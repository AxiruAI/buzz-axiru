/**
 * Policy schema v2 — the rail-agnostic policy DSL.
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §4.2.
 *
 * Compared to v1 (`the hosted platform domain package` Policy):
 *   - v1 references Stripe action types directly (refund / payout / …).
 *   - v2 references the abstract OutboundValueTransfer surface via
 *     `RailRule` / `RailActionRule`, allowing one policy to govern
 *     events from any rail.
 *
 * The Decision Engine accepts both v1 and v2 in Phase 1. v1 policies
 * are translated to v2 at load time by `LegacyV1Adapter`. See spec
 * §4.3 and `packages/decision-engine/src/legacy/v1-policy-adapter.ts`.
 */

import type { Counterparty, OutboundValueTransfer } from "./outbound-value-transfer.js";

/* ------------------------------------------------------------------ */
/* Policy mode                                                        */
/* ------------------------------------------------------------------ */

/**
 * Policy mode determines whether matched policies affect the Decision
 * Engine's final outcome.
 *
 *   - `shadow`: evaluated and included in the audit trail, but DOES
 *               NOT affect the final outcome. Every new policy must
 *               start here for at least one customer billing cycle.
 *   - `enforcing`: evaluated and DOES affect the final outcome.
 *   - `disabled`: skipped entirely.
 *
 * Maps to v1's `simulate | enforce` as: simulate → shadow,
 * enforce → enforcing. There is no v1 equivalent of `disabled`
 * (v1 uses Policy.enabled boolean).
 */
export type PolicyV2Mode = "shadow" | "enforcing" | "disabled";

/* ------------------------------------------------------------------ */
/* Policy effect — what to do when the policy matches                 */
/* ------------------------------------------------------------------ */

export interface PolicyEffectV2 {
  kind: "allow" | "deny" | "require_approval";
  /** For require_approval — which approver group to route to. */
  approver_group?: string;
  /**
   * Stable reason code surfaced to the audit ledger and dashboard.
   * Customer-defined effects use the `customer.*` prefix.
   * Reserved prefixes: `axiru.*`, `stripe.*`, `privy.*`, `tempo.*`, `ucp.*`.
   */
  reason_code: string;
  /** Human-readable explanation, surfaced in UI and audit exports. */
  reason_text: string;
  /**
   * If present, clamps the issued authorization token's
   * `axiru.max_authorized_amount` to this value. The signer is then
   * required to refuse any transaction whose amount exceeds the clamp.
   */
  max_authorized_amount?: { currency: string; minor_units: string };
  /**
   * Override the default authorization-token TTL of 60s. Max 300s
   * per spec §6.2.
   */
  authorization_ttl_seconds?: number;
}

/* ------------------------------------------------------------------ */
/* Rule variants                                                      */
/* ------------------------------------------------------------------ */

export type PolicyRuleV2 =
  | RailRule
  | RailActionRule
  | AmountRule
  | InitiatorKindRule
  | InitiatorIdRule
  | AgentScopeRule
  | CounterpartyRule
  | RollingWindowRule
  | TimeOfDayRule
  | CustomExpressionRule
  | AgentBudgetRule
  | AgentApprovalTierRule
  | MandateScopeRule;

/** Whitelist of rails this policy applies to. Empty = all rails. */
export interface RailRule {
  kind: "rail";
  in: OutboundValueTransfer["rail"][];
}

/**
 * Whitelist of rail_action values. Note that allowed action strings
 * vary by rail; the engine does NOT enforce cross-rail action
 * compatibility — that's the policy author's responsibility.
 */
export interface RailActionRule {
  kind: "rail_action";
  in: string[];
}

/**
 * Amount comparison. Both `gte` and `lte` are bigint values serialized
 * as strings (JSON doesn't natively carry bigint). The evaluator
 * parses them with `BigInt(...)`.
 *
 * If `fx_base` is set, the engine first converts the OVT amount to
 * `fx_base` using the injected pure FX resolver. This enables
 * cross-currency comparison without compromising determinism (the FX
 * function is pure and deterministic per spec §5.1).
 */
export interface AmountRule {
  kind: "amount";
  /** Currency this rule's gte/lte are denominated in. */
  currency: string;
  gte?: string;
  lte?: string;
  fx_base?: string;
}

