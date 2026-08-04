/**
 * Shared test fixtures. Licensed under the Apache License, Version 2.0.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type BridgeConfig } from "../src/config.js";
import { Bridge } from "../src/guard.js";

export const AGENT_PUBKEY =
  "b7a1c3d9e5f2064788a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f";

/** Noon UTC, inside the 9-17 UTC business-hours window used in tests. */
export const NOON_UTC = new Date("2026-07-21T12:00:00Z");

export const TEST_POLICY_DOC = {
  rail: "x402",
  currency: "USD",
  controls: {
    per_agent_daily_cap: { cap_minor_units: "10000000" },
    single_payment_ceiling: { threshold_minor_units: "2500000", approver_group: "operators" },
    counterparty_allowlist: {
      allowed_ids: ["acme-datacenter.example", "cloudsmith.example", "openrouter.example"]
    },
    business_hours: { tz: "UTC", open_hour: 9, close_hour: 17, effect: "require_approval" }
  },
  buzz: { channel_id: null, cli_path: "buzz" },
  webhook_url: null,
  data_dir: "data",
  // Advisory tests pin the clock to NOON_UTC while decide() runs on
  // the real clock; disable expiry so those tests stay about policy.
  approval_ttl_seconds: null
};

export interface TestContext {
  dir: string;
  policiesPath: string;
  config: BridgeConfig;
  bridge: Bridge;
}

export function makeBridge(policyDoc: object = TEST_POLICY_DOC): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-test-"));
  const policiesPath = join(dir, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(policyDoc, null, 2));
  const config = loadConfig(policiesPath, join(dir, "data"));
  const bridge = new Bridge(config);
  return { dir, policiesPath, config, bridge };
}

/** Seed one authorized (allow) spend so rolling-window history is non-zero. */
export function seedAllow(
  bridge: Bridge,
  amountMinorUnits: string,
  ts: Date,
  agentPubkey: string = AGENT_PUBKEY
): void {
  bridge.ledger.append({
    type: "decision",
    actor: agentPubkey,
    agent_pubkey: agentPubkey,
    decision: "allow",
    reason_code: "guardrails.allow.default",
    amount_minor_units: amountMinorUnits,
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: "seed spend",
    fingerprint: "sha256:" + "ab".repeat(32),
    ts: ts.toISOString()
  });
}
