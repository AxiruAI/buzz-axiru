/**
 * @axiru/agent-spend-guardrails
 *
 * Deterministic spend guardrails for AI agents.
 *
 * This package is a thin, self-contained wrapper around the pure policy
 * evaluator that powers Axiru's hosted governance platform. It adds:
 *
 *   1. `defineSpendPolicy()` — a typed builder that produces
 *      spec-conformant policy documents (schema_version 2) with
 *      sensible defaults (enforcing mode, version 1, local org).
 *   2. `guardAgentSpend()` — evaluate a simplified "spend intent"
 *      against a policy set and get back
 *      `allow | require_approval | deny` plus stable reason codes.
 *   3. `presets` (see ./presets.ts) — ready-made policy factories for
 *      the common agent-spend controls (daily caps, approval
 *      thresholds, counterparty allowlists, business hours, velocity).
 *
 * Design properties, in order of importance:
 *
 *   - DETERMINISTIC. Same intent + same policies + same history + same
 *     timestamp always produce the same decision, the same reason
 *     codes, and the same fingerprint. There is no I/O, no wall-clock
 *     access (when you pass `timestamp`), and no randomness anywhere
 *     in the evaluation path.
 *   - REPLAYABLE. Every result carries a `sha256:` fingerprint over
 *     the canonical-JSON form of the intent and a decision id derived
 *     from it. Persist (intent, policies, history, timestamp) and you
 *     can re-run the decision bit-for-bit, years later.
 *   - NO SaaS DEPENDENCY. Everything runs in-process on Node >= 18
 *     using only `node:crypto`. Axiru's hosted platform adds the
 *     evidence ledger, approvals inbox, and multi-rail ingestion on
 *     top of the exact same evaluator, but nothing here phones home.
 *
 * Reason-code namespaces (see the public spec, §5):
 *   - `guardrails.*` — canonical engine codes defined by the spec.
 *     The underlying production engine emits these under its hosted
 *     prefix (`axiru.*`); this wrapper normalizes them to the generic
 *     spec namespace so OSS adopters are not coupled to a vendor name.
 *   - `customer.*` (or any non-reserved prefix) — codes you define on
 *     your own policies via `defineSpendPolicy()`.
 *
 * Spec: docs/oss/agent-spend-policy-spec-v0.2.md (Agent Spend Policy
 * Spec v0.2 draft, July 2026).
 *
 * Licensed under the Apache License, Version 2.0.
 * Copyright 2026 Axiru.
 */

import { createHash } from "node:crypto";

import {
  isReservedReasonCode,
  type Counterparty,
  type OutboundValueTransfer,
  type PolicyEffectV2,
  type PolicyInputs,
  type PolicyRuleV2,
  type PolicyV2,
  type PolicyV2Mode,
  type Rail
} from "./types/index.js";
import { evaluate } from "./engine/index.js";

/* ------------------------------------------------------------------ */
/* Public input types — the simplified spend-intent shape             */
/* ------------------------------------------------------------------ */

/**
 * A monetary amount. `minor_units` is a base-10 integer string in the
 * smallest indivisible unit of the currency or token (cents for USD,
 * 1e-6 base units for USDC). A string, never a number: JS numbers
 * silently lose precision above 2^53, which is well inside the range
 * of large stablecoin transfers.
 */
export interface SpendAmount {
  /** ISO 4217 code or token symbol ("USD", "USDC", "PYUSD"). */
  currency: string;
  /** Non-negative base-10 integer string, e.g. "125000". */
  minor_units: string;
}

/** The agent attempting the spend. */
export interface SpendAgent {
  /** Stable agent identifier in your system. */
  id: string;
  /** Model identifier, e.g. "claude-sonnet-4-6". Optional. */
  model?: string;
  /**
   * Comma-separated scope tokens granted to the agent, e.g.
   * "payments.create,refunds.read". Consumed by `agent_scope` rules.
   */
  scope?: string;
}

/** Who is being paid. */
export interface SpendCounterparty {
  /** Stable counterparty identifier (merchant id, wallet address, ...). */
  id: string;
  kind?: Counterparty["kind"];
  name?: string;
  /** ISO-3166-1 alpha-2, e.g. "US". */
  country_code?: string;
}

