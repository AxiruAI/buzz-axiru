/**
 * `buzz-axiru quickstart`: generate a secure starter configuration and
 * concrete harness wiring from `npm install -g buzz-axiru`.
 *
 * The manual path (read the README, hand-edit policies.json, export an
 * env var) loses people before the gate ever runs. quickstart collapses
 * it: detect the harness's shell MCP server, write a working config
 * around it, and print the exact wiring steps for the harness in use.
 * It is non-interactive by design: every choice has a flag, so the
 * command behaves identically in a terminal, a script, and a CI job,
 * and its output is plain ASCII so it screenshots cleanly anywhere.
 *
 * This module holds the testable pieces (detection, config generation,
 * per-harness snippets); flag handling and printing live in cli.ts
 * next to the other commands.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

import { STARTER_POLICIES } from "./scaffold.js";

export const HARNESSES = ["buzz", "goose", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const PRESETS = ["secure-stripe"] as const;
export type Preset = (typeof PRESETS)[number];

/**
 * The exact @stripe/mcp version the secure-stripe preset pins.
 * Field-verified to run the full local toolset (--tools=all) under the
 * gate. Newer 0.3.x releases are a thin proxy to Stripe's hosted MCP
 * endpoint (mcp.stripe.com), where tool scoping moves to restricted
 * API keys instead of a local --tools flag; re-verify before bumping.
 */
export const STRIPE_MCP_VERSION = "0.2.5";

export interface DetectedShell {
  /** The command to write into the downstream config. */
  command: string;
  /** Where it was found, so quickstart can report what it detected. */
  source: string;
}

/** macOS install location of the Buzz app's bundled shell MCP server. */
const BUZZ_APP_BINARY = "/Applications/Buzz.app/Contents/MacOS/buzz-dev-mcp";

/**
 * Locate buzz-dev-mcp: BUZZ_ACP_MCP_COMMAND first (that is where a Buzz
 * user's current shell server lives), then PATH, then the macOS app
 * bundle. env and platform are injectable so tests can exercise every
 * branch without a real Buzz install.
 *
 * If BUZZ_ACP_MCP_COMMAND already points at buzz-axiru (a re-run after
 * an earlier quickstart), that value is skipped: the gate must never be
 * configured as its own downstream, which would recurse on startup.
 */
export function detectBuzzDevMcp(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): DetectedShell | null {
  const fromEnv = env.BUZZ_ACP_MCP_COMMAND?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && basename(fromEnv) !== "buzz-axiru") {
    return { command: fromEnv, source: "BUZZ_ACP_MCP_COMMAND" };
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "buzz-dev-mcp");
    if (existsSync(candidate)) {
      return { command: "buzz-dev-mcp", source: `PATH (${candidate})` };
    }
  }
  if (platform === "darwin" && existsSync(BUZZ_APP_BINARY)) {
    return { command: BUZZ_APP_BINARY, source: "Buzz.app application bundle" };
  }
  return null;
}

/**
 * Build the quickstart policies.json as a string. Controls, the
 * payment_tools matcher, and the prose style are lifted straight out
 * of STARTER_POLICIES (the `init` scaffold) so the two commands cannot
 * drift; quickstart only decides the downstream wiring.
 *
 * With a detected shell server the file is a working multi-downstream
 * gate config: the shell entry exposed with no prefix, a disabled
 * payment slot parked under a $-key to move into the array later, and
 * pay_* as the only gated pattern so shell tools pass through. Without
 * one, downstream is null and the file loads in advisory mode.
 */
