/**
 * buzz-axiru: bounded spend authority for Buzz agents.
 *
 * Programmatic entry points, for embedding the bridge in your own
 * tooling. The CLI (src/cli.ts) is the usual way to run it.
 *
 * Licensed under the Apache License, Version 2.0.
 */

export { Bridge, type SpendDecision, type SpendRequest } from "./guard.js";
export {
  loadConfig,
  policiesForAgent,
  isPlausiblePubkey,
  matchesPattern,
  isGatedTool,
  mappingForTool,
  extractPayment,
  getPath,
  type BridgeConfig,
  type BridgeControls,
  type DownstreamConfig,
  type PaymentToolsConfig,
  type ToolMapping,
  type ExtractionResult
} from "./config.js";
export { GateServer, type GateOptions } from "./gate.js";
export { DownstreamClient, DownstreamError, type DownstreamTool } from "./downstream.js";
export {
  Ledger,
  verifyLedger,
  historyForAgent,
  hashRecord,
  GENESIS_HASH,
  type LedgerRecord,
  type VerifyResult
} from "./ledger.js";
export {
  ApprovalStore,
  approvalIdForFingerprint,
  isExpired,
  type ApprovalRequest,
  type ParkedCall
} from "./approvals.js";
export { STARTER_POLICIES } from "./scaffold.js";
export { McpServer, TOOL_DEFINITION, TOOL_NAME } from "./mcp.js";
export { formatAmount } from "./notify.js";
