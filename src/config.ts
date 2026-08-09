/**
 * Configuration loading for buzz-axiru.
 *
 * Policies load from a local policies.json (path resolution order:
 * explicit argument, BUZZ_AXIRU_POLICIES env var, ./policies.json).
 * The file describes a small set of named controls; each control maps
 * onto a preset from @axiru/agent-spend-guardrails. Policy documents
 * are built per request so the per-agent daily cap can be pinned to
 * the requesting agent's Nostr pubkey.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  businessHoursOnly,
  counterpartyAllowlist,
  defineSpendPolicy,
  humanApprovalAboveAmount,
  perAgentDailyCap,
  velocityCountCap,
  type PolicyV2,
  type Rail
} from "@axiru/agent-spend-guardrails";

export interface BridgeControls {
  per_agent_daily_cap?: { cap_minor_units: string };
  single_payment_ceiling?: {
    threshold_minor_units: string;
    approver_group?: string;
  };
  counterparty_allowlist?: { allowed_ids: string[] };
  business_hours?: {
    tz: string;
    open_hour?: number;
    close_hour?: number;
    effect?: "deny" | "require_approval";
  };
  velocity_count_cap?: {
    window?: "24h" | "30d";
    max_count: number;
    effect?: "deny" | "require_approval";
  };
}

export interface SpendHistorySnapshot {
  amount_24h: string;
  amount_30d: string;
  count_24h: number;
  count_30d: number;
}

export interface BuzzChannelConfig {
  /** Buzz channel UUID to post approval requests into (via buzz CLI). */
  channel_id: string | null;
  /** Path to the buzz CLI binary. Defaults to "buzz" on PATH. */
  cli_path: string;
}

/**
 * One downstream MCP server the gate spawns and fronts.
 *
 * Buzz gives an agent exactly one MCP server, so an agent that needs
 * both a shell server and a payment server has nowhere to put the
 * second one. The gate is a proxy, so it can take that single slot and
 * fan out to several servers behind it. Config accepts a single object
 * (the original shape) or an array of these; loadConfig normalizes to
 * an array so the rest of the code has one case to handle.
 */
export interface DownstreamConfig {
  /**
   * Label used in error messages, logs, and instruction text. Defaults
   * to the basename of command. Must be unique across entries: it is
   * how an operator tells two servers apart when one of them dies.
   */
  name: string;
  command: string;
  args: string[];
  /** Extra environment variables for the child (merged over env_passthrough). */
  env: Record<string, string>;
  /**
   * Which of the bridge's own environment variables the child inherits.
   *
   * "all" (the historical pre-0.4 behaviour) hands the child
   * every variable this process has, which means the bridge's Buzz
   * signing key and one payment server's API key are both visible to
   * every other downstream server the operator configures. That is a
   * lot of trust to place in a server chosen for an unrelated job.
   * "none" (the secure default) passes nothing but `env`, and an array
   * names the variables to forward. Generated configs use an explicit
   * small allowlist so unrelated downstream tools never receive the
   * bridge signing key or another server's API credentials.
   */
  env_passthrough: "all" | "none" | string[];
  /** Per-request timeout against the downstream server. Default 30000. */
  request_timeout_ms: number;
  /**
   * Downstream tool names to omit from the merged tools/list. Matched
   * against the name the server itself reports, before tool_prefix.
   */
  hide_tools: string[];
  /**
   * Prefix every tool from this server with this string when exposing
   * it to the agent. Empty string means expose names unchanged. This is
   * the operator's escape hatch for name collisions between servers,
   * and it also makes payment_tools.gate patterns like "pay_*" possible.
   */
  tool_prefix: string;
}

/**
 * How to read a payment out of one gated tool's arguments. Field paths
 * are dot-separated into the tool call's arguments object, e.g.
 * "amount" or "payment.total_minor_units".
 */
export interface ToolMapping {
  /** Path to the amount. The value must be a non-negative integer (number or string), in minor units. */
  amount_field?: string;
  /** Path to the currency string. */
  currency_field?: string;
  /** Static currency when the tool has no currency argument. */
  currency?: string;
  /** Path to the counterparty id. */
  counterparty_field?: string;
  /** Static counterparty id when the tool has no counterparty argument. */
  counterparty?: string;
}

