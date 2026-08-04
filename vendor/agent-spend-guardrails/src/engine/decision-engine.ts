/**
 * Decision Engine v2 — top-level `evaluate()` (T-011, T-015).
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §5.
 *
 * This is the single function the rest of Axiru calls. Everything
 * else in this package is implementation detail.
 *
 * Wire-up plan (Wk 4 — T-019): the existing webhook dispatcher in
 * `apps/web/src/lib/axiru/decision-pipeline.ts` will call
 * `evaluate()` BEHIND the `crossRail.enabled` org-level feature flag,
 * in parallel with the legacy `evaluateRefundEvent` family. Both
 * decisions are persisted; the Replay engine (T-020) asserts they
 * agree for every v1 policy via LegacyV1Adapter.
 *
 *   v1 path (today):
 *     webhook → normalize-financial-event → evaluateXEvent → EventDecision
 *
 *   v2 path (Wk 4+):
 *     webhook → rail-adapter.normalize → OVT → evaluate(ovt, policies, ctx)
 *            → DecisionV2 → EventDecision (rail+railAction+ovtFingerprint
 *              now populated from the v2 result)
 *
 * Purity invariant: this function is pure. Every impure input is
 * passed via EvalContext. See spec §5.1.
 */

import {
  AXIRU_REASON_CODES,
  type AgentBudgetRule,
  type MandateScopeRule,
  type OutboundValueTransfer,
  type PolicyV2,
  type Rail
} from "../types/index.js";
import { matchPolicySet } from "./policy-matcher.js";
import {
  agentBudgetInputsUnavailable,
  evaluateAgentBudgetRule,
  evaluateMandateScopeRule
} from "./rule-evaluators.js";
import {
  isPhase1EvaluatorRail,
  PHASE_1_EVALUATORS,
  type Phase1ActiveRail
} from "./per-rail-evaluators.js";
import type {
  DecisionReason,
  DecisionV2,
  EvalContext,
  EvaluateInput,
  MatchedPolicy,
  RailEvaluator
} from "./types.js";

/* ------------------------------------------------------------------ */
/* evaluate()                                                         */
/* ------------------------------------------------------------------ */

export function evaluate(input: EvaluateInput): DecisionV2 {
  const { ovt, policies, context } = input;

  // ----- 1. Rail gate: Phase 2 rails are short-circuited to deny. ---
  if (!isPhase1EvaluatorRail(ovt.rail)) {
    return synthesizeUnknownRailDecision(ovt, context);
  }

  // ----- 2. Match the policy set, sorted by precedence. -------------
  const summary = matchPolicySet(policies, ovt, context);

  // ----- 3. Dispatch to per-rail evaluator. --------------------------
  // Widened to the general `RailEvaluator` (not the precise indexed
  // union member) — with five Phase 1 rails now registered, letting
  // TS infer the exact union blows past its "expression too complex"
  // limit (TS2590). Safe: every registry entry satisfies the general
  // shape, and `ovt as never` below is the pre-existing narrowing
  // idiom this dispatch already relied on.
  const evaluator: RailEvaluator = PHASE_1_EVALUATORS[ovt.rail as Phase1ActiveRail];
  let decision = evaluator.buildDecision({
    ovt: ovt as never,
    matched: summary.matched,
    considered: summary.considered,
    context
  });

  // ----- 4. Rule-error fail-closed escalation. ----------------------
  // If any policy in scope produced a rule-evaluation error, demote
  // the action to require_approval and attach a synthetic reason so
  // operators can find and fix the bad rule.
  if (summary.rule_errors.length > 0) {
    decision = demoteForRuleErrors(decision, summary.rule_errors);
  }

  // ----- 5. Zero-sentinel velocity guard (review P1-1, interim). ----
  // Rolling-window rules compare against aggregates denormalized onto
  // the OVT at intake. When the intake path never supplied them, the
  // OVT carries the zero-filled sentinel — and every velocity rule
  // silently evaluates as if the org had zero prior activity, which
  // makes gte-deny rules unfireable and lte-allow rules trivially
  // true. If any ENFORCING policy in scope carries a rolling-window
  // rule and the inputs are the sentinel, a clean `allow` cannot be
  // trusted: demote to `require_approval`.
  //
  // Known false positive: a brand-new org with genuinely zero
  // activity gets one conservative require_approval on its first
  // transfer under a velocity policy. Accepted — indistinguishable
  // from the missing-aggregates case with the current PolicyInputs
  // shape, and safe. Removed once the x402 path computes real
  // server-side aggregates (P1-1 full fix).
  const velocityPolicyIds = consideredEnforcingRollingWindowPolicyIds(summary.considered);
  if (velocityPolicyIds.length > 0 && isZeroSentinelPolicyInputs(ovt)) {
    decision = demoteForZeroSentinelVelocity(decision, velocityPolicyIds);
  }

  // ----- 6. Agent-budget inputs guard (Track B Epic A). --------------
  // Mirror of step 5 for agent_budget rules: budgets evaluate against
  // scope-selected aggregates denormalized onto the OVT (org-level
  // aggregates for principal scope; enrichment keys for agent / tool /
  // merchant scope). When an ENFORCING policy carries a budget rule
  // whose scope's aggregate this OVT does not supply, the rule silently
  // cannot fire — so a clean `allow` cannot be trusted and is demoted
  // to `require_approval`. Shadow-mode policies are exempt; a deny is
  // never weakened. Same accepted false positive as step 5: a genuinely
  // fresh scope gets one conservative approval.
  const budgetPolicyIds = consideredEnforcingAgentBudgetPolicyIdsWithUnavailableInputs(
    summary.considered,
    ovt
  );
  if (budgetPolicyIds.length > 0) {
    decision = demoteForAgentBudgetInputs(decision, budgetPolicyIds);
  }

  // ----- 7. Canonical attribution for mandate-missing denies. --------
  decision = annotateMandateMissingDeny(decision, summary.matched, ovt);

  // ----- 8. Binding-ceiling attribution for the budget hierarchy. ----
  decision = annotateBindingBudgetCeiling(decision, summary.matched, ovt);

  return decision;
}

