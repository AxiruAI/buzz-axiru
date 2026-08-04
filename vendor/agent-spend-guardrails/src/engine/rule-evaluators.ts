/**
 * Pure evaluators for each `PolicyRuleV2` variant.
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §5.2.
 *
 * Each function returns a `RuleEvaluation` with `matched: boolean` and
 * an optional `error` string. The caller (policy-matcher.ts) ANDs the
 * `matched` field across every rule on a policy to decide if the
 * policy as a whole matches.
 *
 * Phase 1 coverage:
 *   Wk 3 (T-012 / T-013): RailRule, RailActionRule, AmountRule,
 *     InitiatorKindRule, InitiatorIdRule, CounterpartyRule.
 *   Wk 4 (T-016 / T-017): RollingWindowRule, TimeOfDayRule,
 *     AgentScopeRule, CustomExpressionRule.
 *
 * Purity invariant: no `new Date()`, no I/O, no logging. The single
 * impure dependency is the optional FxResolver, which is passed in
 * via EvalContext and is itself contractually pure. TimeOfDayRule
 * uses `Intl.DateTimeFormat`, which is pure (snapshot of the ICU
 * timezone database compiled into the runtime).
 */

import type {
  AgentApprovalTierRule,
  AgentBudgetRule,
  AgentPaymentExtension,
  AmountRule,
  CounterpartyRule,
  CustomExpressionRule,
  InitiatorIdRule,
  InitiatorKindRule,
  MandateScopeRule,
  OutboundValueTransfer,
  PolicyEffectV2,
  PolicyInputs,
  PolicyRuleV2,
  RailActionRule,
  RailRule,
  RollingWindowRule,
  TimeOfDayRule,
  AgentScopeRule
} from "../types/index.js";
import { agentPaymentOf } from "../types/index.js";

import type { EvalContext, RuleEvaluation } from "./types.js";
import { evaluateCustomExpressionRule } from "./custom-expression.js";

export { evaluateCustomExpressionRule };

/* ------------------------------------------------------------------ */
/* RailRule                                                           */
/* ------------------------------------------------------------------ */

/**
 * Whitelist of rails. Empty `in: []` means "all rails" by convention
 * (matches the spec author guidance that a rule with no constraint
 * does not narrow the policy). The policy editor enforces this — we
 * reproduce the same semantics here so a hand-crafted policy with an
 * empty `in` array doesn't silently never-match.
 */
export function evaluateRailRule(rule: RailRule, ovt: OutboundValueTransfer): RuleEvaluation {
  if (rule.in.length === 0) {
    return { matched: true };
  }
  return { matched: rule.in.includes(ovt.rail) };
}

/* ------------------------------------------------------------------ */
/* RailActionRule                                                     */
/* ------------------------------------------------------------------ */

/**
 * Whitelist of `rail_action` strings. The spec explicitly leaves
 * cross-rail action compatibility (e.g. a rule that names "refund"
 * matches both Stripe and StripeDAA refunds) to the policy author —
 * the engine does NOT enforce action-name uniqueness across rails.
 * See `policy-v2.ts` comment on RailActionRule.
 */
export function evaluateRailActionRule(rule: RailActionRule, ovt: OutboundValueTransfer): RuleEvaluation {
  if (rule.in.length === 0) {
    return { matched: true };
  }
  return { matched: rule.in.includes(ovt.rail_action) };
}

/* ------------------------------------------------------------------ */
/* AmountRule                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compare the OVT's amount against a `gte` / `lte` band.
 *
 * Same-currency path: a direct bigint comparison. No FX resolver
 * required.
 *
 * Cross-currency path: if `rule.fx_base` is set AND it differs from
 * `ovt.amount.currency`, the evaluator multiplies the OVT amount by
 * the FX rate from `context.fx`. The result is rounded to the nearest
 * bigint (round-half-away-from-zero) so the comparison is deterministic
 * and lossless to the smallest displayable unit. We chose this over
 * truncation because truncation can flip a high-watermark match from
 * "deny" to "allow" at the boundary (e.g. $1000.00 rule vs $999.99
 * OVT after conversion).
 *
 * Errors that produce `matched: false` with a populated `error`:
 *   - `fx_base` set but no FX resolver provided
 *   - resolver returns 0, negative, NaN, or non-finite
 *
 * Why these are errors rather than allowed-through silently:
 * an FX miss could otherwise let a high-value transfer slip past a
 * blocked policy. Failing closed (matched: false) keeps the policy
 * from blocking, but the dispatcher escalates the error to a
 * `axiru.deny.expression_timeout`-family reason that downgrades to
 * `require_approval`. See spec §5.6 "FX evaluation failures".
 */
