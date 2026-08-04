/**
 * Scripted demo session for the README GIF: GATE MODE.
 *
 * Runs the real gate (real proxy, real policy evaluation, real
 * approvals store, real hash-chained ledger) against a real spawned
 * downstream payment MCP server (the scripted fake from the test
 * suite) and prints the exact terminal output to screen-record:
 *
 *   1. the agent calls the payment tool for a non-allowlisted vendor:
 *      DENIED, and the downstream server never sees the call,
 *   2. the agent calls it for USD 40,000.00: parked for approval,
 *      channel post drafted, downstream still untouched,
 *   3. a human approves from the CLI; the gate replays the original
 *      call downstream exactly once and shows the payment receipt,
 *   4. the ledger chain verifies.
 *
 * Run: npm run demo        (set DEMO_FAST=1 to skip the pauses)
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { GateServer } from "../src/gate.js";
import { Bridge } from "../src/guard.js";
import { verifyLedger } from "../src/ledger.js";
import { approvalRequestText, formatAmount } from "../src/notify.js";

const AGENT_PUBKEY = "b7a1c3d9e5f2064788a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f";
// Buzz launch day, 15:00 New York time: inside the business-hours window.
const CLOCK = new Date("2026-07-21T15:00:00-04:00");
const FAST = process.env.DEMO_FAST === "1";
process.env.BUZZ_AXIRU_QUIET = "1";

const demoDir = fileURLToPath(new URL(".", import.meta.url));
const dataDir = join(demoDir, ".demo-data");
const fakeDownstream = join(demoDir, "..", "test", "fake-downstream.js");
const downstreamLog = join(dataDir, "downstream-calls.jsonl");

function sleep(ms: number): Promise<void> {
  return FAST ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function say(text: string, pauseMs = 500): Promise<void> {
  process.stdout.write(text + "\n");
  await sleep(pauseMs);
}

function downstreamCallCount(): number {
  if (!existsSync(downstreamLog)) return 0;
  return readFileSync(downstreamLog, "utf8").split("\n").filter((l) => l.trim().length > 0)
    .length;
}

let rpcId = 0;
async function callPaymentTool(
  gate: GateServer,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const raw = await gate.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: "create_payment", arguments: args }
    })
  );
  return (JSON.parse(raw!) as { result: Record<string, unknown> }).result;
}

function bodyOf(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const policiesPath = join(dataDir, "policies.json");
  writeFileSync(
    policiesPath,
    JSON.stringify(
      {
        rail: "x402",
        currency: "USD",
        controls: {
          per_agent_daily_cap: { cap_minor_units: "10000000" },
          single_payment_ceiling: { threshold_minor_units: "2500000", approver_group: "operators" },
          counterparty_allowlist: {
            allowed_ids: ["acme-datacenter.example", "cloudsmith.example", "openrouter.example"]
          },
          business_hours: { tz: "America/New_York", open_hour: 9, close_hour: 17, effect: "require_approval" }
        },
        downstream: {
          command: process.execPath,
          args: [fakeDownstream],
          env: { FAKE_DOWNSTREAM_LOG: downstreamLog }
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
        approval_ttl_seconds: 86400,
        agent_pubkey: AGENT_PUBKEY,
        buzz: { channel_id: null, cli_path: "buzz" },
        webhook_url: null
      },
      null,
      2
    )
  );

  const config = loadConfig(policiesPath, dataDir);
  const bridge = new Bridge(config);
  const gate = new GateServer(bridge, "0.2.0", { clock: () => CLOCK, quiet: true });
  await gate.start();

  // Seed one prior authorized spend so rolling-window history exists
  // (a brand-new agent's very first spend deliberately escalates to a
  // human; this demo starts on day two of the agent's life).
  bridge.ledger.append({
    type: "decision",
    actor: AGENT_PUBKEY,
    agent_pubkey: AGENT_PUBKEY,
    decision: "allow",
    reason_code: "guardrails.allow.default",
    amount_minor_units: "180000",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "build minutes, weekly top-up",
    fingerprint: "sha256:" + "0f".repeat(32),
    ts: new Date(CLOCK.getTime() - 3 * 60 * 60 * 1000).toISOString()
  });

  try {
    await say("");
    await say("  buzz-axiru 0.2.0 | gate mode: the agent's only path to money runs through policy", 700);
    await say("  downstream: fake-payments MCP server (spawned child) | gated: create_payment, refund_*");
    await say("  policy: daily cap USD 100,000.00 | ceiling USD 25,000.00 | allowlist | business hours ET", 900);
    await say("");

    await say("[1] agent calls create_payment for a vendor OFF the allowlist", 400);
    await say('      { "amount": 90000, "currency": "USD", "destination": "evil-corp.example" }', 800);
    const denied = await callPaymentTool(gate, {
      amount: 90000,
      currency: "USD",
      destination: "evil-corp.example"
    });
    const deniedBody = bodyOf(denied);
    await say("");
    await say(`      decision:   ${String(deniedBody.decision).toUpperCase()}  (isError: ${String(denied.isError)})`);
    await say(`      reason:     ${deniedBody.reason_code}`);
    await say(`      downstream: ${downstreamCallCount()} calls received. The payment server never saw it.`, 1000);
    await say("");

    await say("[2] agent calls create_payment for USD 40,000.00 to an approved vendor", 400);
    await say('      { "amount": 4000000, "currency": "USD", "destination": "acme-datacenter.example" }', 800);
    const parked = await callPaymentTool(gate, {
      amount: 4000000,
      currency: "USD",
      destination: "acme-datacenter.example"
    });
    const parkedBody = bodyOf(parked);
    const approvalId = String(parkedBody.approval_id);
    await say("");
    await say(`      status:     ${parkedBody.status}  (call parked, NOT executed)`);
    await say(`      reason:     ${parkedBody.reason_code}`);
    await say(`      downstream: still ${downstreamCallCount()} calls received`, 800);
    await say("");
    await say("      posted to the Buzz channel:", 300);
    for (const line of approvalRequestText(bridge.approvals.get(approvalId)!).split("\n")) {
      await say("      | " + line, 120);
    }
    await say("");

    await say("[3] a human decides", 400);
    await say(`      $ buzz-axiru approve ${approvalId} --by marcos --note "invoice checked"`, 800);
    const granted = bridge.approvals.decide(approvalId, "granted", "marcos", "invoice checked", CLOCK);
    bridge.ledger.append({
      type: "approval_granted",
      actor: "marcos",
      agent_pubkey: AGENT_PUBKEY,
      reason_code: "bridge.approval.granted",
      amount_minor_units: granted.amount_minor_units,
      currency: granted.currency,
      counterparty: granted.counterparty,
      memo: granted.memo,
      fingerprint: granted.fingerprint,
      approval_id: approvalId,
      tool_name: "create_payment",
      note: "invoice checked",
      ts: CLOCK.toISOString()
    });
    await say("      granted by marcos; the gate replays the ORIGINAL call downstream...", 700);
    await gate.processApprovals(CLOCK);
    const approval = bridge.approvals.get(approvalId)!;
    const receipt = bodyOf((approval.execution_result ?? {}) as Record<string, unknown>);
    await say("");
    await say(`      execution:  ${approval.execution_status} (exactly once)`);
    await say(`      receipt:    payment_id ${receipt.payment_id}, ${formatAmount("4000000", "USD")} to ${receipt.destination}`);
    await say(`      downstream: ${downstreamCallCount()} call received, the one a human approved`, 1000);
    await say("");

    await say("[4] anyone can audit the chain", 400);
    await say("      $ buzz-axiru verify", 600);
    const result = verifyLedger(bridge.ledger.filePath);
    await say(`      ${JSON.stringify(result)}`, 900);
    await say("");
    await say("  Deny never reached the rail. Approval executed exactly once. All of it in one");
    await say("  tamper-evident log. The agent's only path to money ran through the decision.");
    await say("");
  } finally {
    gate.close();
  }
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