/* ------------------------------------------------------------------ */
/* Synthetic deny for unrecognized rails                              */
/* ------------------------------------------------------------------ */

function synthesizeUnknownRailDecision(
  ovt: OutboundValueTransfer,
  context: EvalContext
): DecisionV2 {
  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.DENY_UNKNOWN_RAIL,
    reason_text: `Rail "${ovt.rail}" has no Phase 1 evaluator; failing closed (deny).`
  };
  return {
    id: buildDecisionId(ovt.fingerprint),
    org_id: ovt.org_id,
    rail: ovt.rail as Rail,
    rail_action: ovt.rail_action,
    ovt_fingerprint: ovt.fingerprint,
    action: "deny",
    reasons: [reason],
    matched_policy_ids: [],
    axiru_reason_code: AXIRU_REASON_CODES.DENY_UNKNOWN_RAIL,
    evaluated_at: context.now
  };
}

function buildDecisionId(fingerprint: string): string {
  const hex = fingerprint.startsWith("sha256:") ? fingerprint.slice("sha256:".length) : fingerprint;
  return `dec_v2_${hex.slice(0, 12)}`;
}

/* ------------------------------------------------------------------ */
/* Rule-error fail-closed demotion                                    */
/* ------------------------------------------------------------------ */

/**
 * When the matcher encountered a rule that could not be evaluated
 * cleanly (FX miss, custom-expression timeout, unknown rule kind from
 * a forward-compat policy), we treat the OVT conservatively:
 *
 *   - If the baseline decision was `allow`, downgrade to
 *     `require_approval`. A clean allow shouldn't paper over a
 *     broken policy.
 *   - If the baseline was already `require_approval` or `deny`, leave
 *     the action alone but still attach the diagnostic reason.
 *
 * The synthetic reason carries the `axiru.deny.expression_timeout`
 * code by spec convention even though the root cause may be an FX
 * miss; the code names a CATEGORY (rule-evaluation failure), not a
 * specific defect.
 */
