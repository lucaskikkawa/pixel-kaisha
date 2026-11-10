/**
 * Codex hook script (bundled to dist/hooks/codex-hook.js).
 *
 * Reads the hook payload from stdin and POSTs it to every live Pixel Kaisha
 * server at /api/hooks/codex. Fail-open and passive: always exits 0 and
 * prints nothing, so Codex never sees a decision from us.
 */

import { HOOK_API_PREFIX } from '../../../../constants.js';
import { liveServers, postToServer } from '../../claude/hooks/serverRegistry.js';

const POST_TIMEOUT_MS = 1500;
const noop = (): void => {};

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof data !== 'object' || data === null) return;
  const label = `codex event=${String(data.hook_event_name ?? '?')}`;
  const servers = liveServers(noop, label);
  if (servers === null) return;
  const body = JSON.stringify(data);
  await Promise.all(
    servers.map((server) =>
      postToServer(server, {
        path: `${HOOK_API_PREFIX}/codex`,
        body,
        label,
        debug: noop,
        timeoutMs: POST_TIMEOUT_MS,
      }),
    ),
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
