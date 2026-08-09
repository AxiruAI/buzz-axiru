/**
 * Policy evaluation paths through the bridge: allow, require_approval,
 * deny, the zero-history escalation, and the human approval flow.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { gatedCallFingerprint } from "../src/approvals.js";
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

test("human approval flow: a consumed grant cannot authorize the same intent again", async () => {
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

  // The grant is single-use: an identical retry is explicitly refused,
  // rather than being presented as a new pending approval backed by the
  // already-consumed record.
  const third = await bridge.evaluate(request("4000000"), NOON_UTC);
  assert.equal(third.decision, "deny");
  assert.equal(third.reason_code, "bridge.deny.approval_already_consumed");
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

test("one payment cannot jump from below the daily cap to above it", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "9000000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("1000001"), NOON_UTC);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "guardrails.deny.daily_cap_exceeded");
});

test("a payment may land exactly on the daily cap", async () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "9000000", new Date(NOON_UTC.getTime() - HOUR));
  const decision = await bridge.evaluate(request("1000000"), NOON_UTC);
  assert.equal(decision.decision, "allow");
});

test("an ambiguous in-progress payment reserves daily-cap headroom", () => {
  const { bridge } = makeBridge();
  seedAllow(bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
  const parkedArgs = { amount: "8950000" };
  const approval = bridge.approvals.createOrGet(
    {
      fingerprint: gatedCallFingerprint("create_payment", parkedArgs, AGENT_PUBKEY),
      agent_pubkey: AGENT_PUBKEY,
      amount_minor_units: "8950000",
      currency: "USD",
      counterparty: "acme-datacenter.example",
      memo: "ambiguous provider response",
      reason_code: "guardrails.pending.above_approval_threshold",
      call: { tool_name: "create_payment", arguments: parkedArgs }
    },
    NOON_UTC
  );
  bridge.approvals.decide(approval.approval_id, "granted", "tester", undefined, NOON_UTC);
  bridge.approvals.claimExecution(approval.approval_id, NOON_UTC);

  const blocked = bridge.policyEvaluate(request("1000001"), NOON_UTC).result;
  assert.equal(blocked.decision, "deny");
  assert.equal(blocked.reason_code, "guardrails.deny.daily_cap_exceeded");

  bridge.approvals.recordExecution(approval.approval_id, {
    status: "failed",
    error: "operator confirmed no transfer",
    at: NOON_UTC
  });
  const afterReconciliation = bridge.policyEvaluate(request("1000001"), NOON_UTC).result;
  assert.equal(afterReconciliation.decision, "allow");
});

test("a different currency cannot bypass this policy pack's amount controls", async () => {
  const { bridge } = makeBridge();
  await assert.rejects(
    bridge.evaluate({ ...request("100"), currency: "EUR" }, NOON_UTC),
    /does not match the policy currency/
  );
});
