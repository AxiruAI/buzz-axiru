/**
 * Ready-made policy presets for the common agent-spend controls.
 *
 * Each preset is a documented factory that returns a spec-conformant
 * policy document via `defineSpendPolicy()`. Presets default to
 * `enforcing` mode; pass `mode: "shadow"` to observe first (the
 * recommended graduated-autonomy on-ramp).
 *
 * Reason codes emitted by presets live under the `guardrails.*`
 * namespace defined by the Agent Spend Policy Spec v0.2.
 *
 * Licensed under the Apache License, Version 2.0.
 * Copyright 2026 Axiru.
 */

import type { PolicyRuleV2, PolicyV2, PolicyV2Mode } from "./types/index.js";
import { defineSpendPolicy } from "./index.js";

/** Options shared by every preset. */
export interface PresetCommonOptions {
  /** Policy mode. Defaults to "enforcing". */
  mode?: PolicyV2Mode;
  /** Override the derived policy id. */
  id?: string;
}

/* ------------------------------------------------------------------ */
/* 1. Per-agent daily cap                                             */
/* ------------------------------------------------------------------ */

export interface PerAgentDailyCapOptions extends PresetCommonOptions {
  /** The agent this cap applies to. */
  agent_id: string;
  /** Currency the cap is denominated in ("USD", "USDC", ...). */
  currency: string;
  /**
   * The 24h cap in minor units (integer string). The policy DENIES
   * once the agent's trailing-24h spend (supplied via
   * `guardAgentSpend({ history })`) reaches or exceeds this value.
   */
  cap_minor_units: string;
}

/**
 * Deny an agent's spend once its trailing-24h total hits the cap.
 *
 * IMPORTANT — aggregate scoping: `rolling_window` rules compare
 * against the aggregates YOU pass in `history`. For a per-agent cap,
 * compute `history.amount_24h` over that agent's prior transfers
 * only. If you pass org-wide totals, the cap fires on org-wide spend.
 *
 * Zero-sentinel behavior: with this (enforcing) policy in scope and
 * no history supplied, a clean allow is demoted to require_approval
 * (`guardrails.pending.velocity_inputs_unavailable`). Supply real
 * aggregates, even "0"-adjacent ones, once the agent has any history.
 *
 * Cap semantics: the comparison is against PRIOR spend, excluding the
 * intent being evaluated. To make the cap inclusive of the pending
 * amount, add it into `history.amount_24h` before calling the guard.
 */
export function perAgentDailyCap(options: PerAgentDailyCapOptions): PolicyV2 {
  requireIntegerString(options.cap_minor_units, "cap_minor_units");
  return defineSpendPolicy({
    name: `Daily cap for agent ${options.agent_id}`,
    description:
      `Denies transfers initiated by agent "${options.agent_id}" once its trailing-24h ` +
      `spend reaches ${options.cap_minor_units} minor units of ${options.currency.toUpperCase()}.`,
    id: options.id ?? `policy_daily_cap_${slugFragment(options.agent_id)}`,
    mode: options.mode,
    rules: [
      { kind: "initiator_kind", in: ["agent"] },
      { kind: "initiator_id", in: [options.agent_id] },
      {
        kind: "rolling_window",
        window: "24h",
        aggregate: "sum_amount",
        op: "gte",
        value: options.cap_minor_units
      }
    ],
    effect: {
      kind: "deny",
      reason_code: "guardrails.deny.daily_cap_exceeded",
      reason_text: `Agent ${options.agent_id} exceeded its 24h spend cap`
    }
  });
}

/* ------------------------------------------------------------------ */
/* 2. Human approval above amount                                     */
/* ------------------------------------------------------------------ */

export interface HumanApprovalAboveAmountOptions extends PresetCommonOptions {
  /** Currency the threshold is denominated in. */
  currency: string;
  /** Threshold in minor units (integer string), inclusive. */
  threshold_minor_units: string;
  /** Approver group hint routed with the approval (optional). */
  approver_group?: string;
}

/**
 * Route any single transfer at or above the threshold to a human.
 * The intent is neither allowed nor denied: the caller receives
 * `require_approval` and holds execution until a person decides.
 *
 * Note: the currency must match the intent's currency (currencies
 * never compare silently). A mismatch is a rule-evaluation error and
 * fails closed to require_approval, never to allow.
 */