export interface PaymentToolsConfig {
  /**
   * Tool-name patterns to gate ("create_payment", "refund_*"). "*"
   * matches any run of characters. Tools that match no pattern pass
   * through untouched.
   */
  gate: string[];
  /** Per-tool amount mappings. Keys are exact names or the same glob form. */
  mappings: Record<string, ToolMapping>;
}

export interface BridgeConfig {
  /**
   * Rail label passed to the policy evaluator. The evaluator ships
   * reference evaluators for "x402", "stripe", "stripe_daa" and
   * "usdc_solana"; any other value fails closed to deny. The bridge
   * itself never touches a rail; this only selects which reference
   * evaluator reasons about the intent.
   */
  rail: Rail;
  /** Currency the policy pack is denominated in ("USD", "USDC", ...). */
  currency: string;
  controls: BridgeControls;
  buzz: BuzzChannelConfig;
  /** Optional webhook POSTed on approval requests and outcomes. */
  webhook_url: string | null;
  /** Directory for the decision ledger and pending approvals. */
  data_dir: string;
  /** Absolute path the config was loaded from (for logs). */
  config_path: string;
  /**
   * Downstream MCP servers for gate mode; null = advisory only. Always
   * an array once loaded, even when the config file used the single
   * object form.
   */
  downstream: DownstreamConfig[] | null;
  /**
   * Which downstream tools are payment-class. null means the operator
   * configured a downstream but no matcher; the gate FAILS CLOSED and
   * gates every downstream tool.
   */
  payment_tools: PaymentToolsConfig | null;
  /**
   * Seconds a parked approval stays decidable. After this it expires:
   * it can no longer be granted and is never executed. null disables
   * expiry (not recommended). Default 86400 (24 hours).
   */
  approval_ttl_seconds: number | null;
  /**
   * Ceiling on how many approvals may sit pending at once. Each parked
   * call is a distinct file entry and a distinct line in somebody's
   * channel, and the agent chooses the arguments, so it also chooses
   * how many distinct approvals exist. Past the ceiling the gate
   * refuses new gated calls outright rather than growing a queue no
   * human will ever read. Default 500; null disables the ceiling.
   */
  max_pending_approvals: number | null;
  /**
   * The Nostr pubkey decisions are attributed to in gate mode, where
   * downstream tool calls carry no agent_pubkey argument. Overridden
   * by BUZZ_AXIRU_AGENT_PUBKEY. If neither is set the gate still fails
   * closed: decisions are attributed to the all-zeros pubkey, so every
   * unattributed agent shares one daily cap. `buzz-axiru doctor` flags
   * the missing identity as not ready.
   */
  agent_pubkey: string | null;
}

export const DEFAULT_POLICIES_FILE = "policies.json";

