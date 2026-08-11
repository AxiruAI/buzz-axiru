# Onboarding copy change for the website (/open-source/buzz)

The /open-source/buzz page cannot be edited from this repository. Apply this
copy change on the next website pass. It matches the 0.5.2 CLI and README.

## Why

Verified field findings, 0.5.1 and 0.5.2:

- Buzz Desktop gives imported and custom agents an empty `mcp_command` and
  exposes no UI to set it, and `BUZZ_ACP_MCP_COMMAND` is on the app's
  reserved environment variable list. The page's current step 3
  (`export BUZZ_ACP_MCP_COMMAND=buzz-axiru`) therefore does nothing for
  Buzz Desktop users, which is most of the audience arriving from that page.
- Editing `mcp_command` in `managed-agents.json` (the 0.5.1 adopt approach)
  does not work either: Desktop injects `BUZZ_ACP_MCP_COMMAND` first in the
  agent child's envp and the first duplicate wins. The working path, and
  what `buzz-axiru adopt` does as of 0.5.2, is a custom harness that passes
  buzz-acp's `--mcp-command` argv flag, plus the agent's `runtime` pointing
  at it.
- Agents cannot verify the gate from the inside by looking around: the
  wiring is an argv flag (no env var to inspect) and tool names are
  identical in passthrough. Asked "is your gate live", agents guessed and
  misreported. 0.5.2 adds the `axiru_gate_status` MCP tool for exactly this.

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
> `adopt` creates an "Axiru Gated" harness for your agent and points the
> agent's runtime at it, with a timestamped backup and a confirmation
> prompt before anything is written. Reopen Buzz, set the agent's model
> explicitly (custom harnesses do not inherit a default model), restart the
> agent, and verify:
>
> ```bash
> buzz-axiru doctor
> ```
>
> Then, in the agent's channel, ask the agent to call its
> `axiru_gate_status` tool and paste the result. That tool only exists when
> traffic routes through the gate, so its JSON is proof, not vibes.

## Agent card guidance

Wherever the agent-card prompt text is maintained (it does not live in this
repository), update the verification line. Old guidance asked the agent to
"confirm your gate is live", which the agent cannot actually determine by
inspection and will get wrong. Recommended new verification line for the
card:

> To verify your spend gate, call the `axiru_gate_status` tool and report
> its JSON. If the tool does not exist, say so plainly: it means your tool
> traffic is NOT routed through buzz-axiru.

Notes for the website pass:

- No em-dashes anywhere in the copy (brand test enforces this on marketing
  files).
- Link "adopt" to the README section "Buzz Desktop: buzz-axiru adopt" on
  GitHub.
- If the page shows a single copy-paste "three steps" block, split step 3
  into 3a/3b as above rather than adding a fourth step, so the step count
  in surrounding prose stays correct.
