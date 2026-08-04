/**
 * @axiru/agent-spend-guardrails (vendored engine)
 *
 * Rail-agnostic decision evaluator. The single public entry point is
 * `evaluate(input)`. Everything else is exported for tests and for
 * the LegacyV1Adapter (T-018), which lets callers route v1 policies
 * through the v2 evaluator at load time.
 */

export { evaluate, evaluateMany } from "./decision-engine.js";
export {
  matchPolicy,
  matchPolicySet,
  comparePolicyPrecedence,
  type PolicyMatchSummary
} from "./policy-matcher.js";
export {
  evaluateRule,
  evaluateRailRule,
  evaluateRailActionRule,
  evaluateAmountRule,
  evaluateInitiatorKindRule,
  evaluateInitiatorIdRule,
  evaluateCounterpartyRule,
  evaluateRollingWindowRule,
  evaluateTimeOfDayRule,
  evaluateAgentScopeRule,
  evaluateAgentBudgetRule,
  evaluateAgentApprovalTierRule,
  evaluateMandateScopeRule,
  agentBudgetInputsUnavailable,
  evaluateCustomExpressionRule
} from "./rule-evaluators.js";
export {
  stripeEvaluator,
  stripeDaaEvaluator,
  x402Evaluator,
  usdcSolanaEvaluator,
  PHASE_1_EVALUATORS,
  isPhase1EvaluatorRail,
  type Phase1ActiveRail
} from "./per-rail-evaluators.js";
export type {
  DecisionV2,
  DecisionActionV2,
  DecisionReason,
  EvalContext,
  EvaluateInput,
  FxResolver,
  MatchedPolicy,
  RailEvaluator,
  RuleEvaluation,
  PolicyRuleV2
} from "./types.js";

/* LegacyV1Adapter (T-018) */
export {
  translateV1Policy,
  translateV1Policies,
  mapV1ModeToV2,
  mapV2ModeToV1,
  type LegacyV1Policy,
  type LegacyV1PolicyMode,
  type LegacyV1PolicyRule,
  type LegacyV1ThresholdRule,
  type LegacyV1AdapterResult
} from "./legacy/v1-policy-adapter.js";
