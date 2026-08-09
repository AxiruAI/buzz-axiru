/**
 * The evaluation core: one spend request in, one decision out, one
 * ledger record always.
 *
 * Order of operations:
 *   1. Validate the request shape (amounts are integer strings in
 *      minor units; the pubkey must look like a Nostr identity).
 *   2. If a human already granted this exact intent, consume the
 *      grant and allow. If a human denied it, deny. Human decisions
 *      outrank policy re-evaluation for the same intent.
 *   3. Otherwise evaluate with @axiru/agent-spend-guardrails, feeding
 *      rolling-window history computed from this bridge's own ledger.
 *   4. Append the decision to the hash-chained ledger with the
 *      agent's Nostr pubkey as the actor.
 *   5. On require_approval, park a pending approval and notify the
 *      Buzz channel (or webhook).
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { join } from "node:path";

import { guardAgentSpend, type GuardReason, type GuardResult } from "@axiru/agent-spend-guardrails";

import { ApprovalStore, isExpired } from "./approvals.js";
import { isPlausiblePubkey, policiesForAgent, type BridgeConfig } from "./config.js";
import { historyForAgent, Ledger, type LedgerRecord } from "./ledger.js";
import { notifyApprovalRequested } from "./notify.js";

export interface SpendRequest {
  amount_minor_units: string;
  currency: string;
  counterparty: string;
  memo: string;
  agent_pubkey: string;
}

export interface SpendDecision {
  decision: "allow" | "require_approval" | "deny";
  reason_code: string;
  reasons: GuardReason[];
  summary_code: string;
  fingerprint: string;
  decision_id: string;
  evaluated_at: string;
  agent_pubkey: string;
  approval_id?: string;
  /** What the agent should do next, in plain words. */
  guidance: string;
  ledger: { seq: number; hash: string };
}

const INTEGER_STRING = /^[0-9]+$/;

export class Bridge {
  readonly ledger: Ledger;
  readonly approvals: ApprovalStore;

  constructor(readonly config: BridgeConfig) {
    this.ledger = new Ledger(join(config.data_dir, "ledger.jsonl"));
    this.approvals = new ApprovalStore(config.data_dir);
  }

  validate(request: SpendRequest): string | null {
    if (typeof request.amount_minor_units !== "string" || !INTEGER_STRING.test(request.amount_minor_units)) {
      return "amount_minor_units must be a non-negative base-10 integer string (cents for USD)";
    }
    if (typeof request.currency !== "string" || request.currency.trim().length === 0) {
      return "currency must be a non-empty string, e.g. \"USD\"";
    }
    if (typeof request.counterparty !== "string" || request.counterparty.trim().length === 0) {
      return "counterparty must be a non-empty string id";
    }
    if (typeof request.memo !== "string") {
      return "memo must be a string";
    }
    if (typeof request.agent_pubkey !== "string" || !isPlausiblePubkey(request.agent_pubkey)) {
      return "agent_pubkey must be the agent's Nostr pubkey (64-char lowercase hex, or npub form)";
    }
    // The env var wins, then policies.json. Reading only the env var
    // meant an operator who pinned agent_pubkey in the config file got
    // no pinning at all in advisory mode, while gate mode honoured it:
    // the per-agent daily cap is keyed on this string, so an unpinned
    // advisory bridge lets an agent reset its own cap by picking a
    // different pubkey on the next call.
    const pinned = process.env.BUZZ_AXIRU_AGENT_PUBKEY ?? this.config.agent_pubkey;
    if (pinned && pinned !== request.agent_pubkey) {
      return `agent_pubkey does not match the pinned identity this bridge instance was started for`;
    }
    return null;
  }