export function buildQuickstartPolicies(
  shell: DetectedShell | null,
  agentPubkey: string | null = null
): string {
  const starter = JSON.parse(STARTER_POLICIES) as Record<string, unknown>;
  const doc: Record<string, unknown> = {
    $comment:
      "buzz-axiru config written by `buzz-axiru quickstart`. Amounts are integer " +
      "strings in minor units (cents for USD). Keys starting with $ are ignored " +
      "by the loader. Edit and restart the gate.",
    rail: starter["rail"],
    currency: starter["currency"],
    controls: starter["controls"],
    downstream:
      shell === null
        ? null
        : [
            {
              $comment:
                `Your harness's shell MCP server, found via ${shell.source}. ` +
                "Exposed with no tool_prefix so its tools keep their plain names.",
              name: "shell",
              command: shell.command,
              args: [],
              env: {},
              env_passthrough: ["PATH", "HOME", "TMPDIR"],
              request_timeout_ms: 30000,
              hide_tools: []
            }
          ],
    ...(shell === null
      ? {
          $downstream_hint:
            "downstream is null, so this config runs in advisory mode and nothing " +
            "is enforced. To turn on the enforcing gate, set downstream to an array " +
            "of MCP server blocks; $downstream_payment_slot below is a ready-made " +
            "entry for a payment server."
        }
      : {}),
    $downstream_payment_slot: {
      $comment:
        "A second downstream slot for your payment MCP server, disabled here " +
        "because keys starting with $ are ignored. Move this object into the " +
        "downstream array to put your payment server behind the same gate. The " +
        "pay_ tool_prefix keeps shell tool names unchanged and is what lets " +
        "payment_tools.gate target money tools only. Replace PIN_REVIEWED_VERSION " +
        "with an exact downstream package version you have reviewed.",
      name: "payments",
      command: "npx",
      args: ["-y", "@stripe/mcp@PIN_REVIEWED_VERSION", "--tools=all"],
      env: {},
      env_passthrough: ["PATH", "HOME", "TMPDIR", "STRIPE_SECRET_KEY"],
      tool_prefix: "pay_",
      request_timeout_ms: 30000,
      hide_tools: []
    },
    payment_tools: starter["$payment_tools_example"],
    approval_ttl_seconds: starter["approval_ttl_seconds"],
    $approval_ttl_comment: starter["$approval_ttl_comment"],
    max_pending_approvals: starter["max_pending_approvals"],
    $max_pending_comment: starter["$max_pending_comment"],
    agent_pubkey: agentPubkey,
    $agent_pubkey_comment: starter["$agent_pubkey_comment"],
    buzz: starter["buzz"],
    webhook_url: null,
    data_dir: "data"
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Build the secure-stripe preset policies.json as a string: the
 * productized form of "never give an AI agent direct access to Stripe;
 * give it Axiru". One downstream entry, Stripe's official MCP server,
 * pinned to the exact version verified with this preset, every tool
 * exposed under the pay_ prefix, and a starter policy pack sized for a
 * team's first test-mode deployment rather than the init scaffold's
 * enterprise placeholders.
 *
 * Every gated tool name below is grounded in the @stripe/mcp@0.2.5
 * toolset (served via @stripe/agent-toolkit) and verified against a
 * live `--tools=all` catalog under the gate: 22 tools exposed, 9 of
 * them gated by this list (the toolkit source also registers
 * send_invoice, but 0.2.5 does not expose it). create_refund is the
 * only tool in that set that carries an integer minor-units amount
 * argument, so it is the only tool with an amount mapping. Every other
 * gated tool has no mapping on purpose and therefore ALWAYS parks for
 * human approval (the gate fails closed on an unextractable amount).
 */
export function buildSecureStripePolicies(agentPubkey: string | null = null): string {
  const starter = JSON.parse(STARTER_POLICIES) as Record<string, unknown>;
  const doc: Record<string, unknown> = {
    $comment:
      "buzz-axiru config written by `buzz-axiru quickstart --preset secure-stripe`: " +
      "Stripe's official MCP server behind the Axiru gate. Amounts are integer strings " +
      "in minor units (cents for USD). Keys starting with $ are ignored by the loader. " +
      "Start with a TEST-MODE Stripe key. Edit and restart the gate.",
    rail: "stripe",
    currency: "USD",
    controls: {
      $comment:
        "Deterministic spend policy, evaluated locally on every decision. Sized for a " +
        "first test-mode deployment; raise the numbers once the approval flow is proven.",
      per_agent_daily_cap: {
        $comment:
          "Denies an agent's spend once its trailing-24h authorized total reaches the cap. " +
          "USD 5,000.00.",
        cap_minor_units: "500000"
      },
      single_payment_ceiling: {
        $comment: "Routes any single payment at or above the threshold to a human. USD 500.00.",
        threshold_minor_units: "50000",
        approver_group: "operators"
      },
      counterparty_allowlist: {
        $comment:
          "Deny by default: anything not in this list is denied outright. pay_create_refund " +
          "reports the refunded PaymentIntent (pi_...) as its counterparty, so this list is " +
          "which payments the agent may refund without a human (find ids with " +
          "pay_list_payment_intents). Replace the placeholder; it matches nothing real. " +
          "Gated tools with no counterparty mapping never reach this control: they park for " +
          "human approval first.",
        allowed_ids: ["pi_3ReplaceWithRealPaymentIntent"]
      },
      business_hours: {
        $comment:
          "Outside 09:00-17:00 in this timezone, spend is routed to a human instead of allowed.",
        tz: "America/New_York",
        open_hour: 9,
        close_hour: 17,
        effect: "require_approval"
      }
    },
    downstream: [
      {
        $comment:
          `Stripe's official MCP server, pinned to @stripe/mcp@${STRIPE_MCP_VERSION}, the ` +
          "version field-verified to run the full local toolset under the gate. Newer " +
          "0.3.x releases are a hosted proxy to mcp.stripe.com whose tool scoping moves " +
          "to Stripe restricted API keys; re-verify before bumping the pin. --tools=all " +
          "is safe here because the gate fronts every exposed tool. Export " +
          "STRIPE_SECRET_KEY (a TEST-MODE secret key first) in the gate's environment; " +
          "never write the key into this file. Only the four listed variables reach the " +
          "child process; if your machine reaches npm through an egress proxy, add your " +
          "proxy variables (HTTPS_PROXY etc.) to env_passthrough or npx cannot fetch. " +
          "The timeout is generous because the first start downloads the pinned package; " +
          "later starts hit the npm cache.",
        name: "stripe",
        command: "npx",
        args: ["-y", `@stripe/mcp@${STRIPE_MCP_VERSION}`, "--tools=all"],
        env: {},
        env_passthrough: ["PATH", "HOME", "TMPDIR", "STRIPE_SECRET_KEY"],
        tool_prefix: "pay_",
        request_timeout_ms: 120000,
        hide_tools: []
      }
    ],
    payment_tools: {
      $comment:
        `Grounded in the @stripe/mcp@${STRIPE_MCP_VERSION} --tools=all toolset. Gated: the ` +
        "tools that move money or commit charges (refunds, payment links, invoices, " +
        "coupons, subscription changes, dispute updates). Passing through: read-only " +
        "tools (pay_list_*, pay_retrieve_balance, pay_search_stripe_documentation) and " +
        "catalog writes (pay_create_customer, pay_create_product, pay_create_price). A " +
        "gated tool WITHOUT an amount mapping always parks for human approval: the gate " +
        "fails closed when it cannot read an amount. To gate more tools, add their " +
        "exposed pay_-prefixed names to gate; add a mapping only for a tool whose " +
        "arguments really carry an integer minor-units amount.",
      gate: [
        "pay_create_refund",
        "pay_create_payment_link",
        "pay_create_invoice",
        "pay_create_invoice_item",
        "pay_finalize_invoice",
        "pay_create_coupon",
        "pay_update_subscription",
        "pay_cancel_subscription",
        "pay_update_dispute"
      ],
      mappings: {
        pay_create_refund: {
          $comment:
            "create_refund takes payment_intent (required) and amount in cents " +
            "(optional). A FULL refund omits amount and fails closed to a human. The " +
            "refunded PaymentIntent is the counterparty, so the allowlist above decides " +
            "which payments may be refunded autonomously. Refunds settle in the original " +
            "charge's currency; this static USD matches the preset's USD policy pack, " +
            "change both together.",
          amount_field: "amount",
          currency: "USD",
          counterparty_field: "payment_intent"
        }
      }
    },
    approval_ttl_seconds: starter["approval_ttl_seconds"],
    $approval_ttl_comment: starter["$approval_ttl_comment"],
    max_pending_approvals: starter["max_pending_approvals"],
    $max_pending_comment: starter["$max_pending_comment"],
    agent_pubkey: agentPubkey,
    $agent_pubkey_comment: starter["$agent_pubkey_comment"],
    buzz: starter["buzz"],
    webhook_url: null,
    data_dir: "data"
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Write the file, refusing to clobber unless forced. Refusal is a
 * thrown Error (not a process.exit) so cli.ts owns the exit code and
 * tests can assert the exact message.
 */
export function writeQuickstartPolicies(path: string, content: string, force: boolean): void {
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists (use --force to overwrite). Nothing was written.`);
  }
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The exact wiring steps for each harness, printed after the config is
 * written. Accepts a plain string and throws on unknown values so the
 * CLI's flag validation and this function cannot disagree silently.
 */
export function harnessNextSteps(harness: string): string {
  switch (harness as Harness) {
    case "buzz":
      // Two wiring paths on purpose: the env var only works for raw
      // buzz-acp. Buzz Desktop keeps BUZZ_ACP_MCP_COMMAND on its
      // reserved list and has no UI field for an agent's mcp command,
      // so Desktop users must go through `buzz-axiru adopt` instead.
      return [
        "Next steps (buzz):",
        "  1. Raw buzz-acp (terminal): point it at the gate with",
        "       export BUZZ_ACP_MCP_COMMAND=buzz-axiru",
        "  2. Restart the agent. Its tools now route through the gate.",
        "  3. Buzz Desktop instead? The app reserves that env var and has no UI",
        "     field for it. Quit Buzz Desktop completely, run",
        "       buzz-axiru adopt --agent <name>",
        "     then reopen Buzz and restart the agent.",
        "  4. Prove it works:",
        "       buzz-axiru doctor"
      ].join("\n");
    case "goose":
      return [
        "Next steps (goose):",
        "  1. Add buzz-axiru as an extension in ~/.config/goose/config.yaml.",
        "     Generic snippet; verify against your goose version:",
        "",
        "       extensions:",
        "         buzz-axiru:",
        "           enabled: true",
        "           type: stdio",
        "           cmd: buzz-axiru",
        "           args: [\"serve\"]",
        "",
        "  2. Restart goose.",
        "  3. Prove it works:",
        "       buzz-axiru doctor"
      ].join("\n");
    case "claude-code":
      return [
        "Next steps (claude-code):",
        "  1. Register the gate as an MCP server:",
        "       claude mcp add buzz-axiru -- buzz-axiru serve",
        "  2. Restart Claude Code (or start a new session).",
        "  3. Prove it works:",
        "       buzz-axiru doctor"
      ].join("\n");
    case "codex":
      return [
        "Next steps (codex):",
        "  1. Add the gate to ~/.codex/config.toml:",
        "",
        "       [mcp_servers.buzz-axiru]",
        "       command = \"buzz-axiru\"",
        "       args = [\"serve\"]",
        "",
        "  2. Restart Codex.",
        "  3. Prove it works:",
        "       buzz-axiru doctor"
      ].join("\n");
    default:
      throw new Error(`unknown harness "${harness}" (use ${HARNESSES.join(", ")})`);
  }
}
