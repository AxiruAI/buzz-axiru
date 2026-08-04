/**
 * LegacyV1Adapter (T-018) — translate a v1 `Policy` from
 * `the hosted platform domain package` into one or more `PolicyV2` records.
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §4.3.
 *
 * Why a separate adapter (rather than running v1 and v2 side-by-side
 * with no translation): the Decision Engine v2 path replaces the six
 * `evaluateXEvent` functions behind a flag in T-019. To meet the
 * Decision Replay golden-test requirement (T-020) — that the same
 * OVT + same policy version produce byte-identical decisions on both
 * paths — we MUST evaluate v1 policies through the same v2 evaluator
 * code. The adapter is what makes that possible without forcing every
 * customer to rewrite their existing policies before Phase 1 closes.
 *
 * Structural typing (no the hosted platform domain package dep):
 *
 *   The v1 Policy shape is small and stable. Rather than introducing
 *   a cross-package dependency (decision-engine → domain) just for
 *   this one translation, we declare the v1 wire shape inline and
 *   accept any input matching it. Call sites already have a
 *   `Policy` from `the hosted platform domain package` — TypeScript structurally
 *   widens it to `LegacyV1Policy` without a cast, so this stays
 *   ergonomic at the call site.
 *
 * Translation strategy — three-band amount semantics:
 *
 *   v1 has per-category threshold sub-rules (refund / goodwillCredit /
 *   payout / transfer / dispute / applicationFeeRefund) with three
 *   knobs each:
 *     - autoAllowUpToCents
 *     - requireApprovalAboveCents
 *     - hardBlockAboveCents
 *
 *   v1 evaluator semantics (`packages/domain/src/policy.ts`):
 *     - amount > hardBlockAboveCents       → BLOCK
 *     - amount > requireApprovalAboveCents → REQUIRE_APPROVAL
 *     - amount <= autoAllowUpToCents       → ALLOW
 *     - between auto & approval thresholds → REQUIRE_APPROVAL ("manual review band")
 *
 *   v2 default action is `allow`. So per category we emit:
 *     - one `require_approval` policy with amount in
 *       (autoAllowUpToCents, hardBlockAboveCents]
 *     - one `deny` policy with amount > hardBlockAboveCents
 *
 *   Bands collapse cleanly when thresholds are equal (e.g.
 *   `auto = requireApproval` — common in "binary" policies that allow
 *   below X and deny above) so we omit empty bands.
 *
 *   `blockedReasons` is NOT translated — it depends on Stripe-specific
 *   reason strings on the FinancialEvent, which the v2 OVT does not
 *   carry. Customers using `blockedReasons` will need to manually
 *   port to a v2 `CustomExpressionRule` once they migrate. We surface
 *   this in `LegacyV1AdapterResult.warnings` so the operator can see
 *   that a policy did not fully translate.
 *
 * Mode mapping (semantics-preserving; see P1-3 in the 2026-07-02
 * review for why this is deliberately NOT label-preserving):
 *
 *     v1 mode "enforce"  →  v2 mode "enforcing"
 *     v1 mode "simulate" →  v2 mode "enforcing" with every `deny`
 *                            effect demoted to `require_approval`.
 *                            v1 simulate SEMANTICS still gate: BLOCK
 *                            is demoted to REQUIRE_APPROVAL but the
 *                            transfer does not proceed unreviewed.
 *                            v2 "shadow" has NO enforcement effect,
 *                            so the old simulate→shadow mapping made
 *                            every simulate-mode customer policy
 *                            silently fail open at cutover. Customers
 *                            who want observe-only must OPT IN by
 *                            setting v2 mode "shadow" explicitly.
 *     v1 active=false    →  v2 mode "disabled"  (one-way; "disabled"
 *                            has no clean v1 reverse since v1
 *                            represents "off" as a separate boolean).
 *
 * The reverse map (`mapV2ModeToV1`) is best-effort for dashboard
 * display only and is documented as asymmetric.
 *
 * Stable ids for golden tests: derived policies use deterministic ids
 * `${v1.id}__v2_<category>_<band>` so a Decision Replay can find
 * exactly the same v2 policy on every run.
 */

import type {
  AmountRule,
  PolicyEffectV2,
  PolicyRuleV2,
  PolicyV2,
  PolicyV2Mode,
  RailActionRule,
  RailRule
} from "../../types/index.js";

/* ------------------------------------------------------------------ */
/* Structural v1 types                                                */
/* ------------------------------------------------------------------ */

/** Subset of v1's PolicyMode we recognize. */
export type LegacyV1PolicyMode = "simulate" | "enforce";

