import { afterEach, describe, expect, it, vi } from 'vitest';

import { noticeForTransition, notifyAgent, shouldNotify } from '../src/agentNotifications.js';
import { makeAgentStatusRow, stateStartedAt } from '../src/office/agentStatusRow.js';

describe('browser notification transition rules', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('notifies on entering waiting and done, once per state transition', () => {
    expect(noticeForTransition('other', 'waiting')).toBe('waiting');
    expect(noticeForTransition('waiting', 'waiting')).toBeNull();
    expect(noticeForTransition('other', 'done')).toBe('done');
    expect(noticeForTransition('done', 'done')).toBeNull();
  });
  it('does not notify for other states', () => {
    expect(noticeForTransition('waiting', 'other')).toBeNull();
  });
  it('respects denied permission and an off preference', () => {
    expect(shouldNotify(true, 'denied')).toBe(false);
    expect(shouldNotify(false, 'granted')).toBe(false);
    expect(shouldNotify(true, 'granted')).toBe(true);
  });
  it('uses the mocked Notification API only when enabled and granted', () => {
    const constructor = vi.fn();
    const MockNotification = Object.assign(constructor, { permission: 'granted' as const });
    vi.stubGlobal('Notification', MockNotification);
    vi.stubGlobal('localStorage', { getItem: () => 'true', setItem: vi.fn() });
    expect(notifyAgent('Agent 1', 'waiting')).toBe(true);
    expect(constructor).toHaveBeenCalledOnce();
    vi.stubGlobal('localStorage', { getItem: () => 'false', setItem: vi.fn() });
    expect(notifyAgent('Agent 1', 'done')).toBe(false);
    expect(constructor).toHaveBeenCalledOnce();
    vi.stubGlobal('Notification', Object.assign(constructor, { permission: 'denied' as const }));
    vi.stubGlobal('localStorage', { getItem: () => 'true', setItem: vi.fn() });
    expect(notifyAgent('Agent 1', 'done')).toBe(false);
    expect(constructor).toHaveBeenCalledOnce();
  });
});

describe('agent status panel rows', () => {
  it('renders its five fields and resets elapsed time when state changes', () => {
    const row = makeAgentStatusRow(
      { name: 'Agent 1', source: 'Claude', state: 'Working', tool: 'Reading auth.ts' },
      65,
    );
    expect(row).toEqual({
      name: 'Agent 1',
      source: 'Claude',
      state: 'Working',
      tool: 'Reading auth.ts',
      elapsed: '1:05',
    });
    expect(stateStartedAt({ signature: 'Working', at: 10 }, 'Waiting', 30)).toEqual({
      signature: 'Waiting',
      at: 30,
    });
  });
});