export function humanApprovalAboveAmount(options: HumanApprovalAboveAmountOptions): PolicyV2 {
  requireIntegerString(options.threshold_minor_units, "threshold_minor_units");
  const currency = options.currency.toUpperCase();
  return defineSpendPolicy({
    name: `Human approval above ${options.threshold_minor_units} ${currency}`,
    description:
      `Requires human approval for any agent-initiated transfer of ` +
      `${options.threshold_minor_units} minor units of ${currency} or more.`,
    id: options.id ?? `policy_approval_above_${options.threshold_minor_units}_${slugFragment(currency)}`,
    mode: options.mode,
    rules: [
      { kind: "initiator_kind", in: ["agent"] },
      { kind: "amount", currency, gte: options.threshold_minor_units }
    ],
    effect: {
      kind: "require_approval",
      reason_code: "guardrails.pending.above_approval_threshold",
      reason_text: `Transfer at or above ${options.threshold_minor_units} minor units of ${currency} requires human approval`,
      ...(options.approver_group !== undefined ? { approver_group: options.approver_group } : {})
    }
  });
}

/* ------------------------------------------------------------------ */
/* 3. Counterparty allowlist                                          */
/* ------------------------------------------------------------------ */

export interface CounterpartyAllowlistOptions extends PresetCommonOptions {
  /**
   * Counterparty ids agents may pay. Anything NOT in this list is
   * denied. Ids must match /^[A-Za-z0-9_.:@/-]+$/ (they are embedded
   * in a sandboxed policy expression; quoting characters are refused
   * rather than escaped so the expression stays trivially auditable).
   */
  allowed_ids: string[];
}

const SAFE_ID = /^[A-Za-z0-9_.:@/-]+$/;

/**
 * Deny agent spend to any counterparty outside the allowlist.
 *
 * Implementation note: the rule DSL's `counterparty` rule expresses
 * membership ("id is in [...]"), and rules are ANDed, so a pure
 * negative match uses the spec's sandboxed expression rule:
 * `!(ovt.counterparty.id in ["a", "b"])`. Deterministic, budgeted,
 * no host access.
 */
export function counterpartyAllowlist(options: CounterpartyAllowlistOptions): PolicyV2 {
  if (options.allowed_ids.length === 0) {
    throw new TypeError("counterpartyAllowlist: allowed_ids must not be empty");
  }
  for (const id of options.allowed_ids) {
    if (!SAFE_ID.test(id)) {
      throw new TypeError(
        `counterpartyAllowlist: id ${JSON.stringify(id)} contains characters outside ` +
          `[A-Za-z0-9_.:@/-] and cannot be safely embedded in a policy expression`
      );
    }
  }
  const list = options.allowed_ids.map((id) => `"${id}"`).join(", ");
  return defineSpendPolicy({
    name: "Counterparty allowlist",
    description: `Denies agent transfers to any counterparty not in: ${options.allowed_ids.join(", ")}.`,
    id: options.id ?? "policy_counterparty_allowlist",
    mode: options.mode,
    rules: [
      { kind: "initiator_kind", in: ["agent"] },
      { kind: "custom_expression", expression: `!(ovt.counterparty.id in [${list}])` }
    ],
    effect: {
      kind: "deny",
      reason_code: "guardrails.deny.counterparty_not_allowlisted",
      reason_text: "Counterparty is not on the allowlist"
    }
  });
}

/* ------------------------------------------------------------------ */
/* 4. Business hours only                                             */
/* ------------------------------------------------------------------ */

export interface BusinessHoursOnlyOptions extends PresetCommonOptions {
  /** IANA timezone, e.g. "America/New_York". */
  tz: string;
  /** Opening hour, 0-23. Defaults to 9. */
  open_hour?: number;
  /** Closing hour, 1-24, exclusive. Defaults to 17. */
  close_hour?: number;
  /**
   * What to do outside business hours. Defaults to "deny"; pass
   * "require_approval" to queue after-hours spend for a human instead.
   */
  effect?: "deny" | "require_approval";
}

/**
 * Block (or escalate) agent spend outside business hours.
 *
 * The rule matches the COMPLEMENT of the open window using a
 * cross-midnight range: open 9-17 produces a match window of
 * [17, 24) union [0, 9), evaluated against the intent's timestamp
 * projected into `tz` (DST handled by the runtime's IANA database).
 */
