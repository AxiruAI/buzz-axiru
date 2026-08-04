/**
 * OutboundValueTransfer ("OVT") — the rail-agnostic outbound value
 * transfer type that the Decision Engine v2 evaluates against.
 *
 * Every rail adapter normalizes its raw events into instances of this
 * discriminated union (keyed on the `rail` field). The Decision Engine
 * then operates on this single type — never on rail-specific events.
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §4.1.
 *
 * Stability guarantee: this file defines a wire-format contract used
 * for the audit ledger (`ovt_fingerprint` is computed over a canonical
 * JSON serialization of an OVT). Any non-additive change to a field
 * here invalidates historical fingerprints and breaks Decision Replay.
 * If you need to change shape, add a new optional field; do not rename
 * or retype existing ones.
 */

import type { Rail } from "./rail.js";

/* ------------------------------------------------------------------ */
/* Common supporting types                                            */
/* ------------------------------------------------------------------ */

/**
 * A monetary amount. Always represented in the smallest indivisible
 * unit of the currency or token (e.g. cents for USD, base units for
 * USDC/PYUSD). NEVER use floating point for monetary math.
 *
 * `minor_units` is a bigint to safely accommodate large stablecoin
 * transfers (USDC base unit is 1e-6, so a $1M USDC transfer is
 * 1_000_000_000_000n).
 */
export interface Money {
  /**
   * ISO 4217 for fiat (`USD`, `EUR`), or the token symbol for
   * stablecoins (`USDC`, `PYUSD`). Uppercase canonical.
   */
  currency: string;
  /** Smallest indivisible unit. NEVER a float. */
  minor_units: bigint;
}

/**
 * Who initiated the action. The `kind` discriminator drives policy
 * rules like "block agent-initiated refunds > $X" or "require approval
 * on any automation-initiated transfer".
 */
export interface Initiator {
  kind: "human" | "agent" | "automation";
  /**
   * Stable identifier scoped to `org_id`.
   *   - human: Clerk user id
   *   - agent: Axiru agent_id (foundation for Phase 4 IDiru binding)
   *   - automation: workflow id
   */
  id: string;
  /** Present iff kind === "agent". */
  agent_metadata?: AgentMetadata;
}

export interface AgentMetadata {
  /** e.g. "claude-sonnet-4-6", "gpt-5.5", "gemini-3.1-pro" */
  model: string;
  version: string;
  /**
   * Comma-separated scope tokens granted to the agent by the customer.
   * Phase 4 IDiru integration will replace this with a structured
   * scope claim; the comma-separated form is the Phase 1 wire format.
   */
  scope: string;
  /** Set only when agent has been verified by IDiru (Phase 4). */
  idiru_verification_id?: string;
}

export interface Counterparty {
  kind: "customer" | "merchant" | "wallet_address" | "connect_account" | "unknown";
  id: string;
  display?: {
    name?: string;
    /** ISO-3166-1 alpha-2 */
    country_code?: string;
  };
}

/**
 * Rolling-window aggregates computed by the adapter at intake.
 *
 * These are DENORMALIZED onto the OVT so the Decision Engine can
 * evaluate `RollingWindowRule` without performing I/O. axiru's
 * lesson learned: any evaluator that has to reach into the database
 * mid-evaluation breaks the purity invariant and the Decision Replay
 * guarantee. See spec §5.5.
 */
