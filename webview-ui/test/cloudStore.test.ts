/**
 * Pixel Kaisha cloud ghosts: the `cloudAgents` message (B3 poller → UI),
 * status mapping, the unavailable state, URL safety and the dev fixture.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { mockCloudMessage } from '../src/cloud/cloudMock.js';
import {
  cloudProviders,
  cloudStatus,
  handleCloudMessage,
  resetCloudStoreForTests,
  safeTaskUrl,
  subscribeCloud,
} from '../src/cloud/cloudStore.js';
import {
  agentEngineBadge,
  engineBadgeFor,
  forgetAgentProvider,
  resetEngineBadgesForTests,
  setAgentProvider,
} from '../src/cloud/engineBadge.js';

beforeEach(() => {
  resetCloudStoreForTests();
  resetEngineBadgesForTests();
});

test('raw vendor statuses map to ghost statuses; unknown never throws', () => {
  assert.equal(cloudStatus('ready'), 'ready');
  assert.equal(cloudStatus('READY'), 'ready');
  assert.equal(cloudStatus('running'), 'active');
  assert.equal(cloudStatus('pending'), 'active');
  assert.equal(cloudStatus('failed'), 'error');
  assert.equal(cloudStatus('something-new'), 'unknown');
  assert.equal(cloudStatus(undefined), 'unknown');
  assert.equal(cloudStatus('ready', false), 'unavailable');
});

test('a snapshot replaces the provider task list', () => {
  let calls = 0;
  subscribeCloud(() => calls++);
  assert.equal(handleCloudMessage(mockCloudMessage(0)), true);
  const [p] = cloudProviders();
  assert.equal(p.providerId, 'codex-cloud');
  assert.equal(p.providerName, 'Codex Cloud');
  assert.deepEqual(
    p.tasks.map((t) => t.status),
    ['active', 'ready', 'error'],
  );
  handleCloudMessage({ ...mockCloudMessage(2), tasks: mockCloudMessage(2).tasks.slice(0, 1) });
  assert.equal(cloudProviders()[0].tasks.length, 1);
  assert.equal(cloudProviders()[0].tasks[0].status, 'ready');
  assert.equal(calls, 2);
});

test('unavailable keeps the last tasks, greyed out', () => {
  handleCloudMessage(mockCloudMessage(0));
  handleCloudMessage({
    type: 'cloudAgents',
    providerId: 'codex-cloud',
    available: false,
    reason: 'not signed in',
  });
  const [p] = cloudProviders();
  assert.equal(p.available, false);
  assert.equal(p.reason, 'not signed in');
  assert.equal(p.tasks.length, 3);
  assert.ok(p.tasks.every((t) => t.status === 'unavailable'));
  handleCloudMessage(mockCloudMessage(2));
  assert.equal(cloudProviders()[0].tasks[0].status, 'ready');
});

test('malformed messages are consumed without crashing; others are ignored', () => {
  assert.equal(handleCloudMessage({ type: 'cloudAgents' }), true);
  assert.equal(
    handleCloudMessage({
      type: 'cloudAgents',
      providerId: 'x',
      tasks: [null, 1, { title: 'no id' }],
    }),
    true,
  );
  assert.equal(cloudProviders()[0].tasks.length, 0);
  assert.equal(handleCloudMessage({ type: 'agentCreated', id: 1 }), false);
});

test('a task without title shows its id', () => {
  handleCloudMessage({
    type: 'cloudAgents',
    providerId: 'codex-cloud',
    available: true,
    tasks: [{ id: 'task_e_x', url: 'https://chatgpt.com/codex/tasks/task_e_x', status: 'ready' }],
  });
  assert.equal(cloudProviders()[0].tasks[0].title, 'task_e_x');
});

test('only http(s) task URLs can be opened', () => {
  assert.equal(
    safeTaskUrl('https://chatgpt.com/codex/tasks/task_e_1'),
    'https://chatgpt.com/codex/tasks/task_e_1',
  );
  assert.equal(safeTaskUrl('javascript:alert(1)'), null);
  assert.equal(safeTaskUrl('not a url'), null);
  assert.equal(safeTaskUrl(undefined), null);
});

test('engine badges: claude by default, codex and agy when tagged', () => {
  assert.equal(agentEngineBadge(1).label, 'Claude');
  setAgentProvider(2, 'codex');
  setAgentProvider(3, 'agy');
  setAgentProvider(4, 42);
  assert.equal(agentEngineBadge(2).label, 'Codex');
  assert.equal(agentEngineBadge(3).label, 'agy');
  assert.equal(agentEngineBadge(4).label, 'Claude');
  assert.equal(engineBadgeFor('gemini').label, 'gemini');
  forgetAgentProvider(2);
  assert.equal(agentEngineBadge(2).label, 'Claude');
});
