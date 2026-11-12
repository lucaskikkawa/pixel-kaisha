/** Codex CLI hook events Pixel Kaisha listens to. Passive only: the script
 *  never prints a decision, so Codex behaves exactly as without it. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

/** Events whose handlers use a matcher group (tool-scoped). */
export const CODEX_MATCHER_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
]);

/** Hook script file name (dist/hooks/<name> -> ~/.pixel-agents/hooks/<name>). */
export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';

/** Handler timeout, seconds. Codex clamps SessionEnd to 3 s. */
export const CODEX_HOOK_TIMEOUT_SEC = 3;
