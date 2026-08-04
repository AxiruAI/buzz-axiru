/**
 * Per-rail evaluators (T-014).
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §5.5, §7.1.
 *
 * One evaluator per Phase-1-active rail. Each implements `RailEvaluator`
 * and is selected by `evaluate()` based on `ovt.rail`.
 *
 * The evaluators share most of their logic — collapse precedence,
 * apply mode-resolution, build the Decision — through the
 * `buildSharedDecision` helper. The only per-rail customization today
 * is the reason-code namespace prefix used when a matched policy
 * carries a generic effect (we annotate it with the rail family so
 * the audit ledger can be filtered by rail without a join).
 *
 * Phase 2 rails (ucp, tempo, …) intentionally have NO evaluator here.
 * `evaluate()` short-circuits to a `axiru.deny.unknown_rail` synthetic
 * decision for those rails.
 *
 * Purity invariant: same as the rest of the package. The single
 * impure dependency, `EvalContext.now`, flows through unchanged.
 */

import {
  AXIRU_REASON_CODES,
  type AxiruReasonCode,
  type OutboundValueTransfer,
  type PolicyEffectV2,
  type PolicyV2,
  type Rail,
  type AdPlatformOVT,
  type StripeOVT,
  type StripeDAAOVT,
  type USDCSolanaOVT,
  type X402OVT
} from "../types/index.js";

