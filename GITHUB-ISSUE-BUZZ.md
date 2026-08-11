# Ready-to-file upstream issue for github.com/block/buzz

Title:

```
Desktop: per-agent mcpCommand cannot be set or honored (no UI field, reserved env var, envp duplicate wins, silent bundle fallback)
```

Body:

---

## Summary

There is currently no supported way to route a Buzz Desktop agent's MCP
traffic through an operator-chosen server. The backend stores a per-agent
`mcpCommand` in `managed-agents.json`, but the value cannot be set from the
UI, and even when set by hand it is not honored, because the Desktop app
injects its own `BUZZ_ACP_MCP_COMMAND` ahead of it. The one working path we
found is a custom harness that passes buzz-acp's `--mcp-command` argv flag.

This blocks a real use case: wiring a gating or auditing MCP proxy (spend
controls, human approvals, decision logging) in front of an agent's tools.
With raw `buzz-acp` in a terminal this is a one-line env var export; under
Desktop it takes a hand-written harness file.

## Evidence chain (all reproduced on a real machine)

1. **No UI field.** Custom and imported agents are created with
   `mcpCommand: ""`. UserProfilePanel renders the field read-only and hides
   the row entirely when it is empty, so affected users never see that the
   field exists. The edit-agent dialog has no input for it.

2. **The env var is reserved.** `BUZZ_ACP_MCP_COMMAND` is on Desktop's
   reserved environment variable list; setting it in an agent's environment
   configuration is rejected.

3. **Hand-editing the record does not work either.** With the app closed we
   set the agent's `mcp_command` in `managed-agents.json` to an absolute
   path to our proxy. On launch, Desktop builds the agent child's
   environment with `BUZZ_ACP_MCP_COMMAND=<bundled buzz-dev-mcp>` FIRST in
   the envp, and appends overrides after it. buzz-acp reads the first
   occurrence of a duplicated variable, so the appended value loses and the
   bundled server wins, silently.

4. **Bare names fall back to the bundle directory, silently.** When the
   command is a bare name rather than an absolute path, resolution falls
   back to the app bundle's own directory instead of failing or consulting
   PATH. A user who writes `mcpCommand: "my-proxy"` gets the bundled
   behavior with no error, which makes the previous two problems very hard
   to diagnose.

5. **The argv flag is the only working override.** buzz-acp's
   `--mcp-command <path>` flag takes precedence over the env var. The only
   place Desktop lets an operator supply argv is a custom harness file
   (`custom_harnesses/*.json` with `command` pointing at
   `/Applications/Buzz.app/Contents/MacOS/buzz-acp` and
   `args: ["--mcp-command", "<absolute path>"]` as two separate elements),
   with the agent record's `runtime` referencing that harness. This works,
   but it is undocumented, loses the default model inheritance, and is
   clearly not the intended interface.

## Concrete asks

1. **Expose `mcpCommand` in the UI.** The backend support already exists
   (`update_managed_agent` accepts it). A single text input in the
   edit-agent form for custom and imported agents would be enough, and
   showing the read-only value in UserProfilePanel even when empty would
   help discoverability.

2. **Honor the agent-record value.** When an agent's `mcpCommand` is
   non-empty, pass it to buzz-acp in a way that wins (for example via
   `--mcp-command`, which already takes precedence), instead of losing the
   envp duplicate race to the injected default.

3. **Error instead of silent fallback.** If a configured command cannot be
   resolved, fail the agent launch with a message naming the command,
   rather than silently substituting the bundled server. A user who asked
   for a gating proxy and silently got an ungated server is the worst
   possible failure mode when the proxy exists to control spending.

## Related

#2899 (related context on managed agent configuration surfaces)

Happy to provide more detail, exact reproduction steps, or to test a build.
Thanks for Buzz!
