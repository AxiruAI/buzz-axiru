/**
 * Gate mode: a gating MCP proxy in front of one or more downstream MCP
 * servers. The agent talks to the gate; the gate spawns each downstream
 * server as a child process, re-exposes their tools under one merged
 * namespace, and intercepts every call to a payment-class tool:
 *
 *   allow            -> the call is executed against the downstream
 *                       server and its result returned unchanged
 *   deny             -> a structured refusal; the downstream server
 *                       never sees the call
 *   require_approval -> the call is parked verbatim; a human grants
 *                       or denies it (CLI), and only a grant lets the
 *                       gate durably claim and execute the original
 *                       call downstream
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
 * saw, and retrying an identical call after execution returns the
 * stored downstream result instead of paying twice. Direct policy
 * allows are also durably claimed before the network side effect, so a
 * gate-process crash cannot reopen an exact-call replay window.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import {
  ApprovalQueueFullError,
  executionResultFingerprint,
  gatedCallFingerprint,
  isExpired,
  type ApprovalRequest
} from "./approvals.js";
import {
  extractPayment,
  isGatedTool,
  normalizePubkey,
  policiesForAgent,
  type BridgeConfig
} from "./config.js";
import { DownstreamError, type DownstreamTool } from "./downstream.js";
import { acquireServingLease, withDataDirLock } from "./lock.js";
import { DownstreamPool } from "./pool.js";
import type { Bridge, SpendRequest } from "./guard.js";
import {
  errorResponse,
  isJsonObject,
  jsonShapeProblem,
  LATEST_PROTOCOL_VERSION,
  response,
  serveNdjson,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_DEFINITION,
  TOOL_NAME,
  type JsonRpcRequest
} from "./mcp.js";
import { notifyApprovalDecided, notifyApprovalRequested } from "./notify.js";

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

/** Flatten and bound a downstream error before it enters durable records. */
function executionErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flattened = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "\uFFFD");
  return flattened.length > 1_000 ? flattened.slice(0, 997) + "..." : flattened;
}

function outcomeIsUnknown(err: unknown): boolean {
  return err instanceof DownstreamError && err.outcome === "unknown";
}

/**
 * A sent tool call may have moved money unless its result is safe and
 * explicit (external 0.5 review). A non-object or unboundedly large
 * result is treated as an UNKNOWN outcome, not a failure: the request
 * reached the child, so the side effect may have happened. An MCP
 * `isError: true` result is a definitive failure reported by a live
 * downstream and stays retryable.
 */
function checkedToolResult(result: unknown): Record<string, unknown> {
  if (!isJsonObject(result)) {
    throw new DownstreamError(
      "downstream tools/call returned a non-object result",
      -32000,
      "unknown"
    );
  }
  const problem = jsonShapeProblem(result);
  if (problem !== null) {
    throw new DownstreamError(
      `downstream tools/call returned an unsafe result shape: ${problem}`,
      -32000,
      "unknown"
    );
  }
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : [];
    const detail = content
      .filter(isJsonObject)
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .find((text) => text.trim().length > 0);
    throw new DownstreamError(
      detail !== undefined
        ? `downstream tool reported failure: ${detail}`
        : "downstream tool reported failure"
    );
  }
  return result;
}

