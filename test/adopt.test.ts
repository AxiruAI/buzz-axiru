/**
 * adopt: managed-agents.json shape tolerance (array, keyed object, both
 * mcp command spellings), file discovery across both platform layouts,
 * the running-Buzz-Desktop refusal via the injectable predicate, and
 * the CLI's dry-run, backup, confirm, and unset behavior.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  backupPathFor,
  buildCustomHarness,
  buzzDesktopRunning,
  customHarnessPathFor,
  dedupeAgents,
  describeStructure,
  findManagedAgentsFiles,
  locateAgents,
  mergeCodexToml,
  mergeMcpJson,
  planSpaceFreeGatePath,
  refuseIfBuzzDesktopRunning,
  selectAgentGroup,
  setAgentMcpCommand,
  setAgentRuntime,
  writeGateShim,
  BUZZ_ACP_BINARY
} from "../src/adopt.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "buzz-axiru-adopt-"));
}

/**
 * CLI runs pass --force: the suite must be hermetic, and without it the
 * real process scan would fail these tests on any machine that happens
 * to have Buzz Desktop open. The refusal path itself is covered through
 * the injectable predicate below.
 */
function runCli(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI_PATH, "adopt", "--force", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

const ARRAY_DOC = [
  { name: "Axiru", mcp_command: "", model: "claude" },
  { name: "Scout", mcp_command: "/usr/local/bin/other-mcp" }
];

const KEYED_DOC = {
  version: 2,
  agents: {
    "id-1": { name: "Axiru", mcpCommand: "", temperature: 0.2 },
    "id-2": { name: "Scout", mcpCommand: "" }
  }
};

test("locateAgents finds a top-level array of agents", () => {
  const found = locateAgents(structuredClone(ARRAY_DOC));
  assert.ok(found !== null);
  assert.equal(found.agents.length, 2);
  assert.equal(found.location, "top-level array");
});

test("locateAgents finds a keyed object under an agents key, and a top-level keyed object", () => {
  const nested = locateAgents(structuredClone(KEYED_DOC));
  assert.ok(nested !== null);
  assert.equal(nested.agents.length, 2);
  assert.equal(nested.location, 'keyed object under "agents"');

  const flat = locateAgents({ a: { name: "Axiru" }, b: { name: "Scout" } });
  assert.ok(flat !== null);
  assert.equal(flat.location, "top-level keyed object");
});

test("an unrecognizable shape yields null plus a snippet-free structural description", () => {
  const doc = { schema: 3, blob: "SECRET-TOKEN-VALUE", entries: [1, 2, 3] };
  assert.equal(locateAgents(doc), null);
  const description = describeStructure(doc);
  // Key names and types only; the refusal must never echo values.
  assert.match(description, /"blob": string/);
  assert.match(description, /"entries": array\[3\]/);
  assert.doesNotMatch(description, /SECRET-TOKEN-VALUE/);
});

test("setAgentMcpCommand edits mcp_command in place, matching the name case-insensitively", () => {
  const doc = structuredClone(ARRAY_DOC);
  const edit = setAgentMcpCommand(locateAgents(doc)!, "axiru", "buzz-axiru");
  assert.deepEqual(edit.keys, ["mcp_command"]);
  assert.equal(edit.previous, "");
  assert.equal(doc[0]!.mcp_command, "buzz-axiru");
  assert.equal(doc[1]!.mcp_command, "/usr/local/bin/other-mcp", "other agents untouched");
});

test("setAgentMcpCommand preserves the camelCase spelling when that is what the file uses", () => {
  const doc = structuredClone(KEYED_DOC);
  const edit = setAgentMcpCommand(locateAgents(doc)!, "Axiru", "buzz-axiru");
  assert.deepEqual(edit.keys, ["mcpCommand"]);
  assert.equal(doc.agents["id-1"].mcpCommand, "buzz-axiru");
  assert.equal("mcp_command" in doc.agents["id-1"], false, "no second spelling introduced");
});

test("a missing agent name lists what exists; multiple agents require --agent", () => {
  const collection = locateAgents(structuredClone(ARRAY_DOC))!;
  assert.throws(
    () => setAgentMcpCommand(collection, "Ghost", "buzz-axiru"),
    /no agent named "Ghost" \(found: Axiru, Scout\)/
  );
  assert.throws(
    () => setAgentMcpCommand(collection, null, "buzz-axiru"),
    /multiple agents found \(Axiru, Scout\); pick one with --agent/
  );
});

test("omitting --agent targets the single agent when there is only one", () => {
  const doc = [{ name: "Solo", mcp_command: "" }];
  const edit = setAgentMcpCommand(locateAgents(doc)!, null, "buzz-axiru");
  assert.equal(edit.agentName, "Solo");
  assert.equal(doc[0]!.mcp_command, "buzz-axiru");
});

test("file discovery covers the macOS and Linux layouts and returns every hit", () => {
  const home = tempDir();
  // macOS layout: ~/Library/Application Support/Buzz*/ and ~/.buzz*/
  const appSupport = join(home, "Library", "Application Support", "Buzz");
  mkdirSync(appSupport, { recursive: true });
  writeFileSync(join(appSupport, "managed-agents.json"), "[]");
  const dotDir = join(home, ".buzz-desktop");
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(join(dotDir, "managed-agents.json"), "[]");
  const darwinHits = findManagedAgentsFiles(home, "darwin");
  assert.equal(darwinHits.length, 2);
  assert.ok(darwinHits.includes(join(appSupport, "managed-agents.json")));
  assert.ok(darwinHits.includes(join(dotDir, "managed-agents.json")));

  // Linux layout: ~/.config/buzz*/ and ~/.buzz*/
  const configDir = join(home, ".config", "buzz-desktop");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "managed-agents.json"), "[]");
  const linuxHits = findManagedAgentsFiles(home, "linux");
  assert.equal(linuxHits.length, 2);
  assert.ok(linuxHits.includes(join(configDir, "managed-agents.json")));
  assert.ok(linuxHits.includes(join(dotDir, "managed-agents.json")));

  // A matching directory without the file is not a hit.
  assert.deepEqual(findManagedAgentsFiles(tempDir(), "linux"), []);
});

