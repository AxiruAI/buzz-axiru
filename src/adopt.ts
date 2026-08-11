/**
 * `buzz-axiru adopt`: point a Buzz Desktop managed agent at the gate by
 * editing the app's managed-agents.json while the app is closed.
 *
 * Why this command exists: Buzz Desktop creates imported and custom
 * agents with an empty mcp_command and exposes no UI field to change
 * it, and BUZZ_ACP_MCP_COMMAND is on the app's reserved environment
 * variable list, so the env-var wiring that works for raw buzz-acp
 * does nothing under the Desktop app. The only remaining path is the
 * app's own managed-agents.json. The app live-rewrites that file while
 * running, so editing it under a running app can corrupt agent state;
 * adopt therefore refuses to run unless Buzz Desktop is closed.
 *
 * This module holds the testable pieces (process-scan predicate, file
 * discovery, shape detection, the edit itself). Flag handling, the
 * confirmation prompt, and printing live in cli.ts next to the other
 * commands, mirroring the quickstart split.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import { isExecutableFile } from "./downstream.js";

type JsonObject = Record<string, unknown>;

/* -------------------------------------------------------------------- *
 * Running-app refusal
 * -------------------------------------------------------------------- */

/**
 * True when one process command line looks like the Buzz Desktop app
 * itself: the buzz-desktop binary name, or the macOS app bundle's main
 * executable. Deliberately narrow: buzz-acp, the buzz CLI, and this
 * gate must not trip the check, or adopt could never run at all on a
 * machine that uses Buzz.
 */
export function isBuzzDesktopProcess(commandLine: string): boolean {
  return (
    /(?:^|\/)buzz-desktop(?:$|[\s/])/i.test(commandLine) ||
    /Buzz\.app\/Contents\/MacOS\/Buzz(?:$|\s)/.test(commandLine)
  );
}

/** Pure predicate over a process listing, so tests can simulate one. */
export function buzzDesktopRunning(processCommandLines: string[]): boolean {
  return processCommandLines.some(isBuzzDesktopProcess);
}

/**
 * Full command lines of every running process, via POSIX `ps`. Returns
 * null when the listing cannot be obtained (non-POSIX platform, ps
 * missing): null and "running" are treated the same by the caller,
 * because an unverifiable process table is not proof the app is closed.
 */
export function listProcessCommandLines(): string[] | null {
  const result = spawnSync("ps", ["-A", "-o", "command="], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * The refusal decision, factored out of cli.ts so tests can inject a
 * probe. Returns the refusal message, or null when it is safe (or
 * explicitly forced) to proceed. Fails closed on an unreadable process
 * table: the cost of a false "running" is re-running one command, the
 * cost of a false "closed" is a corrupted agent store.
 */
export function refuseIfBuzzDesktopRunning(
  force: boolean,
  probe: () => string[] | null = listProcessCommandLines
): string | null {
  if (force) return null;
  const lines = probe();
  if (lines === null) {
    return (
      "buzz-axiru adopt: could not scan the process list to confirm Buzz " +
      "Desktop is closed. Quit Buzz Desktop, then re-run with --force to " +
      "proceed without the check."
    );
  }
  if (buzzDesktopRunning(lines)) {
    return (
      "buzz-axiru adopt: Buzz Desktop is running. The app rewrites " +
      "managed-agents.json while it runs, so editing the file now can corrupt " +
      "your agent store. Quit Buzz Desktop completely and re-run. (--force " +
      "overrides this check; do not use it while the app is open.)"
    );
  }
  return null;
}

/* -------------------------------------------------------------------- *
 * File discovery
 * -------------------------------------------------------------------- */

/** One glob level: parent directory plus a prefix pattern for entries. */
interface SearchRoot {
  parent: string;
  pattern: RegExp;
  /** Human-readable form for "searched:" output and error messages. */
  display: string;
}

/**
 * Where Buzz Desktop's data directory can live, per platform. Kept as
 * data (not inlined into the search) so the CLI can print the exact
 * list it searched when nothing is found.
 */
export function managedAgentsSearchRoots(
  homeDir: string,
  platform: NodeJS.Platform
): SearchRoot[] {
  if (platform === "darwin") {
    return [
      {
        // xyz.block.buzz.app is the observed Buzz Desktop data dir on
        // real machines (field-verified 0.5.2); Buzz* covers older and
        // renamed layouts.
        parent: join(homeDir, "Library", "Application Support"),
        pattern: /^(?:buzz|xyz\.block\.buzz)/i,
        display: "~/Library/Application Support/{Buzz*,xyz.block.buzz*}/[agents/]managed-agents.json"
      },
      { parent: homeDir, pattern: /^\.buzz/i, display: "~/.buzz*/[agents/]managed-agents.json" }
    ];
  }
  return [
    {
      parent: join(homeDir, ".config"),
      pattern: /^(?:buzz|xyz\.block\.buzz)/i,
      display: "~/.config/{buzz*,xyz.block.buzz*}/[agents/]managed-agents.json"
    },
    { parent: homeDir, pattern: /^\.buzz/i, display: "~/.buzz*/[agents/]managed-agents.json" }
  ];
}

/**
 * Find managed-agents.json in the standard locations: one glob level
 * of directories under each search root, then the file directly inside.
 * Injectable home and platform so tests cover both layouts anywhere.
 */
export function findManagedAgentsFiles(
  homeDir: string,
  platform: NodeJS.Platform
): string[] {
  const hits: string[] = [];
  for (const root of managedAgentsSearchRoots(homeDir, platform)) {
    let entries: string[];
    try {
      entries = readdirSync(root.parent);
    } catch {
      continue; // a missing parent directory just means "not installed here"
    }
    for (const entry of entries.sort()) {
      if (!root.pattern.test(entry)) continue;
      // Two placements exist in the wild: directly in the data dir, and
      // under an agents/ subdirectory (the observed xyz.block.buzz.app
      // layout keeps it at <data>/agents/managed-agents.json).
      for (const candidate of [
        join(root.parent, entry, "managed-agents.json"),
        join(root.parent, entry, "agents", "managed-agents.json")
      ]) {
        try {
          if (statSync(candidate).isFile()) hits.push(candidate);
        } catch {
          // the directory matched but holds no managed-agents.json; skip
        }
      }
    }
  }
  return hits;
}

/* -------------------------------------------------------------------- *
 * Shape detection and the edit
 * -------------------------------------------------------------------- */

/** An agent entry is any object with a string `name`; everything else about
 *  the shape is tolerated, because the file's schema is Buzz's, not ours. */
function isAgentLike(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as JsonObject).name === "string"
  );
}

