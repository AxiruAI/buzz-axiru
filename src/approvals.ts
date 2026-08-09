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

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import { sha256Fingerprint } from "@axiru/agent-spend-guardrails";

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

/** A gated downstream tool call, parked verbatim for execution on approval. */
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
  /** Gate mode: the original tool call to execute after a grant. */
  call?: ParkedCall;
  /** Exact arguments are removed after a final outcome to minimize secret retention. */
  call_arguments_redacted?: boolean;
  /**
   * Gate-mode execution status. `in_progress` is a durable,
   * pre-execution claim. Once written, a
   * restarted or second gate must never retry the call automatically:
   * the downstream may already have moved money even if the process
   * died before it could record the response.
   */
  execution_status?: "in_progress" | "executed" | "failed";
  execution_started_at?: string;
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

export function gatedCallFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  agentPubkey: string
): string {
  return sha256Fingerprint({
    v: 1,
    kind: "buzz-axiru.gated_call",
    tool: toolName,
    arguments: args as never,
    agent_pubkey: agentPubkey
  });
}

/** Bind a retained downstream result to the execution ledger record. */
export function executionResultFingerprint(result: unknown): string {
  return sha256Fingerprint({
    v: 1,
    kind: "buzz-axiru.downstream_result",
    result: result as never
  });
}

export function isExpired(approval: ApprovalRequest, now: Date): boolean {
  if (approval.expires_at === undefined) return false;
  const at = Date.parse(approval.expires_at);
  return Number.isFinite(at) && now.getTime() >= at;
}

type ApprovalMap = Record<string, ApprovalRequest>;

function emptyApprovalMap(): ApprovalMap {
  return Object.create(null) as ApprovalMap;
}

const APPROVAL_STATUSES = new Set<ApprovalStatus>(["pending", "granted", "denied", "expired"]);
const EXECUTION_STATUSES = new Set(["in_progress", "executed", "failed"]);
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

/**
 * The approval store controls whether a parked payment may execute, so
 * malformed state must stop the gate rather than be interpreted as an
 * empty queue. This is intentionally stricter than a best-effort cache.
 */
function approvalProblem(key: string, value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `record "${key}" is not an object`;
  }
  const approval = value as Partial<ApprovalRequest>;
  if (approval.approval_id !== key) return `record "${key}" has a mismatched approval_id`;
  if (typeof approval.fingerprint !== "string" || !FINGERPRINT.test(approval.fingerprint)) {
    return `record "${key}" has an invalid fingerprint`;
  }
  if (
    key !== approvalIdForFingerprint(approval.fingerprint) &&
    key !== legacyApprovalIdForFingerprint(approval.fingerprint)
  ) {
    return `record "${key}" is not derived from its fingerprint`;
  }
  if (!APPROVAL_STATUSES.has(approval.status as ApprovalStatus)) {
    return `record "${key}" has an invalid status`;
  }
  for (const field of [
    "agent_pubkey",
    "amount_minor_units",
    "currency",
    "counterparty",
    "memo",
    "reason_code",
    "requested_at"
  ] as const) {
    if (typeof approval[field] !== "string") return `record "${key}" is missing ${field}`;
  }
  if (
    approval.execution_status !== undefined &&
    !EXECUTION_STATUSES.has(approval.execution_status)
  ) {
    return `record "${key}" has an invalid execution_status`;
  }
  if (
    approval.call_arguments_redacted !== undefined &&
    typeof approval.call_arguments_redacted !== "boolean"
  ) {
    return `record "${key}" has an invalid call_arguments_redacted flag`;
  }
  if (approval.execution_status !== undefined && approval.status !== "granted") {
    return `record "${key}" has execution state without a grant`;
  }
  if (
    approval.execution_error !== undefined &&
    (typeof approval.execution_error !== "string" || approval.execution_error.length > 1_000)
  ) {
    return `record "${key}" has an invalid execution_error`;
  }
  if (approval.execution_result !== undefined) {
    const resultShape = boundedJsonProblem(approval.execution_result);
    if (resultShape !== null) {
      return `record "${key}" has an unsafe execution_result: ${resultShape}`;
    }
  }
  if (approval.call !== undefined) {
    if (
      typeof approval.call !== "object" ||
      approval.call === null ||
      typeof approval.call.tool_name !== "string" ||
      typeof approval.call.arguments !== "object" ||
      approval.call.arguments === null ||
      Array.isArray(approval.call.arguments)
    ) {
      return `record "${key}" has an invalid parked call`;
    }
    const shape = boundedJsonProblem(approval.call.arguments);
    if (shape !== null) return `record "${key}" has unsafe parked arguments: ${shape}`;
    if (approval.call_arguments_redacted === true) {
      const isFinal =
        approval.status === "denied" ||
        approval.status === "expired" ||
        approval.execution_status === "executed" ||
        approval.execution_status === "failed";
      if (!isFinal || Object.keys(approval.call.arguments).length !== 0) {
        return `record "${key}" has inconsistent redacted parked arguments`;
      }
    } else {
      let actual: string;
      try {
        actual = gatedCallFingerprint(
          approval.call.tool_name,
          approval.call.arguments,
          approval.agent_pubkey!
        );
      } catch {
        return `record "${key}" has parked arguments that cannot be fingerprinted`;
      }
      if (actual !== approval.fingerprint) {
        return `record "${key}" parked call does not match its approved fingerprint`;
      }
    }
  }
  return null;
}