export function evaluateAmountRule(
  rule: AmountRule,
  ovt: OutboundValueTransfer,
  context: EvalContext
): RuleEvaluation {
  // P2-6: thresholds (gte/lte) are denominated in rule.currency, while the
  // amount is converted to rule.fx_base. If those differ, the comparison is
  // incoherent — fail closed rather than compare across denominations.
  if (rule.fx_base && rule.currency !== rule.fx_base) {
    return {
      matched: false,
      error: `AmountRule fx_base ${rule.fx_base} must equal rule currency ${rule.currency}; thresholds are denominated in rule.currency`
    };
  }

  let amount: bigint;
  if (rule.fx_base && rule.fx_base !== ovt.amount.currency) {
    if (!context.fx) {
      return {
        matched: false,
        error: `AmountRule requires FX conversion (${ovt.amount.currency} → ${rule.fx_base}) but no FX resolver was provided`
      };
    }
    const rate = context.fx(ovt.amount.currency, rule.fx_base, context.now);
    if (!Number.isFinite(rate) || rate <= 0) {
      return {
        matched: false,
        error: `AmountRule FX resolver returned a non-positive or non-finite rate (${rate}) for ${ovt.amount.currency} → ${rule.fx_base}`
      };
    }
    // P1-2: convert with bigint fixed-point math. `Number(minor_units)` would
    // truncate large token base-unit amounts (>2^53) and flip threshold
    // comparisons at the boundary. We scale the float rate to a 1e9 fixed-point
    // integer and multiply the exact bigint amount, rounding half up.
    // See docs/reviews/2026-07-02-codebase-review.md P1-2.
    const RATE_SCALE = 1_000_000_000n; // 1e9
    const scaledRate = BigInt(Math.round(rate * 1e9));
    amount = (ovt.amount.minor_units * scaledRate + RATE_SCALE / 2n) / RATE_SCALE;
  } else {
    amount = ovt.amount.minor_units;
  }

  // Rule currency mismatch (no fx_base, but rule currency differs).
  // We do NOT silently allow this — it indicates a policy-author error.
  if (!rule.fx_base && rule.currency !== ovt.amount.currency) {
    return {
      matched: false,
      error: `AmountRule currency ${rule.currency} does not match OVT amount currency ${ovt.amount.currency} and no fx_base was specified`
    };
  }

  if (rule.gte !== undefined) {
    if (amount < BigInt(rule.gte)) {
      return { matched: false };
    }
  }
  if (rule.lte !== undefined) {
    if (amount > BigInt(rule.lte)) {
      return { matched: false };
    }
  }
  return { matched: true };
}

function roundHalfAwayFromZero(value: number): bigint {
  if (value >= 0) {
    return BigInt(Math.floor(value + 0.5));
  }
  return BigInt(-Math.floor(-value + 0.5));
}

/* ------------------------------------------------------------------ */
/* InitiatorKindRule                                                  */
/* ------------------------------------------------------------------ */

/**
 * Drives "agent-only" or "human-only" policies. The spec's headline
 * Phase 1 use case ("block agent-initiated refunds > $X") composes
 * this with AmountRule.
 */
export function evaluateInitiatorKindRule(
  rule: InitiatorKindRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  if (rule.in.length === 0) {
    return { matched: true };
  }
  return { matched: rule.in.includes(ovt.initiator.kind) };
}

/* ------------------------------------------------------------------ */
/* InitiatorIdRule                                                    */
/* ------------------------------------------------------------------ */

/**
 * Allow- or block-list a specific Clerk user / agent id / workflow id.
 * Useful for the "freeze this specific agent" workflow that today is
 * implemented at the AgentControl table layer.
 */
export function evaluateInitiatorIdRule(
  rule: InitiatorIdRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  if (rule.in.length === 0) {
    return { matched: true };
  }
  return { matched: rule.in.includes(ovt.initiator.id) };
}

/* ------------------------------------------------------------------ */
/* CounterpartyRule                                                   */
/* ------------------------------------------------------------------ */

/**
 * Counterparty filtering. All sub-fields are independently optional;
 * a rule with every field unset is treated as match-all (consistent
 * with RailRule / RailActionRule semantics).
 *
 * The `country_in` and `country_not_in` fields use ISO-3166-1 alpha-2
 * and are case-sensitive (uppercase canonical). The policy editor
 * uppercases on save; we trust that here.
 */
export function evaluateCounterpartyRule(
  rule: CounterpartyRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  if (rule.kind_in && rule.kind_in.length > 0) {
    if (!rule.kind_in.includes(ovt.counterparty.kind)) {
      return { matched: false };
    }
  }
  if (rule.id_in && rule.id_in.length > 0) {
    if (!rule.id_in.includes(ovt.counterparty.id)) {
      return { matched: false };
    }
  }
  const country = ovt.counterparty.display?.country_code;
  if (rule.country_in && rule.country_in.length > 0) {
    if (!country || !rule.country_in.includes(country)) {
      return { matched: false };
    }
  }
  if (rule.country_not_in && rule.country_not_in.length > 0) {
    if (country && rule.country_not_in.includes(country)) {
      return { matched: false };
    }
  }
  return { matched: true };
}