/** Load and validate policies.json. Throws with a clear message on bad input. */
export function loadConfig(policiesPath?: string, dataDirOverride?: string): BridgeConfig {
  const path = resolve(
    policiesPath ?? process.env.BUZZ_AXIRU_POLICIES ?? DEFAULT_POLICIES_FILE
  );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `buzz-axiru: cannot read policies file at ${path}: ${(err as Error).message}`
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`buzz-axiru: policies file ${path} must be a JSON object`);
  }
  const doc = raw as Record<string, unknown>;

  const rail = typeof doc.rail === "string" && doc.rail.trim().length > 0 ? doc.rail.trim() : "x402";
  const currency =
    typeof doc.currency === "string" && doc.currency.trim().length > 0
      ? doc.currency.trim().toUpperCase()
      : "USD";
  if (!/^[A-Z0-9._-]{2,20}$/.test(currency)) {
    throw new Error(
      `buzz-axiru: ${path}: currency must be a 2-20 character currency or token symbol`
    );
  }
  const controls = (doc.controls ?? {}) as BridgeControls;

  const buzzRaw = (doc.buzz ?? {}) as Record<string, unknown>;
  const buzz: BuzzChannelConfig = {
    channel_id: typeof buzzRaw.channel_id === "string" ? buzzRaw.channel_id : null,
    cli_path: typeof buzzRaw.cli_path === "string" ? buzzRaw.cli_path : "buzz"
  };

  const data_dir = resolve(
    dataDirOverride ??
      process.env.BUZZ_AXIRU_DATA_DIR ??
      (typeof doc.data_dir === "string" ? doc.data_dir : "data")
  );

  const config: BridgeConfig = {
    rail: rail as Rail,
    currency,
    controls,
    buzz,
    webhook_url: parseWebhookUrl(doc.webhook_url, path),
    data_dir,
    config_path: path,
    downstream: parseDownstream(doc.downstream, path),
    payment_tools: parsePaymentTools(doc.payment_tools, path),
    approval_ttl_seconds: parseTtl(doc.approval_ttl_seconds, path),
    max_pending_approvals: parseMaxPending(doc.max_pending_approvals, path),
    agent_pubkey: parseAgentPubkey(doc.agent_pubkey, path)
  };

  // Fail fast: building policies validates every control's shape.
  policiesForAgent(config, "0".repeat(64));
  return config;
}

const TOOL_PREFIX_RE = /^[A-Za-z0-9_.-]*$/;

/**
 * Accepts the historical single object, an array of objects, or null.
 * Always returns an array (or null), so callers never branch on shape.
 */
function parseDownstream(raw: unknown, path: string): DownstreamConfig[] | null {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error(
        `buzz-axiru: ${path}: "downstream" must not be an empty array; use null for advisory mode`
      );
    }
    const entries = raw.map((entry, index) =>
      parseDownstreamEntry(entry, path, `downstream[${index}]`)
    );
    // Names are the only handle an operator has on a specific server in
    // logs and errors, so ambiguity here is worth failing the load over.
    const seen = new Map<string, string>();
    entries.forEach((entry, index) => {
      const previous = seen.get(entry.name);
      if (previous !== undefined) {
        throw new Error(
          `buzz-axiru: ${path}: duplicate downstream name "${entry.name}" ` +
            `(${previous} and downstream[${index}]); give each entry a unique "name"`
        );
      }
      seen.set(entry.name, `downstream[${index}]`);
    });
    return entries;
  }
  if (typeof raw !== "object") {
    throw new Error(
      `buzz-axiru: ${path}: "downstream" must be an object, an array of objects, or null`
    );
  }
  return [parseDownstreamEntry(raw, path, "downstream")];
}

