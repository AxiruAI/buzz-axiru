/**
 * Gate mode: a gating MCP proxy in front of a downstream payment MCP
 * server. The agent talks to the gate; the gate spawns the downstream
 * server as a child process, re-exposes its tools, and intercepts
 * every call to a payment-class tool:
 *
 *   allow            -> the call is executed against the downstream
 *                       server and its result returned unchanged
 *   deny             -> a structured refusal; the downstream server
 *                       never sees the call
 *   require_approval -> the call is parked verbatim; a human grants
 *                       or denies it (CLI), and only a grant makes
 *                       the gate replay the original call downstream
 *
 * Fail-closed choices, all deliberate:
 *   - downstream configured but no payment_tools matcher: EVERY
 *     downstream tool is gated, loudly, rather than guessing which
 *     tools move money.
 *   - gated call whose amount cannot be read: require_approval with a
 *     distinct reason code, never allow.
 *   - expired approvals are never executed, and an identical retry
 *     after expiry is refused rather than silently re-parked.
 *
 * Approvals for gated calls are keyed to a CALL fingerprint
 * (tool name + full arguments + agent pubkey), not just the policy
 * intent fingerprint: a grant authorizes exactly the bytes the human
 * saw, and replaying an identical call after execution returns the
 * stored downstream result instead of paying twice.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { sha256Fingerprint } from "@axiru/agent-spend-guardrails";

import { isExpired, type ApprovalRequest } from "./approvals.js";
import { extractPayment, isGatedTool, type BridgeConfig } from "./config.js";
import { DownstreamClient, DownstreamError, type DownstreamTool } from "./downstream.js";
import type { Bridge, SpendRequest } from "./guard.js";
import {
  errorResponse,
  LATEST_PROTOCOL_VERSION,
  response,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_DEFINITION,
  TOOL_NAME,
  type JsonRpcRequest
} from "./mcp.js";
import { notifyApprovalDecided, notifyApprovalRequested } from "./notify.js";
import { createInterface } from "node:readline";

const UNATTRIBUTED_PUBKEY = "0".repeat(64);

const GATED_TOOL_NOTICE =
  " [Routed through the buzz-axiru spend gate: this call is evaluated against " +
  "local spend policy first. It may return a structured refusal or a " +
  "pending_approval status instead of executing.]";

export interface GateOptions {
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
  /** Suppress the startup banner (tests). */
  quiet?: boolean;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
  [key: string]: unknown;
}

function textResult(payload: Record<string, unknown>, isError: boolean): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

export class GateServer {
  readonly downstream: DownstreamClient;
  private downstreamTools: DownstreamTool[] = [];
  private readonly clock: () => Date;
  private readonly quiet: boolean;
  /** In-flight approval executions, to prevent a poller/retry double-replay. */
  private readonly executing = new Set<string>();
  readonly agentPubkey: string;
  /** True when the matcher config is missing and every tool is gated. */
  readonly gateAll: boolean;

  constructor(
    private readonly bridge: Bridge,
    private readonly version: string,
    options: GateOptions = {}
  ) {
    const config = bridge.config;
    if (config.downstream === null) {
      throw new Error("buzz-axiru: gate mode requires a \"downstream\" server in the config file");
    }
    this.clock = options.clock ?? (() => new Date());
    this.quiet = options.quiet ?? false;
    this.gateAll = config.payment_tools === null;
    this.agentPubkey =
      process.env.BUZZ_AXIRU_AGENT_PUBKEY ?? config.agent_pubkey ?? UNATTRIBUTED_PUBKEY;
    this.downstream = new DownstreamClient({
      command: config.downstream.command,
      args: config.downstream.args,
      env: config.downstream.env,
      request_timeout_ms: config.downstream.request_timeout_ms
    });
  }

  private get config(): BridgeConfig {
    return this.bridge.config;
  }

