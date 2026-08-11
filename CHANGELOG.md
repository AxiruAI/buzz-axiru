# Changelog

## 0.5.2

The field-test release: every fix in it comes from an overnight of real
Buzz agents running the gate on a real machine. Credit for the reports,
the reproductions, and the tracing goes to the Buzz agents who did that
field testing.

- Fixed: downstream commands given as a bare name ("buzz-dev-mcp",
  "npx") failed to start with `spawn <name> ENOENT` on any config that
  predates the explicit env allowlist. Since 0.4.0 `env_passthrough`
  defaults to "none", so the child environment has no PATH, and Node
  resolves a spawned executable against the child's PATH rather than
  the gate's. The gate now resolves bare command names against its own
  (parent) PATH before spawning and passes the child environment
  through unchanged, so "none" still forwards no parent variables,
  PATH included. Commands containing a path separator are untouched.
  This restores the pre-0.4 resolution behaviour without weakening the
  secret isolation that 0.4.0 introduced.
- Improved: when a bare command cannot be found on the gate's PATH
  either, startup still fails closed but now says which command was
  not found and suggests using an absolute path in policies.json,
  instead of surfacing a raw ENOENT.
- Fixed: `adopt` for Buzz Desktop now creates an "Axiru Gated" custom
  harness (buzz-acp with `["--mcp-command", "<gate>"]` as two separate
  argv elements) and points the agent's runtime at it, instead of
  editing `mcp_command`. Field testing proved the old edit does
  nothing: Desktop injects `BUZZ_ACP_MCP_COMMAND` first in the child
  envp, appended overrides lose (first duplicate wins in buzz-acp),
  and only the argv flag beats the env var. The old mode survives
  behind `--legacy`, with a warning. adopt also prints the new
  required step: an agent on a custom harness must have its model set
  explicitly.
- Fixed: `adopt` no longer double-counts agents. managed-agents.json
  stores each agent twice (a persona definition row and a live
  instance row); adopt now dedupes by identity, prefers the live row
  (the one with a pubkey or runtime metadata), and reports each agent
  once, so one agent no longer trips "2 agents share the name".
- Fixed: `adopt` now searches the real macOS Buzz Desktop data dir,
  `~/Library/Application Support/xyz.block.buzz.app/`, including the
  `agents/` subdirectory where managed-agents.json actually lives.
- Added: when the resolved buzz-axiru path contains spaces (which
  break harness argument handling), adopt creates a two-line exec shim
  at /usr/local/bin/buzz-axiru when writable, and prints copy-paste
  instructions when not. `--gate-path` pins the binary explicitly.
- Added: `axiru_gate_status`, a read-only MCP tool in both gate and
  advisory modes, never gated regardless of payment_tools patterns. It
  returns version, mode, policy path, downstream servers with tool
  counts, gated tool names, agent pubkey, ledger record count and head
  hash, and pending approvals. Field testing showed agents cannot
  otherwise tell whether the gate is live (the wiring is an argv flag
  and tool names are unchanged), and they misreported when asked; this
  tool is the evidence they can quote.
- Added: a low file-descriptor warning at gate startup and in
  `doctor`. A gate spawned under a Buzz custom harness inherits the
  login shell's limits (macOS soft maxfiles 256), and buzz-acp running
  agents in parallel can then fail them all with EAGAIN (os error 35).
  The warning names the `launchctl limit maxfiles` fix and never
  blocks startup.
- Added: `adopt --harness claude-code` merges an `axiru-gate` server
  into the project's `.mcp.json`, and `adopt --harness codex` merges
  `[mcp_servers.axiru-gate]` into `~/.codex/config.toml`. Both are
  idempotent, backed up, honor `--dry-run`/`--yes`, and refuse files
  they cannot parse.
- Docs: GITHUB-ISSUE-BUZZ.md rewritten with the complete evidence
  chain and concrete asks (expose mcpCommand in the UI, honor the
  agent-record value, error instead of silent bundle fallback);
  README and onboarding notes updated for the custom-harness flow and
  the axiru_gate_status verification line.

## 0.5.1

Onboarding release: `buzz-axiru adopt`, the missing wiring step for Buzz
Desktop users.

Field finding that motivated it: Buzz Desktop gives imported and custom
agents an empty `mcp_command` and exposes no UI to set it, and
`BUZZ_ACP_MCP_COMMAND` is on the app's reserved environment variable list,
so the env-var instructions (README step 3, quickstart output) silently do
nothing under the Desktop app. The only working path is editing the app's
`managed-agents.json` while the app is closed. Evidence: the reserved-list
error string in the buzz-desktop binary; UserProfilePanel renders
`mcpCommand` read-only and hides it when empty; the edit-agent dialog and
the custom-harness form contain zero `mcpCommand` references; agents get
`mcpCommand` copied from the runtime definition at creation. A ready-to-file
upstream issue lives in `GITHUB-ISSUE-BUZZ.md`.