function boundedJsonProblem(value: unknown): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  let chars = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 20_000) return "more than 20000 values";
    if (current.depth > 64) return "more than 64 levels";
    const kind = typeof current.value;
    if (
      kind === "undefined" ||
      kind === "function" ||
      kind === "symbol" ||
      kind === "bigint" ||
      (kind === "number" && !Number.isFinite(current.value))
    ) {
      return "a non-JSON value";
    }
    if (typeof current.value === "string") chars += current.value.length;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const [childKey, child] of Object.entries(current.value as Record<string, unknown>)) {
        chars += childKey.length;
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
    if (chars > 262_144) return "more than 262144 string characters";
  }
  return null;
}

function own(all: ApprovalMap, id: string): ApprovalRequest | undefined {
  return Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
}

function redactFinalCall(approval: ApprovalRequest): void {
  if (approval.call === undefined) return;
  approval.call = { tool_name: approval.call.tool_name, arguments: {} };
  approval.call_arguments_redacted = true;
}

/** Resolve an exact fingerprint, including a pre-0.3 short-key record. */
function recordForFingerprint(all: ApprovalMap, fingerprint: string): ApprovalRequest | undefined {
  const current = own(all, approvalIdForFingerprint(fingerprint));
  if (current?.fingerprint === fingerprint) return current;
  const legacy = own(all, legacyApprovalIdForFingerprint(fingerprint));
  return legacy?.fingerprint === fingerprint ? legacy : undefined;
}

export interface ExecutionClaim {
  claimed: boolean;
  approval: ApprovalRequest;
}

