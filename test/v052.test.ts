/**
 * 0.5.2 regression tests: downstream commands given as bare names must
 * resolve against the PARENT process PATH before spawning.
 *
 * Field report (a Buzz agent, August 2026): after upgrading past 0.4.0,
 * a pre-0.4 config whose downstream.command was a bare name failed with
 * `spawn buzz-dev-mcp ENOENT` even though `which buzz-dev-mcp`
 * succeeded in the parent shell. Cause: env_passthrough now defaults to
 * "none", the child env therefore has no PATH, and Node resolves the
 * executable against the CHILD env's PATH. These tests reproduce that
 * setup with a scratch executable and pin the fix: resolution happens
 * in the parent, and the child environment is left exactly as
 * configured (no quiet PATH injection).
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import {
  childEnv,
  fileLimitWarning,
  resolveCommand,
  softMaxFiles,
  MIN_RECOMMENDED_MAXFILES
} from "../src/downstream.js";
import { GateServer } from "../src/gate.js";
import { Bridge } from "../src/guard.js";
import { McpServer } from "../src/mcp.js";
import { DownstreamPool } from "../src/pool.js";
import { AGENT_PUBKEY, makeBridge } from "./helpers.js";

const FAKE_PATH = fileURLToPath(new URL("./fake-downstream.js", import.meta.url));

/**
 * A scratch executable on PATH, standing in for buzz-dev-mcp: a shell
 * wrapper that dumps its own environment to a file (so tests can see
 * exactly what the child inherited) and then execs the fake downstream
 * server. Interpreter and script paths are baked in absolute because
 * the child env deliberately has no PATH to resolve them with.
 */
function writeScratchServer(dir: string, name: string, envDumpPath: string): string {
  const path = join(dir, name);
  const script = [
    "#!/bin/sh",
    `env > ${JSON.stringify(envDumpPath)}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_PATH)} "$@"`,
    ""
  ].join("\n");
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

/** A legacy-shaped policies.json: note there is NO env_passthrough key. */
function legacyConfig(dir: string, downstream: Record<string, unknown>): ReturnType<typeof loadConfig> {
  const policiesPath = join(dir, "policies.json");
  writeFileSync(
    policiesPath,
    JSON.stringify({
      rail: "x402",
      currency: "USD",
      controls: { per_agent_daily_cap: { cap_minor_units: "10000000" } },
      downstream,
      payment_tools: { gate: ["create_payment"], mappings: {} },
      agent_pubkey: AGENT_PUBKEY,
      buzz: { channel_id: null, cli_path: "buzz" },
      webhook_url: null
    })
  );
  return loadConfig(policiesPath, join(dir, "data"));
}

async function withScratchOnPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = previous;
  }
}

/* ------------------------------------------------------------------ */
/* resolveCommand unit behaviour                                       */
/* ------------------------------------------------------------------ */

test("a bare command name resolves to an absolute path via the given PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-"));
  const expected = writeScratchServer(dir, "scratch-mcp", join(dir, "env.txt"));
  assert.equal(resolveCommand("scratch-mcp", { PATH: dir }), expected);
});

test("a command containing a path separator is returned untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-"));
  writeScratchServer(dir, "scratch-mcp", join(dir, "env.txt"));
  // Even with a same-named executable sitting on PATH, an explicit
  // location is the operator's word and must not be second-guessed.
  assert.equal(resolveCommand("/opt/none/scratch-mcp", { PATH: dir }), "/opt/none/scratch-mcp");
  assert.equal(resolveCommand("./scratch-mcp", { PATH: dir }), "./scratch-mcp");
});

test("an unresolvable bare command fails closed with an actionable message", () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-empty-"));
  assert.throws(
    () => resolveCommand("no-such-server-3c1f", { PATH: dir }),
    (err: Error) => {
      assert.match(err.message, /"no-such-server-3c1f"/);
      assert.match(err.message, /not found on the gate's PATH/);
      assert.match(err.message, /absolute path in policies\.json/);
      return true;
    }
  );
});

test("npx, the 0.5.0 strict-pinning shape, resolves like any bare command", () => {
  // The pinned form `npx -y package@1.2.3` still names npx barely, so
  // it would have hit the same ENOENT under the "none" default.
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-npx-"));
  const expected = writeScratchServer(dir, "npx", join(dir, "env.txt"));
  assert.equal(resolveCommand("npx", { PATH: dir }), expected);
});

/* ------------------------------------------------------------------ */
/* End-to-end reproduction of the field report                         */
/* ------------------------------------------------------------------ */