export interface AgentsCollection {
  /** Live references into the parsed document: mutating an entry mutates
   *  the document, which is what lets the caller re-serialize the whole
   *  file with only the one field changed. */
  agents: JsonObject[];
  /** Where the collection was found, for messages. */
  location: string;
}

/**
 * Find the agents collection wherever it lives: a top-level array, an
 * array or keyed object under some key, or a top-level keyed object.
 * Returns null when no arrangement of agent-like objects is found;
 * the caller then refuses with a structural description instead of
 * guessing, because a wrong guess writes into Buzz's state file.
 */
export function locateAgents(doc: unknown): AgentsCollection | null {
  if (Array.isArray(doc) && doc.length > 0 && doc.every(isAgentLike)) {
    return { agents: doc as JsonObject[], location: "top-level array" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const obj = doc as JsonObject;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (Array.isArray(value) && value.length > 0 && value.every(isAgentLike)) {
      return { agents: value as JsonObject[], location: `array under "${key}"` };
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const inner = Object.values(value as JsonObject);
      if (inner.length > 0 && inner.every(isAgentLike)) {
        return { agents: inner as JsonObject[], location: `keyed object under "${key}"` };
      }
    }
  }
  const values = Object.values(obj);
  if (values.length > 0 && values.every(isAgentLike)) {
    return { agents: values as JsonObject[], location: "top-level keyed object" };
  }
  return null;
}

/**
 * Snippet-free structural description for the refusal message: types
 * and key names only, never values, because the file can hold tokens
 * or other material that must not land in a terminal scrollback.
 */
export function describeStructure(value: unknown): string {
  const typeName = (v: unknown): string => {
    if (v === null) return "null";
    if (Array.isArray(v)) return `array[${v.length}]`;
    return typeof v;
  };
  if (Array.isArray(value)) {
    return value.length === 0
      ? "array[0]"
      : `array[${value.length}] of ${typeName(value[0])}`;
  }
  if (typeof value === "object" && value !== null) {
    const parts = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${typeName(v)}`);
    return `object { ${parts.join(", ")} }`;
  }
  return typeName(value);
}

/* -------------------------------------------------------------------- *
 * Deduplication: persona rows vs live instance rows
 * -------------------------------------------------------------------- */

/**
 * One logical agent, possibly stored as several rows. Field-verified
 * (0.5.2): Buzz Desktop's managed-agents.json carries each agent TWICE,
 * once as a persona definition and once as a live instance. Treating
 * rows as agents made adopt report "2 agents share the name" for a
 * machine with exactly one agent and list every agent twice.
 */
export interface AgentGroup {
  name: string;
  /** Every row that belongs to this agent, in file order. */
  rows: JsonObject[];
  /** The preferred row for edits and reporting: the live instance. */
  live: JsonObject;
}

function nonEmptyRuntime(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return false;
}

/** The live instance row carries the agent's pubkey or runtime metadata;
 *  the persona definition row carries neither. */
export function isLiveAgentRow(row: JsonObject): boolean {
  return (
    (typeof row.pubkey === "string" && row.pubkey.length > 0) || nonEmptyRuntime(row.runtime)
  );
}

/**
 * Collapse the doubled collections into one group per agent identity
 * (name, case-insensitive). Two rows that BOTH look live under one name
 * but carry different pubkeys are genuinely distinct agents and are
 * kept apart, so the old rename-one-first error still fires for real
 * collisions.
 */
export function dedupeAgents(agents: JsonObject[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup[]>();
  const ordered: AgentGroup[] = [];
  for (const row of agents) {
    const key = String(row.name).toLowerCase();
    const candidates = groups.get(key) ?? [];
    const rowPubkey = typeof row.pubkey === "string" && row.pubkey.length > 0 ? row.pubkey : null;
    const match = candidates.find((group) => {
      const livePubkey =
        typeof group.live.pubkey === "string" && group.live.pubkey.length > 0
          ? group.live.pubkey
          : null;
      // Same name plus no contradicting identity evidence: same agent.
      return rowPubkey === null || livePubkey === null || rowPubkey === livePubkey;
    });
    if (match === undefined) {
      const group: AgentGroup = { name: String(row.name), rows: [row], live: row };
      candidates.push(group);
      ordered.push(group);
      groups.set(key, candidates);
    } else {
      match.rows.push(row);
      // Prefer the live instance row for edits and display; when both
      // rows qualify the first live one keeps winning (stable).
      if (!isLiveAgentRow(match.live) && isLiveAgentRow(row)) match.live = row;
    }
  }
  return ordered;
}

/**
 * Pick the target agent group: case-insensitive by name, defaulting to
 * the single agent when no name was given. Throws actionable messages
 * for cli.ts to print verbatim. Names in messages are deduped, so one
 * agent stored twice reads as one agent.
 */
export function selectAgentGroup(
  collection: AgentsCollection,
  agentName: string | null
): AgentGroup {
  const groups = dedupeAgents(collection.agents);
  const names = groups.map((group) => group.name);
  if (agentName === null) {
    if (groups.length !== 1) {
      throw new Error(
        `multiple agents found (${names.join(", ")}); pick one with --agent <name>`
      );
    }
    return groups[0]!;
  }
  const matches = groups.filter((group) => group.name.toLowerCase() === agentName.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`no agent named "${agentName}" (found: ${names.join(", ")}); check --agent`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} agents share the name "${agentName}"; rename one in Buzz first`
    );
  }
  return matches[0]!;
}