test("the process predicate recognizes Buzz Desktop but not the buzz CLI family", () => {
  assert.equal(buzzDesktopRunning(["/opt/buzz/bin/buzz-desktop --started-by launcher"]), true);
  assert.equal(buzzDesktopRunning(["/Applications/Buzz.app/Contents/MacOS/Buzz"]), true);
  assert.equal(
    buzzDesktopRunning([
      "/usr/local/bin/buzz-acp",
      "/usr/local/bin/buzz messages send",
      "node /usr/local/bin/buzz-axiru serve"
    ]),
    false
  );
});

test("refusal fails closed: running app refuses, unreadable process table refuses, --force overrides", () => {
  const running = refuseIfBuzzDesktopRunning(false, () => ["/opt/buzz/bin/buzz-desktop"]);
  assert.ok(running !== null && running.includes("Buzz Desktop is running"));
  const unknowable = refuseIfBuzzDesktopRunning(false, () => null);
  assert.ok(unknowable !== null && unknowable.includes("--force"));
  assert.equal(refuseIfBuzzDesktopRunning(true, () => ["/opt/buzz/bin/buzz-desktop"]), null);
  assert.equal(refuseIfBuzzDesktopRunning(false, () => ["node server.js"]), null);
});

test("CLI --legacy --dry-run prints the change and writes nothing, not even a backup", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  const original = JSON.stringify(ARRAY_DOC, null, 2) + "\n";
  writeFileSync(dataPath, original);
  const result = runCli(dir, {}, "--legacy", "--agent", "Axiru", "--data", dataPath, "--dry-run");
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stderr), /IGNORES/, "--legacy warns that Desktop ignores mcp_command");
  assert.match(String(result.stdout), /"" -> "buzz-axiru"/);
  assert.match(String(result.stdout), /Dry run: nothing was written/);
  assert.equal(readFileSync(dataPath, "utf8"), original, "file byte-identical");
  assert.equal(
    readdirSync(dir).filter((name) => name.endsWith(".bak")).length,
    0,
    "no backup on a dry run"
  );
});

