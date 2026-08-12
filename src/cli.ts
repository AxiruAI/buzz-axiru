#!/usr/bin/env node
/**
 * buzz-axiru CLI.
 *
 *   buzz-axiru                       start the MCP server on stdio (default)
 *   buzz-axiru serve                 same, explicit; --mode gate|advisory
 *   buzz-axiru init                  write a starter policies.json here
 *   buzz-axiru quickstart            detect your setup, write policies.json,
 *                                    print wiring steps; --check verifies it
 *   buzz-axiru adopt                 route an agent through the gate: Buzz
 *                                    Desktop custom harness by default (app
 *                                    closed), or --harness claude-code|codex
 *   buzz-axiru pending               list approvals waiting on a human
 *   buzz-axiru approve <id>          grant a pending approval
 *   buzz-axiru deny <id>             deny a pending approval
 *   buzz-axiru reconcile <id>        resolve an ambiguous approved execution
 *   buzz-axiru verify                re-derive the ledger hash chain
 *
 * Flags: --mode gate|advisory  --policies <path>  --data-dir <path>
 *        --by <name>  --note <text>  --force (init, quickstart)
 *        --harness buzz|goose|claude-code|codex  --preset secure-stripe
 *        --yes  --check (quickstart)
 * Env:   BUZZ_AXIRU_POLICIES, BUZZ_AXIRU_DATA_DIR, BUZZ_AXIRU_AGENT_PUBKEY
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  buildCustomHarness,
  customHarnessPathFor,
  describeStructure,
  findManagedAgentsFiles,
  locateAgents,
  managedAgentsSearchRoots,
  mergeCodexToml,
  mergeMcpJson,
  planSpaceFreeGatePath,
  refuseIfBuzzDesktopRunning,
  resolveGateBinary,
  selectAgentGroup,
  setAgentMcpCommand,
  setAgentRuntime,
  unsetAgentGate,
  writeBackup,
  writeGateShim,
  BUZZ_ACP_BINARY,
  CUSTOM_HARNESS_ID,
  CUSTOM_HARNESS_LABEL,
  type AgentsCollection
} from "./adopt.js";
import { isExpired } from "./approvals.js";
import {
  isGatedTool,
  isPlausiblePubkey,
  loadConfig,
  mappingForTool,
  policiesForAgent
} from "./config.js";
import { GateServer } from "./gate.js";
import { Bridge } from "./guard.js";
import { fileLimitWarning } from "./downstream.js";
import { verifyLedger } from "./ledger.js";
import { withDataDirLock } from "./lock.js";
import { LATEST_PROTOCOL_VERSION, McpServer } from "./mcp.js";
import { formatAmount, notifyApprovalDecided } from "./notify.js";
import { DownstreamPool } from "./pool.js";
import {
  buildQuickstartPolicies,
  buildSecureStripePolicies,
  detectBuzzDevMcp,
  harnessNextSteps,
  writeQuickstartPolicies,
  HARNESSES,
  PRESETS,
  STRIPE_MCP_VERSION
} from "./quickstart.js";
import { STARTER_POLICIES } from "./scaffold.js";

const VERSION = "0.5.3";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "force",
  "yes",
  "check",
  "json",
  "ack-unknown-amount",
  "unset",
  "dry-run",
  "legacy"
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let command = "serve";
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals > 2) {
        flags[arg.slice(2, equals)] = arg.slice(equals + 1);
        continue;
      }
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || value === undefined || value.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = value;
        i++;
      }
    } else if (!commandSet) {
      command = arg;
      commandSet = true;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function fail(message: string): never {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function runInit(flags: Record<string, string>): void {
  const path = resolve(flags.path ?? "policies.json");
  if (existsSync(path) && flags.force !== "true") {
    fail(
      `buzz-axiru init: ${path} already exists (use --force to overwrite). ` +
        "Nothing was written."
    );
  }
  writeFileSync(path, STARTER_POLICIES, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  process.stdout.write(
    [
      `Wrote ${path}`,
      "",
      "Next steps:",
      "  1. Set downstream.command/args to your payment MCP server to run the",
      "     enforcing gate, or leave downstream null for advisory mode.",
      "  2. List the tools that move money in payment_tools.gate and map their",
      "     amount fields in payment_tools.mappings.",
      "  3. Adjust the controls (caps, ceiling, allowlist, hours) to taste.",
      "  4. Start the bridge:  buzz-axiru serve",
      "",
      "The README has an AGENTS.md snippet to paste into your agent's prompt:",
      "encouragement lives in the prompt, enforcement lives in the gate.",
      ""
    ].join("\n")
  );
}

/**
 * `buzz-axiru quickstart`: secure starter setup. Detects the shell
 * MCP server, writes a working policies.json, and prints the wiring
 * steps for the chosen harness. Non-interactive: every choice has a
 * flag, and --yes exists so scripts can state "defaults accepted"
 * explicitly (there are no prompts to answer).
 */
function runQuickstart(flags: Record<string, string>): void {
  const harness = flags.harness ?? "buzz";
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    fail(
      `buzz-axiru quickstart: unknown --harness "${harness}" (use ${HARNESSES.join(", ")})`
    );
  }
  const preset = flags.preset ?? null;
  if (preset !== null && !(PRESETS as readonly string[]).includes(preset)) {
    fail(
      `buzz-axiru quickstart: unknown --preset "${preset}" (use ${PRESETS.join(", ")})`
    );
  }
  const detected = detectBuzzDevMcp();
  const agentPubkey = flags["agent-pubkey"] ?? process.env.BUZZ_AXIRU_AGENT_PUBKEY ?? null;
  if (agentPubkey !== null && !isPlausiblePubkey(agentPubkey)) {
    fail(
      "buzz-axiru quickstart: --agent-pubkey must be a 64-character lowercase hex Nostr pubkey or npub"
    );
  }
  const path = resolve(flags.path ?? "policies.json");
  if (preset === "secure-stripe") {
    runQuickstartSecureStripe(flags, harness, agentPubkey, path);
    return;
  }
  // The shell entry is Buzz's bundled server. Other harnesses bring
  // their own tools, so their config starts in advisory mode with the
  // payment slot ready to move into the downstream array.
  const shell = harness === "buzz" ? detected : null;
  try {
    writeQuickstartPolicies(
      path,
      buildQuickstartPolicies(shell, agentPubkey),
      flags.force === "true"
    );
  } catch (err) {
    fail(`buzz-axiru quickstart: ${(err as Error).message}`);
  }
  const lines: string[] = [`buzz-axiru ${VERSION} quickstart`, ""];
  lines.push(`harness: ${harness}`);
  if (harness === "buzz") {
    lines.push(
      detected !== null
        ? `shell server: ${detected.command} (found via ${detected.source})`
        : "shell server: buzz-dev-mcp NOT FOUND (checked BUZZ_ACP_MCP_COMMAND, PATH,\n" +
            "              and /Applications/Buzz.app). Wrote an advisory-mode config;\n" +
            "              nothing is enforced until you add a downstream server."
    );
  }
  lines.push("", `Wrote ${path}`);
  lines.push(
    agentPubkey === null
      ? "  agent identity: MISSING - set agent_pubkey or BUZZ_AXIRU_AGENT_PUBKEY before gate mode"
      : `  agent identity: ${agentPubkey}`
  );
  if (shell !== null) {
    lines.push(
      `  downstream:    shell (${shell.command}), tools exposed with their plain names`,
      '  payment slot:  disabled; move "$downstream_payment_slot" into the',
      '                 "downstream" array to gate your payment MCP server',
      "  gated tools:   pay_* (money tools only; shell tools pass through)"
    );
  } else {
    lines.push(
      "  downstream:    null (advisory mode; nothing enforced yet)",
      '  payment slot:  "$downstream_payment_slot" is a ready-made entry; set',
      '                 "downstream" to an array containing it to turn on the gate',
      "  gated tools:   pay_* once a downstream server is configured"
    );
  }
  lines.push(
    "  controls:      USD 100,000.00 per-agent daily cap, USD 25,000.00",
    "                 single-payment ceiling routes to a human, counterparty",
    "                 allowlist, business hours 09:00-17:00 America/New_York",
    "",
    harnessNextSteps(harness),
    ""
  );
  process.stdout.write(lines.join("\n"));
}

