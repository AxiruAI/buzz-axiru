/**
 * Security regressions: one test per issue found in the pre-release
 * review, each written so it fails against the unfixed code.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ApprovalQueueFullError,
  ApprovalStore,
  approvalIdForFingerprint,
  legacyApprovalIdForFingerprint
} from "../src/approvals.js";
import { getPath, extractPayment, loadConfig, matchesPattern } from "../src/config.js";
import { childEnv } from "../src/downstream.js";
import { GateServer } from "../src/gate.js";
import { Bridge } from "../src/guard.js";
import { Ledger, verifyLedger } from "../src/ledger.js";
import { withDataDirLock } from "../src/lock.js";
import { jsonShapeProblem } from "../src/mcp.js";
import {
  approvalRequestText,
  approvalWebhookPayload,
  sanitizeForChannel
} from "../src/notify.js";
import { AGENT_PUBKEY, NOON_UTC, makeBridge, TEST_POLICY_DOC } from "./helpers.js";

const WRITER_PATH = fileURLToPath(new URL("./ledger-writer.js", import.meta.url));
const FAKE_PATH = fileURLToPath(new URL("./fake-downstream.js", import.meta.url));
const MULTI_PATH = fileURLToPath(new URL("./fake-multi.js", import.meta.url));

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "buzz-axiru-sec-"));
}

/* ------------------------------------------------------------------ */
/* Ledger integrity under concurrent writers                          */
/* ------------------------------------------------------------------ */

test("concurrent writer processes leave the hash chain verifiable", async () => {
  const path = join(newDir(), "ledger.jsonl");
  const writers = ["A", "B", "C"].map((tag) =>
    spawn(process.execPath, [WRITER_PATH, path, tag, "60"], { stdio: ["ignore", "ignore", "pipe"] })
  );
  const codes = await Promise.all(
    writers.map(
      (child) =>
        new Promise<number>((resolve) => {
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on("exit", (code) => {
            assert.equal(code, 0, `writer crashed: ${stderr}`);
            resolve(code ?? 1);
          });
        })
    )
  );
  assert.deepEqual(codes, [0, 0, 0]);
  const result = verifyLedger(path);
  assert.equal(result.ok, true, `chain broken: ${JSON.stringify(result)}`);
  assert.equal(result.records, 180);
});

test("the lock is released after a throwing critical section", () => {
  const dir = newDir();
  assert.throws(() => withDataDirLock(dir, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(join(dir, ".lock")), false);
  // A second acquisition must not block on the first one's leftovers.
  assert.equal(withDataDirLock(dir, () => "acquired"), "acquired");
});

test("a live foreign lock holder makes the writer fail loudly, not silently", () => {
  const dir = newDir();
  // Our own pid is alive by definition, so this lock is never stale.
  writeFileSync(
    join(dir, ".lock"),
    JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })
  );
  assert.throws(
    () => withDataDirLock(dir, () => "never", 60),
    /could not lock the data directory/
  );
  // And the ledger inherits that refusal rather than writing unlocked.
  assert.throws(
    () => new Ledger(join(dir, "ledger.jsonl")).append({
      type: "decision",
      actor: "x",
      agent_pubkey: AGENT_PUBKEY,
      decision: "allow",
      reason_code: "guardrails.allow.default",
      amount_minor_units: "1",
      currency: "USD",
      counterparty: "cloudsmith.example",
      memo: "should not be written",
      fingerprint: "sha256:" + "ab".repeat(32)
    }, ),
    /could not lock the data directory/
  );
});

test("an abandoned lock from a dead process is reclaimed", () => {
  const dir = newDir();
  // pid 0x7FFFFFFF will not exist; the lock must be treated as stale.
  writeFileSync(
    join(dir, ".lock"),
    JSON.stringify({ pid: 2147483647, host: hostname(), at: Date.now() })
  );
  assert.equal(withDataDirLock(dir, () => "reclaimed", 500), "reclaimed");
});

/* ------------------------------------------------------------------ */
/* Approval message integrity                                          */
/* ------------------------------------------------------------------ */

