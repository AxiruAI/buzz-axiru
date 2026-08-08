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
 * Every mutation is a read-modify-write over the whole file, so each
 * one runs inside the data directory lock (src/lock.ts). Without it
 * the gate process and the approve/deny CLI lose each other's updates,
 * which can resurrect an approval one of them had already expired.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withDataDirLock } from "./lock.js";

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired";

/**
 * Raised when a new approval would push the pending queue past the
 * configured ceiling. Its own class so callers can turn it into a
 * refusal for the agent instead of a generic internal error: the agent
 * picks the tool arguments, so the agent picks how many distinct
 * approvals exist, and an unbounded queue is both a disk problem and a
 * queue no human will read to the bottom of.
 */
export class ApprovalQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(
      `buzz-axiru: ${limit} approvals are already pending; refusing to park another. ` +
        "Decide or expire the queue (buzz-axiru pending) before this agent can request more."
    );
    this.name = "ApprovalQueueFullError";
  }
}

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

/**
 * Length of an approval id, in hex characters. 32 hex is 128 bits of
 * the underlying SHA-256. The id is public and predictable by design
 * (it is the dedup key for an intent), but it must not be *collidable*:
 * at the original 12 hex characters an agent that can grind hashes
 * could make two different tool calls land on one approval record, so
 * a human deciding one of them silently decides for the other.
 */
const APPROVAL_ID_HEX = 32;

/** The pre-0.3 id length, still recognized when reading old stores. */
const LEGACY_APPROVAL_ID_HEX = 12;

function hexOfFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^sha256:/, "");
}

export function approvalIdForFingerprint(fingerprint: string): string {
  return hexOfFingerprint(fingerprint).slice(0, APPROVAL_ID_HEX);
}

/** The id this fingerprint would have had before the id was widened. */
export function legacyApprovalIdForFingerprint(fingerprint: string): string {
  return hexOfFingerprint(fingerprint).slice(0, LEGACY_APPROVAL_ID_HEX);
}

export function isExpired(approval: ApprovalRequest, now: Date): boolean {
  if (approval.expires_at === undefined) return false;
  const at = Date.parse(approval.expires_at);
  return Number.isFinite(at) && now.getTime() >= at;
}

export class ApprovalStore {
  readonly filePath: string;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, "approvals.json");
  }

  /** Run one read-modify-write under the data directory lock. */
  private locked<T>(fn: () => T): T {
    return withDataDirLock(this.dataDir, fn);
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
    // The temp name carries the pid so that a writer running without
    // the lock (a future caller, a bug) cannot truncate another
    // writer's staging file mid-write.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", "utf8");
    renameSync(tmp, this.filePath);
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.load()[approvalId];
  }

  byFingerprint(fingerprint: string): ApprovalRequest | undefined {
    const all = this.load();
    // Stores written before the id was widened key the same intent
    // under its short id; keep honouring those so an upgrade does not
    // orphan a pending approval a human is about to decide.
    return all[approvalIdForFingerprint(fingerprint)] ?? all[legacyApprovalIdForFingerprint(fingerprint)];
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
    now: Date = new Date(),
    maxPending: number | null = null
  ): ApprovalRequest {
    return this.locked(() => this.createOrGetLocked(request, now, maxPending));
  }

  private createOrGetLocked(
    request: Omit<ApprovalRequest, "approval_id" | "requested_at" | "status">,
    now: Date,
    maxPending: number | null
  ): ApprovalRequest {
    const all = this.load();
    const id = approvalIdForFingerprint(request.fingerprint);
    const existing = all[id] ?? all[legacyApprovalIdForFingerprint(request.fingerprint)];
    // A repeat of an intent that is already parked is not queue growth,
    // so the ceiling only applies to genuinely new records.
    if (existing) return existing;
    if (maxPending !== null) {
      const pendingNow = Object.values(all).filter(
        (a) => a.status === "pending" && !isExpired(a, now)
      ).length;
      if (pendingNow >= maxPending) throw new ApprovalQueueFullError(maxPending);
    }
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
    return this.locked(() => {
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
    });
  }

  /**
   * Transition an overdue pending approval to expired. Returns the
   * updated record when THIS call performed the transition (so exactly
   * one caller appends the ledger record), undefined otherwise.
   */
  markExpired(approvalId: string, now: Date = new Date()): ApprovalRequest | undefined {
    return this.locked(() => {
      const all = this.load();
      const approval = all[approvalId];
      if (!approval || approval.status !== "pending" || !isExpired(approval, now)) {
        return undefined;
      }
      approval.status = "expired";
      this.save(all);
      return approval;
    });
  }

  /** Record the downstream replay outcome for a granted parked call. */
  recordExecution(
    approvalId: string,
    outcome:
      | { status: "executed"; result: unknown; at: Date }
      | { status: "failed"; error: string; at: Date }
  ): ApprovalRequest {
    return this.locked(() => {
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
    });
  }

  /** Mark a granted approval as used so it cannot authorize a second transfer. */
  consume(approvalId: string): void {
    this.locked(() => {
      const all = this.load();
      const approval = all[approvalId];
      if (approval && approval.status === "granted") {
        approval.consumed = true;
        this.save(all);
      }
    });
  }
}
