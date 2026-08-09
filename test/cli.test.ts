/**
 * CLI smoke tests for entry points that must work before a config exists.
 * These caught the historical parser bug where --help and --version were
 * recorded as flags but then handled only as positional commands.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApprovalStore, gatedCallFingerprint } from "../src/approvals.js";
import { Ledger, verifyLedger } from "../src/ledger.js";
import { AGENT_PUBKEY, NOON_UTC, TEST_POLICY_DOC } from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FAKE_PATH = fileURLToPath(new URL("./fake-downstream.js", import.meta.url));

function run(...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "buzz-axiru-cli-")),
    encoding: "utf8"
  });
}

test("--help works without policies.json", () => {
  const result = run("--help");
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /Usage:/);
  assert.match(String(result.stdout), /buzz-axiru doctor/);
  assert.equal(result.stderr, "");
});

test("--version and command-form help work without policies.json", () => {
  const version = run("--version");
  assert.equal(version.status, 0, String(version.stderr));
  assert.match(String(version.stdout), /^buzz-axiru \d+\.\d+\.\d+\n$/);

  const help = run("help");
  assert.equal(help.status, 0, String(help.stderr));
  assert.match(String(help.stdout), /security-readiness/);
});

test("unknown-amount approvals require inspection acknowledgement", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-cli-approval-"));
  const policies = join(dir, "policies.json");
  const dataDir = join(dir, "data");
  writeFileSync(policies, JSON.stringify(TEST_POLICY_DOC));
  const store = new ApprovalStore(dataDir);
  const parkedArgs = { opaque: "provider-specific" };
  const approval = store.createOrGet(
    {
      fingerprint: gatedCallFingerprint("opaque_payment", parkedArgs, AGENT_PUBKEY),
      agent_pubkey: AGENT_PUBKEY,
      amount_minor_units: "unknown",
      currency: "USD",
      counterparty: "tool:opaque_payment",
      memo: "amount could not be extracted",
      reason_code: "bridge.pending.amount_unextractable",
      call: { tool_name: "opaque_payment", arguments: parkedArgs }
    },
    NOON_UTC
  );

  const refused = spawnSync(
    process.execPath,
    [CLI_PATH, "approve", approval.approval_id, "--policies", policies, "--data-dir", dataDir],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(refused.status, 1);
  assert.match(String(refused.stderr), /--ack-unknown-amount/);
  assert.equal(new ApprovalStore(dataDir).get(approval.approval_id)?.status, "pending");

  const acknowledged = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "approve",
      approval.approval_id,
      "--policies",
      policies,
      "--data-dir",
      dataDir,
      "--ack-unknown-amount",
      "--by",
      "security-reviewer"
    ],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  assert.equal(new ApprovalStore(dataDir).get(approval.approval_id)?.status, "granted");
});

test("an in-progress approval has an auditable reconciliation path", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-cli-reconcile-"));
  const policies = join(dir, "policies.json");
  const dataDir = join(dir, "data");
  writeFileSync(policies, JSON.stringify(TEST_POLICY_DOC));
  const store = new ApprovalStore(dataDir);
  const parkedArgs = { amount: "5000" };
  const approval = store.createOrGet(
    {
      fingerprint: gatedCallFingerprint("create_payment", parkedArgs, AGENT_PUBKEY),
      agent_pubkey: AGENT_PUBKEY,
      amount_minor_units: "5000",
      currency: "USD",
      counterparty: "cloudsmith.example",
      memo: "provider status checked",
      reason_code: "bridge.pending.ceiling",
      call: { tool_name: "create_payment", arguments: parkedArgs }
    },
    NOON_UTC
  );
  store.decide(approval.approval_id, "granted", "approver", undefined, NOON_UTC);
  store.claimExecution(approval.approval_id, NOON_UTC);

  const missingEvidence = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "reconcile",
      approval.approval_id,
      "--outcome",
      "failed",
      "--policies",
      policies,
      "--data-dir",
      dataDir
    ],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(missingEvidence.status, 1);
  assert.match(String(missingEvidence.stderr), /--note is required/);

  const reconciled = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      "reconcile",
      approval.approval_id,
      "--outcome",
      "failed",
      "--note",
      "Provider search confirms no transfer",
      "--by",
      "ops-reviewer",
      "--policies",
      policies,
      "--data-dir",
      dataDir
    ],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(reconciled.status, 0, String(reconciled.stderr));
  assert.equal(new ApprovalStore(dataDir).get(approval.approval_id)?.execution_status, "failed");
  assert.equal(verifyLedger(join(dataDir, "ledger.jsonl")).ok, true);
});

test("doctor distinguishes a ready gate from a matcher that protects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-cli-doctor-"));
  const policies = join(dir, "policies.json");
  const base = {
    ...TEST_POLICY_DOC,
    agent_pubkey: AGENT_PUBKEY,
    downstream: {
      command: process.execPath,
      args: [FAKE_PATH],
      env: {},
      env_passthrough: "none"
    },
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
  };
  writeFileSync(policies, JSON.stringify(base));
  const ready = spawnSync(process.execPath, [CLI_PATH, "doctor", "--policies", policies], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(ready.status, 0, String(ready.stderr));
  assert.match(String(ready.stdout), /READY: start the enforcing gate/);
  assert.match(String(ready.stdout), /3 tools exposed, 1 gated: create_payment/);

  writeFileSync(
    policies,
    JSON.stringify({ ...base, payment_tools: { gate: ["missing_*"], mappings: {} } })
  );
  const unsafe = spawnSync(process.execPath, [CLI_PATH, "doctor", "--policies", policies], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(unsafe.status, 1);
  assert.match(String(unsafe.stdout), /NOT READY.*Nothing is currently protected/s);
});

test("verify exits 1 and names the sequence for an out-of-band forgery", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-cli-verify-"));
  const policies = join(dir, "policies.json");
  writeFileSync(policies, JSON.stringify(TEST_POLICY_DOC));
  const ledgerPath = join(dir, "data", "ledger.jsonl");
  const ledger = new Ledger(ledgerPath);
  for (const memo of ["one", "two", "three"]) {
    ledger.append({
      type: "decision",
      actor: AGENT_PUBKEY,
      agent_pubkey: AGENT_PUBKEY,
      decision: "allow",
      reason_code: "guardrails.allow.default",
      amount_minor_units: "200",
      currency: "USD",
      counterparty: "cloudsmith.example",
      memo,
      fingerprint: "sha256:" + "4b".repeat(32)
    });
  }
  // Same-size in-place forgery of record 2: invisible to a running
  // instance's checkpoint, and exactly what the CLI full pass is for.
  // Forge a copy so the bridge's own ledger (which every CLI command
  // opens, and which refuses to open corrupted) stays clean.
  const forgedPath = ledgerPath + ".forged";
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  lines[1] = lines[1]!.replace('"amount_minor_units":"200"', '"amount_minor_units":"999"');
  writeFileSync(forgedPath, lines.join("\n") + "\n");

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, "verify", "--policies", policies, "--ledger", forgedPath],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(String(result.stdout)) as { ok: boolean; bad_seq?: number };
  assert.equal(report.ok, false);
  assert.equal(report.bad_seq, 2);
});
