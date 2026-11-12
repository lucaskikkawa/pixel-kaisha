/**
 * Codex hook script (bundled to dist/hooks/codex-hook.js).
 *
 * Reads the hook payload from stdin and POSTs it (plus Codex's pid,
 * `cli_pid`) to every live Pixel Kaisha server at /api/hooks/codex. Fail-open and passive: always exits 0 and
 * prints nothing, so Codex never sees a decision from us.
 */

import { HOOK_API_PREFIX } from '../../../../constants.js';
import { liveServers, postToServer } from '../../claude/hooks/serverRegistry.js';
import { cliProcessPid } from '../../shared/cliPid.js';

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
  // Codex's own pid, so the server can tell a live session from a residual one.
  const cliPid = cliProcessPid();
  if (cliPid !== undefined) data.cli_pid = cliPid;
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
