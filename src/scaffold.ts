/**
 * The `buzz-axiru init` scaffold: one starter config file with the
 * defaults spelled out in $comment keys (JSON has no comments; keys
 * starting with $ are ignored by the loader).
 *
 * Licensed under the Apache License, Version 2.0.
 */

export const STARTER_POLICIES = `{
  "$comment": "buzz-axiru config. One file: policy controls, the downstream payment MCP server to gate, and notification wiring. Amounts are integer strings in minor units (cents for USD). Keys starting with $ are ignored. Edit and restart the bridge.",

  "rail": "x402",
  "currency": "USD",

  "controls": {
    "$comment": "Deterministic spend policy, evaluated locally on every decision.",
    "per_agent_daily_cap": {
      "$comment": "Denies an agent's spend once its trailing-24h authorized total reaches the cap. USD 100,000.00.",
      "cap_minor_units": "10000000"
    },
    "single_payment_ceiling": {
      "$comment": "Routes any single payment at or above the threshold to a human. USD 25,000.00.",
      "threshold_minor_units": "2500000",
      "approver_group": "operators"
    },
    "counterparty_allowlist": {
      "$comment": "Anything not in this list is denied. Ids must match [A-Za-z0-9_.:@/-]+. Gated tools with no counterparty mapping report as tool:<tool_name>; allowlist that id if you use the allowlist without a counterparty_field.",
      "allowed_ids": [
        "acme-datacenter.example",
        "cloudsmith.example",
        "openrouter.example"
      ]
    },
    "business_hours": {
      "$comment": "Outside 09:00-17:00 in this timezone, spend is routed to a human instead of allowed.",
      "tz": "America/New_York",
      "open_hour": 9,
      "close_hour": 17,
      "effect": "require_approval"
    }
  },

  "downstream": null,
  "$downstream_example": {
    "$comment": "Set downstream to an object like this to turn on gate mode: the bridge spawns your payment MCP server as a child process, re-exposes its tools, and intercepts every payment-class call. Example for a Stripe MCP server:",
    "command": "npx",
    "args": ["-y", "@stripe/mcp", "--tools=all"],
    "env": { "STRIPE_SECRET_KEY": "sk_test_..." },
    "request_timeout_ms": 30000,
    "hide_tools": []
  },

  "payment_tools": null,
  "$payment_tools_example": {
    "$comment": "Which downstream tools are payment-class, and how to read the amount out of their arguments. Patterns support * as a wildcard. FAIL CLOSED: if downstream is set and payment_tools is null, EVERY downstream tool is gated. Field paths are dot-separated into the tool call arguments; amounts must be non-negative integers in minor units.",
    "gate": ["create_payment", "refund_*"],
    "mappings": {
      "create_payment": {
        "amount_field": "amount",
        "currency_field": "currency",
        "counterparty_field": "customer"
      },
      "refund_*": {
        "amount_field": "amount",
        "currency": "USD"
      }
    }
  },

  "approval_ttl_seconds": 86400,
  "$approval_ttl_comment": "How long a parked approval stays decidable, in seconds. After this it expires: it can no longer be granted and is never executed. null disables expiry (not recommended).",

  "agent_pubkey": null,
  "$agent_pubkey_comment": "The Nostr pubkey (64-char hex) decisions are attributed to in gate mode. Usually set per instance via BUZZ_AXIRU_AGENT_PUBKEY instead. If neither is set, decisions attribute to the all-zeros pubkey and all unattributed agents share one daily cap.",

  "buzz": {
    "$comment": "Set channel_id to a Buzz channel UUID to post approval requests there via the buzz CLI. The CLI must be on PATH and BUZZ_PRIVATE_KEY / BUZZ_RELAY_URL must be set for the bridge's own identity.",
    "channel_id": null,
    "cli_path": "buzz"
  },
  "webhook_url": null,
  "data_dir": "data"
}
`;
