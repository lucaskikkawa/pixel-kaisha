/** Antigravity CLI (`agy`) hook events Pixel Kaisha listens to. */
export const AGY_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;

/** Events whose handlers sit in a `{ matcher, hooks }` group. */
export const AGY_MATCHER_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/** Our named entry in hooks.json (agy merges all named hooks). */
export const AGY_HOOK_NAME = 'pixel-kaisha';

export const AGY_HOOK_SCRIPT_NAME = 'agy-hook.js';

/** Handler timeout, seconds. agy hooks are synchronous: keep it short. */
export const AGY_HOOK_TIMEOUT_SEC = 3;
