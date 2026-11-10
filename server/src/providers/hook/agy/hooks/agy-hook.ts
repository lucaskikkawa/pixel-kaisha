/**
 * agy (Antigravity CLI) hook script, bundled to dist/hooks/agy-hook.js.
 *
 * agy hooks are synchronous and FAIL-CLOSED on PreToolUse: an empty JSON
 * object there means "deny", and a hook that exits non-zero also blocks the
 * tool. So this script:
 *   - prints NOTHING for PreToolUse (= normal permission flow) and `{}` for
 *     every other event;
 *   - writes its stdout reply first, before any network work;
 *   - always exits 0, whatever happens.
 * It then forwards a reduced, snake_case copy of the event to every live
 * Pixel Kaisha server at /api/hooks/agy (short timeout, fail-open).
 */

import { HOOK_API_PREFIX } from '../../../../constants.js';
import { liveServers, postToServer } from '../../claude/hooks/serverRegistry.js';
import { toWireEvent } from '../agyPayload.js';

const POST_TIMEOUT_MS = 1000;
const noop = (): void => {};

async function main(): Promise<void> {
  const argEvent = process.argv[2];
  let input = '';
  try {
    for await (const chunk of process.stdin) input += chunk;
  } catch {
    /* fall through with what we have */
  }
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed === 'object' && parsed !== null) raw = parsed as Record<string, unknown>;
  } catch {
    raw = null;
  }
  const eventName =
    (raw && typeof raw.hookEventName === 'string' ? raw.hookEventName : undefined) ?? argEvent;
  if (eventName !== 'PreToolUse') process.stdout.write('{}');
  if (!raw) return;
  const wire = toWireEvent(raw, argEvent);
  if (!wire) return;
  const servers = liveServers(noop, 'agy');
  if (servers === null) return;
  const body = JSON.stringify(wire);
  await Promise.all(
    servers.map((server) =>
      postToServer(server, {
        path: `${HOOK_API_PREFIX}/agy`,
        body,
        label: 'agy',
        debug: noop,
        timeoutMs: POST_TIMEOUT_MS,
      }),
    ),
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