/** Subset of v1's PolicyThresholdRule we consume. */
export interface LegacyV1ThresholdRule {
  autoAllowUpToCents: number;
  requireApprovalAboveCents: number;
  hardBlockAboveCents: number;
  blockedReasons?: string[];
}

/** Subset of v1's PolicyRule. Mirrors `the hosted platform domain package` PolicyRule. */
export interface LegacyV1PolicyRule extends LegacyV1ThresholdRule {
  id?: string;
  description?: string;
  blockedReasons: string[];
  goodwillCredit?: LegacyV1ThresholdRule;
  payout?: LegacyV1ThresholdRule;
  transfer?: LegacyV1ThresholdRule;
  dispute?: LegacyV1ThresholdRule;
  applicationFeeRefund?: LegacyV1ThresholdRule;
  disputeEvidenceDueWithinHours?: number;
}

export interface LegacyV1Policy {
  id: string;
  organizationId: string;
  name: string;
  mode: LegacyV1PolicyMode;
  active: boolean;
  rule: LegacyV1PolicyRule;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ */
/* Result                                                             */
/* ------------------------------------------------------------------ */

export interface LegacyV1AdapterResult {
  policies: PolicyV2[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Category → (rail, rail_action) mapping                             */
/* ------------------------------------------------------------------ */

/**
 * Every v1 outflow category maps to exactly one (rail, rail_action)
 * tuple. Phase 1 stays Stripe-only — Phase 2 will add (stripe_daa,
 * transfer) and (x402, pay) categories, at which point this table
 * grows but the adapter logic stays the same.
 */
interface CategoryMapping {
  v1Field: "default" | "goodwillCredit" | "payout" | "transfer" | "dispute" | "applicationFeeRefund";
  /** Slug used in derived policy ids and policy names. */
  v2Slug: string;
  rail: "stripe";
  /**
   * Allowed rail_action values for this category. A single Stripe v1
   * category sometimes corresponds to multiple v2 rail_actions
   * (e.g. v1 "refund" subsumes both the basic refund and the
   * goodwill_credit overlap). We list them here and emit one
   * RailActionRule with all of them on the `in` array so a single
   * v2 policy covers the entire surface.
   */
  railActions: string[];
}

const CATEGORY_MAPPINGS: CategoryMapping[] = [
  // The "refund" category is the v1 default threshold (policy.rule itself);
  // it covers basic Stripe refunds + the credit-note variant.
  { v1Field: "default", v2Slug: "refund", rail: "stripe", railActions: ["refund", "credit_note"] },
  { v1Field: "goodwillCredit", v2Slug: "goodwill_credit", rail: "stripe", railActions: ["goodwill_credit"] },
  { v1Field: "payout", v2Slug: "payout", rail: "stripe", railActions: ["payout"] },
  { v1Field: "transfer", v2Slug: "transfer", rail: "stripe", railActions: ["transfer"] },
  { v1Field: "dispute", v2Slug: "dispute", rail: "stripe", railActions: ["dispute_decision"] },
  {
    v1Field: "applicationFeeRefund",
    v2Slug: "application_fee_refund",
    rail: "stripe",
    railActions: ["application_fee_refund"]
  }
];

/* ------------------------------------------------------------------ */
/* Public translator                                                  */
/* ------------------------------------------------------------------ */

/**
 * Translate a v1 Policy to a list of v2 PolicyV2 records.
 *
 * Pure function — no I/O. Multiple v2 policies may share the same
 * `version` (= v1.updatedAt timestamp expressed as a small integer);
 * the precedence ladder in policy-matcher.ts handles ties by id.
 */
export function translateV1Policy(policy: LegacyV1Policy): LegacyV1AdapterResult {
  const warnings: string[] = [];
  const v2Policies: PolicyV2[] = [];

  const mode = mapV1Mode(policy);
  const version = computeV2Version(policy);

  // P1-3: surface the simulate translation so operators reviewing a
  // cutover see exactly what changed and how to opt into observe-only.
  if (policy.mode === "simulate" && policy.active) {
    warnings.push(
      `v1 policy "${policy.id}" is in simulate mode: translated to v2 ENFORCING with deny demoted to require_approval (v1 simulate still gates). ` +
        `If observe-only was intended, explicitly set the v2 policy mode to "shadow".`
    );
  }

  for (const mapping of CATEGORY_MAPPINGS) {
    const threshold = readThreshold(policy.rule, mapping.v1Field);

    // Surface a warning if blockedReasons is non-empty — we don't
    // translate it (see file header).
    if (threshold.blockedReasons && threshold.blockedReasons.length > 0) {
      warnings.push(
        `v1 policy "${policy.id}" category "${mapping.v2Slug}" has blockedReasons that did not translate to v2; manual port to CustomExpressionRule required.`
      );
    }

    const requireApprovalPolicy = buildRequireApprovalBand(policy, mapping, threshold, mode, version);
    if (requireApprovalPolicy) v2Policies.push(requireApprovalPolicy);

    const denyPolicy = buildDenyBand(policy, mapping, threshold, mode, version);
    if (denyPolicy) v2Policies.push(denyPolicy);
  }

  return { policies: v2Policies, warnings };
}

/**
 * Batch helper. Concatenates results across many v1 policies, useful
 * when the caller loads `policies = await prisma.policy.findMany(...)`
 * and wants the full v2 set in one go. Warnings are aggregated.
 */
export function translateV1Policies(policies: LegacyV1Policy[]): LegacyV1AdapterResult {
  const all: PolicyV2[] = [];
  const warnings: string[] = [];
  for (const p of policies) {
    const r = translateV1Policy(p);
    all.push(...r.policies);
    warnings.push(...r.warnings);
  }
  return { policies: all, warnings };
}

/* ------------------------------------------------------------------ */
/* Reverse mapping: v1 mode → v2 mode                                 */
/* ------------------------------------------------------------------ */

/**
 * Public mode mapper. Used by tests and by the dashboard when showing
 * customers how their v1 policy behaves under v2 semantics.
 *
 * P1-3 (2026-07-02 review): v1 "simulate" maps to v2 "enforcing", NOT
 * "shadow". v1 simulate still gates (BLOCK demoted to
 * REQUIRE_APPROVAL); v2 shadow does not gate at all. Mapping to
 * shadow silently dropped enforcement for every simulate-mode
 * customer at cutover. The accompanying effect demotion
 * (deny → require_approval) happens in the band builders, keyed off
 * the original v1 mode.
 */
export function mapV1ModeToV2(v1Mode: LegacyV1PolicyMode, active: boolean): PolicyV2Mode {
  if (!active) return "disabled";
  // Both v1 modes gate; both map to enforcing. The simulate/enforce
  // difference is expressed via effect demotion, not mode.
  void v1Mode;
  return "enforcing";
}

/**
 * Best-effort reverse map for DISPLAY ONLY — asymmetric by design.
 * A v2 "shadow" policy has no v1 equivalent (v1 simulate gates,
 * shadow does not); we render it as simulate because that is the
 * closest v1 vocabulary, but round-tripping mode labels through this
 * pair is not supported.
 */
export function mapV2ModeToV1(mode: PolicyV2Mode): { mode: LegacyV1PolicyMode; active: boolean } {
  if (mode === "disabled") return { mode: "enforce", active: false };
  if (mode === "shadow") return { mode: "simulate", active: true };
  return { mode: "enforce", active: true };
}

/* ------------------------------------------------------------------ */
/* Internals                                                          */
/* ------------------------------------------------------------------ */

function mapV1Mode(policy: LegacyV1Policy): PolicyV2Mode {
  return mapV1ModeToV2(policy.mode, policy.active);
}

/**
 * Map v1 Policy.updatedAt to a monotonic v2 version integer. We use
 * epoch milliseconds (rather than a UUID or random number) so that
 * a v1 policy updated later in time always sorts above its earlier
 * self under v2's precedence ladder.
 *
 * BigInt → number narrowing: the JS-safe range easily fits a Date
 * epoch through year 2255, so an unchecked Number(...) is fine.
 */
function computeV2Version(policy: LegacyV1Policy): number {
  return policy.updatedAt.getTime();
}

function readThreshold(
  rule: LegacyV1PolicyRule,
  field: CategoryMapping["v1Field"]
): LegacyV1ThresholdRule {
  if (field === "default") {
    return {
      autoAllowUpToCents: rule.autoAllowUpToCents,
      requireApprovalAboveCents: rule.requireApprovalAboveCents,
      hardBlockAboveCents: rule.hardBlockAboveCents,
      blockedReasons: rule.blockedReasons
    };
  }
  const override = rule[field];
  if (override) {
    return override;
  }
  // No override → fall back to the policy default thresholds. This
  // matches v1 semantics: when `goodwillCredit` etc. is absent on
  // policy.rule, the top-level thresholds apply to that category.
  return {
    autoAllowUpToCents: rule.autoAllowUpToCents,
    requireApprovalAboveCents: rule.requireApprovalAboveCents,
    hardBlockAboveCents: rule.hardBlockAboveCents,
    blockedReasons: rule.blockedReasons
  };
}

function buildRequireApprovalBand(
  policy: LegacyV1Policy,
  mapping: CategoryMapping,
  threshold: LegacyV1ThresholdRule,
  mode: PolicyV2Mode,
  version: number
): PolicyV2 | null {
  // Band: (autoAllowUpToCents, hardBlockAboveCents]
  // If auto >= hardBlock the band is empty and nothing to emit.
  if (threshold.autoAllowUpToCents >= threshold.hardBlockAboveCents) return null;

  const gte = (threshold.autoAllowUpToCents + 1).toString();
  const lte = threshold.hardBlockAboveCents.toString();

  const rules: PolicyRuleV2[] = [
    railRule(mapping.rail),
    railActionRule(mapping.railActions),
    amountRule({ gte, lte })
  ];

  const effect: PolicyEffectV2 = {
    kind: "require_approval",
    reason_code: `customer.legacy_v1.${mapping.v2Slug}.require_approval`,
    reason_text: `Migrated from v1 policy "${policy.name}" — ${mapping.v2Slug} above auto-allow threshold requires approval`
  };

  return assemblePolicy(policy, mapping, "require_approval", rules, effect, mode, version);
}

function buildDenyBand(
  policy: LegacyV1Policy,
  mapping: CategoryMapping,
  threshold: LegacyV1ThresholdRule,
  mode: PolicyV2Mode,
  version: number
): PolicyV2 | null {
  // Band: amount > hardBlockAboveCents, modeled as gte = hardBlockAboveCents + 1.
  // P1-3: v1 semantics are `amount > hardBlockAboveCents → BLOCK`, so
  // hardBlockAboveCents === 0 means "block every positive amount" — NOT "no
  // deny". Previously this returned null for `<= 0`, translating a block-all
  // v1 policy into zero v2 policies (fail-open default allow). We now emit the
  // deny band for any non-negative threshold (gte >= 1 when hardBlock === 0).
  // Only a negative (invalid) threshold is skipped.
  // See docs/reviews/2026-07-02-codebase-review.md P1-3.
  if (threshold.hardBlockAboveCents < 0) return null;

  const gte = (threshold.hardBlockAboveCents + 1).toString();

  const rules: PolicyRuleV2[] = [
    railRule(mapping.rail),
    railActionRule(mapping.railActions),
    amountRule({ gte })
  ];

  // P1-3: under v1 "simulate", a BLOCK verdict is demoted to
  // REQUIRE_APPROVAL — but it still gates. Preserve exactly that:
  // the v2 policy is enforcing with a require_approval effect. The
  // reason_code keeps the `.hard_block` suffix so audit trails and
  // dashboards can still see which band fired.
  const simulateDemoted = policy.mode === "simulate" && policy.active;

  const effect: PolicyEffectV2 = simulateDemoted
    ? {
        kind: "require_approval",
        reason_code: `customer.legacy_v1.${mapping.v2Slug}.hard_block`,
        reason_text: `Migrated from v1 policy "${policy.name}" (simulate mode) — ${mapping.v2Slug} exceeded hard-block threshold; v1 simulate demotes BLOCK to REQUIRE_APPROVAL`
      }
    : {
        kind: "deny",
        reason_code: `customer.legacy_v1.${mapping.v2Slug}.hard_block`,
        reason_text: `Migrated from v1 policy "${policy.name}" — ${mapping.v2Slug} exceeded hard-block threshold`
      };

  return assemblePolicy(policy, mapping, "deny", rules, effect, mode, version);
}

function railRule(rail: "stripe"): RailRule {
  return { kind: "rail", in: [rail] };
}

function railActionRule(actions: string[]): RailActionRule {
  return { kind: "rail_action", in: actions };
}

/**
 * Cents are USD-denominated in v1 (the column is literally named
 * `*_cents`). v2 amount rules require an explicit `currency`; we
 * stamp USD. If a customer ever operated with a non-USD Stripe
 * account, the v1 path was equally broken — the v1 evaluator
 * does not handle multi-currency either. See spec §4.3 note.
 */
function amountRule({ gte, lte }: { gte: string; lte?: string }): AmountRule {
  const rule: AmountRule = { kind: "amount", currency: "USD", gte };
  if (lte !== undefined) rule.lte = lte;
  return rule;
}

function assemblePolicy(
  v1: LegacyV1Policy,
  mapping: CategoryMapping,
  band: "require_approval" | "deny",
  rules: PolicyRuleV2[],
  effect: PolicyEffectV2,
  mode: PolicyV2Mode,
  version: number
): PolicyV2 {
  return {
    id: `${v1.id}__v2_${mapping.v2Slug}_${band}`,
    org_id: v1.organizationId,
    schema_version: 2,
    name: `${v1.name} — ${mapping.v2Slug} (${band})`,
    description: `Auto-translated from v1 policy ${v1.id}.`,
    version,
    author_id: "system.legacy_v1_adapter",
    mode,
    rules,
    effect,
    created_at: v1.createdAt,
    updated_at: v1.updatedAt
  };
}