New:

- `buzz-axiru adopt [--agent <name>] [--data <path>] [--unset] [--dry-run]
  [--yes]` sets an agent's mcp command to `buzz-axiru` inside Buzz Desktop's
  `managed-agents.json` (`--unset` restores the empty string):
  - Refuses to run while Buzz Desktop is running (POSIX process scan; the
    app live-rewrites the file, so editing under it corrupts state). Fails
    closed when the process table cannot be read. `--force` overrides,
    loudly discouraged.
  - Locates the file via `--data`, else one glob level under the standard
    locations (macOS: `~/Library/Application Support/Buzz*/` and
    `~/.buzz*/`; Linux: `~/.config/buzz*/` and `~/.buzz*/`). Multiple hits
    are listed and require `--data`; zero hits print instructions to ask a
    shell-capable Buzz agent for the path.
  - Tolerates unknown file shapes (top-level array, keyed object, either
    the `mcp_command` or `mcpCommand` spelling; the spelling found is the
    spelling edited). An unrecognizable shape is refused with a structural
    description that contains no values from the file.
  - Writes a timestamped backup next to the file before any edit, previews
    the change, and requires a TTY confirmation or `--yes`. Re-serializes
    with 2-space indent, so formatting may normalize; the backup keeps the
    original bytes.
- `quickstart --harness buzz` next steps now split the two wiring paths:
  the env var for raw `buzz-acp`, `adopt` for Buzz Desktop.
- README onboarding rewritten around the same split.

## 0.5.0

Security release. Most items originate from an external deep security review
of a proposed 0.5 rewrite. That rewrite was based on 0.4.0 and would have
reverted the 0.4.1 incremental ledger verification, so no file was adopted
wholesale: every adopted change was re-reviewed, re-implemented against the
current codebase where needed, and landed with a test. Items from the review
that were rejected are listed at the end.

Breaking changes:

- Node.js 22 or newer is required; the 18 and 20 lines are end of life.
- Agent identities are canonicalized. An npub is decoded (bech32 checksum
  verified) to its 32-byte lowercase hex form before it keys anything.
  Previously the hex and npub spellings of ONE key were two identity strings,
  so a single agent could split its per-agent daily cap across the two
  spellings and spend up to twice the cap. Operators who configured an npub
  will see their cap history continue under the hex form; the documented
  all-zeros unattributed fallback is unchanged (warn and share one cap, never
  crash).
- `npx` downstream commands must use the auditable form
  `npx -y package@exact-version ...`. Unpinned, tagged, ranged, and
  option-reordered forms fail config load: an unpinned payment server
  re-resolves on every gate start, so the binary that moves money could
  change between reviews.
- An identical, already-successful direct (policy-allowed) gated call is now
  suppressed as a duplicate instead of being paid again; rolling spend
  history correspondingly counts one final state per exact call.

Security fixes (external review, re-implemented):

- Direct policy-allowed payments are durably claimed BEFORE the downstream
  side effect, in the same critical section as the cap snapshot and the
  decision record. A crash between the downstream call and the outcome
  record previously erased the spend from rolling history (cap fail-open)
  and left the exact call replayable (double payment). The claim now counts
  as conservative spend until resolved.
- Transport outcomes are classified. A timeout, child exit, stdin write
  failure, or malformed/oversized response after a payment call was sent is
  an UNKNOWN outcome, not a failure: money may have moved. Unknown outcomes
  keep the durable claim, reserve cap headroom, suppress identical retries,
  and route to `buzz-axiru reconcile` (which now also accepts a direct-call
  sha256 fingerprint). A JSON-RPC error or MCP `isError: true` from a live
  child remains a definitive failure. Previously an ambiguous timeout was
  recorded as "failed", inviting a human to re-issue the payment.
- The approval store is tamper-evident and cross-checked. Parked call
  arguments must re-derive the approval's fingerprint at load, so a store
  edit that redirects an approved payment is refused. Before executing a
  grant, the gate requires a matching `approval_granted` record in the
  hash-chained ledger and re-derives the amount, currency, and counterparty
  the approver saw. This composes with the 0.4.1 checkpoint verification and
  stays tamper-evident, not tamper-proof, exactly as the README documents.
- Final approvals erase their parked arguments (secret-retention
  minimization); the fingerprint binding and ledger records remain. `show`
  explains the redaction. Existing store files are tightened to mode 0600 on
  open.