test("CLI without --yes on a non-TTY refuses to write", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  const original = JSON.stringify(ARRAY_DOC, null, 2) + "\n";
  writeFileSync(dataPath, original);
  const result = runCli(dir, {}, "--agent", "Axiru", "--data", dataPath);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /re-run with --yes/);
  assert.equal(readFileSync(dataPath, "utf8"), original, "file untouched");
});

test("CLI --legacy --yes writes a timestamped backup of the original, then the edit and next steps", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  const original = JSON.stringify(ARRAY_DOC, null, 2) + "\n";
  writeFileSync(dataPath, original);
  const result = runCli(dir, {}, "--legacy", "--agent", "Axiru", "--data", dataPath, "--yes");
  assert.equal(result.status, 0, String(result.stderr));

  const backups = readdirSync(dir).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]!), "utf8"), original, "backup is the pre-edit bytes");

  const updated = JSON.parse(readFileSync(dataPath, "utf8")) as typeof ARRAY_DOC;
  assert.equal(updated[0]!.mcp_command, "buzz-axiru");
  assert.equal(updated[1]!.mcp_command, "/usr/local/bin/other-mcp");
  assert.match(String(result.stdout), /axiru_gate_status/);
  assert.match(String(result.stdout), /buzz-axiru doctor/);
});

test("CLI --unset restores the empty mcp command Buzz Desktop started with", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  writeFileSync(dataPath, JSON.stringify([{ name: "Axiru", mcp_command: "buzz-axiru" }]));
  const result = runCli(dir, {}, "--agent", "Axiru", "--data", dataPath, "--unset", "--yes");
  assert.equal(result.status, 0, String(result.stderr));
  const updated = JSON.parse(readFileSync(dataPath, "utf8")) as Array<{ mcp_command: string }>;
  assert.equal(updated[0]!.mcp_command, "");
});

test("CLI requires --data when the search finds multiple managed-agents.json files", () => {
  const home = tempDir();
  for (const name of [".buzz-a", ".buzz-b"]) {
    // ~/.buzz*/ is searched on every platform, so this fixture is
    // ambiguous on both the macOS and Linux search paths.
    mkdirSync(join(home, name), { recursive: true });
    writeFileSync(join(home, name, "managed-agents.json"), JSON.stringify(ARRAY_DOC));
  }
  const result = runCli(home, { HOME: home }, "--agent", "Axiru", "--yes");
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /multiple managed-agents\.json files found/);
  assert.match(String(result.stderr), /\.buzz-a/);
  assert.match(String(result.stderr), /\.buzz-b/);
  assert.match(String(result.stderr), /--data/);
});

test("CLI with no file found points at a shell-capable Buzz agent and --data", () => {
  const home = tempDir();
  const result = runCli(home, { HOME: home }, "--agent", "Axiru", "--yes");
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /no managed-agents\.json found/);
  assert.match(String(result.stderr), /Ask a shell-capable Buzz agent/);
  assert.match(String(result.stderr), /--data <path-to-managed-agents\.json>/);
});

test("backup paths are timestamped siblings and never collide across seconds", () => {
  const a = backupPathFor("/x/managed-agents.json", new Date("2026-08-09T10:00:00.000Z"));
  const b = backupPathFor("/x/managed-agents.json", new Date("2026-08-09T10:00:01.000Z"));
  assert.match(a, /^\/x\/managed-agents\.json\..+\.bak$/);
  assert.notEqual(a, b);
});

/* ------------------------------------------------------------------ *
 * 0.5.2: dedupe (persona row + live instance row), custom harness,
 * space-free shim, and the claude-code / codex file harnesses.
 * ------------------------------------------------------------------ */

/** The observed Buzz Desktop shape: each agent appears TWICE, once as a
 *  persona definition and once as a live instance carrying the pubkey
 *  and runtime metadata. */
const DOUBLED_DOC = [
  { name: "Axiru", mcp_command: "", model: "" },
  { name: "Axiru", mcp_command: "", pubkey: "ab".repeat(32), runtime: "default" }
];

