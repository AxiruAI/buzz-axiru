/**
 * Rail enum — a stable identifier for the payment/value-transfer rail
 * a given OutboundValueTransfer originated on.
 *
 * Phase 1 in-scope rails: `stripe`, `stripe_daa`, `x402`, and (since
 * 2026-07-03, roadmap v2 Track A Phase 1) `usdc_solana`.
 * Phase 2 placeholders (no adapter yet, but the type space is reserved
 * so customers and policies can be authored against them today):
 *   `mpp`, `ucp`, `tempo`, `usdc_base`, `pyusd`,
 *   `plaid_ach`, `modern_treasury`, `dwolla`, `square`.
 *
 * `ad_platform` (added AI-CMO Phase 1, 2026-07-31 — Axiru's own
 * dogfood governance build): a GOVERNANCE-ONLY rail. Ad spend
 * (Google Ads / LinkedIn Ads campaign create / budget update / pause /
 * resume) is proposed by an agent, evaluated by this same
 * cross-rail engine and the budget hierarchy (B-H1/B-H2), and staged
 * for human approval — but there is NO settlement executor and NO
 * payment credentials anywhere in this rail. Every decision this rail
 * produces carries `disposition: "manual_execution"`: Marcos (or
 * whichever human owns the ad account) executes any approved action
 * by hand in the ad platform's own console. This is a strict,
 * non-negotiable Phase 1 boundary — do not wire up automatic spend
 * execution for this rail.
 *
 * This enum is intentionally a string literal union (not a TypeScript
 * `enum`) so that:
 *   1. Adapters can declare their rail at the type level without runtime
 *      enum members polluting the bundle.
 *   2. The discriminator field on OutboundValueTransfer is a simple string,
 *      which serializes cleanly to JSON for the audit ledger and JWS
 *      claims.
 *   3. Exhaustiveness checks via `never` work without ceremony.
 *
 * IMPORTANT — relationship to the legacy `PaymentProvider` type in
 * `packages/adapters/src/provider-abstraction.ts`:
 *   The two enums are intentionally parallel during Phase 1. The legacy
 *   enum stays the source of truth for the Stripe-typed evaluator
 *   (`the hosted platform domain package` `evaluateRefundEvent` etc.). The `Rail`
 *   enum is the source of truth for the rail-agnostic evaluator
 *   (`@axiru/agent-spend-guardrails (vendored engine)` — Phase 1 Wk 3+).
 *
 *   Do NOT widen `PaymentProvider` to include the new values. Doing so
 *   would force exhaustive switches in dozens of legacy files. See
 *   CROSS_RAIL_AUDIT.md → "Risks discovered during audit".
 */
export type Rail =
  | "stripe"
  | "stripe_daa"
  | "x402"
  | "mpp"
  | "ucp"
  | "tempo"
  | "usdc_base"
  | "usdc_solana"
  | "pyusd"
  | "plaid_ach"
  | "modern_treasury"
  | "dwolla"
  | "square"
  | "ad_platform";

/**
 * The set of rails that have a fully-implemented adapter and are eligible
 * for `enforcing` mode in Phase 1. Useful at the API boundary to reject
 * policies that target a rail with no adapter yet.
 */
export const PHASE_1_ACTIVE_RAILS: readonly Rail[] = [
  "stripe",
  "stripe_daa",
  "x402",
  // Activated 2026-07-03 (roadmap v2 Track A Phase 1 — stablecoin
  // rail). Evaluator registered in @axiru/agent-spend-guardrails (vendored engine)
  // PHASE_1_EVALUATORS; keep the two registries in lockstep.
  "usdc_solana",
  // Activated 2026-07-31 (AI-CMO Phase 1 — Axiru's own dogfood
  // governance build). "Active" here means the Decision Engine has a
  // real evaluator for it (policies + the budget hierarchy actually
  // adjudicate ad-spend intents), NOT that money moves automatically —
  // there is no settlement executor for this rail in Phase 1. See the
  // `ad_platform` doc comment on the Rail union above.
  "ad_platform"
] as const;

/**
 * The set of rails that exist in the type system but have no adapter
 * yet. Policies targeting these rails are allowed to be saved (so
 * customers can prepare ahead of GA), but the Decision Engine will
 * return `axiru.deny.unknown_rail` if it sees an event for one of
 * these rails.
 */
export const PHASE_2_RESERVED_RAILS: readonly Rail[] = [
  // Reserved 2026-07-09 (Track B Epic A, agent-controls plan v1.1 §3.1).
  // MPP is x402-backwards-compatible; the Phase 1 agent-payments demo
  // path rides the ACTIVE `x402` rail. `mpp` activates alongside the
  // unified x402+MPP adapter (Epic B) — until then the Decision Engine
  // fails closed with `axiru.deny.unknown_rail` for mpp events.
  "mpp",
  "ucp",
  "tempo",
  "usdc_base",
  "pyusd",
  "plaid_ach",
  "modern_treasury",
  "dwolla",
  "square"
] as const;

export function isPhase1ActiveRail(rail: Rail): boolean {
  return PHASE_1_ACTIVE_RAILS.includes(rail);
}

/**
 * Exhaustiveness helper. Use in switch statements over OutboundValueTransfer.rail
 * to force a compile error if a new rail is added without handling it.
 */
export function assertUnreachableRail(rail: never): never {
  throw new Error(`Unhandled rail in switch: ${String(rail)}`);
}
