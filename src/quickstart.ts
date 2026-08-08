/**
 * `buzz-axiru quickstart`: one command from `npm install -g buzz-axiru`
 * to a governed agent.
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

import { existsSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

import { STARTER_POLICIES } from "./scaffold.js";

export const HARNESSES = ["buzz", "goose", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

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
export function buildQuickstartPolicies(shell: DetectedShell | null): string {
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
        "payment_tools.gate target money tools only.",
      name: "payments",
      command: "npx",
      args: ["-y", "@stripe/mcp", "--tools=all"],
      env: { STRIPE_SECRET_KEY: "sk_test_..." },
      tool_prefix: "pay_",
      request_timeout_ms: 30000,
      hide_tools: []
    },
    payment_tools: starter["$payment_tools_example"],
    approval_ttl_seconds: starter["approval_ttl_seconds"],
    $approval_ttl_comment: starter["$approval_ttl_comment"],
    agent_pubkey: null,
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
  writeFileSync(path, content, "utf8");
}

/**
 * The exact wiring steps for each harness, printed after the config is
 * written. Accepts a plain string and throws on unknown values so the
 * CLI's flag validation and this function cannot disagree silently.
 */
export function harnessNextSteps(harness: string): string {
  switch (harness as Harness) {
    case "buzz":
      return [
        "Next steps (buzz):",
        "  1. Point Buzz at the gate:",
        "       export BUZZ_ACP_MCP_COMMAND=buzz-axiru",
        "  2. Restart the agent in Buzz. Its tools now route through the gate.",
        "  3. Prove it works:",
        "       buzz-axiru quickstart --check"
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
        "       buzz-axiru quickstart --check"
      ].join("\n");
    case "claude-code":
      return [
        "Next steps (claude-code):",
        "  1. Register the gate as an MCP server:",
        "       claude mcp add buzz-axiru -- buzz-axiru serve",
        "  2. Restart Claude Code (or start a new session).",
        "  3. Prove it works:",
        "       buzz-axiru quickstart --check"
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
        "       buzz-axiru quickstart --check"
      ].join("\n");
    default:
      throw new Error(`unknown harness "${harness}" (use ${HARNESSES.join(", ")})`);
  }
}