test("doubled persona and live rows dedupe to ONE agent, preferring the live row", () => {
  const collection = locateAgents(structuredClone(DOUBLED_DOC))!;
  const groups = dedupeAgents(collection.agents);
  assert.equal(groups.length, 1, "one logical agent, not two");
  assert.equal(groups[0]!.rows.length, 2);
  assert.equal(groups[0]!.live.pubkey, "ab".repeat(32), "the live instance row wins");
  // The 0.5.1 parser refused here with '2 agents share the name';
  // selection without --agent must now just work.
  const group = selectAgentGroup(collection, null);
  assert.equal(group.name, "Axiru");
});

test("two genuinely distinct agents sharing a name still refuse with the rename message", () => {
  const doc = [
    { name: "Axiru", pubkey: "aa".repeat(32) },
    { name: "Axiru", pubkey: "bb".repeat(32) }
  ];
  assert.throws(
    () => selectAgentGroup(locateAgents(doc)!, "Axiru"),
    /2 agents share the name "Axiru"/
  );
});

test("setAgentRuntime switches the runtime reference and preserves object metadata", () => {
  const doc = structuredClone(DOUBLED_DOC);
  const edit = setAgentRuntime(locateAgents(doc)!, "Axiru", "axiru-gate");
  assert.equal(edit.previous, "default");
  assert.equal(doc[1]!.runtime, "axiru-gate");
  assert.equal("runtime" in doc[0]!, false, "the persona row does not gain a runtime field");

  const objDoc = [
    { name: "Solo", pubkey: "cc".repeat(32), runtime: { id: "default", sandbox: true } }
  ];
  setAgentRuntime(locateAgents(objDoc)!, null, "axiru-gate");
  assert.deepEqual(
    objDoc[0]!.runtime,
    { id: "axiru-gate", sandbox: true },
    "an object runtime keeps its sibling metadata"
  );
});

test("setAgentMcpCommand edits every row of the doubled group so the copies agree", () => {
  const doc = structuredClone(DOUBLED_DOC);
  const edit = setAgentMcpCommand(locateAgents(doc)!, null, "buzz-axiru");
  assert.equal(edit.agentName, "Axiru");
  assert.equal(doc[0]!.mcp_command, "buzz-axiru");
  assert.equal(doc[1]!.mcp_command, "buzz-axiru");
});

test("discovery covers the xyz.block.buzz.app data dir and its agents/ subdirectory", () => {
  const home = tempDir();
  const agentsDir = join(home, "Library", "Application Support", "xyz.block.buzz.app", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "managed-agents.json"), "[]");
  const hits = findManagedAgentsFiles(home, "darwin");
  assert.deepEqual(hits, [join(agentsDir, "managed-agents.json")]);
});

test("the custom harness sits in custom_harnesses/ with buzz-acp and TWO arg elements", () => {
  assert.equal(
    customHarnessPathFor("/x/data/agents/managed-agents.json"),
    "/x/data/custom_harnesses/axiru-gate.json"
  );
  assert.equal(
    customHarnessPathFor("/x/data/managed-agents.json"),
    "/x/data/custom_harnesses/axiru-gate.json"
  );
  const fresh = buildCustomHarness(null, "/opt/axiru/bin/buzz-axiru");
  assert.equal(fresh.id, "axiru-gate");
  assert.equal(fresh.label, "Axiru Gated");
  assert.equal(fresh.command, BUZZ_ACP_BINARY);
  // Two separate elements: a single "--mcp-command <path>" string would
  // reach buzz-acp as one unparseable argument.
  assert.deepEqual(fresh.args, ["--mcp-command", "/opt/axiru/bin/buzz-axiru"]);
  const updated = buildCustomHarness(
    { id: "old", args: ["stale"], future_field: 7 },
    "/opt/axiru/bin/buzz-axiru"
  );
  assert.equal(updated.future_field, 7, "fields Buzz added later survive a re-run");
  assert.deepEqual(updated.args, ["--mcp-command", "/opt/axiru/bin/buzz-axiru"]);
});