function parseDownstreamEntry(raw: unknown, path: string, label: string): DownstreamConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`buzz-axiru: ${path}: "${label}" must be an object`);
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.command !== "string" || d.command.length === 0) {
    throw new Error(`buzz-axiru: ${path}: ${label}.command must be a non-empty string`);
  }
  const args = d.args === undefined ? [] : d.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`buzz-axiru: ${path}: ${label}.args must be an array of strings`);
  }
  if ((args as string[]).some((arg) => arg.includes("PIN_REVIEWED_VERSION"))) {
    throw new Error(
      `buzz-axiru: ${path}: ${label}.args still contains PIN_REVIEWED_VERSION; ` +
        "replace it with an exact downstream package version you reviewed"
    );
  }
  validateNpxAutoInstall(d.command, args as string[], path, label);
  const env = Object.create(null) as Record<string, string>;
  if (d.env !== undefined && d.env !== null) {
    if (typeof d.env !== "object" || Array.isArray(d.env)) {
      throw new Error(`buzz-axiru: ${path}: ${label}.env must be an object of strings`);
    }
    for (const [key, value] of Object.entries(d.env as Record<string, unknown>)) {
      if (key.startsWith("$")) continue;
      if (!ENV_NAME_RE.test(key) || isUnsafeKey(key)) {
        throw new Error(`buzz-axiru: ${path}: ${label}.env has an invalid variable name "${key}"`);
      }
      if (typeof value !== "string") {
        throw new Error(`buzz-axiru: ${path}: ${label}.env.${key} must be a string`);
      }
      env[key] = value;
    }
  }
  const env_passthrough = parseEnvPassthrough(d.env_passthrough, path, label);
  const timeout =
    d.request_timeout_ms === undefined ? 30_000 : Number(d.request_timeout_ms);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 600_000) {
    throw new Error(
      `buzz-axiru: ${path}: ${label}.request_timeout_ms must be an integer from 1 to 600000`
    );
  }
  const hide = d.hide_tools === undefined ? [] : d.hide_tools;
  if (!Array.isArray(hide) || !hide.every((h) => typeof h === "string")) {
    throw new Error(`buzz-axiru: ${path}: ${label}.hide_tools must be an array of strings`);
  }
  let name: string;
  if (d.name === undefined) {
    name = basename(d.command);
  } else if (typeof d.name !== "string" || d.name.length === 0) {
    throw new Error(`buzz-axiru: ${path}: ${label}.name must be a non-empty string`);
  } else {
    name = d.name;
  }
  const tool_prefix = d.tool_prefix === undefined ? "" : d.tool_prefix;
  if (typeof tool_prefix !== "string" || !TOOL_PREFIX_RE.test(tool_prefix)) {
    throw new Error(
      `buzz-axiru: ${path}: ${label}.tool_prefix must be a string matching ` +
        "[A-Za-z0-9_.-]* (letters, digits, underscore, dot, hyphen)"
    );
  }
  return {
    name,
    command: d.command,
    args: args as string[],
    env,
    env_passthrough,
    request_timeout_ms: timeout,
    hide_tools: hide as string[],
    tool_prefix
  };
}

function parseEnvPassthrough(
  raw: unknown,
  path: string,
  label: string
): "all" | "none" | string[] {
  if (raw === undefined || raw === null) return "none";
  if (raw === "all" || raw === "none") return raw;
  if (
    Array.isArray(raw) &&
    raw.every(
      (name) => typeof name === "string" && ENV_NAME_RE.test(name) && !isUnsafeKey(name)
    )
  ) {
    return [...new Set(raw as string[])];
  }
  throw new Error(
    `buzz-axiru: ${path}: ${label}.env_passthrough must be "all", "none", or an array of variable names`
  );
}

/**
 * Keys that would reach an object's prototype instead of the object
 * when copied with plain assignment. Config is operator-written, but
 * these maps are also indexed with names that come off the wire, so
 * the cheap defence is to refuse the keys outright.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

function parsePaymentTools(raw: unknown, path: string): PaymentToolsConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`buzz-axiru: ${path}: "payment_tools" must be an object or absent`);
  }
  const p = raw as Record<string, unknown>;
  const gate = p.gate === undefined ? [] : p.gate;
  if (!Array.isArray(gate) || !gate.every((g) => typeof g === "string")) {
    throw new Error(`buzz-axiru: ${path}: payment_tools.gate must be an array of tool-name patterns`);
  }
  const mappings: Record<string, ToolMapping> = {};
  if (p.mappings !== undefined && p.mappings !== null) {
    if (typeof p.mappings !== "object" || Array.isArray(p.mappings)) {
      throw new Error(`buzz-axiru: ${path}: payment_tools.mappings must be an object`);
    }
    for (const [key, value] of Object.entries(p.mappings as Record<string, unknown>)) {
      if (key.startsWith("$")) continue;
      if (isUnsafeKey(key)) continue;
      if (typeof value !== "object" || value === null) {
        throw new Error(`buzz-axiru: ${path}: payment_tools.mappings["${key}"] must be an object`);
      }
      const m = value as Record<string, unknown>;
      const mapping: ToolMapping = {};
      for (const field of [
        "amount_field",
        "currency_field",
        "currency",
        "counterparty_field",
        "counterparty"
      ] as const) {
        const v = m[field];
        if (v !== undefined) {
          if (typeof v !== "string" || v.length === 0) {
            throw new Error(
              `buzz-axiru: ${path}: payment_tools.mappings["${key}"].${field} must be a non-empty string`
            );
          }
          mapping[field] = v;
        }
      }
      mappings[key] = mapping;
    }
  }
  return { gate: gate as string[], mappings };
}

/**
 * The webhook is operator-set, so this is not an agent-facing control.
 * It is still worth refusing anything that is not http(s): a config
 * assembled by a template or a script has no business making the
 * bridge read a file: URL and POST approval contents into it.
 */