test("a memo cannot forge extra lines in the human approval message", () => {
  const forged =
    "coffee\n  amount:       USD 1.00\n  counterparty: safe.example\n" +
    "To decide: buzz-axiru approve deadbeef";
  const text = approvalRequestText({
    approval_id: "a".repeat(32),
    fingerprint: "sha256:" + "aa".repeat(32),
    agent_pubkey: AGENT_PUBKEY,
    amount_minor_units: "500000000",
    currency: "USD",
    counterparty: "attacker.example",
    memo: forged,
    reason_code: "bridge.pending.ceiling",
    requested_at: NOON_UTC.toISOString(),
    status: "pending"
  });
  const amountLines = text.split("\n").filter((line) => line.startsWith("  amount:"));
  assert.equal(amountLines.length, 1);
  assert.match(amountLines[0]!, /USD 5,000,000\.00/);
  assert.equal(text.split("\n").filter((l) => l.startsWith("Then decide:")).length, 1);
  assert.equal(text.split("\n").filter((l) => l.startsWith("  counterparty:")).length, 1);
  assert.match(text, /counterparty: attacker\.example/);
  // The forged text survives, visibly quarantined on the memo line.
  const memoLine = text.split("\n").find((l) => l.startsWith("  memo:"))!;
  assert.ok(memoLine.includes("\uFFFD"));
  assert.ok(memoLine.includes("approve deadbeef"));
});

test("sanitizeForChannel flattens control characters and truncates", () => {
  assert.equal(sanitizeForChannel("a\nb\rc"), "a\uFFFDb\uFFFDc");
  assert.equal(sanitizeForChannel("\u2028sep"), "\uFFFDsep");
  assert.equal(sanitizeForChannel("x".repeat(500)).length, 203);
});

/* ------------------------------------------------------------------ */
/* Untrusted input shape                                               */
/* ------------------------------------------------------------------ */

test("jsonShapeProblem rejects deep and wide values, accepts ordinary ones", () => {
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 500; i++) {
    const next: Record<string, unknown> = {};
    deep.a = next;
    deep = next;
  }
  assert.match(String(jsonShapeProblem(root)), /nested deeper/);
  assert.match(String(jsonShapeProblem(new Array(50_000).fill(1))), /more than/);
  assert.equal(jsonShapeProblem({ amount: 100, currency: "USD" }), null);
});

test("a deeply nested tools/call is refused instead of killing the gate", async () => {
  const dir = newDir();
  const doc: Record<string, unknown> = {
    ...TEST_POLICY_DOC,
    downstream: { command: process.execPath, args: [FAKE_PATH], env: {} },
    payment_tools: { gate: ["create_payment"], mappings: { create_payment: { amount_field: "amount" } } },
    agent_pubkey: AGENT_PUBKEY
  };
  const policiesPath = join(dir, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(doc));
  const config = loadConfig(policiesPath, join(dir, "data"));
  const gate = new GateServer(new Bridge(config), "test", { clock: () => NOON_UTC, quiet: true });
  await gate.start();
  try {
    let nested: Record<string, unknown> = {};
    const args = nested;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      nested.a = next;
      nested = next;
    }
    const raw = await gate.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_payment", arguments: args } })
    );
    const reply = JSON.parse(raw!) as { error?: { code: number; message: string } };
    assert.equal(reply.error?.code, -32602);
    assert.match(reply.error!.message, /nested deeper/);
    // Still serving afterwards: the crash this replaces took the process down.
    const ping = JSON.parse((await gate.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })))!);
    assert.deepEqual(ping.result, {});
  } finally {
    gate.close();
  }
});

/* ------------------------------------------------------------------ */
/* Matching and path lookup                                            */
/* ------------------------------------------------------------------ */

test("a wildcard gate pattern cannot be dodged with a newline in the tool name", () => {
  assert.equal(matchesPattern("create_payment", "create_payment"), true);
  assert.equal(matchesPattern("create_payment", "create_payment\n"), false);
  assert.equal(matchesPattern("pay_*", "pay_refund"), true);
  assert.equal(matchesPattern("pay_*", "x_pay_refund"), false);
  // With ".*" as the wildcard this was false, so a downstream server
  // could name a money tool past a "pay_*" gate and still be called.
  assert.equal(matchesPattern("pay_*", "pay_a\nb"), true);
  assert.equal(matchesPattern("*", "anything\nat all"), true);
});