test("legacy config with a bare command on the parent PATH starts, and the child env stays sealed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-e2e-"));
  const envDump = join(dir, "child-env.txt");
  writeScratchServer(dir, "scratch-buzz-dev-mcp", envDump);
  const config = legacyConfig(dir, { command: "scratch-buzz-dev-mcp", args: [] });
  const spec = config.downstream![0]!;
  assert.equal(spec.env_passthrough, "none", "the legacy config parses to the secure default");

  const canary = "BUZZ_AXIRU_V052_CANARY";
  process.env[canary] = "must-not-leak";
  try {
    await withScratchOnPath(dir, async () => {
      const pool = new DownstreamPool(config.downstream!);
      try {
        await pool.start("2025-06-18", "test");
        assert.equal(pool.alive, true, "the field-reported ENOENT is gone");
        const names = (await pool.listTools()).map((t) => t.name);
        assert.ok(names.includes("create_payment"));
      } finally {
        pool.close();
      }
    });
    // Resolution ran in the parent; the child must not have inherited
    // parent variables, and PATH must not have been quietly added.
    const inherited = readFileSync(envDump, "utf8");
    assert.ok(!inherited.includes(canary), "parent canary variable leaked into the child");
    assert.ok(!inherited.includes("must-not-leak"));
    assert.equal("PATH" in childEnv(spec), false, "none mode still passes no PATH to the child");
  } finally {
    delete process.env[canary];
  }
});

test("pool startup surfaces the improved not-found message for a missing bare command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-miss-"));
  const config = legacyConfig(dir, { command: "definitely-absent-server-77aa", args: [] });
  const pool = new DownstreamPool(config.downstream!);
  await assert.rejects(
    () => pool.start("2025-06-18", "test"),
    (err: Error) => {
      assert.match(err.message, /refusing to run degraded/);
      assert.match(err.message, /"definitely-absent-server-77aa"/);
      assert.match(err.message, /not found on the gate's PATH/);
      return true;
    }
  );
  pool.close();
});

/* ------------------------------------------------------------------ */
/* axiru_gate_status: the in-band evidence probe                       */
/* ------------------------------------------------------------------ */

async function rpc(
  server: { handleMessage(raw: string): Promise<string | null> },
  method: string,
  params?: Record<string, unknown>,
  id = 1
): Promise<Record<string, unknown>> {
  const raw = await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return JSON.parse(raw!) as Record<string, unknown>;
}

function statusOf(reply: Record<string, unknown>): Record<string, unknown> {
  const result = reply.result as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, false, "the status probe must never be an error");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** A gate over the scripted fake downstream, with injectable payment_tools. */
async function makeStatusGate(paymentTools: unknown): Promise<{
  gate: GateServer;
  bridge: Bridge;
  close: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-status-"));
  const policiesPath = join(dir, "policies.json");
  writeFileSync(
    policiesPath,
    JSON.stringify({
      rail: "x402",
      currency: "USD",
      controls: {
        per_agent_daily_cap: { cap_minor_units: "10000000" },
        single_payment_ceiling: { threshold_minor_units: "2500000" }
      },
      downstream: { command: process.execPath, args: [FAKE_PATH] },
      payment_tools: paymentTools,
      agent_pubkey: AGENT_PUBKEY,
      buzz: { channel_id: null, cli_path: "buzz" },
      webhook_url: null
    })
  );
  const config = loadConfig(policiesPath, join(dir, "data"));
  const bridge = new Bridge(config);
  const gate = new GateServer(bridge, "0.5.2", { quiet: true });
  await gate.start();
  return { gate, bridge, close: () => gate.close() };
}

test("advisory mode lists axiru_gate_status and answers it with mode evidence", async () => {
  const ctx = makeBridge();
  const server = new McpServer(ctx.bridge, "0.5.2");
  const list = await rpc(server, "tools/list");
  const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.deepEqual(names, ["request_spend_approval", "axiru_gate_status"]);

  const status = statusOf(await rpc(server, "tools/call", { name: "axiru_gate_status", arguments: {} }, 2));
  assert.equal(status.version, "0.5.2");
  assert.equal(status.mode, "advisory", "an agent must be able to see that nothing is enforced");
  assert.equal(status.policy_path, ctx.config.config_path);
  assert.deepEqual(status.downstream, []);
  assert.deepEqual(status.gated_tools, { count: 0, names: [] });
  const ledger = status.ledger as { records: number; head_hash: string };
  assert.equal(ledger.records, 0);
  assert.equal(ledger.head_hash, "0".repeat(64), "empty ledger reports the genesis hash");
  assert.equal(status.pending_approvals, 0);
});

