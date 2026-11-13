# Hook lifecycle

## agy sessions

The installed agy 1.5.7 hook set has `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`; it has no session-end event. `Stop` means a turn ended. In particular, `NO_TOOL_CALL` and `fullyIdle` describe turn/background-task completion, not the end of an interactive session. The hook forwards the agy CLI pid as `cli_pid`; the server watches that process and feeds a synthetic `SessionEnd(reason=process_exit)` through the normal lifecycle handler when it exits. The payload may also carry `termination_reason` and `fully_idle`, but neither alone ends a session. Prompts are not forwarded.

## Residual agents

An external root agent is residual only when `now - lastDataAt > 10 minutes` and it has no active session or process. The exact ten-minute boundary is retained. A live terminal/PTY, a live reported CLI pid, or active hook work (active turn, tool, or background spawn) keeps an agent alive. A reported CLI pid that has exited decides alone: the agent has no session, even if the dead process left a turn "active". If there is no reliable pid, the turn state is all there is, for hooks-only agents and transcript agents alike: an agent is retained while its turn, a tool, or a background spawn is active. A restored or stale transcript agent (e.g. a Claude session restored from its jsonl) with no terminal, no live pid, and a finished turn therefore follows the residual rule like any other: after ten minutes without a hook event or a transcript line it is removed. Agents whose idle clock was never stamped, agents between `SessionEnd(clear)` and their next `SessionStart`, and child agents are never removed on their own. A restored agent's idle clock starts at restore time, giving it ten minutes to report another hook or transcript line. Child agents leave with their lead.

## Codex subagents

Codex `SubagentStart` creates a child office agent with `parentAgentId`/`leadAgentId` pointing to the parent and the Codex `agent_id` as its key. `SubagentStop` closes just that child. Ending the parent session removes its children as well.