/**
 * `buzz-axiru quickstart --preset secure-stripe`: never give an AI
 * agent direct access to Stripe; give it Axiru. Writes a config whose
 * one downstream server is Stripe's official MCP server, pinned and
 * prefixed, with every money-moving tool behind the gate.
 */
function runQuickstartSecureStripe(
  flags: Record<string, string>,
  harness: string,
  agentPubkey: string | null,
  path: string
): void {
  try {
    writeQuickstartPolicies(path, buildSecureStripePolicies(agentPubkey), flags.force === "true");
  } catch (err) {
    fail(`buzz-axiru quickstart: ${(err as Error).message}`);
  }
  const lines: string[] = [
    `buzz-axiru ${VERSION} quickstart`,
    "",
    "preset: secure-stripe (govern Stripe's official MCP server)",
    `harness: ${harness}`,
    "",
    `Wrote ${path}`,
    agentPubkey === null
      ? "  agent identity: MISSING - set agent_pubkey or BUZZ_AXIRU_AGENT_PUBKEY before gate mode"
      : `  agent identity: ${agentPubkey}`,
    `  downstream:    stripe (npx -y @stripe/mcp@${STRIPE_MCP_VERSION} --tools=all),`,
    "                 tools exposed to the agent as pay_<tool>",
    "  gated tools:   refunds, payment links, invoices, coupons, subscription",
    "                 changes, dispute updates. Read-only tools (pay_list_*,",
    "                 pay_retrieve_balance) pass through. A gated tool without an",
    "                 amount mapping always parks for human approval.",
    "  controls:      USD 5,000.00 per-agent daily cap, USD 500.00 single-payment",
    "                 ceiling routes to a human, refund counterparty allowlist",
    "                 (deny by default), business hours 09:00-17:00",
    "                 America/New_York",
    "  key:           export STRIPE_SECRET_KEY (a TEST-MODE sk_test_ key first).",
    "                 Without it the Stripe server cannot start and the gate",
    "                 fails closed: no key, no tools, no spend.",
    "",
    harnessNextSteps(harness),
    "",
    "Then prove the whole chain: buzz-axiru quickstart --check",
    ""
  ];
  process.stdout.write(lines.join("\n"));
}

/**
 * `buzz-axiru quickstart --check`: the "did it work" command. Loads the
 * config and starts the same DownstreamPool that `serve` runs in gate
 * mode, so a green check means serve will come up too. Exit 0 on
 * success, 1 on any failure.
 */