import type {
  DecisionActionV2,
  DecisionReason,
  DecisionV2,
  EvalContext,
  MatchedPolicy,
  RailEvaluator
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Authorization-token TTL clamp (spec §6.2)                          */
/* ------------------------------------------------------------------ */

/**
 * Maximum TTL the engine will surface to the downstream token issuer.
 * A matched policy effect can request a longer TTL but the engine
 * silently clamps it. Per spec §6.2, anything above 300s violates
 * the "short-lived capability" property of the JWS.
 */
const MAX_AUTHORIZATION_TTL_SECONDS = 300;

function clampTtl(ttl: number | undefined): number | undefined {
  if (ttl === undefined) return undefined;
  if (!Number.isFinite(ttl) || ttl <= 0) return undefined;
  return Math.min(Math.floor(ttl), MAX_AUTHORIZATION_TTL_SECONDS);
}

/* ------------------------------------------------------------------ */
/* Effect → action mapping                                            */
/* ------------------------------------------------------------------ */

function effectToAction(effect: PolicyEffectV2): DecisionActionV2 {
  switch (effect.kind) {
    case "allow":
      return "allow";
    case "deny":
      return "deny";
    case "require_approval":
      return "require_approval";
    default:
      // Exhaustiveness; the literal union is closed.
      return "require_approval";
  }
}

/**
 * Map the proximate effect.kind to the canonical `axiru.*` reason
 * code. Used as the engine-level summary on the Decision, distinct
 * from the matched policy's customer-defined `reason_code`.
 */
function effectToAxiruReasonCode(effect: PolicyEffectV2): AxiruReasonCode {
  switch (effect.kind) {
    case "deny":
      return AXIRU_REASON_CODES.DENY_AMOUNT_EXCEEDED;
    case "require_approval":
      return AXIRU_REASON_CODES.PENDING_APPROVAL_REQUIRED;
    case "allow":
      return AXIRU_REASON_CODES.ALLOW_DEFAULT;
    default:
      return AXIRU_REASON_CODES.PENDING_APPROVAL_REQUIRED;
  }
}

/* ------------------------------------------------------------------ */
/* Decision id derivation                                             */
/* ------------------------------------------------------------------ */

/**
 * Derive a stable, deterministic Decision id from the OVT fingerprint.
 * Pure function (no random, no clock). Decision Replay re-runs the
 * engine and asserts the resulting id matches the original — that
 * is only possible because of this derivation.
 *
 * Format chosen: `dec_v2_` followed by the first 12 hex chars of the
 * fingerprint (which itself is `sha256:<hex>` per
 * `@axiru/shared/canonical-fingerprint`). 48 bits of entropy is
 * sufficient for a tenant's lifetime decision volume — at 1B decisions
 * per org, P(collision) is still < 2^-12.
 */
function buildDecisionId(fingerprint: string): string {
  const hex = fingerprint.startsWith("sha256:") ? fingerprint.slice("sha256:".length) : fingerprint;
  return `dec_v2_${hex.slice(0, 12)}`;
}

/* ------------------------------------------------------------------ */
/* Shared collapse → Decision                                         */
/* ------------------------------------------------------------------ */

/**
 * Common logic across every rail. The per-rail evaluators wrap this
 * with rail-specific behaviour (currently just the rail typing).
 *
 * Mode-resolution rule (spec §5.4 — encoded here, not in the matcher):
 *
 *   A matched policy in shadow mode contributes its reason to the
 *   audit trail but DOES NOT change the final action. In practice we
 *   walk the precedence-sorted list and pick the first ENFORCING
 *   policy as the winner; shadow-mode matches above it are recorded
 *   into `reasons` for transparency but their effect is not applied.
 *
 *   If only shadow policies matched, the action is `allow` (default)
 *   and a `axiru.deny.shadow_mode_forced` reason is appended for the
 *   highest-precedence shadow match. This is the canonical signal a
 *   customer is looking for in the dashboard ("this would have been
 *   blocked if I had moved the policy to enforcing").
 *
 *   Zero matches → action `allow`, reason `axiru.allow.default`.
 */
function buildSharedDecision(input: {
  ovt: OutboundValueTransfer;
  matched: MatchedPolicy[];
  considered: PolicyV2[];
  context: EvalContext;
}): DecisionV2 {
  const { ovt, matched, considered, context } = input;

  // Split matched into enforcing vs shadow.
  const enforcingMatches = matched.filter((m) => m.policy.mode === "enforcing");
  const shadowMatches = matched.filter((m) => m.policy.mode === "shadow");

  let action: DecisionActionV2;
  let axiruReasonCode: AxiruReasonCode | string;
  const reasons: DecisionReason[] = [];
  let winning: MatchedPolicy | undefined;
  let maxAuthorizedAmount: { currency: string; minor_units: string } | undefined;
  let authorizationTtl: number | undefined;

  if (enforcingMatches.length > 0) {
    winning = enforcingMatches[0]!;
    action = effectToAction(winning.effect);
    axiruReasonCode = effectToAxiruReasonCode(winning.effect);
    reasons.push({
      reason_code: winning.effect.reason_code,
      reason_text: winning.effect.reason_text,
      policy_id: winning.policy.id,
      policy_version: winning.policy.version,
      policy_mode: winning.policy.mode
    });
    maxAuthorizedAmount = winning.effect.max_authorized_amount;
    authorizationTtl = clampTtl(winning.effect.authorization_ttl_seconds);
  } else if (shadowMatches.length > 0) {
    // Shadow-only: action defaults to allow, but we annotate.
    action = "allow";
    axiruReasonCode = AXIRU_REASON_CODES.DENY_SHADOW_MODE_FORCED;
    reasons.push({
      reason_code: AXIRU_REASON_CODES.DENY_SHADOW_MODE_FORCED,
      reason_text: `Highest-precedence matched policy ${shadowMatches[0]!.policy.id} is in shadow mode; action allowed without enforcement`,
      policy_id: shadowMatches[0]!.policy.id,
      policy_version: shadowMatches[0]!.policy.version,
      policy_mode: shadowMatches[0]!.policy.mode
    });
  } else {
    action = "allow";
    axiruReasonCode = AXIRU_REASON_CODES.ALLOW_DEFAULT;
    reasons.push({
      reason_code: AXIRU_REASON_CODES.ALLOW_DEFAULT,
      reason_text:
        considered.length === 0
          ? "No policies in scope; default allow"
          : `No policy matched (${considered.length} considered); default allow`
    });
  }

  // Append remaining matched policies to the reason trail in
  // precedence order. Skip the winner, which is already at index 0.
  for (const m of matched) {
    if (winning && m === winning) continue;
    reasons.push({
      reason_code: m.effect.reason_code,
      reason_text: m.effect.reason_text,
      policy_id: m.policy.id,
      policy_version: m.policy.version,
      policy_mode: m.policy.mode
    });
  }

  return {
    id: buildDecisionId(ovt.fingerprint),
    org_id: ovt.org_id,
    rail: ovt.rail,
    rail_action: ovt.rail_action,
    ovt_fingerprint: ovt.fingerprint,
    action,
    reasons,
    matched_policy_ids: matched.map((m) => m.policy.id),
    axiru_reason_code: axiruReasonCode,
    evaluated_at: context.now,
    max_authorized_amount: maxAuthorizedAmount,
    authorization_ttl_seconds: authorizationTtl
  };
}

/* ------------------------------------------------------------------ */
/* Stripe evaluator                                                   */
/* ------------------------------------------------------------------ */

export const stripeEvaluator: RailEvaluator<"stripe"> = {
  rail: "stripe",
  buildDecision: (input: {
    ovt: StripeOVT;
    matched: MatchedPolicy[];
    considered: PolicyV2[];
    context: EvalContext;
  }) => buildSharedDecision(input)
};

/* ------------------------------------------------------------------ */
/* StripeDAA evaluator                                                */
/* ------------------------------------------------------------------ */

export const stripeDaaEvaluator: RailEvaluator<"stripe_daa"> = {
  rail: "stripe_daa",
  buildDecision: (input: {
    ovt: StripeDAAOVT;
    matched: MatchedPolicy[];
    considered: PolicyV2[];
    context: EvalContext;
  }) => buildSharedDecision(input)
};

/* ------------------------------------------------------------------ */
/* x402 evaluator                                                     */
/* ------------------------------------------------------------------ */

export const x402Evaluator: RailEvaluator<"x402"> = {
  rail: "x402",
  buildDecision: (input: {
    ovt: X402OVT;
    matched: MatchedPolicy[];
    considered: PolicyV2[];
    context: EvalContext;
  }) => buildSharedDecision(input)
};

/* ------------------------------------------------------------------ */
/* USDC-on-Solana evaluator (Track A Phase 1 — stablecoin rail)       */
/* ------------------------------------------------------------------ */

/**
 * Activated 2026-07-03 for the stablecoin rail (roadmap v2 Track A
 * Phase 1: `/v1/decisions` for stablecoin verbs). Same shared
 * collapse as every other rail; the rail-specific work (SPL
 * ingestion, instrument config) lives in `@axiru/rails-solana` and
 * the host adapter, never here — the engine stays pure.
 *
 * OUSD note: OUSD-on-Solana transfers will flow through a sibling
 * OVT variant once the Open Standard consortium publishes the mint;
 * activating it is this same three-line pattern.
 */
export const usdcSolanaEvaluator: RailEvaluator<"usdc_solana"> = {
  rail: "usdc_solana",
  buildDecision: (input: {
    ovt: USDCSolanaOVT;
    matched: MatchedPolicy[];
    considered: PolicyV2[];
    context: EvalContext;
  }) => buildSharedDecision(input)
};

/* ------------------------------------------------------------------ */
/* Ad-platform evaluator (AI-CMO Phase 1 — dogfood governance)        */
/* ------------------------------------------------------------------ */

/**
 * Activated 2026-07-31 for Axiru's own "AI CMO under governance"
 * dogfood build. Same shared collapse as every other rail, PLUS one
 * rail-specific rule enforced here rather than in the generic engine
 * (the documented "only per-rail customization" extension point — see
 * file header):
 *
 *   `ad_spend` is STAGED BY DEFAULT. A clean `allow` that resulted from
 *   NO enforcing policy explicitly allowing the intent (zero matches,
 *   or only a shadow-mode allow match) is demoted to
 *   `require_approval` with `axiru.pending.ad_spend_staged_default`.
 *   An enforcing policy whose effect is `allow` — i.e. a policy the
 *   org author explicitly wrote to allow ad-spend traffic — bypasses
 *   the demotion, per spec: "requires approval unless a policy
 *   explicitly allows otherwise". A `deny` or `require_approval`
 *   verdict from `buildSharedDecision` is untouched (this only ever
 *   tightens a clean allow, never loosens anything).
 *
 *   This rail also has NO settlement executor (Phase 1, non-negotiable
 *   boundary — see `Rail` union doc comment in `rail.ts`): every
 *   decision this evaluator returns, regardless of `action`, carries
 *   `disposition: "manual_execution"` plus a matching leading
 *   `axiru.disposition.manual_execution` reason, so the fact that
 *   nothing was executed automatically survives into the persisted
 *   `reasonTrail` even without any host-side wiring change.
 */
function hasEnforcingAllowMatch(matched: MatchedPolicy[]): boolean {
  return matched.some((m) => m.policy.mode === "enforcing" && m.effect.kind === "allow");
}

function stageAdSpendByDefault(decision: DecisionV2, matched: MatchedPolicy[]): DecisionV2 {
  if (decision.action !== "allow") return decision;
  if (hasEnforcingAllowMatch(matched)) return decision;

  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.PENDING_AD_SPEND_STAGED_DEFAULT,
    reason_text:
      "ad_spend is staged by default: no enforcing policy explicitly allowed this intent, " +
      "so it requires approval rather than defaulting to allow."
  };
  return {
    ...decision,
    action: "require_approval",
    axiru_reason_code: AXIRU_REASON_CODES.PENDING_AD_SPEND_STAGED_DEFAULT,
    reasons: [reason, ...decision.reasons]
  };
}