export class ApprovalStore {
  readonly filePath: string;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, "approvals.json");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Tighten an existing store too; otherwise a file restored with a
    // permissive umask remains world-readable until its next mutation.
    if (existsSync(this.filePath)) chmodSync(this.filePath, 0o600);
  }

  /** Run one read-modify-write under the data directory lock. */
  private locked<T>(fn: () => T): T {
    return withDataDirLock(this.dataDir, fn);
  }

  private load(): ApprovalMap {
    if (!existsSync(this.filePath)) return emptyApprovalMap();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `buzz-axiru: cannot read approval store ${this.filePath}: ${(err as Error).message}. ` +
          "Refusing to forget approval state because that could re-authorize a payment."
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`buzz-axiru: approval store ${this.filePath} must contain a JSON object`);
    }
    const all = emptyApprovalMap();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const problem = approvalProblem(key, value);
      if (problem !== null) {
        throw new Error(
          `buzz-axiru: approval store ${this.filePath} is invalid: ${problem}. ` +
            "Refusing to continue with ambiguous payment state."
        );
      }
      all[key] = value as ApprovalRequest;
    }
    return all;
  }

  private save(all: ApprovalMap): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The temp name carries the pid so that a writer running without
    // the lock (a future caller, a bug) cannot truncate another
    // writer's staging file mid-write.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(tmp, 0o600);
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    fsyncDirectory(directory);
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return own(this.load(), approvalId);
  }

  byFingerprint(fingerprint: string): ApprovalRequest | undefined {
    const all = this.load();
    // Stores written before the id was widened key the same intent
    // under its short id; keep honouring those so an upgrade does not
    // orphan a pending approval a human is about to decide.
    return recordForFingerprint(all, fingerprint);
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
    const existing = recordForFingerprint(all, request.fingerprint);
    // A repeat of an intent that is already parked is not queue growth,
    // so the ceiling only applies to genuinely new records.
    if (existing) return existing;
    const colliding = own(all, id);
    if (colliding !== undefined) {
      throw new Error(
        `buzz-axiru: approval id collision for ${id}; refusing to merge two different payment intents`
      );
    }
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
    const problem = approvalProblem(id, created);
    if (problem !== null) {
      throw new Error(`buzz-axiru: refusing to create an invalid approval: ${problem}`);
    }
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
      const approval = own(all, approvalId);
      if (!approval) {
        throw new Error(`buzz-axiru: no approval with id ${approvalId}`);
      }
      if (approval.status === "pending" && isExpired(approval, now)) {
        approval.status = "expired";
        redactFinalCall(approval);
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
      if (status === "denied") redactFinalCall(approval);
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
      const approval = own(all, approvalId);
      if (!approval || approval.status !== "pending" || !isExpired(approval, now)) {
        return undefined;
      }
      approval.status = "expired";
      redactFinalCall(approval);
      this.save(all);
      return approval;
    });
  }

  /** Record the downstream execution outcome for a granted parked call. */
  recordExecution(
    approvalId: string,
    outcome:
      | { status: "executed"; result: unknown; at: Date }
      | { status: "failed"; error: string; at: Date }
  ): ApprovalRequest {
    return this.locked(() => {
      const all = this.load();
      const approval = own(all, approvalId);
      if (!approval) {
        throw new Error(`buzz-axiru: no approval with id ${approvalId}`);
      }
      if (approval.status !== "granted" || approval.execution_status !== "in_progress") {
        throw new Error(
          `buzz-axiru: approval ${approvalId} has no active execution claim; refusing to overwrite its outcome`
        );
      }
      approval.execution_status = outcome.status;
      approval.executed_at = outcome.at.toISOString();
      if (outcome.status === "executed") {
        approval.execution_result = outcome.result;
        delete approval.execution_error;
      } else {
        approval.execution_error = outcome.error;
        delete approval.execution_result;
      }
      approval.consumed = true;
      redactFinalCall(approval);
      this.save(all);
      return approval;
    });
  }

  /**
   * Attach evidence to an execution claim whose transport outcome is
   * ambiguous, while deliberately keeping it in_progress and therefore
   * non-retryable until an operator reconciles it.
   */
  recordExecutionUncertain(approvalId: string, error: string): ApprovalRequest {
    return this.locked(() => {
      const all = this.load();
      const approval = own(all, approvalId);
      if (!approval) throw new Error(`buzz-axiru: no approval with id ${approvalId}`);
      if (approval.status !== "granted" || approval.execution_status !== "in_progress") {
        throw new Error(
          `buzz-axiru: approval ${approvalId} has no active execution claim; ` +
            "refusing to attach an ambiguous outcome"
        );
      }
      approval.execution_error = error;
      approval.consumed = true;
      this.save(all);
      return approval;
    });
  }

  /**
   * Atomically consume an advisory-mode grant. Exactly one concurrent
   * caller receives the record; every later caller receives undefined.
   */
  consumeGranted(approvalId: string): ApprovalRequest | undefined {
    return this.locked(() => {
      const all = this.load();
      const approval = own(all, approvalId);
      if (!approval || approval.status !== "granted" || approval.consumed === true) return undefined;
      approval.consumed = true;
      this.save(all);
      return approval;
    });
  }

  /**
   * Claim a parked call before touching the downstream server. This is
   * the durable at-most-once boundary: if the process crashes after the
   * claim, a restart leaves the call in_progress for manual
   * reconciliation instead of risking a duplicate payment.
   */
  claimExecution(approvalId: string, now: Date = new Date()): ExecutionClaim {
    return this.locked(() => {
      const all = this.load();
      const approval = own(all, approvalId);
      if (!approval) throw new Error(`buzz-axiru: no approval with id ${approvalId}`);
      if (
        approval.status !== "granted" ||
        approval.call === undefined ||
        approval.execution_status !== undefined
      ) {
        return { claimed: false, approval };
      }
      approval.execution_status = "in_progress";
      approval.execution_started_at = now.toISOString();
      approval.consumed = true;
      this.save(all);
      return { claimed: true, approval };
    });
  }
}

/** Persist a rename's directory entry where the platform supports it. */
function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (err) {
    // Windows and some network filesystems do not permit fsync on a
    // directory. The file itself is already flushed; do not turn a
    // portability limitation into an approval-store outage.
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP") throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
