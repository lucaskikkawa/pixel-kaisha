// webview-ui/src/office/engine/agentSummary.ts
//
// Pixel Kaisha F2.1: an agent's balloon text — what it last said (`speech`) and
// what it is doing (`action`), exactly as the server sent it (B2.1,
// docs/kaisha/protocol-summary.md). The server already cut both to length; the
// client never invents, trims or shortens the text. DOM-free so it is unit-tested.

/** The balloon text of one agent. `speech: ''` = nothing said, `action: null` = no tool. */
export interface AgentSummaryText {
  speech: string;
  action: string | null;
}

/** A summary as any of the three messages may carry it (fields optional, values untrusted). */
export interface AgentSummaryInput {
  speech?: unknown;
  action?: unknown;
}

/**
 * Read a summary snapshot (`agentSummary`, `agentCreated.speech/action` or an
 * `existingAgents.summaries` entry). Missing or ill-typed fields read as empty.
 * Returns null when there is nothing to show at all.
 */
export function readAgentSummary(
  input: AgentSummaryInput | null | undefined,
): AgentSummaryText | null {
  if (!input || typeof input !== 'object') return null;
  const speech = typeof input.speech === 'string' ? input.speech : '';
  const action = typeof input.action === 'string' && input.action !== '' ? input.action : null;
  if (speech === '' && action === null) return null;
  return { speech, action };
}

/** What a balloon draws: each line only when it has text (hooks-only agents have no speech). */
export interface BalloonLines {
  speech: string | null;
  action: string | null;
}

/** The balloon's lines, or null when there is no balloon. Whitespace-only text shows nothing. */
export function balloonLines(summary: AgentSummaryText | null | undefined): BalloonLines | null {
  if (!summary) return null;
  const speech = summary.speech.trim() !== '' ? summary.speech : null;
  const action = summary.action !== null && summary.action.trim() !== '' ? summary.action : null;
  if (speech === null && action === null) return null;
  return { speech, action };
}

/** Minimal structural view of OfficeState the snapshot reader needs. */
export interface AgentSummaryOffice {
  setAgentSummary: (id: number, input: AgentSummaryInput | null | undefined) => void;
}

/**
 * Apply `existingAgents.summaries` (the whole truth on connect and reconnect):
 * a listed agent takes its entry, one with no entry has no summary yet. An older
 * server sends no `summaries` at all; then nothing is touched.
 */
export function applySummarySnapshot(
  os: AgentSummaryOffice,
  incoming: number[],
  summaries: Record<string, AgentSummaryInput> | null | undefined,
): void {
  if (!summaries || typeof summaries !== 'object') return;
  for (const id of incoming) os.setAgentSummary(id, summaries[String(id)]);
}
