/**
 * Cloud agents (Pixel Kaisha): tasks that run on a vendor's cloud (Codex Cloud
 * in v0.1) and show in the office as translucent ☁ ghosts.
 *
 * INTEGRATION POINT (B3 cloud poller → UI). The server sends, over the same
 * WebSocket as every other message, one additive message per poll:
 *
 *   { type: 'cloudAgents', providerId: 'codex-cloud', providerName?: string,
 *     available: boolean, reason?: string,
 *     tasks: [{ id, url, title?, status, updatedAt? }] }
 *
 * - `tasks` is the FULL current list for that provider (a snapshot, not a
 *   diff): tasks missing from it are removed.
 * - `status` is the vendor's raw value (e.g. Codex Cloud `ready`); the UI maps
 *   it (cloudStatus below), unknown values become 'unknown' and never break.
 * - `available: false` (CLI logged out, no network, exit ≠ 0) keeps the last
 *   tasks but greys them out as "unavailable" (acceptance test 7).
 *
 * A dev fixture imitating these messages lives in cloudMock.ts.
 * Kept outside React like usage/usageStore.ts.
 */

export type CloudStatus = 'active' | 'ready' | 'error' | 'unavailable' | 'unknown';

export interface CloudTask {
  id: string;
  url: string;
  title: string;
  rawStatus: string;
  status: CloudStatus;
  updatedAt?: string;
}

export interface CloudProviderEntry {
  providerId: string;
  providerName: string;
  available: boolean;
  reason?: string;
  tasks: CloudTask[];
}

const PROVIDER_NAMES: Record<string, string> = {
  'codex-cloud': 'Codex Cloud',
};

const ACTIVE = new Set(['pending', 'queued', 'running', 'in_progress', 'working', 'started']);
const READY = new Set(['ready', 'completed', 'complete', 'done', 'succeeded', 'applied', 'merged']);
const ERROR = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled', 'timed_out']);

/** Map a vendor's raw task status to the ghost's status. */
export function cloudStatus(raw: unknown, available = true): CloudStatus {
  if (!available) return 'unavailable';
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.trim().toLowerCase();
  if (ACTIVE.has(s)) return 'active';
  if (READY.has(s)) return 'ready';
  if (ERROR.has(s)) return 'error';
  return 'unknown';
}

/** Only http(s) URLs may be opened by a click. */
export function safeTaskUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

let entries = new Map<string, CloudProviderEntry>();
let snapshot: CloudProviderEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = [...entries.values()];
  for (const l of listeners) l();
}

/** Take a cloud message (useExtensionMessages). Returns whether it was one. */
export function handleCloudMessage(msg: { type?: unknown; [key: string]: unknown }): boolean {
  if (msg.type !== 'cloudAgents') return false;
  if (typeof msg.providerId !== 'string') return true;
  const providerId = msg.providerId;
  const available = msg.available !== false;
  const rawTasks = Array.isArray(msg.tasks) ? (msg.tasks as unknown[]) : null;
  const prev = entries.get(providerId);
  let tasks: CloudTask[];
  if (rawTasks) {
    tasks = [];
    for (const t of rawTasks) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      if (typeof r.id !== 'string') continue;
      const rawStatus = typeof r.status === 'string' ? r.status : '';
      tasks.push({
        id: r.id,
        url: typeof r.url === 'string' ? r.url : '',
        title: typeof r.title === 'string' && r.title ? r.title : r.id,
        rawStatus,
        status: cloudStatus(rawStatus, available),
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
      });
    }
  } else {
    // No list (e.g. an unavailable poll): keep the last tasks, re-mapped.
    tasks = (prev?.tasks ?? []).map((t) => ({ ...t, status: cloudStatus(t.rawStatus, available) }));
  }
  entries.set(providerId, {
    providerId,
    providerName:
      typeof msg.providerName === 'string'
        ? msg.providerName
        : (PROVIDER_NAMES[providerId] ?? providerId),
    available,
    reason: typeof msg.reason === 'string' ? msg.reason : undefined,
    tasks,
  });
  emit();
  return true;
}

export function cloudProviders(): CloudProviderEntry[] {
  return snapshot;
}

export function subscribeCloud(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetCloudStoreForTests(): void {
  entries = new Map();
  snapshot = [];
  listeners.clear();
}
