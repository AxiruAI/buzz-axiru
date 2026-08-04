/**
 * Policy evaluation paths through the bridge: allow, require_approval,
 * deny, the zero-history escalation, and the human approval flow.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_PUBKEY, NOON_UTC, makeBridge, seedAllow } from "./helpers.js";

const HOUR = 60 * 60 * 1000;

function request(amountMinorUnits: string, counterparty = "acme-datacenter.example") {
  return {
    amount_minor_units: amountMinorUnits,
    currency: "USD",
    counterparty,
    memo: "test payment",
    agent_pubkey: AGENT_PUBKEY
  };
}

test("small in-policy payment is allowed", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("12000"), NOON_UTC);
  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason_code, "guardrails.allow.default");
  assert.equal(decision.agent_pubkey, AGENT_PUBKEY);
  assert.match(decision.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(decision.ledger.seq, 2);
});

test("single payment at or above the ceiling requires human approval", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("4000000"), NOON_UTC);
  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.reason_code, "guardrails.pending.above_approval_threshold");
  assert.ok(decision.approval_id, "approval_id should be set");
  const pending = bridge.approvals.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.agent_pubkey, AGENT_PUBKEY);
});

test("counterparty outside the allowlist is denied", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("12000", "evil-corp.example"), NOON_UTC);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "guardrails.deny.counterparty_not_allowlisted");
});

test("daily cap denies once trailing-24h authorized spend reaches the cap", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "9990000", new Date(NOON_UTC.getTime() - 2 * HOUR));
  seedAllow(bridge, "10000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("12000"), NOON_UTC);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "guardrails.deny.daily_cap_exceeded");
});

test("daily cap is per agent: another agent's spend does not count", async () => {
  const { bridge } = makeBridge();
  const otherAgent = "c".repeat(64);
  seedAllow(bridge, "10000000", new Date(NOON_UTC.getTime() - HOUR), otherAgent);
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("12000"), NOON_UTC);
  assert.equal(decision.decision, "allow");
});

test("first-ever spend with zero history escalates to a human (fail-safe)", async () => {
  const { bridge } = makeBridge();
  const decision = await bridge.evaluate(request("12000"), NOON_UTC);
  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.reason_code, "guardrails.pending.velocity_inputs_unavailable");
});

test("outside business hours, spend routes to a human", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date("2026-07-21T01:00:00Z"));
  const decision = await bridge.evaluate(request("12000"), new Date("2026-07-21T02:00:00Z"));
  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.reason_code, "guardrails.pending.outside_business_hours");
});

test("human approval flow: grant, consume once, then back through policy", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));

  const first = await bridge.evaluate(request("4000000"), NOON_UTC);
  assert.equal(first.decision, "require_approval");
  const approvalId = first.approval_id!;

  bridge.approvals.decide(approvalId, "granted", "tester", "vendor invoice checked");

  const second = await bridge.evaluate(request("4000000"), NOON_UTC);
  assert.equal(second.decision, "allow");
  assert.equal(second.reason_code, "bridge.allow.human_approved");
  assert.equal(second.approval_id, approvalId);

  // The grant is single-use: the same intent now goes back through policy.
  const third = await bridge.evaluate(request("4000000"), NOON_UTC);
  assert.equal(third.decision, "require_approval");
});

test("human denial is sticky for the same intent", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));

  const first = await bridge.evaluate(request("4000000"), NOON_UTC);
  bridge.approvals.decide(first.approval_id!, "denied", "tester", "wrong vendor");

  const second = await bridge.evaluate(request("4000000"), NOON_UTC);
  assert.equal(second.decision, "deny");
  assert.equal(second.reason_code, "bridge.deny.human_denied");
});

test("malformed requests are rejected before evaluation", async () => {
  const { bridge } = makeBridge();
  await assert.rejects(
    () => bridge.evaluate({ ...request("12000"), amount_minor_units: "40 dollars" }, NOON_UTC),
    /integer string/
  );
  await assert.rejects(
    () => bridge.evaluate({ ...request("12000"), agent_pubkey: "not-a-pubkey" }, NOON_UTC),
    /Nostr pubkey/
  );
});

test("every decision lands in the ledger with the agent pubkey as actor", async () => {
  const { bridge } = makeBridge();
  await bridge.evaluate(request("12000"), NOON_UTC);
  await bridge.evaluate(request("12000", "evil-corp.example"), NOON_UTC);
  const { verifyLedger } = await import("../src/ledger.js");
  const result = verifyLedger(bridge.ledger.filePath);
  assert.equal(result.ok, true);
  assert.equal(result.records, 2);
});