/* ------------------------------------------------------------------ */
/* RollingWindowRule                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rolling-window comparison against the org's running aggregates.
 *
 * Aggregates are DENORMALIZED onto the OVT at intake (see
 * `PolicyInputs` in `@axiru/agent-spend-guardrails (vendored types)`) so this evaluator never
 * needs to perform I/O. That preserves the purity invariant and the
 * Decision Replay guarantee — a stored OVT replayed years later still
 * carries the exact aggregate counters it saw at the time. See spec
 * §5.5.
 *
 * Phase 1 scope: the precomputed aggregates are ORG-LEVEL. The spec's
 * `group_by` modifier (by_initiator / by_counterparty / by_agent)
 * would require either per-group precomputation at intake (extra cost
 * on every webhook) or a database-backed evaluator (kills purity).
 * Phase 1 therefore evaluates only the org-level path and fails
 * closed when `group_by` is set — the rule is treated as a non-match
 * with an error, which the dispatcher escalates to
 * `require_approval` rather than silently allowing through. Phase 2
 * (T-058 in the spec) will add per-group aggregate columns to the
 * OVT and revisit this.
 *
 * Window semantics: `24h` reads `policy_inputs.{amount,count}_24h`;
 * `30d` reads `policy_inputs.{amount,count}_30d`. The window is a
 * rolling lookback ending at `rail_event_at`, populated by the
 * intake adapter — `context.now` is NOT consulted here because
 * staleness checks belong at intake.
 */
export function evaluateRollingWindowRule(
  rule: RollingWindowRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  if (rule.group_by) {
    return {
      matched: false,
      error: `RollingWindowRule.group_by="${rule.group_by}" is not supported in Phase 1 (org-level aggregates only). Tracked under spec T-058; rule fails closed.`
    };
  }

  let actual: bigint;
  if (rule.aggregate === "sum_amount") {
    actual = rule.window === "24h" ? ovt.policy_inputs.amount_24h : ovt.policy_inputs.amount_30d;
  } else {
    // count aggregate — stored as number, widen to bigint for uniform comparison.
    const countNumber = rule.window === "24h" ? ovt.policy_inputs.count_24h : ovt.policy_inputs.count_30d;
    actual = BigInt(countNumber);
  }

  let target: bigint;
  try {
    target = BigInt(rule.value);
  } catch (err) {
    return {
      matched: false,
      error: `RollingWindowRule.value="${rule.value}" is not a valid bigint literal: ${(err as Error).message}`
    };
  }

  if (rule.op === "gte") {
    return { matched: actual >= target };
  }
  // op === "lte"
  return { matched: actual <= target };
}

/* ------------------------------------------------------------------ */
/* TimeOfDayRule                                                      */
/* ------------------------------------------------------------------ */

/**
 * Time-of-day windowing in a customer-provided IANA timezone.
 *
 * The rule matches when `ovt.rail_event_at`, projected into
 * `rule.tz`, falls inside ANY of the configured `ranges`. Each range
 * is `[start, end)` measured in whole hours 0-24. We deliberately do
 * not support minute granularity in Phase 1 — every observed v1
 * policy in production uses hour windows, and supporting minutes
 * would require a more elaborate cross-midnight calculation.
 *
 * Cross-midnight ranges (e.g. `{ start: 22, end: 6 }`) are supported:
 * we treat them as the union of `[22, 24)` ∪ `[0, 6)`. This is the
 * conventional finance interpretation ("overnight banking window").
 *
 * Timezone resolution: we use `Intl.DateTimeFormat` with the `hour`
 * part in 24h form. This honors DST automatically; on a fall-back
 * day the 1:00 hour appears twice (once in DST, once after), which
 * is fine for an inclusive-of-start / exclusive-of-end window
 * because both instants still map to hour=1.
 *
 * Invalid `tz` strings throw inside `Intl.DateTimeFormat` — we trap
 * that and surface as a typed error so a bad timezone never silently
 * allows a transfer through.
 */
export function evaluateTimeOfDayRule(
  rule: TimeOfDayRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  if (rule.ranges.length === 0) {
    // A rule with no ranges is interpreted as "never matches" rather
    // than "always matches" — the rule's whole purpose is to constrain
    // the time window, so an empty list is almost certainly an editor
    // bug. We fail closed.
    return {
      matched: false,
      error: "TimeOfDayRule.ranges is empty; rule cannot match any time. Likely a policy-editor bug."
    };
  }

  let hourInTz: number;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: rule.tz,
      hour12: false,
      hour: "2-digit"
    });
    const parts = formatter.formatToParts(ovt.rail_event_at);
    const hourPart = parts.find((p) => p.type === "hour");
    if (!hourPart) {
      return {
        matched: false,
        error: `TimeOfDayRule failed to read hour from rail_event_at in tz="${rule.tz}"`
      };
    }
    // Intl returns hour as a 2-digit string; in 24h mode midnight can
    // come back as "24" on some runtimes — normalize to 0-23.
    const h = Number.parseInt(hourPart.value, 10);
    if (!Number.isInteger(h) || h < 0 || h > 24) {
      return {
        matched: false,
        error: `TimeOfDayRule got unexpected hour value "${hourPart.value}" from Intl in tz="${rule.tz}"`
      };
    }
    hourInTz = h === 24 ? 0 : h;
  } catch (err) {
    return {
      matched: false,
      error: `TimeOfDayRule timezone "${rule.tz}" is invalid: ${(err as Error).message}`
    };
  }

  for (const range of rule.ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
      return {
        matched: false,
        error: `TimeOfDayRule range has non-integer bounds: { start: ${range.start}, end: ${range.end} }`
      };
    }
    if (range.start < 0 || range.start > 24 || range.end < 0 || range.end > 24) {
      return {
        matched: false,
        error: `TimeOfDayRule range out of 0..24 bounds: { start: ${range.start}, end: ${range.end} }`
      };
    }
    if (range.start === range.end) {
      // Zero-width range can never match; skip rather than treat as all-day.
      continue;
    }
    if (range.start < range.end) {
      // Normal range.
      if (hourInTz >= range.start && hourInTz < range.end) {
        return { matched: true };
      }
    } else {
      // Cross-midnight: e.g. { start: 22, end: 6 } means [22,24) ∪ [0,6).
      if (hourInTz >= range.start || hourInTz < range.end) {
        return { matched: true };
      }
    }
  }
  return { matched: false };
}

