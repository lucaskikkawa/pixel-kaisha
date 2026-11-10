import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CloudTask, PollProvider } from '../../core/src/provider.js';
import {
  CloudPoller,
  diffCloudTasks,
  latestCloudMessages,
  snapshotOf,
} from '../src/cloudPoller.js';
import {
  createCodexCloudProvider,
  mapCodexCloudStatus,
  parseCodexCloudPage,
} from '../src/providers/poll/codexCloud/codexCloud.js';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'codexCloud', name), 'utf8');

describe('codex-cloud adapter (fixtures)', () => {
  it('parses the observed list --json shape', () => {
    const { tasks, cursor } = parseCodexCloudPage(fixture('list-observed.json'));
    expect(cursor).toBeUndefined();
    expect(tasks).toEqual([
      {
        id: 'task_e_example1',
        title: 'Summarize the repository',
        status: 'done',
        rawStatus: 'ready',
        url: 'https://chatgpt.com/codex/tasks/task_e_example1',
        updatedAt: '2026-06-29T14:29:19.349145889Z',
        environment: 'calculator',
      },
    ]);
  });

  it('maps statuses tolerantly', () => {
    expect(mapCodexCloudStatus('ready')).toBe('done');
    expect(mapCodexCloudStatus('PENDING')).toBe('active');
    expect(mapCodexCloudStatus('in_progress')).toBe('active');
    expect(mapCodexCloudStatus('error')).toBe('failed');
    expect(mapCodexCloudStatus('some_new_status')).toBe('unknown');
  });

  it('rejects output it does not understand', () => {
    expect(() => parseCodexCloudPage('{"items":[]}')).toThrow(/unexpected/);
    expect(() => parseCodexCloudPage('not json')).toThrow();
  });

  it('follows the cursor, runs read-only list commands outside the repo', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const provider = createCodexCloudProvider(
      async (args, cwd) => {
        calls.push({ args, cwd });
        return args.includes('--cursor') ? fixture('list-page2.json') : fixture('list-page1.json');
      },
      () => true,
    );
    const tasks = await provider.listTasks();
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['task_e_example2', 'active'],
      ['task_e_example3', 'done'],
      ['task_e_example4', 'failed'],
      ['task_e_example5', 'unknown'],
    ]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.args.slice(0, 3)).toEqual(['cloud', 'list', '--json']);
      expect(c.args).not.toContain('exec');
      expect(c.cwd.startsWith(os.tmpdir())).toBe(true);
    }
    expect(calls[1].args).toContain('cursor-page-2');
  });
});

const task = (id: string, status: CloudTask['status'], updatedAt = 't1'): CloudTask => ({
  id,
  title: id,
  status,
  rawStatus: status,
  updatedAt,
});

describe('diffCloudTasks', () => {
  it('new done task: sessionStart + turnEnd', () => {
    expect(diffCloudTasks({}, [task('a', 'done')])).toEqual([
      {
        taskId: 'a',
        change: 'added',
        events: [{ kind: 'sessionStart', source: 'cloud' }, { kind: 'turnEnd' }],
      },
    ]);
  });

  it('active -> done: toolEnd + turnEnd; unchanged task: nothing', () => {
    const prev = snapshotOf([task('a', 'active'), task('b', 'done')]);
    const changes = diffCloudTasks(prev, [task('a', 'done', 't2'), task('b', 'done')]);
    expect(changes).toEqual([
      {
        taskId: 'a',
        change: 'updated',
        events: [{ kind: 'toolEnd', toolId: 'cloud-a' }, { kind: 'turnEnd' }],
      },
    ]);
  });

  it('failed asks for attention; removed ends the session', () => {
    const prev = snapshotOf([task('a', 'active'), task('gone', 'done')]);
    const changes = diffCloudTasks(prev, [task('a', 'failed', 't2')]);
    expect(changes).toContainEqual({
      taskId: 'a',
      change: 'updated',
      events: [
        { kind: 'toolEnd', toolId: 'cloud-a' },
        { kind: 'turnEnd', awaitingInput: true },
      ],
    });
    expect(changes).toContainEqual({
      taskId: 'gone',
      change: 'removed',
      events: [{ kind: 'sessionEnd', reason: 'gone' }],
    });
  });
});