/**
 * A spend intent: "agent X wants to move amount Y to counterparty Z
 * over rail R". Evaluate it BEFORE executing the transfer.
 */
export interface SpendIntent {
  /**
   * The value-transfer rail, e.g. "x402", "stripe", "usdc_solana".
   * Rails without a reference evaluator fail closed to `deny` with
   * `guardrails.deny.unknown_rail` — the guard never silently allows
   * traffic it cannot reason about.
   */
  rail: Rail;
  /** Rail action verb, e.g. "pay", "transfer", "refund". */
  action: string;
  amount: SpendAmount;
  agent: SpendAgent;
  counterparty: SpendCounterparty;
  /**
   * When the intent occurred (Date or ISO-8601 string). Drives
   * `time_of_day` rules and is used as the evaluation clock. Pass it
   * explicitly for deterministic replay; if omitted, the guard falls
   * back to `new Date()` and the decision is only reproducible if you
   * persist the `evaluated_at` it returns.
   */
  timestamp?: Date | string;
}

/**
 * Precomputed rolling-window aggregates for `rolling_window` rules.
 * The evaluator NEVER does I/O, so velocity limits compare against
 * whatever aggregates you supply here (compute them from your own
 * spend log). Scope them to match your policy's intent: for a
 * per-agent cap, aggregate only that agent's prior spend.
 *
 * Zero-sentinel escalation (preserved from the production engine): if
 * an ENFORCING policy in scope carries a `rolling_window` rule and
 * every field here is zero or absent, the guard cannot distinguish
 * "genuinely no prior activity" from "caller forgot to compute
 * aggregates". It fails safe: a clean `allow` is demoted to
 * `require_approval` with `guardrails.pending.velocity_inputs_unavailable`.
 * A brand-new agent's very first transfer under a velocity policy
 * therefore gets one conservative approval. This is deliberate.
 */
export interface SpendHistory {
  /** Sum of minor_units over the trailing 24 hours (integer string). */
  amount_24h?: string;
  /** Sum of minor_units over the trailing 30 days (integer string). */
  amount_30d?: string;
  /** Count of transfers over the trailing 24 hours. */
  count_24h?: number;
  /** Count of transfers over the trailing 30 days. */
  count_30d?: number;
}

export interface GuardInput {
  intent: SpendIntent;
  /** Policies from `defineSpendPolicy()` / the presets. OR semantics. */
  policies: PolicyV2[];
  /** Optional rolling-window aggregates. See SpendHistory docs. */
  history?: SpendHistory;
  /**
   * Evaluation clock override. Defaults to `intent.timestamp` when
   * set, else `new Date()`. Tests and replay harnesses pass a fixed
   * Date here.
   */
  now?: Date;
}

/* ------------------------------------------------------------------ */
/* Public output types                                                */
/* ------------------------------------------------------------------ */

export type GuardDecision = "allow" | "require_approval" | "deny";

export interface GuardReason {
  /** Stable, namespaced code (`guardrails.*`, `customer.*`, ...). */
  reason_code: string;
  /** Human-readable explanation. Never parse this; parse reason_code. */
  reason_text: string;
  /** Set when the reason came from a matched policy. */
  policy_id?: string;
}

export interface GuardResult {
  decision: GuardDecision;
  /**
   * The winning reason code (always `reasons[0].reason_code`). For a
   * matched policy this is the policy's own code; for the default
   * path it is `guardrails.allow.default`.
   */
  reason_code: string;
  /**
   * Full reason trail in precedence order: winner first, then every
   * other matched policy, retained for audit transparency.
   */
  reasons: GuardReason[];
  /**
   * Canonical engine summary code (`guardrails.allow.default`,
   * `guardrails.pending.approval_required`, ...). Stable across
   * customer-defined policy codes; useful for metrics and alerting.
   */
  summary_code: string;
  /**
   * `sha256:<hex>` fingerprint over the canonical-JSON form of the
   * intent. Two structurally identical intents always fingerprint
   * identically, regardless of key order. Persist it as your replay
   * and idempotency key.
   */
  fingerprint: string;
  /** Deterministic decision id derived from the fingerprint. */
  decision_id: string;
  /** The clock the evaluator used. Persist for replay. */
  evaluated_at: Date;
}

