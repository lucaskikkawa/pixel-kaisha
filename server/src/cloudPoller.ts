/**
 * Cloud poller (Pixel Kaisha): polls a PollProvider while a client is
 * connected, diffs the task list against a persisted snapshot, turns the diff
 * into AgentEvents per task and broadcasts a `cloudAgents` snapshot to the
 * office (format: docs/kaisha/protocol-cloud.md).
 *
 * Never throws into the server: any provider failure becomes
 * `status: 'unavailable'` plus exponential backoff.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentEvent, CloudTask, PollProvider } from '../../core/src/provider.js';

/** Last `cloudAgents` message per provider, re-sent to each client on connect. */
const latestByProvider = new Map<string, Record<string, unknown>>();

export function latestCloudMessages(): Record<string, unknown>[] {
  return [...latestByProvider.values()];
}

export type CloudAvailability = 'ok' | 'unavailable' | 'unconfigured';

export interface CloudTaskChange {
  taskId: string;
  change: 'added' | 'updated' | 'removed';
  events: AgentEvent[];
}

interface SnapshotEntry {
  status: CloudTask['status'];
  rawStatus: string;
  updatedAt?: string;
}
type Snapshot = Record<string, SnapshotEntry>;

/** AgentEvents that bring a viewer from `prev` (absent = never seen) to `next`. */
function eventsFor(prev: SnapshotEntry | undefined, next: CloudTask): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (!prev) events.push({ kind: 'sessionStart', source: 'cloud' });
  if (prev && prev.status === next.status && prev.updatedAt === next.updatedAt) return events;
  switch (next.status) {
    case 'active':
      events.push({ kind: 'toolStart', toolId: `cloud-${next.id}`, toolName: 'cloud', input: {} });
      break;
    case 'done':
      if (prev?.status === 'active') events.push({ kind: 'toolEnd', toolId: `cloud-${next.id}` });
      events.push({ kind: 'turnEnd' });
      break;
    case 'failed':
      if (prev?.status === 'active') events.push({ kind: 'toolEnd', toolId: `cloud-${next.id}` });
      events.push({ kind: 'turnEnd', awaitingInput: true });
      break;
    default:
      break;
  }
  return events;
}

/** Pure diff between a snapshot and a fresh task list. */
export function diffCloudTasks(prev: Snapshot, tasks: readonly CloudTask[]): CloudTaskChange[] {
  const changes: CloudTaskChange[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    seen.add(task.id);
    const before = prev[task.id];
    const events = eventsFor(before, task);
    if (!before) changes.push({ taskId: task.id, change: 'added', events });
    else if (events.length > 0) changes.push({ taskId: task.id, change: 'updated', events });
  }
  for (const id of Object.keys(prev)) {
    if (!seen.has(id)) {
      changes.push({
        taskId: id,
        change: 'removed',
        events: [{ kind: 'sessionEnd', reason: 'gone' }],
      });
    }
  }
  return changes;
}

export function snapshotOf(tasks: readonly CloudTask[]): Snapshot {
  const out: Snapshot = {};
  for (const t of tasks)
    out[t.id] = { status: t.status, rawStatus: t.rawStatus, updatedAt: t.updatedAt };
  return out;
}

export interface CloudPollerOptions {
  provider: PollProvider;
  /** Where the snapshot is persisted (JSON). */
  statePath: string;
  /** How many viewers are connected; nothing is polled at 0. */
  subscriberCount: () => number;
  /** Diff of each successful poll, as AgentEvents per task. */
  onChanges?: (changes: CloudTaskChange[]) => void;
  /** Delivers `cloudAgents` messages to the office. */
  broadcast: (message: Record<string, unknown>) => void;
  /** Max backoff after failures, ms (default 15 min). */
  maxBackoffMs?: number;
  /** How often to check for (new) viewers, ms (default 2 s). */
  watchMs?: number;
  /** Injectable clock/timers for tests. */
  now?: () => number;
}