  /** Spawn the downstream server, handshake, and cache its tool list. */
  async start(): Promise<void> {
    await this.downstream.start(LATEST_PROTOCOL_VERSION, this.version);
    this.downstreamTools = await this.downstream.listTools();
    if (!this.quiet) {
      const gated = this.downstreamTools
        .map((t) => t.name)
        .filter((name) => this.isGated(name));
      process.stderr.write(
        `buzz-axiru gate: downstream ${this.config.downstream!.command} up | ` +
          `${this.downstreamTools.length} tools | gated: ${gated.join(", ") || "(none)"}\n`
      );
      if (this.gateAll) {
        process.stderr.write(
          "buzz-axiru gate: WARNING: no payment_tools matcher in the config file. " +
            "Failing closed: EVERY downstream tool is gated and, with no amount " +
            "mappings, every call will require human approval. Add payment_tools " +
            "to gate only the tools that move money.\n"
        );
      }
      if (this.agentPubkey === UNATTRIBUTED_PUBKEY) {
        process.stderr.write(
          "buzz-axiru gate: WARNING: no agent identity configured " +
            "(BUZZ_AXIRU_AGENT_PUBKEY or agent_pubkey). Decisions are attributed " +
            "to the all-zeros pubkey, so all unattributed agents share one daily cap.\n"
        );
      }
    }
  }

  close(): void {
    this.downstream.close();
  }

  isGated(toolName: string): boolean {
    if (toolName === TOOL_NAME) return false;
    return isGatedTool(this.config, toolName);
  }

  /** Handle one JSON-RPC message from the agent. Null for notifications. */
  async handleMessage(raw: string): Promise<string | null> {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return errorResponse(null, -32700, "Parse error: not valid JSON");
    }
    const id = message.id ?? null;
    const isNotification = message.id === undefined;