/* ------------------------------------------------------------------ */
/* defineSpendPolicy()                                                */
/* ------------------------------------------------------------------ */

export interface SpendPolicyInit {
  /** Human-readable policy name. Also seeds the default id. */
  name: string;
  /**
   * Rules are ANDed: the policy matches an intent only when EVERY
   * rule matches. Use multiple policies for OR logic. An empty rules
   * array matches every intent (a catch-all), per the spec.
   */
  rules: PolicyRuleV2[];
  /** What happens when the policy matches. */
  effect: PolicyEffectV2;
  description?: string;
  /**
   * `enforcing` (default) gates traffic. `shadow` records what WOULD
   * have happened without changing the outcome — the graduated-
   * autonomy on-ramp: ship every new policy in shadow, watch the
   * audit trail, then flip to enforcing. `disabled` skips entirely.
   */
  mode?: PolicyV2Mode;
  /** Stable id. Defaults to a slug of `name` ("policy_daily_cap"). */
  id?: string;
  /** Monotonic version, bumped on every edit. Defaults to 1. */
  version?: number;
  /** Tenant identifier. Defaults to "local" for standalone use. */
  org_id?: string;
}

/**
 * Build a spec-conformant policy document (schema_version 2).
 *
 * Timestamps are pinned to the epoch so the returned object is fully
 * deterministic (the evaluator never reads them; they exist for
 * hosted implementations that persist policies).
 *
 * Throws if `effect.reason_code` uses a reserved implementation
 * prefix (`axiru.*`, `stripe.*`, ...). Use your own namespace, e.g.
 * `customer.deny.too_large`, or the `guardrails.*` codes emitted by
 * the presets.
 */
export function defineSpendPolicy(init: SpendPolicyInit): PolicyV2 {
  if (!init.name || init.name.trim().length === 0) {
    throw new TypeError("defineSpendPolicy: name must be a non-empty string");
  }
  if (!init.effect || !init.effect.reason_code || !init.effect.reason_text) {
    throw new TypeError(
      "defineSpendPolicy: effect.reason_code and effect.reason_text are required"
    );
  }
  if (isReservedReasonCode(init.effect.reason_code)) {
    throw new TypeError(
      `defineSpendPolicy: reason_code "${init.effect.reason_code}" uses a reserved ` +
        `implementation prefix; pick your own namespace (e.g. "customer.*")`
    );
  }
  if (init.version !== undefined && (!Number.isInteger(init.version) || init.version < 1)) {
    throw new TypeError("defineSpendPolicy: version must be a positive integer");
  }

  return {
    id: init.id ?? `policy_${slugify(init.name)}`,
    org_id: init.org_id ?? "local",
    schema_version: 2,
    name: init.name,
    description: init.description ?? "",
    version: init.version ?? 1,
    author_id: "local",
    mode: init.mode ?? "enforcing",
    rules: init.rules,
    effect: init.effect,
    // Epoch-pinned for determinism; the evaluator never reads these.
    created_at: new Date(0),
    updated_at: new Date(0)
  };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "unnamed";
}

/* ------------------------------------------------------------------ */
/* guardAgentSpend()                                                  */
/* ------------------------------------------------------------------ */

/**
 * Evaluate a spend intent against a policy set.
 *
 * Semantics (spec §6):
 *   - Rules within a policy are ANDed; policies are ORed.
 *   - Precedence: deny > require_approval > allow. One matched deny
 *     wins regardless of how many allows also matched.
 *   - Shadow-mode matches are recorded in `reasons` but never change
 *     the decision.
 *   - Zero matches → `allow` with `guardrails.allow.default`.
 *   - Fail closed: unevaluable rules (bad timezone, malformed value)
 *     and missing velocity aggregates demote a clean `allow` to
 *     `require_approval`, never silently allow.
 *
 * Throws `TypeError` on malformed input (non-integer amount strings,
 * invalid timestamps, negative history counts) BEFORE evaluation —
 * a guardrail that cannot parse its input must not guess.
 */