function annotateManualExecutionDisposition(decision: DecisionV2): DecisionV2 {
  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.DISPOSITION_MANUAL_EXECUTION,
    reason_text:
      "The ad_platform rail has no settlement executor in Phase 1. This decision does not " +
      "move money or change any ad platform's live state by itself; on allow, a human executes " +
      "the action manually in the ad platform's own console and records the outcome."
  };
  return {
    ...decision,
    disposition: "manual_execution",
    reasons: [reason, ...decision.reasons]
  };
}

export const adPlatformEvaluator: RailEvaluator<"ad_platform"> = {
  rail: "ad_platform",
  buildDecision: (input: {
    ovt: AdPlatformOVT;
    matched: MatchedPolicy[];
    considered: PolicyV2[];
    context: EvalContext;
  }) => {
    let decision = buildSharedDecision(input);
    decision = stageAdSpendByDefault(decision, input.matched);
    decision = annotateManualExecutionDisposition(decision);
    return decision;
  }
};

/* ------------------------------------------------------------------ */
/* Registry — keyed by rail for the dispatcher                        */
/* ------------------------------------------------------------------ */

/**
 * Map a rail discriminator to its evaluator. Only Phase-1-active
 * rails appear here; Phase 2 rails are surfaced as
 * `axiru.deny.unknown_rail` by the top-level dispatcher.
 *
 * Type-level safety: keys are constrained to the Phase 1 active
 * subset via the `Extract<Rail, …>` selector so adding a new active
 * rail without registering an evaluator is a compile error.
 */
export const PHASE_1_EVALUATORS: {
  stripe: RailEvaluator<"stripe">;
  stripe_daa: RailEvaluator<"stripe_daa">;
  x402: RailEvaluator<"x402">;
  usdc_solana: RailEvaluator<"usdc_solana">;
  ad_platform: RailEvaluator<"ad_platform">;
} = {
  stripe: stripeEvaluator,
  stripe_daa: stripeDaaEvaluator,
  x402: x402Evaluator,
  usdc_solana: usdcSolanaEvaluator,
  ad_platform: adPlatformEvaluator
};

export type Phase1ActiveRail = keyof typeof PHASE_1_EVALUATORS;

export function isPhase1EvaluatorRail(rail: Rail): rail is Phase1ActiveRail {
  return (
    rail === "stripe" ||
    rail === "stripe_daa" ||
    rail === "x402" ||
    rail === "usdc_solana" ||
    rail === "ad_platform"
  );
}
