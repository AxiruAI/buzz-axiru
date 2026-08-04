/**
 * @axiru/agent-spend-guardrails (vendored types)
 *
 * Cross-rail governance type system (Phase 1).
 *
 * This package is the single source of truth for the `OutboundValueTransfer`
 * discriminated union, the v2 policy schema, and the supporting `Money`,
 * `Initiator`, `Counterparty`, and `PolicyInputs` types.
 *
 * Importers MUST treat every export here as the wire-format contract.
 * Any change here that is not strictly additive is a breaking change
 * across the entire monorepo and across published packages.
 *
 * See: CROSS_RAIL_AUDIT.md, CROSS_RAIL_PROJECT_PLAN.md, spec v1.0 §4.
 */

export * from "./outbound-value-transfer.js";
export * from "./policy-v2.js";
export * from "./rail.js";
export * from "./x402-evidence.js";
