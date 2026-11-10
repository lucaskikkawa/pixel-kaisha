/**
 * Fixture data for the B3 cloud poller: the same `cloudAgents` messages the
 * server will send (see cloudStore.ts), plus three local agents tagged with
 * their engine. No DOM here, so tests can import it; cloudMock.ts plays it.
 *
 * Shapes follow docs/research/codex-cloud-output.md (anonymised; no real ids).
 */

export const MOCK_LOCAL_AGENTS = [
  { id: 101, providerId: 'claude', directoryName: 'sandbox' },
  { id: 102, providerId: 'codex', directoryName: 'sandbox' },
  { id: 103, providerId: 'agy', directoryName: 'sandbox' },
] as const;

export function mockCloudTasks(step: number) {
  return [
    {
      id: 'task_e_mock0001',
      url: 'https://chatgpt.com/codex/tasks/task_e_mock0001',
      title: 'Calculadora simples',
      status: step < 2 ? 'running' : 'ready',
      updatedAt: '2026-11-10T16:00:00.000Z',
    },
    {
      id: 'task_e_mock0002',
      url: 'https://chatgpt.com/codex/tasks/task_e_mock0002',
      title: 'README em inglês',
      status: 'ready',
      updatedAt: '2026-11-10T15:40:00.000Z',
    },
    {
      id: 'task_e_mock0003',
      url: 'https://chatgpt.com/codex/tasks/task_e_mock0003',
      title: 'Testes do poller',
      status: 'failed',
      updatedAt: '2026-11-10T15:20:00.000Z',
    },
  ];
}

/** Message the poller would send at a given poll `step`. */
export function mockCloudMessage(step: number, unavailable = false) {
  if (unavailable) {
    return {
      type: 'cloudAgents',
      providerId: 'codex-cloud',
      providerName: 'Codex Cloud',
      available: false,
      reason: 'codex cloud: not signed in',
      tasks: mockCloudTasks(0),
    };
  }
  return {
    type: 'cloudAgents',
    providerId: 'codex-cloud',
    providerName: 'Codex Cloud',
    available: true,
    tasks: mockCloudTasks(step),
  };
}
