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
  denies from the CLI; only a grant lets the gate durably claim and execute
  the original call. An ambiguous mid-call failure is held for manual
  reconciliation instead of being retried into a possible duplicate payment.

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
        |        `-- buzz-axiru approve ----> durable claim -> downstream
        `-- data/ledger.jsonl                 hash-chained decision log
```

## Quickstart

Node 18 or newer. Generate a secure starter config and wire it to your
harness:

```bash
npm install -g buzz-axiru
export BUZZ_AXIRU_AGENT_PUBKEY=<agent's-64-char-hex-pubkey-or-npub>
buzz-axiru quickstart --harness buzz
```

`quickstart` finds your Buzz shell server (`BUZZ_ACP_MCP_COMMAND` first, then
PATH, then the macOS app bundle), writes a starter `policies.json` in the
current directory, and prints the wiring steps for your harness. It never
prompts: every choice has a flag (`--harness buzz|goose|claude-code|codex`,
`--agent-pubkey`, `--force` to overwrite an existing `policies.json`, `--yes`
to accept all defaults). For Buzz the printed steps boil down to:

```bash
export BUZZ_ACP_MCP_COMMAND=buzz-axiru
# configure the disabled payment slot, then verify identity, coverage, and connectivity:
buzz-axiru doctor
```

`doctor` (also available as `quickstart --check`) loads the config, starts
every configured downstream server exactly the way `serve` does, lists its
tools and gate coverage, checks identity and spend controls, and exits 0 only
when the enforcing setup is ready. Advisory mode, a missing identity, empty
controls, and a matcher that protects no exposed tools are reported as
`NOT READY` rather than as a successful install.

The generated config exposes your shell server's tools unchanged and gates
`pay_*` only. To put a payment server behind the same gate, move the
ready-made `$downstream_payment_slot` object in `policies.json` into the
`downstream` array and restart. Details on the multi-server fan-out are in
[How gating works](#how-gating-works).

The generated file contains no live payment credential. Export each secret in
the bridge process and name only the variables that its downstream child needs
in `env_passthrough`.

### Upgrading from 0.3

Version 0.4 intentionally tightens unsafe defaults:

- Gate mode now refuses to start with an empty spend-control set, and refuses
  a `payment_tools` matcher that gates none of the exposed downstream tools.
  A missing agent identity is still tolerated (all unattributed agents share
  the all-zeros pubkey and one daily cap) but is flagged loudly at startup
  and by `buzz-axiru doctor`.
- Omitted `env_passthrough` now means `none`, not `all`. Add an explicit
  allowlist for `PATH` and each credential a child actually needs.
- New approval ids are 32 hex characters; existing 12-character records are
  still read and checked against their full fingerprint.
- `pending` is human-readable by default; use `pending --json` for automation.
- Ambiguous approved executions remain `in_progress` until an operator uses
  `reconcile` with provider evidence. They are never retried automatically.

### Manual setup

Prefer to wire it by hand, or gating a payment server on a harness quickstart
does not know? Same result, three steps.

```bash
npm install -g buzz-axiru     # or run from a clone: npm install && npm run build
npx buzz-axiru init           # writes policies.json with commented defaults
```

Open `policies.json` and fill in two blocks (the file documents itself; the
`$comment` keys are ignored by the loader):

```jsonc
"downstream": {
  "command": "npx",
  "args": ["-y", "@stripe/mcp@<reviewed-exact-version>", "--tools=all"],
  "env": {},
  "env_passthrough": ["PATH", "HOME", "TMPDIR", "STRIPE_SECRET_KEY"]
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

Keep the key out of `policies.json` and identify the agent before starting.
Replace `<reviewed-exact-version>` with a pinned release you have reviewed;
do not launch an unversioned payment server through `npx -y`. Then export:

```bash
export STRIPE_SECRET_KEY=<your-key>
export BUZZ_AXIRU_AGENT_PUBKEY=<agent's-64-char-hex-pubkey-or-npub>
buzz-axiru doctor
```

Then start it:

```bash
buzz-axiru serve              # gate mode, automatically: a downstream is configured
```

Point your agent at `buzz-axiru` instead of the payment server (with buzz-acp:
`export BUZZ_ACP_MCP_COMMAND="$(which buzz-axiru)"`). The agent sees the same
payment tools it always did. Now they answer to policy.

Try the scripted session to see a blocked payment, a parked one, and an
approved execution end to end:

```bash
npm test        # builds and runs the full suite
npm run demo    # deny, park, approve, execute, verify (DEMO_FAST=1 to skip pauses)
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

**Several servers behind one slot.** Buzz gives an agent exactly one MCP
server, so an agent normally gets a shell server or a payment server, never
both. Because the gate is a proxy, `downstream` also accepts an ARRAY of
server blocks: the gate takes that single slot and fans out behind it. Each
entry may set `name` (defaults to the command basename, must be unique) and
`tool_prefix`, which renames that server's tools on the way out. Gate patterns
and amount mappings match the EXPOSED name, prefix included. Two servers
exposing the same tool name is a startup error, never a silent winner, and if
any server fails to start the gate refuses to run at all. With multiple
servers the no-`payment_tools` fail-closed rule gates shell tools too, which
is why the array example prefixes the payment server with `pay_` and gates
`pay_*`.

```jsonc
"downstream": [
  {
    "name": "buzz-dev",
    "command": "buzz-dev-mcp",
    "env_passthrough": ["PATH", "HOME", "TMPDIR"]
  },
  {
    "name": "payments",
    "command": "npx",
    "args": ["-y", "@stripe/mcp@<reviewed-exact-version>", "--tools=all"],
    "env": {},
    "env_passthrough": ["PATH", "HOME", "TMPDIR", "STRIPE_SECRET_KEY"],
    "tool_prefix": "pay_"
  }
],
"payment_tools": { "gate": ["pay_*"], "mappings": { "pay_create_payment": { "amount_field": "amount" } } }
```

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
unattributed agents share one daily cap. The gate warns loudly at startup and
`buzz-axiru doctor` reports the missing identity as `NOT READY`; set one per
gate before production.

## Approvals

When a gated call needs approval, the bridge parks the call verbatim, posts
the details to your Buzz channel (agent pubkey, amount, counterparty, reason
code, approval id), and returns `pending_approval` to the agent. Then:

```bash
buzz-axiru pending                                  # concise waiting list
buzz-axiru show 9c77edc5e275174850812007ed184b62    # exact parked arguments
buzz-axiru approve 9c77edc5e275174850812007ed184b62 --by marcos --note "invoice checked"
buzz-axiru deny 9c77edc5e275174850812007ed184b62 --by marcos --note "wrong vendor"
```

If Axiru cannot extract an amount, `show` makes the exact call visible and
`approve` additionally requires `--ack-unknown-amount`; a bare approval is
refused.

On a grant, the gate atomically records an `in_progress` claim on disk before
sending the parked call downstream. A successful result is stored, and the
agent's next identical call returns it with an `_buzz_axiru` annotation. This
provides durable **at-most-once** execution across retries, concurrent gate
instances, and restarts. It deliberately does not claim impossible
exactly-once semantics: if the process dies after the claim but before it can
record the provider's response, Axiru will not retry automatically. The
approval stays `in_progress`, reserves its policy-currency amount against
rolling history, and an operator must check the payment provider. Record the
verified outcome with evidence:

```bash
buzz-axiru reconcile 9c77edc5e275174850812007ed184b62 \
  --outcome executed --by marcos --note "provider payment pi_123 succeeded"
# or: --outcome failed --note "provider search confirms no transfer"
```

A known downstream failure is recorded as `failed`; the grant remains spent
and requires human review before a genuinely new payment is requested.

Approvals expire: `approval_ttl_seconds` (default 24 hours). An expired
approval can no longer be granted, is never executed, and is recorded in the
ledger as expired. Denials are sticky. Grants never transfer to a different
amount, counterparty, tool, or arguments, because the approval is keyed to a
fingerprint of the exact call.

Approving by replying in the channel is not implemented: that requires the
bridge to hold a relay subscription, and it is left as a marked integration
point (`src/notify.ts`). A `webhook_url` receives approval requests and
outcomes for operators who want them in their own tooling. Webhook bodies are
summary-only: exact tool arguments and provider results remain local because
they may contain credentials or customer/payment data.

## Policies

Policies load from `policies.json` at startup. The default pack:

| control | default | effect |
|---|---|---|
| `per_agent_daily_cap` | USD 100,000.00 per 24h | deny a request that would push trailing-24h spend over the cap |
| `single_payment_ceiling` | USD 25,000.00 | any single payment at or above it requires human approval |
| `counterparty_allowlist` | 3 example ids | anything not listed is denied |
| `business_hours` | 09:00 to 17:00 America/New_York | outside the window, spend requires human approval |

The daily cap is instantiated per requesting pubkey and includes the current
request: reaching the cap exactly is allowed, crossing it is denied.
Rolling-window history comes from the bridge's own ledger: in gate mode,
executed downstream calls count; in advisory mode, allow decisions count.
One gate evaluates one configured currency. A call whose extracted currency
does not match the policy currency is never executed; run separate gate
instances for independently denominated policy packs.

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

The chain is verified when the ledger opens and again before every append; a
corrupt chain blocks new decisions instead of being extended. Local config,
approval, ledger, and lock files are created owner-only (`0600`) and data
directories as `0700`.

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
  when you upgrade it. The gate refuses to start when a configured matcher
  gates none of the tools it can see. Note also that gate patterns match the
  exposed tool name, and without a `tool_prefix` that name is chosen by the
  downstream server: a server that renames its payment tool leaves the gate.
  Set a `tool_prefix` on any server that moves money and gate the prefix.
- This is a local gate: one data directory, files on disk. It can front
  several downstream servers at once, but they all share one ledger. It is not
  the hosted product's multi-rail enforcement, queue, or replication. The serve
  process and the approve/deny CLI interleave writes safely, because every
  ledger append and every approval-store update is taken under an exclusive
  lock on the data directory (`<data_dir>/.lock`). A writer that cannot take
  that lock within ten seconds fails loudly rather than writing anyway. Run
  only one serving gate process per data directory: writers serialize safely,
  but policy evaluation and a downstream side effect are not one cross-process
  transaction, so two serving processes could both authorize against the same
  pre-payment cap history. The approve/deny/reconcile CLI may safely share the
  serving process's data directory.
- In gate mode the agent identity comes from the operator's configuration
  (`BUZZ_AXIRU_AGENT_PUBKEY` per instance), not from anything the agent
  proves cryptographically. In advisory mode `agent_pubkey` is self-reported
  by the calling agent; pin it per instance.
- Approved calls execute with the exact arguments that were parked. If the
  downstream server interprets those arguments differently over time (for
  example, a price quote changes), approve promptly; the TTL exists to keep
  stale intents from executing.
- At-most-once claims apply to human-approved parked calls. A direct policy
  `allow` is passed through immediately and has no durable retry deduplication.
  Use a provider-supported idempotency key for every money-moving tool so an
  agent or transport retry cannot duplicate a directly allowed payment.
- Each process has one policy currency. Currency mismatch fails closed; use a
  separate gate and ledger for each independently denominated policy pack.
- The ledger is tamper-EVIDENT, not tamper-PROOF. `buzz-axiru verify`
  re-derives the whole chain and names the first bad record, so an edit, a
  reorder, a deletion, or a mid-file truncation is caught. It cannot catch
  anyone who can write `data_dir`, because that person can recompute a
  consistent chain from genesis, and it cannot by itself catch a truncation
  of the tail. Copy the head hash somewhere the agent cannot write if you need
  either; the local bridge does not automate external anchoring.
- Business-hours policy knows hours and timezones, not weekends or holidays.
- The channel-post adapter shells out to the `buzz` CLI; if the CLI is absent
  or the relay is down, the approval still exists locally and is listed by
  `buzz-axiru pending`, but nobody gets pinged. The CLI is invoked with an
  argv array and no shell, and every agent-supplied field in the message
  (memo, counterparty, amounts) is flattened to one line first, so an agent
  cannot forge extra lines in what the approver reads.
- Downstream children inherit no bridge environment variables by default.
  Use an explicit `env_passthrough` allowlist for variables a child needs.
  Legacy `"all"` remains supported, but exposes `BUZZ_PRIVATE_KEY` and every
  unrelated credential in the bridge process and produces a readiness warning.
- The pending-approval queue is bounded by `max_pending_approvals` (default
  500). At the ceiling, gated calls are refused with
  `bridge.deny.approval_queue_full` rather than parked, because an agent that
  varies its arguments otherwise chooses how long the queue gets.
- Decided approval records are retained in `approvals.json` so identical
  retries remain sticky. That file can grow over time and may contain exact
  call arguments and provider results; archive it only with an operator-defined
  retention process that preserves the ledger and idempotency requirements.
- If the downstream server crashes, gated and passthrough calls return
  errors (never hang) and the child is not auto-restarted; restart the
  bridge.

For the deployment threat model, reporting instructions, and a production
checklist, read [SECURITY.md](SECURITY.md).

## Development notes

For local development this repo vendors the guardrails library under
`vendor/` so `npm install && npm test` works without the registry. Swapping to
the published package at release is a one-line change documented in
[vendor/README.md](vendor/README.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