    switch (message.method) {
      case "initialize":
        return this.handleInitialize(id, message.params ?? {});
      case "notifications/initialized":
      case "notifications/cancelled":
        // The gate ran its own handshake with the downstream server.
        return null;
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, { tools: this.mergedTools() });
      case "tools/call":
        return this.handleToolsCall(id, message.params ?? {});
      default: {
        if (isNotification) {
          this.downstream.notify(message.method, message.params);
          return null;
        }
        // Transparent for everything else (resources, prompts, ...):
        // forward to the downstream server and relay its answer.
        if (!this.downstream.alive) {
          return errorResponse(id, -32601, `Method not found: ${message.method}`);
        }
        try {
          const result = await this.downstream.request(message.method, message.params);
          return response(id, (result ?? {}) as Record<string, unknown>);
        } catch (err) {
          const code = err instanceof DownstreamError ? err.code : -32000;
          return errorResponse(id, code, (err as Error).message);
        }
      }
    }
  }

  private handleInitialize(id: number | string | null, params: Record<string, unknown>): string {
    const requested = (params.protocolVersion as string) ?? "";
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    const downstreamCapabilities = { ...this.downstream.capabilities };
    delete (downstreamCapabilities as Record<string, unknown>).tools;
    return response(id, {
      protocolVersion,
      // Downstream capabilities pass through; the tools surface is ours.
      capabilities: { ...downstreamCapabilities, tools: {} },
      serverInfo: { name: "buzz-axiru", version: this.version },
      instructions:
        "Payment tools here are routed through a local spend gate. Gated calls are " +
        "evaluated against policy before execution: they may execute, be refused, or " +
        "return status pending_approval. On pending_approval, hold and call the same " +
        "tool again with identical arguments after a human decides. " +
        "request_spend_approval remains available to check policy before planning a spend." +
        (this.downstream.instructions !== undefined
          ? ` Downstream server instructions: ${this.downstream.instructions}`
          : "")
    });
  }

  private mergedTools(): Array<Record<string, unknown>> {
    const hide = new Set(this.config.downstream!.hide_tools);
    const tools: Array<Record<string, unknown>> = [TOOL_DEFINITION as unknown as Record<string, unknown>];
    for (const tool of this.downstreamTools) {
      if (hide.has(tool.name)) continue;
      if (tool.name === TOOL_NAME) continue; // ours wins
      if (this.isGated(tool.name)) {
        tools.push({ ...tool, description: `${tool.description ?? ""}${GATED_TOOL_NOTICE}` });
      } else {
        tools.push({ ...tool });
      }
    }
    return tools;
  }

  private async handleToolsCall(
    id: number | string | null,
    params: Record<string, unknown>
  ): Promise<string> {
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== "string") {
      return errorResponse(id, -32602, "tools/call requires a tool name");
    }

    // The advisory tool keeps working in gate mode.
    if (name === TOOL_NAME) {
      try {
        const decision = await this.bridge.evaluate(
          {
            amount_minor_units: String(args.amount_minor_units ?? ""),
            currency: String(args.currency ?? ""),
            counterparty: String(args.counterparty ?? ""),
            memo: String(args.memo ?? ""),
            agent_pubkey: String(args.agent_pubkey ?? "")
          },
          this.clock()
        );
        return response(id, textResult(decision as unknown as Record<string, unknown>, false));
      } catch (err) {
        return response(id, textResult({ error: (err as Error).message }, true));
      }
    }

    const known = this.downstreamTools.some((t) => t.name === name);
    const hidden = this.config.downstream!.hide_tools.includes(name);
    if (!known || hidden) {
      return errorResponse(id, -32602, `Unknown tool: ${name}`);
    }

    if (!this.isGated(name)) {
      return this.passthrough(id, name, args);
    }
    return this.gatedCall(id, name, args);
  }

  private async passthrough(
    id: number | string | null,
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    try {
      const result = await this.downstream.callTool(name, args);
      return response(id, (result ?? {}) as Record<string, unknown>);
    } catch (err) {
      return response(
        id,
        textResult(
          {
            status: "downstream_error",
            reason_code: "bridge.error.downstream_unavailable",
            error: (err as Error).message
          },
          true
        )
      );
    }
  }

  private async gatedCall(
    id: number | string | null,
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const now = this.clock();
    const callFingerprint = sha256Fingerprint({
      v: 1,
      kind: "buzz-axiru.gated_call",
      tool: name,
      arguments: args as never,
      agent_pubkey: this.agentPubkey
    });

    // A prior decision for this exact call outranks re-evaluation.
    const existing = this.bridge.approvals.byFingerprint(callFingerprint);
    if (existing) {
      const resolved = await this.resolveExistingApproval(id, name, existing, now);
      if (resolved !== null) return resolved;
    }

    const extraction = extractPayment(this.config, name, args);
    const memo = `${name} ${JSON.stringify(args).slice(0, 160)}`;

    if (!extraction.ok) {
      // FAIL CLOSED: an amount the gate cannot read is a payment a
      // human must look at. Never allow.
      return this.parkCall(id, name, args, callFingerprint, now, {
        reason_code: extraction.reason_code,
        reason_text: extraction.detail,
        amount_minor_units: "unknown",
        currency: this.config.currency,
        counterparty: `tool:${name}`,
        memo,
        policy_fingerprint: undefined
      });
    }

    const request: SpendRequest = {
      amount_minor_units: extraction.amount_minor_units,
      currency: extraction.currency,
      counterparty: extraction.counterparty,
      memo,
      agent_pubkey: this.agentPubkey
    };

    let result;
    try {
      ({ result } = this.bridge.policyEvaluate(request, now));
    } catch (err) {
      // Unevaluable input (currency mismatch shapes, etc.): fail closed.
      return this.parkCall(id, name, args, callFingerprint, now, {
        reason_code: "bridge.pending.policy_unevaluable",
        reason_text: (err as Error).message,
        amount_minor_units: extraction.amount_minor_units,
        currency: extraction.currency,
        counterparty: extraction.counterparty,
        memo,
        policy_fingerprint: undefined
      });
    }

    this.bridge.ledger.append({
      type: "decision",
      actor: this.agentPubkey,
      agent_pubkey: this.agentPubkey,
      decision: result.decision,
      reason_code: result.reason_code,
      amount_minor_units: extraction.amount_minor_units,
      currency: extraction.currency,
      counterparty: extraction.counterparty,
      memo,
      fingerprint: callFingerprint,
      policy_fingerprint: result.fingerprint,
      tool_name: name,
      ts: now.toISOString()
    });

    if (result.decision === "deny") {
      return response(
        id,
        textResult(
          {
            status: "denied_by_policy",
            executed: false,
            decision: "deny",
            reason_code: result.reason_code,
            reasons: result.reasons,
            guidance:
              "This payment tool call was refused by spend policy and was NOT executed. " +
              "Do not retry it with altered parameters."
          },
          true
        )
      );
    }

    if (result.decision === "require_approval") {
      return this.parkCall(id, name, args, callFingerprint, now, {
        reason_code: result.reason_code,
        reason_text: result.reasons[0]?.reason_text ?? "requires human approval",
        amount_minor_units: extraction.amount_minor_units,
        currency: extraction.currency,
        counterparty: extraction.counterparty,
        memo,
        policy_fingerprint: result.fingerprint
      });
    }

    // allow: pass the original call through to the downstream server.
    return this.executeDownstream(id, name, args, {
      approval_id: undefined,
      fingerprint: callFingerprint,
      amount_minor_units: extraction.amount_minor_units,
      currency: extraction.currency,
      counterparty: extraction.counterparty,
      memo,
      now
    });
  }

  /**
   * Handle a gated call whose fingerprint already has an approval
   * record. Returns null when evaluation should continue (no prior
   * record applies, which cannot happen today but keeps this total).
   */
  private async resolveExistingApproval(
    id: number | string | null,
    name: string,
    existing: ApprovalRequest,
    now: Date
  ): Promise<string | null> {
    if (existing.status === "pending" && isExpired(existing, now)) {
      const expired = this.bridge.approvals.markExpired(existing.approval_id, now);
      if (expired) this.appendExpiry(expired, now);
      return response(id, this.expiredRefusal(existing));
    }
    switch (existing.status) {
      case "pending":
        return response(
          id,
          textResult(
            {
              status: "pending_approval",
              executed: false,
              decision: "require_approval",
              reason_code: existing.reason_code,
              approval_id: existing.approval_id,
              expires_at: existing.expires_at ?? null,
              guidance:
                "This payment tool call is still waiting on a human decision and has NOT been executed. " +
                "Hold. Call the same tool again with identical arguments after a human decides."
            },
            false
          )
        );
      case "expired":
        return response(id, this.expiredRefusal(existing));
      case "denied":
        return response(
          id,
          textResult(
            {
              status: "denied_by_human",
              executed: false,
              decision: "deny",
              reason_code: "bridge.deny.human_denied",
              approval_id: existing.approval_id,
              decided_by: existing.decided_by ?? "operator",
              ...(existing.note !== undefined ? { note: existing.note } : {}),
              guidance:
                "A human denied this payment tool call. It was NOT executed. Do not retry it."
            },
            true
          )
        );
      case "granted": {
        if (existing.execution_status === undefined) {
          // Granted but the poller has not replayed it yet: replay now.
          const replayed = await this.executeApproved(existing, now);
          return this.approvedOutcomeResponse(id, replayed);
        }
        return this.approvedOutcomeResponse(id, existing);
      }
    }
  }

  private expiredRefusal(approval: ApprovalRequest): ToolCallResult {
    return textResult(
      {
        status: "approval_expired",
        executed: false,
        decision: "deny",
        reason_code: "bridge.deny.approval_expired",
        approval_id: approval.approval_id,
        expires_at: approval.expires_at ?? null,
        guidance:
          "The approval window for this payment tool call expired before a human decided. " +
          "It was NOT executed and cannot be executed. Ask a human in the channel before trying again."
      },
      true
    );
  }

  private approvedOutcomeResponse(
    id: number | string | null,
    approval: ApprovalRequest
  ): string {
    if (approval.execution_status === "executed") {
      // Idempotent re-read: return the stored downstream result, never
      // execute the same grant twice.
      const stored = (approval.execution_result ?? {}) as Record<string, unknown>;
      return response(id, {
        ...stored,
        _buzz_axiru: {
          status: "executed_after_approval",
          approval_id: approval.approval_id,
          decided_by: approval.decided_by ?? "operator",
          executed_at: approval.executed_at
        }
      });
    }
    return response(
      id,
      textResult(
        {
          status: "execution_failed_after_approval",
          executed: false,
          reason_code: "bridge.execution.failed",
          approval_id: approval.approval_id,
          error: approval.execution_error ?? "downstream call failed",
          guidance:
            "A human approved this call but the downstream payment server failed to execute it. " +
            "The grant is spent. If the payment should still happen, ask a human, then issue a " +
            "fresh call (any changed argument creates a new approval)."
        },
        true
      )
    );
  }

  private async parkCall(
    id: number | string | null,
    name: string,
    args: Record<string, unknown>,
    callFingerprint: string,
    now: Date,
    details: {
      reason_code: string;
      reason_text: string;
      amount_minor_units: string;
      currency: string;
      counterparty: string;
      memo: string;
      policy_fingerprint: string | undefined;
    }
  ): Promise<string> {
    // Extraction failures never produced a decision record above; make
    // sure every fail-closed park still lands in the ledger.
    if (details.policy_fingerprint === undefined) {
      this.bridge.ledger.append({
        type: "decision",
        actor: this.agentPubkey,
        agent_pubkey: this.agentPubkey,
        decision: "require_approval",
        reason_code: details.reason_code,
        amount_minor_units: details.amount_minor_units,
        currency: details.currency,
        counterparty: details.counterparty,
        memo: details.memo,
        fingerprint: callFingerprint,
        tool_name: name,
        note: details.reason_text,
        ts: now.toISOString()
      });
    }
    const approval = this.bridge.approvals.createOrGet(
      {
        fingerprint: callFingerprint,
        agent_pubkey: this.agentPubkey,
        amount_minor_units: details.amount_minor_units,
        currency: details.currency,
        counterparty: details.counterparty,
        memo: details.memo,
        reason_code: details.reason_code,
        call: { tool_name: name, arguments: args },
        ...(this.config.approval_ttl_seconds !== null
          ? {
              expires_at: new Date(
                now.getTime() + this.config.approval_ttl_seconds * 1000
              ).toISOString()
            }
          : {})
      },
      now
    );
    await notifyApprovalRequested(this.config, approval);
    return response(
      id,
      textResult(
        {
          status: "pending_approval",
          executed: false,
          decision: "require_approval",
          reason_code: details.reason_code,
          reason: details.reason_text,
          approval_id: approval.approval_id,
          expires_at: approval.expires_at ?? null,
          guidance:
            "This payment tool call was NOT executed. A human has been asked to decide. " +
            "Hold, then call the same tool again with identical arguments after they respond. " +
            "The gate will execute the original call exactly once if it is approved."
        },
        false
      )
    );
  }

  private async executeDownstream(
    id: number | string | null,
    name: string,
    args: Record<string, unknown>,
    meta: {
      approval_id: string | undefined;
      fingerprint: string;
      amount_minor_units: string;
      currency: string;
      counterparty: string;
      memo: string;
      now: Date;
    }
  ): Promise<string> {
    try {
      const result = await this.downstream.callTool(name, args);
      this.appendExecution(name, meta, "executed", undefined);
      return response(id, (result ?? {}) as Record<string, unknown>);
    } catch (err) {
      this.appendExecution(name, meta, "failed", (err as Error).message);
      return response(
        id,
        textResult(
          {
            status: "execution_failed",
            executed: false,
            reason_code: "bridge.execution.failed",
            error: (err as Error).message,
            guidance:
              "Policy allowed this call but the downstream payment server failed to execute it. " +
              "The failure is recorded in the decision log."
          },
          true
        )
      );
    }
  }

  private appendExecution(
    name: string,
    meta: {
      approval_id: string | undefined;
      fingerprint: string;
      amount_minor_units: string;
      currency: string;
      counterparty: string;
      memo: string;
      now: Date;
    },
    status: "executed" | "failed",
    error: string | undefined
  ): void {
    this.bridge.ledger.append({
      type: "execution",
      actor: "bridge",
      agent_pubkey: this.agentPubkey,
      reason_code: status === "executed" ? "bridge.execution.ok" : "bridge.execution.failed",
      amount_minor_units: meta.amount_minor_units,
      currency: meta.currency,
      counterparty: meta.counterparty,
      memo: meta.memo,
      fingerprint: meta.fingerprint,
      tool_name: name,
      execution_status: status,
      ...(error !== undefined ? { error } : {}),
      ...(meta.approval_id !== undefined ? { approval_id: meta.approval_id } : {}),
      ts: meta.now.toISOString()
    });
  }

  private appendExpiry(approval: ApprovalRequest, now: Date): void {
    this.bridge.ledger.append({
      type: "approval_expired",
      actor: "bridge",
      agent_pubkey: approval.agent_pubkey,
      reason_code: "bridge.expired.approval_ttl",
      amount_minor_units: approval.amount_minor_units,
      currency: approval.currency,
      counterparty: approval.counterparty,
      memo: approval.memo,
      fingerprint: approval.fingerprint,
      approval_id: approval.approval_id,
      ...(approval.call !== undefined ? { tool_name: approval.call.tool_name } : {}),
      ts: now.toISOString()
    });
  }

  /** Replay one granted parked call against the downstream server. */
  private async executeApproved(approval: ApprovalRequest, now: Date): Promise<ApprovalRequest> {
    if (this.executing.has(approval.approval_id)) return approval;
    this.executing.add(approval.approval_id);
    try {
      const call = approval.call!;
      const meta = {
        approval_id: approval.approval_id,
        fingerprint: approval.fingerprint,
        amount_minor_units: approval.amount_minor_units,
        currency: approval.currency,
        counterparty: approval.counterparty,
        memo: approval.memo,
        now
      };
      try {
        const result = await this.downstream.callTool(call.tool_name, call.arguments);
        this.appendExecution(call.tool_name, meta, "executed", undefined);
        return this.bridge.approvals.recordExecution(approval.approval_id, {
          status: "executed",
          result,
          at: now
        });
      } catch (err) {
        this.appendExecution(call.tool_name, meta, "failed", (err as Error).message);
        return this.bridge.approvals.recordExecution(approval.approval_id, {
          status: "failed",
          error: (err as Error).message,
          at: now
        });
      }
    } finally {
      this.executing.delete(approval.approval_id);
    }
  }

  /**
   * One sweep of the approval queue: expire overdue pending approvals
   * and replay granted parked calls that have not executed yet. The
   * serve loop calls this on an interval; tests call it directly.
   */
  async processApprovals(now: Date = this.clock()): Promise<void> {
    const all = this.bridge.approvals.pending();
    for (const approval of all) {
      if (isExpired(approval, now)) {
        const expired = this.bridge.approvals.markExpired(approval.approval_id, now);
        if (expired) {
          this.appendExpiry(expired, now);
          await notifyApprovalDecided(this.config, expired);
        }
      }
    }
    for (const approval of this.granteesAwaitingExecution()) {
      const executed = await this.executeApproved(approval, now);
      if (executed.execution_status !== undefined) {
        await notifyApprovalDecided(this.config, executed);
      }
    }
  }

  private granteesAwaitingExecution(): ApprovalRequest[] {
    return this.bridge.approvals
      .all()
      .filter(
        (a) => a.status === "granted" && a.call !== undefined && a.execution_status === undefined
      );
  }

  /** Serve newline-delimited JSON-RPC on stdin/stdout until stdin closes. */
  async serveStdio(): Promise<void> {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      const reply = await this.handleMessage(line);
      if (reply !== null) {
        process.stdout.write(reply + "\n");
      }
    }
  }
}