export interface InitiatorKindRule {
  kind: "initiator_kind";
  in: ("human" | "agent" | "automation")[];
}

export interface InitiatorIdRule {
  kind: "initiator_id";
  in: string[];
}

export interface AgentScopeRule {
  kind: "agent_scope";
  /** Agent must have ALL of these scopes. */
  has_all?: string[];
  /** Agent must have NONE of these scopes. */
  has_none?: string[];
}

export interface CounterpartyRule {
  kind: "counterparty";
  kind_in?: Counterparty["kind"][];
  id_in?: string[];
  /** ISO-3166-1 alpha-2. */
  country_in?: string[];
  country_not_in?: string[];
}

export interface RollingWindowRule {
  kind: "rolling_window";
  window: "24h" | "30d";
  aggregate: "sum_amount" | "count";
  op: "gte" | "lte";
  /** bigint or count, serialized as string. */
  value: string;
  /**
   * Optional grouping. `by_initiator` computes the aggregate per
   * initiator id (e.g. "any single agent has spent > $X in 24h").
   * Default (omitted) is per-org.
   */
  group_by?: "by_initiator" | "by_counterparty" | "by_agent";
}

export interface TimeOfDayRule {
  kind: "time_of_day";
  /** IANA TZ, e.g. "America/New_York". */
  tz: string;
  /**
   * Allowed hour ranges (inclusive start, exclusive end), e.g.
   * `[{ start: 9, end: 17 }]` for 9am-5pm. The rule matches when
   * the OVT's `rail_event_at` falls inside ANY of the ranges.
   */
  ranges: { start: number; end: number }[];
}

export interface CustomExpressionRule {
  kind: "custom_expression";
  /**
   * Sandboxed JS-subset expression. See spec §5.4 for the language
   * grammar. Parsed once at policy save and cached as an AST.
   * Evaluation budget: 10ms per expression.
   */
  expression: string;
}

/* ------------------------------------------------------------------ */
/* Agent-spend rules (Track B Epic A — plan v1.1 §3.2)                */
/* ------------------------------------------------------------------ */

/**
 * Budget cap on agent spend, scoped and windowed.
 *
 * The rule MATCHES when the spend under evaluation would EXCEED the
 * budget — pair it with a `deny` or `require_approval` effect. The
 * check is prospective: for windowed budgets the comparison is
 * `(window aggregate) + (OVT amount) > max_amount_minor_units`, i.e.
 * "would this transfer take the scope over budget".
 *
 * Scope → aggregate source (all pure reads off the OVT; no I/O):
 *   - `per_call` window: only the OVT amount itself — always evaluable.
 *   - `principal`: the org-level `policy_inputs.amount_{24h,30d}`
 *     aggregates (Phase 1 approximates principal as the org). The
 *     zero-filled sentinel counts as UNAVAILABLE, mirroring the P1-1
 *     velocity guard.
 *   - `agent` / `tool` / `merchant`: enrichment keys computed by the
 *     intake adapter (decimal bigint strings). Currency-blind budgets read
 *     the agnostic `policy_inputs.enrichment["{scope}_spend_{24h|30d}"]`;
 *     currency-scoped budgets read the per-currency variant
 *     `policy_inputs.enrichment["{scope}_spend_{24h|30d}_{CCY}"]` (CCY =
 *     the uppercased, validated currency). See `budget-reader.ts` for the
 *     emit side of this key contract.
 *
 * Fail-closed contract: when the aggregate the scope needs is absent
 * from the OVT, the rule does not match (it cannot demonstrate an
 * over-budget condition) and the Decision Engine escalates any clean
 * allow to `require_approval` with
 * `axiru.pending.agent_budget_inputs_unavailable` — the exact shape of
 * the zero-sentinel velocity guard, including the shadow-mode
 * exemption and never weakening a deny.
 *
 * Amounts are minor-unit sums. CURRENCY DIMENSION:
 *   - `currency` ABSENT (back-compat default): the rule is currency-
 *     BLIND (like RollingWindowRule). It assumes the org transacts in a
 *     single denomination and the intake adapter aggregates in that one
 *     denomination; summing across denominations would be incommensurable,
 *     so authors of multi-currency orgs MUST set `currency`.
 *   - `currency` PRESENT: the rule governs spend in THAT currency only.
 *     The evaluator binds an OVT only when `ovt.amount.currency ===
 *     currency`; a different-currency OVT is out of scope and never
 *     matches (no false deny, no spurious escalation). The windowed check
 *     reads the PER-CURRENCY enrichment key
 *     `{scope}_spend_{24h|30d}_{CCY}` for that denomination (F2 fix), so
 *     the aggregate counts only same-currency spend — a USDC budget never
 *     folds in EUR spend. If the agent has no decodable prior spend in the
 *     rule's currency the key is absent and the engine fails closed
 *     (`agent_budget_inputs_unavailable` → require_approval), never a
 *     false allow. (Principal scope is the exception: it reads the
 *     currency-agnostic org velocity aggregate, so a currency-scoped
 *     principal budget keeps the over-restrict-safe cross-currency read.)
 *
 * The rule binds AGENT-INITIATED traffic only (`initiator.kind ===
 * "agent"`); other OVTs never match. Optional selectors narrow which
 * agent traffic the budget governs.
 */
