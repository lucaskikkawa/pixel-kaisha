/**
 * Antigravity CLI (`agy`) as a hook provider (Pixel Kaisha).
 *
 * The hook script converts agy's camelCase payloads to snake_case before
 * POSTing (see agyPayload.ts), so this normalizer reads the same field names
 * as the other providers. Agents are hooks-only. agy has no SessionEnd event:
 * `Stop` ends the turn and the agent then idles like any finished agent.
 */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  agyHooksFilePath,
  agyHooksInstalled,
  installAgyHooks,
  uninstallAgyHooks,
} from './agyHooksFile.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function shorten(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function formatAgyToolStatus(toolName: string, input?: unknown): string {
  const a = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const name = toolName.toLowerCase();
  if (name === 'run_command' && typeof a.CommandLine === 'string') {
    return `Running: ${shorten(a.CommandLine)}`;
  }
  const file = str(a.AbsolutePath) ?? str(a.TargetFile);
  if (name === 'view_file' || name === 'read_file') {
    return file ? `Reading ${baseName(file)}` : 'Reading file';
  }
  if (name.includes('write') || name.includes('replace') || name.includes('edit')) {
    return file ? `Editing ${baseName(file)}` : 'Editing file';
  }
  if (name.includes('search') || name === 'find_by_name' || name === 'grep_search') {
    return 'Searching';
  }
  if (name === 'list_dir') return 'Listing files';
  if (name.startsWith('browser_') || name === 'read_url_content') return 'Browsing';
  return toolName ? `Using ${toolName}` : 'Working';
}

export function normalizeAgyHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = str(raw.hook_event_name);
  const sessionId = str(raw.session_id);
  if (!eventName || !sessionId) return null;
  switch (eventName) {
    case 'SessionStart':
      return { sessionId, event: { kind: 'sessionStart', source: 'startup', cwd: str(raw.cwd) } };
    case 'PreToolUse':
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-agy-${str(raw.tool_use_id) ?? Date.now()}`,
          toolName: str(raw.tool_name) ?? 'tool',
          input:
            typeof raw.tool_input === 'object' && raw.tool_input !== null ? raw.tool_input : {},
        },
      };
    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'Stop': {
      const reason = str(raw.termination_reason);
      // A normal turn ends with NO_TOOL_CALL; anything else (error, limits,
      // cancel) wants the user's attention.
      const attention = reason !== undefined && reason !== 'NO_TOOL_CALL';
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: attention || undefined } };
    }
    default:
      return null;
  }
}

function consentDisclosure(): { headline: string; disclosure: string } {
  const file = agyHooksFilePath() ?? '<project>/.agents/hooks.json';
  return {
    headline: 'Show Antigravity (agy) sessions in the office?',
    disclosure: [
      `Pixel Kaisha will add a hook named "pixel-kaisha" to ${file}. It runs a small script on session start, before and after each tool, and when a turn stops, and forwards the session id, event, tool name and a short tool argument (e.g. the command line) to this local server. Your prompts are not forwarded.`,
      'The script never approves, denies or changes a tool call, and always exits successfully, so agy behaves as without it. agy hooks run synchronously; the script returns at once and gives up on the server after one second.',
      'Turning hooks off removes the "pixel-kaisha" entry and restores the file (a backup is kept next to it until then).',
    ].join('\n\n'),
  };
}

function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'agy', args: [], env: { PWD: cwd } };
}

/** Hooks-only: no transcript is tailed. */
function getSessionDirs(): string[] {
  return [];
}

export const agyProvider: HookProvider = {
  kind: 'hook',
  id: 'agy',
  displayName: 'Antigravity',
  protocolVersion: 1,

  normalizeHookEvent: normalizeAgyHookEvent,
  buildLaunchCommand,
  getSessionDirs,

  async installHooks(): Promise<void> {
    installAgyHooks();
  },
  async uninstallHooks(): Promise<void> {
    uninstallAgyHooks();
  },
  async areHooksInstalled(): Promise<boolean> {
    return agyHooksInstalled();
  },
  consentDisclosure,

  formatToolStatus: formatAgyToolStatus,
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set([
    'view_file',
    'list_dir',
    'grep_search',
    'find_by_name',
    'read_url_content',
  ]),
};
