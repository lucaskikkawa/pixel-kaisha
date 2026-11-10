/**
 * Where hook installers write.
 *
 * Default (upstream behaviour): each CLI's user-level settings in the home
 * directory. Pixel Kaisha on the dev box must NOT touch those (they fire for
 * every bot on the machine), so `PIXEL_KAISHA_HOOKS_PROJECT_DIR` switches every
 * installer to that project's own settings instead:
 *
 *   claude -> <dir>/.claude/settings.json
 *   codex  -> <dir>/.codex/hooks.json
 *   agy    -> <dir>/.agents/hooks.json
 *
 * The CLIs only read project hooks for sessions started inside <dir>.
 */

import * as path from 'path';

export const HOOKS_PROJECT_DIR_ENV = 'PIXEL_KAISHA_HOOKS_PROJECT_DIR';

/** The project directory hooks are scoped to, or undefined for user-level. */
/** Short alias read by scripts/box-run.sh; "user" means user-level hooks. */
export const HOOKS_PROJECT_DIR_ALIAS_ENV = 'KAISHA_HOOKS_PROJECT_DIR';

export function hooksProjectDir(): string | undefined {
  const raw =
    process.env[HOOKS_PROJECT_DIR_ENV]?.trim() || process.env[HOOKS_PROJECT_DIR_ALIAS_ENV]?.trim();
  if (!raw || raw === 'user') return undefined;
  return path.resolve(raw);
}