function demoteForRuleErrors(
  decision: DecisionV2,
  rule_errors: Array<{ policy_id: string; error: string }>
): DecisionV2 {
  const errorReasons: DecisionReason[] = rule_errors.map((re) => ({
    reason_code: AXIRU_REASON_CODES.DENY_EXPRESSION_TIMEOUT,
    reason_text: `Policy ${re.policy_id} rule evaluation failed: ${re.error}`,
    policy_id: re.policy_id
  }));

  const demotedAction = decision.action === "allow" ? "require_approval" : decision.action;
  const demotedAxiruCode =
    decision.action === "allow"
      ? AXIRU_REASON_CODES.DENY_EXPRESSION_TIMEOUT
      : decision.axiru_reason_code;

  return {
    ...decision,
    action: demotedAction,
    // Diagnostic reasons go FIRST so operators see them at the top of
    // the audit trail, then the would-have-been-winning reason, then
    // the rest.
    reasons: [...errorReasons, ...decision.reasons],
    axiru_reason_code: demotedAxiruCode
  };
}

/* ------------------------------------------------------------------ */
/* Zero-sentinel velocity guard (review P1-1, interim)                */
/* ------------------------------------------------------------------ */

/**
 * True when the OVT's aggregates are the zero-filled sentinel used by
 * intake paths that do not (yet) compute rolling-window aggregates
 * (e.g. `ZERO_POLICY_INPUTS` in the x402 middleware's OVT builder).
 * `enrichment` is deliberately not consulted — enrichment adapters can
 * run independently of aggregate computation.
 */
export function isZeroSentinelPolicyInputs(ovt: OutboundValueTransfer): boolean {
  const pi = ovt.policy_inputs;
  return (
    pi.amount_30d === 0n && pi.amount_24h === 0n && pi.count_30d === 0 && pi.count_24h === 0
  );
}

/**
 * IDs of in-scope ENFORCING policies that carry at least one
 * rolling-window rule. Shadow-mode policies are excluded: they never
 * gate live traffic, so an unevaluable velocity rule in shadow must
 * not force approvals in production.
 */
function consideredEnforcingRollingWindowPolicyIds(considered: PolicyV2[]): string[] {
  return considered
    .filter(
      (p) => p.mode === "enforcing" && p.rules.some((r) => r.kind === "rolling_window")
    )
    .map((p) => p.id);
}

/**
 * Same demotion shape as {@link demoteForRuleErrors}: a clean `allow`
 * becomes `require_approval`; an existing `require_approval`/`deny`
 * keeps its action but gains the diagnostic reason so the audit trail
 * records that velocity limits were not actually evaluated.
 */
function demoteForZeroSentinelVelocity(
  decision: DecisionV2,
  velocityPolicyIds: string[]
): DecisionV2 {
  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.PENDING_VELOCITY_INPUTS_UNAVAILABLE,
    reason_text:
      `Rolling-window aggregates were not supplied at intake (zero sentinel); ` +
      `velocity rules on enforcing ${velocityPolicyIds.length === 1 ? "policy" : "policies"} ` +
      `${velocityPolicyIds.join(", ")} could not be evaluated. Failing to require_approval.`
  };

  const demotedAction = decision.action === "allow" ? "require_approval" : decision.action;
  const demotedAxiruCode =
    decision.action === "allow"
      ? AXIRU_REASON_CODES.PENDING_VELOCITY_INPUTS_UNAVAILABLE
      : decision.axiru_reason_code;

  return {
    ...decision,
    action: demotedAction,
    reasons: [reason, ...decision.reasons],
    axiru_reason_code: demotedAxiruCode
  };
}

/* ------------------------------------------------------------------ */
/* Agent-budget inputs guard (Track B Epic A)                         */
/* ------------------------------------------------------------------ */

/**
 * IDs of in-scope ENFORCING policies carrying at least one
 * agent_budget rule that would bind this OVT but whose scoped
 * aggregate is unavailable at intake. Shadow-mode policies are
 * excluded for the same reason as the velocity guard: they never gate
 * live traffic, so an unevaluable budget in shadow must not force
 * approvals in production. The per-rule predicate is shared with the
 * rule evaluator ({@link agentBudgetInputsUnavailable}) so the two
 * layers can never drift.
 */
