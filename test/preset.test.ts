/**
 * secure-stripe preset: generated-config validity (the file must load
 * through loadConfig), the pinned Stripe downstream entry, gate and
 * mapping coverage inside the pay_ namespace, refund counterparty
 * extraction, the stripe-rail policy pack, and the CLI flow including
 * --check failing closed when STRIPE_SECRET_KEY is absent.
 *
 * Tool names and argument fields asserted here are grounded in the
 * @stripe/mcp@0.2.5 --tools=all catalog (served via
 * @stripe/agent-toolkit): create_refund(payment_intent, amount?),
 * create_payment_link(price, quantity), list_customers(limit?).
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractPayment,
  isGatedTool,
  loadConfig,
  matchesPattern
} from "../src/config.js";
import { buildSecureStripePolicies, STRIPE_MCP_VERSION } from "../src/quickstart.js";
import { AGENT_PUBKEY, makeBridge, seedAllow } from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FAKE_STRIPE_PATH = fileURLToPath(new URL("./fake-stripe.js", import.meta.url));

/** Tuesday 12:00 EDT: inside the preset's America/New_York 9-17 window. */
const BUSINESS_NOON_ET = new Date("2026-07-21T16:00:00Z");
const HOUR = 60 * 60 * 1000;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "buzz-axiru-preset-"));
}

function loadPreset(): ReturnType<typeof loadConfig> {
  const dir = tempDir();
  const path = join(dir, "policies.json");
  writeFileSync(path, buildSecureStripePolicies(AGENT_PUBKEY), "utf8");
  return loadConfig(path, join(dir, "data"));
}

test("secure-stripe preset config is credential-free, pinned, and loads through loadConfig", () => {
  const content = buildSecureStripePolicies(AGENT_PUBKEY);
  assert.doesNotMatch(content, /sk_(?:test|live)_/);
  assert.doesNotMatch(content, /PIN_REVIEWED_VERSION/);

  const config = loadPreset();
  assert.equal(config.rail, "stripe");
  assert.equal(config.currency, "USD");
  assert.equal(config.agent_pubkey, AGENT_PUBKEY);
  assert.ok(config.downstream !== null);
  assert.equal(config.downstream.length, 1, "one downstream server: Stripe's MCP");
  const stripe = config.downstream[0]!;
  assert.equal(stripe.name, "stripe");
  assert.equal(stripe.command, "npx");
  assert.deepEqual(stripe.args, ["-y", `@stripe/mcp@${STRIPE_MCP_VERSION}`, "--tools=all"]);
  assert.equal(stripe.tool_prefix, "pay_");
  assert.equal(Object.keys(stripe.env).length, 0, "no inline credentials, ever");
  assert.deepEqual(stripe.env_passthrough, ["PATH", "HOME", "TMPDIR", "STRIPE_SECRET_KEY"]);
  // The version pin is load-bearing: 0.3.x moves to a hosted proxy.
  assert.equal(STRIPE_MCP_VERSION, "0.2.5");
});

test("secure-stripe gate patterns and mappings stay inside the pay_ namespace", () => {
  const config = loadPreset();
  assert.ok(config.payment_tools !== null);
  assert.ok(config.payment_tools.gate.length > 0);
  for (const pattern of config.payment_tools.gate) {
    assert.ok(pattern.startsWith("pay_"), `gate pattern ${pattern} must carry the pay_ prefix`);
  }
  for (const mapped of Object.keys(config.payment_tools.mappings)) {
    assert.ok(mapped.startsWith("pay_"), `mapping ${mapped} must carry the pay_ prefix`);
    assert.ok(
      config.payment_tools.gate.some((pattern) => matchesPattern(pattern, mapped)),
      `mapping ${mapped} must target a gated tool`
    );
  }
  // Money verbs gated; read-only and unprefixed names are not.
  assert.equal(isGatedTool(config, "pay_create_refund"), true);
  assert.equal(isGatedTool(config, "pay_create_payment_link"), true);
  assert.equal(isGatedTool(config, "pay_cancel_subscription"), true);
  assert.equal(isGatedTool(config, "pay_list_customers"), false);
  assert.equal(isGatedTool(config, "pay_retrieve_balance"), false);
  assert.equal(isGatedTool(config, "create_refund"), false, "gate matches EXPOSED names only");
});

test("refunds report the refunded PaymentIntent as counterparty and full refunds fail closed", () => {
  const config = loadPreset();
  const partial = extractPayment(config, "pay_create_refund", {
    payment_intent: "pi_3ReplaceWithRealPaymentIntent",
    amount: 2000
  });
  assert.ok(partial.ok);
  assert.equal(partial.amount_minor_units, "2000");
  assert.equal(partial.currency, "USD");
  assert.equal(partial.counterparty, "pi_3ReplaceWithRealPaymentIntent");
  // create_refund's amount is optional: a full refund omits it, and the
  // gate must fail closed to a human rather than guess the amount.
  const full = extractPayment(config, "pay_create_refund", {
    payment_intent: "pi_3ReplaceWithRealPaymentIntent"
  });
  assert.equal(full.ok, false);
  assert.equal((full as { reason_code: string }).reason_code, "bridge.pending.amount_unextractable");
});