/* ------------------------------------------------------------------ */
/* AgentScopeRule                                                     */
/* ------------------------------------------------------------------ */

/**
 * Constrains the agent's granted scope tokens.
 *
 * Wire format: `Initiator.agent_metadata.scope` is a comma-separated
 * string of scope tokens ("refund.create,payout.read"). The Phase 4
 * IDiru integration will replace this with a structured scope claim,
 * but Phase 1 stays compatible with what the customer's onboarding
 * flow already emits.
 *
 * Semantics:
 *   `has_all`: every listed scope must be present. Empty/missing
 *              has_all is a no-op (matches by default).
 *   `has_none`: none of the listed scopes may be present. Empty/missing
 *               has_none is a no-op.
 *
 * Both lists may coexist on the same rule ("must have X, must NOT
 * have Y"). They're ANDed.
 *
 * Initiator kind handling:
 *   - kind === "agent" with no agent_metadata → fails closed (rule
 *     authors expected scope metadata; missing it is a data-quality
 *     bug at intake).
 *   - kind !== "agent" → if has_all is non-empty, the rule cannot
 *     match (human/automation initiators have no agent scopes). If
 *     only has_none is set, the rule trivially matches (you cannot
 *     have what you don't have).
 */
export function evaluateAgentScopeRule(
  rule: AgentScopeRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  const initiator = ovt.initiator;
  const hasAll = rule.has_all ?? [];
  const hasNone = rule.has_none ?? [];

  if (hasAll.length === 0 && hasNone.length === 0) {
    // No constraints — match-all consistent with other rule shapes.
    return { matched: true };
  }

  if (initiator.kind !== "agent") {
    // Non-agent initiator has no scopes. has_all with content cannot
    // match; has_none trivially matches.
    if (hasAll.length > 0) {
      return { matched: false };
    }
    return { matched: true };
  }

  if (!initiator.agent_metadata) {
    return {
      matched: false,
      error: `AgentScopeRule requires agent_metadata on the OVT, but initiator.agent_metadata is undefined for agent id=${initiator.id}`
    };
  }

  const grantedScopes = parseScopeString(initiator.agent_metadata.scope);

  for (const required of hasAll) {
    if (!grantedScopes.has(required)) {
      return { matched: false };
    }
  }
  for (const forbidden of hasNone) {
    if (grantedScopes.has(forbidden)) {
      return { matched: false };
    }
  }
  return { matched: true };
}

/**
 * Parse the comma-separated wire format into a Set for O(1) lookup.
 * Tolerates whitespace and empty entries — both are observed in the
 * existing customer data. Empty input → empty set (never throws).
 */
function parseScopeString(raw: string): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AgentBudgetRule (Track B Epic A)                                   */
/* ------------------------------------------------------------------ */

/**
 * Zero-filled sentinel check on the org-level aggregates, mirroring
 * `isZeroSentinelPolicyInputs` in decision-engine.ts (duplicated here
 * on the PolicyInputs shape to avoid an import cycle through the
 * dispatcher). The sentinel means the intake path never computed
 * aggregates, so principal-scoped budgets treat it as UNAVAILABLE.
 */
function isZeroSentinelInputs(pi: PolicyInputs): boolean {
  return pi.amount_30d === 0n && pi.amount_24h === 0n && pi.count_30d === 0 && pi.count_24h === 0;
}

/**
 * Parse a scoped-spend aggregate from the enrichment bag. The wire
 * format is a decimal bigint string (enrichment travels as JSON);
 * bigint and non-negative integer number are tolerated for in-process
 * callers. Anything else — including negatives — is treated as absent,
 * which fails closed via the inputs-unavailable guard.
 */
function parseAggregate(value: unknown): bigint | undefined {
  try {
    if (typeof value === "bigint") return value >= 0n ? value : undefined;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && value.length > 0) {
      const parsed = BigInt(value);
      return parsed >= 0n ? parsed : undefined;
    }
  } catch {
    // fall through — unparseable is indistinguishable from absent.
  }
  return undefined;
}

/**
 * Currency normalization for the per-currency enrichment key suffix.
 * MUST stay byte-for-byte identical to the reader's copy in
 * `apps/web/src/lib/axiru/agent-controls/budget-reader.ts`
 * (`normalizeCurrencyForKey`) so the key this engine reads is the exact
 * key the reader emitted. Trims, uppercases, validates a plausible
 * currency/token symbol; null for anything else. Because `Money.currency`
 * is uppercase-canonical, a well-formed `rule.currency` round-trips
 * (USDC ⇄ USDC).
 */
