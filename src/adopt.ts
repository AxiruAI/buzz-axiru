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
import { copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
        parent: join(homeDir, "Library", "Application Support"),
        pattern: /^buzz/i,
        display: "~/Library/Application Support/Buzz*/managed-agents.json"
      },
      { parent: homeDir, pattern: /^\.buzz/i, display: "~/.buzz*/managed-agents.json" }
    ];
  }
  return [
    {
      parent: join(homeDir, ".config"),
      pattern: /^buzz/i,
      display: "~/.config/buzz*/managed-agents.json"
    },
    { parent: homeDir, pattern: /^\.buzz/i, display: "~/.buzz*/managed-agents.json" }
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
      const candidate = join(root.parent, entry, "managed-agents.json");
      try {
        if (statSync(candidate).isFile()) hits.push(candidate);
      } catch {
        // the directory matched but holds no managed-agents.json; skip
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
 * Set the target agent's mcp command in place. Matches the agent
 * case-insensitively by name; throws with actionable messages for a
 * missing or ambiguous agent so cli.ts can print them verbatim.
 */
export function setAgentMcpCommand(
  collection: AgentsCollection,
  agentName: string | null,
  next: string
): AdoptEdit {
  const names = collection.agents.map((a) => String(a.name));
  let matches: JsonObject[];
  if (agentName === null) {
    if (collection.agents.length !== 1) {
      throw new Error(
        `multiple agents found (${names.join(", ")}); pick one with --agent <name>`
      );
    }
    matches = collection.agents;
  } else {
    matches = collection.agents.filter(
      (a) => String(a.name).toLowerCase() === agentName.toLowerCase()
    );
    if (matches.length === 0) {
      throw new Error(
        `no agent named "${agentName}" (found: ${names.join(", ")}); check --agent`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} agents share the name "${agentName}"; rename one in Buzz first`
      );
    }
  }
  const agent = matches[0]!;
  const present = MCP_COMMAND_KEYS.filter((key) => key in agent);
  // When neither spelling exists we add snake_case: that is the shape
  // observed on disk for Desktop-created agents, so a Buzz that reads
  // the file strictly still finds the field where it expects it.
  const keys: McpCommandKey[] = present.length > 0 ? present : ["mcp_command"];
  const previous = keys[0]! in agent ? agent[keys[0]!] : undefined;
  for (const key of keys) agent[key] = next;
  return { agentName: String(agent.name), keys, previous, next };
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
