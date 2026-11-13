/**
 * Pixel Kaisha F2.1: fixture for the speech/action balloons — the same
 * `agentCreated` / `agentSummary` messages the B2.1 server sends
 * (docs/kaisha/protocol-summary.md). No DOM here, so tests can import it;
 * summaryMock.ts plays it. Made-up text, no real ids.
 */

export const MOCK_SUMMARY_AGENTS = [
  // Claude: speech and action. The speech is the server's 80-code-point cut.
  {
    id: 201,
    providerId: 'claude',
    directoryName: 'sandbox',
    speech: 'Vou corrigir o teste de login que falha e depois rodar a suíte inteira de novo …',
    action: 'Reading auth.ts',
  },
  // Codex and agy are hooks-only: no speech, only the action.
  {
    id: 202,
    providerId: 'codex',
    directoryName: 'sandbox',
    speech: '',
    action: 'Running npm test',
  },
  { id: 203, providerId: 'agy', directoryName: 'sandbox', speech: '', action: 'Editing calc.py' },
  // Claude between tools: speech only.
  {
    id: 204,
    providerId: 'claude',
    directoryName: 'sandbox',
    speech: 'Pronto: a calculadora soma, subtrai e divide.',
    action: null,
  },
] as const;

/** The live updates after the first paint, one list per step. */
export function mockSummaryUpdates(step: number) {
  if (step === 1) {
    return [
      {
        type: 'agentSummary',
        id: 201,
        speech: MOCK_SUMMARY_AGENTS[0].speech,
        action: 'Editing auth.ts',
      },
      { type: 'agentSummary', id: 202, speech: '', action: 'Reading package.json' },
    ];
  }
  if (step === 2) {
    // The tool ended: `action: null` clears the action row, the speech stays.
    return [{ type: 'agentSummary', id: 201, speech: 'Testes verdes.', action: null }];
  }
  return [];
}