function consideredEnforcingAgentBudgetPolicyIdsWithUnavailableInputs(
  considered: PolicyV2[],
  ovt: OutboundValueTransfer
): string[] {
  return considered
    .filter(
      (p) =>
        p.mode === "enforcing" &&
        p.rules.some((r) => r.kind === "agent_budget" && agentBudgetInputsUnavailable(r, ovt))
    )
    .map((p) => p.id);
}

/**
 * Same demotion shape as {@link demoteForZeroSentinelVelocity}: a
 * clean `allow` becomes `require_approval`; an existing
 * `require_approval`/`deny` keeps its action but gains the diagnostic
 * reason so the audit trail records that agent budgets were not
 * actually evaluated.
 */
function demoteForAgentBudgetInputs(decision: DecisionV2, budgetPolicyIds: string[]): DecisionV2 {
  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.PENDING_AGENT_BUDGET_INPUTS_UNAVAILABLE,
    reason_text:
      `Scoped agent-spend aggregates were not supplied at intake; ` +
      `agent_budget rules on enforcing ${budgetPolicyIds.length === 1 ? "policy" : "policies"} ` +
      `${budgetPolicyIds.join(", ")} could not be evaluated. Failing to require_approval.`
  };

  const demotedAction = decision.action === "allow" ? "require_approval" : decision.action;
  const demotedAxiruCode =
    decision.action === "allow"
      ? AXIRU_REASON_CODES.PENDING_AGENT_BUDGET_INPUTS_UNAVAILABLE
      : decision.axiru_reason_code;

  return {
    ...decision,
    action: demotedAction,
    reasons: [reason, ...decision.reasons],
    axiru_reason_code: demotedAxiruCode
  };
}

/* ------------------------------------------------------------------ */
/* Mandate-missing canonical attribution (Track B Epic A)             */
/* ------------------------------------------------------------------ */

/**
 * When the WINNING enforcing policy is a deny that matched through a
 * `mandate_scope { require_mandate: true }` rule against an
 * agent-initiated OVT with no mandate_ref, stamp the canonical
 * `axiru.deny.mandate_missing` code onto the decision (summary code +
 * a leading diagnostic reason). The action is never changed — this is
 * pure attribution so billing/alerting/the JWS claim can distinguish
 * "denied for missing mandate" from a generic customer deny.
 *
 * The violation is re-derived from the rule + OVT (cheap and pure)
 * rather than trusted from match order, so a mandate policy that also
 * carries other rules cannot mislabel a deny that fired for a
 * different reason on a mandate-carrying OVT.
 */
function annotateMandateMissingDeny(
  decision: DecisionV2,
  matched: MatchedPolicy[],
  ovt: OutboundValueTransfer
): DecisionV2 {
  if (decision.action !== "deny") return decision;
  // The winner mirrors buildSharedDecision: first enforcing match in
  // precedence order.
  const winner = matched.find((m) => m.policy.mode === "enforcing");
  if (!winner || winner.effect.kind !== "deny") return decision;
  const mandateRule = winner.policy.rules.find(
    (r): r is MandateScopeRule => r.kind === "mandate_scope" && r.require_mandate
  );
  if (!mandateRule) return decision;
  if (!evaluateMandateScopeRule(mandateRule, ovt).matched) return decision;

  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.DENY_MANDATE_MISSING,
    reason_text:
      `Agent-initiated OVT carries no mandate_ref but enforcing policy ` +
      `${winner.policy.id} requires a signed mandate (mandate_scope.require_mandate). Denied.`,
    policy_id: winner.policy.id,
    policy_version: winner.policy.version,
    policy_mode: winner.policy.mode
  };

  return {
    ...decision,
    axiru_reason_code: AXIRU_REASON_CODES.DENY_MANDATE_MISSING,
    reasons: [reason, ...decision.reasons]
  };
}

/* ------------------------------------------------------------------ */
/* Binding-ceiling attribution (budget hierarchy B-H1/B-H2)           */
/* ------------------------------------------------------------------ */

/**
 * Deterministic layer order for describing breached ceilings: the
 * narrowest layer first. Purely presentational ordering - precedence
 * between EFFECTS is the standard ladder in the policy matcher.
 */
const BUDGET_LAYER_ORDER: Record<AgentBudgetRule["scope"], number> = {
  agent: 0,
  tool: 1,
  merchant: 2,
  principal: 3,
  team: 4,
  org: 5,
  project: 6
};