test("gate mode status reports servers up, gated tool names, ledger head, and pending approvals", async () => {
  const ctx = await makeStatusGate({
    gate: ["create_payment", "refund_*"],
    mappings: {
      create_payment: {
        amount_field: "amount",
        currency_field: "currency",
        counterparty_field: "destination"
      }
    }
  });
  try {
    const list = await rpc(ctx.gate, "tools/list");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(names.includes("axiru_gate_status"));

    // Park one approval so the pending count is observable evidence.
    await rpc(ctx.gate, "tools/call", {
      name: "create_payment",
      arguments: { amount: 4000000, currency: "USD", destination: "acme-datacenter.example" }
    }, 2);

    const status = statusOf(await rpc(ctx.gate, "tools/call", { name: "axiru_gate_status", arguments: {} }, 3));
    assert.equal(status.mode, "gate");
    assert.equal(status.agent_pubkey, AGENT_PUBKEY);
    const downstream = status.downstream as Array<{ name: string; up: boolean; tools: number }>;
    assert.equal(downstream.length, 1);
    assert.equal(downstream[0]!.up, true);
    assert.ok(downstream[0]!.tools > 0, "tool counts come from the live catalog");
    const gated = status.gated_tools as { count: number; names: string[] };
    assert.ok(gated.names.includes("create_payment"));
    assert.equal(gated.count, gated.names.length);
    const ledger = status.ledger as { records: number; head_hash: string };
    assert.ok(ledger.records >= 1, "the parked decision is in the ledger");
    assert.match(ledger.head_hash, /^[0-9a-f]{64}$/);
    assert.equal(status.pending_approvals, 1);
  } finally {
    ctx.close();
  }
});

test("the status probe is never gated, even by matchers that cover its name", async () => {
  // "*" gates every downstream tool, and axiru_* would match the probe
  // by name. The probe answers anyway: it is the gate's own tool, and
  // parking it would destroy the one in-band way to verify the gate.
  const ctx = await makeStatusGate({ gate: ["axiru_*", "*"], mappings: {} });
  try {
    const status = statusOf(await rpc(ctx.gate, "tools/call", { name: "axiru_gate_status", arguments: {} }, 4));
    assert.equal(status.tool, "axiru_gate_status");
    assert.equal(status.mode, "gate");
    assert.equal(status.pending_approvals, 0, "the probe itself must never be parked");
    const gated = status.gated_tools as { count: number; names: string[] };
    assert.ok(!gated.names.includes("axiru_gate_status"));
    assert.ok(!gated.names.includes("request_spend_approval"));
  } finally {
    ctx.close();
  }
});

/* ------------------------------------------------------------------ */
/* Low file-descriptor limits guard                                    */
/* ------------------------------------------------------------------ */

test("softMaxFiles parses the ulimit probe and fails quiet on anything odd", () => {
  assert.equal(softMaxFiles(() => "256"), 256);
  assert.equal(softMaxFiles(() => "65536"), 65536);
  assert.equal(softMaxFiles(() => "unlimited"), null);
  assert.equal(softMaxFiles(() => null), null);
  assert.equal(softMaxFiles(() => "not-a-number"), null);
});

test("fileLimitWarning names the launchctl fix below the threshold and stays quiet above it", () => {
  const warning = fileLimitWarning(256);
  assert.ok(warning !== null);
  assert.match(warning, /256/);
  assert.match(warning, /EAGAIN \(os error 35\)/);
  assert.match(warning, /launchctl limit maxfiles/);
  assert.match(warning, /keeps running/, "the guard warns, it never fails startup");
  assert.equal(fileLimitWarning(MIN_RECOMMENDED_MAXFILES), null);
  assert.equal(fileLimitWarning(65536), null);
  assert.equal(fileLimitWarning(null), null, "an unknowable limit is not worth a false alarm");
});

test("an explicit env_passthrough allowlist keeps working with a bare command", async () => {
  // Quickstart-generated configs pass PATH through explicitly; they
  // worked before this fix and must keep working after it.
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-v052-allow-"));
  writeScratchServer(dir, "scratch-allow-mcp", join(dir, "env.txt"));
  const config = legacyConfig(dir, {
    command: "scratch-allow-mcp",
    args: [],
    env_passthrough: ["PATH", "HOME", "TMPDIR"]
  });
  await withScratchOnPath(dir, async () => {
    const pool = new DownstreamPool(config.downstream!);
    try {
      await pool.start("2025-06-18", "test");
      assert.equal(pool.alive, true);
    } finally {
      pool.close();
    }
  });
});
