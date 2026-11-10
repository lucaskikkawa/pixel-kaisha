/**
 * Dev fixture for the B3 cloud poller: dispatches the same `cloudAgents`
 * messages the server will send (see cloudStore.ts), plus three local agents
 * tagged with their engine. Enabled in Vite dev with `?mock=cloud`
 * (`&cloud=unavailable` shows the logged-out / offline state).
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

export function isCloudMockEnabled(search: string): boolean {
  return new URLSearchParams(search).get('mock') === 'cloud';
}

/** Dispatch the fixture as window messages (same path as browserMock). */
export function dispatchCloudMock(search: string): () => void {
  const params = new URLSearchParams(search);
  const unavailable = params.get('cloud') === 'unavailable';
  const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
  // Labels always on, so the engine badges show without hovering.
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    alwaysShowLabels: true,
    extensionVersion: '1.6.0',
    lastSeenVersion: '1.6.0',
  });
  for (const a of MOCK_LOCAL_AGENTS) {
    dispatch({
      type: 'agentCreated',
      id: a.id,
      providerId: a.providerId,
      directoryName: a.directoryName,
    });
  }
  dispatch({
    type: 'agentToolStart',
    id: 101,
    toolId: 'mock-t1',
    status: 'Editing calc.ts',
    toolName: 'Edit',
  });
  dispatch({ type: 'agentStatus', id: 101, status: 'active' });
  dispatch({
    type: 'agentToolStart',
    id: 102,
    toolId: 'mock-t2',
    status: 'Running tests',
    toolName: 'Bash',
  });
  dispatch({ type: 'agentStatus', id: 102, status: 'active' });
  let step = 0;
  dispatch(mockCloudMessage(step, unavailable));
  // Simulate the 60 s poll, sped up: the running task turns ready.
  const timer = window.setInterval(() => {
    step += 1;
    dispatch(mockCloudMessage(step, unavailable));
    if (step >= 2) window.clearInterval(timer);
  }, 4000);
  return () => window.clearInterval(timer);
}