- One enforcing gate per data directory: a process-lifetime serving lease
  refuses a second gate, which could otherwise authorize payments from a
  stale cap snapshot. Stale-lock reclamation is serialized under a separate
  O_EXCL recovery token, closing a race where two restarting processes could
  both reclaim and one deleted the other's fresh lock.
- Tool-name globs are matched without regular expressions, removing
  catastrophic backtracking driven by adversarial downstream tool names.
  Overlapping wildcard amount mappings for one tool now fail closed to
  human approval instead of extracting from whichever mapping came first.
- Payment extraction is bounded: amounts at most 78 digits, currencies must
  look like currency codes, counterparties at most 512 printable characters.
  Argument and result shapes carry an aggregate 256 KiB string budget on top
  of the node and depth caps. Downstream tool results are shape-checked
  before they are returned or retained.
- The downstream initialize handshake rejects a child that selects a
  protocol revision the gate does not implement.

Operator changes:

- `pending` also lists direct-call incidents awaiting reconciliation, keyed
  by fingerprint, with the reserved amount and the transport evidence.
- `reconcile <approval-id|sha256:fingerprint> --outcome executed|failed
  --note <evidence>` resolves both approved and direct incidents in the
  ledger.
- Ambiguous approved executions notify the channel/webhook when the
  evidence is first attached, not only on final outcomes.
- Added least-privilege CI (SHA-pinned actions/checkout and
  actions/setup-node, verified against the upstream repositories; Node 22
  and 24; `npm ci --ignore-scripts`; production `npm audit`) and Dependabot
  for npm and GitHub Actions.

Rejected from the external review, with reasons:

- Their ledger.ts (full re-parse plus full hash re-verification on every
  read): reverts the 0.4.1 incremental checkpoint and reintroduces the
  O(n^2) decision latency it fixed.
- Advertising MCP protocol revision 2025-11-25: compliance with that
  revision was not verified here; a version string adds no safety by itself.
- Requiring an agent identity for gate startup: breaks the documented
  fail-closed all-zeros fallback, which warns and shares one cap.
- secp256k1 curve membership check on identities: the key is an identity
  label here, not signature input, and the check breaks the all-zeros
  fallback.
- Resolving relative `data_dir` beside policies.json: silently switches the
  data directory (and cap history) for existing deployments, the exact
  hazard it claims to fix.
- Never reclaiming remote-host locks by age: wedges containerized restarts,
  where hostnames churn while the volume persists.
- Ledger record schema validation at verify time: bricks existing valid
  ledgers whose old records exceed the new field bounds. Bounds are enforced
  where records are created instead.
- Their full config.ts, cli.ts, gate.ts, guard.ts, notify.ts, quickstart.ts,
  scaffold.ts, README, and SECURITY rewrites: based on 0.4.0; the narrow
  improvements above were extracted instead of adopting files wholesale.
- Store-vs-ledger cross-checks on every agent retry of a decided approval:
  full-ledger scans on an agent-controlled path; the check runs at the
  execution boundary, where money moves.

## 0.4.1

Performance and availability release. The issue was reported by an external
review, reproduced with a benchmark before any code changed, and re-measured
after the fix.

- Availability fix: every ledger append re-read, re-parsed, and re-hashed the
  entire ledger file, and every decision's history scan re-verified the full
  chain, so per-operation cost grew linearly with ledger size and total cost
  grew quadratically over the ledger's life. Appends run under the data
  directory lock, so a long-lived gate or a runaway agent eventually slowed
  every append and every spend decision toward seconds. Measured before the
  fix (median per operation): appends 12 ms at 500 records, 92 ms at 3,000,
  138 ms at 6,000, and still climbing; decisions tracked the same curve.
- The `Ledger` now keeps a verified checkpoint (last sequence, head hash,
  byte offset) and verifies only records appended after it, chaining onto the
  known-good head. Records appended by another process (the serve process and
  the approve/deny CLI interleave) are detected by file growth and verified
  as a delta; that is the normal case, not an anomaly. Measured after the
  fix: appends are flat at 2 to 3 ms from 500 through 20,000 records.
- Full from-genesis verification is preserved: at every `Ledger` open, in
  `buzz-axiru verify`, in `doctor`, and as the automatic fallback whenever
  the incremental pass sees anything unexpected (unparseable line, sequence
  or hash mismatch, file shrinkage, head divergence). If the fallback fails,
  the bridge still refuses to append or compute history, loudly.
- Integrity nuance, stated plainly: an in-place, same-size edit of a record
  the running process has already verified is caught at the next full pass
  (restart, `verify`, `doctor`) rather than at the next decision. That is
  consistent with the tamper-evident, not tamper-proof, model the README has
  always documented, and it is now written down there too.