function normalizeCurrencyForKey(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  return /^[A-Z0-9]{2,16}$/.test(upper) ? upper : null;
}

/**
 * Team-tag normalization for the team-budget enrichment key segment
 * (budget hierarchy B-H2). MUST stay byte-for-byte identical to the
 * reader's copy in
 * `apps/web/src/lib/axiru/agent-controls/budget-reader.ts`
 * (`normalizeTeamTagForKey`) so the key this engine constructs is the
 * exact key the reader emitted. Trims, lowercases, maps "_" to "-" (so
 * the tag segment never contains the "_" separator), and validates
 * `^[a-z0-9][a-z0-9-]{0,63}$`; null for anything else. Because the tag
 * segment is lowercase-only and hyphen-safe while the per-currency
 * suffix is `^[A-Z0-9]{2,16}$`, `team_spend_{w}__{TAG}` and
 * `team_spend_{w}__{TAG}_{CCY}` decompose unambiguously.
 */
function normalizeTeamTagForKey(raw: string): string | null {
  const tag = raw.trim().toLowerCase().replace(/_/g, "-");
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(tag) ? tag : null;
}

const TEAM_TAG_LIST_RE = /^$|^[a-z0-9][a-z0-9-]{0,63}(,[a-z0-9][a-z0-9-]{0,63})*$/;

/**
 * The current agent's team membership, read off the enrichment key
 * `agent_team_tags` the budget reader emits: normalized tags joined by
 * ",", where the EMPTY string means "registration known, member of no
 * team" (a definitive fact, not an absence). Returns undefined when
 * the key is absent or malformed - membership is then UNKNOWN and
 * team-scoped budgets fail closed via the inputs-unavailable guard.
 */
function teamTagsFromEnrichment(ovt: OutboundValueTransfer): string[] | undefined {
  const raw = ovt.policy_inputs.enrichment?.["agent_team_tags"];
  if (typeof raw !== "string" || !TEAM_TAG_LIST_RE.test(raw)) return undefined;
  return raw === "" ? [] : raw.split(",");
}

/**
 * The rolling aggregate an agent_budget rule's scope needs, read purely
 * off the OVT (never I/O — same denormalization contract as
 * RollingWindowRule, spec §5.5):
 *
 *   principal → org-level `policy_inputs.amount_{24h,30d}` (Phase 1
 *               approximates principal as the org). Zero sentinel =
 *               unavailable, consistent with the P1-1 velocity guard.
 *               Currency-agnostic (the org velocity pipeline is not
 *               per-currency); a currency-scoped principal budget keeps
 *               the over-restrict-safe behavior.
 *   agent / tool / merchant → enrichment keys computed by the intake
 *               adapter (decimal bigint strings). When the rule carries a
 *               `currency`, read the PER-CURRENCY key
 *               `{scope}_spend_{24h|30d}_{CCY}` (CCY =
 *               {@link normalizeCurrencyForKey}(rule.currency)) so the
 *               budget counts only its own denomination (F2 fix); when it
 *               is currency-blind, read the agnostic
 *               `{scope}_spend_{24h|30d}` key (today's behavior). Tool
 *               scope additionally requires tool attribution
 *               (`agent_payment.tool_ref`) on the OVT.
 *
 * Returns undefined when the aggregate is unavailable (including a
 * currency-scoped budget whose per-currency key is absent — the agent has
 * no decodable prior spend in that denomination — which fails closed via
 * the inputs-unavailable guard). Only meaningful for windowed rules —
 * callers must not invoke this for `per_call`.
 */
function scopedBudgetAggregate(rule: AgentBudgetRule, ovt: OutboundValueTransfer): bigint | undefined {
  const suffix = rule.window === "24h" ? "24h" : "30d";
  if (rule.scope === "principal") {
    if (isZeroSentinelInputs(ovt.policy_inputs)) return undefined;
    return rule.window === "24h" ? ovt.policy_inputs.amount_24h : ovt.policy_inputs.amount_30d;
  }
  if (rule.scope === "project") {
    // RESERVED scope (type-only): no aggregate source exists by design.
    // The evaluator's typed-error path fails closed before this can
    // matter; returning undefined keeps this function total.
    return undefined;
  }
  if (rule.scope === "team") {
    // Budget hierarchy B-H2: per-team aggregate emitted by the reader
    // for the CURRENT agent's own teams only (bounded key space).
    const tag = rule.team_tag === undefined ? null : normalizeTeamTagForKey(rule.team_tag);
    if (tag === null) return undefined;
    let teamKey = `team_spend_${suffix}__${tag}`;
    if (rule.currency !== undefined) {
      const ccy = normalizeCurrencyForKey(rule.currency);
      if (ccy === null) return undefined;
      teamKey = `${teamKey}_${ccy}`;
    }
    return parseAggregate(ovt.policy_inputs.enrichment?.[teamKey]);
  }
  if (rule.scope === "tool" && !agentPaymentOf(ovt)?.tool_ref) {
    // Spend cannot be attributed to a tool without tool_ref — the
    // aggregate is meaningless even if an enrichment key is present.
    return undefined;
  }
  // agent / tool / merchant / org all read `{scope}_spend_{window}` (org
  // is the fleet-wide sum the reader emits for B-H1).
  const baseKey = `${rule.scope}_spend_${suffix}`;
  let key = baseKey;
  if (rule.currency !== undefined) {
    const ccy = normalizeCurrencyForKey(rule.currency);
    // A currency the reader could never key (junk / token address) has no
    // per-currency aggregate — fail closed rather than fall back to the
    // cross-currency agnostic sum.
    if (ccy === null) return undefined;
    key = `${baseKey}_${ccy}`;
  }
  return parseAggregate(ovt.policy_inputs.enrichment?.[key]);
}

