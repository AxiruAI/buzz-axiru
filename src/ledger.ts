/**
 * Append-only JSONL decision ledger with a SHA-256 hash chain.
 *
 * Every decision the bridge makes (allow, deny, require_approval) and
 * every human approval outcome is appended as one JSON line. Each
 * record carries:
 *
 *   - the agent's Nostr pubkey as the actor of the spend intent,
 *   - prev_hash: the hash of the previous record (64 zeros at genesis),
 *   - hash: SHA-256 over the canonical-JSON form of the record with
 *     the hash field removed.
 *
 * Tampering with any record (edit, delete, reorder, truncate-then-
 * append) breaks every subsequent hash. `verifyLedger` re-derives the
 * chain and reports the first bad sequence number.
 *
 * Verification is incremental during a run. Re-deriving the whole
 * chain on every append made each append (and each decision, via the
 * history scan) cost O(ledger size), O(n^2) over the ledger's life,
 * so a long-lived gate slowed every spend decision to seconds; that
 * is an availability failure, and it was reported by an external
 * review. A Ledger instance therefore keeps a verified checkpoint
 * (last seq, head hash, byte offset) and verifies only bytes appended
 * after it, chaining onto the known-good head. The full from-genesis
 * pass still runs at instance open, in `buzz-axiru verify` and
 * `doctor`, and as the fallback whenever the incremental pass sees
 * anything unexpected (unparseable line, seq/prev_hash/hash mismatch,
 * file shrinkage). The honest cost: an in-place, same-size edit of a
 * record this process already verified is caught at the next full
 * pass (restart, verify, doctor), not at the next decision. That is
 * consistent with the tamper-evident, not tamper-proof, model the
 * README documents.
 *
 * This mirrors the shape of Buzz's own buzz-audit hash-chain log, so
 * an operator reads both the workspace audit trail and the spend
 * trail the same way.
 *
 * Appends are serialized across processes by the data directory lock
 * (src/lock.ts). Without it, the serve process and the approve/deny
 * CLI race between reading the chain tail and writing the next record,
 * which produces duplicate seq numbers and half-written lines that
 * make the chain permanently unverifiable.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { canonicalJsonStringify } from "@axiru/agent-spend-guardrails";

import { withDataDirLock } from "./lock.js";

export const GENESIS_HASH = "0".repeat(64);

export type LedgerRecordType =
  | "decision"
  | "approval_granted"
  | "approval_denied"
  | "approval_expired"
  | "execution";

export interface LedgerEntryInput {
  type: LedgerRecordType;
  /** Who performed this action: the agent pubkey for decisions, the approver id for outcomes. */
  actor: string;
  /** The Nostr pubkey of the agent whose spend intent this concerns. */
  agent_pubkey: string;
  decision?: "allow" | "require_approval" | "deny";
  reason_code: string;
  amount_minor_units: string;
  currency: string;
  counterparty: string;
  memo: string;
  /**
   * sha256:<hex> fingerprint. For advisory decisions this is the
   * policy evaluator's intent fingerprint; for gated tool calls it is
   * the call fingerprint (tool name + arguments + agent pubkey).
   */
  fingerprint: string;
  /** Gate mode: the policy evaluator's intent fingerprint, when distinct. */
  policy_fingerprint?: string;
  /** Gate mode: the downstream tool this record concerns. */
  tool_name?: string;
  /** For "execution" records: did the downstream call succeed. */
  execution_status?: "in_progress" | "executed" | "failed";
  /** For failed executions: the downstream error, verbatim. */
  error?: string;
  approval_id?: string;
  note?: string;
  /** Timestamp override for deterministic tests. Defaults to now. */
  ts?: string;
}

export interface LedgerRecord extends Omit<LedgerEntryInput, "ts" | "actor"> {
  seq: number;
  ts: string;
  actor: string;
  prev_hash: string;
  hash: string;
}

type CanonicalObject = Parameters<typeof canonicalJsonStringify>[0];

