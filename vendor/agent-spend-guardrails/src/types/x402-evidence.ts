/**
 * x402 Signed Offers & Receipts — canonical evidence objects.
 *
 * These types are the wire-format contract for Coinbase's documented
 * x402 "Signed Offers and Receipts" extension (the optional extension
 * merged into the `coinbase/x402` reference repo, exposed at
 * https://docs.x402.org/extensions/offer-receipt).
 *
 * Axiru ingests these as the canonical evidence object that binds a
 * pre-authorization decision (issued before an agent's on-chain
 * transfer) to the eventual settlement proof. The pre-auth decision
 * records an OVT fingerprint; the SignedOffer is captured at pre-auth
 * time; the SignedReceipt is captured at settlement; the three together
 * form a cryptographically-verifiable audit chain that a third party
 * can replay without contacting Axiru.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Stability guarantee
 * ───────────────────────────────────────────────────────────────────────
 * Field names and shapes here mirror the upstream x402 extension verbatim
 * because the bytes we accept off the wire are the bytes the upstream
 * signer produced; renaming a field would silently break signature
 * verification. If x402 adds new optional fields we add them as
 * `?: T | undefined` here; we do NOT shadow them with our own names.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Why we model both JWS and EIP-712 paths
 * ───────────────────────────────────────────────────────────────────────
 * The x402 extension supports two signature formats — JWS (`did:web`,
 * arbitrary asymmetric key) and EIP-712 (`did:pkh`, secp256k1 wallet).
 * Both are valid wire encodings of the same logical payload. The
 * verifier resolves either to the same `OfferPayload` / `ReceiptPayload`
 * shape so the Decision Engine consumes one canonical form.
 */

/* ------------------------------------------------------------------ */
/* Payload shapes (the underlying object that gets signed)            */
/* ------------------------------------------------------------------ */

/**
 * Field-for-field mirror of the upstream `Offer` payload (x402 spec
 * §"Signed Offers & Receipts" / Offer Payload Fields table).
 *
 * Returned inside the `402 Payment Required` body by an x402 resource
 * server when the operator has the optional offer-receipt extension
 * enabled. Field semantics are the same as a plain x402 `PaymentRequirements`
 * — the extension just wraps it with a signature.
 */
export interface OfferPayload {
  /** The URL the client is requesting. */
  resourceUrl: string;
  /**
   * Payment scheme. The reference extension supports `"exact"` today;
   * upstream may add more schemes (e.g. `"upTo"`).
   *
   * We type as `string` (not a closed union) because the wire format
   * is forward-compatible and we want unknown schemes to fail
   * verification cleanly rather than fail to deserialize.
   */
  offerType: string;
  /**
   * CAIP-2 chain identifier, e.g. `"eip155:84532"` (Base Sepolia) or
   * `"eip155:8453"` (Base mainnet). The verifier MUST treat this as
   * opaque — it is part of the signed payload and therefore part of
   * the binding claim, but we do not parse the chain id ourselves.
   */
  network: string;
  /** Smallest-unit amount. String over the wire to preserve bigint precision. */
  amount: string;
  /** Server's payment address (0x-prefixed hex for EVM chains). */
  payTo: string;
  /** Unix-seconds timestamp after which the offer expires. */
  validUntil: number;
}

/**
 * Field-for-field mirror of the upstream `Receipt` payload (x402 spec
 * Receipt Payload Fields table).
 *
 * Returned inside the `200 OK` response body once the facilitator has
 * settled the on-chain payment. The receipt is signed by the same
 * `did:web` or `did:pkh` identity that signed the offer — the verifier
 * MUST check the signer matches before treating the receipt as evidence.
 */
export interface ReceiptPayload {
  /** The URL the client requested. MUST equal the matching offer's `resourceUrl`. */
  resourceUrl: string;
  /** The client's wallet address (the payer recovered from the on-chain payment). */
  payer: string;
  /** Network on which payment was made. MUST equal the matching offer's `network`. */
  network: string;
  /** Unix-seconds timestamp when the receipt was issued by the resource server. */
  issuedAt: number;
  /**
   * On-chain transaction hash. OPTIONAL — only present when the
   * resource server was configured with `includeTxHash: true`.
   *
   * When present, this is the only field that crosses Axiru's
   * audit boundary into the on-chain world; downstream forensic
   * tooling can use it to fetch the actual transfer from the chain.
   */
  txHash?: string;
}

/* ------------------------------------------------------------------ */
/* Wire formats — JWS                                                 */
/* ------------------------------------------------------------------ */

/**
 * Supported JWS algorithms for the x402 extension. The verifier
 * intentionally accepts the same superset as the reference signer:
 * ES256 (P-256), EdDSA (Ed25519), ES256K (secp256k1).
 *
 * `none` and HMAC algorithms are NEVER accepted — they would allow
 * unauthenticated parties to forge offers/receipts.
 */
export type X402JwsAlgorithm = "ES256" | "EdDSA" | "ES256K";

