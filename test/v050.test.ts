/**
 * 0.5.0 security release tests: identity canonicalization, npx
 * pinning, direct-call durable claims and replay barriers, unknown
 * transport outcomes, approval-store tamper evidence, the serving
 * lease, and matcher/extraction bounds. Several cases originate from
 * an external security review of a proposed 0.5 branch; each adopted
 * change was re-implemented against this codebase and is proven here.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApprovalStore, gatedCallFingerprint } from "../src/approvals.js";
import {
  extractPayment,
  loadConfig,
  matchesPattern,
  normalizePubkey,
  type BridgeConfig
} from "../src/config.js";
import { GateServer } from "../src/gate.js";
import { Bridge } from "../src/guard.js";
import { acquireServingLease } from "../src/lock.js";
import { jsonShapeProblem } from "../src/mcp.js";
import { AGENT_PUBKEY, NOON_UTC, TEST_POLICY_DOC, makeBridge, seedAllow } from "./helpers.js";

const FAKE_PATH = fileURLToPath(new URL("./fake-downstream.js", import.meta.url));
const HOUR = 60 * 60 * 1000;

/** NIP-19 reference vector: the same key in npub and hex form. */
const VECTOR_HEX = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const VECTOR_NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";

/* ------------------------------------------------------------------ */
/* Identity canonicalization                                           */
/* ------------------------------------------------------------------ */

test("npub canonicalizes to the NIP-19 hex form and bad checksums are refused", () => {
  assert.equal(normalizePubkey(VECTOR_NPUB), VECTOR_HEX);
  assert.equal(normalizePubkey(VECTOR_HEX), VECTOR_HEX);
  // One flipped character must fail the bech32 checksum, not mint a
  // fresh identity.
  const flipped = VECTOR_NPUB.slice(0, -1) + (VECTOR_NPUB.endsWith("6") ? "7" : "6");
  assert.equal(normalizePubkey(flipped), null);
  assert.equal(normalizePubkey("npub1short"), null);
  assert.equal(normalizePubkey(VECTOR_NPUB.toUpperCase()), null);
  // The documented all-zeros unattributed fallback stays a valid identity.
  assert.equal(normalizePubkey("0".repeat(64)), "0".repeat(64));
});

test("hex and npub spellings of one key share one daily cap bucket", async () => {
  const { bridge } = makeBridge();
  const spend = (pubkey: string, amount: string) =>
    bridge.evaluate(
      {
        amount_minor_units: amount,
        currency: "USD",
        counterparty: "acme-datacenter.example",
        memo: "cap split attempt",
        agent_pubkey: pubkey
      },
      NOON_UTC
    );
  // Consume most of the 10,000,000 cap under the hex spelling, then
  // try to spend past the remainder under the npub spelling. Before
  // canonicalization those were two history buckets and this allowed.
  seedAllow(bridge, "9990000", new Date(NOON_UTC.getTime() - HOUR), VECTOR_HEX);
  const decision = await spend(VECTOR_NPUB, "1000000");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason_code, "guardrails.deny.daily_cap_exceeded");
  assert.equal(decision.agent_pubkey, VECTOR_HEX, "decisions are attributed to canonical hex");
});

