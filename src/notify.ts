/**
 * Channel notification adapter.
 *
 * VERIFIED (block/buzz, crates/buzz-cli/README.md): messages are
 * posted to a channel programmatically with
 *
 *     buzz messages send --channel <uuid> --content "<text>"
 *
 * with the sender's identity taken from BUZZ_PRIVATE_KEY (nsec) and
 * the relay from BUZZ_RELAY_URL. On the wire this lands as a kind 9
 * stream message (NIP-29 style group chat event) signed by the
 * bridge's own keypair. Mint the bridge its own keypair with
 * buzz-admin; do not reuse an agent's key.
 *
 * ASSUMPTION: rendering an @mention of a human approver requires a
 * "p" tag on the event; the buzz CLI does not document a mention flag,
 * so the bridge posts plain text and does not tag approvers.
 *
 * If no channel is configured, the adapter falls back to an optional
 * webhook (plain JSON POST), and always logs to stderr. Failures are
 * logged, never thrown: notification is best-effort, the decision and
 * the ledger record already happened.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { execFile } from "node:child_process";

import type { BridgeConfig } from "./config.js";
import type { ApprovalRequest } from "./approvals.js";

const CURRENCY_EXPONENT: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  USDC: 6,
  PYUSD: 6
};

/** "4000000" USD minor units -> "USD 40,000.00". */
export function formatAmount(minorUnits: string, currency: string): string {
  if (!/^[0-9]+$/.test(minorUnits)) {
    // Gate mode parks calls whose amount could not be extracted; show
    // the placeholder rather than formatting garbage.
    return `${currency.toUpperCase()} ${minorUnits}`;
  }
  const exponent = CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
  const digits = minorUnits.padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const frac = exponent > 0 ? "." + digits.slice(digits.length - exponent) : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency.toUpperCase()} ${grouped}${frac}`;
}

export function approvalRequestText(approval: ApprovalRequest): string {
  return [
    "[buzz-axiru] Spend approval needed",
    `  agent:        ${approval.agent_pubkey}`,
    `  amount:       ${formatAmount(approval.amount_minor_units, approval.currency)} (${approval.amount_minor_units} minor units)`,
    `  counterparty: ${approval.counterparty}`,
    `  memo:         ${approval.memo}`,
    `  reason:       ${approval.reason_code}`,
    `  approval id:  ${approval.approval_id}`,
    "",
    `To decide: buzz-axiru approve ${approval.approval_id}   or   buzz-axiru deny ${approval.approval_id}`
  ].join("\n");
}

export function approvalOutcomeText(approval: ApprovalRequest): string {
  const verb =
    approval.status === "granted"
      ? "APPROVED"
      : approval.status === "expired"
        ? "EXPIRED (never executed)"
        : "DENIED";
  return [
    `[buzz-axiru] Spend ${verb}`,
    `  approval id:  ${approval.approval_id}`,
    `  agent:        ${approval.agent_pubkey}`,
    `  amount:       ${formatAmount(approval.amount_minor_units, approval.currency)}`,
    `  counterparty: ${approval.counterparty}`,
    ...(approval.status !== "expired" ? [`  decided by:   ${approval.decided_by ?? "unknown"}`] : []),
    ...(approval.call !== undefined ? [`  gated tool:   ${approval.call.tool_name}`] : []),
    ...(approval.execution_status !== undefined
      ? [`  execution:    ${approval.execution_status}`]
      : []),
    ...(approval.note ? [`  note:         ${approval.note}`] : [])
  ].join("\n");
}

function postToBuzzChannel(config: BridgeConfig, text: string): Promise<void> {
  return new Promise((resolvePromise) => {
    if (!config.buzz.channel_id) return resolvePromise();
    execFile(
      config.buzz.cli_path,
      ["messages", "send", "--channel", config.buzz.channel_id, "--content", text],
      { timeout: 15_000 },
      (error, _stdout, stderr) => {
        if (error) {
          process.stderr.write(
            `buzz-axiru: channel post failed (${error.message}); stderr: ${stderr}\n`
          );
        }
        resolvePromise();
      }
    );
  });
}

async function postWebhook(config: BridgeConfig, payload: unknown): Promise<void> {
  if (!config.webhook_url) return;
  try {
    const response = await fetch(config.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      process.stderr.write(`buzz-axiru: webhook returned HTTP ${response.status}\n`);
    }
  } catch (err) {
    process.stderr.write(`buzz-axiru: webhook failed (${(err as Error).message})\n`);
  }
}

function logLocal(text: string): void {
  // BUZZ_AXIRU_QUIET=1 suppresses the local stderr copy (the demo
  // script prints its own framed version of the channel post).
  if (process.env.BUZZ_AXIRU_QUIET === "1") return;
  process.stderr.write(text + "\n");
}

/** Announce a new approval request. Best-effort; never throws. */
export async function notifyApprovalRequested(
  config: BridgeConfig,
  approval: ApprovalRequest
): Promise<void> {
  const text = approvalRequestText(approval);
  logLocal(text);
  await Promise.all([
    postToBuzzChannel(config, text),
    postWebhook(config, { type: "spend_approval_requested", approval })
  ]);
}

/** Announce a human decision. Best-effort; never throws. */
export async function notifyApprovalDecided(
  config: BridgeConfig,
  approval: ApprovalRequest
): Promise<void> {
  const text = approvalOutcomeText(approval);
  logLocal(text);
  await Promise.all([
    postToBuzzChannel(config, text),
    postWebhook(config, { type: "spend_approval_decided", approval })
  ]);
}