test("the stripe rail policy pack allows an allowlisted refund and denies an unlisted one", async () => {
  const doc = JSON.parse(buildSecureStripePolicies(AGENT_PUBKEY)) as Record<string, unknown>;
  // Advisory-mode bridge: policy evaluation without spawning npx.
  doc.downstream = null;
  const { bridge } = makeBridge(doc);
  seedAllow(bridge, "10000", new Date(BUSINESS_NOON_ET.getTime() - HOUR));
  const allowed = await bridge.evaluate(
    {
      amount_minor_units: "2000",
      currency: "USD",
      counterparty: "pi_3ReplaceWithRealPaymentIntent",
      memo: "partial refund",
      agent_pubkey: AGENT_PUBKEY
    },
    BUSINESS_NOON_ET
  );
  assert.equal(allowed.decision, "allow");
  const denied = await bridge.evaluate(
    {
      amount_minor_units: "2000",
      currency: "USD",
      counterparty: "pi_9NotOnTheAllowlist",
      memo: "partial refund",
      agent_pubkey: AGENT_PUBKEY
    },
    BUSINESS_NOON_ET
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason_code, "guardrails.deny.counterparty_not_allowlisted");
});

test("quickstart --preset secure-stripe writes the config and --check fails closed without a key", () => {
  const dir = tempDir();
  const path = join(dir, "policies.json");
  const written = spawnSync(
    process.execPath,
    [CLI_PATH, "quickstart", "--preset", "secure-stripe", "--path", path, "--agent-pubkey", AGENT_PUBKEY],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(written.status, 0, String(written.stderr));
  assert.match(String(written.stdout), /preset: secure-stripe/);
  assert.match(String(written.stdout), new RegExp(`@stripe/mcp@${STRIPE_MCP_VERSION}`));
  assert.match(String(written.stdout), /fails closed/);
  assert.ok(existsSync(path));

  // Swap the pinned npx command for the scripted fake (same tool names,
  // same keyless exit) so the fail-closed path runs without the network.
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    downstream: Array<{ command: string; args: string[] }>;
  };
  doc.downstream[0]!.command = process.execPath;
  doc.downstream[0]!.args = [FAKE_STRIPE_PATH];
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");

  const keyless = { ...process.env };
  delete keyless.STRIPE_SECRET_KEY;
  // The config file's pubkey must be the identity under test, not one
  // inherited from the host environment.
  delete keyless.BUZZ_AXIRU_AGENT_PUBKEY;
  const failed = spawnSync(
    process.execPath,
    [CLI_PATH, "quickstart", "--check", "--policies", path, "--data-dir", join(dir, "data")],
    { cwd: dir, encoding: "utf8", env: keyless }
  );
  assert.equal(failed.status, 1, "no key must fail closed");
  assert.match(String(failed.stdout), /FAILED: .*failed to start, refusing to run degraded/);
  assert.match(String(failed.stdout), /stripe/);

  const ready = spawnSync(
    process.execPath,
    [CLI_PATH, "quickstart", "--check", "--policies", path, "--data-dir", join(dir, "data")],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...keyless, STRIPE_SECRET_KEY: "sk_test_placeholder" }
    }
  );
  assert.equal(ready.status, 0, String(ready.stdout) + String(ready.stderr));
  assert.match(String(ready.stdout), /READY: start the enforcing gate/);
  assert.match(String(ready.stdout), /3 tools exposed, 2 gated/);
  assert.match(String(ready.stdout), /pay_create_refund/);
});

test("unknown presets are refused and the preset-free quickstart is unchanged", () => {
  const dir = tempDir();
  const unknown = spawnSync(
    process.execPath,
    [CLI_PATH, "quickstart", "--preset", "stripe"],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(unknown.status, 1);
  assert.match(String(unknown.stderr), /unknown --preset "stripe" \(use secure-stripe\)/);
  assert.ok(!existsSync(join(dir, "policies.json")), "nothing written on a refused preset");

  const plain = spawnSync(process.execPath, [CLI_PATH, "quickstart", "--harness", "goose"], {
    cwd: dir,
    encoding: "utf8"
  });
  assert.equal(plain.status, 0, String(plain.stderr));
  const content = readFileSync(join(dir, "policies.json"), "utf8");
  assert.match(content, /\$downstream_payment_slot/, "harness quickstart output is unchanged");
  assert.match(content, /PIN_REVIEWED_VERSION/);
});
