/**
 * DownstreamPool: one gate, several downstream MCP servers.
 *
 * Buzz hands an agent exactly one MCP server (buzz-acp --mcp-command),
 * which forces an either/or: the agent gets a shell server OR a domain
 * server, never both. The gate is already a proxy, so it can occupy
 * that single slot and fan out behind it. This class owns N
 * DownstreamClient instances and presents the same surface a single
 * client does, so gate.ts stays a gate and does not become a router.
 *
 * Deliberate choices, all of them failing closed rather than degraded:
 *   - If any child fails to start, the whole pool refuses to start and
 *     the others are closed. A partially available pool would silently
 *     drop tools the agent was told about.
 *   - Tool name collisions across servers are a startup error, never a
 *     silent winner: which server got the call would otherwise depend
 *     on config ordering, and one of them may move money.
 *   - A tool name containing control characters is a startup error.
 *     The name is what the operator's gate patterns are written
 *     against and what appears in the ledger and in the approval a
 *     human reads; a newline in it is either a broken server or a
 *     server trying to make its money tool unreadable.
 *   - alive is true only when every child is alive, so a dead child
 *     cannot hide behind its healthy siblings.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import type { DownstreamConfig } from "./config.js";
import { DownstreamClient, DownstreamError, type DownstreamTool } from "./downstream.js";

interface Member {
  config: DownstreamConfig;
  client: DownstreamClient;
}

interface ToolOwner {
  member: Member;
  /** The name the owning server knows this tool by, before tool_prefix. */
  originalName: string;
}

export class DownstreamPool {
  private readonly members: Member[];
  /** Exposed tool name -> owning server. Built during start(). */
  private readonly owners = new Map<string, ToolOwner>();
  private merged: DownstreamTool[] = [];
  private started = false;

  constructor(configs: DownstreamConfig[]) {
    if (configs.length === 0) {
      throw new Error("buzz-axiru: DownstreamPool requires at least one downstream server");
    }
    this.members = configs.map((config) => ({
      config,
      client: new DownstreamClient({
        command: config.command,
        args: config.args,
        env: config.env,
        env_passthrough: config.env_passthrough,
        request_timeout_ms: config.request_timeout_ms
      })
    }));
  }

  /** The configured servers, in config order. */
  get servers(): DownstreamConfig[] {
    return this.members.map((m) => m.config);
  }

  get alive(): boolean {
    return this.members.every((m) => m.client.alive);
  }

  /** Names the first dead server, so the operator knows which one to look at. */
  get deadReason(): string | null {
    for (const member of this.members) {
      if (member.client.alive) continue;
      const reason = member.client.deadReason ?? "downstream server is not running";
      return `[${member.config.name}] ${reason}`;
    }
    return null;
  }

  /**
   * Union of the children's capabilities. tools is dropped because the
   * gate replaces the tools surface with its own merged list anyway.
   * Later servers do not overwrite earlier ones: first advertiser wins,
   * matching how request() picks a target.
   */
  get capabilities(): Record<string, unknown> {
    const union = Object.create(null) as Record<string, unknown>;
    for (const member of this.members) {
      for (const [key, value] of Object.entries(member.client.capabilities)) {
        if (key === "tools") continue;
        if (!Object.prototype.hasOwnProperty.call(union, key)) union[key] = value;
      }
    }
    return union;
  }

