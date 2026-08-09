# Onboarding copy change for the website (/open-source/buzz)

The /open-source/buzz page cannot be edited from this repository. Apply this
copy change on the next website pass. It matches the 0.5.1 CLI and README.

## Why

Verified field finding: Buzz Desktop gives imported and custom agents an
empty `mcp_command` and exposes no UI to set it, and `BUZZ_ACP_MCP_COMMAND`
is on the app's reserved environment variable list. The page's current
step 3 (`export BUZZ_ACP_MCP_COMMAND=buzz-axiru`) therefore does nothing for
Buzz Desktop users, which is most of the audience arriving from that page.
The working path is `buzz-axiru adopt` (new in 0.5.1), which edits the app's
`managed-agents.json` while the app is closed.

## Change

Keep the env-var instructions, but scope them to raw `buzz-acp` (terminal)
users only. For Buzz Desktop, replace step 3 with the adopt flow.

Suggested copy (replace the current step 3 block):

> **3a. Raw buzz-acp (terminal):** point it at the gate and restart the
> agent:
>
> ```bash
> export BUZZ_ACP_MCP_COMMAND=buzz-axiru
> ```
>
> **3b. Buzz Desktop:** the app reserves that variable and has no settings
> field for it, so use the adopt command instead. Quit Buzz Desktop
> completely, then:
>
> ```bash
> buzz-axiru adopt --agent <your-agent-name>
> ```
>
> Reopen Buzz, restart the agent, and verify:
>
> ```bash
> buzz-axiru quickstart --check
> ```
>
> Then ask in the agent's channel: `@Axiru confirm your gate is live`.
>
> `adopt` finds Buzz's `managed-agents.json`, backs it up with a timestamp,
> shows you the one-field change, and asks before writing. It refuses to run
> while Buzz Desktop is open, because the app rewrites that file live.

Notes for the website pass:

- No em-dashes anywhere in the copy (brand test enforces this on marketing
  files).
- Link "adopt" to the README section "Buzz Desktop: buzz-axiru adopt" on
  GitHub.
- If the page shows a single copy-paste "three steps" block, split step 3
  into 3a/3b as above rather than adding a fourth step, so the step count
  in surrounding prose stays correct.
