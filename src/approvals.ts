/**
 * Pending approvals store.
 *
 * A require_approval decision parks the intent here until a human
 * grants or denies it with the buzz-axiru CLI. The store is a small
 * JSON file in the data directory; the tamper-evident record of what
 * happened lives in the ledger, not here.
 *
 * Approval ids are derived from the intent fingerprint, so an agent
 * re-requesting the same intent maps onto the same approval instead
 * of spamming the queue. A grant is single-use: the next identical
 * request consumes it and is allowed; the one after that goes back
 * through policy.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired";

/** A gated downstream tool call, parked verbatim for replay on approval. */
export interface ParkedCall {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ApprovalRequest {
  approval_id: string;
  fingerprint: string;
  agent_pubkey: string;
  amount_minor_units: string;
  currency: string;
  counterparty: string;
  memo: string;
  reason_code: string;
  requested_at: string;
  status: ApprovalStatus;
  decided_by?: string;
  decided_at?: string;
  note?: string;
  /** True once a grant has been consumed by a follow-up request. */
  consumed?: boolean;
  /** When this approval stops being decidable (ISO). Absent = no expiry. */
  expires_at?: string;
  /** Gate mode: the original tool call to replay after a grant. */
  call?: ParkedCall;
  /** Gate mode: outcome of the replay against the downstream server. */
  execution_status?: "executed" | "failed";
  executed_at?: string;
  /** The downstream tools/call result, stored for idempotent re-reads. */
  execution_result?: unknown;
  execution_error?: string;
}

export function approvalIdForFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^sha256:/, "").slice(0, 12);
}

export function isExpired(approval: ApprovalRequest, now: Date): boolean {
  if (approval.expires_at === undefined) return false;
  const at = Date.parse(approval.expires_at);
  return Number.isFinite(at) && now.getTime() >= at;
}

export class ApprovalStore {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "approvals.json");
  }

  private load(): Record<string, ApprovalRequest> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, ApprovalRequest>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, ApprovalRequest>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", "utf8");
    renameSync(tmp, this.filePath);
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.load()[approvalId];
  }

  byFingerprint(fingerprint: string): ApprovalRequest | undefined {
    return this.load()[approvalIdForFingerprint(fingerprint)];
  }

  pending(): ApprovalRequest[] {
    return Object.values(this.load()).filter((a) => a.status === "pending");
  }

  all(): ApprovalRequest[] {
    return Object.values(this.load());
  }

  /** Create a pending approval, or return the existing record for this intent. */
  createOrGet(
    request: Omit<ApprovalRequest, "approval_id" | "requested_at" | "status">,
    now: Date = new Date()
  ): ApprovalRequest {
    const all = this.load();
    const id = approvalIdForFingerprint(request.fingerprint);
    const existing = all[id];
    if (existing) return existing;
    const created: ApprovalRequest = {
      ...request,
      approval_id: id,
      requested_at: now.toISOString(),
      status: "pending"
    };
    all[id] = created;
    this.save(all);
    return created;
  }

  decide(
    approvalId: string,
    status: "granted" | "denied",
    decidedBy: string,
    note?: string,
    now: Date = new Date()
  ): ApprovalRequest {
    const all = this.load();
    const approval = all[approvalId];
    if (!approval) {
      throw new Error(`buzz-axiru: no approval with id ${approvalId}`);
    }
    if (approval.status === "pending" && isExpired(approval, now)) {
      approval.status = "expired";
      this.save(all);
      throw new Error(
        `buzz-axiru: approval ${approvalId} expired at ${approval.expires_at} and can no longer be ${status}`
      );
    }
    if (approval.status !== "pending") {
      throw new Error(
        `buzz-axiru: approval ${approvalId} was already ${approval.status}` +
          (approval.decided_by !== undefined ? ` by ${approval.decided_by}` : "")
      );
    }
    approval.status = status;
    approval.decided_by = decidedBy;
    approval.decided_at = now.toISOString();
    if (note !== undefined) approval.note = note;
    this.save(all);
    return approval;
  }

  /**
   * Transition an overdue pending approval to expired. Returns the
   * updated record when THIS call performed the transition (so exactly
   * one caller appends the ledger record), undefined otherwise.
   */
  markExpired(approvalId: string, now: Date = new Date()): ApprovalRequest | undefined {
    const all = this.load();
    const approval = all[approvalId];
    if (!approval || approval.status !== "pending" || !isExpired(approval, now)) {
      return undefined;
    }
    approval.status = "expired";
    this.save(all);
    return approval;
  }

  /** Record the downstream replay outcome for a granted parked call. */
  recordExecution(
    approvalId: string,
    outcome:
      | { status: "executed"; result: unknown; at: Date }
      | { status: "failed"; error: string; at: Date }
  ): ApprovalRequest {
    const all = this.load();
    const approval = all[approvalId];
    if (!approval) {
      throw new Error(`buzz-axiru: no approval with id ${approvalId}`);
    }
    approval.execution_status = outcome.status;
    approval.executed_at = outcome.at.toISOString();
    if (outcome.status === "executed") {
      approval.execution_result = outcome.result;
    } else {
      approval.execution_error = outcome.error;
    }
    approval.consumed = true;
    this.save(all);
    return approval;
  }

  /** Mark a granted approval as used so it cannot authorize a second transfer. */
  consume(approvalId: string): void {
    const all = this.load();
    const approval = all[approvalId];
    if (approval && approval.status === "granted") {
      approval.consumed = true;
      this.save(all);
    }
  }
}