test("a downstream tool name with a control character is a startup error", async () => {
  const dir = newDir();
  const doc: Record<string, unknown> = {
    ...TEST_POLICY_DOC,
    downstream: {
      command: process.execPath,
      args: [MULTI_PATH],
      env: { FAKE_MULTI_NAME: "sneaky", FAKE_MULTI_TOOLS: "pay_a\nb" }
    },
    payment_tools: { gate: ["pay_*"], mappings: {} },
    agent_pubkey: AGENT_PUBKEY
  };
  const policiesPath = join(dir, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(doc));
  const config = loadConfig(policiesPath, join(dir, "data"));
  const gate = new GateServer(new Bridge(config), "test", { clock: () => NOON_UTC, quiet: true });
  await assert.rejects(gate.start(), /control character/);
  gate.close();
});

test("amount paths cannot walk the prototype chain", () => {
  assert.equal(getPath({}, "__proto__"), undefined);
  assert.equal(getPath({}, "constructor.name"), undefined);
  assert.equal(getPath(JSON.parse('{"__proto__":{"amount":"1"}}'), "__proto__.amount"), undefined);
  assert.equal(getPath({ payment: { total: "42" } }, "payment.total"), "42");
});

test("a polluted arguments object still fails closed on the amount", () => {
  const { config } = makeBridge({
    ...TEST_POLICY_DOC,
    payment_tools: { gate: ["pay"], mappings: { pay: { amount_field: "__proto__.amount" } } }
  });
  const result = extractPayment(config, "pay", JSON.parse('{"__proto__":{"amount":"1"}}'));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason_code, "bridge.pending.amount_unextractable");
});

/* ------------------------------------------------------------------ */
/* Identity pinning                                                    */
/* ------------------------------------------------------------------ */

test("agent_pubkey in the config file pins advisory-mode identity", async () => {
  const { bridge } = makeBridge({ ...TEST_POLICY_DOC, agent_pubkey: AGENT_PUBKEY });
  await assert.rejects(
    bridge.evaluate({
      amount_minor_units: "100",
      currency: "USD",
      counterparty: "cloudsmith.example",
      memo: "cap shopping",
      agent_pubkey: "c".repeat(64)
    }),
    /does not match the pinned identity/
  );
});

test("gate mode refuses an empty control set that would default to allow", () => {
  const dir = newDir();
  const path = join(dir, "policies.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...TEST_POLICY_DOC,
      controls: {},
      agent_pubkey: AGENT_PUBKEY,
      downstream: { command: process.execPath, args: [FAKE_PATH], env: {} }
    })
  );
  const bridge = new Bridge(loadConfig(path, join(dir, "data")));
  assert.throws(() => new GateServer(bridge, "test", { quiet: true }), /at least one spend control/);
});

/* ------------------------------------------------------------------ */
/* Approval ids and queue bounds                                       */
/* ------------------------------------------------------------------ */

test("approval ids carry 128 bits and still resolve legacy short ids", () => {
  const fingerprint = "sha256:" + "9f".repeat(32);
  const id = approvalIdForFingerprint(fingerprint);
  assert.equal(id.length, 32);
  assert.equal(legacyApprovalIdForFingerprint(fingerprint).length, 12);
  assert.ok(id.startsWith(legacyApprovalIdForFingerprint(fingerprint)));

  const dir = newDir();
  const store = new ApprovalStore(dir);
  const legacyId = legacyApprovalIdForFingerprint(fingerprint);
  writeFileSync(
    join(dir, "approvals.json"),
    JSON.stringify({
      [legacyId]: {
        approval_id: legacyId,
        fingerprint,
        agent_pubkey: AGENT_PUBKEY,
        amount_minor_units: "100",
        currency: "USD",
        counterparty: "cloudsmith.example",
        memo: "written by an older version",
        reason_code: "bridge.pending.ceiling",
        requested_at: NOON_UTC.toISOString(),
        status: "pending"
      }
    })
  );
  assert.equal(store.byFingerprint(fingerprint)?.approval_id, legacyId);
});

