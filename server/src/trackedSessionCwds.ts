/**
 * Pixel Kaisha: working directories whose hook sessions are always adopted,
 * even with Watch All Sessions off.
 *
 * Upstream decides adoption by the session's *project dir*, which for Claude is
 * `dirname(transcript_path)` (`~/.claude/projects/-workspace-...`), not the
 * folder the session runs in. When hooks are scoped to one project
 * (PIXEL_KAISHA_HOOKS_PROJECT_DIR) every hook that fires comes from a session
 * started there, so that folder is registered here and sessions are matched by
 * their `cwd` (the folder itself or anything below it), for every provider.
 */

import * as path from 'path';

import { toPathKey } from './pathKey.js';

const trackedCwds = new Set<string>();

/** Register a working directory (stored normalized). */
export function registerTrackedCwd(dir: string): void {
  if (dir) trackedCwds.add(toPathKey(dir));
}

/** True when `cwd` is a registered dir or lies inside one. */
export function isTrackedCwd(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const key = toPathKey(cwd);
  for (const dir of trackedCwds) {
    if (key === dir) return true;
    const rel = path.relative(dir, key);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** Test helper. */
export function clearTrackedCwds(): void {
  trackedCwds.clear();
}