/* -------------------------------------------------------------------- *
 * The edits
 * -------------------------------------------------------------------- */

/** Both spellings seen in the wild: Buzz's Rust side writes snake_case,
 *  its TypeScript side camelCase. Whichever the file uses is edited. */
export const MCP_COMMAND_KEYS = ["mcp_command", "mcpCommand"] as const;
export type McpCommandKey = (typeof MCP_COMMAND_KEYS)[number];

export interface AdoptEdit {
  agentName: string;
  /** Every spelling that was edited (both, when the file carries both,
   *  so the two copies cannot disagree after our write). */
  keys: McpCommandKey[];
  /** Previous value of the first edited key, for the change preview. */
  previous: unknown;
  next: string;
}

/**
 * Set the target agent's mcp command in place, on EVERY row of the
 * agent's group that carries the field (persona and live copies must
 * not disagree after our write). Legacy mode only: field testing proved
 * Buzz Desktop ignores this value (it injects BUZZ_ACP_MCP_COMMAND
 * itself, first in the child envp, and first duplicate wins), so the
 * default adopt path uses a custom harness instead.
 */
export function setAgentMcpCommand(
  collection: AgentsCollection,
  agentName: string | null,
  next: string
): AdoptEdit {
  const group = selectAgentGroup(collection, agentName);
  const present = new Set<McpCommandKey>();
  for (const row of group.rows) {
    for (const key of MCP_COMMAND_KEYS) if (key in row) present.add(key);
  }
  // When no row carries either spelling we add snake_case to the live
  // row: that is the shape observed on disk for Desktop-created agents,
  // so a Buzz that reads the file strictly finds it where it expects.
  const keys: McpCommandKey[] = present.size > 0 ? [...present] : ["mcp_command"];
  const readFrom = group.rows.find((row) => keys[0]! in row) ?? group.live;
  const previous = keys[0]! in readFrom ? readFrom[keys[0]!] : undefined;
  for (const row of group.rows) {
    for (const key of keys) {
      if (key in row || row === group.live) row[key] = next;
    }
  }
  return { agentName: group.name, keys, previous, next };
}

