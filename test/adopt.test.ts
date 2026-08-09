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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  backupPathFor,
  buzzDesktopRunning,
  describeStructure,
  findManagedAgentsFiles,
  locateAgents,
  refuseIfBuzzDesktopRunning,
  setAgentMcpCommand
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

test("CLI --dry-run prints the change and writes nothing, not even a backup", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  const original = JSON.stringify(ARRAY_DOC, null, 2) + "\n";
  writeFileSync(dataPath, original);
  const result = runCli(dir, {}, "--agent", "Axiru", "--data", dataPath, "--dry-run");
  assert.equal(result.status, 0, String(result.stderr));
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

test("CLI --yes writes a timestamped backup of the original, then the edit and next steps", () => {
  const dir = tempDir();
  const dataPath = join(dir, "managed-agents.json");
  const original = JSON.stringify(ARRAY_DOC, null, 2) + "\n";
  writeFileSync(dataPath, original);
  const result = runCli(dir, {}, "--agent", "Axiru", "--data", dataPath, "--yes");
  assert.equal(result.status, 0, String(result.stderr));

  const backups = readdirSync(dir).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]!), "utf8"), original, "backup is the pre-edit bytes");

  const updated = JSON.parse(readFileSync(dataPath, "utf8")) as typeof ARRAY_DOC;
  assert.equal(updated[0]!.mcp_command, "buzz-axiru");
  assert.equal(updated[1]!.mcp_command, "/usr/local/bin/other-mcp");
  assert.match(String(result.stdout), /quickstart --check/);
  assert.match(String(result.stdout), /@Axiru confirm your gate is live/);
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
