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
 *   buzz-axiru verify                re-derive the ledger hash chain
 *
 * Flags: --mode gate|advisory  --policies <path>  --data-dir <path>
 *        --by <name>  --note <text>  --force (init, quickstart)
 *        --harness buzz|goose|claude-code|codex  --yes  --check (quickstart)
 * Env:   BUZZ_AXIRU_POLICIES, BUZZ_AXIRU_DATA_DIR, BUZZ_AXIRU_AGENT_PUBKEY
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isExpired } from "./approvals.js";
import { isGatedTool, loadConfig } from "./config.js";
import { GateServer } from "./gate.js";
import { Bridge } from "./guard.js";
import { verifyLedger } from "./ledger.js";
import { LATEST_PROTOCOL_VERSION, McpServer } from "./mcp.js";
import { notifyApprovalDecided } from "./notify.js";
import { DownstreamPool } from "./pool.js";
import {
  buildQuickstartPolicies,
  detectBuzzDevMcp,
  harnessNextSteps,
  writeQuickstartPolicies,
  HARNESSES
} from "./quickstart.js";
import { STARTER_POLICIES } from "./scaffold.js";

const VERSION = "0.2.0";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let command = "serve";
  let commandSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
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
  writeFileSync(path, STARTER_POLICIES, "utf8");
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
 * `buzz-axiru quickstart`: the one-command install. Detects the shell
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
  // The shell entry is Buzz's bundled server. Other harnesses bring
  // their own tools, so their config starts in advisory mode with the
  // payment slot ready to move into the downstream array.
  const shell = harness === "buzz" ? detected : null;
  const path = resolve(flags.path ?? "policies.json");
  try {
    writeQuickstartPolicies(path, buildQuickstartPolicies(shell), flags.force === "true");
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
  process.stdout.write(`buzz-axiru ${VERSION} check\npolicies: ${config.config_path}\n\n`);
  if (config.downstream === null) {
    process.stdout.write(
      "downstream: null (advisory mode; no servers to start)\n" +
        "Config loads. Add a downstream server to run the enforcing gate.\n"
    );
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
    process.stdout.write("OK: every downstream server started and answered tools/list.\n");
  } catch (err) {
    process.stdout.write(`FAILED: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    pool.close();
  }
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (command === "--version" || command === "version") {
    process.stdout.write(`buzz-axiru ${VERSION}\n`);
    return;
  }
  if (command === "--help" || command === "help") {
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
        "                               --force); --check starts the configured downstream",
        "                               servers, reports tool counts, and exits 0/1",
        "  buzz-axiru pending           list approvals waiting on a human",
        "  buzz-axiru approve <id>      grant a pending approval",
        "  buzz-axiru deny <id>         deny a pending approval",
        "  buzz-axiru verify            re-derive the decision ledger hash chain",
        "",
        "Flags: --mode gate|advisory  --policies <path>  --data-dir <path>",
        "       --by <name>  --note <text>  --force (init, quickstart)",
        "       --harness buzz|goose|claude-code|codex  --yes  --check (quickstart)",
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
      // Sweep the queue so granted parked calls are replayed and
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
      process.stdout.write(JSON.stringify(bridge.approvals.pending(), null, 2) + "\n");
      return;
    }
    case "approve":
    case "deny": {
      const id = positional[0];
      if (!id) fail(`buzz-axiru ${command}: missing approval id (see: buzz-axiru pending)`);
      const now = new Date();
      const overdue = bridge.approvals.get(id);
      if (overdue && overdue.status === "pending" && isExpired(overdue, now)) {
        const expired = bridge.approvals.markExpired(id, now);
        if (expired) {
          bridge.ledger.append({
            type: "approval_expired",
            actor: "bridge",
            agent_pubkey: expired.agent_pubkey,
            reason_code: "bridge.expired.approval_ttl",
            amount_minor_units: expired.amount_minor_units,
            currency: expired.currency,
            counterparty: expired.counterparty,
            memo: expired.memo,
            fingerprint: expired.fingerprint,
            approval_id: expired.approval_id,
            ...(expired.call !== undefined ? { tool_name: expired.call.tool_name } : {}),
            ts: now.toISOString()
          });
          await notifyApprovalDecided(config, expired);
        }
        fail(
          `buzz-axiru ${command}: approval ${id} expired at ${overdue.expires_at} ` +
            "and can no longer be decided. It was never executed."
        );
      }
      const status = command === "approve" ? "granted" : "denied";
      const decidedBy = flags.by ?? "operator";
      const approval = bridge.approvals.decide(id, status, decidedBy, flags.note, now);
      const record = bridge.ledger.append({
        type: status === "granted" ? "approval_granted" : "approval_denied",
        actor: decidedBy,
        agent_pubkey: approval.agent_pubkey,
        reason_code: status === "granted" ? "bridge.approval.granted" : "bridge.approval.denied",
        amount_minor_units: approval.amount_minor_units,
        currency: approval.currency,
        counterparty: approval.counterparty,
        memo: approval.memo,
        fingerprint: approval.fingerprint,
        approval_id: approval.approval_id,
        ...(approval.call !== undefined ? { tool_name: approval.call.tool_name } : {}),
        ...(flags.note !== undefined ? { note: flags.note } : {})
      });
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
            "process will execute it against the downstream server within a few " +
            "seconds and record the outcome in the ledger.\n"
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