export function hashRecord(record: Omit<LedgerRecord, "hash">): string {
  const canonical = canonicalJsonStringify(record as unknown as CanonicalObject);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function splitLines(raw: string): string[] {
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

function parseLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return splitLines(readFileSync(filePath, "utf8"));
}

/** Current file size in bytes; a missing file is size 0. */
function fileSizeSync(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Read `length` bytes starting at `offset` without touching the rest
 * of the file. This is what keeps appends flat: the verified prefix
 * is never re-read. The offset always sits just past the newline of a
 * record this process verified, so it cannot split a UTF-8 sequence;
 * if the file was rewritten underneath us the parse fails and the
 * caller falls back to a full verification.
 */
function readBytesFrom(filePath: string, offset: number, length: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const got = readSync(fd, buf, done, length - done, offset + done);
      if (got === 0) break;
      done += got;
    }
    return buf.subarray(0, done).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Append-only writer. The chain tail is re-synced from the file before
 * every append: in gate mode the serve process and the approve/deny
 * CLI interleave appends from separate processes, and each must chain
 * onto whatever the other wrote last. Re-sync and append happen inside
 * the data directory lock, so no other process can append between
 * them.
 *
 * The re-sync is incremental against a verified checkpoint (lastSeq,
 * lastHash, verifiedBytes). Another process appending since our last
 * look is the NORMAL case, detected by file growth and handled by
 * verifying just the delta. Anything the delta pass cannot explain
 * (shrinkage, a record that does not chain onto our head, a line that
 * does not parse) means the file is not the one we verified, so we
 * fall back to a full from-genesis verification and fail loudly if
 * that fails too.
 */
export class Ledger {
  private lastSeq = 0;
  private lastHash = GENESIS_HASH;
  /** Byte offset just past the newline of the last verified record. */
  private verifiedBytes = 0;

  constructor(public readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
    // The checkpoint starts at genesis, so this first sync verifies
    // every existing record: opening a ledger is always a full check.
    this.syncTail();
  }

  /**
   * Bring the checkpoint up to date with the file. Fast path: nothing
   * changed, one stat. Normal multi-writer path: verify only the bytes
   * another process appended. Anomaly path: full re-verification.
   */
  private syncTail(): void {
    const size = fileSizeSync(this.filePath);
    if (size === this.verifiedBytes) return;
    if (size > this.verifiedBytes) {
      const delta = readBytesFrom(this.filePath, this.verifiedBytes, size - this.verifiedBytes);
      if (this.advanceCheckpoint(delta)) return;
    }
    const raw = existsSync(this.filePath) ? readFileSync(this.filePath, "utf8") : "";
    this.adoptFullVerify(
      splitLines(raw),
      Buffer.byteLength(raw, "utf8"),
      "Refusing to append to an untrusted audit trail."
    );
  }

  /**
   * Verify records that chain onto the checkpointed head and advance
   * the checkpoint past them. Returns false, leaving the checkpoint
   * untouched, if anything in the delta fails: the caller decides
   * whether that is fatal by running the full verification.
   */
  private advanceCheckpoint(delta: string): boolean {
    let prevHash = this.lastHash;
    let prevSeq = this.lastSeq;
    for (const line of splitLines(delta)) {
      let record: LedgerRecord;
      try {
        record = JSON.parse(line) as LedgerRecord;
      } catch {
        return false;
      }
      if (record.seq !== prevSeq + 1) return false;
      if (record.prev_hash !== prevHash) return false;
      const { hash, ...unhashed } = record;
      if (hashRecord(unhashed) !== hash) return false;
      prevHash = hash;
      prevSeq = record.seq;
    }
    this.lastSeq = prevSeq;
    this.lastHash = prevHash;
    this.verifiedBytes += Buffer.byteLength(delta, "utf8");
    return true;
  }

  /** Full from-genesis verification; adopt the result or throw. */
  private adoptFullVerify(lines: string[], sizeBytes: number, refusal: string): void {
    const verified = verifyLines(lines);
    if (!verified.ok) {
      throw new Error(
        `buzz-axiru: ledger integrity check failed at sequence ${verified.bad_seq}: ` +
          `${verified.reason}. ${refusal}`
      );
    }
    // verifyLines enforces seq starting at 1 with no gaps, so the
    // record count IS the tail seq.
    this.lastSeq = verified.records;
    this.lastHash = verified.head_hash;
    this.verifiedBytes = sizeBytes;
  }

  /**
   * Rolling-window spend history, verified incrementally against this
   * instance's checkpoint. One snapshot read serves both verification
   * of the delta and the aggregation scan, so the numbers always come
   * from bytes that passed a hash check (modulo the same-size in-place
   * caveat documented in the file header).
   */
  historyForAgent(agentPubkey: string, currency: string, now: Date): AgentHistory {
    const buf = existsSync(this.filePath) ? readFileSync(this.filePath) : Buffer.alloc(0);
    const lines = splitLines(buf.toString("utf8"));
    if (buf.length !== this.verifiedBytes) {
      const grewCleanly =
        buf.length > this.verifiedBytes &&
        this.advanceCheckpoint(buf.subarray(this.verifiedBytes).toString("utf8"));
      if (!grewCleanly) {
        this.adoptFullVerify(
          lines,
          buf.length,
          "Refusing to calculate spend history from a corrupted ledger."
        );
      }
    }
    return aggregateHistory(lines, agentPubkey, currency, now);
  }

  append(entry: LedgerEntryInput): LedgerRecord {
    // Read-tail and append are one critical section: a second writer
    // slipping between them would chain onto the same prev_hash and
    // reuse the same seq, which no later reader can untangle.
    return withDataDirLock(dirname(this.filePath), () => {
      this.syncTail();
      const { ts, ...rest } = entry;
      const unhashed: Omit<LedgerRecord, "hash"> = {
        ...rest,
        seq: this.lastSeq + 1,
        ts: ts ?? new Date().toISOString(),
        prev_hash: this.lastHash
      };
      const record: LedgerRecord = { ...unhashed, hash: hashRecord(unhashed) };
      const line = JSON.stringify(record) + "\n";
      const existed = existsSync(this.filePath);
      const fd = openSync(this.filePath, "a", 0o600);
      try {
        writeFileSync(fd, line, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!existed) fsyncDirectory(dirname(this.filePath));
      // We hold the lock, so the file ended at verifiedBytes when we
      // wrote: the checkpoint advances past our own record without a
      // re-read.
      this.lastSeq = record.seq;
      this.lastHash = record.hash;
      this.verifiedBytes += Buffer.byteLength(line, "utf8");
      return record;
    });
  }

  get head(): { seq: number; hash: string } {
    return { seq: this.lastSeq, hash: this.lastHash };
  }
}

/** Persist first-file creation where directory fsync is supported. */
function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP") throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface VerifyOk {
  ok: true;
  records: number;
  head_hash: string;
}

export interface VerifyFail {
  ok: false;
  records: number;
  bad_seq: number;
  reason: string;
}

export type VerifyResult = VerifyOk | VerifyFail;

function verifyLines(lines: string[]): VerifyResult {
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;

  for (let i = 0; i < lines.length; i++) {
    let record: LedgerRecord;
    try {
      record = JSON.parse(lines[i]!) as LedgerRecord;
    } catch {
      return { ok: false, records: lines.length, bad_seq: prevSeq + 1, reason: "unparseable JSON line" };
    }
    if (record.seq !== prevSeq + 1) {
      return {
        ok: false,
        records: lines.length,
        bad_seq: record.seq,
        reason: `sequence gap: expected ${prevSeq + 1}, found ${record.seq}`
      };
    }
    if (record.prev_hash !== prevHash) {
      return {
        ok: false,
        records: lines.length,
        bad_seq: record.seq,
        reason: "prev_hash does not match the previous record's hash (edit, reorder, or deletion upstream)"
      };
    }
    const { hash, ...unhashed } = record;
    if (hashRecord(unhashed) !== hash) {
      return {
        ok: false,
        records: lines.length,
        bad_seq: record.seq,
        reason: "record hash does not match its contents (record was modified)"
      };
    }
    prevHash = hash;
    prevSeq = record.seq;
  }
  return { ok: true, records: lines.length, head_hash: prevHash };
}

/** Re-derive the whole chain. Reports the first record that fails. */
export function verifyLedger(filePath: string): VerifyResult {
  return verifyLines(parseLines(filePath));
}

export interface AgentHistory {
  amount_24h: string;
  amount_30d: string;
  count_24h: number;
  count_30d: number;
}

const INTEGER_AMOUNT = /^[0-9]+$/;

/**
 * Rolling-window aggregates for one agent, computed from the ledger.
 * Only records for money that was authorized or moved count:
 *
 *   - advisory allow decisions (type "decision", decision "allow",
 *     no tool_name): the bridge cannot see execution, so authorization
 *     is the conservative proxy;
 *   - gated executions that succeeded (type "execution", status
 *     "executed"): in gate mode the bridge sees the actual downstream
 *     call, so it counts real movement and never double-counts the
 *     preceding allow decision (which carries a tool_name).
 *
 * Denied, still-pending, and expired intents never moved money.
 * Aggregates are scoped to the requesting agent's pubkey and to the
 * configured currency, matching the per-agent scope of the daily cap.
 *
 * This standalone form re-verifies the whole chain on every call.
 * Long-lived processes should use Ledger#historyForAgent, which
 * carries a verified checkpoint and only verifies new records.
 */
export function historyForAgent(
  filePath: string,
  agentPubkey: string,
  currency: string,
  now: Date
): AgentHistory {
  const lines = parseLines(filePath);
  const verified = verifyLines(lines);
  if (!verified.ok) {
    throw new Error(
      `buzz-axiru: ledger integrity check failed at sequence ${verified.bad_seq}: ` +
        `${verified.reason}. Refusing to calculate spend history from a corrupted ledger.`
    );
  }
  return aggregateHistory(lines, agentPubkey, currency, now);
}

/** The aggregation scan itself; callers verify `lines` first. */
function aggregateHistory(
  lines: string[],
  agentPubkey: string,
  currency: string,
  now: Date
): AgentHistory {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const monthAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  let amount24 = 0n;
  let amount30 = 0n;
  let count24 = 0;
  let count30 = 0;

  const countable: Array<{ record: LedgerRecord; effectiveTs?: string }> = [];
  const approvedExecutions = new Map<
    string,
    { final: LedgerRecord; startedTs?: string }
  >();

  for (const line of lines) {
    const record = JSON.parse(line) as LedgerRecord;
    const advisoryAllow =
      record.type === "decision" && record.decision === "allow" && record.tool_name === undefined;
    const gatedExecution = record.type === "execution" && record.execution_status === "executed";
    if (record.type === "execution" && record.approval_id !== undefined) {
      const prior = approvedExecutions.get(record.approval_id);
      approvedExecutions.set(record.approval_id, {
        final: record,
        startedTs:
          prior?.startedTs ??
          (record.execution_status === "in_progress" ? record.ts : undefined)
      });
      continue;
    }
    if (!advisoryAllow && !gatedExecution) continue;
    countable.push({ record });
  }
  // One human approval is one possible transfer. A crash can leave an
  // executed ledger record and an in_progress approval-store record,
  // after which manual reconciliation appends a second final record.
  // Count the final state once, using the original claim time when it
  // exists, so audit recovery cannot double the rolling spend amount.
  for (const { final, startedTs } of approvedExecutions.values()) {
    if (final.execution_status === "executed") {
      countable.push({ record: final, effectiveTs: startedTs });
    }
  }

  for (const { record, effectiveTs } of countable) {
    if (record.agent_pubkey !== agentPubkey) continue;
    if (record.currency !== currency) continue;
    if (!INTEGER_AMOUNT.test(record.amount_minor_units)) continue;
    const t = Date.parse(effectiveTs ?? record.ts);
    if (Number.isNaN(t) || t > now.getTime()) continue;
    const amount = BigInt(record.amount_minor_units);
    if (t >= monthAgo) {
      amount30 += amount;
      count30 += 1;
    }
    if (t >= dayAgo) {
      amount24 += amount;
      count24 += 1;
    }
  }

  return {
    amount_24h: amount24.toString(),
    amount_30d: amount30.toString(),
    count_24h: count24,
    count_30d: count30
  };
}
