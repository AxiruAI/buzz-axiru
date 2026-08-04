# buzz-axiru

Bounded spend authority for [Buzz](https://github.com/block/buzz) agents.

Buzz gives every AI agent its own Nostr keypair, its own channel memberships,
and the same surface area as a human teammate. `buzz-axiru` adds the one thing
a teammate with a company card also needs: **money movement asks first.**

It is a gating MCP proxy that runs beside your Buzz workspace. You point it at
whatever payment MCP server you already use (a Stripe MCP, an x402 wallet
server, anything that speaks MCP over stdio). The gate spawns that server as a
child process, re-exposes its tools to the agent, and intercepts every call to
a payment-class tool:

- **allow**: the call passes through to your payment server and its result
  comes back unchanged.
- **deny**: the agent gets a structured refusal. Your payment server never
  sees the call.
- **require_approval**: the call is parked, verbatim. A human approves or
  denies from the CLI; only a grant makes the gate replay the original call,
  exactly once.

Policy evaluation is deterministic and local, with
[`@axiru/agent-spend-guardrails`](https://www.npmjs.com/package/@axiru/agent-spend-guardrails):
pure in-process functions, no account, nothing phones home. Every decision
lands in an append-only JSONL ledger with a SHA-256 hash chain, keyed to the
agent's Nostr pubkey.

The agent's only path to money runs through the decision.

```
Goose / Codex / Claude Code  (harnessed by buzz-acp)
        |
        |  MCP: create_payment, refund, ... (your payment server's tools)
        v
   buzz-axiru gate  (this bridge, local process)
        |-- @axiru/agent-spend-guardrails    policy evaluation, in process
        |-- allow -> child process ----------> your payment MCP server
        |-- deny  -> structured refusal       (never reaches the server)
        |-- require_approval -> parked call
        |        |-- buzz messages send ...   approval request into your channel
        |        `-- buzz-axiru approve ----> replayed downstream exactly once
        `-- data/ledger.jsonl                 hash-chained decision log
```

## Two-minute quickstart (gate mode)

Node 18 or newer. One config file, one command.

```bash
npm install -g buzz-axiru     # or run from a clone: npm install && npm run build
npx buzz-axiru init           # writes policies.json with commented defaults
```

Open `policies.json` and fill in two blocks (the file documents itself; the
`$comment` keys are ignored by the loader):

```jsonc
"downstream": {
  "command": "npx",
  "args": ["-y", "@stripe/mcp", "--tools=all"],
  "env": { "STRIPE_SECRET_KEY": "sk_test_..." }
},
"payment_tools": {
  "gate": ["create_payment", "refund_*"],
  "mappings": {
    "create_payment": {
      "amount_field": "amount",
      "currency_field": "currency",
      "counterparty_field": "customer"
    }
  }
}
```

Then start it:

```bash
buzz-axiru serve              # gate mode, automatically: a downstream is configured
```

Point your agent at `buzz-axiru` instead of the payment server (with buzz-acp:
`export BUZZ_ACP_MCP_COMMAND="$(which buzz-axiru)"`). The agent sees the same
payment tools it always did. Now they answer to policy.

Try the scripted session to see a blocked payment, a parked one, and an
approved replay end to end:

```bash
npm test        # builds and runs the full suite
npm run demo    # deny, park, approve, replay, verify (DEMO_FAST=1 to skip pauses)
```

### Tell your agents (AGENTS.md snippet)

Paste this into your agent's AGENTS.md or system prompt. Encouragement lives
in the prompt, enforcement lives in the gate:

```markdown
## Payments
Payment tools in this workspace run through buzz-axiru, a local spend gate.
A payment tool call may come back with a structured refusal or a
"pending_approval" status instead of executing. On pending_approval: hold,
do not retry with altered parameters, and call the same tool again with
identical arguments after a human decides. Before planning a large spend,
you can call request_spend_approval to learn the policy decision in advance.
```

## Advisory mode: the on-ramp

Without a `downstream` block (or with `--mode advisory`), the bridge is the
v0.1 single-tool server: it exposes `request_spend_approval`, agents are asked
to call it before spending, and nothing is enforced. It is a good first step
when you want the policy pack, the approval flow, and the ledger before you
are ready to route your payment server through the gate.

`request_spend_approval` takes:

| field | type | example |
|---|---|---|
| `amount_minor_units` | integer string | `"4000000"` (USD 40,000.00) |
| `currency` | string | `"USD"` |
| `counterparty` | string id | `"acme-datacenter.example"` |
| `memo` | string | `"Q3 GPU cluster prepay"` |
| `agent_pubkey` | 64-char hex | the agent's Nostr pubkey |

Amounts are strings in minor units (cents for USD) because JavaScript numbers
lose precision exactly where large transfers live. The tool stays available in
gate mode too, so agents can check policy before committing to a plan.

## How gating works

**Which tools are gated.** `payment_tools.gate` is a list of tool-name
patterns (`*` is a wildcard). Tools that match are intercepted; everything
else passes through untouched, including tool listing, resources, prompts,
and any other request the downstream server understands.
`downstream.hide_tools` removes tools from the merged listing entirely.

**Fail closed, everywhere it matters:**

- Downstream configured but no `payment_tools` block: the gate cannot know
  which tools move money, so it gates EVERY downstream tool and says so at
  startup. Un-gating is an explicit operator decision.
- A gated call whose amount cannot be read (no mapping for the tool, missing
  field, negative or non-integer value) is routed to a human with a distinct
  reason code (`bridge.pending.amount_unextractable`,
  `bridge.pending.no_payment_mapping`, and friends). It is never allowed
  through on a guess.
- A brand-new agent's very first spend escalates to a human
  (`guardrails.pending.velocity_inputs_unavailable`): the evaluator cannot
  distinguish "no prior activity" from "missing data", so it asks once.

**Amount extraction.** Each gated tool gets a mapping: dot-separated paths
into the tool call's arguments for the amount (integer minor units), the
currency, and the counterparty. Static `currency` / `counterparty` values are
supported for tools that do not carry them. With no counterparty mapping, the
counterparty is reported as `tool:<tool_name>`; allowlist that id if you use
the counterparty allowlist.

**Identity.** Downstream tool calls carry no pubkey argument, so gate-mode
decisions are attributed to `BUZZ_AXIRU_AGENT_PUBKEY` (run one gate per agent,
as with v0.1) or `agent_pubkey` in the config. If neither is set the gate
still fails safe: everything attributes to the all-zeros pubkey and all
unattributed agents share one daily cap.

## Approvals

When a gated call needs approval, the bridge parks the call verbatim, posts
the details to your Buzz channel (agent pubkey, amount, counterparty, reason
code, approval id), and returns `pending_approval` to the agent. Then:

```bash
buzz-axiru pending                     # see what is waiting
buzz-axiru approve 9c77edc5e275 --by marcos --note "invoice checked"
buzz-axiru deny 9c77edc5e275 --by marcos --note "wrong vendor"
```

On a grant, the running gate process replays the original call against the
downstream server exactly once and records the outcome. The agent's next
identical call returns the stored result (with an `_buzz_axiru` annotation),
never a second payment. If the downstream call fails after approval, that is
recorded with its own status (`execution_failed_after_approval`) and the grant
is spent; a human has to look.

Approvals expire: `approval_ttl_seconds` (default 24 hours). An expired
approval can no longer be granted, is never executed, and is recorded in the
ledger as expired. Denials are sticky. Grants never transfer to a different
amount, counterparty, tool, or arguments, because the approval is keyed to a
fingerprint of the exact call.

Approving by replying in the channel is not implemented: that requires the
bridge to hold a relay subscription, and it is left as a marked integration
point (`src/notify.ts`). A `webhook_url` receives approval requests and
outcomes for operators who want them in their own tooling.

## Policies

Policies load from `policies.json` at startup. The default pack:

| control | default | effect |
|---|---|---|
| `per_agent_daily_cap` | USD 100,000.00 per 24h | deny once the agent's trailing-24h spend hits the cap |
| `single_payment_ceiling` | USD 25,000.00 | any single payment at or above it requires human approval |
| `counterparty_allowlist` | 3 example ids | anything not listed is denied |
| `business_hours` | 09:00 to 17:00 America/New_York | outside the window, spend requires human approval |

The daily cap is instantiated per requesting pubkey. Rolling-window history
comes from the bridge's own ledger: in gate mode, executed downstream calls
count; in advisory mode, allow decisions count.

## The decision ledger

`data/ledger.jsonl`, one JSON record per line: policy decisions, human
grants and denials, expiries, and downstream executions (success or failure),
each with the agent's pubkey, the call fingerprint, `prev_hash`, and its own
SHA-256 hash over the canonical JSON of everything else. Editing, reordering,
or deleting any record breaks every hash after it:

```bash
buzz-axiru verify
# { "ok": true, "records": 5, "head_hash": "d0723de2..." }
```

One honest caveat: truncating the tail of a local file is not detectable from
the file alone. If you need that property, anchor the current `head_hash`
somewhere external now and then. A Buzz message is a fine place; the relay's
own audit chain then covers your spend chain.

## Wiring it into Buzz

1. **Give the bridge its own identity for channel posts.** Mint a keypair with
   `buzz-admin mint-token` and export `BUZZ_PRIVATE_KEY` and `BUZZ_RELAY_URL`
   in the bridge's environment. Do not reuse an agent's key: the approval
   request should be signed by the guardrail, not by the agent asking for
   money.
2. **Point the bridge at a channel.** Set `buzz.channel_id` in `policies.json`
   to the channel UUID where approvals should land. The bridge posts through
   the `buzz` CLI (`buzz messages send --channel <uuid> --content ...`), which
   must be on `PATH`.
3. **Hand the gate to your agents.** `buzz-acp` accepts an MCP server binary
   via `BUZZ_ACP_MCP_COMMAND` and provides it to each agent subprocess:

   ```bash
   export BUZZ_ACP_MCP_COMMAND="$(which buzz-axiru)"
   buzz-acp
   ```

4. **Run one gate instance per agent** and set `BUZZ_AXIRU_AGENT_PUBKEY` to
   that agent's hex pubkey, so decisions and caps attach to the right
   identity.

## What is verified against Buzz, and what is assumed

Built against the public `block/buzz` repository (README, ARCHITECTURE.md,
`crates/buzz-acp`, `crates/buzz-cli`, as of July 2026).

**Verified surfaces this bridge relies on:**

- Agents are Nostr identities: keys minted as `nsec`/`npub` pairs, and authors
  identified by 64-char hex pubkeys (buzz-acp allowlist format).
- `buzz-acp` accepts `BUZZ_ACP_MCP_COMMAND`, an MCP server binary provided to
  each agent subprocess; ACP `session/new` carries `mcpServers`. Each agent
  subprocess gets its own MCP server instance.
- Channel posts: `buzz messages send --channel <uuid> --content <text>` with
  `BUZZ_PRIVATE_KEY` identity and `BUZZ_RELAY_URL` relay. Chat messages are
  kind 9 Nostr events.
- Buzz itself keeps a hash-chain audit log (`buzz-audit`); this ledger
  mirrors that shape for spend decisions.

**Assumptions, marked in code comments where they bite:**

- That `buzz-acp` invokes the MCP binary with no arguments (the default
  `buzz-axiru` action therefore starts the stdio server).
- That plain-text channel posts are sufficient; the `buzz` CLI documents no
  flag for @mention `p` tags, so approvers are not tagged.
- Workflow-native approval gates (`buzz workflows approve`) are documented as
  not yet wired end-to-end upstream, so this bridge keeps its own approval
  queue instead of using them.

## The honest split

Everything in this repository is free, local, and Apache-2.0: the gating
proxy, the policy evaluation, the approval flow, the hash-chained log. It is
a real guardrail for a single workspace, and it is deliberately small.

The hosted [Axiru](https://axiru.com) platform is where the larger problem
lives: enforcement wired into the payment rails themselves (Stripe, x402,
USDC on Solana), a real approval queue with routing and escalation instead of
one JSON file, and an audit-grade evidence ledger that can replay any decision
bit-for-bit across a fleet of agents. Same evaluator, same reason codes; the
bridge is the local end of it.

## Limitations

Read this section before trusting the gate with anything.

- **The gate governs the tools routed through it, nothing else.** An agent
  that holds direct credentials (an API key in its environment, a wallet
  file, a payment binary on PATH) or that reaches a payment tool you did not
  gate is outside the gate's authority entirely. Enforcement is real, but its
  scope is exactly the downstream server behind the gate: give agents the
  gate, not the keys.
- The matcher is the operator's statement of which tools move money. A
  payment tool missing from `payment_tools.gate` passes through ungated
  (unless you omit the matcher entirely, in which case everything is gated).
  Review the downstream server's tool list when you configure it, and again
  when you upgrade it.
- This is a local, single-process gate in front of one downstream server per
  instance: one bridge, one data directory, files on disk. It is not the
  hosted product's multi-rail enforcement, queue, or replication. The serve
  process and the approve/deny CLI may interleave ledger writes; truly
  concurrent writers are not supported.
- In gate mode the agent identity comes from the operator's configuration
  (`BUZZ_AXIRU_AGENT_PUBKEY` per instance), not from anything the agent
  proves cryptographically. In advisory mode `agent_pubkey` is self-reported
  by the calling agent; pin it per instance.
- Approved-then-executed calls are replayed exactly as parked. If the
  downstream server treats a replay differently over time (price changes,
  idempotency windows), the human should approve promptly; the TTL exists to
  keep stale intents from executing.
- Business-hours policy knows hours and timezones, not weekends or holidays.
- The channel-post adapter shells out to the `buzz` CLI; if the CLI is absent
  or the relay is down, the approval still exists locally and is listed by
  `buzz-axiru pending`, but nobody gets pinged.
- If the downstream server crashes, gated and passthrough calls return
  errors (never hang) and the child is not auto-restarted; restart the
  bridge.

## Development notes

For local development this repo vendors the guardrails library under
`vendor/` so `npm install && npm test` works without the registry. Swapping to
the published package at release is a one-line change documented in
[vendor/README.md](vendor/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