export interface RuntimeEdit {
  agentName: string;
  previous: unknown;
  next: string;
}

/** Keys a structured runtime object might use to reference a harness. */
const RUNTIME_REF_KEYS = ["id", "harness_id", "harnessId", "harness"] as const;

/**
 * Point the agent's runtime at a (custom) harness id. The runtime field
 * belongs to Buzz's schema, not ours, so the edit is conservative: a
 * string (or absent) runtime becomes the harness id; an object runtime
 * keeps its sibling metadata and only its id-like key is rewritten;
 * anything else is replaced whole. Rows without a runtime key are left
 * alone except when NO row carries one, in which case the live row
 * gains it (Buzz reads the live instance's runtime).
 */
export function setAgentRuntime(
  collection: AgentsCollection,
  agentName: string | null,
  harnessId: string
): RuntimeEdit {
  const group = selectAgentGroup(collection, agentName);
  const carriers = group.rows.filter((row) => "runtime" in row);
  const targets = carriers.length > 0 ? carriers : [group.live];
  const previous = "runtime" in targets[0]! ? targets[0]!.runtime : undefined;
  for (const row of targets) {
    const current = row.runtime;
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      const runtime = current as JsonObject;
      const refKey = RUNTIME_REF_KEYS.find((key) => key in runtime);
      if (refKey !== undefined) {
        runtime[refKey] = harnessId;
        continue;
      }
    }
    row.runtime = harnessId;
  }
  return { agentName: group.name, previous, next: harnessId };
}

/** True when a runtime value references our custom harness. */
export function runtimeReferencesHarness(value: unknown, harnessId: string): boolean {
  if (value === harnessId) return true;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const runtime = value as JsonObject;
    return RUNTIME_REF_KEYS.some((key) => runtime[key] === harnessId);
  }
  return false;
}

export interface UnsetEdit {
  agentName: string;
  /** Human-readable field changes, for the preview. */
  changes: string[];
}

/**
 * Take the gate back out of the loop: clear every runtime reference to
 * our harness (back to the empty string, the state Desktop-created
 * agents start in) and every mcp_command that names buzz-axiru. Values
 * we did not write are left untouched, because restoring somebody
 * else's wiring is not this command's call.
 */
export function unsetAgentGate(
  collection: AgentsCollection,
  agentName: string | null,
  harnessId: string
): UnsetEdit {
  const group = selectAgentGroup(collection, agentName);
  const changes: string[] = [];
  for (const row of group.rows) {
    if ("runtime" in row && runtimeReferencesHarness(row.runtime, harnessId)) {
      row.runtime = "";
      if (!changes.includes(`runtime: "${harnessId}" -> ""`)) {
        changes.push(`runtime: "${harnessId}" -> ""`);
      }
    }
    for (const key of MCP_COMMAND_KEYS) {
      if (key in row && typeof row[key] === "string" && basename(row[key] as string) === "buzz-axiru") {
        const previous = row[key] as string;
        row[key] = "";
        if (!changes.includes(`${key}: ${JSON.stringify(previous)} -> ""`)) {
          changes.push(`${key}: ${JSON.stringify(previous)} -> ""`);
        }
      }
    }
  }
  return { agentName: group.name, changes };
}

/* -------------------------------------------------------------------- *
 * Custom harness: the wiring path that actually works on Buzz Desktop
 * -------------------------------------------------------------------- */

/**
 * Why a custom harness and not mcp_command (field-verified, 0.5.2):
 * Buzz Desktop launches agents through buzz-acp and injects
 * BUZZ_ACP_MCP_COMMAND=<bundled buzz-dev-mcp> FIRST in the child envp.
 * Values appended later, including anything derived from the agent
 * record's mcp_command, lose: buzz-acp reads the first duplicate. The
 * only override that beats the env var is buzz-acp's own --mcp-command
 * argv flag, and the only place Desktop lets an operator supply argv is
 * a custom harness file. So adopt writes one.
 */
