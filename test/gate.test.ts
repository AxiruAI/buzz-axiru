/**
 * Gate mode: the gating MCP proxy in front of a scripted fake
 * downstream payment server (test/fake-downstream.ts, spawned as a
 * real stdio subprocess for every test).
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { GateServer } from "../src/gate.js";
import { Bridge } from "../src/guard.js";
import { verifyLedger, type LedgerRecord } from "../src/ledger.js";
import { AGENT_PUBKEY, NOON_UTC, seedAllow } from "./helpers.js";

const FAKE_PATH = fileURLToPath(new URL("./fake-downstream.js", import.meta.url));
const HOUR = 60 * 60 * 1000;

interface GateContext {
  bridge: Bridge;
  gate: GateServer;
  logPath: string;
  ledgerPath: string;
  now: { value: Date };
  close: () => void;
}

function basePolicyDoc(logPath: string): Record<string, unknown> {
  return {
    rail: "x402",
    currency: "USD",
    controls: {
      per_agent_daily_cap: { cap_minor_units: "10000000" },
      single_payment_ceiling: { threshold_minor_units: "2500000" },
      counterparty_allowlist: {
        allowed_ids: ["acme-datacenter.example", "cloudsmith.example", "openrouter.example"]
      },
      business_hours: { tz: "UTC", open_hour: 9, close_hour: 17, effect: "require_approval" }
    },
    downstream: {
      command: process.execPath,
      args: [FAKE_PATH],
      env: { FAKE_DOWNSTREAM_LOG: logPath }
    },
    payment_tools: {
      gate: ["create_payment", "refund_*"],
      mappings: {
        create_payment: {
          amount_field: "amount",
          currency_field: "currency",
          counterparty_field: "destination"
        }
      }
    },
    approval_ttl_seconds: 3600,
    agent_pubkey: AGENT_PUBKEY,
    buzz: { channel_id: null, cli_path: "buzz" },
    webhook_url: null
  };
}

async function makeGate(
  mutate: (doc: Record<string, unknown>) => void = () => {}
): Promise<GateContext> {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-gate-"));
  const logPath = join(dir, "downstream-calls.jsonl");
  const doc = basePolicyDoc(logPath);
  mutate(doc);
  const policiesPath = join(dir, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(doc, null, 2));
  const config = loadConfig(policiesPath, join(dir, "data"));
  const bridge = new Bridge(config);
  const now = { value: NOON_UTC };
  const gate = new GateServer(bridge, "test", { clock: () => now.value, quiet: true });
  await gate.start();
  return {
    bridge,
    gate,
    logPath,
    ledgerPath: bridge.ledger.filePath,
    now,
    close: () => gate.close()
  };
}

let nextId = 100;
async function callTool(
  gate: GateServer,
  name: string,
  args: Record<string, unknown>
): Promise<{ result?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const raw = await gate.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name, arguments: args }
    })
  );
  return JSON.parse(raw!) as { result?: Record<string, unknown>; error?: Record<string, unknown> };
}

function toolText(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function downstreamCalls(logPath: string): Array<{ name: string; args: Record<string, unknown> }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> });
}

function ledgerRecords(ledgerPath: string): LedgerRecord[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerRecord);
}

const PAYMENT = {
  amount: 12000,
  currency: "USD",
  destination: "acme-datacenter.example"
};

test("tools/list merges downstream tools with the advisory tool and marks gated ones", async () => {
  const ctx = await makeGate((doc) => {
    (doc.downstream as Record<string, unknown>).hide_tools = ["crash_now"];
  });
  try {
    const raw = await ctx.gate.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    );
    const tools = (JSON.parse(raw!).result as { tools: Array<Record<string, unknown>> }).tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("request_spend_approval"));
    assert.ok(names.includes("create_payment"));
    assert.ok(names.includes("get_weather"));
    assert.ok(!names.includes("crash_now"), "hidden tools are not listed");
    const gated = tools.find((t) => t.name === "create_payment")!;
    assert.match(String(gated.description), /spend gate/);
    const ungated = tools.find((t) => t.name === "get_weather")!;
    assert.doesNotMatch(String(ungated.description), /spend gate/);
  } finally {
    ctx.close();
  }
});

test("un-gated tools pass through to the downstream server untouched", async () => {
  const ctx = await makeGate();
  try {
    const reply = await callTool(ctx.gate, "get_weather", { city: "Lisbon" });
    const content = (reply.result as { content: Array<{ text: string }> }).content;
    assert.equal(content[0]!.text, "sunny in Lisbon");
    assert.deepEqual(downstreamCalls(ctx.logPath), [
      { name: "get_weather", args: { city: "Lisbon" } }
    ]);
    assert.equal(ledgerRecords(ctx.ledgerPath).length, 0, "passthrough leaves no decision record");
  } finally {
    ctx.close();
  }
});

test("allow path executes the call downstream and records decision plus execution", async () => {
  const ctx = await makeGate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const reply = await callTool(ctx.gate, "create_payment", PAYMENT);
    const body = toolText(reply.result!);
    assert.equal(body.paid, true);
    assert.equal(body.amount, 12000);
    const calls = downstreamCalls(ctx.logPath);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, PAYMENT);
    const records = ledgerRecords(ctx.ledgerPath);
    const decision = records.find((r) => r.type === "decision" && r.tool_name === "create_payment");
    assert.ok(decision);
    assert.equal(decision!.decision, "allow");
    assert.equal(decision!.agent_pubkey, AGENT_PUBKEY);
    const execution = records.find((r) => r.type === "execution");
    assert.ok(execution);
    assert.equal(execution!.execution_status, "executed");
  } finally {
    ctx.close();
  }
});

test("deny never reaches the downstream server", async () => {
  const ctx = await makeGate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const reply = await callTool(ctx.gate, "create_payment", {
      ...PAYMENT,
      destination: "evil-corp.example"
    });
    const result = reply.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const body = toolText(result);
    assert.equal(body.status, "denied_by_policy");
    assert.equal(body.decision, "deny");
    assert.equal(body.reason_code, "guardrails.deny.counterparty_not_allowlisted");
    assert.equal(downstreamCalls(ctx.logPath).length, 0, "downstream must never see a denied call");
    const records = ledgerRecords(ctx.ledgerPath);
    assert.equal(records.filter((r) => r.type === "execution").length, 0);
    assert.equal(records.at(-1)!.decision, "deny");
  } finally {
    ctx.close();
  }
});

test("require_approval parks the call, executes it once on approve, and replays are idempotent", async () => {
  const ctx = await makeGate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const big = { ...PAYMENT, amount: 4000000 };
    const first = await callTool(ctx.gate, "create_payment", big);
    const body = toolText(first.result!);
    assert.equal(body.status, "pending_approval");
    assert.equal(body.executed, false);
    const approvalId = String(body.approval_id);
    assert.ok(approvalId.length > 0);
    assert.equal(downstreamCalls(ctx.logPath).length, 0, "parked call must not execute");

    // Retrying while pending stays parked, same approval id.
    const retry = await callTool(ctx.gate, "create_payment", big);
    assert.equal(toolText(retry.result!).approval_id, approvalId);
    assert.equal(downstreamCalls(ctx.logPath).length, 0);

    // Human approves (what the CLI does), then the sweeper replays it.
    ctx.bridge.approvals.decide(approvalId, "granted", "tester", undefined, ctx.now.value);
    await ctx.gate.processApprovals();
    const calls = downstreamCalls(ctx.logPath);
    assert.equal(calls.length, 1, "approved call executes exactly once");
    assert.deepEqual(calls[0]!.args, big);
    const approval = ctx.bridge.approvals.get(approvalId)!;
    assert.equal(approval.execution_status, "executed");

    // The agent's follow-up call returns the stored downstream result
    // without paying twice.
    const after = await callTool(ctx.gate, "create_payment", big);
    const stored = toolText(after.result!);
    assert.equal(stored.paid, true);
    const meta = (after.result as Record<string, unknown>)._buzz_axiru as Record<string, unknown>;
    assert.equal(meta.status, "executed_after_approval");
    assert.equal(meta.decided_by, "tester");
    assert.equal(downstreamCalls(ctx.logPath).length, 1, "replay is idempotent");

    const records = ledgerRecords(ctx.ledgerPath);
    const execution = records.find((r) => r.type === "execution");
    assert.ok(execution);
    assert.equal(execution!.approval_id, approvalId);
  } finally {
    ctx.close();
  }
});

test("expired approvals are recorded as expired and never executed", async () => {
  const ctx = await makeGate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const big = { ...PAYMENT, amount: 4000000 };
    const first = await callTool(ctx.gate, "create_payment", big);
    const approvalId = String(toolText(first.result!).approval_id);

    // TTL is 3600s; jump two hours.
    ctx.now.value = new Date(NOON_UTC.getTime() + 2 * HOUR);
    await ctx.gate.processApprovals();
    assert.equal(ctx.bridge.approvals.get(approvalId)!.status, "expired");
    assert.equal(downstreamCalls(ctx.logPath).length, 0, "expired calls never execute");

    // A late human decision is refused.
    assert.throws(
      () => ctx.bridge.approvals.decide(approvalId, "granted", "tester", undefined, ctx.now.value),
      /expired/
    );

    // The agent's retry is refused, not silently re-parked.
    const retry = await callTool(ctx.gate, "create_payment", big);
    assert.equal((retry.result as Record<string, unknown>).isError, true);
    const body = toolText(retry.result!);
    assert.equal(body.status, "approval_expired");
    assert.equal(body.reason_code, "bridge.deny.approval_expired");
    assert.equal(downstreamCalls(ctx.logPath).length, 0);

    const records = ledgerRecords(ctx.ledgerPath);
    assert.ok(records.some((r) => r.type === "approval_expired"));
    assert.equal(records.filter((r) => r.type === "execution").length, 0);
  } finally {
    ctx.close();
  }
});

test("gated call with an unextractable amount fails closed to require_approval", async () => {
  const ctx = await makeGate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const reply = await callTool(ctx.gate, "create_payment", {
      currency: "USD",
      destination: "acme-datacenter.example"
      // amount missing entirely
    });
    const body = toolText(reply.result!);
    assert.equal(body.status, "pending_approval");
    assert.equal(body.reason_code, "bridge.pending.amount_unextractable");
    assert.equal(downstreamCalls(ctx.logPath).length, 0, "never allow what cannot be evaluated");

    // Malformed (negative) amounts fail closed the same way.
    const negative = await callTool(ctx.gate, "create_payment", { ...PAYMENT, amount: -5 });
    assert.equal(toolText(negative.result!).reason_code, "bridge.pending.amount_unextractable");
    assert.equal(downstreamCalls(ctx.logPath).length, 0);
  } finally {
    ctx.close();
  }
});

test("missing payment_tools matcher fails closed: every downstream tool is gated", async () => {
  const ctx = await makeGate((doc) => {
    delete doc.payment_tools;
  });
  try {
    assert.equal(ctx.gate.gateAll, true);
    // Even the weather tool is now gated, and with no mapping it parks.
    const reply = await callTool(ctx.gate, "get_weather", { city: "Lisbon" });
    const body = toolText(reply.result!);
    assert.equal(body.status, "pending_approval");
    assert.equal(body.reason_code, "bridge.pending.no_payment_mapping");
    assert.equal(downstreamCalls(ctx.logPath).length, 0);
  } finally {
    ctx.close();
  }
});

test("a downstream crash surfaces as an error, not a hang, and later calls fail fast", async () => {
  const ctx = await makeGate((doc) => {
    // Keep crash_now un-gated so the call reaches the child.
    (doc.payment_tools as Record<string, unknown>).gate = ["create_payment"];
  });
  try {
    const reply = await callTool(ctx.gate, "crash_now", {});
    const result = reply.result as Record<string, unknown>;
    assert.equal(result.isError, true);
    const body = toolText(result);
    assert.equal(body.reason_code, "bridge.error.downstream_unavailable");
    assert.match(String(body.error), /exited/);

    // The child is gone; the next call fails immediately instead of hanging.
    const after = await callTool(ctx.gate, "get_weather", { city: "Lisbon" });
    assert.equal((after.result as Record<string, unknown>).isError, true);
  } finally {
    ctx.close();
  }
});

test("the hash chain covers gated decisions, executions, approvals, and expiries", async () => {
  const ctx = await makeGate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    await callTool(ctx.gate, "create_payment", PAYMENT); // allow + execution
    await callTool(ctx.gate, "create_payment", { ...PAYMENT, destination: "evil-corp.example" }); // deny
    const parked = await callTool(ctx.gate, "create_payment", { ...PAYMENT, amount: 4000000 });
    const approvalId = String(toolText(parked.result!).approval_id);
    ctx.bridge.approvals.decide(approvalId, "granted", "tester", undefined, ctx.now.value);
    await ctx.gate.processApprovals(); // execution after approval

    const records = ledgerRecords(ctx.ledgerPath);
    const types = new Set(records.map((r) => r.type));
    assert.ok(types.has("decision"));
    assert.ok(types.has("execution"));
    const result = verifyLedger(ctx.ledgerPath);
    assert.equal(result.ok, true);
    assert.equal(result.records, records.length);

    // Tampering with a gated decision breaks the chain.
    const lines = readFileSync(ctx.ledgerPath, "utf8").split("\n");
    const tampered = lines.map((line) => line.replace('"12000"', '"12"'));
    writeFileSync(ctx.ledgerPath + ".tampered", tampered.join("\n"));
    const bad = verifyLedger(ctx.ledgerPath + ".tampered");
    assert.equal(bad.ok, false);
  } finally {
    ctx.close();
  }
});

test("approved execution counts toward the agent's rolling daily cap", async () => {
  const ctx = await makeGate();
  try {
    // 7,600,000 prior authorized spend plus a 2,400,000 gated execution
    // lands exactly on the 10,000,000 daily cap. The next request can
    // only be denied if the gated EXECUTION counted toward history.
    seedAllow(ctx.bridge, "7600000", new Date(NOON_UTC.getTime() - HOUR));
    const first = await callTool(ctx.gate, "create_payment", { ...PAYMENT, amount: 2400000 });
    assert.equal(toolText(first.result!).paid, true);
    const reply = await callTool(ctx.gate, "create_payment", { ...PAYMENT, amount: 12000 });
    const body = toolText(reply.result!);
    assert.equal(body.decision, "deny");
    assert.equal(body.reason_code, "guardrails.deny.daily_cap_exceeded");
    assert.equal(downstreamCalls(ctx.logPath).length, 1);
  } finally {
    ctx.close();
  }
});

test("execution failure after approval is recorded with a distinct status", async () => {
  const ctx = await makeGate((doc) => {
    // Gate crash_now and map a fake amount so policy can evaluate it;
    // replaying it after approval kills the downstream server, which
    // is exactly the failure we want recorded.
    (doc.payment_tools as Record<string, unknown>) = {
      gate: ["create_payment", "crash_now"],
      mappings: {
        create_payment: {
          amount_field: "amount",
          currency_field: "currency",
          counterparty_field: "destination"
        },
        crash_now: { amount_field: "amount", counterparty: "acme-datacenter.example" }
      }
    };
  });
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const parked = await callTool(ctx.gate, "crash_now", { amount: 4000000 });
    const approvalId = String(toolText(parked.result!).approval_id);
    ctx.bridge.approvals.decide(approvalId, "granted", "tester", undefined, ctx.now.value);
    await ctx.gate.processApprovals();

    const approval = ctx.bridge.approvals.get(approvalId)!;
    assert.equal(approval.execution_status, "failed");
    const records = ledgerRecords(ctx.ledgerPath);
    const failed = records.find((r) => r.type === "execution");
    assert.ok(failed);
    assert.equal(failed!.execution_status, "failed");
    assert.equal(failed!.reason_code, "bridge.execution.failed");

    // The agent's follow-up sees the failure, and the grant is spent.
    const after = await callTool(ctx.gate, "crash_now", { amount: 4000000 });
    const body = toolText(after.result!);
    assert.equal(body.status, "execution_failed_after_approval");
    assert.equal(verifyLedger(ctx.ledgerPath).ok, true);
  } finally {
    ctx.close();
  }
});