export function guardAgentSpend(input: GuardInput): GuardResult {
  const { intent, policies, history } = input;

  const minorUnits = parseMinorUnits(intent.amount.minor_units, "intent.amount.minor_units");
  const eventAt = resolveTimestamp(intent.timestamp);
  const now = input.now ?? eventAt;
  const ovt = intentToOvt(intent, minorUnits, history, eventAt);

  const decision = evaluate({ ovt, policies, context: { now } });

  const reasons: GuardReason[] = decision.reasons.map((r) => ({
    reason_code: normalizeReasonCode(r.reason_code),
    reason_text: r.reason_text,
    ...(r.policy_id !== undefined ? { policy_id: r.policy_id } : {})
  }));

  return {
    decision: decision.action,
    reason_code: reasons[0]!.reason_code,
    reasons,
    summary_code: normalizeReasonCode(String(decision.axiru_reason_code)),
    fingerprint: ovt.fingerprint,
    decision_id: decision.id,
    evaluated_at: decision.evaluated_at
  };
}

/* ------------------------------------------------------------------ */
/* Reason-code normalization                                          */
/* ------------------------------------------------------------------ */

/**
 * The production engine emits canonical codes under its hosted
 * implementation prefix (`axiru.*`). The public spec names the same
 * codes generically as `guardrails.*`; hosted implementations MAY
 * substitute their own prefix (spec §5.3). This wrapper presents the
 * generic namespace so OSS adopters key on vendor-neutral codes.
 */
export function normalizeReasonCode(code: string): string {
  return code.startsWith("axiru.") ? `guardrails.${code.slice("axiru.".length)}` : code;
}

/* ------------------------------------------------------------------ */
/* Intent → OutboundValueTransfer conversion                          */
/* ------------------------------------------------------------------ */

const PACKAGE_TAG = "agent-spend-guardrails/0.1";

function intentToOvt(
  intent: SpendIntent,
  minorUnits: bigint,
  history: SpendHistory | undefined,
  eventAt: Date
): OutboundValueTransfer {
  const currency = intent.amount.currency.toUpperCase();

  const initiator = {
    kind: "agent" as const,
    id: intent.agent.id,
    agent_metadata: {
      model: intent.agent.model ?? "unspecified",
      version: "unspecified",
      scope: intent.agent.scope ?? ""
    }
  };

  const counterparty: Counterparty = {
    kind: intent.counterparty.kind ?? "unknown",
    id: intent.counterparty.id,
    ...(intent.counterparty.name !== undefined || intent.counterparty.country_code !== undefined
      ? {
          display: {
            ...(intent.counterparty.name !== undefined ? { name: intent.counterparty.name } : {}),
            ...(intent.counterparty.country_code !== undefined
              ? { country_code: intent.counterparty.country_code.toUpperCase() }
              : {})
          }
        }
      : {})
  };

  const context = buildRailContext(intent, currency);

  // Fingerprint over the same field set the production engine uses:
  // (rail, rail_action, amount, initiator, counterparty, context).
  // Canonical JSON (sorted keys) + sha256 via node:crypto. Zero deps.
  const fingerprint = sha256Fingerprint({
    rail: intent.rail,
    rail_action: intent.action,
    amount: { currency, minor_units: minorUnits.toString() },
    initiator,
    counterparty: counterparty as unknown as CanonicalValue,
    context
  });
  const hex = fingerprint.slice("sha256:".length);

  const policy_inputs: PolicyInputs = {
    amount_24h: parseOptionalMinorUnits(history?.amount_24h, "history.amount_24h"),
    amount_30d: parseOptionalMinorUnits(history?.amount_30d, "history.amount_30d"),
    count_24h: parseOptionalCount(history?.count_24h, "history.count_24h"),
    count_30d: parseOptionalCount(history?.count_30d, "history.count_30d")
  };

  // The simplified intent cannot know every rail-specific context
  // field, so we synthesize a deterministic minimal context per rail
  // and widen through unknown. Rule evaluation never depends on
  // context fields beyond what we set; rails without a reference
  // evaluator are denied before context is ever consulted.
  const ovt = {
    id: `ovt_${hex.slice(0, 16)}`,
    org_id: "local",
    idempotency_key: fingerprint,
    rail: intent.rail,
    rail_action: intent.action,
    amount: { currency, minor_units: minorUnits },
    initiator,
    counterparty,
    rail_event_at: eventAt,
    ingested_at: eventAt,
    fingerprint,
    policy_inputs,
    context
  } as unknown as OutboundValueTransfer;

  return ovt;
}