/**
 * The minimal JOSE header shape we type. We extract only what the
 * verifier needs; unknown fields are preserved verbatim by the
 * verifier so a future extension can opt in to additional metadata
 * without code change here.
 *
 * `kid` is `did:web:<host>#<key-id>` — the DID URL pointing at the
 * key in the issuer's `/.well-known/did.json` document.
 */
export interface X402JwsHeader {
  alg: X402JwsAlgorithm;
  kid: string;
  /** Always `"JWT"` per the upstream reference signer. */
  typ?: "JWT";
}

/**
 * A signed offer in JWS compact serialization (`header.payload.signature`,
 * each segment base64url-encoded).
 *
 * Carried inside the `signedOffers` array of the x402 `402 Payment
 * Required` response body when the offer-receipt extension is active.
 */
export interface JwsSignedOffer {
  format: "jws";
  /** Compact JWS string. Verifier MUST split on `.` and base64url-decode. */
  jws: string;
}

/**
 * A signed receipt in JWS compact serialization. Carried inside the
 * `signedReceipt` field of the x402 `200 OK` response body.
 */
export interface JwsSignedReceipt {
  format: "jws";
  jws: string;
}

/* ------------------------------------------------------------------ */
/* Wire formats — EIP-712                                             */
/* ------------------------------------------------------------------ */

/**
 * EIP-712 typed-data domain separator. Matches the upstream reference
 * issuer (`createEIP712OfferReceiptIssuer`); the verifier reconstructs
 * the domain from `resourceUrl` + `network` and compares against the
 * signed value.
 */
export interface X402Eip712Domain {
  name: string;
  version: string;
  /** CAIP-2 chain ID embedded as `chainId` per EIP-712 §1.2. */
  chainId: number;
}

/**
 * EIP-712 signed offer. The `signature` is the 65-byte secp256k1
 * signature (r || s || v) hex-encoded with a `0x` prefix; the
 * `signer` is the recovered Ethereum address (`did:pkh`).
 *
 * The verifier MUST recompute the EIP-712 digest from `domain` +
 * `payload` and `ecrecover` against `signer` — we do NOT trust the
 * `signer` field as provided.
 */
export interface Eip712SignedOffer {
  format: "eip712";
  domain: X402Eip712Domain;
  /** 0x-prefixed hex of the 65-byte secp256k1 signature. */
  signature: string;
  /** The Ethereum address the signer CLAIMS to be. Verifier recomputes. */
  signer: string;
}

/** EIP-712 signed receipt. Same shape as the offer; different primary type. */
export interface Eip712SignedReceipt {
  format: "eip712";
  domain: X402Eip712Domain;
  signature: string;
  signer: string;
}

/* ------------------------------------------------------------------ */
/* Unions                                                             */
/* ------------------------------------------------------------------ */

/**
 * A signed offer in either wire format, paired with the decoded
 * payload it commits to. The verifier produces this — callers never
 * construct it directly — so consumers receive the payload already
 * extracted and the signature already cryptographically verified.
 */
export interface VerifiedOffer {
  /** Decoded, signature-verified payload. */
  payload: OfferPayload;
  /** The signed envelope, retained for re-serialization into the audit ledger. */
  envelope: JwsSignedOffer | Eip712SignedOffer;
  /**
   * Stable signer identifier. `did:web:<host>` for JWS, `did:pkh:eip155:<chainId>:<address>`
   * for EIP-712. Compared against the receipt's signer during
   * `verifyReceiptMatchesOffer` — the receipt MUST be signed by the
   * same identity that signed the offer.
   */
  signerDid: string;
}

/** Same shape as `VerifiedOffer`, for the post-settlement receipt. */
export interface VerifiedReceipt {
  payload: ReceiptPayload;
  envelope: JwsSignedReceipt | Eip712SignedReceipt;
  signerDid: string;
}

/* ------------------------------------------------------------------ */
/* Runtime guards (cheap, zero-dep, mirror outbound-value-transfer.ts) */
/* ------------------------------------------------------------------ */

