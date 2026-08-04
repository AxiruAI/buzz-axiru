/**
 * Decision Engine v2 — internal type contracts.
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §5.
 *
 * Why these types live here (not in @axiru/agent-spend-guardrails (vendored types)):
 *
 *   @axiru/agent-spend-guardrails (vendored types) holds the WIRE-FORMAT contracts that cross the
 *   network boundary (OutboundValueTransfer, PolicyV2, AXIRU_REASON_CODES).
 *   Those types must stay stable across versions because they are
 *   serialized into audit ledger rows and JWS authorization claims.
 *
 *   @axiru/agent-spend-guardrails (vendored engine) — this package — holds the
 *   IMPLEMENTATION contracts that the evaluator itself consumes
 *   (Decision, EvalContext, RuleEvaluation). These can evolve more
 *   freely; they never cross the network and they never get persisted.
 *
 * Purity invariant: every type in this file is data-only. No method
 * fields, no closures, no Date.now()-style side-channels. Anything the
 * evaluator needs is passed in via EvalContext. See spec §5.1.
 */

import type {
  AxiruReasonCode,
  OutboundValueTransfer,
  PolicyEffectV2,
  PolicyRuleV2,
  PolicyV2,
  Rail
} from "../types/index.js";

/* ------------------------------------------------------------------ */
/* Decision — the engine's output                                     */
/* ------------------------------------------------------------------ */

/**
 * The final action surfaced to callers. Aligns with v1's
 * `DecisionAction` (`ALLOW | REQUIRE_APPROVAL | BLOCK`) so the existing
 * webhook dispatcher, audit ledger, and dashboard continue to render
 * v2 decisions without a UI change.
 *
 *   v1 → v2 mapping (used by LegacyV1Adapter in Wk 4):
 *     ALLOW            ↔ allow
 *     REQUIRE_APPROVAL ↔ require_approval
 *     BLOCK            ↔ deny
 */
export type DecisionActionV2 = "allow" | "require_approval" | "deny";

/**
 * Reason entry attached to a Decision. One entry per matched policy
 * (or one entry from the default-allow branch when nothing matched).
 * The `reason_code` field is what billing, the SOC 2 audit export, and
 * the `axiru.*` JWS claim consume; `reason_text` is for humans only.
 */
export interface DecisionReason {
  /** Stable code; reserved prefixes per @axiru/agent-spend-guardrails (vendored types) §5.3. */
  reason_code: string;
  /** Human-readable, surfaced in UI. */
  reason_text: string;
  /** Set iff this reason came from a matched policy. */
  policy_id?: string;
  /** Policy version that matched. Captured for Decision Replay. */
  policy_version?: number;
  /** Policy mode at time of evaluation. Drives the audit/enforcement split. */
  policy_mode?: PolicyV2["mode"];
}

/**
 * Decision — the immutable output of `evaluate()`.
 *
 * Persistence boundary: the caller writes (id, ovt_id, ovt_fingerprint,
 * org_id, action, reasons, matched_policy_ids, axiru_reason_code,
 * evaluated_at) into the EventDecision row added in Wk 2. The
 * authorization_token_jti column is populated later by the token
 * issuer (Wk 7), not by the engine.
 *
 * Stability: this shape is INTERNAL — see file header. The audit
 * ledger persists a projection of it, not the type itself, so we are
 * free to add fields here without a schema migration as long as the
 * projection logic in the webhook dispatcher continues to extract
 * (rail, action, reasons, fingerprint) verbatim.
 */
export interface DecisionV2 {
  /**
   * Stable id derived from the OVT fingerprint. Format: `dec_v2_<first-12-of-fingerprint>`.
   * NOT a ULID because the engine is pure — it cannot generate
   * monotonic ids. The caller may overwrite this with a ULID before
   * persisting if desired; the dec_v2_… form is sufficient for
   * test determinism and the Decision Replay equality check.
   */
  id: string;
  org_id: string;
  /** Discriminator copied from the OVT for fast indexing. */
  rail: Rail;
  /** Copied from the OVT for fast indexing on the EventDecision row. */
  rail_action: string;
  /**
   * Fingerprint copied from the OVT. The single value the audit
   * ledger keys on for Decision Replay. See spec §5.5.
   */
  ovt_fingerprint: string;
  /** Final adjudicated action after precedence + mode-resolution. */
  action: DecisionActionV2;
  /**
   * Ordered list of reasons. Position 0 is the WINNING reason (the
   * one that produced `action`). Subsequent entries are the other
   * matched policies retained for transparency and audit. Always
   * non-empty: when nothing matched, contains a single
   * `axiru.allow.default` entry.
   */
  reasons: DecisionReason[];
  /**
   * Ids of every PolicyV2 that matched. Order is the precedence
   * order, NOT input order, so a Decision Replay can recreate the
   * winning policy by looking at index 0.
   */
  matched_policy_ids: string[];
  /**
   * The single `axiru.*` reason code that summarizes the decision.
   * This is what billing, alerting, and the JWS authorization claim
   * read. Always populated, even when a customer policy is the
   * proximate cause (we map their effect.kind to the matching
   * axiru.* family member).
   */
  axiru_reason_code: AxiruReasonCode | string;
  /**
   * The effective time the evaluator considered the OVT. Always
   * `context.now` — captured here so Decision Replay can re-run the
   * engine with the same wall-clock and reproduce the result
   * bit-for-bit.
   */
  evaluated_at: Date;
  /**
   * If a matched policy carried `effect.max_authorized_amount`, that
   * value is copied here so the downstream token issuer (Wk 7) can
   * stamp it into the JWS without re-traversing the policy set.
   */
  max_authorized_amount?: { currency: string; minor_units: string };
  /**
   * Authorization-token TTL clamp, propagated from the winning
   * effect when set. Capped at 300s by the engine per spec §6.2.
   */
  authorization_ttl_seconds?: number;
  /**
   * AI-CMO Phase 1 (added 2026-07-31). Set by rails that have no
   * settlement executor: an `allow` (or any other action) does not
   * move money by itself, it authorizes a HUMAN to execute the action
   * in the underlying platform's own console. Today only the
   * `ad_platform` rail sets this (always `"manual_execution"`, on
   * every action). Additive optional field — safe to persist as a
   * projection of the existing Decision shape, no schema change
   * required (see file header "Stability" note).
   */
  disposition?: "manual_execution";
}