/**
 * True when a selector on the rule DEFINITIVELY rules this OVT out of
 * the budget's scope (mismatched currency, agent, tool, or
 * counterparty). A missing tool attribution is NOT a definitive
 * rule-out — that is the inputs-unavailable case, handled separately so
 * it fails closed.
 *
 * Currency: when `rule.currency` is set the budget governs THAT currency
 * only, so an OVT in any other denomination is out of scope (a
 * definitive rule-out, exactly like a mismatched selector). This makes
 * the eval a non-match AND keeps {@link agentBudgetInputsUnavailable}
 * from escalating out-of-scope currency traffic. Mirrors the
 * currency-mismatch gate in {@link evaluateAgentApprovalTierRule}, but
 * as a silent non-match (a currency-scoped budget simply does not bind
 * other currencies) rather than a typed error (a tier rule that fires on
 * the wrong currency is an author mistake). When `rule.currency` is
 * absent the rule is currency-blind (back-compat single-denomination
 * assumption — see the type's JSDoc).
 */
function agentBudgetSelectorRulesOut(
  rule: AgentBudgetRule,
  ovt: OutboundValueTransfer,
  ap: AgentPaymentExtension | undefined
): boolean {
  if (rule.currency !== undefined && ovt.amount.currency !== rule.currency) {
    return true;
  }
  if (
    rule.agent_id !== undefined &&
    ovt.initiator.id !== rule.agent_id &&
    ap?.agent_identity.value !== rule.agent_id
  ) {
    return true;
  }
  if (rule.counterparty_id !== undefined && ovt.counterparty.id !== rule.counterparty_id) {
    return true;
  }
  if (rule.tool_ref !== undefined && ap?.tool_ref !== undefined && ap.tool_ref !== rule.tool_ref) {
    return true;
  }
  if (rule.scope === "team" && rule.team_tag !== undefined) {
    const tag = normalizeTeamTagForKey(rule.team_tag);
    const memberOf = teamTagsFromEnrichment(ovt);
    if (tag !== null && memberOf !== undefined && !memberOf.includes(tag)) {
      // Membership is KNOWN and this agent is not in the team: the
      // ceiling does not bind it (its own team and the org cap still
      // do). UNKNOWN membership is NOT a rule-out - that is the
      // inputs-unavailable case, which fails closed.
      return true;
    }
  }
  return false;
}

/**
 * True when this agent_budget rule WOULD bind the OVT but the inputs
 * it needs are missing at intake, so it cannot be evaluated:
 *
 *   - a `tool_ref` selector (or tool scope) with no tool attribution
 *     on the OVT, or
 *   - a windowed budget whose scoped aggregate is absent (missing /
 *     unparseable enrichment key, or the zero-sentinel org aggregates
 *     for principal scope).
 *
 * Exported for the dispatcher's fail-closed guard (the agent-budget
 * mirror of the P1-1 zero-sentinel velocity guard): sharing this
 * predicate keeps the evaluator's "cannot demonstrate over-budget →
 * non-match" behavior and the engine's "escalate a clean allow"
 * behavior in provable lockstep. Returns false for OVTs the rule
 * cannot bind anyway (non-agent initiators, definitive selector
 * mismatches) so the guard never escalates out-of-scope traffic.
 */
export function agentBudgetInputsUnavailable(
  rule: AgentBudgetRule,
  ovt: OutboundValueTransfer
): boolean {
  if (ovt.initiator.kind !== "agent") return false;
  const ap = agentPaymentOf(ovt);
  if (agentBudgetSelectorRulesOut(rule, ovt, ap)) return false;
  if (rule.scope === "project") {
    // RESERVED scope: the evaluator's typed error already fails closed
    // (rule-error demotion); double-escalating here would be noise.
    return false;
  }
  if (rule.scope === "team") {
    const tag = rule.team_tag === undefined ? null : normalizeTeamTagForKey(rule.team_tag);
    // Missing/invalid team_tag is an author error handled by the typed
    // error path, not an intake gap.
    if (tag === null) return false;
    // Membership unknown (no `agent_team_tags` at intake): the ceiling
    // cannot be evaluated for ANY window, including per_call.
    if (teamTagsFromEnrichment(ovt) === undefined) return true;
  }
  if (rule.tool_ref !== undefined && !ap?.tool_ref) return true;
  if (rule.window === "per_call") return false;
  return scopedBudgetAggregate(rule, ovt) === undefined;
}

