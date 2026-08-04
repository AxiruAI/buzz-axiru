#!/usr/bin/env node
/**
 * buzz-axiru CLI.
 *
 *   buzz-axiru                       start the MCP server on stdio (default)
 *   buzz-axiru serve                 same, explicit; --mode gate|advisory
 *   buzz-axiru init                  write a starter policies.json here
 *   buzz-axiru pending               list approvals waiting on a human
 *   buzz-axiru approve <id>          grant a pending approval
 *   buzz-axiru deny <id>             deny a pending approval
 *   buzz-axiru verify                re-derive the ledger hash chain
 *
 * Flags: --mode gate|advisory  --policies <path>  --data-dir <path>
 *        --by <name>  --note <text>  --force (init)
 * Env:   BUZZ_AXIRU_POLICIES, BUZZ_AXIRU_DATA_DIR, BUZZ_AXIRU_AGENT_PUBKEY
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isExpired } from "./approvals.js";
import { loadConfig } from "./config.js";
import { GateServer } from "./gate.js";
import { Bridge } from "./guard.js";
import { verifyLedger } from "./ledger.js";
import { McpServer } from "./mcp.js";
import { notifyApprovalDecided } from "./notify.js";
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
        "  buzz-axiru pending           list approvals waiting on a human",
        "  buzz-axiru approve <id>      grant a pending approval",
        "  buzz-axiru deny <id>         deny a pending approval",
        "  buzz-axiru verify            re-derive the decision ledger hash chain",
        "",
        "Flags: --mode gate|advisory  --policies <path>  --data-dir <path>",
        "       --by <name>  --note <text>  --force (init)",
        ""
      ].join("\n")
    );
    return;
  }

  if (command === "init") {
    runInit(flags);
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