function parseWebhookUrl(raw: unknown, path: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new Error(`buzz-axiru: ${path}: webhook_url must be a string or null`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`buzz-axiru: ${path}: webhook_url is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `buzz-axiru: ${path}: webhook_url must be http: or https: (got "${parsed.protocol}")`
    );
  }
  return raw;
}

function parseTtl(raw: unknown, path: string): number | null {
  if (raw === undefined) return 86_400;
  if (raw === null) return null;
  const ttl = Number(raw);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 31_536_000) {
    throw new Error(
      `buzz-axiru: ${path}: approval_ttl_seconds must be an integer from 1 to 31536000, or null`
    );
  }
  return ttl;
}

function parseMaxPending(raw: unknown, path: string): number | null {
  if (raw === undefined) return 500;
  if (raw === null) return null;
  const max = Number(raw);
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error(
      `buzz-axiru: ${path}: max_pending_approvals must be a positive integer or null`
    );
  }
  return max;
}

function parseAgentPubkey(raw: unknown, path: string): string | null {
  if (raw === undefined || raw === null) return null;
  const normalized = typeof raw === "string" ? normalizePubkey(raw) : null;
  if (normalized === null) {
    throw new Error(
      `buzz-axiru: ${path}: agent_pubkey must be a Nostr pubkey ` +
        "(64-char lowercase hex or checksummed npub form)"
    );
  }
  return normalized;
}

/**
 * Refuse unpinned npx downstream commands (external 0.5 review). An
 * `npx` payment server without `-y package@exact-version` re-resolves
 * on every gate start, so the binary that moves money can silently
 * change under the operator between reviews; a missing -y can also
 * hang an MCP stdio stream on an interactive install prompt. Only the
 * auditable canonical shape `npx -y package@1.2.3 ...` is accepted;
 * inferring npx's larger option grammar would create bypasses (an
 * option value mistaken for the package, an unpinned later target).
 */
function validateNpxAutoInstall(command: string, args: string[], path: string, label: string): void {
  const executable = basename(command).toLowerCase().replace(/\.cmd$/, "");
  if (executable !== "npx") return;
  const yesIndex = args.findIndex((arg) => arg === "-y" || arg === "--yes");
  const spec = args[yesIndex + 1];
  if (yesIndex !== 0 || spec === undefined || spec.startsWith("-")) {
    throw new Error(
      `buzz-axiru: ${path}: ${label} must use the auditable form ` +
        "npx -y <package@exact-version> followed by package arguments"
    );
  }
  const exact =
    /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!exact.test(spec)) {
    throw new Error(
      `buzz-axiru: ${path}: ${label} auto-installs ${JSON.stringify(spec)} with npx -y. ` +
        "Pin an exact reviewed version such as @scope/package@1.2.3; tags and ranges are refused."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Tool-name matching and payment extraction (gate mode)              */
/* ------------------------------------------------------------------ */

/**
 * Glob match where "*" is the only wildcard (matches any run, including
 * empty). The wildcard matches newlines too: a downstream server that
 * named a tool "pay_a\nb" must not slip past a "pay_*" gate pattern
 * while still being callable by that exact name.
 *
 * Implemented without regular expressions (external 0.5 review): the
 * name being matched comes from the downstream server, and a compiled
 * pattern with several wildcards can be driven into catastrophic
 * backtracking by an adversarial tool name. This form is a standard
 * two-pointer glob match, linear-ish and allocation-free.
 */
export function matchesPattern(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let starP = -1;
  let starN = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === name[n]) && pattern[p] !== "*") {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      starP = p;
      starN = n;
      p += 1;
    } else if (starP !== -1) {
      p = starP + 1;
      starN += 1;
      n = starN;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Whether a downstream tool is gated. FAIL CLOSED: when a downstream
 * is configured without payment_tools, every tool is gated, across
 * every configured server.
 *
 * toolName is the EXPOSED name, the one the agent sees, so it already
 * carries the owning server's tool_prefix. Gate patterns and amount
 * mappings are therefore written against prefixed names ("pay_*").
 */
export function isGatedTool(config: BridgeConfig, toolName: string): boolean {
  if (config.downstream === null) return false;
  if (config.payment_tools === null) return true;
  return config.payment_tools.gate.some((pattern) => matchesPattern(pattern, toolName));
}

/**
 * Find the amount mapping for a tool: an exact key wins, then a SINGLE
 * matching glob key. Two overlapping wildcard mappings for one tool
 * made extraction depend on object key order (external 0.5 review), so
 * that case now returns null and the call fails closed to a human
 * instead of reading the amount from whichever mapping happened to
 * come first.
 */
export function mappingForTool(config: BridgeConfig, toolName: string): ToolMapping | null {
  const mappings = config.payment_tools?.mappings ?? {};
  if (Object.prototype.hasOwnProperty.call(mappings, toolName)) return mappings[toolName]!;
  const matches = mappingPatternsForTool(config, toolName);
  return matches.length === 1 ? mappings[matches[0]!]! : null;
}

/** Matching mapping keys for a tool: the exact key, or all matching globs. */
export function mappingPatternsForTool(config: BridgeConfig, toolName: string): string[] {
  const mappings = config.payment_tools?.mappings ?? {};
  if (Object.prototype.hasOwnProperty.call(mappings, toolName)) return [toolName];
  return Object.keys(mappings).filter(
    (key) => key.includes("*") && matchesPattern(key, toolName)
  );
}

/**
 * Dot-separated path lookup into a JSON arguments object.
 *
 * Prototype keys are refused rather than followed. `JSON.parse` puts a
 * literal "__proto__" key on the object as an own property, so a path
 * through one would read from Object.prototype instead, which is both
 * meaningless here and a way to make an amount appear where the agent
 * never put one. Returning undefined routes the call to the fail-closed
 * unextractable-amount branch, which is the right answer.
 */
export function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    if (isUnsafeKey(segment)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export type ExtractionResult =
  | { ok: true; amount_minor_units: string; currency: string; counterparty: string }
  | { ok: false; reason_code: string; detail: string };

const INTEGER_STRING = /^[0-9]+$/;

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** 2^256-1 is 78 decimal digits; larger payment amounts are never useful here. */
export const MAX_MINOR_UNIT_DIGITS = 78;

/**
 * Read amount, currency, and counterparty out of a gated tool call's
 * arguments. Every unreadable case FAILS CLOSED: the caller must route
 * the call to require_approval, never allow.
 */
export function extractPayment(
  config: BridgeConfig,
  toolName: string,
  args: Record<string, unknown>
): ExtractionResult {
  const mapping = mappingForTool(config, toolName);
  if (mapping === null || mapping.amount_field === undefined) {
    return {
      ok: false,
      reason_code: "bridge.pending.no_payment_mapping",
      detail:
        `no amount mapping configured for gated tool "${toolName}"; ` +
        "add payment_tools.mappings entry with amount_field to enable policy evaluation"
    };
  }

  const rawAmount = getPath(args, mapping.amount_field);
  let amount: string | null = null;
  if (typeof rawAmount === "number" && Number.isSafeInteger(rawAmount) && rawAmount >= 0) {
    amount = String(rawAmount);
  } else if (
    typeof rawAmount === "string" &&
    INTEGER_STRING.test(rawAmount) &&
    rawAmount.length <= MAX_MINOR_UNIT_DIGITS
  ) {
    amount = rawAmount;
  }
  if (amount === null) {
    return {
      ok: false,
      reason_code: "bridge.pending.amount_unextractable",
      detail:
        `could not read a bounded non-negative integer amount from "${mapping.amount_field}" ` +
        `in the arguments of "${toolName}" (at most ${MAX_MINOR_UNIT_DIGITS} digits)`
    };
  }

  let currency: string;
  if (mapping.currency_field !== undefined) {
    const rawCurrency = getPath(args, mapping.currency_field);
    if (typeof rawCurrency !== "string" || rawCurrency.trim().length === 0) {
      return {
        ok: false,
        reason_code: "bridge.pending.currency_unextractable",
        detail: `could not read a currency from "${mapping.currency_field}" in the arguments of "${toolName}"`
      };
    }
    currency = rawCurrency.trim().toUpperCase();
  } else {
    currency = (mapping.currency ?? config.currency).toUpperCase();
  }
  if (!/^[A-Z0-9._-]{2,20}$/.test(currency)) {
    return {
      ok: false,
      reason_code: "bridge.pending.currency_unextractable",
      detail: `currency for "${toolName}" is not a plausible 2-20 character currency or token symbol`
    };
  }

  let counterparty: string;
  if (mapping.counterparty_field !== undefined) {
    const rawCounterparty = getPath(args, mapping.counterparty_field);
    if (typeof rawCounterparty !== "string" || rawCounterparty.trim().length === 0) {
      return {
        ok: false,
        reason_code: "bridge.pending.counterparty_unextractable",
        detail: `could not read a counterparty from "${mapping.counterparty_field}" in the arguments of "${toolName}"`
      };
    }
    counterparty = rawCounterparty.trim();
  } else {
    counterparty = mapping.counterparty ?? `tool:${toolName}`;
  }
  if (counterparty.length > 512 || CONTROL_CHAR_RE.test(counterparty)) {
    return {
      ok: false,
      reason_code: "bridge.pending.counterparty_unextractable",
      detail: `counterparty for "${toolName}" must be at most 512 printable characters`
    };
  }

  return { ok: true, amount_minor_units: amount, currency, counterparty };
}

/**
 * Build the policy set for one requesting agent. The per-agent daily
 * cap is instantiated with the agent's pubkey as the initiator id, so
 * caps are enforced per identity, exactly how Buzz scopes agents.
 */
export function policiesForAgent(
  config: BridgeConfig,
  agentPubkey: string,
  history?: SpendHistorySnapshot
): PolicyV2[] {
  const c = config.controls;
  const policies: PolicyV2[] = [];

  if (c.per_agent_daily_cap) {
    policies.push(
      perAgentDailyCap({
        agent_id: agentPubkey,
        currency: config.currency,
        cap_minor_units: c.per_agent_daily_cap.cap_minor_units
      })
    );
    // The preset's rolling-window rule compares PRIOR spend. Add a
    // second, request-local amount rule for the remaining allowance so
    // one payment cannot jump from below the cap to above it. A payment
    // that lands exactly on the cap remains allowed; the first minor
    // unit over is denied.
    if (history !== undefined) {
      const cap = BigInt(c.per_agent_daily_cap.cap_minor_units);
      const prior = BigInt(history.amount_24h);
      const firstDeniedAmount = prior >= cap ? 0n : cap - prior + 1n;
      policies.push(
        defineSpendPolicy({
          name: `Remaining daily allowance for agent ${agentPubkey}`,
          description:
            `Denies a transfer that would take agent "${agentPubkey}" above its ` +
            `${c.per_agent_daily_cap.cap_minor_units} ${config.currency} daily cap.`,
          id: `policy_daily_cap_remaining_${agentPubkey.slice(0, 16)}`,
          rules: [
            { kind: "initiator_kind", in: ["agent"] },
            { kind: "initiator_id", in: [agentPubkey] },
            {
              kind: "amount",
              currency: config.currency,
              gte: firstDeniedAmount.toString()
            }
          ],
          effect: {
            kind: "deny",
            reason_code: "guardrails.deny.daily_cap_exceeded",
            reason_text: `Transfer would exceed agent ${agentPubkey}'s 24h spend cap`
          }
        })
      );
    }
  }
  if (c.single_payment_ceiling) {
    policies.push(
      humanApprovalAboveAmount({
        currency: config.currency,
        threshold_minor_units: c.single_payment_ceiling.threshold_minor_units,
        ...(c.single_payment_ceiling.approver_group !== undefined
          ? { approver_group: c.single_payment_ceiling.approver_group }
          : {})
      })
    );
  }
  if (c.counterparty_allowlist) {
    policies.push(
      counterpartyAllowlist({ allowed_ids: c.counterparty_allowlist.allowed_ids })
    );
  }
  if (c.business_hours) {
    policies.push(
      businessHoursOnly({
        tz: c.business_hours.tz,
        ...(c.business_hours.open_hour !== undefined
          ? { open_hour: c.business_hours.open_hour }
          : {}),
        ...(c.business_hours.close_hour !== undefined
          ? { close_hour: c.business_hours.close_hour }
          : {}),
        ...(c.business_hours.effect !== undefined ? { effect: c.business_hours.effect } : {})
      })
    );
  }
  if (c.velocity_count_cap) {
    policies.push(
      velocityCountCap({
        max_count: c.velocity_count_cap.max_count,
        ...(c.velocity_count_cap.window !== undefined
          ? { window: c.velocity_count_cap.window }
          : {}),
        ...(c.velocity_count_cap.effect !== undefined
          ? { effect: c.velocity_count_cap.effect }
          : {})
      })
    );
  }
  return policies;
}

