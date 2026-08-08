/**
 * DownstreamPool: several downstream MCP servers behind the single MCP
 * slot Buzz gives an agent. Children are real stdio subprocesses
 * (test/fake-multi.ts, parameterised by env), so routing, collisions,
 * and death are exercised end to end rather than against a stub.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig, type DownstreamConfig } from "../src/config.js";
import { Bridge } from "../src/guard.js";
import { GateServer } from "../src/gate.js";
import { DownstreamPool } from "../src/pool.js";
import { AGENT_PUBKEY, NOON_UTC } from "./helpers.js";

const MULTI_PATH = fileURLToPath(new URL("./fake-multi.js", import.meta.url));
const FAKE_PATH = fileURLToPath(new URL("./fake-downstream.js", import.meta.url));

function server(
  name: string,
  tools: string[],
  overrides: Partial<DownstreamConfig> = {},
  extraEnv: Record<string, string> = {}
): DownstreamConfig {
  return {
    name,
    command: process.execPath,
    args: [MULTI_PATH],
    env: { FAKE_MULTI_NAME: name, FAKE_MULTI_TOOLS: tools.join(","), ...extraEnv },
    request_timeout_ms: 5000,
    hide_tools: [],
    tool_prefix: "",
    ...overrides
  };
}

async function started(configs: DownstreamConfig[]): Promise<DownstreamPool> {
  const pool = new DownstreamPool(configs);
  await pool.start("2025-06-18", "test");
  return pool;
}

function echoed(result: unknown): { server: string; tool: string; args: Record<string, unknown> } {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as { server: string; tool: string; args: Record<string, unknown> };
}

test("two servers merge their tool lists under one namespace", async () => {
  const pool = await started([server("shell", ["run", "read"]), server("pay", ["send"])]);
  try {
    const names = (await pool.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, ["read", "run", "send"]);
    assert.equal(pool.alive, true);
    assert.equal(pool.deadReason, null);
    // Instructions are attributed so an operator can tell them apart.
    assert.match(String(pool.instructions), /\[shell\] Instructions from shell\./);
    assert.match(String(pool.instructions), /\[pay\] Instructions from pay\./);
  } finally {
    pool.close();
  }
});

test("tool_prefix renames one server's tools and hide_tools drops them before prefixing", async () => {
  const pool = await started([
    server("shell", ["run", "secret"], { hide_tools: ["secret"] }),
    server("pay", ["send"], { tool_prefix: "pay_" })
  ]);
  try {
    const names = (await pool.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, ["pay_send", "run"]);
    assert.equal(pool.hasTool("secret"), false);
    assert.equal(pool.hasTool("send"), false, "the unprefixed name is not exposed");
    assert.equal(pool.serverFor("pay_send"), "pay");
  } finally {
    pool.close();
  }
});

test("a tool name collision is a startup error naming both servers", async () => {
  const pool = new DownstreamPool([server("shell", ["run"]), server("other", ["run"])]);
  await assert.rejects(
    () => pool.start("2025-06-18", "test"),
    (err: Error) => {
      assert.match(err.message, /collision on "run"/);
      assert.match(err.message, /shell/);
      assert.match(err.message, /other/);
      assert.match(err.message, /tool_prefix/);
      return true;
    }
  );
  pool.close();
});

test("callTool routes to the owning child using the original tool name", async () => {
  const pool = await started([
    server("shell", ["run"]),
    server("pay", ["run"], { tool_prefix: "pay_" })
  ]);
  try {
    const shell = echoed(await pool.callTool("run", { x: 1 }));
    assert.equal(shell.server, "shell");
    assert.equal(shell.tool, "run");
    assert.deepEqual(shell.args, { x: 1 });

    const pay = echoed(await pool.callTool("pay_run", { x: 2 }));
    assert.equal(pay.server, "pay");
    assert.equal(pay.tool, "run", "the child is called by the name it knows");

    await assert.rejects(() => pool.callTool("nope", {}), /Unknown tool: nope/);
  } finally {
    pool.close();
  }
});

test("one dead child makes the whole pool not-alive and names which one died", async () => {
  const pool = await started([
    server("shell", ["run"]),
    server("pay", ["boom"], {}, { FAKE_MULTI_DIE: "boom" })
  ]);
  try {
    await assert.rejects(() => pool.callTool("boom", {}));
    assert.equal(pool.alive, false, "a dead child cannot hide behind healthy siblings");
    assert.match(String(pool.deadReason), /^\[pay\]/);
    assert.match(String(pool.deadReason), /exited/);
  } finally {
    pool.close();
  }
});

test("start fails closed when any child cannot start", async () => {
  const pool = new DownstreamPool([
    server("shell", ["run"]),
    { ...server("ghost", ["x"]), command: "definitely-not-a-real-binary-9f3a" }
  ]);
  await assert.rejects(() => pool.start("2025-06-18", "test"), /refusing to run degraded/);
  pool.close();
});

test("non-tools methods go to the first server advertising the capability", async () => {
  const pool = await started([
    server("shell", ["run"]),
    server("res", ["fetch"]) // fake-multi advertises resources under the name "res"
  ]);
  try {
    const result = (await pool.request("resources/list")) as { resources: Array<{ uri: string }> };
    assert.equal(result.resources[0]!.uri, "mem://res");
    await assert.rejects(() => pool.request("prompts/list"), /Method not found: prompts\/list/);
  } finally {
    pool.close();
  }
});

/* ------------------------------------------------------------------ */
/* Back-compat: the single-object config form                          */
/* ------------------------------------------------------------------ */