test("a configured gate identity is canonicalized; an invalid one refuses to start", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-id-"));
  const write = (agentPubkey: string): BridgeConfig => {
    const path = join(dir, `policies-${agentPubkey.slice(0, 8)}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        ...TEST_POLICY_DOC,
        agent_pubkey: agentPubkey,
        downstream: { command: process.execPath, args: [FAKE_PATH], env: {} }
      })
    );
    return loadConfig(path, join(dir, "data-" + agentPubkey.slice(0, 8)));
  };
  const config = write(VECTOR_NPUB);
  assert.equal(config.agent_pubkey, VECTOR_HEX, "config canonicalizes npub at load");
  const gate = new GateServer(new Bridge(config), "test", { quiet: true });
  assert.equal(gate.agentPubkey, VECTOR_HEX);
  gate.close();
  // A checksum-invalid identity is a config error, not a new identity.
  assert.throws(() => write(VECTOR_NPUB.slice(0, -1) + "7"), /Nostr pubkey/);
});

/* ------------------------------------------------------------------ */
/* npx pinning and extraction bounds                                   */
/* ------------------------------------------------------------------ */

test("npx downstream commands must be exactly pinned with -y", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-npx-"));
  const attempt = (args: string[]): void => {
    const path = join(dir, "policies.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...TEST_POLICY_DOC,
        downstream: { command: "npx", args, env: {} }
      })
    );
    loadConfig(path, join(dir, "data"));
  };
  assert.throws(() => attempt(["@stripe/mcp"]), /auditable form/);
  assert.throws(() => attempt(["-y", "@stripe/mcp"]), /exact reviewed version/);
  assert.throws(() => attempt(["-y", "@stripe/mcp@latest"]), /exact reviewed version/);
  assert.throws(() => attempt(["-y", "@stripe/mcp@^1.2.3"]), /exact reviewed version/);
  assert.throws(() => attempt(["--cache", "/tmp", "-y", "@stripe/mcp@1.2.3"]), /auditable form/);
  assert.doesNotThrow(() => attempt(["-y", "@stripe/mcp@1.2.3", "--tools=all"]));
  assert.doesNotThrow(() => attempt(["-y", "some-pkg@0.4.1-beta.2"]));
});

test("overlapping wildcard amount mappings fail closed instead of picking one", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-overlap-"));
  const path = join(dir, "policies.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...TEST_POLICY_DOC,
      downstream: { command: process.execPath, args: [FAKE_PATH], env: {} },
      payment_tools: {
        gate: ["pay_*"],
        mappings: {
          "pay_*": { amount_field: "amount" },
          "*_send": { amount_field: "total" }
        }
      }
    })
  );
  const config = loadConfig(path, join(dir, "data"));
  // pay_send matches both globs: order-dependent extraction refused.
  const ambiguous = extractPayment(config, "pay_send", { amount: "100", total: "999999" });
  assert.equal(ambiguous.ok, false);
  assert.equal((ambiguous as { reason_code: string }).reason_code, "bridge.pending.no_payment_mapping");
  // A tool matching exactly one glob still extracts.
  const clean = extractPayment(config, "pay_invoice", { amount: "100" });
  assert.equal(clean.ok, true);
});

test("extraction bounds amounts, currencies, and counterparties", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-bounds-"));
  const path = join(dir, "policies.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...TEST_POLICY_DOC,
      downstream: { command: process.execPath, args: [FAKE_PATH], env: {} },
      payment_tools: {
        gate: ["create_payment"],
        mappings: {
          create_payment: {
            amount_field: "amount",
            currency_field: "currency",
            counterparty_field: "destination"
          }
        }
      }
    })
  );
  const config = loadConfig(path, join(dir, "data"));
  const base = { amount: "100", currency: "USD", destination: "ok.example" };
  assert.equal(extractPayment(config, "create_payment", base).ok, true);
  assert.equal(
    extractPayment(config, "create_payment", { ...base, amount: "9".repeat(79) }).ok,
    false,
    "a 79-digit amount is unextractable, not evaluable"
  );
  assert.equal(
    extractPayment(config, "create_payment", { ...base, currency: "not a currency!!" }).ok,
    false
  );
  assert.equal(
    extractPayment(config, "create_payment", { ...base, destination: "x".repeat(513) }).ok,
    false
  );
});

test("wildcard tool matching is exact without regular expressions", () => {
  assert.equal(matchesPattern("pay_*", "pay_invoice"), true);
  assert.equal(matchesPattern("pay_*", "pay_a\nb"), true, "newlines cannot escape a gate glob");
  assert.equal(matchesPattern("pay_*", "repay_x"), false);
  assert.equal(matchesPattern("*_pay_*", "acme_pay_send"), true);
  assert.equal(matchesPattern("a*b*c", "a-x-b-y-c"), true);
  assert.equal(matchesPattern("a*b*c", "a-x-c-y-b"), false);
  // The old regex-based matcher could backtrack catastrophically on an
  // adversarial downstream tool name; this must return promptly.
  const started = Date.now();
  assert.equal(matchesPattern("a*a*a*a*a*a*a*a*a*c", "a".repeat(4000) + "b"), false);
  assert.ok(Date.now() - started < 1000, "glob matching stays fast on adversarial names");
});

test("the argument shape check bounds aggregate string size", () => {
  assert.equal(jsonShapeProblem({ memo: "fine" }), null);
  const oversized = { blob: "x".repeat(300_000) };
  assert.match(String(jsonShapeProblem(oversized)), /string characters/);
});

/* ------------------------------------------------------------------ */
/* Approval-store tamper evidence                                      */
/* ------------------------------------------------------------------ */

test("a parked call whose arguments were swapped on disk is refused at load", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-tamper-"));
  const store = new ApprovalStore(dir);
  const parkedArgs = { amount: "5000", destination: "cloudsmith.example" };
  const approval = store.createOrGet(
    {
      fingerprint: gatedCallFingerprint("create_payment", parkedArgs, AGENT_PUBKEY),
      agent_pubkey: AGENT_PUBKEY,
      amount_minor_units: "5000",
      currency: "USD",
      counterparty: "cloudsmith.example",
      memo: "tamper target",
      reason_code: "bridge.pending.ceiling",
      call: { tool_name: "create_payment", arguments: parkedArgs }
    },
    NOON_UTC
  );
  // Attacker edits the parked call to redirect an approved payment.
  const storePath = join(dir, "approvals.json");
  const all = JSON.parse(readFileSync(storePath, "utf8")) as Record<
    string,
    { call: { arguments: Record<string, unknown> } }
  >;
  all[approval.approval_id]!.call.arguments = { amount: "5000", destination: "evil.example" };
  writeFileSync(storePath, JSON.stringify(all));
  assert.throws(() => new ApprovalStore(dir).get(approval.approval_id), /does not match its approved fingerprint/);
});

test("final approvals redact parked arguments but keep the fingerprint binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-redact-"));
  const store = new ApprovalStore(dir);
  const parkedArgs = { amount: "5000", secret_token: "sk_live_do_not_retain" };
  const approval = store.createOrGet(
    {
      fingerprint: gatedCallFingerprint("create_payment", parkedArgs, AGENT_PUBKEY),
      agent_pubkey: AGENT_PUBKEY,
      amount_minor_units: "5000",
      currency: "USD",
      counterparty: "cloudsmith.example",
      memo: "secret retention",
      reason_code: "bridge.pending.ceiling",
      call: { tool_name: "create_payment", arguments: parkedArgs }
    },
    NOON_UTC
  );
  store.decide(approval.approval_id, "denied", "tester", undefined, NOON_UTC);
  const denied = store.get(approval.approval_id)!;
  assert.equal(denied.call_arguments_redacted, true);
  assert.deepEqual(denied.call!.arguments, {}, "secrets do not outlive the decision");
  assert.ok(!JSON.stringify(denied).includes("sk_live_do_not_retain"));
  // The redacted record still loads under strict validation.
  assert.equal(new ApprovalStore(dir).get(approval.approval_id)!.status, "denied");
});

/* ------------------------------------------------------------------ */
/* Gate: grants are cross-checked, direct calls are claimed            */
/* ------------------------------------------------------------------ */

function gateDoc(logPath: string, capMinorUnits = "10000000"): Record<string, unknown> {
  return {
    rail: "x402",
    currency: "USD",
    controls: {
      per_agent_daily_cap: { cap_minor_units: capMinorUnits },
      single_payment_ceiling: { threshold_minor_units: "2500000" },
      counterparty_allowlist: {
        allowed_ids: ["acme-datacenter.example", "cloudsmith.example"]
      },
      business_hours: { tz: "UTC", open_hour: 9, close_hour: 17, effect: "require_approval" }
    },
    downstream: {
      command: process.execPath,
      args: [FAKE_PATH],
      env: { FAKE_DOWNSTREAM_LOG: logPath }
    },
    payment_tools: {
      gate: ["create_payment", "crash_now"],
      mappings: {
        create_payment: {
          amount_field: "amount",
          currency_field: "currency",
          counterparty_field: "destination"
        },
        crash_now: { amount_field: "amount", counterparty: "acme-datacenter.example" }
      }
    },
    approval_ttl_seconds: 3600,
    agent_pubkey: AGENT_PUBKEY,
    buzz: { channel_id: null, cli_path: "buzz" },
    webhook_url: null
  };
}

interface V050Gate {
  dir: string;
  bridge: Bridge;
  gate: GateServer;
  logPath: string;
}

async function makeV050Gate(dir?: string, capMinorUnits?: string): Promise<V050Gate> {
  const base = dir ?? mkdtempSync(join(tmpdir(), "buzz-axiru-v050-gate-"));
  const logPath = join(base, "downstream-calls.jsonl");
  const policiesPath = join(base, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(gateDoc(logPath, capMinorUnits)));
  const config = loadConfig(policiesPath, join(base, "data"));
  const bridge = new Bridge(config);
  const gate = new GateServer(bridge, "test", { clock: () => NOON_UTC, quiet: true });
  await gate.start();
  return { dir: base, bridge, gate, logPath };
}

let rpcId = 9000;
async function call(
  gate: GateServer,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const raw = await gate.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args }
    })
  );
  return (JSON.parse(raw!) as { result: Record<string, unknown> }).result;
}

function bodyOf(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function downstreamCalls(logPath: string): unknown[] {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

test("a grant that exists only in the mutable store is refused at execution", async () => {
  const ctx = await makeV050Gate();
  try {
    const parked = await call(ctx.gate, "create_payment", {
      amount: 4000000,
      currency: "USD",
      destination: "acme-datacenter.example"
    });
    const approvalId = String(bodyOf(parked).approval_id);
    // Forge the grant with a bare store write: no approval_granted
    // record ever enters the hash-chained ledger.
    ctx.bridge.approvals.decide(approvalId, "granted", "attacker", undefined, NOON_UTC);
    await ctx.gate.processApprovals();
    const approval = ctx.bridge.approvals.get(approvalId)!;
    assert.equal(approval.execution_status, "failed");
    assert.match(String(approval.execution_error), /integrity check failed/);
    assert.equal(downstreamCalls(ctx.logPath).length, 0, "the forged grant never reaches money");
  } finally {
    ctx.gate.close();
  }
});

test("direct allowed calls are claimed before the side effect and deduplicated after it", async () => {
  const ctx = await makeV050Gate();
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    const args = { amount: 12000, currency: "USD", destination: "cloudsmith.example" };
    const first = await call(ctx.gate, "create_payment", args);
    assert.equal(bodyOf(first).paid, true);
    assert.equal(downstreamCalls(ctx.logPath).length, 1);

    // The exact same call again is suppressed, not re-paid.
    const replay = await call(ctx.gate, "create_payment", args);
    const replayBody = bodyOf(replay);
    assert.equal(replayBody.status, "already_executed");
    assert.equal(replayBody.reason_code, "bridge.execution.duplicate_suppressed");
    assert.equal(downstreamCalls(ctx.logPath).length, 1, "no second downstream call");

    // A different call still executes.
    const other = await call(ctx.gate, "create_payment", { ...args, amount: 12001 });
    assert.equal(bodyOf(other).paid, true);
    assert.equal(downstreamCalls(ctx.logPath).length, 2);
  } finally {
    ctx.gate.close();
  }
});

test("a direct call that loses its outcome reserves cap headroom and survives restart", async () => {
  // Tight 4,000,000 cap so the reservation math stays under the
  // 2,500,000 single-payment ceiling in every request below.
  const ctx = await makeV050Gate(undefined, "4000000");
  const args = { amount: 2000000 };
  try {
    seedAllow(ctx.bridge, "50000", new Date(NOON_UTC.getTime() - HOUR));
    // crash_now is policy-allowed at 2,000,000 (below cap and ceiling);
    // the child then exits without replying.
    const lost = await call(ctx.gate, "crash_now", args);
    const lostBody = bodyOf(lost);
    assert.equal(lostBody.status, "execution_outcome_unknown");
    assert.equal(lostBody.reason_code, "bridge.execution.reconciliation_required");
    assert.equal(lostBody.executed, "unknown");
  } finally {
    ctx.gate.close();
  }

  // Restart-equivalent: a fresh gate over the same data dir.
  const restarted = await makeV050Gate(ctx.dir, "4000000");
  try {
    // The ambiguous 2,000,000 is reserved: 2,400,000 more would cross
    // the 4,000,000 cap.
    const blocked = restarted.bridge.policyEvaluate(
      {
        amount_minor_units: "2400000",
        currency: "USD",
        counterparty: "cloudsmith.example",
        memo: "post-crash spend",
        agent_pubkey: AGENT_PUBKEY
      },
      NOON_UTC
    ).result;
    assert.equal(blocked.decision, "deny");
    assert.equal(blocked.reason_code, "guardrails.deny.daily_cap_exceeded");

    // The identical call is held, never silently re-executed.
    const retry = await call(restarted.gate, "crash_now", args);
    const retryBody = bodyOf(retry);
    assert.equal(retryBody.reason_code, "bridge.execution.reconciliation_required");

    // The incident is listed for the operator, keyed by fingerprint.
    const incidents = restarted.bridge.ledger.directExecutionIncidents();
    assert.equal(incidents.length, 1);
    const fingerprint = incidents[0]!.fingerprint;

    // Operator reconciliation as failed clears the reservation and the
    // replay barrier (this is what `buzz-axiru reconcile <fp>` writes).
    restarted.bridge.ledger.append({
      type: "execution",
      actor: "operator",
      agent_pubkey: AGENT_PUBKEY,
      reason_code: "bridge.execution.reconciled_failed",
      amount_minor_units: incidents[0]!.amount_minor_units,
      currency: "USD",
      counterparty: incidents[0]!.counterparty,
      memo: incidents[0]!.memo,
      fingerprint,
      execution_status: "failed",
      error: "provider confirmed no transfer",
      note: "provider confirmed no transfer",
      ts: NOON_UTC.toISOString()
    });
    assert.equal(restarted.bridge.ledger.directExecutionIncidents().length, 0);
    const cleared = restarted.bridge.policyEvaluate(
      {
        amount_minor_units: "2400000",
        currency: "USD",
        counterparty: "cloudsmith.example",
        memo: "post-reconcile spend",
        agent_pubkey: AGENT_PUBKEY
      },
      NOON_UTC
    ).result;
    assert.equal(cleared.decision, "allow");
  } finally {
    restarted.gate.close();
  }
});

test("one enforcing gate per data directory: the serving lease refuses a second gate", async () => {
  const ctx = await makeV050Gate();
  try {
    const second = new GateServer(ctx.bridge, "test", { clock: () => NOON_UTC, quiet: true });
    await assert.rejects(second.start(), /another enforcing gate already owns/);
  } finally {
    ctx.gate.close();
  }
  // After a clean close the lease is free again.
  const third = await makeV050Gate(ctx.dir);
  third.gate.close();
});

test("a released or crashed lease is reclaimed, a live one is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v050-lease-"));
  const release = acquireServingLease(dir);
  assert.throws(() => acquireServingLease(dir), /another enforcing gate/);
  release();
  // A dead-pid lease from a crashed gate must not wedge the directory.
  writeFileSync(
    join(dir, ".serve.lock"),
    JSON.stringify({ pid: 999999999, host: hostname(), at: Date.now(), token: "t" })
  );
  const reclaimed = acquireServingLease(dir);
  reclaimed();
});
