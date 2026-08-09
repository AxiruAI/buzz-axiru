# Changelog

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
