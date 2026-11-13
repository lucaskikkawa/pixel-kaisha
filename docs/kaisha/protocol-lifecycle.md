# Hook lifecycle

## agy sessions

The installed agy 1.5.7 hook set has `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`; it has no session-end event. `Stop` means a turn ended. In particular, `NO_TOOL_CALL` and `fullyIdle` describe turn/background-task completion, not the end of an interactive session. The hook forwards the agy CLI pid as `cli_pid`; the server watches that process and feeds a synthetic `SessionEnd(reason=process_exit)` through the normal lifecycle handler when it exits. The payload may also carry `termination_reason` and `fully_idle`, but neither alone ends a session. Prompts are not forwarded.

## Residual agents

An external root agent is residual only when `now - lastDataAt > 10 minutes` and it has no active session or process. The exact ten-minute boundary is retained. A live terminal/PTY, a live reported CLI pid, or active hook work (active turn, tool, or background spawn) keeps an agent alive. If there is no reliable pid, a hooks-only agent is retained while its turn is active; transcript-only agents are conservatively retained. Agents with unknown activity are kept. A restored agent's idle clock starts at restore time, giving it ten minutes to report another hook. Child agents leave with their lead.

## Codex subagents

Codex `SubagentStart` creates a child office agent with `parentAgentId`/`leadAgentId` pointing to the parent and the Codex `agent_id` as its key. `SubagentStop` closes just that child. Ending the parent session removes its children as well.