export interface AgentBudgetRule {
  kind: "agent_budget";
  /**
   * Budget hierarchy (roadmap v2 Phase 2 block, B-H1/B-H2):
   *
   *   - `team`: shared ceiling for the policyTags group named by
   *     `team_tag` (B-H2). The evaluator reads the per-team enrichment
   *     keys `team_spend_{24h|30d}__{TAG}` plus the membership key
   *     `agent_team_tags`; membership KNOWN and absent is a definitive
   *     rule-out (the agent's own team/org ceilings still bind), while
   *     membership UNKNOWN fails closed via the inputs-unavailable
   *     guard. `team_tag` is REQUIRED for this scope (author error,
   *     typed, otherwise).
   *   - `org`: aggregate ceiling across ALL agent spend in the
   *     organization per window and currency (B-H1) - the fleet-wide
   *     cap. Reads `org_spend_{24h|30d}` (or the per-currency
   *     variant). Human/automation traffic is NOT counted or bound;
   *     this caps the agent fleet, complementing principal-scope org
   *     velocity.
   *   - `project`: RESERVED, type-only (roadmap: deferred until real
   *     per-intent project attribution exists). The evaluator emits a
   *     typed error, which the engine demotes fail-closed to
   *     require_approval - never a silent pass.
   *
   * Hierarchy evaluation is layered, deterministic, and
   * most-restrictive-wins: author one policy per layer (agent, team,
   * org); every breached layer matches its own policy and the standard
   * precedence ladder (deny > require_approval > allow) resolves
   * disagreement with no human needed. A spend inside the agent budget
   * that breaches a team or org ceiling therefore gets that ceiling's
   * effect (REQUIRE_APPROVAL at minimum), and the decision reason trail
   * records WHICH ceiling was binding (`axiru.budget.ceiling_binding`).
   */
  scope: "agent" | "principal" | "tool" | "merchant" | "team" | "org" | "project";
  window: "per_call" | "24h" | "30d";
  /** Decimal bigint string, minor units. */
  max_amount_minor_units: string;
  /**
   * When set, the budget governs spend in this currency ONLY: the
   * evaluator ignores OVTs whose `amount.currency` differs (mirrors
   * {@link AgentApprovalTierRule.currency}). When absent, the rule is
   * currency-blind and assumes one denomination per org (back-compat).
   */
  currency?: string;
  /**
   * REQUIRED when scope is "team": the policyTags group this ceiling
   * governs (normalized for the enrichment key: trimmed, lowercased,
   * "_" mapped to "-", `^[a-z0-9][a-z0-9-]{0,63}$`). Ignored for other
   * scopes.
   */
  team_tag?: string;
  /** Only govern this agent (matched against `initiator.id` or `agent_payment.agent_identity.value`). */
  agent_id?: string;
  /** Only govern spend to this tool (matched against `agent_payment.tool_ref`). */
  tool_ref?: string;
  /** Only govern spend to this counterparty (matched against `counterparty.id`). */
  counterparty_id?: string;
}