export class GateServer {
  /**
   * The downstream side, one or many servers behind a single facade.
   * Named "downstream" still: from the gate's point of view there is
   * one thing to start, close, and call tools on.
   */
  readonly downstream: DownstreamPool;
  private downstreamTools: DownstreamTool[] = [];
  private readonly clock: () => Date;
  private readonly quiet: boolean;
  /** In-flight approval executions, to prevent a poller/retry double-execution. */
  private readonly executing = new Set<string>();
  private releaseServingLease: (() => void) | null = null;
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
    // A CONFIGURED identity must be valid and is canonicalized to hex
    // (external 0.5 review): an npub and its hex form must not split
    // one agent's cap history into two buckets, and a typo must not
    // silently become a fresh identity. An absent identity keeps the
    // documented fail-closed fallback: the all-zeros pubkey, one shared
    // cap for every unattributed agent, and a startup warning.
    const configuredIdentity = process.env.BUZZ_AXIRU_AGENT_PUBKEY ?? config.agent_pubkey;
    if (configuredIdentity === undefined || configuredIdentity === null) {
      this.agentPubkey = UNATTRIBUTED_PUBKEY;
    } else {
      const normalized = normalizePubkey(configuredIdentity);
      if (normalized === null) {
        throw new Error(
          "buzz-axiru: BUZZ_AXIRU_AGENT_PUBKEY (or agent_pubkey) must be a valid " +
            "64-character lowercase hex key or checksummed npub"
        );
      }
      this.agentPubkey = normalized;
    }
    // FAIL CLOSED: with zero spend controls the policy engine has
    // nothing to deny with, so every mapped payment call would execute
    // immediately while the operator believes a gate is in place. A
    // gate that gates nothing is worse than no gate, because it looks
    // like one.
    if (policiesForAgent(config, this.agentPubkey).length === 0) {
      throw new Error(
        "buzz-axiru: gate mode requires at least one spend control. Configure a daily cap, " +
          "single-payment approval threshold, counterparty allowlist, business hours, or velocity cap."
      );
    }
    this.downstream = new DownstreamPool(config.downstream);
  }

  private get config(): BridgeConfig {
    return this.bridge.config;
  }

  /** Spawn the downstream server, handshake, and cache its tool list. */
  async start(): Promise<void> {
    // One enforcing gate per data directory, for the gate's lifetime
    // (external 0.5 review): the short critical-section lock already
    // serializes writes, but two gates can still each read a cap
    // snapshot the other is about to invalidate. The lease turns that
    // misconfiguration into a loud startup refusal.
    this.releaseServingLease = acquireServingLease(this.config.data_dir);
    try {
      await this.downstream.start(
        LATEST_PROTOCOL_VERSION,
        this.version,
        SUPPORTED_PROTOCOL_VERSIONS
      );
      this.downstreamTools = await this.downstream.listTools();
      this.startAfterLease();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private startAfterLease(): void {
    const gated = this.downstreamTools
      .map((tool) => tool.name)
      .filter((name) => this.isGated(name));
    // The fail-closed rule only covers a MISSING matcher. Once
    // payment_tools is set it is an allowlist of gated names, and a
    // matcher that matches nothing gates nothing: every tool, any
    // money-movers included, would pass straight through a gate the
    // operator believes is enforcing. Refuse to start instead; a
    // startup warning on a background MCP server's stderr is a warning
    // nobody reads.
    if (!this.gateAll && gated.length === 0) {
      throw new Error(
        "buzz-axiru: payment_tools is configured, but no exposed downstream tool matches " +
          "any gate pattern. Refusing to start an enforcing gate that protects nothing. " +
          "Run `buzz-axiru doctor` and fix payment_tools.gate."
      );
    }
    if (!this.quiet) {
      const perServer = this.downstream.servers
        .map((server) => {
          const count = this.downstreamTools.filter(
            (t) => this.downstream.serverFor(t.name) === server.name
          ).length;
          return `${server.name} (${count} tools)`;
        })
        .join(", ");
      process.stderr.write(
        `buzz-axiru gate: downstream up: ${perServer} | ` +
          `${this.downstreamTools.length} tools total | gated: ${gated.join(", ") || "(none)"}\n`
      );
      if (this.gateAll) {
        process.stderr.write(
          "buzz-axiru gate: WARNING: no payment_tools matcher in the config file. " +
            "Failing closed: EVERY tool from EVERY configured downstream server is " +
            "gated, shell tools included, and with no amount mappings every call " +
            "will require human approval. Add payment_tools to gate only the tools " +
            "that move money.\n"
        );
      }
      // A zero-match matcher is refused above; a partial matcher is
      // still operator-defined, and a money tool the operator did not
      // list passes straight through. Stable prefixes remain the
      // safest boundary, so that mistake is worth a startup note.
      if (!this.gateAll) {
        const unprefixed = this.downstream.servers
          .filter((server) => server.tool_prefix === "")
          .map((server) => server.name);
        if (unprefixed.length > 0) {
          process.stderr.write(
            `buzz-axiru gate: NOTE: server(s) ${unprefixed.join(", ")} expose tools under ` +
              "names the server itself chooses, and the gate patterns match those names. " +
              "A server that renames a tool leaves the gate. Set a \"tool_prefix\" and gate " +
              "the prefix if that server moves money.\n"
          );
        }
      }
      if (this.agentPubkey === UNATTRIBUTED_PUBKEY) {
        process.stderr.write(
          "buzz-axiru gate: WARNING: no agent identity configured " +
            "(BUZZ_AXIRU_AGENT_PUBKEY or agent_pubkey). Decisions are attributed " +
            "to the all-zeros pubkey, so all unattributed agents share one daily cap.\n"
        );
      }
      // Legacy configs can still explicitly request this lossy mode:
      // every downstream child then sees the bridge's own signing key.
      const inheriting = this.downstream.servers.filter(
        (server) => server.env_passthrough === "all"
      );
      if (inheriting.length > 0 && process.env.BUZZ_PRIVATE_KEY !== undefined) {
        process.stderr.write(
          `buzz-axiru gate: NOTE: ${inheriting.map((s) => s.name).join(", ")} inherit this ` +
            "process's full environment, BUZZ_PRIVATE_KEY included. Set " +
            "\"env_passthrough\": \"none\" (or a list of variable names) on servers that " +
            "do not need it.\n"
        );
      }
    }
  }

  close(): void {
    this.downstream.close();
    this.releaseServingLease?.();
    this.releaseServingLease = null;
  }

  /**
   * toolName is the EXPOSED name: payment_tools.gate patterns and
   * payment_tools.mappings keys match the name the agent sees, which
   * already includes the owning server's tool_prefix.
   */
  isGated(toolName: string): boolean {
    if (toolName === TOOL_NAME) return false;
    return isGatedTool(this.config, toolName);
  }

  /** Handle one JSON-RPC message from the agent. Null for notifications. */
  async handleMessage(raw: string): Promise<string | null> {
    try {
      return await this.dispatch(raw);
    } catch (err) {
      // The agent is untrusted, and an unhandled rejection out of here
      // ends the serve loop and the process with it. Every gate that
      // dies is a gate that stops gating, so failures become protocol
      // errors instead.
      return errorResponse(null, -32603, `Internal error: ${(err as Error).message}`);
    }
  }

  private async dispatch(raw: string): Promise<string | null> {
    let message: JsonRpcRequest;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isJsonObject(parsed)) return errorResponse(null, -32600, "Invalid Request: expected an object");
      message = parsed as unknown as JsonRpcRequest;
    } catch {
      return errorResponse(null, -32700, "Parse error: not valid JSON");
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return errorResponse(null, -32600, "Invalid Request: expected jsonrpc \"2.0\" and a method");
    }
    if (message.params !== undefined && !isJsonObject(message.params)) {
      return errorResponse(message.id ?? null, -32602, "Invalid params: expected an object");
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
    // The pool already applied hide_tools and tool_prefix, so these are
    // the exposed names and nothing else needs filtering here.
    const tools: Array<Record<string, unknown>> = [TOOL_DEFINITION as unknown as Record<string, unknown>];
    for (const tool of this.downstreamTools) {
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
    const rawArgs = params.arguments ?? {};
    if (typeof name !== "string") {
      return errorResponse(id, -32602, "tools/call requires a tool name");
    }
    if (!isJsonObject(rawArgs)) {
      return errorResponse(id, -32602, "tools/call arguments must be an object");
    }
    const args = rawArgs;
    // Checked before anything walks the arguments: the fingerprint,
    // the memo, and the policy evaluator all recurse over this object.
    const shapeProblem = jsonShapeProblem(args);
    if (shapeProblem !== null) {
      return errorResponse(id, -32602, `tools/call rejected: ${shapeProblem}`);
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

    // Hidden tools never entered the pool's catalog, so "unknown" covers
    // both never-existed and deliberately hidden.
    if (!this.downstream.hasTool(name)) {
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
    const callFingerprint = gatedCallFingerprint(name, args, this.agentPubkey);

    // Replay barrier for direct (no-approval) calls (external 0.5
    // review). A successful exact call is never re-executed just
    // because the agent missed the response, and an exact call whose
    // outcome is still ambiguous is held rather than retried: money may
    // already have moved.
    const priorDirect = this.bridge.ledger.latestDirectExecution(callFingerprint);
    if (priorDirect?.execution_status === "executed") {
      return response(
        id,
        textResult(
          {
            status: "already_executed",
            executed: true,
            decision: "deduplicated",
            reason_code: "bridge.execution.duplicate_suppressed",
            fingerprint: callFingerprint,
            executed_at: priorDirect.ts,
            guidance:
              "This exact payment call already completed and the gate suppressed a duplicate. " +
              "Do not issue it again; retrieve its receipt from the payment provider using the " +
              "business idempotency key in the original arguments."
          },
          false
        )
      );
    }
    if (priorDirect?.execution_status === "in_progress") {
      return response(
        id,
        textResult(
          {
            status: "execution_outcome_unknown",
            executed: "unknown",
            decision: "hold",
            reason_code: "bridge.execution.reconciliation_required",
            fingerprint: callFingerprint,
            execution_started_at: priorDirect.ts,
            guidance:
              "This exact call was durably claimed but its downstream outcome was lost. The gate " +
              "suppressed a retry because money may already have moved. Verify with the payment " +
              "provider, then run `buzz-axiru reconcile " + callFingerprint + "`. Do not vary " +
              "arguments to bypass this hold."
          },
          true
        )
      );
    }

    // A prior decision for this exact call outranks re-evaluation.
    const existing = this.bridge.approvals.byFingerprint(callFingerprint);
    if (existing) {
      const resolved = await this.resolveExistingApproval(id, name, existing, now);
      if (resolved !== null) return resolved;
    }

    const extraction = extractPayment(this.config, name, args);
    // Approval files retain the exact arguments for local inspection
    // (`buzz-axiru show <id>`). Ledger memos and notification summaries
    // must not echo arbitrary argument fields: payment calls often
    // carry API tokens, customer secrets, or PII.
    const memo = `Gated call to ${name}`;

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

    // FAIL CLOSED: this policy pack is denominated in ONE currency
    // (config.currency), and the daily cap, single-payment ceiling, and
    // rolling-window aggregates are all scoped to it. A payment in any
    // other currency cannot be compared against them: the guardrails
    // engine would weigh the foreign amount against same-currency
    // history that never includes it, so the per-agent daily cap silently
    // never fires and the call fails OPEN. A raw cross-currency compare
    // (100000 JPY treated as 100000 USD cents) is just as wrong. Park it
    // for a human rather than allow an uncapped foreign-currency spend.
    if (extraction.currency !== this.config.currency) {
      return this.parkCall(id, name, args, callFingerprint, now, {
        reason_code: "bridge.pending.currency_mismatch",
        reason_text:
          `payment currency ${extraction.currency} does not match the policy currency ` +
          `${this.config.currency}; this policy pack evaluates a single currency and cannot ` +
          "compare cross-currency spend, so the call is parked for human review",
        amount_minor_units: extraction.amount_minor_units,
        currency: extraction.currency,
        counterparty: extraction.counterparty,
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

    let result: ReturnType<Bridge["policyEvaluate"]>["result"] | undefined;
    let evaluationError: unknown;
    // Cap snapshot, policy decision, decision record, and the direct
    // pre-execution claim share ONE critical section (external 0.5
    // review). The claim is durable BEFORE the network side effect, so
    // a crash on either side of the downstream call leaves an
    // in_progress reservation instead of a replayable, uncounted call.
    // The data-dir lock is reentrant, so the nested ledger appends are
    // safe.
    withDataDirLock(this.config.data_dir, () => {
      try {
        ({ result } = this.bridge.policyEvaluate(request, now));
      } catch (err) {
        evaluationError = err;
        return;
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
      if (result.decision === "allow") {
        this.appendExecution(
          name,
          {
            approval_id: undefined,
            fingerprint: callFingerprint,
            amount_minor_units: extraction.amount_minor_units,
            currency: extraction.currency,
            counterparty: extraction.counterparty,
            memo,
            now
          },
          "in_progress",
          undefined
        );
      }
    });
    if (result === undefined) {
      // Unevaluable input (currency mismatch shapes, etc.): fail closed.
      return this.parkCall(id, name, args, callFingerprint, now, {
        reason_code: "bridge.pending.policy_unevaluable",
        reason_text:
          evaluationError instanceof Error ? evaluationError.message : String(evaluationError),
        amount_minor_units: extraction.amount_minor_units,
        currency: extraction.currency,
        counterparty: extraction.counterparty,
        memo,
        policy_fingerprint: undefined
      });
    }

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
          // Granted but the poller has not executed it yet: do so now.
          const executed = await this.executeApproved(existing, now);
          if (
            executed.execution_status === "executed" ||
            executed.execution_status === "failed" ||
            (executed.execution_status === "in_progress" &&
              executed.execution_error !== undefined)
          ) {
            await notifyApprovalDecided(this.config, executed);
          }
          return this.approvedOutcomeResponse(id, executed);
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
    if (approval.execution_status === "in_progress" || approval.execution_status === undefined) {
      // A durable claim exists but no final outcome does: the process
      // died (or is dying) between the claim and the response record.
      // The downstream may already have moved money, so never retry
      // automatically. Surface the ambiguity to the agent and the
      // operator instead.
      return response(
        id,
        textResult(
          {
            status:
              approval.execution_error !== undefined
                ? "execution_outcome_unknown"
                : "execution_in_progress_or_unknown",
            executed: "unknown",
            decision: "hold",
            reason_code: "bridge.execution.reconciliation_required",
            approval_id: approval.approval_id,
            execution_started_at: approval.execution_started_at ?? null,
            ...(approval.execution_error !== undefined
              ? { error: approval.execution_error }
              : {}),
            guidance:
              "This approved call was durably claimed for execution, but no final outcome is recorded yet. " +
              "The gate will not retry it because the downstream may already have moved money. Verify the " +
              "payment provider using its business idempotency key, then reconcile this approval with " +
              "`buzz-axiru reconcile`."
          },
          true
        )
      );
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
    let approval: ApprovalRequest;
    try {
      approval = this.bridge.approvals.createOrGet(
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
      now,
      this.config.max_pending_approvals
      );
    } catch (err) {
      if (!(err instanceof ApprovalQueueFullError)) throw err;
      // FAIL CLOSED: no room to park it means nobody can approve it,
      // so the call is refused outright rather than dropped on the
      // floor with a pending-looking answer.
      this.bridge.ledger.append({
        type: "decision",
        actor: this.agentPubkey,
        agent_pubkey: this.agentPubkey,
        decision: "deny",
        reason_code: "bridge.deny.approval_queue_full",
        amount_minor_units: details.amount_minor_units,
        currency: details.currency,
        counterparty: details.counterparty,
        memo: details.memo,
        fingerprint: callFingerprint,
        tool_name: name,
        note: err.message,
        ts: now.toISOString()
      });
      return response(
        id,
        textResult(
          {
            status: "denied_by_policy",
            executed: false,
            decision: "deny",
            reason_code: "bridge.deny.approval_queue_full",
            error: err.message,
            guidance:
              "The approval queue is full, so this payment tool call was refused and NOT executed. " +
              "Stop issuing payment calls and ask a human to clear the queue."
          },
          true
        )
      );
    }
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
            "If approved, the gate will durably claim the original call before executing it."
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
    // The caller durably recorded the in-progress claim in the same
    // critical section as its cap snapshot and allow decision. From the
    // first network operation onward, every failure must finalize or
    // preserve that claim, never discard it.
    try {
      const result = checkedToolResult(await this.downstream.callTool(name, args));
      this.appendExecution(name, meta, "executed", undefined);
      return response(id, result);
    } catch (err) {
      const error = executionErrorText(err);
      if (outcomeIsUnknown(err)) {
        // No approval record exists for a direct allow, so the ledger's
        // in_progress record is both the durable cap reservation and
        // the operator-visible incident.
        this.appendExecution(name, meta, "in_progress", error);
        return response(
          id,
          textResult(
            {
              status: "execution_outcome_unknown",
              executed: "unknown",
              decision: "hold",
              reason_code: "bridge.execution.reconciliation_required",
              fingerprint: meta.fingerprint,
              error,
              guidance:
                "The downstream server received this call but no definitive outcome reached the " +
                "gate. Do NOT retry: money may already have moved, and this amount is reserved " +
                "against the cap. Verify with the payment provider, then run `buzz-axiru " +
                "reconcile " + meta.fingerprint + "`."
            },
            true
          )
        );
      }
      this.appendExecution(name, meta, "failed", error);
      return response(
        id,
        textResult(
          {
            status: "execution_failed",
            executed: false,
            reason_code: "bridge.execution.failed",
            error,
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
    status: "in_progress" | "executed" | "failed",
    error: string | undefined,
    resultFingerprint?: string
  ): void {
    this.bridge.ledger.append({
      type: "execution",
      actor: "bridge",
      agent_pubkey: this.agentPubkey,
      reason_code:
        status === "in_progress"
          ? error === undefined
            ? "bridge.execution.started"
            : "bridge.execution.outcome_unknown"
          : status === "executed"
            ? "bridge.execution.ok"
            : "bridge.execution.failed",
      amount_minor_units: meta.amount_minor_units,
      currency: meta.currency,
      counterparty: meta.counterparty,
      memo: meta.memo,
      fingerprint: meta.fingerprint,
      tool_name: name,
      execution_status: status,
      ...(error !== undefined ? { error } : {}),
      ...(resultFingerprint !== undefined ? { result_fingerprint: resultFingerprint } : {}),
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

  /**
   * Re-derive the human-visible payment fields from the parked call
   * immediately before execution. The store's fingerprint binding
   * already proves the arguments are the approved bytes; this proves
   * the amount, currency, and counterparty the approver saw still
   * describe those bytes under the CURRENT mapping config.
   */
  private approvalCallProblem(approval: ApprovalRequest): string | null {
    if (approval.call === undefined) return "the granted approval has no parked call";
    const extraction = extractPayment(
      this.config,
      approval.call.tool_name,
      approval.call.arguments
    );
    if (!extraction.ok) {
      if (
        approval.amount_minor_units !== "unknown" ||
        approval.currency !== this.config.currency ||
        approval.counterparty !== `tool:${approval.call.tool_name}`
      ) {
        return "the parked call no longer matches the amount, currency, and counterparty shown to the approver";
      }
      return null;
    }
    if (
      approval.amount_minor_units !== extraction.amount_minor_units ||
      approval.currency !== extraction.currency ||
      approval.counterparty !== extraction.counterparty
    ) {
      return "the parked call no longer matches the amount, currency, and counterparty shown to the approver";
    }
    return null;
  }

  /** Durably claim and execute one granted parked call downstream. */
  private async executeApproved(approval: ApprovalRequest, now: Date): Promise<ApprovalRequest> {
    if (this.executing.has(approval.approval_id)) {
      return this.bridge.approvals.get(approval.approval_id) ?? approval;
    }
    if (approval.call === undefined) {
      // An advisory-mode approval that shares this data directory has
      // no parked call. Nothing to execute, and inventing one would be
      // executing something no human ever saw.
      return approval;
    }
    // The claim is the at-most-once boundary: it is persisted BEFORE
    // the downstream call, so a crash on either side of the network
    // side effect leaves an in_progress record that is never retried
    // automatically. Exactly one claimer wins across processes.
    const claim = this.bridge.approvals.claimExecution(approval.approval_id, now);
    if (!claim.claimed) return claim.approval;
    this.executing.add(approval.approval_id);
    try {
      const claimed = claim.approval;
      const call = claimed.call!;
      const meta = {
        approval_id: claimed.approval_id,
        fingerprint: claimed.fingerprint,
        amount_minor_units: claimed.amount_minor_units,
        currency: claimed.currency,
        counterparty: claimed.counterparty,
        memo: claimed.memo,
        now
      };
      // Cross-check the mutable store against the hash-chained ledger
      // and re-derive the human-visible payment fields immediately
      // before money moves (external 0.5 review, narrowed to the
      // execution boundary). A grant that only exists in the store, or
      // a parked call that no longer extracts to the amount the human
      // saw, is refused and the grant is spent.
      const stateProblem =
        this.bridge.ledger.grantRecordProblem(claimed) ?? this.approvalCallProblem(claimed);
      if (stateProblem !== null) {
        const error = `approval state integrity check failed: ${stateProblem}`;
        this.appendExecution(call.tool_name, meta, "failed", error);
        return this.bridge.approvals.recordExecution(claimed.approval_id, {
          status: "failed",
          error,
          at: now
        });
      }
      // Audit the claim before the network side effect. Any failure
      // from here onward leaves the approval non-retryable and
      // requiring manual reconciliation.
      this.appendExecution(call.tool_name, meta, "in_progress", undefined);
      let result: unknown;
      try {
        result = checkedToolResult(
          await this.downstream.callTool(call.tool_name, call.arguments)
        );
      } catch (err) {
        const error = executionErrorText(err);
        if (outcomeIsUnknown(err)) {
          // The transport lost the outcome, not the call. Keep the
          // claim in_progress (non-retryable, cap-reserving) and attach
          // the evidence for `pending` and the operator.
          this.appendExecution(call.tool_name, meta, "in_progress", error);
          return this.bridge.approvals.recordExecutionUncertain(claimed.approval_id, error);
        }
        this.appendExecution(call.tool_name, meta, "failed", error);
        return this.bridge.approvals.recordExecution(claimed.approval_id, {
          status: "failed",
          error,
          at: now
        });
      }
      // Keep persistence failures out of the downstream-error catch.
      // If either write fails after the provider returned success, the
      // durable claim remains in_progress and therefore non-retryable.
      // The result fingerprint binds the retained provider result to
      // the hash chain, so a later store edit cannot silently change
      // what an idempotent re-read returns.
      this.appendExecution(
        call.tool_name,
        meta,
        "executed",
        undefined,
        executionResultFingerprint(result)
      );
      return this.bridge.approvals.recordExecution(claimed.approval_id, {
        status: "executed",
        result,
        at: now
      });
    } finally {
      this.executing.delete(approval.approval_id);
    }
  }

  /**
   * One sweep of the approval queue: expire overdue pending approvals
   * and execute granted parked calls that have not been claimed yet.
   * The serve loop calls this on an interval; tests call it directly.
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
      // An approval left in_progress by a crash is deliberately NOT a
      // decided outcome; the operator resolves it via `reconcile`. An
      // in_progress claim WITH attached evidence is a fresh ambiguous
      // outcome, and the operator should hear about it now.
      if (
        executed.execution_status === "executed" ||
        executed.execution_status === "failed" ||
        (executed.execution_status === "in_progress" && executed.execution_error !== undefined)
      ) {
        await notifyApprovalDecided(this.config, executed);
      }
    }
  }

  private granteesAwaitingExecution(): ApprovalRequest[] {
    // execution_status undefined means never claimed. An in_progress
    // record from a previous run is excluded on purpose: replaying it
    // is exactly the double-payment this claim design exists to stop.
    return this.bridge.approvals
      .all()
      .filter(
        (a) => a.status === "granted" && a.call !== undefined && a.execution_status === undefined
      );
  }

  /** Serve newline-delimited JSON-RPC on stdin/stdout until stdin closes. */
  async serveStdio(): Promise<void> {
    await serveNdjson(process.stdin, process.stdout, (line) => this.handleMessage(line));
  }
}
