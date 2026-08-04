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
 * This mirrors the shape of Buzz's own buzz-audit hash-chain log, so
 * an operator reads both the workspace audit trail and the spend
 * trail the same way. It is a local, single-writer file: good for one
 * bridge process, honest about being nothing more.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalJsonStringify } from "@axiru/agent-spend-guardrails";

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
  execution_status?: "executed" | "failed";
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

function parseLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/**
 * Append-only writer. The chain tail is re-read from the file before
 * every append: in gate mode the serve process and the approve/deny
 * CLI interleave appends from separate processes, and each must chain
 * onto whatever the other wrote last. (Truly simultaneous writers are
 * still out of scope: one bridge, one data directory.)
 */
export class Ledger {
  private lastSeq = 0;
  private lastHash = GENESIS_HASH;

  constructor(public readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.syncTail();
  }

  private syncTail(): void {
    const lines = parseLines(this.filePath);
    if (lines.length > 0) {
      const tail = JSON.parse(lines[lines.length - 1]!) as LedgerRecord;
      this.lastSeq = tail.seq;
      this.lastHash = tail.hash;
    } else {
      this.lastSeq = 0;
      this.lastHash = GENESIS_HASH;
    }
  }

  append(entry: LedgerEntryInput): LedgerRecord {
    this.syncTail();
    const { ts, ...rest } = entry;
    const unhashed: Omit<LedgerRecord, "hash"> = {
      ...rest,
      seq: this.lastSeq + 1,
      ts: ts ?? new Date().toISOString(),
      prev_hash: this.lastHash
    };
    const record: LedgerRecord = { ...unhashed, hash: hashRecord(unhashed) };
    appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
    this.lastSeq = record.seq;
    this.lastHash = record.hash;
    return record;
  }

  get head(): { seq: number; hash: string } {
    return { seq: this.lastSeq, hash: this.lastHash };
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

/** Re-derive the whole chain. Reports the first record that fails. */
export function verifyLedger(filePath: string): VerifyResult {
  const lines = parseLines(filePath);
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
 */
export function historyForAgent(
  filePath: string,
  agentPubkey: string,
  currency: string,
  now: Date
): AgentHistory {
  const lines = parseLines(filePath);
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  const monthAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  let amount24 = 0n;
  let amount30 = 0n;
  let count24 = 0;
  let count30 = 0;

  for (const line of lines) {
    let record: LedgerRecord;
    try {
      record = JSON.parse(line) as LedgerRecord;
    } catch {
      continue;
    }
    const advisoryAllow =
      record.type === "decision" && record.decision === "allow" && record.tool_name === undefined;
    const gatedExecution = record.type === "execution" && record.execution_status === "executed";
    if (!advisoryAllow && !gatedExecution) continue;
    if (record.agent_pubkey !== agentPubkey) continue;
    if (record.currency !== currency) continue;
    if (!INTEGER_AMOUNT.test(record.amount_minor_units)) continue;
    const t = Date.parse(record.ts);
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