- `doctor` now runs a full ledger verification and reports ledger state:
  record count, head hash, and verification mode.

## 0.4.0

Security release. Several items originate from an external review of the 0.4
proposal branch; every adopted change was independently re-reviewed and tested
before landing.

Breaking changes:

- `env_passthrough` now defaults to `"none"` instead of `"all"` (external
  review): a downstream child no longer inherits the bridge's full
  environment, including `BUZZ_PRIVATE_KEY` and other servers' API keys,
  unless the operator names each variable. Migration: add
  `"env_passthrough": ["PATH", "HOME", "TMPDIR", "<each credential>"]` (or
  the legacy `"all"`) to every downstream server that needs more than its
  own `env` block. Generated configs now ship explicit allowlists and no
  longer place a literal secret in the file.
- Gate mode refuses to start with an empty spend-control set (external
  review): with zero controls the policy engine default-allows every mapped
  payment while the operator believes a gate is in place.
- Gate mode refuses to start when `payment_tools` is configured but no
  exposed downstream tool matches any gate pattern (external review): a
  matcher typo previously left every money tool ungated behind a stderr
  warning nobody reads.
- `quickstart --check` (and the new `doctor`) now exits 1 for setups that are
  not enforcing-ready (advisory mode, missing identity, empty controls, a
  matcher that gates nothing).

Security fixes:

- Crash-safe approval execution (external review, reworked and extended): a
  granted parked call is now durably claimed (`execution_status:
  "in_progress"` plus fsync) BEFORE the downstream call. Previously a crash
  between the downstream call and the outcome record replayed the call on
  restart, which is a double payment. An ambiguous claim is never retried
  automatically; the agent receives `bridge.execution.reconciliation_required`,
  `pending` shows the stuck approval, and the new
  `reconcile <id> --outcome executed|failed --note <evidence>` records the
  operator-verified outcome in the ledger. In-progress claims also reserve
  their amount against the daily cap until reconciled.
- Daily-cap jump fix (external review): the vendored preset compares PRIOR
  24h spend only, so a single large payment could leap from under the cap to
  far above it. A request-local remaining-allowance rule now denies any
  payment that would cross the cap; landing exactly on the cap stays allowed.
- Approval store fails closed on corrupt or malformed state (external
  review): unreadable JSON previously became an empty queue, forgetting
  grants and executions. Records are schema-validated on load, keyed off a
  null-prototype map, and legacy short-id lookups verify the full
  fingerprint before matching.
- Atomic single-use grants (external review): advisory-mode grant consumption
  is now check-and-consume under the data-dir lock, so two concurrent
  identical requests can no longer both ride one human approval; a consumed
  grant now returns an explicit `bridge.deny.approval_already_consumed`.
- Ledger integrity enforced on use (external review): the hash chain is
  verified when the ledger opens and before spend-history reads; a tampered
  or corrupt line previously just vanished from rolling history, silently
  raising the remaining daily cap. Appends are fsynced; approval, ledger,
  lock, and generated config files are created `0600` (dirs `0700`).
- Ledger memos and notifications no longer echo raw tool arguments (external
  review): gated-call memos are now `Gated call to <tool>`, webhook payloads
  carry a summary without parked arguments or downstream results, and the
  exact call is inspected locally with the new `show <id>`.
- Downstream hardening (external review): tools/list pagination is bounded
  and loop-protected, tool catalogs have size/depth limits, JSON-RPC replies
  from the child are shape-validated, stdin write errors no longer crash the
  gate, and capability maps are null-prototype.
- Gate and advisory servers validate JSON-RPC envelopes and require object
  params/arguments (external review).
- Lock releases are token-checked so a stale-lock recovery cannot have its
  fresh lock deleted by the old holder; live local processes are never
  treated as stale (external review).
- Unknown-amount approvals require `--ack-unknown-amount` after inspecting
  the exact call with `show` (external review).
- Config validation tightened (external review): currency symbol format,
  integer bounds on `request_timeout_ms` and `approval_ttl_seconds`,
  environment variable name validation, refusal of the scaffolded
  `PIN_REVIEWED_VERSION` placeholder so unpinned `npx` payment servers are
  not launched from sample configs.

Other:

- New CLI commands: `show`, `reconcile`, `doctor`; human-readable `pending`
  (use `--json` for the old output). Approve/deny run under the data-dir
  lock and write the ledger record before the decision becomes visible.
- devDependencies pinned to exact versions; `prepack` builds; SECURITY.md
  ships in the npm tarball.

## 0.3.1

- security: gate now fails closed on foreign-currency or missing-currency payments (previously could bypass caps)