test("legacy short-id compatibility never merges a colliding fingerprint", () => {
  const original = "sha256:" + "a".repeat(12) + "b".repeat(52);
  const collision = "sha256:" + "a".repeat(12) + "c".repeat(52);
  const dir = newDir();
  const legacyId = legacyApprovalIdForFingerprint(original);
  writeFileSync(
    join(dir, "approvals.json"),
    JSON.stringify({
      [legacyId]: {
        approval_id: legacyId,
        fingerprint: original,
        agent_pubkey: AGENT_PUBKEY,
        amount_minor_units: "100",
        currency: "USD",
        counterparty: "cloudsmith.example",
        memo: "legacy approval",
        reason_code: "bridge.pending.ceiling",
        requested_at: NOON_UTC.toISOString(),
        status: "granted"
      }
    })
  );
  const store = new ApprovalStore(dir);
  assert.equal(store.byFingerprint(collision), undefined);
});

test("a durable execution claim has exactly one winner across store instances", () => {
  const dir = newDir();
  const store = new ApprovalStore(dir);
  const approval = store.createOrGet({
    fingerprint: "sha256:" + "7e".repeat(32),
    agent_pubkey: AGENT_PUBKEY,
    amount_minor_units: "5000",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "memo-must-not-leak",
    reason_code: "bridge.pending.ceiling",
    call: { tool_name: "create_payment", arguments: { amount: "5000" } }
  });
  store.decide(approval.approval_id, "granted", "tester", undefined, NOON_UTC);

  const first = store.claimExecution(approval.approval_id, NOON_UTC);
  const afterRestart = new ApprovalStore(dir).claimExecution(approval.approval_id, NOON_UTC);
  assert.equal(first.claimed, true);
  assert.equal(first.approval.execution_status, "in_progress");
  assert.equal(afterRestart.claimed, false);
  assert.equal(afterRestart.approval.execution_status, "in_progress");
});

test("a corrupt approval store fails closed instead of becoming an empty queue", () => {
  const dir = newDir();
  writeFileSync(join(dir, "approvals.json"), "{not-json");
  assert.throws(
    () => new ApprovalStore(dir).pending(),
    /Refusing to forget approval state/
  );
});

test("approval and ledger files are owner-readable only", () => {
  if (process.platform === "win32") return;
  const dir = newDir();
  const store = new ApprovalStore(dir);
  store.createOrGet({
    fingerprint: "sha256:" + "8e".repeat(32),
    agent_pubkey: AGENT_PUBKEY,
    amount_minor_units: "100",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "private",
    reason_code: "bridge.pending.ceiling"
  });
  const ledgerPath = join(dir, "ledger.jsonl");
  new Ledger(ledgerPath).append({
    type: "decision",
    actor: AGENT_PUBKEY,
    agent_pubkey: AGENT_PUBKEY,
    decision: "deny",
    reason_code: "test",
    amount_minor_units: "100",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "private",
    fingerprint: "sha256:" + "8e".repeat(32)
  });
  assert.equal(statSync(store.filePath).mode & 0o777, 0o600);
  assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);
});

test("ledger corruption blocks reopening and future appends", () => {
  const path = join(newDir(), "ledger.jsonl");
  const ledger = new Ledger(path);
  ledger.append({
    type: "decision",
    actor: AGENT_PUBKEY,
    agent_pubkey: AGENT_PUBKEY,
    decision: "allow",
    reason_code: "test",
    amount_minor_units: "100",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "original",
    fingerprint: "sha256:" + "9e".repeat(32)
  });
  writeFileSync(path, readFileSync(path, "utf8").replace("original", "tampered"));
  assert.throws(() => new Ledger(path), /ledger integrity check failed/);
});

test("the pending queue has a ceiling and refuses past it", () => {
  const store = new ApprovalStore(newDir());
  const park = (n: number): void => {
    store.createOrGet(
      {
        fingerprint: "sha256:" + String(n).padEnd(64, "0"),
        agent_pubkey: AGENT_PUBKEY,
        amount_minor_units: "100",
        currency: "USD",
        counterparty: "cloudsmith.example",
        memo: `park ${n}`,
        reason_code: "bridge.pending.ceiling"
      },
      NOON_UTC,
      3
    );
  };
  park(1);
  park(2);
  park(3);
  assert.throws(() => park(4), ApprovalQueueFullError);
  // A repeat of an already parked intent is not new queue growth.
  assert.doesNotThrow(() => park(2));
  assert.equal(store.pending().length, 3);
});

