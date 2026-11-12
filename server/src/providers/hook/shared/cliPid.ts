/**
 * The pid of the CLI that ran a hook script, for the server to notice when
 * that CLI has exited (Pixel Kaisha B2.5, see docs/kaisha/protocol-lifecycle.md).
 *
 * CLIs run hook commands through a shell (`sh -c "node …/agy-hook.js"`), so
 * the script's parent is usually that short-lived shell: walk up past shells
 * to the first process that isn't one. Linux only (/proc); elsewhere, or on
 * any doubt, undefined — a wrong pid would close a live agent, a missing one
 * only leaves the server without the signal.
 */

import * as fs from 'fs';

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'busybox']);
const MAX_HOPS = 3;

function procInfo(pid: number, procRoot: string): { comm: string; ppid: number } | null {
  try {
    const comm = fs.readFileSync(`${procRoot}/${pid}/comm`, 'utf8').trim();
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    // `pid (comm) state ppid …`; comm may itself hold spaces or parentheses.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) ? { comm, ppid } : null;
  } catch {
    return null;
  }
}

export function cliProcessPid(
  startPid: number = process.ppid,
  procRoot = '/proc',
  platform: string = process.platform,
): number | undefined {
  if (platform !== 'linux') return undefined;
  let pid = startPid;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    const info = procInfo(pid, procRoot);
    if (!info) return undefined;
    if (!SHELLS.has(info.comm)) return pid;
    pid = info.ppid;
  }
  return undefined;
}
