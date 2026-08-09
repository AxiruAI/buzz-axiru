/**
 * Hash-chain ledger: append, verify, and tamper detection.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GENESIS_HASH,
  historyForAgent,
  Ledger,
  verifyLedger,
  type LedgerRecord
} from "../src/ledger.js";
import { AGENT_PUBKEY } from "./helpers.js";

function entry(amount: string, memo: string) {
  return {
    type: "decision" as const,
    actor: AGENT_PUBKEY,
    agent_pubkey: AGENT_PUBKEY,
    decision: "allow" as const,
    reason_code: "guardrails.allow.default",
    amount_minor_units: amount,
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo,
    fingerprint: "sha256:" + "cd".repeat(32)
  };
}

function newLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "buzz-axiru-ledger-")), "ledger.jsonl");
}

test("append builds a chain from the genesis hash and verify passes", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  const first = ledger.append(entry("100", "one"));
  const second = ledger.append(entry("200", "two"));
  const third = ledger.append(entry("300", "three"));

  assert.equal(first.prev_hash, GENESIS_HASH);
  assert.equal(second.prev_hash, first.hash);
  assert.equal(third.prev_hash, second.hash);

  const result = verifyLedger(path);
  assert.equal(result.ok, true);
  assert.equal(result.records, 3);
  if (result.ok) assert.equal(result.head_hash, third.hash);
});

test("a reopened ledger continues the same chain", () => {
  const path = newLedgerPath();
  const a = new Ledger(path);
  a.append(entry("100", "one"));
  a.append(entry("200", "two"));

  const b = new Ledger(path);
  const third = b.append(entry("300", "three"));
  assert.equal(third.seq, 3);

  const result = verifyLedger(path);
  assert.equal(result.ok, true);
  assert.equal(result.records, 3);
});

test("editing a record's content is detected at that sequence number", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  ledger.append(entry("100", "one"));
  ledger.append(entry("200", "two"));
  ledger.append(entry("300", "three"));

  const lines = readFileSync(path, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[1]!) as LedgerRecord;
  tampered.amount_minor_units = "999999999";
  lines[1] = JSON.stringify(tampered);
  writeFileSync(path, lines.join("\n") + "\n");

  const result = verifyLedger(path);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.bad_seq, 2);
    assert.match(result.reason, /modified/);
  }
});

test("reordering records is detected", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  ledger.append(entry("100", "one"));
  ledger.append(entry("200", "two"));
  ledger.append(entry("300", "three"));

  const lines = readFileSync(path, "utf8").trim().split("\n");
  [lines[1], lines[2]] = [lines[2]!, lines[1]!];
  writeFileSync(path, lines.join("\n") + "\n");

  const result = verifyLedger(path);
  assert.equal(result.ok, false);
});

test("deleting a record breaks the chain", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  ledger.append(entry("100", "one"));
  ledger.append(entry("200", "two"));
  ledger.append(entry("300", "three"));

  const lines = readFileSync(path, "utf8").trim().split("\n");
  lines.splice(1, 1);
  writeFileSync(path, lines.join("\n") + "\n");

  const result = verifyLedger(path);
  assert.equal(result.ok, false);
});

test("an empty ledger verifies clean", () => {
  const path = newLedgerPath();
  new Ledger(path);
  const result = verifyLedger(path);
  assert.equal(result.ok, true);
  assert.equal(result.records, 0);
});

test("incremental and full verification agree on the chain head", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  let last: LedgerRecord | undefined;
  for (let i = 1; i <= 5; i++) {
    last = ledger.append(entry(String(i * 100), `memo-${i}`));
  }

  const result = verifyLedger(path);
  assert.equal(result.ok, true);
  assert.equal(result.records, 5);
  if (result.ok) assert.equal(result.head_hash, last!.hash);
  assert.equal(ledger.head.seq, 5);
  assert.equal(ledger.head.hash, last!.hash);
});

test("a second writer's records are re-synced as a verified delta before the next append", () => {
  const path = newLedgerPath();
  const a = new Ledger(path);
  a.append(entry("100", "one"));
  a.append(entry("200", "two"));

  // Another process (here: another instance) appends behind a's back.
  // That is the normal multi-writer case, not an anomaly: a must
  // verify just the delta and chain onto b's record.
  const b = new Ledger(path);
  const third = b.append(entry("300", "three"));

  const fourth = a.append(entry("400", "four"));
  assert.equal(fourth.seq, 4);
  assert.equal(fourth.prev_hash, third.hash);

  const result = verifyLedger(path);
  assert.equal(result.ok, true);
  assert.equal(result.records, 4);
});

test("instance history sees another writer's delta and matches the standalone scan", () => {
  const path = newLedgerPath();
  const a = new Ledger(path);
  a.append(entry("100", "one"));
  const b = new Ledger(path);
  b.append(entry("250", "two"));

  const now = new Date();
  const viaInstance = a.historyForAgent(AGENT_PUBKEY, "USD", now);
  assert.deepEqual(viaInstance, historyForAgent(path, AGENT_PUBKEY, "USD", now));
  assert.equal(viaInstance.amount_24h, "350");
  assert.equal(viaInstance.count_24h, 2);
});

test("a same-size in-place forgery is caught by full verification", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  ledger.append(entry("100", "one"));
  ledger.append(entry("200", "two"));
  ledger.append(entry("300", "three"));

  // Forge record 2 without changing the file size, so the running
  // instance's checkpoint cannot see it. Incremental verification
  // trusts the already-verified prefix by design; catching this is the
  // full pass's job (restart, `verify`, `doctor`).
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.match(lines[1]!, /"amount_minor_units":"200"/);
  lines[1] = lines[1]!.replace('"amount_minor_units":"200"', '"amount_minor_units":"999"');
  writeFileSync(path, lines.join("\n") + "\n");

  // The live instance still appends onto its verified head.
  const fourth = ledger.append(entry("400", "four"));
  assert.equal(fourth.seq, 4);

  // Every full pass names the forged record.
  const result = verifyLedger(path);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.bad_seq, 2);
  assert.throws(() => new Ledger(path), /integrity check failed at sequence 2/);
});

test("an unverifiable delta falls back to full verification and fails loud", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  ledger.append(entry("100", "one"));

  // Out-of-band garbage lands after the verified checkpoint: the delta
  // pass cannot parse it, so the fallback full pass runs and refuses.
  appendFileSync(path, "not-a-ledger-record\n");

  assert.throws(() => ledger.append(entry("200", "two")), /integrity check failed/);
  assert.throws(
    () => ledger.historyForAgent(AGENT_PUBKEY, "USD", new Date()),
    /corrupted ledger/
  );
});

test("file shrinkage triggers the full-verification fallback", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  ledger.append(entry("100", "one"));
  ledger.append(entry("200", "two"));
  const third = ledger.append(entry("300", "three"));

  // Truncate the tail out-of-band. The checkpoint sits past the new
  // end of file, so the instance re-derives the chain from genesis,
  // which is exactly what a fresh open would accept: tail truncation
  // alone verifies clean (README: anchor the head hash externally to
  // catch it), and the next append chains onto the shorter tail.
  const lines = readFileSync(path, "utf8").trim().split("\n");
  writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");

  const next = ledger.append(entry("400", "four"));
  assert.equal(next.seq, 3);
  assert.notEqual(next.prev_hash, third.hash);
  const result = verifyLedger(path);
  assert.equal(result.ok, true);
  assert.equal(result.records, 3);
});

test("manual reconciliation cannot double-count one approved execution", () => {
  const path = newLedgerPath();
  const ledger = new Ledger(path);
  const base = {
    type: "execution" as const,
    actor: "bridge",
    agent_pubkey: AGENT_PUBKEY,
    reason_code: "bridge.execution.started",
    amount_minor_units: "5000",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "approved payment",
    fingerprint: "sha256:" + "ef".repeat(32),
    tool_name: "create_payment",
    approval_id: "a".repeat(32)
  };
  const now = new Date("2026-07-21T12:00:00Z");
  ledger.append({ ...base, execution_status: "in_progress", ts: "2026-07-21T11:58:00Z" });
  ledger.append({
    ...base,
    execution_status: "executed",
    reason_code: "bridge.execution.ok",
    ts: "2026-07-21T11:59:00Z"
  });
  ledger.append({
    ...base,
    actor: "ops-reviewer",
    execution_status: "executed",
    reason_code: "bridge.execution.reconciled_executed",
    ts: now.toISOString()
  });

  assert.deepEqual(historyForAgent(path, AGENT_PUBKEY, "USD", now), {
    amount_24h: "5000",
    amount_30d: "5000",
    count_24h: 1,
    count_30d: 1
  });
});