test("the gate refuses a gated call when the approval queue is full", async () => {
  const dir = newDir();
  const doc: Record<string, unknown> = {
    ...TEST_POLICY_DOC,
    approval_ttl_seconds: 3600,
    max_pending_approvals: 1,
    downstream: { command: process.execPath, args: [FAKE_PATH], env: {} },
    payment_tools: {
      gate: ["create_payment"],
      mappings: { create_payment: { amount_field: "amount", currency_field: "currency", counterparty_field: "destination" } }
    },
    agent_pubkey: AGENT_PUBKEY
  };
  const policiesPath = join(dir, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(doc));
  const config = loadConfig(policiesPath, join(dir, "data"));
  const bridge = new Bridge(config);
  const gate = new GateServer(bridge, "test", { clock: () => NOON_UTC, quiet: true });
  await gate.start();
  try {
    const call = (amount: string): string =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_payment",
          arguments: { amount, currency: "USD", destination: "cloudsmith.example" }
        }
      });
    // Over the ceiling control, so both calls want a human.
    const first = JSON.parse((await gate.handleMessage(call("9000000")))!);
    assert.match(first.result.content[0].text, /pending_approval/);
    const second = JSON.parse((await gate.handleMessage(call("9000001")))!);
    const payload = JSON.parse(second.result.content[0].text) as Record<string, unknown>;
    assert.equal(payload.reason_code, "bridge.deny.approval_queue_full");
    assert.equal(payload.executed, false);
    const ledger = readFileSync(join(dir, "data", "ledger.jsonl"), "utf8");
    assert.ok(ledger.includes("bridge.deny.approval_queue_full"));
    assert.equal(verifyLedger(join(dir, "data", "ledger.jsonl")).ok, true);
  } finally {
    gate.close();
  }
});

/* ------------------------------------------------------------------ */
/* Config hardening                                                    */
/* ------------------------------------------------------------------ */

test("webhook_url must be http or https", () => {
  const dir = newDir();
  const path = join(dir, "policies.json");
  writeFileSync(path, JSON.stringify({ ...TEST_POLICY_DOC, webhook_url: "file:///etc/passwd" }));
  assert.throws(() => loadConfig(path, join(dir, "data")), /webhook_url must be http/);
  writeFileSync(path, JSON.stringify({ ...TEST_POLICY_DOC, webhook_url: "https://hooks.example/x" }));
  assert.equal(loadConfig(path, join(dir, "data")).webhook_url, "https://hooks.example/x");
});

test("webhook notifications omit parked arguments and downstream results", () => {
  const payload = approvalWebhookPayload({
    approval_id: "a".repeat(32),
    fingerprint: "sha256:" + "aa".repeat(32),
    agent_pubkey: AGENT_PUBKEY,
    amount_minor_units: "100",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "invoice",
    reason_code: "bridge.pending.ceiling",
    requested_at: NOON_UTC.toISOString(),
    status: "granted",
    call: {
      tool_name: "create_payment",
      arguments: { api_key: "must-not-leak", customer_secret: "also-private" }
    },
    execution_status: "executed",
    execution_result: { provider_token: "must-not-leak-either" }
  });
  const serialized = JSON.stringify(payload);
  assert.equal(payload.tool_name, "create_payment");
  assert.doesNotMatch(serialized, /must-not-leak|also-private/);
  assert.equal(Object.hasOwn(payload, "memo"), false);
  assert.equal(Object.hasOwn(payload, "execution_result"), false);
});

test("env_passthrough controls what a downstream child inherits", () => {
  process.env.BUZZ_AXIRU_TEST_SECRET = "top-secret";
  try {
    const spec = { command: "x", args: [], env: { OWN: "1" }, request_timeout_ms: 1000 };
    assert.equal(childEnv({ ...spec, env_passthrough: "all" }).BUZZ_AXIRU_TEST_SECRET, "top-secret");
    assert.equal(childEnv(spec).BUZZ_AXIRU_TEST_SECRET, undefined, "secure default is no passthrough");
    const none = childEnv({ ...spec, env_passthrough: "none" });
    assert.equal(none.BUZZ_AXIRU_TEST_SECRET, undefined);
    assert.equal(none.OWN, "1");
    const listed = childEnv({ ...spec, env_passthrough: ["BUZZ_AXIRU_TEST_SECRET"] });
    assert.equal(listed.BUZZ_AXIRU_TEST_SECRET, "top-secret");
    assert.equal(listed.PATH, undefined);
  } finally {
    delete process.env.BUZZ_AXIRU_TEST_SECRET;
  }
});