function describeBudgetCeiling(rule: AgentBudgetRule): string {
  const parts = [`scope=${rule.scope}`];
  if (rule.scope === "team" && rule.team_tag !== undefined) parts.push(`team_tag=${rule.team_tag}`);
  parts.push(`window=${rule.window}`, `cap=${rule.max_amount_minor_units}`);
  if (rule.currency !== undefined) parts.push(`currency=${rule.currency}`);
  return parts.join(" ");
}

function sortCeilings(rules: AgentBudgetRule[]): AgentBudgetRule[] {
  return [...rules].sort(
    (a, b) =>
      BUDGET_LAYER_ORDER[a.scope] - BUDGET_LAYER_ORDER[b.scope] ||
      a.window.localeCompare(b.window) ||
      a.max_amount_minor_units.localeCompare(b.max_amount_minor_units)
  );
}

/**
 * Budget-hierarchy receipt requirement (roadmap v2 Phase 2 block): when
 * a non-allow decision's WINNING enforcing policy matched through one
 * or more `agent_budget` ceilings, stamp a leading
 * `axiru.budget.ceiling_binding` reason that names exactly WHICH
 * ceiling was binding (layer, window, cap, currency, policy), plus any
 * other breached ceilings across matched enforcing policies for the
 * trail. Pure attribution: the action and the summary reason code are
 * never changed, and the breach is re-derived from rule + OVT (cheap,
 * pure, same posture as {@link annotateMandateMissingDeny}) so match
 * order can never mislabel the binding layer.
 *
 * Most-restrictive-wins is enforced upstream by the precedence ladder
 * (deny > require_approval > allow); this function only RECORDS the
 * outcome so receipts and the approval surface can say "the org cap
 * bound this spend" instead of a bare policy id.
 */
function annotateBindingBudgetCeiling(
  decision: DecisionV2,
  matched: MatchedPolicy[],
  ovt: OutboundValueTransfer
): DecisionV2 {
  if (decision.action === "allow") return decision;
  const winner = matched.find((m) => m.policy.mode === "enforcing");
  if (!winner) return decision;

  const breachedOn = (policy: PolicyV2): AgentBudgetRule[] =>
    policy.rules.filter(
      (r): r is AgentBudgetRule =>
        r.kind === "agent_budget" && evaluateAgentBudgetRule(r, ovt).matched
    );

  const binding = sortCeilings(breachedOn(winner.policy));
  if (binding.length === 0) return decision;

  const alsoBreached: string[] = [];
  for (const m of matched) {
    if (m.policy.mode !== "enforcing" || m.policy.id === winner.policy.id) continue;
    for (const rule of sortCeilings(breachedOn(m.policy))) {
      alsoBreached.push(`${describeBudgetCeiling(rule)} (policy ${m.policy.id})`);
    }
  }

  const reason: DecisionReason = {
    reason_code: AXIRU_REASON_CODES.BUDGET_CEILING_BINDING,
    reason_text:
      `Binding budget ceiling: ${binding.map(describeBudgetCeiling).join("; ")} ` +
      `(policy ${winner.policy.id} v${winner.policy.version}, effect ${winner.effect.kind}). ` +
      `Most restrictive layer wins.` +
      (alsoBreached.length > 0 ? ` Also breached: ${alsoBreached.join("; ")}.` : ""),
    policy_id: winner.policy.id,
    policy_version: winner.policy.version,
    policy_mode: winner.policy.mode
  };

  return { ...decision, reasons: [reason, ...decision.reasons] };
}

/* ------------------------------------------------------------------ */
/* Convenience: evaluate-many                                         */
/* ------------------------------------------------------------------ */

/**
 * Batch wrapper. Same context, same policy set, many OVTs. Useful for
 * Decision Replay (T-020) which re-runs historical OVTs against the
 * current engine to check for drift.
 */
export function evaluateMany(
  ovts: OutboundValueTransfer[],
  policies: PolicyV2[],
  context: EvalContext
): DecisionV2[] {
  return ovts.map((ovt) => evaluate({ ovt, policies, context }));
}
