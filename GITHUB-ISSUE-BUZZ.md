# Ready-to-file upstream issue for github.com/block/buzz

Title:

```
Desktop: expose mcpCommand for custom/imported agents (backend supports it, no UI field)
```

Body:

---

## Summary

Buzz Desktop's backend fully supports a per-agent `mcpCommand` (it is stored
in `managed-agents.json` and `update_managed_agent` can change it), but the
Desktop UI never exposes the field for custom or imported agents. Those
agents are created with `mcpCommand: ""` and there is no way to set it from
inside the app.

This blocks a real use case: wiring a gating or auditing MCP proxy (spend
controls, approvals, logging) in front of an agent's tools. With raw
`buzz-acp` this is a one-line `BUZZ_ACP_MCP_COMMAND` export; under Desktop
there is currently no supported path at all.

## What we observed

- Custom and imported agents are created with `mcpCommand` copied from the
  runtime definition, which for these agents is the empty string.
- `BUZZ_ACP_MCP_COMMAND` is on Desktop's reserved environment variable list;
  setting it in an agent's environment is rejected (the reserved-list error
  string is present in the buzz-desktop binary).
- UserProfilePanel renders `mcpCommand` read-only, and hides the row
  entirely when the value is empty, so affected users never even see that
  the field exists.
- The edit-agent dialog and the custom-harness form contain no
  `mcpCommand` references at all.

Net effect: the only way to set the field today is to quit the app and hand
edit `managed-agents.json`, which is fragile (the app rewrites the file
while running) and invisible to users.

## Concrete ask

Wire the existing `update_managed_agent` `mcpCommand` support through the
edit-agent form: a single text input (with the same validation the backend
already applies) for custom and imported agents would be enough. Showing the
read-only value in UserProfilePanel even when empty would also help
discoverability.

## Related

#2899 (related context on managed agent configuration surfaces)

Happy to provide more detail or test a build. Thanks for Buzz!
