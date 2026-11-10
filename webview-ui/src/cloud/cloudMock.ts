/**
 * Dev mock of the B3 cloud poller: plays cloudFixture.ts as window messages
 * (same path as browserMock). Enabled in Vite dev with `?mock=cloud`
 * (`&cloud=unavailable` shows the logged-out / offline state).
 */

import { MOCK_LOCAL_AGENTS, mockCloudMessage } from './cloudFixture.js';

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