/**
 * Amount-tiered approval routing for agent spend (plan v1.1 §3.2:
 * "auto-approve < $X, human-in-the-loop $X–$Y, block ≥ $Y").
 *
 * Band semantics (thresholds are decimal bigint strings in
 * `currency` minor units; `auto_allow_below` must be <=
 * `require_approval_below`, else the rule fails closed with an error):
 *
 *   amount <  auto_allow_below                      → auto-allow band
 *   auto_allow_below <= amount < require_approval_below → approval band
 *   amount >= require_approval_below                → deny band
 *
 * MECHANISM: rules in this DSL are boolean matchers and a policy
 * carries exactly one effect, so the rule matches the band named by
 * the OWNING POLICY'S `effect.kind`: on a `deny` policy it matches the
 * deny band, on a `require_approval` policy the approval band, on an
 * `allow` policy the auto-allow band. Authors express the full tier
 * with a deny policy + a require_approval policy sharing the same
 * thresholds (amounts below `auto_allow_below` match neither, which IS
 * the auto-allow). PRECEDENCE: when tier policies overlap, the
 * standard ladder applies — deny wins, then require_approval, then
 * allow — so the deny band can never be weakened by a broader
 * require_approval or allow tier.
 *
 * Cross-currency tiers are not supported in Phase 1: a currency
 * mismatch with the OVT fails closed (typed error → engine demotes to
 * require_approval). Binds agent-initiated traffic only.
 */
export interface AgentApprovalTierRule {
  kind: "agent_approval_tier";
  /** Currency the two thresholds are denominated in. */
  currency: string;
  /** Decimal bigint string, minor units. */
  auto_allow_below: string;
  /** Decimal bigint string, minor units. Amounts at or above this are the deny band. */
  require_approval_below: string;
}

/**
 * Mandate-scope enforcement (plan v1.1 §3.2): the transaction must fit
 * within the signed delegation the agent acts under.
 *
 * The rule matches the VIOLATION: `require_mandate: true` and the OVT
 * is agent-initiated (`initiator.kind === "agent"`) with no
 * `agent_payment.mandate_ref`. Pair with a `deny` effect; the engine
 * surfaces the canonical `axiru.deny.mandate_missing` code on the
 * resulting decision. Non-agent OVTs never match (the rule does not
 * bind them). `require_mandate: false` never matches (no constraint).
 *
 * `max_amount_within_mandate` is RECORDED ONLY in Phase 1: verifying
 * the amount against the mandate's cap requires parsing the mandate
 * itself, which lands with AP2 mandate verification (plan §3.2 item 5,
 * Phase 2/3). The flag is carried now so policies authored today are
 * forward-compatible.
 */
export interface MandateScopeRule {
  kind: "mandate_scope";
  require_mandate: boolean;
  /** Phase 2: enforce OVT amount <= the mandate's authorized cap. Recorded, not enforced, in Phase 1. */
  max_amount_within_mandate?: boolean;
}

/* ------------------------------------------------------------------ */
/* The policy itself                                                  */
/* ------------------------------------------------------------------ */

export interface PolicyV2 {
  id: string;
  org_id: string;
  /** Schema-version discriminator. Always 2 for this shape. */
  schema_version: 2;
  name: string;
  description: string;
  /**
   * Monotonically increasing per-org version. Bumped on every save.
   * Persisted on every decision row to enable Decision Replay against
   * the exact policy version that produced the decision.
   */
  version: number;
  /** Clerk user id of the author of the most recent save. */
  author_id: string;
  mode: PolicyV2Mode;
  /**
   * Logical AND across all rules. A policy "matches" iff every rule
   * matches. Use multiple policies for OR-style logic.
   */
  rules: PolicyRuleV2[];
  effect: PolicyEffectV2;
  created_at: Date;
  updated_at: Date;
}

/* ------------------------------------------------------------------ */
/* Reason-code catalog (reserved axiru.* prefix)                      */
/* ------------------------------------------------------------------ */

/**
 * Canonical reason codes the engine itself emits. Customer policies
 * use the `customer.*` prefix and should NOT collide with these.
 *
 * Spec reference: §5.3.
 */
