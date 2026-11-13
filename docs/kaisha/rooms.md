# Office rooms fixture

From the repository root, run `npm run dev` in `webview-ui/` and open
`http://localhost:5173/?mock=rooms`. The fixture uses IDs 31–33 and an
`existingAgents.rooms` snapshot to place Claude in work, Codex in meeting, and
agy in the rest lounge. It does not connect to a server or use real agent IDs.

Add `&live=1` to see an authoritative room update move the idle agy character
to work, followed by a meeting assignment for the active Claude character.
Activity does not release that meeting hold. In a live office, select **Meet**
or **Release** in the Status panel to send one `setAgentRoom` message for the
selected agent.
