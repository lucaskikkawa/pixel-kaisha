/**
 * Dev mock of the B2.1 agent summaries (Pixel Kaisha F2.1): plays
 * summaryFixture.ts as window messages (same path as browserMock). Enabled in
 * Vite dev with `?mock=summary` (`&labels=1` turns the labels on, to see the
 * balloon stacked over them; `&live=1` plays the updates).
 */

import { MOCK_SUMMARY_AGENTS, mockSummaryUpdates } from './summaryFixture.js';

export function isSummaryMockEnabled(search: string): boolean {
  return new URLSearchParams(search).get('mock') === 'summary';
}

/** Dispatch the fixture as window messages (same path as browserMock). */
export function dispatchSummaryMock(search: string): () => void {
  const params = new URLSearchParams(search);
  const dispatch = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
  dispatch({
    type: 'settingsLoaded',
    soundEnabled: false,
    alwaysShowLabels: params.get('labels') === '1',
    extensionVersion: '1.6.0',
    lastSeenVersion: '1.6.0',
    hooksEnabled: true,
    hooksInfoShown: true,
  });
  dispatch({ type: 'hooksStatus', providerId: 'claude', installed: true });
  for (const a of MOCK_SUMMARY_AGENTS) {
    dispatch({
      type: 'agentCreated',
      id: a.id,
      providerId: a.providerId,
      directoryName: a.directoryName,
      speech: a.speech,
      action: a.action,
    });
    if (a.action) {
      dispatch({ type: 'agentToolStart', id: a.id, toolId: `mock-${a.id}`, status: a.action });
      dispatch({ type: 'agentStatus', id: a.id, status: 'active' });
    }
  }
  if (params.get('live') !== '1') return () => {};
  let step = 0;
  const timer = window.setInterval(() => {
    step += 1;
    for (const m of mockSummaryUpdates(step)) dispatch(m);
    if (step >= 2) window.clearInterval(timer);
  }, 4000);
  return () => window.clearInterval(timer);
}