async function runQuickstartCheck(flags: Record<string, string>): Promise<void> {
  const config = loadConfig(flags.policies, flags["data-dir"]);
  process.stdout.write(`buzz-axiru ${VERSION} security readiness check\npolicies: ${config.config_path}\n\n`);
  // Full chain verification, on purpose: doctor and verify are the
  // scheduled full passes in the incremental-verification model, so
  // this is where a tamper of an already-verified prefix surfaces.
  const ledgerPath = join(config.data_dir, "ledger.jsonl");
  const ledgerState = verifyLedger(ledgerPath);
  if (ledgerState.ok) {
    process.stdout.write(
      `ledger: ${ledgerState.records} record(s), head ` +
        `${ledgerState.records > 0 ? ledgerState.head_hash : "genesis (empty)"}\n` +
        "        verification: full chain verified now and at every process start;\n" +
        "        incremental from a verified checkpoint per append and decision\n\n"
    );
  } else {
    process.stdout.write(
      `[NOT READY] Ledger integrity check failed at sequence ${ledgerState.bad_seq}: ` +
        `${ledgerState.reason}. Run \`buzz-axiru verify\` and restore the ledger from a ` +
        "trusted copy before serving.\n\n"
    );
    process.exitCode = 1;
  }
  // Same check `serve` runs at gate startup; doctor is where operators
  // look when agents fail with EAGAIN, so it belongs here too.
  const limitWarning = fileLimitWarning();
  if (limitWarning !== null) {
    process.stdout.write(`[WARN] ${limitWarning}\n\n`);
  }
  if (config.downstream === null) {
    process.stdout.write(
      "[PASS] Config loads.\n" +
        "[NOT READY] downstream is null: advisory mode does not enforce payment policy.\n" +
        "Move the $downstream_payment_slot into downstream, configure its tool mappings,\n" +
        "set agent_pubkey (or BUZZ_AXIRU_AGENT_PUBKEY), then run this check again.\n"
    );
    process.exitCode = 1;
    return;
  }
  const pool = new DownstreamPool(config.downstream);
  try {
    await pool.start(LATEST_PROTOCOL_VERSION, VERSION);
    const tools = await pool.listTools();
    const width = Math.max(...config.downstream.map((s) => s.name.length));
    for (const server of config.downstream) {
      const count = tools.filter((t) => pool.serverFor(t.name) === server.name).length;
      const prefixNote = server.tool_prefix !== "" ? `, tool prefix "${server.tool_prefix}"` : "";
      process.stdout.write(
        `  ${server.name.padEnd(width)}  up  ${String(count).padStart(3)} tools  ` +
          `(${server.command}${prefixNote})\n`
      );
    }
    const gated = tools.map((t) => t.name).filter((name) => isGatedTool(config, name));
    process.stdout.write(
      `\n${tools.length} tools exposed, ${gated.length} gated` +
        (gated.length > 0 ? `: ${gated.join(", ")}` : "") +
        "\n"
    );
    if (config.payment_tools === null) {
      process.stdout.write(
        "NOTE: no payment_tools matcher in the config file. Failing closed:\n" +
          "every tool from every server is gated. Add payment_tools to gate\n" +
          "only the tools that move money.\n"
      );
    }
    const blockers: string[] = [];
    const warnings: string[] = [];
    const identity = process.env.BUZZ_AXIRU_AGENT_PUBKEY ?? config.agent_pubkey;
    if (identity === null || identity === undefined) {
      blockers.push(
        "No agent identity is configured. Set agent_pubkey or BUZZ_AXIRU_AGENT_PUBKEY."
      );
    } else if (!isPlausiblePubkey(identity)) {
      blockers.push("BUZZ_AXIRU_AGENT_PUBKEY is not a valid hex pubkey or npub.");
    }
    if (config.payment_tools !== null && gated.length === 0) {
      blockers.push(
        "No exposed tool matches payment_tools.gate. Nothing is currently protected."
      );
    }
    if (policiesForAgent(config, identity ?? "0".repeat(64)).length === 0) {
      blockers.push("No spend controls are configured; the policy engine would default to allow.");
    }
    const unmapped = gated.filter((name) => mappingForTool(config, name)?.amount_field === undefined);
    if (unmapped.length > 0) {
      warnings.push(
        `${unmapped.length} gated tool(s) have no amount mapping and will always require manual approval: ` +
          unmapped.join(", ")
      );
    }
    const fullEnv = config.downstream.filter((server) => server.env_passthrough === "all");
    if (fullEnv.length > 0) {
      warnings.push(
        `Full environment inheritance is enabled for: ${fullEnv.map((s) => s.name).join(", ")}. ` +
          "Use none or an explicit variable allowlist to isolate credentials."
      );
    }
    if (config.buzz.channel_id === null && config.webhook_url === null) {
      warnings.push(
        "No Buzz channel or webhook is configured; approval requests are visible only in local stderr."
      );
    }
    for (const warning of warnings) process.stdout.write(`[WARN] ${warning}\n`);
    if (blockers.length > 0) {
      for (const blocker of blockers) process.stdout.write(`[NOT READY] ${blocker}\n`);
      process.stdout.write("\nDownstream connectivity passed, but the enforcing setup is not ready.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("\n[PASS] Every downstream server started and answered tools/list.\n");
      process.stdout.write("[PASS] Agent identity and gate coverage are configured.\n");
      process.stdout.write("READY: start the enforcing gate with `buzz-axiru serve`.\n");
    }
  } catch (err) {
    process.stdout.write(`FAILED: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    pool.close();
  }
}

/** Prompt-or---yes gate shared by every adopt write path. */
async function confirmAdoptWrite(flags: Record<string, string>): Promise<void> {
  if (flags.yes === "true") return;
  // No TTY means nobody can answer the prompt; require --yes so a
  // script cannot silently rewrite a config file.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("buzz-axiru adopt: not a terminal; re-run with --yes to apply this change.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Apply this change? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    fail("buzz-axiru adopt: aborted; nothing was written.");
  }
}

/** Absolute path to the buzz-axiru binary for wiring into configs. */
function resolveGatePath(flags: Record<string, string>): { path: string; source: string } {
  if (flags["gate-path"] !== undefined) {
    if (!isAbsolute(flags["gate-path"])) {
      fail("buzz-axiru adopt: --gate-path must be an absolute path");
    }
    return { path: flags["gate-path"], source: "--gate-path" };
  }
  const resolved = resolveGateBinary();
  if (resolved === null) {
    fail(
      "buzz-axiru adopt: could not locate the buzz-axiru executable. Install it " +
        "(npm install -g buzz-axiru) or pass --gate-path <absolute-path>."
    );
  }
  return resolved;
}

/** Rewrite a config file in place, preserving its permission bits when
 *  it already exists (the file is the other tool's, not ours). */
function writePreservingMode(path: string, content: string): void {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    writeFileSync(path, content, { encoding: "utf8", mode });
    chmodSync(path, mode);
  } else {
    writeFileSync(path, content, { encoding: "utf8" });
  }
}

/** Locate, read, and parse managed-agents.json, failing with the
 *  established messages. Shared by the legacy and harness flows. */
function loadManagedAgents(flags: Record<string, string>): {
  path: string;
  doc: unknown;
  collection: AgentsCollection;
} {
  // Locate the file: explicit --data wins; otherwise search the standard
  // Buzz Desktop data directories, refusing to guess between multiple hits.
  let path: string;
  if (flags.data !== undefined) {
    path = resolve(flags.data);
    if (!existsSync(path)) fail(`buzz-axiru adopt: --data ${path} does not exist`);
  } else {
    const roots = managedAgentsSearchRoots(homedir(), process.platform);
    const found = findManagedAgentsFiles(homedir(), process.platform);
    if (found.length === 0) {
      fail(
        [
          "buzz-axiru adopt: no managed-agents.json found. Searched (one glob level):",
          ...roots.map((root) => `  ${root.display}`),
          "Your Buzz install keeps it somewhere else. Ask a shell-capable Buzz agent",
          "to run:",
          "  find ~ -maxdepth 5 -name managed-agents.json 2>/dev/null",
          "then pass the path explicitly:",
          "  buzz-axiru adopt --agent <name> --data <path-to-managed-agents.json>"
        ].join("\n")
      );
    }
    if (found.length > 1) {
      fail(
        [
          "buzz-axiru adopt: multiple managed-agents.json files found:",
          ...found.map((hit) => `  ${hit}`),
          "Pick the one your Buzz Desktop actually uses and pass it with --data."
        ].join("\n")
      );
    }
    path = found[0]!;
  }

  const raw = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    fail(
      `buzz-axiru adopt: ${path} is not valid JSON (${(err as Error).message}). ` +
        "Refusing to touch it; restore it from a Buzz backup first."
    );
  }
  const collection = locateAgents(doc);
  if (collection === null) {
    // Structural description only, never file contents: the store can
    // hold tokens that must not end up in a terminal scrollback.
    fail(
      "buzz-axiru adopt: could not recognize the agents collection in " +
        `${path}. The file's structure is: ${describeStructure(doc)}. ` +
        "Refusing to guess; file an issue with this structural description " +
        "(it contains no values from your file)."
    );
  }
  return { path, doc, collection };
}

/**
 * `buzz-axiru adopt`: wire an agent's tool traffic through the gate.
 *
 * Default (Buzz Desktop): create/update a CUSTOM HARNESS whose command
 * is buzz-acp with ["--mcp-command", <gate>] as two argv elements, and
 * point the agent's runtime at it. Field-verified (0.5.2): editing the
 * agent record's mcp_command does NOT work under Desktop, because the
 * app injects BUZZ_ACP_MCP_COMMAND first in the child envp and the
 * first duplicate wins; the argv flag is the only override that beats
 * it. --legacy keeps the old mcp_command edit for setups where the
 * record value is honored. --harness claude-code|codex instead merges
 * the gate into those tools' MCP config files.
 */
async function runAdopt(flags: Record<string, string>): Promise<void> {
  const harness = flags.harness ?? "buzz";
  if (harness === "claude-code" || harness === "codex") {
    await runAdoptFileHarness(harness, flags);
    return;
  }
  if (harness !== "buzz") {
    fail(`buzz-axiru adopt: unknown --harness "${harness}" (use buzz, claude-code, codex)`);
  }

  if (flags.force === "true") {
    process.stderr.write(
      "buzz-axiru adopt: --force skips the Buzz-Desktop-is-closed check. If the " +
        "app is open, this edit can be overwritten or corrupt the agent store.\n"
    );
  }
  const refusal = refuseIfBuzzDesktopRunning(flags.force === "true");
  if (refusal !== null) fail(refusal);

  const { path, doc, collection } = loadManagedAgents(flags);

  if (flags.legacy === "true") {
    await runAdoptLegacy(flags, path, doc, collection);
    return;
  }
  if (flags.unset === "true") {
    await runAdoptUnset(flags, path, doc, collection);
    return;
  }

  // The harness flow, the one field testing proved works.
  const gate = resolveGatePath(flags);
  const plan = planSpaceFreeGatePath(gate.path);
  if (plan.warning !== null) {
    process.stderr.write(`buzz-axiru adopt: WARNING: ${plan.warning}\n`);
  }
  if (!existsSync(BUZZ_ACP_BINARY)) {
    process.stderr.write(
      `buzz-axiru adopt: WARNING: ${BUZZ_ACP_BINARY} does not exist on this machine. ` +
        "The harness is written anyway, but it cannot launch until Buzz Desktop is " +
        "installed at the standard location.\n"
    );
  }

  let group;
  let runtimeEdit;
  try {
    group = selectAgentGroup(collection, flags.agent ?? null);
    runtimeEdit = setAgentRuntime(collection, flags.agent ?? null, CUSTOM_HARNESS_ID);
  } catch (err) {
    fail(`buzz-axiru adopt: ${(err as Error).message}`);
  }

  const harnessPath = customHarnessPathFor(path);
  let existingHarness: unknown = null;
  const harnessExists = existsSync(harnessPath);
  if (harnessExists) {
    try {
      existingHarness = JSON.parse(readFileSync(harnessPath, "utf8"));
    } catch (err) {
      fail(
        `buzz-axiru adopt: ${harnessPath} is not valid JSON (${(err as Error).message}). ` +
          "Refusing to touch it; delete or fix it first."
      );
    }
  }
  const harnessDoc = buildCustomHarness(existingHarness, plan.path);

  process.stdout.write(
    [
      `${path}`,
      `  agents collection: ${collection.location}`,
      `  agent:             ${group.name}` +
        (group.rows.length > 1
          ? ` (stored as ${group.rows.length} rows; live instance preferred)`
          : ""),
      `  runtime:           ${JSON.stringify(runtimeEdit.previous)} -> ${JSON.stringify(CUSTOM_HARNESS_ID)}`,
      `  harness file:      ${harnessPath} (${harnessExists ? "update" : "new"})`,
      `  harness label:     ${CUSTOM_HARNESS_LABEL}`,
      `  harness command:   ${BUZZ_ACP_BINARY}`,
      `  harness args:      ${JSON.stringify(harnessDoc.args)}  (two separate elements)`,
      `  gate binary:       ${gate.path} (via ${gate.source})`,
      ...(plan.action === "write-shim"
        ? [
            `  shim:              ${plan.shim} will be created/refreshed (the resolved`,
            "                     path contains spaces, which break harness arg handling)"
          ]
        : []),
      "  note:              files are re-serialized with 2-space indent; timestamped",
      "                     backups are written first",
      ""
    ].join("\n")
  );

  if (flags["dry-run"] === "true") {
    process.stdout.write("Dry run: nothing was written.\n");
    return;
  }
  await confirmAdoptWrite(flags);

  if (plan.action === "write-shim") writeGateShim(plan.shim!, gate.path);
  const backup = writeBackup(path);
  const harnessBackup = harnessExists ? writeBackup(harnessPath) : null;
  mkdirSync(join(harnessPath, ".."), { recursive: true });
  writePreservingMode(harnessPath, JSON.stringify(harnessDoc, null, 2) + "\n");
  writePreservingMode(path, JSON.stringify(doc, null, 2) + "\n");
  process.stdout.write(
    [
      `Backup:  ${backup}`,
      ...(harnessBackup !== null ? [`Backup:  ${harnessBackup}`] : []),
      `Updated: ${path}`,
      `Harness: ${harnessPath}`,
      "",
      "Next steps:",
      "  1. Reopen Buzz Desktop.",
      `  2. In the agent's settings, confirm the runtime is "${CUSTOM_HARNESS_LABEL}" and set`,
      "     the MODEL explicitly: an agent on a custom harness does not inherit a",
      "     default model, and an unset model fails to launch.",
      `  3. Restart the agent (${group.name}).`,
      "  4. Prove the gate is live from the inside: ask the agent to call the",
      "     axiru_gate_status tool and paste the JSON. Agents cannot see the gate",
      "     any other way (the wiring is an argv flag, and tool names are",
      "     unchanged in passthrough).",
      "  5. And from the outside:  buzz-axiru doctor",
      ""
    ].join("\n")
  );
}

/** The pre-0.5.2 mcp_command edit, kept behind --legacy. */
async function runAdoptLegacy(
  flags: Record<string, string>,
  path: string,
  doc: unknown,
  collection: AgentsCollection
): Promise<void> {
  process.stderr.write(
    "buzz-axiru adopt: --legacy edits the agent record's mcp_command. Field " +
      "testing proved Buzz Desktop IGNORES that value (the app injects " +
      "BUZZ_ACP_MCP_COMMAND first in the child envp and the first duplicate " +
      "wins). Use this mode only for file formats where the record value is " +
      "honored; otherwise run adopt without --legacy.\n"
  );
  const next = flags.unset === "true" ? "" : "buzz-axiru";
  let edit;
  try {
    edit = setAgentMcpCommand(collection, flags.agent ?? null, next);
  } catch (err) {
    fail(`buzz-axiru adopt: ${(err as Error).message}`);
  }

  const spelling = edit.keys.join(" and ");
  process.stdout.write(
    [
      `${path}`,
      `  agents collection: ${collection.location}`,
      `  agent:             ${edit.agentName}`,
      `  field:             ${spelling}`,
      `  change:            ${JSON.stringify(edit.previous)} -> ${JSON.stringify(edit.next)}`,
      "  note:              the file is re-serialized with 2-space indent, so",
      "                     formatting may normalize; a timestamped backup is",
      "                     written next to it first",
      ""
    ].join("\n")
  );

  if (flags["dry-run"] === "true") {
    process.stdout.write("Dry run: nothing was written.\n");
    return;
  }
  await confirmAdoptWrite(flags);

  const backup = writeBackup(path);
  writePreservingMode(path, JSON.stringify(doc, null, 2) + "\n");
  process.stdout.write(
    [
      `Backup:  ${backup}`,
      `Updated: ${path}`,
      "",
      "Next steps:",
      "  1. Reopen Buzz Desktop.",
      `  2. Restart the agent (${edit.agentName}) so it picks up the change.`,
      ...(flags.unset === "true"
        ? ["  3. The agent's mcp command is empty again; the gate is out of the loop."]
        : [
            "  3. Prove the gate is live: ask the agent to call axiru_gate_status,",
            "     and run:",
            "       buzz-axiru doctor"
          ]),
      ""
    ].join("\n")
  );
}

/** Take the gate back out of the loop (default-mode --unset). */
async function runAdoptUnset(
  flags: Record<string, string>,
  path: string,
  doc: unknown,
  collection: AgentsCollection
): Promise<void> {
  let edit;
  try {
    edit = unsetAgentGate(collection, flags.agent ?? null, CUSTOM_HARNESS_ID);
  } catch (err) {
    fail(`buzz-axiru adopt: ${(err as Error).message}`);
  }
  if (edit.changes.length === 0) {
    process.stdout.write(
      `buzz-axiru adopt: agent ${edit.agentName} does not reference the gate; nothing to do.\n`
    );
    return;
  }
  process.stdout.write(
    [
      `${path}`,
      `  agent:  ${edit.agentName}`,
      ...edit.changes.map((change) => `  change: ${change}`),
      ""
    ].join("\n")
  );
  if (flags["dry-run"] === "true") {
    process.stdout.write("Dry run: nothing was written.\n");
    return;
  }
  await confirmAdoptWrite(flags);
  const backup = writeBackup(path);
  writePreservingMode(path, JSON.stringify(doc, null, 2) + "\n");
  process.stdout.write(
    [
      `Backup:  ${backup}`,
      `Updated: ${path}`,
      "",
      "The agent no longer routes through the gate. The custom harness file, if",
      "any, is left in place: unreferenced harnesses are inert.",
      ""
    ].join("\n")
  );
}

/**
 * `adopt --harness claude-code|codex`: merge the gate into that tool's
 * MCP config. No Buzz-Desktop-is-closed check: these files belong to
 * tools that read them at startup, not live-rewriting apps.
 */
async function runAdoptFileHarness(
  harness: "claude-code" | "codex",
  flags: Record<string, string>
): Promise<void> {
  const gate = resolveGatePath(flags);
  const target =
    harness === "claude-code" ? resolve(".mcp.json") : join(homedir(), ".codex", "config.toml");
  const existingRaw = existsSync(target) ? readFileSync(target, "utf8") : null;
  let merged;
  try {
    merged =
      harness === "claude-code"
        ? mergeMcpJson(existingRaw, gate.path)
        : mergeCodexToml(existingRaw, gate.path);
  } catch (err) {
    fail(`buzz-axiru adopt: ${(err as Error).message}`);
  }
  if (!merged.changed) {
    process.stdout.write(`buzz-axiru adopt: ${target} already routes through the gate; nothing to do.\n`);
    return;
  }
  process.stdout.write(
    [
      `${target} (${existingRaw === null ? "new" : "update"})`,
      `  server:      ${CUSTOM_HARNESS_ID}`,
      `  command:     ${gate.path} (via ${gate.source})`,
      ...(existingRaw !== null ? ["  note:        a timestamped backup is written first"] : []),
      ""
    ].join("\n")
  );
  if (flags["dry-run"] === "true") {
    process.stdout.write("Dry run: nothing was written.\n");
    return;
  }
  await confirmAdoptWrite(flags);
  const backup = existingRaw !== null ? writeBackup(target) : null;
  mkdirSync(join(target, ".."), { recursive: true });
  writePreservingMode(target, merged.content);
  process.stdout.write(
    [
      ...(backup !== null ? [`Backup:  ${backup}`] : []),
      `Updated: ${target}`,
      "",
      "Next steps:",
      harness === "claude-code"
        ? "  1. Restart Claude Code (or start a new session) in this project."
        : "  1. Restart Codex.",
      "  2. Prove the gate is live: ask the agent to call axiru_gate_status,",
      "     and run:",
      "       buzz-axiru doctor",
      ""
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.version === "true" || command === "version") {
    process.stdout.write(`buzz-axiru ${VERSION}\n`);
    return;
  }
  if (flags.help === "true" || command === "help") {
    process.stdout.write(
      [
        `buzz-axiru ${VERSION}: bounded spend authority for Buzz agents`,
        "",
        "Usage:",
        "  buzz-axiru [serve]           start the MCP server on stdio",
        "                               (gate mode when a downstream server is configured,",
        "                               advisory mode otherwise; override with --mode)",
        "  buzz-axiru init              write a starter policies.json in the current directory",
        "  buzz-axiru quickstart        detect your setup, write policies.json, print wiring",
        "                               steps (--harness buzz|goose|claude-code|codex, --yes,",
        "                               --agent-pubkey <pubkey>, --force); --preset secure-stripe",
        "                               writes a config that gates Stripe's official MCP server;",
        "                               --check starts the configured downstream",
        "                               servers, reports tool counts, and exits 0/1",
        "  buzz-axiru doctor            run the same security-readiness and connectivity check",
        "  buzz-axiru adopt             route an agent's tools through the gate. Default: create",
        "                               an \"Axiru Gated\" custom harness for Buzz Desktop and point",
        "                               the agent's runtime at it (quit Buzz first; --agent <name>,",
        "                               --data <path>, --gate-path <abs>, --unset, --dry-run, --yes;",
        "                               --legacy edits mcp_command instead, which Buzz Desktop",
        "                               is known to ignore). --harness claude-code merges the gate",
        "                               into ./.mcp.json; --harness codex into ~/.codex/config.toml",
        "  buzz-axiru pending           list approvals waiting on a human",
        "  buzz-axiru show <id>         inspect one approval and its exact parked call",
        "  buzz-axiru approve <id>      grant a pending approval",
        "  buzz-axiru deny <id>         deny a pending approval",
        "  buzz-axiru reconcile <id|fingerprint>  record an ambiguous execution as executed",
        "                               or failed (approval id, or sha256:<hex> for a direct call)",
        "  buzz-axiru verify            re-derive the decision ledger hash chain",
        "",
        "Flags: --mode gate|advisory  --policies <path>  --data-dir <path>",
        "       --by <name>  --note <text>  --force (init, quickstart)",
        "       --json (pending)  --ack-unknown-amount (approve)",
        "       --outcome executed|failed --note <evidence> (reconcile)",
        "       --harness buzz|goose|claude-code|codex  --yes  --check (quickstart)",
        "       --preset secure-stripe  --agent-pubkey <hex-or-npub> (quickstart)",
        "       --agent <name>  --data <path>  --unset  --dry-run  --yes  --legacy",
        "       --harness buzz|claude-code|codex  --gate-path <abs> (adopt)",
        ""
      ].join("\n")
    );
    return;
  }

  if (command === "init") {
    runInit(flags);
    return;
  }

  if (command === "quickstart") {
    if (flags.check === "true") {
      await runQuickstartCheck(flags);
    } else {
      runQuickstart(flags);
    }
    return;
  }

  if (command === "doctor") {
    await runQuickstartCheck(flags);
    return;
  }

  if (command === "adopt") {
    await runAdopt(flags);
    return;
  }

  const config = loadConfig(flags.policies, flags["data-dir"]);
  const bridge = new Bridge(config);

  switch (command) {
    case "serve": {
      const mode = flags.mode ?? (config.downstream !== null ? "gate" : "advisory");
      if (mode !== "gate" && mode !== "advisory") {
        fail(`buzz-axiru serve: unknown --mode "${mode}" (use gate or advisory)`);
      }
      if (mode === "gate" && config.downstream === null) {
        fail(
          "buzz-axiru serve: --mode gate needs a downstream payment MCP server. " +
            `Add a "downstream" block to ${config.config_path} (see: buzz-axiru init).`
        );
      }
      if (mode === "advisory" && config.downstream !== null) {
        process.stderr.write(
          "buzz-axiru: NOTE: a downstream server is configured but --mode advisory " +
            "was requested; the downstream server will NOT be started and nothing " +
            "is enforced.\n"
        );
      }
      process.stderr.write(
        `buzz-axiru ${VERSION}: MCP server on stdio | mode: ${mode} | policies: ${config.config_path} | data: ${config.data_dir}\n`
      );
      // Field-verified (0.5.2): a gate spawned under a Buzz custom
      // harness inherits the login shell's low limits (macOS soft
      // maxfiles 256), and buzz-acp's parallelism can then fail every
      // agent with EAGAIN. Warn loudly, never fail: a low limit
      // degrades throughput, it does not make gating unsafe.
      const limitWarning = fileLimitWarning();
      if (limitWarning !== null) {
        process.stderr.write(`buzz-axiru: WARNING: ${limitWarning}\n`);
      }
      if (mode === "advisory") {
        await new McpServer(bridge, VERSION).serveStdio();
        return;
      }
      const gate = new GateServer(bridge, VERSION);
      process.on("exit", () => gate.close());
      process.on("SIGINT", () => process.exit(130));
      process.on("SIGTERM", () => process.exit(143));
      await gate.start();
      // Sweep the queue so granted parked calls are executed and
      // overdue approvals expire even while the agent is idle.
      const sweeper = setInterval(() => {
        gate.processApprovals().catch((err) => {
          process.stderr.write(`buzz-axiru: approval sweep failed: ${(err as Error).message}\n`);
        });
      }, 1000);
      sweeper.unref();
      try {
        await gate.serveStdio();
      } finally {
        clearInterval(sweeper);
        gate.close();
      }
      return;
    }
    case "pending": {
      const pending = bridge.approvals.pending();
      // A granted call stuck in_progress is not "pending" in the store,
      // but it is exactly what an operator running this command needs
      // to see: an ambiguous execution that only reconcile can resolve.
      const unreconciled = bridge.approvals
        .all()
        .filter((a) => a.status === "granted" && a.execution_status === "in_progress");
      // Direct (policy-allowed) calls have no approval record; their
      // durable claim lives in the ledger, and an unresolved claim is
      // an incident the operator must clear with reconcile.
      const directIncidents = bridge.ledger.directExecutionIncidents();
      if (flags.json === "true") {
        process.stdout.write(JSON.stringify(pending, null, 2) + "\n");
        return;
      }
      if (pending.length === 0 && unreconciled.length === 0 && directIncidents.length === 0) {
        process.stdout.write("No approvals are waiting.\n");
        return;
      }
      if (pending.length > 0) {
        process.stdout.write(`${pending.length} approval${pending.length === 1 ? "" : "s"} waiting:\n\n`);
        for (const approval of pending) {
          process.stdout.write(
            [
              `${approval.approval_id}  ${formatAmount(approval.amount_minor_units, approval.currency)}`,
              `  counterparty: ${approval.counterparty}`,
              `  tool:         ${approval.call?.tool_name ?? "advisory request"}`,
              `  requested:    ${approval.requested_at}`,
              `  expires:      ${approval.expires_at ?? "never"}`,
              `  inspect:      buzz-axiru show ${approval.approval_id}`,
              ""
            ].join("\n")
          );
        }
      }
      if (unreconciled.length > 0) {
        process.stdout.write(
          `${unreconciled.length} approved execution${unreconciled.length === 1 ? "" : "s"} ` +
            "NEED MANUAL RECONCILIATION (claimed but no recorded outcome; never retried automatically):\n\n"
        );
        for (const approval of unreconciled) {
          process.stdout.write(
            [
              `${approval.approval_id}  ${formatAmount(approval.amount_minor_units, approval.currency)}`,
              `  counterparty: ${approval.counterparty}`,
              `  tool:         ${approval.call?.tool_name ?? "advisory request"}`,
              `  claimed:      ${approval.execution_started_at ?? "unknown"}`,
              `  inspect:      buzz-axiru show ${approval.approval_id}`,
              `  resolve:      buzz-axiru reconcile ${approval.approval_id} --outcome executed|failed --note <evidence>`,
              ""
            ].join("\n")
          );
        }
      }
      if (directIncidents.length > 0) {
        process.stdout.write(
          `${directIncidents.length} direct call${directIncidents.length === 1 ? "" : "s"} ` +
            "NEED MANUAL RECONCILIATION (policy-allowed, durably claimed, but the downstream " +
            "outcome was lost; the amount is reserved against the cap and an identical retry " +
            "is suppressed):\n\n"
        );
        for (const incident of directIncidents) {
          process.stdout.write(
            [
              `${incident.fingerprint}`,
              `  amount:       ${formatAmount(incident.amount_minor_units, incident.currency)}`,
              `  counterparty: ${incident.counterparty}`,
              `  tool:         ${incident.tool_name ?? "unknown"}`,
              `  claimed:      ${incident.ts}`,
              ...(incident.error !== undefined ? [`  evidence:     ${incident.error}`] : []),
              `  resolve:      buzz-axiru reconcile ${incident.fingerprint} --outcome executed|failed --note <evidence>`,
              ""
            ].join("\n")
          );
        }
      }
      return;
    }
    case "show": {
      const id = positional[0];
      if (!id) fail("buzz-axiru show: missing approval id (see: buzz-axiru pending)");
      if (!/^(?:[0-9a-f]{12}|[0-9a-f]{32})$/.test(id)) {
        fail("buzz-axiru show: approval id must be 12 or 32 lowercase hex characters");
      }
      const approval = bridge.approvals.get(id);
      if (!approval) fail(`buzz-axiru show: no approval with id ${id}`);
      if (flags.json === "true") {
        process.stdout.write(JSON.stringify(approval, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        [
          `Approval ${approval.approval_id}`,
          `  status:       ${approval.status}`,
          `  amount:       ${formatAmount(approval.amount_minor_units, approval.currency)} (${approval.amount_minor_units} minor units)`,
          `  counterparty: ${approval.counterparty}`,
          `  agent:        ${approval.agent_pubkey}`,
          `  reason:       ${approval.reason_code}`,
          `  requested:    ${approval.requested_at}`,
          `  expires:      ${approval.expires_at ?? "never"}`,
          `  tool:         ${approval.call?.tool_name ?? "advisory request"}`,
          "",
          ...(approval.call !== undefined
            ? approval.call_arguments_redacted === true
              ? [
                  "Exact parked arguments: removed after the final outcome (secret-retention " +
                    "minimization); the ledger retains the call fingerprint.",
                  ""
                ]
              : ["Exact parked arguments:", JSON.stringify(approval.call.arguments, null, 2), ""]
            : []),
          ...(approval.amount_minor_units === "unknown"
            ? [
                "WARNING: Axiru could not extract the amount. Verify the exact arguments above.",
                `Approval requires: buzz-axiru approve ${approval.approval_id} --ack-unknown-amount`,
                ""
              ]
            : []),
          `Approve: buzz-axiru approve ${approval.approval_id} --by <name>`,
          `Deny:    buzz-axiru deny ${approval.approval_id} --by <name>`,
          ""
        ].join("\n")
      );
      return;
    }
    case "reconcile": {
      const id = positional[0];
      if (!id) {
        fail(
          "buzz-axiru reconcile: missing approval id or direct-call fingerprint (see: buzz-axiru pending)"
        );
      }
      const isDirectFingerprint = /^(?:sha256:)?[0-9a-f]{64}$/.test(id);
      if (!isDirectFingerprint && !/^(?:[0-9a-f]{12}|[0-9a-f]{32})$/.test(id)) {
        fail(
          "buzz-axiru reconcile: expected a 12/32 hex approval id or a sha256:<64-hex> direct-call fingerprint"
        );
      }
      const finalStatus = flags.outcome;
      if (finalStatus !== "executed" && finalStatus !== "failed") {
        fail("buzz-axiru reconcile: --outcome must be executed or failed");
      }
      const decidedBy = flags.by ?? "operator";
      if (
        decidedBy.length === 0 ||
        decidedBy.length > 100 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(decidedBy)
      ) {
        fail("buzz-axiru reconcile: --by must be 1-100 printable characters");
      }
      const note = flags.note;
      if (note === undefined || note.trim().length === 0 || note.length > 1_000) {
        fail(
          "buzz-axiru reconcile: --note is required (1-1000 characters; include provider evidence)"
        );
      }
      const now = new Date();
      if (isDirectFingerprint) {
        // A direct (policy-allowed) call with a lost outcome. The final
        // execution record clears the conservative cap reservation
        // (failed) or converts it to recorded spend and a permanent
        // duplicate barrier (executed). No approval store is involved.
        const fingerprint = id.startsWith("sha256:") ? id : `sha256:${id}`;
        const record = withDataDirLock(config.data_dir, () => {
          const incident = bridge.ledger.latestDirectExecution(fingerprint);
          if (incident === undefined || incident.execution_status !== "in_progress") {
            throw new Error(
              `buzz-axiru: no direct call with fingerprint ${fingerprint} is awaiting reconciliation ` +
                "(see: buzz-axiru pending)"
            );
          }
          return bridge.ledger.append({
            type: "execution",
            actor: decidedBy,
            agent_pubkey: incident.agent_pubkey,
            reason_code:
              finalStatus === "executed"
                ? "bridge.execution.reconciled_executed"
                : "bridge.execution.reconciled_failed",
            amount_minor_units: incident.amount_minor_units,
            currency: incident.currency,
            counterparty: incident.counterparty,
            memo: incident.memo,
            fingerprint,
            ...(incident.tool_name !== undefined ? { tool_name: incident.tool_name } : {}),
            execution_status: finalStatus,
            ...(finalStatus === "failed" ? { error: note } : {}),
            note,
            ts: now.toISOString()
          });
        });
        process.stdout.write(
          JSON.stringify(
            {
              fingerprint,
              execution_status: finalStatus,
              reconciled_by: decidedBy,
              note,
              ledger: { seq: record.seq, hash: record.hash }
            },
            null,
            2
          ) + "\n"
        );
        return;
      }
      const outcome = withDataDirLock(config.data_dir, () => {
        const current = bridge.approvals.get(id);
        if (!current) throw new Error(`buzz-axiru: no approval with id ${id}`);
        if (current.execution_status !== "in_progress" || current.status !== "granted") {
          throw new Error(
            `buzz-axiru: approval ${id} is not awaiting reconciliation ` +
              `(status=${current.status}, execution=${current.execution_status ?? "not_started"})`
          );
        }
        const record = bridge.ledger.append({
          type: "execution",
          actor: decidedBy,
          agent_pubkey: current.agent_pubkey,
          reason_code:
            finalStatus === "executed"
              ? "bridge.execution.reconciled_executed"
              : "bridge.execution.reconciled_failed",
          amount_minor_units: current.amount_minor_units,
          currency: current.currency,
          counterparty: current.counterparty,
          memo: current.memo,
          fingerprint: current.fingerprint,
          ...(current.call !== undefined ? { tool_name: current.call.tool_name } : {}),
          execution_status: finalStatus,
          approval_id: current.approval_id,
          ...(finalStatus === "failed" ? { error: note } : {}),
          note,
          ts: now.toISOString()
        });
        const approval =
          finalStatus === "executed"
            ? bridge.approvals.recordExecution(id, {
                status: "executed",
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        status: "executed_after_manual_reconciliation",
                        executed: true,
                        approval_id: id,
                        guidance:
                          "An operator confirmed this payment with the provider. Do not issue it again."
                      })
                    }
                  ],
                  isError: false
                },
                at: now
              })
            : bridge.approvals.recordExecution(id, {
                status: "failed",
                error: note,
                at: now
              });
        return { approval, record };
      });
      await notifyApprovalDecided(config, outcome.approval);
      process.stdout.write(
        JSON.stringify(
          {
            approval_id: outcome.approval.approval_id,
            execution_status: outcome.approval.execution_status,
            reconciled_by: decidedBy,
            note,
            ledger: { seq: outcome.record.seq, hash: outcome.record.hash }
          },
          null,
          2
        ) + "\n"
      );
      return;
    }
    case "approve":
    case "deny": {
      const id = positional[0];
      if (!id) fail(`buzz-axiru ${command}: missing approval id (see: buzz-axiru pending)`);
      if (!/^(?:[0-9a-f]{12}|[0-9a-f]{32})$/.test(id)) {
        fail(`buzz-axiru ${command}: approval id must be 12 or 32 lowercase hex characters`);
      }
      const now = new Date();
      const status: "granted" | "denied" = command === "approve" ? "granted" : "denied";
      const decidedBy = flags.by ?? "operator";
      if (
        decidedBy.length === 0 ||
        decidedBy.length > 100 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(decidedBy)
      ) {
        fail(`buzz-axiru ${command}: --by must be 1-100 printable characters`);
      }
      if (flags.note !== undefined && flags.note.length > 1_000) {
        fail(`buzz-axiru ${command}: --note must be 1000 characters or fewer`);
      }

      const outcome = withDataDirLock(config.data_dir, () => {
        const current = bridge.approvals.get(id);
        if (!current) throw new Error(`buzz-axiru: no approval with id ${id}`);
        if (current.status === "pending" && isExpired(current, now)) {
          // Record the expiry before publishing the state transition.
          const record = bridge.ledger.append({
            type: "approval_expired",
            actor: "bridge",
            agent_pubkey: current.agent_pubkey,
            reason_code: "bridge.expired.approval_ttl",
            amount_minor_units: current.amount_minor_units,
            currency: current.currency,
            counterparty: current.counterparty,
            memo: current.memo,
            fingerprint: current.fingerprint,
            approval_id: current.approval_id,
            ...(current.call !== undefined ? { tool_name: current.call.tool_name } : {}),
            ts: now.toISOString()
          });
          const expired = bridge.approvals.markExpired(id, now)!;
          return { kind: "expired" as const, approval: expired, record };
        }
        if (current.status !== "pending") {
          throw new Error(
            `buzz-axiru: approval ${id} was already ${current.status}` +
              (current.decided_by !== undefined ? ` by ${current.decided_by}` : "")
          );
        }
        if (
          status === "granted" &&
          current.amount_minor_units === "unknown" &&
          flags["ack-unknown-amount"] !== "true"
        ) {
          throw new Error(
            `buzz-axiru: approval ${id} has an unknown amount. Inspect the exact call with ` +
              `"buzz-axiru show ${id}", then repeat with --ack-unknown-amount only if it is safe.`
          );
        }
        // Write the human decision to the tamper-evident ledger before
        // making a grant visible to the gate's execution sweeper.
        const record = bridge.ledger.append({
          type: status === "granted" ? "approval_granted" : "approval_denied",
          actor: decidedBy,
          agent_pubkey: current.agent_pubkey,
          reason_code: status === "granted" ? "bridge.approval.granted" : "bridge.approval.denied",
          amount_minor_units: current.amount_minor_units,
          currency: current.currency,
          counterparty: current.counterparty,
          memo: current.memo,
          fingerprint: current.fingerprint,
          approval_id: current.approval_id,
          ...(current.call !== undefined ? { tool_name: current.call.tool_name } : {}),
          ...(flags.note !== undefined ? { note: flags.note } : {}),
          ts: now.toISOString()
        });
        const approval = bridge.approvals.decide(id, status, decidedBy, flags.note, now);
        return { kind: "decided" as const, approval, record };
      });

      if (outcome.kind === "expired") {
        await notifyApprovalDecided(config, outcome.approval);
        fail(
          `buzz-axiru ${command}: approval ${id} expired at ${outcome.approval.expires_at} ` +
            "and can no longer be decided. It was never executed."
        );
      }
      const { approval, record } = outcome;
      await notifyApprovalDecided(config, approval);
      process.stdout.write(
        JSON.stringify(
          {
            approval_id: approval.approval_id,
            status: approval.status,
            agent_pubkey: approval.agent_pubkey,
            amount_minor_units: approval.amount_minor_units,
            currency: approval.currency,
            counterparty: approval.counterparty,
            decided_by: decidedBy,
            ...(approval.call !== undefined ? { gated_tool: approval.call.tool_name } : {}),
            ledger: { seq: record.seq, hash: record.hash }
          },
          null,
          2
        ) + "\n"
      );
      if (status === "granted" && approval.call !== undefined) {
        process.stderr.write(
          "buzz-axiru: this approval is a parked tool call; the running gate " +
            "process will durably claim it, execute it at most once, and record the " +
            "outcome. If the process dies mid-call, Axiru will require manual " +
            "reconciliation instead of risking a duplicate payment.\n"
        );
      }
      return;
    }
    case "verify": {
      const ledgerPath = flags.ledger ?? join(config.data_dir, "ledger.jsonl");
      const result = verifyLedger(ledgerPath);
      process.stdout.write(JSON.stringify({ ledger: ledgerPath, ...result }, null, 2) + "\n");
      if (!result.ok) process.exit(1);
      return;
    }
    default:
      fail(`buzz-axiru: unknown command "${command}" (try: buzz-axiru help)`);
  }
}

main().catch((err) => {
  process.stderr.write(`buzz-axiru: ${(err as Error).message}\n`);
  process.exit(1);
});