export interface PolicyInputs {
  /** Sum of minor_units across this org's OVTs in the last 30 days. */
  amount_30d: bigint;
  /** Sum of minor_units across this org's OVTs in the last 24 hours. */
  amount_24h: bigint;
  /** Count of this org's OVTs in the last 30 days. */
  count_30d: number;
  /** Count of this org's OVTs in the last 24 hours. */
  count_24h: number;
  /**
   * Free-form risk-signal bag populated by enrichment adapters if any
   * are wired. Schema is intentionally open — policies that consume
   * these inputs name the key explicitly.
   */
  enrichment?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Agent-initiated payment extension (Track B Epic A)                 */
/* ------------------------------------------------------------------ */

/**
 * Who the paying agent IS, in whichever identity scheme the rail or
 * platform surfaced. Spec: agent-controls strategic plan v1.1 §3.1.
 *
 *   - `did`: W3C decentralized identifier (Phase 4 IDiru binding path).
 *   - `tap_header`: Visa TAP agent header value.
 *   - `api_key_fingerprint`: SHA-256 fingerprint of the API key the
 *     agent authenticated with (never the key itself).
 *   - `model_platform`: model+platform tuple when no stronger identity
 *     exists; populate `model` and `platform` alongside `value`.
 */
export interface AgentIdentity {
  kind: "did" | "tap_header" | "api_key_fingerprint" | "model_platform";
  /** The identity value in the scheme named by `kind`. */
  value: string;
  /** e.g. "claude-sonnet-4-6". Expected when kind === "model_platform". */
  model?: string;
  /** e.g. "anthropic", "openai". Expected when kind === "model_platform". */
  platform?: string;
}

/**
 * The human or org the agent acts FOR. Drives principal-scoped budget
 * rules and the per-principal audit export (Epic C).
 */
export interface PrincipalIdentity {
  kind: "user" | "org";
  /** Clerk user id (kind "user") or Axiru org id (kind "org"). */
  id: string;
}

/**
 * MPP session-intent parameters captured at intake.
 *
 * FIELDS ONLY IN PHASE 1 — per the plan v1.1 DECISION block
 * (2026-07-09), session-intent ENFORCEMENT is gated to Phase 2 (or an
 * early Epic B landing). The Decision Engine records these fields but
 * does not evaluate them yet. Amounts are decimal bigint strings
 * (JSON cannot carry bigint).
 */
export interface SessionIntent {
  /** Hard cap on total spend across the session channel. Decimal string, minor units. */
  max_session_spend_minor_units: string;
  /** Max vouchers the session may emit per minute. */
  voucher_velocity_per_min?: number;
  /** Auto-close the session once cumulative spend reaches this. Decimal string, minor units. */
  auto_close_threshold_minor_units?: string;
  /** Expire the session after this many seconds without a voucher. */
  idle_expiry_seconds?: number;
}

/**
 * The agent-payment extension block (plan v1.1 §3.1).
 *
 * DESIGN DECISION — extension field, not a new union variant:
 * the OutboundValueTransfer union discriminates on `rail`, and an
 * AgentInitiatedPayment in Phase 1 rides the ACTIVE `x402` rail. Adding
 * a second union member with `rail: "x402"` would (a) make
 * `OVTByRail<"x402">` a two-member union, (b) invalidate the
 * `isX402OVT` guard's narrowing, and (c) force every rail-keyed
 * exhaustive switch in the monorepo to grow non-rail handling. Instead,
 * the x402 variant (and the reserved mpp variant, which will carry
 * agent payments once its adapter lands) gains ONE optional
 * `agent_payment` field — strictly additive per this file's stability
 * guarantee, so historical `ovt_fingerprint`s and every existing
 * exhaustive switch stay valid. `AgentInitiatedPayment` below is the
 * refinement type where the block is required.
 */
export interface AgentPaymentExtension {
  agent_identity: AgentIdentity;
  principal_identity: PrincipalIdentity;
  /** AP2-style signed mandate or Axiru-native delegation token reference. */
  mandate_ref?: string;
  /** MCP tool / ACP merchant / x402 endpoint being paid, e.g. "mcp:widgets.example/buy". */
  tool_ref?: string;
  /** SHA-256 hash of the task/prompt context that triggered the spend. */
  intent_hash?: string;
  /** Conversation/run identifier for evidence linkage. */
  session_ref?: string;
  /** MPP session channel parameters. Fields only in Phase 1 — see {@link SessionIntent}. */
  session_intent?: SessionIntent;
}

/* ------------------------------------------------------------------ */
/* Base OVT — fields every variant carries                            */
/* ------------------------------------------------------------------ */

interface BaseOVT {
  /** ULID; primary key on the decision and ledger tables. */
  id: string;
  /** Tenant isolation. Every query filters on this. */
  org_id: string;
  /** Idempotency key from the rail (when available) or computed by the adapter. */
  idempotency_key: string;
  amount: Money;
  initiator: Initiator;
  counterparty: Counterparty;
  /** Time the rail event was generated (rail-provided when possible). */
  rail_event_at: Date;
  /** Time Axiru ingested the event. */
  ingested_at: Date;
  /**
   * SHA-256 fingerprint over canonical-JSON of
   * (rail, rail_action, amount, initiator, counterparty, context).
   * Used as the binding claim in the authorization token. Computed by
   * `@axiru/shared/canonical-fingerprint`.
   */
  fingerprint: string;
  /** Rolling-window aggregates the evaluator may reference. */
  policy_inputs: PolicyInputs;
}

/* ------------------------------------------------------------------ */
/* Per-rail OVT variants                                              */
/* ------------------------------------------------------------------ */

export interface StripeOVT extends BaseOVT {
  rail: "stripe";
  rail_action:
    | "refund"
    | "payout"
    | "transfer"
    | "application_fee_refund"
    | "credit_note"
    | "dispute_decision"
    | "goodwill_credit";
  context: {
    stripe_account_id: string;
    charge_id?: string;
    payment_intent_id?: string;
    balance_transaction_id?: string;
    api_version: string;
  };
}

export interface StripeDAAOVT extends BaseOVT {
  rail: "stripe_daa";
  rail_action: "transfer" | "payout" | "refund";
  context: {
    stripe_account_id: string;
    digital_asset_account_id: string;
    /** Asset symbol: "USDC", "PYUSD", or other token symbols Stripe DAA supports. */
    asset: "USDC" | "PYUSD" | string;
    /** Chain identifier: "ethereum", "base", "solana", etc. */
    chain: "ethereum" | "base" | "solana" | string;
    api_version: string;
  };
}

export interface X402OVT extends BaseOVT {
  rail: "x402";
  rail_action: "pay";
  context: {
    facilitator_url: string;
    resource_url: string;
    asset: string;
    chain: string;
    /** Present when initiated via a Stripe-integrated x402 flow. */
    stripe_account_id?: string;
  };
  /**
   * Present when the x402 payment is agent-initiated (Track B Epic A).
   * Populated by the x402+MPP adapter (Epic B); absent on legacy /
   * non-agent x402 events. See {@link AgentPaymentExtension} for why
   * this is an optional extension field rather than a union variant.
   */
  agent_payment?: AgentPaymentExtension;
}

/**
 * MPP (Merchant Payment Protocol, Stripe+Tempo, Mar 2026) — Phase 2
 * RESERVED rail (no adapter yet; the engine denies mpp events with
 * `axiru.deny.unknown_rail`). The type space is reserved so policies
 * can be authored against it today. MPP is x402-backwards-compatible:
 * exact-payment flows map onto charge intents; session intents are the
 * streaming-channel primitive governed via `agent_payment.session_intent`.
 */
export interface MPPOVT extends BaseOVT {
  rail: "mpp";
  rail_action: "charge" | "session_open" | "session_voucher" | "session_close";
  context: {
    mpp_version: string;
    resource_url: string;
    asset: string;
    chain: string;
    /** Present for session-intent actions. */
    session_id?: string;
  };
  /** MPP payments are agent-initiated by construction; the adapter populates this. */
  agent_payment?: AgentPaymentExtension;
}

export interface UCPOVT extends BaseOVT {
  rail: "ucp";
  rail_action: "checkout" | "refund" | "authorization";
  context: {
    ucp_version: string;
    merchant_id: string;
    cart_fingerprint: string;
  };
}

export interface TempoOVT extends BaseOVT {
  rail: "tempo";
  rail_action: "transfer" | "streaming_segment";
  context: {
    tempo_account_id: string;
    asset: string;
    /** Present only for streaming segments. */
    stream_id?: string;
    segment_index?: number;
  };
}

export interface USDCBaseOVT extends BaseOVT {
  rail: "usdc_base";
  rail_action: "transfer";
  context: { chain: "base"; from_address: string; to_address: string };
}

export interface USDCSolanaOVT extends BaseOVT {
  rail: "usdc_solana";
  rail_action: "transfer";
  context: { chain: "solana"; from_address: string; to_address: string };
}

export interface PYUSDOVT extends BaseOVT {
  rail: "pyusd";
  rail_action: "transfer";
  context: { chain: string; from_address: string; to_address: string };
}

export interface PlaidACHOVT extends BaseOVT {
  rail: "plaid_ach";
  rail_action: "transfer";
  context: { plaid_account_id: string; destination_account: string };
}

export interface ModernTreasuryOVT extends BaseOVT {
  rail: "modern_treasury";
  rail_action: "payment_order";
  context: { payment_order_id: string; payment_type: string };
}

export interface DwollaOVT extends BaseOVT {
  rail: "dwolla";
  rail_action: "transfer";
  context: { transfer_id: string };
}

export interface SquareOVT extends BaseOVT {
  rail: "square";
  rail_action: "refund" | "payout";
  context: { square_location_id: string };
}

/**
 * `ad_platform` — the AI-CMO Phase 1 governance-only rail (added
 * 2026-07-31). An agent proposes a Google/LinkedIn ad-spend action;
 * this OVT is what the Decision Engine and the budget hierarchy
 * (B-H1 org cap / B-H2 team cap / per-agent cap) evaluate. There is NO
 * settlement executor for this rail in Phase 1 — see the `Rail` union
 * doc comment in `rail.ts`. `amount.minor_units` carries
 * `total_cap_minor_units` (the maximum financial exposure of the
 * proposed action, the conservative figure for budget-ceiling
 * comparison); `context.daily_budget_minor_units` carries the
 * finer-grained daily pace.
 */
export interface AdPlatformOVT extends BaseOVT {
  rail: "ad_platform";
  rail_action: "create_campaign" | "update_daily_budget" | "pause_campaign" | "resume_campaign";
  context: {
    platform: "google_ads" | "linkedin_ads";
    campaign_ref: string;
    /** Decimal string, minor units — mirrors amount.minor_units precision. */
    daily_budget_minor_units: string;
    /** Decimal string, minor units. Equal to amount.minor_units. */
    total_cap_minor_units: string;
    duration_days: number;
    creative_ref?: string;
    rationale: string;
  };
  /**
   * Ad-spend intents are agent-proposed by construction in the Phase 1
   * dogfood build (the CMO agent). Populated the same way the x402
   * agent-payment extension is: see {@link AgentPaymentExtension}.
   */
  agent_payment?: AgentPaymentExtension;
}

/* ------------------------------------------------------------------ */
/* The union                                                          */
/* ------------------------------------------------------------------ */

/**
 * The central type of the cross-rail engine. Every adapter produces
 * an instance; every policy is evaluated against an instance.
 *
 * Discriminator field: `rail`. Use exhaustive switches with
 * `assertUnreachableRail` to catch missing handlers at compile time.
 */
export type OutboundValueTransfer =
  | StripeOVT
  | StripeDAAOVT
  | X402OVT
  | MPPOVT
  | UCPOVT
  | TempoOVT
  | USDCBaseOVT
  | USDCSolanaOVT
  | PYUSDOVT
  | PlaidACHOVT
  | ModernTreasuryOVT
  | DwollaOVT
  | SquareOVT
  | AdPlatformOVT;

/**
 * Type-narrow helper: given a Rail discriminator, get the matching OVT variant.
 *
 * Usage:
 *   function handle(ovt: OVTByRail<"stripe_daa">) { ovt.context.asset; }
 */
export type OVTByRail<R extends Rail> = Extract<OutboundValueTransfer, { rail: R }>;

/* ------------------------------------------------------------------ */
/* Runtime guards (cheap; intentionally not Zod — keep package zero-dep) */
/* ------------------------------------------------------------------ */

export function isOutboundValueTransfer(value: unknown): value is OutboundValueTransfer {
  if (!value || typeof value !== "object") return false;
  const ovt = value as Partial<OutboundValueTransfer>;
  return (
    typeof ovt.id === "string" &&
    typeof ovt.org_id === "string" &&
    typeof ovt.idempotency_key === "string" &&
    typeof ovt.rail === "string" &&
    typeof ovt.rail_action === "string" &&
    typeof ovt.fingerprint === "string" &&
    ovt.amount !== undefined &&
    typeof (ovt.amount as Money).currency === "string" &&
    typeof (ovt.amount as Money).minor_units === "bigint" &&
    ovt.initiator !== undefined &&
    ovt.counterparty !== undefined &&
    ovt.policy_inputs !== undefined
  );
}

export function isStripeOVT(ovt: OutboundValueTransfer): ovt is StripeOVT {
  return ovt.rail === "stripe";
}
export function isStripeDAAOVT(ovt: OutboundValueTransfer): ovt is StripeDAAOVT {
  return ovt.rail === "stripe_daa";
}
export function isX402OVT(ovt: OutboundValueTransfer): ovt is X402OVT {
  return ovt.rail === "x402";
}
export function isMPPOVT(ovt: OutboundValueTransfer): ovt is MPPOVT {
  return ovt.rail === "mpp";
}
export function isAdPlatformOVT(ovt: OutboundValueTransfer): ovt is AdPlatformOVT {
  return ovt.rail === "ad_platform";
}

/* ------------------------------------------------------------------ */
/* AgentInitiatedPayment (Track B Epic A, plan v1.1 §3.1)             */
/* ------------------------------------------------------------------ */

/**
 * An OVT that carries the agent-payment extension block. Phase 1 scope
 * is the x402 rail (the mpp variant joins when its adapter activates
 * the rail). This is a REFINEMENT of X402OVT — not a separate union
 * member — so `ovt.rail === "x402"` switches keep compiling unchanged
 * and `OVTByRail<"x402">` stays a single type. See the design note on
 * {@link AgentPaymentExtension}.
 */
export type AgentInitiatedPayment = X402OVT & { agent_payment: AgentPaymentExtension };

/**
 * Narrow to an agent-initiated payment: an x402 OVT carrying the
 * required `agent_payment` block. Rails without the extension field
 * (stripe, stripe_daa, …) always return false.
 */
export function isAgentInitiatedPayment(
  ovt: OutboundValueTransfer
): ovt is AgentInitiatedPayment {
  return ovt.rail === "x402" && ovt.agent_payment !== undefined;
}

/**
 * Read the agent-payment extension off any OVT variant that can carry
 * it (`x402` today, `mpp` when it activates). Returns undefined for
 * every other rail — convenient for rule evaluators that must not
 * special-case rails.
 */
export function agentPaymentOf(ovt: OutboundValueTransfer): AgentPaymentExtension | undefined {
  return ovt.rail === "x402" || ovt.rail === "mpp" || ovt.rail === "ad_platform"
    ? ovt.agent_payment
    : undefined;
}