/**
 * Budget cap on agent spend. See the AgentBudgetRule JSDoc in
 * `@axiru/agent-spend-guardrails (vendored types)` for the full semantics; in short:
 *
 *   - Binds `initiator.kind === "agent"` traffic only; anything else
 *     never matches (the rule family governs agent spend).
 *   - Selectors (currency / agent_id / tool_ref / counterparty_id)
 *     narrow scope; a definitive mismatch is a non-match. A set
 *     `currency` binds that denomination ONLY (other-currency OVTs are
 *     out of scope and never match — no false deny); an absent
 *     `currency` is currency-blind (single-denomination assumption).
 *   - `per_call`: matches when the OVT amount alone exceeds the cap.
 *   - `24h` / `30d`: PROSPECTIVE check — matches when
 *     `aggregate + amount > max` ("this transfer would take the scope
 *     over budget").
 *   - Missing aggregates: non-match WITHOUT an error. This mirrors the
 *     rolling-window zero-sentinel behavior — the rule cannot
 *     demonstrate an over-budget condition, and the DISPATCHER (not
 *     this function) escalates a clean allow to require_approval via
 *     {@link agentBudgetInputsUnavailable}, with shadow-mode policies
 *     exempt and denies never weakened.
 *   - Unparseable `max_amount_minor_units` is an author error → typed
 *     error, which the dispatcher demotes fail-closed.
 */
export function evaluateAgentBudgetRule(
  rule: AgentBudgetRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  let max: bigint;
  try {
    max = BigInt(rule.max_amount_minor_units);
  } catch (err) {
    return {
      matched: false,
      error: `AgentBudgetRule.max_amount_minor_units="${rule.max_amount_minor_units}" is not a valid bigint literal: ${(err as Error).message}`
    };
  }
  if (max < 0n) {
    return {
      matched: false,
      error: `AgentBudgetRule.max_amount_minor_units="${rule.max_amount_minor_units}" must be non-negative`
    };
  }
  if (rule.scope === "project") {
    // RESERVED (roadmap v2 Phase 2 block): project budgets need
    // per-intent project attribution that has not shipped. Typed error
    // so the engine demotes a clean allow to require_approval - a
    // reserved ceiling is never a silent pass.
    return {
      matched: false,
      error:
        'AgentBudgetRule scope "project" is reserved (type-only in this build; per-intent project attribution has not shipped). Use agent, team, or org scope.'
    };
  }
  if (rule.scope === "team") {
    const tag = rule.team_tag === undefined ? null : normalizeTeamTagForKey(rule.team_tag);
    if (tag === null) {
      return {
        matched: false,
        error: `AgentBudgetRule scope "team" requires a team_tag that normalizes to ^[a-z0-9][a-z0-9-]{0,63}$ (got ${JSON.stringify(rule.team_tag)})`
      };
    }
  }

  if (ovt.initiator.kind !== "agent") {
    return { matched: false };
  }
  const ap = agentPaymentOf(ovt);
  if (agentBudgetSelectorRulesOut(rule, ovt, ap)) {
    return { matched: false };
  }
  if (agentBudgetInputsUnavailable(rule, ovt)) {
    // No error on purpose — see JSDoc; the engine-level guard escalates.
    return { matched: false };
  }

  if (rule.window === "per_call") {
    return { matched: ovt.amount.minor_units > max };
  }
  const aggregate = scopedBudgetAggregate(rule, ovt);
  if (aggregate === undefined) {
    // Unreachable given the guard above; defensive fail-safe.
    return { matched: false };
  }
  return { matched: aggregate + ovt.amount.minor_units > max };
}

/* ------------------------------------------------------------------ */
/* AgentApprovalTierRule (Track B Epic A)                             */
/* ------------------------------------------------------------------ */

/**
 * Amount-tiered approval routing for agent spend. Rules in this DSL
 * are boolean matchers, so the rule matches the band named by the
 * OWNING POLICY'S effect kind (see the type's JSDoc in
 * `@axiru/agent-spend-guardrails (vendored types)` for the author-facing contract):
 *
 *   effect "allow"            → matches amount <  auto_allow_below
 *   effect "require_approval" → matches auto_allow_below <= amount < require_approval_below
 *   effect "deny"             → matches amount >= require_approval_below
 *
 * Precedence between overlapping tier policies is the standard ladder
 * (deny > require_approval > allow), which is exactly the "deny wins,
 * then require_approval" band semantics.
 *
 * Fail-closed errors (dispatcher demotes to require_approval):
 *   - thresholds that are not bigint literals or are inverted
 *     (auto_allow_below > require_approval_below)
 *   - currency mismatch with the OVT (no FX for tiers in Phase 1)
 *   - missing `effectKind` (a caller bypassed the policy matcher; the
 *     band cannot be chosen without it)
 *
 * Binds agent-initiated traffic only (initiator.kind === "agent").
 */
