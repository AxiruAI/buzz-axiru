/**
 * Hash-chain ledger: append, verify, and tamper detection.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GENESIS_HASH, Ledger, verifyLedger, type LedgerRecord } from "../src/ledger.js";
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