export const CUSTOM_HARNESS_ID = "axiru-gate";
export const CUSTOM_HARNESS_LABEL = "Axiru Gated";
export const BUZZ_ACP_BINARY = "/Applications/Buzz.app/Contents/MacOS/buzz-acp";

/**
 * The harness file location, derived from where managed-agents.json
 * was found: custom_harnesses/ is a sibling of agents/ in the app's
 * data dir (observed layout: <data>/agents/managed-agents.json and
 * <data>/custom_harnesses/*.json). A file directly in the data dir
 * puts custom_harnesses/ next to it.
 */
export function customHarnessPathFor(managedAgentsPath: string): string {
  const parent = dirname(managedAgentsPath);
  const dataDir = basename(parent) === "agents" ? dirname(parent) : parent;
  return join(dataDir, "custom_harnesses", `${CUSTOM_HARNESS_ID}.json`);
}

/**
 * Build (or update) the custom harness document. The args MUST be two
 * separate array elements: a single "--mcp-command <path>" string would
 * reach buzz-acp as one argument and fail to parse as the flag. Fields
 * we do not own are preserved from an existing file, so a re-run after
 * a Buzz update that added keys does not strip them.
 */
export function buildCustomHarness(
  existing: unknown,
  gatePath: string,
  acpPath: string = BUZZ_ACP_BINARY
): JsonObject {
  const base: JsonObject =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as JsonObject) }
      : {};
  base.id = CUSTOM_HARNESS_ID;
  base.label = CUSTOM_HARNESS_LABEL;
  base.command = acpPath;
  base.args = ["--mcp-command", gatePath];
  return base;
}

/* -------------------------------------------------------------------- *
 * Gate binary resolution and the space-free shim
 * -------------------------------------------------------------------- */

export interface ResolvedGateBinary {
  path: string;
  /** Where it came from, for the preview ("PATH" or "this process"). */
  source: string;
}

/**
 * The absolute path to the buzz-axiru executable, for wiring into
 * harness and MCP config files. PATH is authoritative (that is the
 * installed bin shim); the running script is only a fallback, and the
 * caller should surface its source so the operator can see when the
 * gate is not properly installed.
 */
export function resolveGateBinary(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1]
): ResolvedGateBinary | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "buzz-axiru");
    if (isExecutableFile(candidate)) return { path: candidate, source: `PATH (${dir})` };
  }
  if (argv1 !== undefined && argv1.length > 0) {
    return { path: resolve(argv1), source: "this process (buzz-axiru is not on PATH)" };
  }
  return null;
}

export interface GatePathPlan {
  /** The path to write into the harness args. */
  path: string;
  action: "use-as-is" | "write-shim" | "warn";
  /** The shim to create/refresh before writing configs (write-shim). */
  shim: string | null;
  warning: string | null;
}

/**
 * Prefer a space-free gate path. Field-verified: npm global installs
 * under "~/Library/Application Support" or similar put a space in the
 * path, and a spaced --mcp-command path breaks under Buzz's harness
 * argument handling. When the resolved path contains a space, plan a
 * tiny exec shim at /usr/local/bin/buzz-axiru if that directory is
 * writable, else fall back to the spaced path with instructions.
 */
export function planSpaceFreeGatePath(
  resolved: string,
  shimDir: string = "/usr/local/bin"
): GatePathPlan {
  if (!resolved.includes(" ")) {
    return { path: resolved, action: "use-as-is", shim: null, warning: null };
  }
  const shim = join(shimDir, "buzz-axiru");
  let writable = false;
  try {
    accessSync(shimDir, constants.W_OK);
    writable = statSync(shimDir).isDirectory();
  } catch {
    writable = false;
  }
  if (writable) {
    return { path: shim, action: "write-shim", shim, warning: null };
  }
  return {
    path: resolved,
    action: "warn",
    shim: null,
    warning:
      `the buzz-axiru path contains spaces (${JSON.stringify(resolved)}) and ${shimDir} is ` +
      "not writable, so no space-free shim could be planned. Spaced paths are known to " +
      "break Buzz harness argument handling. Create the shim manually:\n" +
      `  sudo sh -c 'printf '\\''#!/bin/sh\\nexec ${JSON.stringify(resolved)} "$@"\\n'\\'' > ${shim} && chmod 755 ${shim}'\n` +
      "then re-run adopt."
  };
}