export class CloudPoller {
  private snapshot: Snapshot;
  private tasks: CloudTask[] = [];
  private availability: CloudAvailability = 'ok';
  private reason: string | undefined;
  private failures = 0;
  private nextPollAt = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: CloudPollerOptions) {
    this.now = opts.now ?? Date.now;
    this.snapshot = this.loadSnapshot();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.maybePoll(), this.opts.watchMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Current backoff delay after `failures` consecutive failures. */
  backoffMs(): number {
    if (this.failures === 0) return this.opts.provider.intervalMs;
    const max = this.opts.maxBackoffMs ?? 15 * 60_000;
    return Math.min(max, this.opts.provider.intervalMs * 2 ** this.failures);
  }

  /** Poll if someone is watching and it is time. A viewer that connects
   *  between polls gets the last message from `latestCloudMessages()`. */
  async maybePoll(): Promise<void> {
    if (this.opts.subscriberCount() === 0 || this.running) return;
    if (this.now() < this.nextPollAt) return;
    await this.pollOnce();
  }

  /** One poll: list, diff, persist, broadcast. Never throws. */
  async pollOnce(): Promise<CloudTaskChange[]> {
    this.running = true;
    try {
      if (!(await this.opts.provider.isConfigured().catch(() => false))) {
        this.availability = 'unconfigured';
        this.reason = `${this.opts.provider.displayName} CLI not found`;
        this.failures = Math.min(this.failures + 1, 10);
        this.nextPollAt = this.now() + this.backoffMs();
        this.publish();
        return [];
      }
      const tasks = await this.opts.provider.listTasks();
      const changes = diffCloudTasks(this.snapshot, tasks);
      this.tasks = tasks;
      this.snapshot = snapshotOf(tasks);
      this.availability = 'ok';
      this.reason = undefined;
      this.failures = 0;
      this.nextPollAt = this.now() + this.backoffMs();
      this.saveSnapshot();
      this.opts.onChanges?.(changes);
      this.publish();
      return changes;
    } catch (err) {
      this.availability = 'unavailable';
      this.reason = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);
      this.failures = Math.min(this.failures + 1, 10);
      this.nextPollAt = this.now() + this.backoffMs();
      console.warn(
        `[Pixel Kaisha] ${this.opts.provider.displayName} unavailable (retry in ${Math.round(this.backoffMs() / 1000)}s): ${this.reason}`,
      );
      this.publish();
      return [];
    } finally {
      this.running = false;
    }
  }

  getAvailability(): CloudAvailability {
    return this.availability;
  }

  /** The `cloudAgents` wire message (docs/kaisha/protocol-cloud.md): full
   *  task snapshot with the vendor's raw status; tasks omitted while the
   *  provider is unavailable so the UI keeps (and greys out) the last list. */
  cloudAgentsMessage(): Record<string, unknown> {
    const available = this.availability === 'ok';
    const message: Record<string, unknown> = {
      type: 'cloudAgents',
      providerId: this.opts.provider.id,
      providerName: this.opts.provider.displayName,
      available,
    };
    if (!available && this.reason) message.reason = this.reason;
    if (available) {
      message.tasks = this.tasks.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        status: t.rawStatus,
        updatedAt: t.updatedAt,
      }));
    }
    return message;
  }

  private publish(): void {
    const message = this.cloudAgentsMessage();
    latestByProvider.set(this.opts.provider.id, message);
    this.opts.broadcast(message);
  }

  private loadSnapshot(): Snapshot {
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as unknown;
      const byProvider = (raw as Record<string, unknown>)?.[this.opts.provider.id];
      return typeof byProvider === 'object' && byProvider !== null ? (byProvider as Snapshot) : {};
    } catch {
      return {};
    }
  }

  private saveSnapshot(): void {
    try {
      let all: Record<string, unknown> = {};
      try {
        all = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as Record<string, unknown>;
      } catch {
        /* first write */
      }
      all[this.opts.provider.id] = this.snapshot;
      fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.opts.statePath);
    } catch (err) {
      console.warn(`[Pixel Kaisha] could not persist cloud snapshot: ${String(err)}`);
    }
  }
}
