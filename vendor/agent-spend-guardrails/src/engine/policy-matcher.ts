/**
 * Policy-set matcher.
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §5.2 — §5.4.
 *
 * Responsibilities:
 *   1. Filter the policy set down to "in scope" (mode !== disabled).
 *   2. Evaluate every rule on every in-scope policy against the OVT.
 *   3. Return the matched policies in PRECEDENCE order so the per-rail
 *      evaluator can pick the winner deterministically.
 *
 * Precedence ladder (spec §5.4, paraphrased):
 *
 *   1. deny  beats  require_approval  beats  allow.
 *      A single `deny` matched policy wins outright, regardless of how
 *      many allow/require_approval policies also matched. This is the
 *      "safety-first" rule that makes Axiru a defensible governance
 *      engine — a customer can write a generic allow policy without
 *      worrying that it silently undoes their narrow deny rule.
 *
 *   2. Within a tier, mode beats mode:
 *        enforcing > shadow > disabled.
 *      A `deny` in shadow mode is NOT promoted to denying an OVT in
 *      production — it is recorded for audit but the precedence
 *      collapse uses an enforcing-mode tiebreaker. The per-rail
 *      evaluator handles this final demotion.
 *
 *   3. Within a (tier, mode) cell, sort by:
 *        - policy.version DESC (newest policy wins)
 *        - policy.id ASC      (stable tiebreaker for byte-identical
 *                              precedence under Decision Replay).
 *
 * Purity invariant: this file has no I/O and no time-dependent logic
 * beyond what the rule evaluators themselves access through
 * EvalContext.now.
 */

import type { OutboundValueTransfer, PolicyEffectV2, PolicyV2 } from "../types/index.js";

import { evaluateRule } from "./rule-evaluators.js";
import type { EvalContext, MatchedPolicy } from "./types.js";

/* ------------------------------------------------------------------ */
/* Policy-level match                                                 */
/* ------------------------------------------------------------------ */

interface PolicyMatchResult {
  policy: PolicyV2;
  effect: PolicyEffectV2;
  /**
   * True iff every rule on the policy matched without error. A policy
   * with zero rules is treated as match-all (the spec's "blanket
   * default" pattern).
   */
  matched: boolean;
  /**
   * The first rule error encountered (if any). Recorded so the
   * per-rail evaluator can surface a fallback reason code; a policy
   * with a rule error is treated as non-matching.
   */
  rule_error?: string;
}

export function matchPolicy(
  policy: PolicyV2,
  ovt: OutboundValueTransfer,
  context: EvalContext
): PolicyMatchResult {
  // Zero-rule policies match everything in scope — see spec §5.2.
  if (policy.rules.length === 0) {
    return { policy, effect: policy.effect, matched: true };
  }

  for (const rule of policy.rules) {
    // The effect kind is passed so band-style rules (agent_approval_tier)
    // can select the band this policy's effect names. See evaluateRule.
    const result = evaluateRule(rule, ovt, context, policy.effect.kind);
    if (result.error) {
      return { policy, effect: policy.effect, matched: false, rule_error: result.error };
    }
    if (!result.matched) {
      return { policy, effect: policy.effect, matched: false };
    }
  }
  return { policy, effect: policy.effect, matched: true };
}

/* ------------------------------------------------------------------ */
/* Precedence sort                                                    */
/* ------------------------------------------------------------------ */

const TIER_RANK: Record<PolicyEffectV2["kind"], number> = {
  // Lower rank = higher precedence.
  deny: 0,
  require_approval: 1,
  allow: 2
};

const MODE_RANK: Record<PolicyV2["mode"], number> = {
  enforcing: 0,
  shadow: 1,
  // Disabled policies should never enter this function (we filter
  // them out at intake), but if one slipped through it should lose.
  disabled: 2
};

/**
 * Stable compare for two matched policies. Lower return value = higher
 * precedence (wins). Total order so the sort result is deterministic
 * across JS engines (a hard requirement for Decision Replay).
 */
export function comparePolicyPrecedence(a: MatchedPolicy, b: MatchedPolicy): number {
  const tier = TIER_RANK[a.effect.kind] - TIER_RANK[b.effect.kind];
  if (tier !== 0) return tier;
  const mode = MODE_RANK[a.policy.mode] - MODE_RANK[b.policy.mode];
  if (mode !== 0) return mode;
  // Newer version wins.
  const ver = b.policy.version - a.policy.version;
  if (ver !== 0) return ver;
  // Stable tiebreaker.
  if (a.policy.id < b.policy.id) return -1;
  if (a.policy.id > b.policy.id) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Top-level matcher                                                  */
/* ------------------------------------------------------------------ */

export interface PolicyMatchSummary {
  /** Sorted by precedence; index 0 is the winner. */
  matched: MatchedPolicy[];
  /** The full in-scope set, used by per-rail evaluators for attribution. */
  considered: PolicyV2[];
  /**
   * Errors encountered while evaluating rules. Each entry is "this
   * policy could not be evaluated cleanly; the dispatcher should
   * route the OVT to require_approval as a fail-closed fallback".
   */
  rule_errors: Array<{ policy_id: string; error: string }>;
}

export function matchPolicySet(
  policies: PolicyV2[],
  ovt: OutboundValueTransfer,
  context: EvalContext
): PolicyMatchSummary {
  const considered = policies.filter((p) => p.mode !== "disabled" && p.org_id === ovt.org_id);
  const matched: MatchedPolicy[] = [];
  const rule_errors: Array<{ policy_id: string; error: string }> = [];

  for (const policy of considered) {
    const result = matchPolicy(policy, ovt, context);
    if (result.rule_error) {
      rule_errors.push({ policy_id: policy.id, error: result.rule_error });
      continue;
    }
    if (result.matched) {
      matched.push({ policy, effect: result.effect });
    }
  }

  matched.sort(comparePolicyPrecedence);
  return { matched, considered, rule_errors };
}