/* ------------------------------------------------------------------ */
/* EvalContext — the only impure inputs the evaluator may see         */
/* ------------------------------------------------------------------ */

/**
 * Foreign-exchange resolver. Pure and deterministic per spec §5.1.
 * The engine never reaches out for live rates — the caller injects a
 * snapshot keyed on `(from_currency, to_currency, day)` so Decision
 * Replay against historical OVTs is reproducible.
 *
 * Returns the multiplier such that
 * `amount_in_to = amount_in_from * multiplier`. NaN/Infinity are
 * rejected by the AmountRule evaluator with a typed error so a bad
 * rate-table never silently produces a wrong decision.
 */
export type FxResolver = (from_currency: string, to_currency: string, at: Date) => number;

/**
 * The bundle of impure values the evaluator is allowed to depend on.
 * Everything else (the OVT, the policy set, customer config) MUST be
 * passed positionally to `evaluate()`. Nothing else is in scope.
 *
 * Why a context object instead of arguments? It is the difference
 * between "this function might call Date.now() somewhere deep inside"
 * and "this function's full set of impure inputs are listed on its
 * signature". The latter is what the ESLint purity guard checks
 * mechanically.
 */
export interface EvalContext {
  /**
   * The wall-clock the evaluator treats as "now" for all time-based
   * rules (TimeOfDayRule, RollingWindowRule freshness checks). The
   * call site SHOULD pass `new Date()`; tests pass a fixed Date so
   * results are stable.
   */
  now: Date;
  /**
   * Cross-currency comparison resolver. Required for AmountRule with
   * `fx_base` set; absent rules with no `fx_base` ignore this.
   */
  fx?: FxResolver;
}

/* ------------------------------------------------------------------ */
/* Internal evaluator return shapes                                   */
/* ------------------------------------------------------------------ */

/**
 * A single rule's match result. The full evaluator composes these into
 * a policy-level match by AND-ing every rule's `matched` field.
 */
export interface RuleEvaluation {
  matched: boolean;
  /**
   * Set when the evaluator could not complete (e.g. AmountRule with
   * an FX lookup that returned NaN). A non-null `error` always
   * implies `matched === false`; the policy as a whole is treated as
   * non-matching and the error is recorded on the Decision as a
   * `axiru.deny.expression_timeout` family reason.
   */
  error?: string;
}

/**
 * A policy that fully matched the OVT, paired with its effect.
 * Internal type used by the precedence ladder.
 */
export interface MatchedPolicy {
  policy: PolicyV2;
  effect: PolicyEffectV2;
}

/* ------------------------------------------------------------------ */
/* Per-rail evaluator interface                                       */
/* ------------------------------------------------------------------ */

/**
 * One evaluator per rail. The dispatcher in `decision-engine.ts`
 * selects the right one based on `ovt.rail`.
 *
 * Why per-rail evaluators instead of a single switch? Each rail has
 * subtle conventions that don't generalize:
 *   - Stripe needs the legacy v1 reason-code prefix `stripe.*`.
 *   - StripeDAA must additionally check the asset+chain allowlist
 *     because not every (asset, chain) pair has a settlement path.
 *   - x402 maps facilitator URLs into `axiru.deny.unknown_rail` when
 *     unrecognized.
 *
 * Each rail's evaluator returns the v2 Decision; the shared
 * dispatcher just plumbs the policy match results in.
 *
 * Phase 2 rails (ucp, tempo, …) intentionally have no evaluator;
 * `evaluate()` short-circuits to `axiru.deny.unknown_rail` for them.
 */
export interface RailEvaluator<R extends Rail = Rail> {
  rail: R;
  /**
   * Compose the matched-policy precedence ladder into a Decision.
   * Pure function — receives the OVT, the matched policies, and the
   * full policy set (some rails want to attribute "no policy matched"
   * with the count of policies considered). May NOT do I/O.
   */
  buildDecision(input: {
    ovt: OutboundValueTransfer & { rail: R };
    matched: MatchedPolicy[];
    /** Every policy in scope, matched or not. */
    considered: PolicyV2[];
    context: EvalContext;
  }): DecisionV2;
}

/* ------------------------------------------------------------------ */
/* Public evaluate() signature                                        */
/* ------------------------------------------------------------------ */

export interface EvaluateInput {
  ovt: OutboundValueTransfer;
  /**
   * Every PolicyV2 in scope for this org. The engine applies its own
   * filter (rail, action, mode=disabled) — the caller does not need
   * to pre-filter, but is welcome to.
   */
  policies: PolicyV2[];
  context: EvalContext;
}

/**
 * Re-export so callers don't have to import @axiru/agent-spend-guardrails (vendored types) for
 * the rule discriminator separately.
 */
export type { PolicyRuleV2 };