test("space-free shim plan: as-is, write-shim into a writable dir, warn otherwise", () => {
  const dir = tempDir();
  assert.equal(planSpaceFreeGatePath("/opt/bin/buzz-axiru", dir).action, "use-as-is");

  const spaced = "/Users/x/Application Support/bin/buzz-axiru";
  const plan = planSpaceFreeGatePath(spaced, dir);
  assert.equal(plan.action, "write-shim");
  assert.equal(plan.path, join(dir, "buzz-axiru"), "the harness gets the space-free path");
  writeGateShim(plan.shim!, spaced);
  const content = readFileSync(plan.shim!, "utf8");
  assert.equal(content, `#!/bin/sh\nexec "${spaced}" "$@"\n`, "a 2-line exec wrapper, target quoted");
  assert.ok((statSync(plan.shim!).mode & 0o111) !== 0, "the shim is executable");

  const unwritable = join(dir, "does-not-exist");
  const warn = planSpaceFreeGatePath(spaced, unwritable);
  assert.equal(warn.action, "warn");
  assert.equal(warn.path, spaced, "falls back to the spaced path");
  assert.match(warn.warning!, /chmod 755/, "the warning carries copy-paste instructions");
});

test("CLI default mode writes the custom harness with two arg elements and switches the runtime", () => {
  const dir = tempDir();
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir);
  const dataPath = join(agentsDir, "managed-agents.json");
  writeFileSync(dataPath, JSON.stringify(DOUBLED_DOC, null, 2));
  const result = runCli(
    dir,
    {},
    "--agent",
    "Axiru",
    "--data",
    dataPath,
    "--yes",
    "--gate-path",
    "/opt/axiru/bin/buzz-axiru"
  );
  assert.equal(result.status, 0, String(result.stderr));

  const harness = JSON.parse(
    readFileSync(join(dir, "custom_harnesses", "axiru-gate.json"), "utf8")
  ) as Record<string, unknown>;
  assert.equal(harness.id, "axiru-gate");
  assert.equal(harness.label, "Axiru Gated");
  assert.equal(harness.command, "/Applications/Buzz.app/Contents/MacOS/buzz-acp");
  assert.deepEqual(harness.args, ["--mcp-command", "/opt/axiru/bin/buzz-axiru"]);

  const updated = JSON.parse(readFileSync(dataPath, "utf8")) as typeof DOUBLED_DOC;
  assert.equal(updated[1]!.runtime, "axiru-gate", "the live row's runtime now names the harness");
  assert.equal(
    readdirSync(agentsDir).filter((name) => name.endsWith(".bak")).length,
    1,
    "managed-agents.json is backed up"
  );
  assert.match(String(result.stdout), /MODEL explicitly/, "the model next-step is printed");
  assert.match(String(result.stdout), /axiru_gate_status/, "the in-band verification line is printed");
});

test("CLI default mode --dry-run previews the harness and runtime and writes nothing", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  const original = JSON.stringify(DOUBLED_DOC, null, 2) + "\n";
  writeFileSync(dataPath, original);
  const result = runCli(
    dir,
    {},
    "--agent",
    "Axiru",
    "--data",
    dataPath,
    "--dry-run",
    "--gate-path",
    "/opt/axiru/bin/buzz-axiru"
  );
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /"axiru-gate"/);
  assert.match(String(result.stdout), /two separate elements/);
  assert.match(String(result.stdout), /Dry run: nothing was written/);
  assert.equal(readFileSync(dataPath, "utf8"), original, "file byte-identical");
  assert.equal(existsSync(join(dir, "custom_harnesses")), false, "no harness dir on a dry run");
});

test("CLI --unset clears the axiru-gate runtime reference and the gate mcp_command", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  writeFileSync(
    dataPath,
    JSON.stringify([
      {
        name: "Axiru",
        mcp_command: "buzz-axiru",
        runtime: "axiru-gate",
        pubkey: "ab".repeat(32)
      }
    ])
  );
  const result = runCli(dir, {}, "--agent", "Axiru", "--data", dataPath, "--unset", "--yes");
  assert.equal(result.status, 0, String(result.stderr));
  const updated = JSON.parse(readFileSync(dataPath, "utf8")) as Array<Record<string, unknown>>;
  assert.equal(updated[0]!.runtime, "");
  assert.equal(updated[0]!.mcp_command, "");
});

