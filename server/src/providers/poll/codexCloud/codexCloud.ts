/**
 * Codex Cloud as a poll provider (read-only): `codex cloud list --json`.
 *
 * - Never runs anything that creates or changes a task.
 * - Runs the CLI with its working directory in a private temp folder: the CLI
 *   writes an `error.log` (with account details) into its current directory.
 * - Follows the pagination cursor up to a small page cap.
 * - Unknown status strings map to `unknown` (the command is experimental).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CloudTask, CloudTaskStatus, PollProvider } from '../../../../../core/src/provider.js';

const PAGE_LIMIT = 20;
const MAX_PAGES = 5;
const CLI_TIMEOUT_MS = 15_000;

export type RunCli = (args: string[], cwd: string) => Promise<string>;

/** Map the CLI's status string to ours. Only `ready` has been observed for
 *  real; the others are informed guesses kept tolerant on purpose. */
export function mapCodexCloudStatus(raw: string): CloudTaskStatus {
  const s = raw.trim().toLowerCase();
  if (s === 'ready' || s === 'completed' || s === 'done' || s === 'applied' || s === 'merged') {
    return 'done';
  }
  if (
    ['pending', 'queued', 'running', 'in_progress', 'in-progress', 'working', 'started'].includes(s)
  ) {
    return 'active';
  }
  if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(s)) {
    return 'failed';
  }
  return 'unknown';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Parse one `list --json` page. Throws on a shape we do not understand. */
export function parseCodexCloudPage(stdout: string): { tasks: CloudTask[]; cursor?: string } {
  const data = JSON.parse(stdout) as unknown;
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { tasks?: unknown }).tasks)
  ) {
    throw new Error('unexpected codex cloud list output');
  }
  const page = data as { tasks: unknown[]; cursor?: unknown };
  const tasks: CloudTask[] = [];
  for (const item of page.tasks) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    const id = str(t.id);
    if (!id) continue;
    const rawStatus = str(t.status) ?? 'unknown';
    tasks.push({
      id,
      title: str(t.title) ?? '(untitled task)',
      status: mapCodexCloudStatus(rawStatus),
      rawStatus,
      url: str(t.url),
      updatedAt: str(t.updated_at),
      environment: str(t.environment_label) ?? str(t.environment_id),
    });
  }
  return { tasks, cursor: str(page.cursor) };
}

/** Private working directory for the CLI (keeps error.log out of the repo). */
export function cloudWorkDir(): string {
  const dir = path.join(os.tmpdir(), `pixel-kaisha-cloud-${process.getuid?.() ?? 'user'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const defaultRunCli: RunCli = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'codex',
      args,
      { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail =
            String(stderr || err.message)
              .trim()
              .split('\n')
              .pop() ?? '';
          reject(new Error(`codex cloud list failed: ${detail}`));
        } else resolve(String(stdout));
      },
    );
  });

function codexOnPath(): boolean {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, 'codex' + ext), fs.constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

export function createCodexCloudProvider(
  runCli: RunCli = defaultRunCli,
  isPresent: () => boolean = codexOnPath,
  intervalMs = 60_000,
): PollProvider {
  return {
    kind: 'poll',
    id: 'codex-cloud',
    displayName: 'Codex Cloud',
    intervalMs,
    async isConfigured() {
      return isPresent();
    },
    async listTasks() {
      const cwd = cloudWorkDir();
      const all: CloudTask[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const args = ['cloud', 'list', '--json', '--limit', String(PAGE_LIMIT)];
        if (cursor) args.push('--cursor', cursor);
        const parsed = parseCodexCloudPage(await runCli(args, cwd));
        all.push(...parsed.tasks);
        cursor = parsed.cursor;
        if (!cursor) break;
      }
      return all;
    },
  };
}

export const codexCloudProvider = createCodexCloudProvider();
