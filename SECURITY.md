# Security policy

`buzz-axiru` sits on a money-movement path. Treat a configuration mistake as
a security issue, not just an availability problem.

## Reporting a vulnerability

Do not publish exploit details, credentials, payment data, or approval-store
contents in a public issue. Use GitHub's private **Report a vulnerability**
flow for this repository when it is available. If that flow is unavailable,
open a public issue containing only a request for a private maintainer contact
and a high-level impact statement; wait for a private channel before sharing
reproduction details.

Include the affected commit or version, threat model, minimal reproduction,
impact, and any suggested mitigation. Never use real payment credentials or
move real funds while demonstrating a report.

Security fixes are made against the latest release line and `main`; operators
should upgrade to the newest published release after a fix is announced.

## Trust boundaries

- The gate controls only MCP tools routed through it. An agent with a direct
  API key, wallet, payment binary, alternate MCP server, or writable gate
  configuration can bypass it.
- `agent_pubkey` is operator-provided identity, not cryptographic proof from a
  downstream tool call. Run one gate instance per agent and keep its config
  and environment outside the agent's write access.
- A downstream MCP server is a privileged payment component. Give each child
  only the environment variables it requires, pin and review its exact package
  version (never an unversioned `npx -y` target), and prefer provider-side
  idempotency keys.
- Approval files contain the exact parked tool arguments and may retain
  downstream results. They can include customer or payment data. The files are
  owner-only, but any user with access to the data directory can read or
  replace them; define a secure archive/retention process for long-lived gates.
- Webhooks receive only approval summaries. Buzz channel posts are also
  summaries and raw tool arguments remain in the local approval store, but
  their recipient scope is controlled by the configured channel and relay.
- The local ledger is tamper-evident, not tamper-proof. A writer who controls
  the data directory can rebuild the chain, and tail truncation needs an
  externally anchored head hash to detect.

## Approval execution semantics

Human-approved calls are durably claimed before the downstream side effect.
That gives at-most-once automatic execution across process retries and
restarts. It cannot guarantee exactly-once execution across a crash or network
partition: if the provider may have acted but the response was not persisted,
the approval remains `in_progress` and Axiru refuses to retry it. Reconcile the
provider manually, then record the verified state with
`buzz-axiru reconcile <id> --outcome executed|failed --note <evidence>`. While
the outcome is ambiguous, its policy-currency amount remains reserved in
rolling spend history.

Direct policy-allowed calls are not stored as executable approvals and are not
deduplicated by Axiru. Configure an idempotency key at the payment provider for
all money-moving operations.

## Production checklist

1. Run `buzz-axiru doctor` and require a zero exit status before serving.
2. Set `BUZZ_AXIRU_AGENT_PUBKEY` (or `agent_pubkey`) uniquely per gate.
3. Put every money-moving server behind a stable `tool_prefix` and gate that
   prefix. Review `tools/list` again after every downstream upgrade.
4. Configure at least one spend control and verify every amount/currency
   mapping. Unknown amounts require explicit human acknowledgement.
5. Keep secrets out of `policies.json`. Use the narrowest possible
   `env_passthrough` allowlist; never use `all` in production.
6. Keep the agent from writing the executable, config, data directory, payment
   credentials, and downstream package installation.
7. Use provider idempotency keys and document how operators reconcile an
   approval left `in_progress`.
8. Configure a Buzz channel or webhook, test delivery, and monitor the local
   `pending` queue as a fallback.
9. Run `buzz-axiru verify` regularly and anchor the reported head hash outside
   the gate host when tail-deletion detection matters.
10. Use one policy currency per gate and separate data directories for
    independently denominated policy packs.

Run only one serving gate process per data directory. The operator CLI can
share that directory, but two serving processes can evaluate the same spend
history concurrently before either downstream execution is recorded.