test("mergeMcpJson preserves other servers, is idempotent, and refuses bad JSON", () => {
  const existing = JSON.stringify({ mcpServers: { other: { command: "x", args: ["y"] } } });
  const merged = mergeMcpJson(existing, "/opt/axiru/bin/buzz-axiru");
  assert.equal(merged.changed, true);
  const doc = JSON.parse(merged.content) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(doc.mcpServers.other, { command: "x", args: ["y"] });
  assert.deepEqual(doc.mcpServers["axiru-gate"], { command: "/opt/axiru/bin/buzz-axiru" });
  assert.equal(mergeMcpJson(merged.content, "/opt/axiru/bin/buzz-axiru").changed, false);
  assert.throws(() => mergeMcpJson("{not json", "/x"), /not valid JSON/);
  assert.throws(() => mergeMcpJson("[]", "/x"), /must contain a JSON object/);
});

test("mergeCodexToml appends, replaces only its own table, and is idempotent", () => {
  const fresh = mergeCodexToml(null, "/opt/axiru/bin/buzz-axiru");
  assert.equal(fresh.content, '[mcp_servers.axiru-gate]\ncommand = "/opt/axiru/bin/buzz-axiru"\n');

  const existing = '[model]\nname = "gpt"\n\n[mcp_servers.other]\ncommand = "z"\n';
  const merged = mergeCodexToml(existing, "/opt/axiru/bin/buzz-axiru");
  assert.ok(merged.content.startsWith(existing), "existing content is untouched");
  assert.match(merged.content, /\[mcp_servers\.axiru-gate\]\ncommand = "\/opt\/axiru\/bin\/buzz-axiru"/);

  const replaced = mergeCodexToml(merged.content, "/usr/local/bin/buzz-axiru");
  assert.ok(!replaced.content.includes("/opt/axiru/bin/buzz-axiru"), "the old path is gone");
  assert.match(replaced.content, /\[mcp_servers\.other\]\ncommand = "z"/, "other tables survive");
  assert.equal(mergeCodexToml(replaced.content, "/usr/local/bin/buzz-axiru").changed, false);

  assert.throws(
    () => mergeCodexToml("[mcp_servers.axiru-gate]\n[mcp_servers.axiru-gate]\n", "/x"),
    /more than once/
  );
});

test("CLI --harness claude-code writes .mcp.json in the cwd and is idempotent", () => {
  const dir = tempDir();
  const args = ["--harness", "claude-code", "--yes", "--gate-path", "/opt/axiru/bin/buzz-axiru"];
  const result = runCli(dir, {}, ...args);
  assert.equal(result.status, 0, String(result.stderr));
  const doc = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(doc.mcpServers["axiru-gate"], { command: "/opt/axiru/bin/buzz-axiru" });

  const again = runCli(dir, {}, ...args);
  assert.equal(again.status, 0, String(again.stderr));
  assert.match(String(again.stdout), /nothing to do/);
  assert.equal(
    readdirSync(dir).filter((name) => name.endsWith(".bak")).length,
    0,
    "an idempotent re-run writes no backup"
  );
});

test("CLI --harness codex merges ~/.codex/config.toml under the given HOME", () => {
  const home = tempDir();
  const result = runCli(
    home,
    { HOME: home },
    "--harness",
    "codex",
    "--yes",
    "--gate-path",
    "/opt/axiru/bin/buzz-axiru"
  );
  assert.equal(result.status, 0, String(result.stderr));
  const content = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(content, /\[mcp_servers\.axiru-gate\]/);
  assert.match(content, /command = "\/opt\/axiru\/bin\/buzz-axiru"/);
});

test("CLI refuses an unrecognizable file with a structural description, no values", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  writeFileSync(dataPath, JSON.stringify({ token: "hunter2", n: 4 }));
  const result = runCli(dir, {}, "--agent", "Axiru", "--data", dataPath, "--yes");
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /could not recognize the agents collection/);
  assert.match(String(result.stderr), /"token": string/);
  assert.doesNotMatch(String(result.stderr), /hunter2/);
  assert.equal(existsSync(dataPath), true);
  assert.equal(
    readdirSync(dir).filter((name) => name.endsWith(".bak")).length,
    0,
    "refusal happens before any backup or write"
  );
});