  /** Child instructions, each attributed to its server by name. */
  get instructions(): string | undefined {
    const parts: string[] = [];
    for (const member of this.members) {
      const text = member.client.instructions;
      if (text === undefined || text.trim().length === 0) continue;
      parts.push(`[${member.config.name}] ${text}`);
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  /**
   * Start every child, handshake, and build the merged tool catalog.
   * Any failure closes everything already started and rethrows: half a
   * pool is worse than none, because the agent would be told about
   * tools that cannot be called.
   */
  async start(protocolVersion: string, clientVersion: string): Promise<void> {
    const results = await Promise.allSettled(
      this.members.map((m) => m.client.start(protocolVersion, clientVersion))
    );
    const failures = results
      .map((r, index) => ({ r, member: this.members[index]! }))
      .filter((entry) => entry.r.status === "rejected");
    if (failures.length > 0) {
      this.close();
      const detail = failures
        .map(
          (entry) =>
            `${entry.member.config.name} (${entry.member.config.command}): ` +
            `${((entry.r as PromiseRejectedResult).reason as Error).message}`
        )
        .join("; ");
      throw new DownstreamError(
        `buzz-axiru: downstream server failed to start, refusing to run degraded: ${detail}`
      );
    }
    try {
      await this.buildCatalog();
    } catch (err) {
      this.close();
      throw err;
    }
    this.started = true;
  }

  private async buildCatalog(): Promise<void> {
    this.owners.clear();
    this.merged = [];
    for (const member of this.members) {
      const hide = new Set(member.config.hide_tools);
      const tools = await member.client.listTools();
      for (const tool of tools) {
        if (
          typeof tool.name !== "string" ||
          tool.name.length === 0 ||
          tool.name.length > 1_024 ||
          CONTROL_CHARS.test(tool.name)
        ) {
          throw new DownstreamError(
            `buzz-axiru: downstream server "${member.config.name}" advertised a tool whose name ` +
              "is empty, over 1024 characters, or contains a control character. Refusing to run: " +
              "that name cannot be matched " +
              "against gate patterns or shown to a human approver truthfully."
          );
        }
        // hide_tools is matched before prefixing: the operator writes it
        // against the names that server's own docs use.
        if (hide.has(tool.name)) continue;
        const exposed = `${member.config.tool_prefix}${tool.name}`;
        const clash = this.owners.get(exposed);
        if (clash !== undefined) {
          throw new DownstreamError(
            `buzz-axiru: downstream tool name collision on "${exposed}": served by both ` +
              `"${clash.member.config.name}" (as ${clash.originalName}) and ` +
              `"${member.config.name}" (as ${tool.name}). Set a "tool_prefix" on one of ` +
              "them in the config file so every exposed tool name is unique."
          );
        }
        this.owners.set(exposed, { member, originalName: tool.name });
        this.merged.push({ ...tool, name: exposed });
      }
    }
  }

  /**
   * The merged, prefixed, hide_tools-filtered catalog. Built once during
   * start() so a collision is a startup failure rather than something
   * the agent discovers mid-session.
   */
  async listTools(): Promise<DownstreamTool[]> {
    if (!this.started) await this.buildCatalog();
    return this.merged.map((tool) => ({ ...tool }));
  }

  /** Whether an exposed tool name is served by this pool. */
  hasTool(exposedName: string): boolean {
    return this.owners.has(exposedName);
  }

  /** The server name that owns an exposed tool, for logs and errors. */
  serverFor(exposedName: string): string | null {
    return this.owners.get(exposedName)?.member.config.name ?? null;
  }

  /** Route to the owning server, calling it by the name it knows. */
  callTool(exposedName: string, args: Record<string, unknown>): Promise<unknown> {
    const owner = this.owners.get(exposedName);
    if (owner === undefined) {
      return Promise.reject(new DownstreamError(`Unknown tool: ${exposedName}`, -32602));
    }
    return owner.member.client.callTool(owner.originalName, args);
  }

  /**
   * Non-tools methods (resources/*, prompts/*, ...) go to the FIRST
   * server that advertised the matching capability. There is no merged
   * namespace for those surfaces, and inventing one would mean rewriting
   * resource URIs and prompt names, so the pool stays honest: one owner
   * per capability, chosen by config order, and a plain method-not-found
   * when nobody claims it. Operators who need a second server's
   * resources should list it first.
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const target = this.targetFor(method);
    if (target === null) {
      return Promise.reject(
        new DownstreamError(
          `Method not found: ${method} (no configured downstream server advertises ` +
            `the "${capabilityKey(method)}" capability)`,
          -32601
        )
      );
    }
    return target.client.request(method, params);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    // Notifications cannot be answered, so an unclaimed one is dropped
    // rather than turned into an error nobody would ever read.
    this.targetFor(method)?.client.notify(method, params);
  }

  private targetFor(method: string): Member | null {
    const key = capabilityKey(method);
    for (const member of this.members) {
      if (Object.prototype.hasOwnProperty.call(member.client.capabilities, key)) return member;
    }
    // Methods outside any capability namespace (ping and friends) have
    // no natural owner; the first server answers for the pool.
    if (!method.includes("/")) return this.members[0] ?? null;
    return null;
  }

  close(): void {
    for (const member of this.members) member.client.close();
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function capabilityKey(method: string): string {
  const slash = method.indexOf("/");
  return slash === -1 ? method : method.slice(0, slash);
}
