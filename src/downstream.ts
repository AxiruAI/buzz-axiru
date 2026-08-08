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

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type Child = ChildProcessByStdio<Writable, Readable, null>;

export class DownstreamError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error code to surface to the agent. */
    readonly code: number = -32000
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
  /** See DownstreamConfig.env_passthrough. Defaults to "all". */
  env_passthrough?: "all" | "none" | string[];
  request_timeout_ms: number;
}

/**
 * Longest line accepted from a downstream server's stdout. A server
 * that never emits a newline would otherwise make the gate buffer
 * without limit; the gate is the process that must stay alive.
 */
export const MAX_DOWNSTREAM_LINE_CHARS = 8_388_608;

/** Build the child's environment from the operator's passthrough choice. */
export function childEnv(spec: DownstreamSpawnSpec): NodeJS.ProcessEnv {
  const mode = spec.env_passthrough ?? "all";
  if (mode === "all") return { ...process.env, ...spec.env };
  const base: NodeJS.ProcessEnv = {};
  if (Array.isArray(mode)) {
    for (const name of mode) {
      const value = process.env[name];
      if (value !== undefined) base[name] = value;
    }
  }
  return { ...base, ...spec.env };
}

export class DownstreamClient {
  private child: Child | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Non-null once the child is gone; the message to reject with. */
  private dead: string | null = null;

  serverInfo: Record<string, unknown> | null = null;
  capabilities: Record<string, unknown> = {};
  instructions: string | undefined;

  constructor(private readonly spec: DownstreamSpawnSpec) {}

  get alive(): boolean {
    return this.child !== null && this.dead === null;
  }

  get deadReason(): string | null {
    return this.dead;
  }

  /** Spawn the child and run the MCP initialize handshake. */
  async start(protocolVersion: string, clientVersion: string): Promise<void> {
    this.child = spawn(this.spec.command, this.spec.args, {
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

    this.readLines(this.child.stdout);

    const init = (await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "buzz-axiru-gate", version: clientVersion }
    })) as Record<string, unknown>;
    this.serverInfo = (init.serverInfo as Record<string, unknown>) ?? null;
    this.capabilities = (init.capabilities as Record<string, unknown>) ?? {};
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
      entry.reject(new DownstreamError(reason));
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (line.trim().length === 0) return;
    let message: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // Not JSON: some servers log to stdout; ignore the line.
    }
    if (typeof message.id !== "number") return; // notification or request from server
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new DownstreamError(message.error.message, message.error.code));
    } else {
      entry.resolve(message.result);
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
            `downstream request ${method} timed out after ${this.spec.request_timeout_ms}ms`
          )
        );
      }, this.spec.request_timeout_ms);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n"
      );
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
    let cursor: string | undefined;
    do {
      const result = (await this.request(
        "tools/list",
        cursor !== undefined ? { cursor } : {}
      )) as { tools?: DownstreamTool[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
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