function isStringField(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Structural validation of an OfferPayload. Does NOT verify the
 * signature — that is the verifier's job. This guard exists for the
 * Decision Engine to defend against malformed input before doing
 * the (relatively expensive) cryptographic check.
 */
export function isOfferPayload(value: unknown): value is OfferPayload {
  if (!value || typeof value !== "object") return false;
  const o = value as Partial<OfferPayload>;
  return (
    isStringField(o.resourceUrl) &&
    isStringField(o.offerType) &&
    isStringField(o.network) &&
    isStringField(o.amount) &&
    isStringField(o.payTo) &&
    typeof o.validUntil === "number" &&
    Number.isFinite(o.validUntil)
  );
}

/**
 * Structural validation of a ReceiptPayload. `txHash` is optional;
 * everything else is required. Same caveats as `isOfferPayload`.
 */
export function isReceiptPayload(value: unknown): value is ReceiptPayload {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<ReceiptPayload>;
  return (
    isStringField(r.resourceUrl) &&
    isStringField(r.payer) &&
    isStringField(r.network) &&
    typeof r.issuedAt === "number" &&
    Number.isFinite(r.issuedAt) &&
    (r.txHash === undefined || isStringField(r.txHash))
  );
}

/* ------------------------------------------------------------------ */
/* Receipt-to-Offer matching                                          */
/* ------------------------------------------------------------------ */

/**
 * Outcome of `verifyReceiptMatchesOffer`. Distinct codes per failure
 * mode so callers can render actionable error messages and so SIEM
 * pipelines can alert on the cryptographic-mismatch cases (which
 * indicate adversarial activity, not user error).
 */
export type ReceiptMatchResult =
  | { ok: true }
  | { ok: false; reason: ReceiptMatchFailureReason };

export type ReceiptMatchFailureReason =
  | "resource_url_mismatch"
  | "network_mismatch"
  | "payer_not_authorized"
  | "signer_mismatch"
  | "receipt_stale"
  | "offer_expired_before_receipt"
  | "receipt_predates_offer"
  // P1-7: the offer's amount / payTo did not match what Axiru authorized.
  | "amount_mismatch"
  | "pay_to_mismatch";

/**
 * Pure comparator: given an already-verified offer + receipt pair,
 * decide whether the receipt is evidence that the offer was paid.
 *
 * The x402 spec defines four conditions (see `verifyReceiptMatchesOffer`
 * in the upstream client SDK):
 *   1. `resourceUrl` matches the offer
 *   2. `network` matches the offer
 *   3. `payer` matches one of the client's known wallet addresses
 *   4. `issuedAt` is recent (default 1 hour)
 *
 * We add two more, both implicit in the spec but worth surfacing as
 * distinct failure codes for forensic clarity:
 *   5. Receipt signer DID equals offer signer DID (a receipt signed
 *      by a *different* identity than the offer is a fraud signal
 *      regardless of payload contents).
 *   6. The receipt was issued AFTER the offer was issued and BEFORE
 *      the offer expired (`receipt.issuedAt` falls in `[offer.iat ?? 0,
 *      offer.validUntil + clockSkewSeconds]`).
 *
 * @param offer Verified offer (signature already checked by the verifier).
 * @param receipt Verified receipt (signature already checked).
 * @param authorizedPayers Payer addresses Axiru considers authorized
 *   for the originating org. Matched case-insensitively (EVM addresses
 *   are case-insensitive after EIP-55 checksumming).
 * @param now Unix-seconds timestamp; defaults to `Date.now()`.
 * @param maxReceiptAgeSeconds Default 3600 (1 hour) per the upstream spec.
 * @param clockSkewSeconds Default 30s grace at the offer expiry boundary.
 */
/**
 * P1-7: what Axiru authorized for this settlement. When provided, the offer's
 * `amount` and `payTo` MUST match — otherwise a receipt settling a *different*
 * (e.g. cheaper) offer, or paying a *different* recipient, would be accepted
 * as evidence for this authorization. The receipt payload itself carries no
 * amount/payTo, so binding is anchored to the offer against the authorized
 * expectation. See docs/reviews/2026-07-02-codebase-review.md P1-7.
 */
export interface AuthorizedSettlementExpectation {
  /** Smallest-unit amount string, compared exactly to `offer.payload.amount`. */
  amount?: string;
  /** Destination address, compared case-insensitively to `offer.payload.payTo`. */
  payTo?: string;
}

export function verifyReceiptMatchesOffer(
  offer: VerifiedOffer,
  receipt: VerifiedReceipt,
  authorizedPayers: readonly string[],
  now: number = Math.floor(Date.now() / 1000),
  maxReceiptAgeSeconds: number = 3600,
  clockSkewSeconds: number = 30,
  expected?: AuthorizedSettlementExpectation
): ReceiptMatchResult {
  if (offer.payload.resourceUrl !== receipt.payload.resourceUrl) {
    return { ok: false, reason: "resource_url_mismatch" };
  }
  if (expected?.amount !== undefined && offer.payload.amount !== expected.amount) {
    return { ok: false, reason: "amount_mismatch" };
  }
  if (
    expected?.payTo !== undefined &&
    offer.payload.payTo.toLowerCase() !== expected.payTo.toLowerCase()
  ) {
    return { ok: false, reason: "pay_to_mismatch" };
  }
  if (offer.payload.network !== receipt.payload.network) {
    return { ok: false, reason: "network_mismatch" };
  }
  if (offer.signerDid !== receipt.signerDid) {
    return { ok: false, reason: "signer_mismatch" };
  }
  const payerLower = receipt.payload.payer.toLowerCase();
  if (!authorizedPayers.some((p) => p.toLowerCase() === payerLower)) {
    return { ok: false, reason: "payer_not_authorized" };
  }
  if (receipt.payload.issuedAt > now + clockSkewSeconds) {
    return { ok: false, reason: "receipt_stale" };
  }
  if (now - receipt.payload.issuedAt > maxReceiptAgeSeconds) {
    return { ok: false, reason: "receipt_stale" };
  }
  // `validUntil` is the offer's hard expiry. We allow a small skew on
  // both sides because the offer signer and receipt signer use the same
  // wall clock but may report at slightly different sample points.
  if (receipt.payload.issuedAt > offer.payload.validUntil + clockSkewSeconds) {
    return { ok: false, reason: "offer_expired_before_receipt" };
  }
  return { ok: true };
}