  /**
   * Pure policy evaluation: validate, load rolling-window history from
   * the ledger, run the guardrails engine. No ledger writes, no
   * approval-queue side effects. Gate mode composes this with its own
   * orchestration; advisory evaluate() builds on it below.
   */
  policyEvaluate(request: SpendRequest, now?: Date): { result: GuardResult; clock: Date; currency: string } {
    const problem = this.validate(request);
    if (problem) {
      throw new TypeError(`buzz-axiru: invalid request: ${problem}`);
    }
    const clock = now ?? new Date();
    const currency = request.currency.toUpperCase();

    // Single-currency invariant. The policy pack is denominated in
    // config.currency and rolling-window history is scoped to it, so a
    // request in any other currency cannot be evaluated without a silent
    // cross-currency comparison that fails OPEN (the daily cap and
    // aggregates never see the foreign amount). Fail closed instead. In
    // gate mode this throw is caught and parked as require_approval; the
    // gate also screens currency before it ever gets here, so this is the
    // backstop for the advisory tool and the CLI decide path.
    const policyCurrency = this.config.currency.toUpperCase();
    if (currency !== policyCurrency) {
      throw new TypeError(
        `buzz-axiru: request currency ${currency} does not match the policy currency ` +
          `${policyCurrency}; this bridge evaluates a single currency and cannot compare ` +
          "cross-currency spend"
      );
    }

    const history = historyForAgent(
      this.ledger.filePath,
      request.agent_pubkey,
      this.config.currency,
      clock
    );

    const result = guardAgentSpend({
      intent: {
        rail: this.config.rail,
        action: "pay",
        amount: { currency, minor_units: request.amount_minor_units },
        agent: { id: request.agent_pubkey, scope: "payments.request" },
        counterparty: { id: request.counterparty },
        timestamp: clock
      },
      policies: policiesForAgent(this.config, request.agent_pubkey),
      history,
      now: clock
    });
    return { result, clock, currency };
  }

  /**
   * Advisory evaluation: policy decision plus ledger append, approval
   * parking, and human-grant handling. `now` exists for deterministic
   * tests and replay; production callers omit it, and the server clock
   * is used so agents cannot influence time-of-day policy evaluation.
   */
  async evaluate(request: SpendRequest, now?: Date): Promise<SpendDecision> {
    const { result, clock, currency } = this.policyEvaluate(request, now);

    // Human decisions for this exact intent outrank re-evaluation.
    let existing = this.approvals.byFingerprint(result.fingerprint);
    if (existing && existing.status === "pending" && isExpired(existing, clock)) {
      const expired = this.approvals.markExpired(existing.approval_id, clock);
      if (expired) {
        this.ledger.append({
          type: "approval_expired",
          actor: "bridge",
          agent_pubkey: expired.agent_pubkey,
          reason_code: "bridge.expired.approval_ttl",
          amount_minor_units: expired.amount_minor_units,
          currency: expired.currency,
          counterparty: expired.counterparty,
          memo: expired.memo,
          fingerprint: expired.fingerprint,
          approval_id: expired.approval_id,
          ts: clock.toISOString()
        });
      }
      existing = this.approvals.byFingerprint(result.fingerprint);
    }
    if (existing && existing.status === "expired") {
      const record = this.appendDecision(request, currency, "deny", "bridge.deny.approval_expired", result.fingerprint, existing.approval_id, clock);
      return this.decisionResult(request, result.fingerprint, result.decision_id, clock, {
        decision: "deny",
        reason_code: "bridge.deny.approval_expired",
        reasons: [
          {
            reason_code: "bridge.deny.approval_expired",
            reason_text: `Approval ${existing.approval_id} expired at ${existing.expires_at} before a human decided`
          }
        ],
        summary_code: "bridge.deny.approval_expired",
        approval_id: existing.approval_id,
        guidance:
          "The approval window for this intent expired before a human decided. Do not retry the identical intent; ask a human in the channel first.",
        record
      });
    }
    if (existing && existing.status === "granted" && !existing.consumed) {
      this.approvals.consume(existing.approval_id);
      const record = this.appendDecision(request, currency, "allow", "bridge.allow.human_approved", result.fingerprint, existing.approval_id, clock);
      return this.decisionResult(request, result.fingerprint, result.decision_id, clock, {
        decision: "allow",
        reason_code: "bridge.allow.human_approved",
        reasons: [
          {
            reason_code: "bridge.allow.human_approved",
            reason_text: `Approved by ${existing.decided_by ?? "operator"} (approval ${existing.approval_id}); grant consumed`
          }
        ],
        summary_code: "bridge.allow.human_approved",
        approval_id: existing.approval_id,
        guidance:
          "A human approved this exact intent. The grant is now consumed. Proceed with the payment tool once, then stop.",
        record
      });
    }
    if (existing && existing.status === "denied") {
      const record = this.appendDecision(request, currency, "deny", "bridge.deny.human_denied", result.fingerprint, existing.approval_id, clock);
      return this.decisionResult(request, result.fingerprint, result.decision_id, clock, {
        decision: "deny",
        reason_code: "bridge.deny.human_denied",
        reasons: [
          {
            reason_code: "bridge.deny.human_denied",
            reason_text: `Denied by ${existing.decided_by ?? "operator"}${existing.note ? `: ${existing.note}` : ""}`
          }
        ],
        summary_code: "bridge.deny.human_denied",
        approval_id: existing.approval_id,
        guidance: "A human denied this intent. Do not retry it. Ask in the channel if you believe this is wrong.",
        record
      });
    }

    const record = this.appendDecision(
      request,
      currency,
      result.decision,
      result.reason_code,
      result.fingerprint,
      undefined,
      clock
    );

    if (result.decision === "require_approval") {
      const approval = this.approvals.createOrGet(
        {
          fingerprint: result.fingerprint,
          agent_pubkey: request.agent_pubkey,
          amount_minor_units: request.amount_minor_units,
          currency,
          counterparty: request.counterparty,
          memo: request.memo,
          reason_code: result.reason_code,
          ...(this.config.approval_ttl_seconds !== null
            ? { expires_at: new Date(clock.getTime() + this.config.approval_ttl_seconds * 1000).toISOString() }
            : {})
        },
        clock,
        this.config.max_pending_approvals
      );
      await notifyApprovalRequested(this.config, approval);
      return this.decisionResult(request, result.fingerprint, result.decision_id, clock, {
        decision: result.decision,
        reason_code: result.reason_code,
        reasons: result.reasons,
        summary_code: result.summary_code,
        approval_id: approval.approval_id,
        guidance:
          `Hold. Do NOT execute this payment. A human has been asked to decide (approval id ${approval.approval_id}). ` +
          "Call request_spend_approval again with the same arguments after a human responds in the channel.",
        record
      });
    }

    return this.decisionResult(request, result.fingerprint, result.decision_id, clock, {
      decision: result.decision,
      reason_code: result.reason_code,
      reasons: result.reasons,
      summary_code: result.summary_code,
      guidance:
        result.decision === "allow"
          ? "Allowed by policy. Proceed with the payment tool once, then stop."
          : "Denied by policy. Do not execute this payment and do not retry with altered parameters.",
      record
    });
  }