describe('CloudPoller', () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaisha-poller-'));
    statePath = path.join(dir, 'cloud-state.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function provider(list: () => Promise<CloudTask[]>, configured = true): PollProvider {
    return {
      kind: 'poll',
      id: 'fake-cloud',
      displayName: 'Fake Cloud',
      intervalMs: 1000,
      isConfigured: async () => configured,
      listTasks: list,
    };
  }

  it('does not poll without a connected client', async () => {
    const list = vi.fn(async () => [task('a', 'done')]);
    const messages: Record<string, unknown>[] = [];
    const poller = new CloudPoller({
      provider: provider(list),
      statePath,
      subscriberCount: () => 0,
      broadcast: (m) => messages.push(m),
    });
    await poller.maybePoll();
    expect(list).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it('polls with a client, broadcasts cloudAgents (protocol-cloud.md) and persists the snapshot', async () => {
    const messages: Record<string, unknown>[] = [];
    const changes: unknown[] = [];
    const poller = new CloudPoller({
      provider: provider(async () => [
        { ...task('a', 'active'), rawStatus: 'pending', url: 'https://example.test/a' },
      ]),
      statePath,
      subscriberCount: () => 1,
      broadcast: (m) => messages.push(m),
      onChanges: (c) => changes.push(...c),
    });
    await poller.maybePoll();
    expect(messages[0]).toEqual({
      type: 'cloudAgents',
      providerId: 'fake-cloud',
      providerName: 'Fake Cloud',
      available: true,
      tasks: [
        { id: 'a', url: 'https://example.test/a', title: 'a', status: 'pending', updatedAt: 't1' },
      ],
    });
    expect(changes).toEqual([
      {
        taskId: 'a',
        change: 'added',
        events: [
          { kind: 'sessionStart', source: 'cloud' },
          { kind: 'toolStart', toolId: 'cloud-a', toolName: 'cloud', input: {} },
        ],
      },
    ]);
    // Re-sent to clients that connect later.
    expect(latestCloudMessages()).toContainEqual(messages[0]);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))['fake-cloud'].a.status).toBe('active');

    // A restarted poller remembers the snapshot: no duplicate "added".
    const again = new CloudPoller({
      provider: provider(async () => [task('a', 'active')]),
      statePath,
      subscriberCount: () => 1,
      broadcast: () => {},
    });
    expect(await again.pollOnce()).toEqual([]);
  });

  it('degrades to unavailable with exponential backoff and never throws', async () => {
    let now = 0;
    const messages: Record<string, unknown>[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = new CloudPoller({
      provider: provider(async () => {
        throw new Error('Not signed in');
      }),
      statePath,
      subscriberCount: () => 1,
      broadcast: (m) => messages.push(m),
      now: () => now,
    });
    await poller.maybePoll();
    expect(poller.getAvailability()).toBe('unavailable');
    expect(messages.at(-1)).toEqual({
      type: 'cloudAgents',
      providerId: 'fake-cloud',
      providerName: 'Fake Cloud',
      available: false,
      reason: 'Not signed in',
    });
    expect(poller.backoffMs()).toBe(2000);
    now = 1000; // still backing off
    await poller.maybePoll();
    expect(messages).toHaveLength(1);
    now = 2000;
    await poller.maybePoll();
    expect(poller.backoffMs()).toBe(4000);
    warn.mockRestore();
  });

  it('reports unconfigured when the CLI is missing', async () => {
    const list = vi.fn(async () => []);
    const poller = new CloudPoller({
      provider: provider(list, false),
      statePath,
      subscriberCount: () => 1,
      broadcast: () => {},
    });
    await poller.pollOnce();
    expect(poller.getAvailability()).toBe('unconfigured');
    expect(poller.cloudAgentsMessage()).toMatchObject({
      available: false,
      reason: 'Fake Cloud CLI not found',
    });
    expect(list).not.toHaveBeenCalled();
  });
});
