/**
 * Downstream MCP client: spawns the operator-configured payment MCP
 * server as a child process and speaks newline-delimited JSON-RPC 2.0
 * to it over stdio.
 *
 * The downstream server is operator-chosen, but what it writes on
 * stdout is not necessarily under the operator's control: it is a
 * payment API's answers, an upstream service's error text, or in the
 * worst case a compromised server. So its output is read with a hard
 * line cap and its environment is whatever the operator said to give
 * it, no more.
 *
 * Failure semantics, chosen deliberately:
 *   - If the child exits or errors, every in-flight request is
 *     rejected immediately (never a hang), and every later request
 *     rejects immediately with the recorded exit reason.
 *   - Requests carry a timeout (config: downstream.request_timeout_ms)
 *     so a wedged child cannot park the agent forever.
 *   - The child is killed on close() and again on process exit.
 *
 * No SDK dependency: same raw-protocol approach as src/mcp.ts.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

type Child = ChildProcessByStdio<Writable, Readable, null>;

export class DownstreamError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error code to surface to the agent. */
    readonly code: number = -32000,
    /** Whether a sent payment request has a definitive negative outcome. */
    readonly outcome: "failed" | "unknown" = "failed"
  ) {
    super(message);
    this.name = "DownstreamError";
  }
}

export interface DownstreamTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DownstreamSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** See DownstreamConfig.env_passthrough. Defaults to "none". */
  env_passthrough?: "all" | "none" | string[];
  request_timeout_ms: number;
}

/**
 * Longest line accepted from a downstream server's stdout. A server
 * that never emits a newline would otherwise make the gate buffer
 * without limit; the gate is the process that must stay alive.
 */
export const MAX_DOWNSTREAM_LINE_CHARS = 8_388_608;
export const MAX_TOOL_LIST_PAGES = 1_000;
export const MAX_DOWNSTREAM_TOOLS = 20_000;
export const MAX_TOOL_CATALOG_CHARS = 16_777_216;
export const MAX_TOOL_CATALOG_NODES = 200_000;
export const MAX_TOOL_SCHEMA_DEPTH = 64;

/** Build the child's environment from the operator's passthrough choice. */
export function childEnv(spec: DownstreamSpawnSpec): NodeJS.ProcessEnv {
  const mode = spec.env_passthrough ?? "none";
  if (mode === "all") return { ...process.env, ...spec.env };
  const base = Object.create(null) as NodeJS.ProcessEnv;
  if (Array.isArray(mode)) {
    for (const name of mode) {
      const value = process.env[name];
      if (value !== undefined) base[name] = value;
    }
  }
  return { ...base, ...spec.env };
}

/**
 * Resolve a bare command name against the PARENT process PATH.
 *
 * Why this exists: Node resolves a spawned executable against the
 * CHILD environment's PATH (options.env.PATH), not the parent's. Since
 * env_passthrough started defaulting to "none" in 0.4.0 the child gets
 * no PATH at all, so a pre-0.4 config that names its downstream server
 * by bare name ("buzz-dev-mcp", "npx") failed on upgrade with
 * `spawn <name> ENOENT` even though the command was plainly on the
 * operator's PATH. Resolving here, in the parent, restores 0.2.0's
 * resolution behaviour while keeping the secret hiding intact: the
 * configured child env is spawned unchanged, so "none" still forwards
 * nothing from the parent, PATH included.
 *
 * A command containing a path separator is returned untouched: the
 * operator already said exactly where the binary lives.
 */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (command.includes("/") || command.includes("\\")) return command;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  // Fail closed, as before the fix, but say what actually went wrong
  // instead of surfacing a bare ENOENT from deep inside spawn.
  throw new DownstreamError(
    `downstream command "${command}" was not found on the gate's PATH. ` +
      "Set downstream.command to an absolute path in policies.json, or start " +
      "buzz-axiru with the command's directory on PATH."
  );
}

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- *
 * Process resource limits guard
 * -------------------------------------------------------------------- */

/**
 * Below this soft open-files limit, buzz-acp with its default agent
 * parallelism can exhaust descriptors and fail every agent with EAGAIN
 * (os error 35 on macOS). Field-verified: a gate spawned under a Buzz
 * custom harness inherits the LOGIN shell's limits, and macOS ships a
 * soft maxfiles of 256 there.
 */
export const MIN_RECOMMENDED_MAXFILES = 4096;

function defaultUlimitProbe(): string | null {
  // Node has no getrlimit binding, so ask a shell. `ulimit` is a shell
  // builtin (POSIX), not a binary, hence sh -c rather than a direct spawn.
  const result = spawnSync("sh", ["-c", "ulimit -n"], { encoding: "utf8", timeout: 5_000 });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return result.stdout.trim();
}

/**
 * The soft open-files limit this process runs under, or null when it
 * cannot be determined or is unlimited (both mean: nothing to warn
 * about, so the caller stays quiet rather than guessing).
 */