/**
 * Deterministic minimal per-rail context. Values are pure functions
 * of the intent so the fingerprint stays replayable.
 */
function buildRailContext(intent: SpendIntent, currency: string): Record<string, CanonicalValue> {
  switch (intent.rail) {
    case "stripe":
      return { stripe_account_id: "local", api_version: PACKAGE_TAG };
    case "stripe_daa":
      return {
        stripe_account_id: "local",
        digital_asset_account_id: "local",
        asset: currency,
        chain: "unspecified",
        api_version: PACKAGE_TAG
      };
    case "x402":
      return {
        facilitator_url: "local",
        resource_url: intent.counterparty.id,
        asset: currency,
        chain: "unspecified"
      };
    case "usdc_solana":
      return { chain: "solana", from_address: "local", to_address: intent.counterparty.id };
    default:
      // Rails with no reference evaluator: the engine fails closed to
      // deny (guardrails.deny.unknown_rail) before reading context.
      return { rail: intent.rail };
  }
}

/* ------------------------------------------------------------------ */
/* Input validation                                                   */
/* ------------------------------------------------------------------ */

const INTEGER_STRING = /^[0-9]+$/;

function parseMinorUnits(value: string, label: string): bigint {
  if (typeof value !== "string" || !INTEGER_STRING.test(value)) {
    throw new TypeError(
      `${label} must be a non-negative base-10 integer string (got ${JSON.stringify(value)}). ` +
        `Amounts are decimal strings in minor units to avoid float precision loss.`
    );
  }
  return BigInt(value);
}

function parseOptionalMinorUnits(value: string | undefined, label: string): bigint {
  if (value === undefined) return 0n;
  return parseMinorUnits(value, label);
}

function parseOptionalCount(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function resolveTimestamp(timestamp: Date | string | undefined): Date {
  if (timestamp === undefined) {
    return new Date();
  }
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      `intent.timestamp is not a valid Date or ISO-8601 string (got ${JSON.stringify(timestamp)})`
    );
  }
  return date;
}

/* ------------------------------------------------------------------ */
/* Canonical JSON + sha256 fingerprint (zero heavy deps)              */
/* ------------------------------------------------------------------ */

type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

/**
 * Serialize with lexicographically sorted keys at every nesting level
 * so structurally identical values always stringify identically.
 * `undefined` object properties are skipped (matching JSON.stringify);
 * NaN/Infinity and non-JSON leaves throw.
 */
export function canonicalJsonStringify(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJsonStringify: NaN/Infinity cannot be fingerprinted");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(value[k] as CanonicalValue)}`
    );
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalJsonStringify: unsupported value of type ${typeof value}`);
}

/** `sha256:<64-hex>` over the canonical-JSON form of `value`. */
export function sha256Fingerprint(value: { [key: string]: CanonicalValue | undefined }): string {
  const digest = createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/* ------------------------------------------------------------------ */
/* Presets                                                            */
/* ------------------------------------------------------------------ */

export {
  perAgentDailyCap,
  humanApprovalAboveAmount,
  counterpartyAllowlist,
  businessHoursOnly,
  velocityCountCap
} from "./presets.js";

/* ------------------------------------------------------------------ */
/* Re-exported wire types, so adopters need only this package         */
/* ------------------------------------------------------------------ */

export type { PolicyV2, PolicyRuleV2, PolicyEffectV2, PolicyV2Mode, Rail };
