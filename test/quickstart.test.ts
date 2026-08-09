/**
 * quickstart: buzz-dev-mcp detection order, generated-config validity
 * (the file must load through loadConfig, multi-downstream shape and
 * all), overwrite refusal, and per-harness next-step snippets.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isGatedTool, loadConfig } from "../src/config.js";
import {
  buildQuickstartPolicies,
  detectBuzzDevMcp,
  harnessNextSteps,
  writeQuickstartPolicies,
  HARNESSES
} from "../src/quickstart.js";
import { AGENT_PUBKEY } from "./helpers.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "buzz-axiru-quickstart-"));
}

test("generated config is valid, credential-free, and loads through loadConfig", () => {
  const content = buildQuickstartPolicies(
    { command: "buzz-dev-mcp", source: "PATH (/usr/local/bin/buzz-dev-mcp)" },
    AGENT_PUBKEY
  );
  const parsed = JSON.parse(content) as Record<string, unknown>;
  assert.ok(Array.isArray(parsed.downstream), "downstream should be an array");
  assert.doesNotMatch(content, /sk_(?:test|live)_/);
  assert.equal(parsed.agent_pubkey, AGENT_PUBKEY);

  const dir = tempDir();
  const path = join(dir, "policies.json");
  writeFileSync(path, content, "utf8");
  const config = loadConfig(path, join(dir, "data"));

  assert.ok(config.downstream !== null);
  assert.equal(config.downstream.length, 1);
  const shell = config.downstream[0]!;
  assert.equal(shell.name, "shell");
  assert.equal(shell.command, "buzz-dev-mcp");
  assert.equal(shell.tool_prefix, "");
  assert.deepEqual(shell.env_passthrough, ["PATH", "HOME", "TMPDIR"]);
  assert.ok(config.payment_tools !== null);
  assert.deepEqual(config.payment_tools.gate, ["pay_*"]);
  // The whole point of the pay_ split: money tools gated, shell tools not.
  assert.equal(isGatedTool(config, "pay_create_payment"), true);
  assert.equal(isGatedTool(config, "run_shell_command"), false);
  // The disabled payment slot must stay a $-key, invisible to the loader.
  assert.ok("$downstream_payment_slot" in parsed);
  const paymentSlot = parsed.$downstream_payment_slot as Record<string, unknown>;
  assert.deepEqual(paymentSlot.env, {});
  assert.match(JSON.stringify(paymentSlot.args), /PIN_REVIEWED_VERSION/);
  assert.deepEqual(paymentSlot.env_passthrough, [
    "PATH",
    "HOME",
    "TMPDIR",
    "STRIPE_SECRET_KEY"
  ]);
});

test("generated config without a shell server loads in advisory mode", () => {
  const content = buildQuickstartPolicies(null);
  const dir = tempDir();
  const path = join(dir, "policies.json");
  writeFileSync(path, content, "utf8");
  const config = loadConfig(path, join(dir, "data"));
  assert.equal(config.downstream, null);
  assert.ok(config.payment_tools !== null, "matcher stays ready for gate mode");
});

test("the disabled payment slot must be explicitly version-pinned before enabling", () => {
  const parsed = JSON.parse(buildQuickstartPolicies(null)) as Record<string, unknown>;
  parsed.downstream = [parsed.$downstream_payment_slot];
  const dir = tempDir();
  const path = join(dir, "policies.json");
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  assert.throws(() => loadConfig(path, join(dir, "data")), /still contains PIN_REVIEWED_VERSION/);
});

test("refuses to overwrite an existing policies.json without force", () => {
  const dir = tempDir();
  const path = join(dir, "policies.json");
  writeFileSync(path, "{\"precious\": true}", "utf8");
  assert.throws(
    () => writeQuickstartPolicies(path, buildQuickstartPolicies(null), false),
    (err: Error) => err.message.includes("already exists (use --force to overwrite)")
  );
  assert.equal(readFileSync(path, "utf8"), "{\"precious\": true}", "file untouched");
  writeQuickstartPolicies(path, buildQuickstartPolicies(null), true);
  assert.ok(readFileSync(path, "utf8").includes("$downstream_payment_slot"));
});

test("harness snippet selection covers every harness and rejects junk", () => {
  const buzz = harnessNextSteps("buzz");
  assert.ok(buzz.includes("export BUZZ_ACP_MCP_COMMAND=buzz-axiru"));
  // The env var is raw-buzz-acp-only; Desktop users must be routed to
  // adopt, because the app reserves the variable and has no UI field.
  assert.ok(buzz.includes("buzz-axiru adopt --agent <name>"));
  assert.ok(buzz.includes("Quit Buzz Desktop"));
  const goose = harnessNextSteps("goose");
  assert.ok(goose.includes("~/.config/goose/config.yaml"));
  assert.ok(goose.includes("verify against your goose version"));
  const claude = harnessNextSteps("claude-code");
  assert.ok(claude.includes("claude mcp add buzz-axiru -- buzz-axiru serve"));
  const codex = harnessNextSteps("codex");
  assert.ok(codex.includes("[mcp_servers.buzz-axiru]"));
  assert.ok(codex.includes("~/.codex/config.toml"));
  for (const harness of HARNESSES) {
    assert.ok(harnessNextSteps(harness).includes("buzz-axiru doctor"));
  }
  assert.throws(() => harnessNextSteps("aider"), /unknown harness "aider"/);
});

test("detection prefers BUZZ_ACP_MCP_COMMAND, then PATH, then gives up", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "buzz-dev-mcp"), "#!/bin/sh\n", "utf8");

  const viaEnv = detectBuzzDevMcp(
    { BUZZ_ACP_MCP_COMMAND: "/opt/buzz/buzz-dev-mcp", PATH: dir },
    "linux"
  );
  assert.deepEqual(viaEnv, {
    command: "/opt/buzz/buzz-dev-mcp",
    source: "BUZZ_ACP_MCP_COMMAND"
  });

  const viaPath = detectBuzzDevMcp({ PATH: dir }, "linux");
  assert.ok(viaPath !== null);
  assert.equal(viaPath.command, "buzz-dev-mcp");
  assert.ok(viaPath.source.includes(dir));

  const nowhere = detectBuzzDevMcp({ PATH: join(dir, "empty") }, "linux");
  assert.equal(nowhere, null);
});

test("detection skips an env var that points back at buzz-axiru itself", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "buzz-dev-mcp"), "#!/bin/sh\n", "utf8");
  const detected = detectBuzzDevMcp(
    { BUZZ_ACP_MCP_COMMAND: "/usr/local/bin/buzz-axiru", PATH: dir },
    "linux"
  );
  assert.ok(detected !== null);
  assert.equal(detected.command, "buzz-dev-mcp", "falls through to PATH, no self-gating");
});