export function softMaxFiles(probe: () => string | null = defaultUlimitProbe): number | null {
  const raw = probe();
  if (raw === null || raw === "unlimited") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A warning string when the limit is dangerously low, else null. Never
 * a failure: a low limit degrades a busy session, it does not make the
 * gate unsafe, so startup proceeds and the operator gets told how to
 * raise it.
 */
export function fileLimitWarning(soft: number | null = softMaxFiles()): string | null {
  if (soft === null || soft >= MIN_RECOMMENDED_MAXFILES) return null;
  return (
    `this process runs with a soft open-files limit of ${soft} (recommended: at least ` +
    `${MIN_RECOMMENDED_MAXFILES}). Under Buzz Desktop a custom harness inherits the login ` +
    "shell's limits, and buzz-acp running several agents in parallel can exhaust file " +
    "descriptors and fail every agent with EAGAIN (os error 35). On macOS raise the " +
    "system limit with `sudo launchctl limit maxfiles 65536 200000` and log out and back " +
    "in, or add `ulimit -n 4096` to your shell profile. The gate itself keeps running."
  );
}

export class DownstreamClient {
  private child: Child | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Non-null once the child is gone; the message to reject with. */
  private dead: string | null = null;

  serverInfo: Record<string, unknown> | null = null;
  capabilities: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  instructions: string | undefined;

  constructor(private readonly spec: DownstreamSpawnSpec) {}

  get alive(): boolean {
    return this.child !== null && this.dead === null;
  }

  get deadReason(): string | null {
    return this.dead;
  }

  /** Spawn the child and run the MCP initialize handshake. */
  async start(
    protocolVersion: string,
    clientVersion: string,
    supportedProtocolVersions: readonly string[] = [protocolVersion]
  ): Promise<void> {
    // Resolved against the PARENT PATH on purpose; see resolveCommand.
    // The child env stays exactly what the operator configured.
    this.child = spawn(resolveCommand(this.spec.command), this.spec.args, {
      env: childEnv(this.spec),
      // stderr is inherited so the operator sees downstream logs.
      stdio: ["pipe", "pipe", "inherit"]
    });

    this.child.on("error", (err) => {
      this.markDead(`downstream server failed to start: ${err.message}`);
    });
    this.child.on("exit", (code, signal) => {
      this.markDead(
        `downstream server exited (${signal !== null ? `signal ${signal}` : `code ${code}`})`
      );
    });
    this.child.stdin.on("error", (err) => {
      this.markDead(`downstream server stdin failed: ${err.message}`);
    });

    this.readLines(this.child.stdout);

    const init = await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "buzz-axiru-gate", version: clientVersion }
    });
    if (!isRecord(init)) {
      throw new DownstreamError("downstream initialize returned a non-object result");
    }
    if (
      typeof init.protocolVersion !== "string" ||
      !supportedProtocolVersions.includes(init.protocolVersion)
    ) {
      throw new DownstreamError(
        `downstream selected unsupported protocol version ${JSON.stringify(init.protocolVersion)}; ` +
          `supported versions: ${supportedProtocolVersions.join(", ")}`
      );
    }
    this.serverInfo = isRecord(init.serverInfo) ? { ...init.serverInfo } : null;
    this.capabilities = copyToNullPrototype(init.capabilities);
    this.instructions = typeof init.instructions === "string" ? init.instructions : undefined;
    this.notify("notifications/initialized");
  }

  /**
   * Newline-split the child's stdout with a cap on line length. An
   * over-long line is dropped with a note on stderr rather than
   * buffered: the request it belonged to then fails on its own timeout,
   * which is the same outcome as a silent server and a much better one
   * than the gate running out of memory.
   */
  private readLines(stream: Readable): void {
    let buffer = "";
    let discarding = false;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        if (line.length > MAX_DOWNSTREAM_LINE_CHARS) {
          process.stderr.write(
            `buzz-axiru: downstream server emitted a line over ${MAX_DOWNSTREAM_LINE_CHARS} characters; discarded it\n`
          );
          continue;
        }
        this.onLine(line);
      }
      if (buffer.length > MAX_DOWNSTREAM_LINE_CHARS) {
        buffer = "";
        discarding = true;
        process.stderr.write(
          `buzz-axiru: downstream server emitted a line over ${MAX_DOWNSTREAM_LINE_CHARS} characters; discarded it\n`
        );
      }
    });
  }

  private markDead(reason: string): void {
    if (this.dead !== null) return;
    this.dead = reason;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      // These requests were written before the child disappeared. A
      // payment provider may have accepted the side effect even though
      // its MCP process died before relaying the response.
      entry.reject(new DownstreamError(reason, -32000, "unknown"));
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return; // Not JSON: some servers log to stdout; ignore the line.
    }
    if (!isRecord(parsed)) return;
    const message = parsed;
    if (typeof message.id !== "number") return; // notification or request from server
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.jsonrpc !== "2.0") {
      entry.reject(
        new DownstreamError("downstream returned an invalid JSON-RPC version", -32000, "unknown")
      );
    } else if (Object.prototype.hasOwnProperty.call(message, "error") && message.error !== null) {
      if (!isRecord(message.error)) {
        entry.reject(
          new DownstreamError("downstream returned an invalid JSON-RPC error", -32000, "unknown")
        );
        return;
      }
      const code = typeof message.error.code === "number" ? message.error.code : -32000;
      const errorMessage =
        typeof message.error.message === "string"
          ? message.error.message
          : "downstream returned an error without a message";
      entry.reject(new DownstreamError(errorMessage, code));
    } else if (Object.prototype.hasOwnProperty.call(message, "result")) {
      entry.resolve(message.result);
    } else {
      entry.reject(
        new DownstreamError("downstream returned an invalid JSON-RPC response", -32000, "unknown")
      );
    }
  }

  /** Send a request; resolves with the JSON-RPC result. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(
        new DownstreamError(this.dead ?? "downstream server is not running")
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DownstreamError(
            `downstream request ${method} timed out after ${this.spec.request_timeout_ms}ms`,
            -32000,
            "unknown"
          )
        );
      }, this.spec.request_timeout_ms);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n"
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new DownstreamError(
            `downstream request ${method} could not be written: ${(err as Error).message}`,
            -32000,
            "unknown"
          )
        );
      }
    });
  }

  /** Send a notification (no reply expected). */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.alive) return;
    this.child!.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n"
    );
  }

  /** tools/list, following pagination cursors to the end. */
  async listTools(): Promise<DownstreamTool[]> {
    const tools: DownstreamTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let catalogChars = 0;
    let catalogNodes = 0;
    do {
      pages += 1;
      if (pages > MAX_TOOL_LIST_PAGES) {
        throw new DownstreamError(
          `downstream tools/list exceeded ${MAX_TOOL_LIST_PAGES} pages; refusing an unbounded catalog`
        );
      }
      const result = (await this.request(
        "tools/list",
        cursor !== undefined ? { cursor } : {}
      )) as { tools?: DownstreamTool[]; nextCursor?: string };
      if (
        result === null ||
        typeof result !== "object" ||
        !Array.isArray(result.tools ?? []) ||
        !(result.tools ?? []).every(isRecord)
      ) {
        throw new DownstreamError("downstream tools/list returned an invalid tools array");
      }
      const metrics = catalogMetrics(result.tools ?? []);
      catalogChars += metrics.chars;
      catalogNodes += metrics.nodes;
      if (metrics.depth > MAX_TOOL_SCHEMA_DEPTH) {
        throw new DownstreamError(
          `downstream tool schemas are nested deeper than ${MAX_TOOL_SCHEMA_DEPTH} levels`
        );
      }
      if (
        catalogChars > MAX_TOOL_CATALOG_CHARS ||
        catalogNodes > MAX_TOOL_CATALOG_NODES
      ) {
        throw new DownstreamError(
          "downstream tool catalog exceeds the aggregate size limit; refusing unbounded metadata"
        );
      }
      tools.push(...(result.tools ?? []));
      if (tools.length > MAX_DOWNSTREAM_TOOLS) {
        throw new DownstreamError(
          `downstream advertised more than ${MAX_DOWNSTREAM_TOOLS} tools; refusing an oversized catalog`
        );
      }
      const next = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (next !== undefined) {
        if (seenCursors.has(next)) {
          throw new DownstreamError(
            `downstream tools/list repeated cursor "${next}"; refusing an infinite pagination loop`
          );
        }
        seenCursors.add(next);
      }
      cursor = next;
    } while (cursor !== undefined);
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  close(): void {
    if (this.child !== null && this.dead === null) {
      this.child.kill();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Capabilities are downstream-controlled property names. A null-prototype
 * copy keeps names such as "constructor" from being inherited accidentally
 * and makes all later routing decisions depend on advertised own properties.
 */
function copyToNullPrototype(value: unknown): Record<string, unknown> {
  const copy = Object.create(null) as Record<string, unknown>;
  if (!isRecord(value)) return copy;
  for (const [key, entry] of Object.entries(value)) copy[key] = entry;
  return copy;
}

/** Iterative metrics keep maliciously deep tool schemas off the JS call stack. */
function catalogMetrics(value: unknown): { chars: number; nodes: number; depth: number } {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let chars = 0;
  let nodes = 0;
  let deepest = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    deepest = Math.max(deepest, current.depth);
    if (typeof current.value === "string") {
      chars += current.value.length;
    } else if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isRecord(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        chars += key.length;
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else {
      chars += 16;
    }
    // Stop measuring as soon as one page alone is impossible to accept.
    if (chars > MAX_TOOL_CATALOG_CHARS || nodes > MAX_TOOL_CATALOG_NODES) break;
  }
  return { chars, nodes, depth: deepest };
}