/** The 2-line exec wrapper. Refreshing an existing shim is deliberate:
 *  a stale shim pointing at an uninstalled version is worse than none. */
export function writeGateShim(shimPath: string, target: string): void {
  writeFileSync(shimPath, `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, {
    encoding: "utf8",
    mode: 0o755
  });
}

/* -------------------------------------------------------------------- *
 * Other harnesses: Claude Code (.mcp.json) and Codex (config.toml)
 * -------------------------------------------------------------------- */

export interface MergeResult {
  content: string;
  /** False when the file already carries exactly this wiring. */
  changed: boolean;
}

/**
 * Merge the gate into a Claude Code project .mcp.json. Config shape per
 * the Claude Code MCP docs (code.claude.com/docs/en/mcp, project-scope
 * .mcp.json): {"mcpServers": {"<name>": {"command": "..."}}}. No args:
 * the bare command starts the stdio server, which is the default CLI
 * action. Throws on anything unparseable rather than guessing, because
 * the file may carry other servers the operator needs intact.
 */
export function mergeMcpJson(existingRaw: string | null, gatePath: string): MergeResult {
  let doc: JsonObject = {};
  if (existingRaw !== null && existingRaw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRaw);
    } catch (err) {
      throw new Error(`.mcp.json is not valid JSON (${(err as Error).message}); fix it first`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".mcp.json must contain a JSON object; fix it first");
    }
    doc = parsed as JsonObject;
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    throw new Error('.mcp.json has a non-object "mcpServers"; fix it first');
  }
  const mcpServers: JsonObject = (servers as JsonObject | undefined) ?? {};
  const entry = { command: gatePath };
  const changed = JSON.stringify(mcpServers[CUSTOM_HARNESS_ID]) !== JSON.stringify(entry);
  mcpServers[CUSTOM_HARNESS_ID] = entry;
  doc.mcpServers = mcpServers;
  return { content: JSON.stringify(doc, null, 2) + "\n", changed };
}

/** TOML basic-string escaping for the one value we write. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const CODEX_SECTION_HEADER = /^\s*\[mcp_servers\.axiru-gate\]\s*$/;

/**
 * Merge the gate into Codex's ~/.codex/config.toml. Config shape per
 * the Codex CLI config docs (github.com/openai/codex, config.md:
 * [mcp_servers.<name>] tables with command/args). No TOML dependency
 * is available, so the merge is textual and deliberately narrow: our
 * own [mcp_servers.axiru-gate] table is replaced line-for-line up to
 * the next table header, anything else is appended-to, and a file we
 * cannot reason about that way is refused rather than rewritten.
 */
export function mergeCodexToml(existingRaw: string | null, gatePath: string): MergeResult {
  const section = `[mcp_servers.${CUSTOM_HARNESS_ID}]\ncommand = ${tomlString(gatePath)}\n`;
  if (existingRaw === null || existingRaw.trim().length === 0) {
    return { content: section, changed: true };
  }
  if (existingRaw.includes("\u0000") || existingRaw.includes("\uFFFD")) {
    throw new Error("~/.codex/config.toml does not look like a text file; refusing to edit it");
  }
  const lines = existingRaw.split("\n");
  const headerIndexes = lines
    .map((line, index) => (CODEX_SECTION_HEADER.test(line) ? index : -1))
    .filter((index) => index !== -1);
  if (headerIndexes.length > 1) {
    throw new Error(
      "~/.codex/config.toml contains [mcp_servers.axiru-gate] more than once; fix it first"
    );
  }
  if (headerIndexes.length === 0) {
    const body = existingRaw.endsWith("\n") ? existingRaw : existingRaw + "\n";
    return { content: `${body}\n${section}`, changed: true };
  }
  const start = headerIndexes[0]!;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
  const replaced = [...lines.slice(0, start), ...section.trimEnd().split("\n"), ...lines.slice(end)];
  const content = replaced.join("\n").replace(/\n*$/, "\n");
  return { content, changed: content !== existingRaw };
}

/* -------------------------------------------------------------------- *
 * Backup
 * -------------------------------------------------------------------- */

/** Timestamped sibling path, so repeated runs never overwrite a backup. */
export function backupPathFor(filePath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${filePath}.${stamp}.bak`;
}

/** Copy the file byte-for-byte before any write touches it. */
export function writeBackup(filePath: string, now: Date = new Date()): string {
  const backup = backupPathFor(filePath, now);
  copyFileSync(filePath, backup);
  return backup;
}
