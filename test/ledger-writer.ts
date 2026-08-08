/**
 * Helper process for the concurrent-writer test: appends N ledger
 * records to a shared file, from its own process, so the test exercises
 * the cross-process lock rather than in-process sequencing.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { Ledger } from "../src/ledger.js";

const [, , filePath, tag, countRaw] = process.argv;
const ledger = new Ledger(filePath!);
const count = Number(countRaw ?? "100");

for (let i = 0; i < count; i++) {
  ledger.append({
    type: "decision",
    actor: "writer",
    agent_pubkey: "b7a1c3d9e5f2064788a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f",
    decision: "allow",
    reason_code: "guardrails.allow.default",
    amount_minor_units: "100",
    currency: "USD",
    counterparty: "cloudsmith.example",
    memo: `${tag}-${i}`,
    fingerprint: "sha256:" + "ab".repeat(32)
  });
}