/**
 * VERIFIED (block/buzz docs): buzz-acp allowlists identify authors as
 * "64-char hex pubkeys", and agent keys are minted as nsec/npub Nostr
 * keypairs. The bridge accepts either form and canonicalizes it to the
 * same 32-byte lowercase hex identity before policy or ledger use.
 */
export const HEX_PUBKEY = /^[0-9a-f]{64}$/;

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Convert a NIP-19 display-form npub to the canonical 32-byte hex key
 * (external 0.5 review). NIP-19 recommends storing keys as hex and
 * accepting npub only at input boundaries. Before this, the hex and
 * npub spellings of ONE key were two different identity strings, so an
 * agent could split its per-agent daily cap across the two spellings
 * and spend up to twice its cap. The bech32 checksum is verified, so a
 * mistyped npub is rejected instead of becoming a fresh identity.
 *
 * Returns canonical lowercase hex, or null when the value is neither a
 * 64-char hex key nor a checksum-valid npub. No curve membership check
 * on purpose: the key is an identity label here, not signature input,
 * and the documented all-zeros unattributed fallback must stay valid.
 */
export function normalizePubkey(value: string): string | null {
  if (HEX_PUBKEY.test(value)) return value;
  if (value.length !== 63 || value !== value.toLowerCase() || !value.startsWith("npub1")) {
    return null;
  }
  const words: number[] = [];
  for (const char of value.slice(5)) {
    const word = BECH32_CHARSET.indexOf(char);
    if (word < 0) return null;
    words.push(word);
  }
  if (words.length < 7 || bech32Polymod([...bech32HrpExpand("npub"), ...words]) !== 1) {
    return null;
  }
  const bytes = convertBits(words.slice(0, -6), 5, 8);
  if (bytes === null || bytes.length !== 32) return null;
  return Buffer.from(bytes).toString("hex");
}

export function isPlausiblePubkey(value: string): boolean {
  return normalizePubkey(value) !== null;
}

function bech32HrpExpand(hrp: string): number[] {
  const high = [...hrp].map((char) => char.charCodeAt(0) >> 5);
  const low = [...hrp].map((char) => char.charCodeAt(0) & 31);
  return [...high, 0, ...low];
}

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < generators.length; i++) {
      if (((top >>> i) & 1) !== 0) checksum ^= generators[i]!;
    }
  }
  return checksum >>> 0;
}

function convertBits(words: number[], from: number, to: number): number[] | null {
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << to) - 1;
  for (const word of words) {
    if (word < 0 || word >= 1 << from) return null;
    accumulator = (accumulator << from) | word;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((accumulator >>> bits) & maxValue);
    }
  }
  if (bits >= from || ((accumulator << (to - bits)) & maxValue) !== 0) return null;
  return result;
}