export function businessHoursOnly(options: BusinessHoursOnlyOptions): PolicyV2 {
  const open = options.open_hour ?? 9;
  const close = options.close_hour ?? 17;
  if (!Number.isInteger(open) || open < 0 || open > 23) {
    throw new TypeError(`businessHoursOnly: open_hour must be an integer 0-23 (got ${open})`);
  }
  if (!Number.isInteger(close) || close < 1 || close > 24) {
    throw new TypeError(`businessHoursOnly: close_hour must be an integer 1-24 (got ${close})`);
  }
  if (open === close) {
    throw new TypeError("businessHoursOnly: open_hour and close_hour must differ");
  }
  const effectKind = options.effect ?? "deny";
  return defineSpendPolicy({
    name: `Business hours only (${options.tz})`,
    description:
      `Agent spend is only allowed between ${open}:00 and ${close}:00 in ${options.tz}; ` +
      `outside that window the effect is ${effectKind}.`,
    id: options.id ?? "policy_business_hours_only",
    mode: options.mode,
    rules: [
      { kind: "initiator_kind", in: ["agent"] },
      // Complement of [open, close): a cross-midnight range that
      // matches exactly the out-of-hours span.
      { kind: "time_of_day", tz: options.tz, ranges: [{ start: close, end: open }] }
    ],
    effect:
      effectKind === "deny"
        ? {
            kind: "deny",
            reason_code: "guardrails.deny.outside_business_hours",
            reason_text: `Agent spend outside ${open}:00-${close}:00 ${options.tz} is blocked`
          }
        : {
            kind: "require_approval",
            reason_code: "guardrails.pending.outside_business_hours",
            reason_text: `Agent spend outside ${open}:00-${close}:00 ${options.tz} requires human approval`
          }
  });
}

/* ------------------------------------------------------------------ */
/* 5. Velocity count cap                                              */
/* ------------------------------------------------------------------ */

export interface VelocityCountCapOptions extends PresetCommonOptions {
  /** Rolling window. Defaults to "24h". */
  window?: "24h" | "30d";
  /**
   * Maximum number of PRIOR transfers in the window. Once the count
   * you supply via `history` reaches this value, the effect fires.
   */
  max_count: number;
  /**
   * What to do at the cap. Defaults to "require_approval" (a burst of
   * transfers is more often a runaway loop than an attack; a human
   * unblocks it). Pass "deny" for a hard stop.
   */
  effect?: "deny" | "require_approval";
}

/**
 * Escalate or deny when transfer COUNT in the rolling window hits the
 * cap: the classic runaway-agent circuit breaker (an agent stuck in a
 * retry loop rarely trips amount caps, but always trips count caps).
 *
 * Same aggregate-scoping and zero-sentinel notes as
 * {@link perAgentDailyCap}: counts come from the `history` you pass,
 * and missing history demotes clean allows to require_approval.
 */
export function velocityCountCap(options: VelocityCountCapOptions): PolicyV2 {
  if (!Number.isInteger(options.max_count) || options.max_count < 1) {
    throw new TypeError(`velocityCountCap: max_count must be a positive integer (got ${options.max_count})`);
  }
  const window = options.window ?? "24h";
  const effectKind = options.effect ?? "require_approval";
  return defineSpendPolicy({
    name: `Velocity cap: ${options.max_count} transfers per ${window}`,
    description:
      `Fires once the agent-supplied ${window} transfer count reaches ${options.max_count}; ` +
      `effect is ${effectKind}.`,
    id: options.id ?? `policy_velocity_count_${window}`,
    mode: options.mode,
    rules: [
      { kind: "initiator_kind", in: ["agent"] },
      {
        kind: "rolling_window",
        window,
        aggregate: "count",
        op: "gte",
        value: String(options.max_count)
      }
    ],
    effect:
      effectKind === "deny"
        ? {
            kind: "deny",
            reason_code: "guardrails.deny.velocity_count_exceeded",
            reason_text: `Transfer count reached the ${window} cap of ${options.max_count}`
          }
        : {
            kind: "require_approval",
            reason_code: "guardrails.pending.velocity_count_exceeded",
            reason_text: `Transfer count reached the ${window} cap of ${options.max_count}; requires human approval`
          }
  });
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                   */
/* ------------------------------------------------------------------ */

const INTEGER_STRING = /^[0-9]+$/;

function requireIntegerString(value: string, label: string): void {
  if (typeof value !== "string" || !INTEGER_STRING.test(value)) {
    throw new TypeError(
      `${label} must be a non-negative base-10 integer string (got ${JSON.stringify(value)})`
    );
  }
}

function slugFragment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "x";
}

/** Rule type re-export for preset extenders. */
export type { PolicyRuleV2 };
