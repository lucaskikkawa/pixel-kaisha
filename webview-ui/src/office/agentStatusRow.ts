export interface AgentStatusRow {
  name: string;
  source: string;
  state: string;
  tool: string;
  elapsed: string;
}

export function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function stateStartedAt(
  previous: { signature: string; at: number } | undefined,
  signature: string,
  now: number,
): { signature: string; at: number } {
  return previous?.signature === signature ? previous : { signature, at: now };
}

export function makeAgentStatusRow(
  fields: Omit<AgentStatusRow, 'elapsed'>,
  elapsedSeconds: number,
): AgentStatusRow {
  return { ...fields, elapsed: formatElapsed(elapsedSeconds) };
}