function loadWith(downstream: unknown): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-pool-"));
  const policiesPath = join(dir, "policies.json");
  writeFileSync(
    policiesPath,
    JSON.stringify({
      rail: "x402",
      currency: "USD",
      controls: { per_agent_daily_cap: { cap_minor_units: "10000000" } },
      downstream,
      agent_pubkey: AGENT_PUBKEY,
      buzz: { channel_id: null, cli_path: "buzz" },
      webhook_url: null
    })
  );
  return loadConfig(policiesPath, join(dir, "data"));
}

test("a single downstream object still loads, normalized to a one-entry array", () => {
  const config = loadWith({ command: "/usr/local/bin/pay-mcp", args: ["--x"] });
  assert.equal(config.downstream!.length, 1);
  const entry = config.downstream![0]!;
  assert.equal(entry.command, "/usr/local/bin/pay-mcp");
  assert.equal(entry.name, "pay-mcp", "name defaults to the command basename");
  assert.equal(entry.tool_prefix, "");
  assert.equal(entry.request_timeout_ms, 30_000);
  assert.deepEqual(entry.hide_tools, []);
});

test("duplicate names and bad tool_prefix values are rejected at load", () => {
  assert.throws(
    () =>
      loadWith([
        { command: "a", name: "same" },
        { command: "b", name: "same" }
      ]),
    /duplicate downstream name "same"/
  );
  assert.throws(
    () => loadWith([{ command: "a" }, { command: "a" }]),
    /duplicate downstream name "a"/
  );
  assert.throws(() => loadWith([{ command: "a", tool_prefix: "pay!" }]), /tool_prefix/);
  assert.throws(() => loadWith([]), /empty array/);
});

test("gate mode over a single-object downstream behaves exactly as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-pool-gate-"));
  const policiesPath = join(dir, "policies.json");
  writeFileSync(
    policiesPath,
    JSON.stringify({
      rail: "x402",
      currency: "USD",
      controls: { per_agent_daily_cap: { cap_minor_units: "10000000" } },
      downstream: {
        command: process.execPath,
        args: [FAKE_PATH],
        hide_tools: ["crash_now"]
      },
      payment_tools: { gate: ["create_payment"], mappings: {} },
      agent_pubkey: AGENT_PUBKEY,
      buzz: { channel_id: null, cli_path: "buzz" },
      webhook_url: null
    })
  );
  const config = loadConfig(policiesPath, join(dir, "data"));
  const gate = new GateServer(new Bridge(config), "test", {
    clock: () => NOON_UTC,
    quiet: true
  });
  await gate.start();
  try {
    const raw = await gate.handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    );
    const tools = (JSON.parse(raw!).result as { tools: Array<Record<string, unknown>> }).tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("request_spend_approval"));
    assert.ok(names.includes("create_payment"));
    assert.ok(names.includes("get_weather"));
    assert.ok(!names.includes("crash_now"), "hidden tools stay hidden");

    const call = await gate.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_weather", arguments: { city: "Lisbon" } }
      })
    );
    const content = (JSON.parse(call!).result as { content: Array<{ text: string }> }).content;
    assert.equal(content[0]!.text, "sunny in Lisbon");

    const hidden = await gate.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "crash_now", arguments: {} }
      })
    );
    assert.match(String((JSON.parse(hidden!).error as { message: string }).message), /Unknown tool/);
  } finally {
    gate.close();
  }
});

test("gate mode fans out across two servers and gates only the prefixed money tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-pool-multi-"));
  const policiesPath = join(dir, "policies.json");
  writeFileSync(
    policiesPath,
    JSON.stringify({
      rail: "x402",
      currency: "USD",
      controls: { per_agent_daily_cap: { cap_minor_units: "10000000" } },
      downstream: [
        {
          name: "shell",
          command: process.execPath,
          args: [MULTI_PATH],
          env: { FAKE_MULTI_NAME: "shell", FAKE_MULTI_TOOLS: "shell_exec" }
        },
        {
          name: "payments",
          command: process.execPath,
          args: [MULTI_PATH],
          env: { FAKE_MULTI_NAME: "payments", FAKE_MULTI_TOOLS: "send" },
          tool_prefix: "pay_"
        }
      ],
      payment_tools: { gate: ["pay_*"], mappings: {} },
      agent_pubkey: AGENT_PUBKEY,
      buzz: { channel_id: null, cli_path: "buzz" },
      webhook_url: null
    })
  );
  const config = loadConfig(policiesPath, join(dir, "data"));
  const gate = new GateServer(new Bridge(config), "test", {
    clock: () => NOON_UTC,
    quiet: true
  });
  await gate.start();
  try {
    assert.equal(gate.gateAll, false);
    assert.equal(gate.isGated("shell_exec"), false, "the shell stays usable");
    assert.equal(gate.isGated("pay_send"), true);

    // The shell tool passes straight through to its own server.
    const shell = await gate.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "shell_exec", arguments: { cmd: "ls" } }
      })
    );
    const echo = echoed(JSON.parse(shell!).result);
    assert.equal(echo.server, "shell");
    assert.equal(echo.tool, "shell_exec");

    // The payment tool is gated: no mapping, so it parks rather than paying.
    const pay = await gate.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "pay_send", arguments: { amount: 100 } }
      })
    );
    const content = (JSON.parse(pay!).result as { content: Array<{ text: string }> }).content;
    const body = JSON.parse(content[0]!.text) as Record<string, unknown>;
    assert.equal(body.status, "pending_approval");
    assert.equal(body.reason_code, "bridge.pending.no_payment_mapping");
  } finally {
    gate.close();
  }
});