  private appendDecision(
    request: SpendRequest,
    currency: string,
    decision: "allow" | "require_approval" | "deny",
    reasonCode: string,
    fingerprint: string,
    approvalId: string | undefined,
    clock: Date
  ): LedgerRecord {
    return this.ledger.append({
      type: "decision",
      actor: request.agent_pubkey,
      agent_pubkey: request.agent_pubkey,
      decision,
      reason_code: reasonCode,
      amount_minor_units: request.amount_minor_units,
      currency,
      counterparty: request.counterparty,
      memo: request.memo,
      fingerprint,
      ...(approvalId !== undefined ? { approval_id: approvalId } : {}),
      ts: clock.toISOString()
    });
  }

  private decisionResult(
    request: SpendRequest,
    fingerprint: string,
    decisionId: string,
    clock: Date,
    fields: {
      decision: "allow" | "require_approval" | "deny";
      reason_code: string;
      reasons: GuardReason[];
      summary_code: string;
      approval_id?: string;
      guidance: string;
      record: LedgerRecord;
    }
  ): SpendDecision {
    return {
      decision: fields.decision,
      reason_code: fields.reason_code,
      reasons: fields.reasons,
      summary_code: fields.summary_code,
      fingerprint,
      decision_id: decisionId,
      evaluated_at: clock.toISOString(),
      agent_pubkey: request.agent_pubkey,
      ...(fields.approval_id !== undefined ? { approval_id: fields.approval_id } : {}),
      guidance: fields.guidance,
      ledger: { seq: fields.record.seq, hash: fields.record.hash }
    };
  }
}