export function evaluateAgentApprovalTierRule(
  rule: AgentApprovalTierRule,
  ovt: OutboundValueTransfer,
  effectKind?: PolicyEffectV2["kind"]
): RuleEvaluation {
  let autoAllowBelow: bigint;
  let requireApprovalBelow: bigint;
  try {
    autoAllowBelow = BigInt(rule.auto_allow_below);
    requireApprovalBelow = BigInt(rule.require_approval_below);
  } catch (err) {
    return {
      matched: false,
      error: `AgentApprovalTierRule thresholds must be bigint literals (auto_allow_below="${rule.auto_allow_below}", require_approval_below="${rule.require_approval_below}"): ${(err as Error).message}`
    };
  }
  if (autoAllowBelow > requireApprovalBelow) {
    return {
      matched: false,
      error: `AgentApprovalTierRule bands are inverted: auto_allow_below=${autoAllowBelow} > require_approval_below=${requireApprovalBelow}`
    };
  }
  if (effectKind === undefined) {
    return {
      matched: false,
      error:
        "AgentApprovalTierRule requires the owning policy's effect kind to select the band; evaluate it via the policy matcher (or pass effectKind explicitly)"
    };
  }

  if (ovt.initiator.kind !== "agent") {
    return { matched: false };
  }
  if (rule.currency !== ovt.amount.currency) {
    return {
      matched: false,
      error: `AgentApprovalTierRule currency ${rule.currency} does not match OVT amount currency ${ovt.amount.currency}; cross-currency tiers are not supported in Phase 1`
    };
  }

  const amount = ovt.amount.minor_units;
  switch (effectKind) {
    case "allow":
      return { matched: amount < autoAllowBelow };
    case "require_approval":
      return { matched: amount >= autoAllowBelow && amount < requireApprovalBelow };
    case "deny":
      return { matched: amount >= requireApprovalBelow };
    default:
      // Exhaustiveness; the literal union is closed.
      return { matched: false, error: `AgentApprovalTierRule got unknown effect kind ${String(effectKind)}` };
  }
}

/* ------------------------------------------------------------------ */
/* MandateScopeRule (Track B Epic A)                                  */
/* ------------------------------------------------------------------ */

/**
 * Mandate-scope enforcement. Matches the VIOLATION: `require_mandate`
 * is true, the OVT is agent-initiated (initiator.kind === "agent"),
 * and no `agent_payment.mandate_ref` is present (an agent OVT with no
 * agent_payment block at all is by definition missing its mandate —
 * intake gaps must not create a governance bypass). Non-agent OVTs
 * never match: the rule does not bind them, so human/automation
 * traffic is unaffected by mandate policies.
 *
 * Pair with a `deny` effect; the dispatcher stamps the canonical
 * `axiru.deny.mandate_missing` code onto the resulting decision.
 *
 * `max_amount_within_mandate` is recorded, not enforced, in Phase 1 —
 * checking the amount against the mandate's cap requires parsing the
 * mandate itself (AP2 verification, Phase 2/3). See the type's JSDoc.
 */
export function evaluateMandateScopeRule(
  rule: MandateScopeRule,
  ovt: OutboundValueTransfer
): RuleEvaluation {
  if (!rule.require_mandate) {
    // No constraint configured — a violation-matching rule with no
    // requirement can never observe a violation.
    return { matched: false };
  }
  if (ovt.initiator.kind !== "agent") {
    return { matched: false };
  }
  const mandateRef = agentPaymentOf(ovt)?.mandate_ref;
  return { matched: mandateRef === undefined || mandateRef.length === 0 };
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                         */
/* ------------------------------------------------------------------ */

/**
 * Top-level rule dispatch. Exhaustive switch over the discriminator —
 * adding a new PolicyRuleV2 variant produces a compile error here
 * until the case is handled, which is exactly what we want.
 *
 * `effectKind` (additive, optional — existing callers unaffected) is
 * the owning policy's effect kind; the policy matcher always supplies
 * it. Only AgentApprovalTierRule consumes it (band selection), and it
 * fails closed with a typed error when the kind is absent.
 */
export function evaluateRule(
  rule: PolicyRuleV2,
  ovt: OutboundValueTransfer,
  context: EvalContext,
  effectKind?: PolicyEffectV2["kind"]
): RuleEvaluation {
  switch (rule.kind) {
    case "rail":
      return evaluateRailRule(rule, ovt);
    case "rail_action":
      return evaluateRailActionRule(rule, ovt);
    case "amount":
      return evaluateAmountRule(rule, ovt, context);
    case "initiator_kind":
      return evaluateInitiatorKindRule(rule, ovt);
    case "initiator_id":
      return evaluateInitiatorIdRule(rule, ovt);
    case "counterparty":
      return evaluateCounterpartyRule(rule, ovt);
    case "rolling_window":
      return evaluateRollingWindowRule(rule, ovt);
    case "time_of_day":
      return evaluateTimeOfDayRule(rule, ovt);
    case "agent_scope":
      return evaluateAgentScopeRule(rule, ovt);
    case "agent_budget":
      return evaluateAgentBudgetRule(rule, ovt);
    case "agent_approval_tier":
      return evaluateAgentApprovalTierRule(rule, ovt, effectKind);
    case "mandate_scope":
      return evaluateMandateScopeRule(rule, ovt);
    case "custom_expression":
      return evaluateCustomExpressionRule(rule, ovt, context);
    default:
      return assertUnreachableRule(rule);
  }
}

function assertUnreachableRule(rule: never): RuleEvaluation {
  // Defensive: should be unreachable due to exhaustive switch.
  return {
    matched: false,
    error: `Unknown PolicyRuleV2 variant: ${JSON.stringify(rule)}`
  };
}
