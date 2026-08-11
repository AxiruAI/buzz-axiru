/**
 * MCP server request/response shape, exercised over a real stdio
 * subprocess exactly as buzz-acp would spawn it.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_PUBKEY, TEST_POLICY_DOC } from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

let child: ChildProcessWithoutNullStreams;
let replies: Array<(line: string) => void>;

function send(message: object): void {
  child.stdin.write(JSON.stringify(message) + "\n");
}

function nextLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for MCP reply")), 10_000);
    replies.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

async function request(message: object): Promise<Record<string, unknown>> {
  send(message);
  return JSON.parse(await nextLine()) as Record<string, unknown>;
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-axiru-mcp-"));
  const policiesPath = join(dir, "policies.json");
  writeFileSync(policiesPath, JSON.stringify(TEST_POLICY_DOC));

  replies = [];
  child = spawn(process.execPath, [CLI_PATH, "serve"], {
    env: {
      ...process.env,
      BUZZ_AXIRU_POLICIES: policiesPath,
      BUZZ_AXIRU_DATA_DIR: join(dir, "data")
    },
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessWithoutNullStreams;

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    const handler = replies.shift();
    if (handler) handler(line);
  });
});

after(() => {
  child.kill();
});

test("initialize negotiates a protocol version and announces tools", async () => {
  const reply = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "buzz-acp-test", version: "0.0.0" }
    }
  });
  const result = reply.result as Record<string, unknown>;
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal((result.serverInfo as Record<string, unknown>).name, "buzz-axiru");

  // Notification: no reply expected.
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
});

test("tools/list exposes request_spend_approval and the status probe, nothing else", async () => {
  const reply = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (reply.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, "request_spend_approval");
  assert.equal(tools[1]!.name, "axiru_gate_status");
  const schema = tools[0]!.inputSchema as { required: string[] };
  assert.deepEqual(
    [...schema.required].sort(),
    ["agent_pubkey", "amount_minor_units", "counterparty", "currency", "memo"]
  );
});

test("tools/call with a large amount returns require_approval and an approval id", async () => {
  const reply = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "request_spend_approval",
      arguments: {
        amount_minor_units: "4000000",
        currency: "USD",
        counterparty: "acme-datacenter.example",
        memo: "Q3 GPU cluster prepay",
        agent_pubkey: AGENT_PUBKEY
      }
    }
  });
  const result = reply.result as {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(result.isError, false);
  assert.equal(result.content[0]!.type, "text");
  const decision = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  assert.equal(decision.decision, "require_approval");
  assert.equal(decision.agent_pubkey, AGENT_PUBKEY);
  assert.ok(decision.approval_id);
  assert.match(String(decision.fingerprint), /^sha256:[0-9a-f]{64}$/);
});

test("tools/call with malformed arguments returns an in-band tool error", async () => {
  const reply = await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "request_spend_approval",
      arguments: {
        amount_minor_units: "forty grand",
        currency: "USD",
        counterparty: "acme-datacenter.example",
        memo: "nope",
        agent_pubkey: AGENT_PUBKEY
      }
    }
  });
  const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /integer string/);
});

test("unknown tools and unknown methods are JSON-RPC errors", async () => {
  const unknownTool = await request({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "transfer_everything", arguments: {} }
  });
  assert.equal((unknownTool.error as Record<string, unknown>).code, -32602);

  const unknownMethod = await request({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal((unknownMethod.error as Record<string, unknown>).code, -32601);
});
