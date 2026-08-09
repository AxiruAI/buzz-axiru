#!/usr/bin/env node
/**
 * buzz-axiru CLI.
 *
 *   buzz-axiru                       start the MCP server on stdio (default)
 *   buzz-axiru serve                 same, explicit; --mode gate|advisory
 *   buzz-axiru init                  write a starter policies.json here
 *   buzz-axiru quickstart            detect your setup, write policies.json,
 *                                    print wiring steps; --check verifies it
 *   buzz-axiru pending               list approvals waiting on a human
 *   buzz-axiru approve <id>          grant a pending approval
 *   buzz-axiru deny <id>             deny a pending approval
 *   buzz-axiru reconcile <id>        resolve an ambiguous approved execution
 *   buzz-axiru verify                re-derive the ledger hash chain
 *
 * Flags: --mode gate|advisory  --policies <path>  --data-dir <path>
 *        --by <name>  --note <text>  --force (init, quickstart)
 *        --harness buzz|goose|claude-code|codex  --yes  --check (quickstart)
 * Env:   BUZZ_AXIRU_POLICIES, BUZZ_AXIRU_DATA_DIR, BUZZ_AXIRU_AGENT_PUBKEY
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
import { verifyLedger } from "./ledger.js";
import { withDataDirLock } from "./lock.js";
import { LATEST_PROTOCOL_VERSION, McpServer } from "./mcp.js";
import { formatAmount, notifyApprovalDecided } from "./notify.js";
import { DownstreamPool } from "./pool.js";
import {
  buildQuickstartPolicies,
  detectBuzzDevMcp,
  harnessNextSteps,
  writeQuickstartPolicies,
  HARNESSES
} from "./quickstart.js";
import { STARTER_POLICIES } from "./scaffold.js";

const VERSION = "0.5.0";

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
  "ack-unknown-amount"
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
  const detected = detectBuzzDevMcp();
  const agentPubkey = flags["agent-pubkey"] ?? process.env.BUZZ_AXIRU_AGENT_PUBKEY ?? null;
  if (agentPubkey !== null && !isPlausiblePubkey(agentPubkey)) {
    fail(
      "buzz-axiru quickstart: --agent-pubkey must be a 64-character lowercase hex Nostr pubkey or npub"
    );
  }
  // The shell entry is Buzz's bundled server. Other harnesses bring
  // their own tools, so their config starts in advisory mode with the
  // payment slot ready to move into the downstream array.
  const shell = harness === "buzz" ? detected : null;
  const path = resolve(flags.path ?? "policies.json");
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
        "                               --agent-pubkey <pubkey>, --force); --check starts the configured downstream",
        "                               servers, reports tool counts, and exits 0/1",
        "  buzz-axiru doctor            run the same security-readiness and connectivity check",
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
        "       --agent-pubkey <hex-or-npub> (quickstart)",
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