export const AXIRU_REASON_CODES = {
  ALLOW_DEFAULT: "axiru.allow.default",
  DENY_AMOUNT_EXCEEDED: "axiru.deny.amount_exceeded",
  DENY_SCOPE_VIOLATION: "axiru.deny.scope_violation",
  DENY_ROLLING_WINDOW_EXCEEDED: "axiru.deny.rolling_window_exceeded",
  DENY_COUNTERPARTY_BLOCKED: "axiru.deny.counterparty_blocked",
  DENY_COUNTRY_BLOCKED: "axiru.deny.country_blocked",
  DENY_UNKNOWN_RAIL: "axiru.deny.unknown_rail",
  DENY_SHADOW_MODE_FORCED: "axiru.deny.shadow_mode_forced",
  DENY_EXPRESSION_TIMEOUT: "axiru.deny.expression_timeout",
  PENDING_APPROVAL_REQUIRED: "axiru.pending.approval_required",
  PENDING_HIGH_VALUE: "axiru.pending.high_value",
  /**
   * The policy set contains enforcing rolling-window rules but the
   * OVT's `policy_inputs` are the zero sentinel (no aggregates were
   * supplied at intake). Velocity limits cannot be meaningfully
   * evaluated, so the engine fails to `require_approval` rather than
   * silently treating the aggregates as zero. See 2026-07-02 review
   * P1-1.
   */
  PENDING_VELOCITY_INPUTS_UNAVAILABLE: "axiru.pending.velocity_inputs_unavailable",
  /**
   * An enforcing `agent_budget` rule needed a scoped spend aggregate
   * (per-agent / per-tool / per-merchant enrichment key, or the
   * org-level aggregates for principal scope) that the OVT did not
   * carry at intake. Budgets cannot be meaningfully evaluated, so the
   * engine fails a clean allow to `require_approval` — the agent-spend
   * mirror of PENDING_VELOCITY_INPUTS_UNAVAILABLE. Track B Epic A.
   */
  PENDING_AGENT_BUDGET_INPUTS_UNAVAILABLE: "axiru.pending.agent_budget_inputs_unavailable",
  /**
   * A `mandate_scope` rule with `require_mandate: true` matched an
   * agent-initiated OVT that carries no `agent_payment.mandate_ref`.
   * Track B Epic A.
   */
  DENY_MANDATE_MISSING: "axiru.deny.mandate_missing",
  /**
   * Attribution (never changes the action): a matched enforcing
   * `agent_budget` ceiling drove (or contributed to) a non-allow
   * decision. The reason text names the layer (agent / tool / merchant
   * / principal / team / org), window, cap, and currency, so the
   * receipt records WHICH ceiling was binding under
   * most-restrictive-wins hierarchy evaluation. Roadmap v2 Phase 2
   * budget-hierarchy block (B-H1/B-H2).
   */
  BUDGET_CEILING_BINDING: "axiru.budget.ceiling_binding",
  /**
   * AI-CMO Phase 1 (added 2026-07-31): the `ad_platform` rail's
   * per-rail evaluator demoted a clean `allow` because no ENFORCING
   * policy explicitly allowed the ad_spend intent — `ad_spend` is
   * staged-by-default (every intent requires approval unless a policy
   * explicitly allows otherwise). A shadow-mode allow match or zero
   * matches both fall into this default; an enforcing policy whose
   * effect is `allow` bypasses it. See
   * `packages/decision-engine/src/per-rail-evaluators.ts` `adPlatformEvaluator`.
   */
  PENDING_AD_SPEND_STAGED_DEFAULT: "axiru.pending.ad_spend_staged_default",
  /**
   * AI-CMO Phase 1 (added 2026-07-31): attribution-only reason stamped
   * on EVERY decision the `ad_platform` rail produces (any action —
   * allow, require_approval, or deny). The rail has no settlement
   * executor: an ALLOW here authorizes a human to execute the action
   * manually in the ad platform's own console, it never moves money by
   * itself. Mirrors `DecisionV2.disposition === "manual_execution"`.
   */
  DISPOSITION_MANUAL_EXECUTION: "axiru.disposition.manual_execution"
} as const;

export type AxiruReasonCode = (typeof AXIRU_REASON_CODES)[keyof typeof AXIRU_REASON_CODES];

/** Reserved reason-code prefixes. Customer policies must avoid these. */
export const RESERVED_REASON_PREFIXES: readonly string[] = [
  "axiru.",
  "stripe.",
  "privy.",
  "tempo.",
  "ucp."
] as const;

export function isReservedReasonCode(code: string): boolean {
  return RESERVED_REASON_PREFIXES.some((p) => code.startsWith(p));
}
