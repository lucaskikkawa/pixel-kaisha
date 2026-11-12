/**
 * Codex CLI as a hook provider (Pixel Kaisha).
 *
 * Codex hook payloads are snake_case like Claude's (session id, event name,
 * cwd, tool name/input/use id). Agents are hooks-only: we do not tail Codex
 * rollout files, so the session start carries no transcript path.
 *
 * Codex ignores non-managed hooks until the user trusts them in `/hooks`
 * (trust is stored per hook hash in ~/.codex/config.toml). Installing is
 * therefore not enough for a character to appear; the consent copy says so.
 */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  codexHooksFilePath,
  codexHooksInstalled,
  installCodexHooks,
  uninstallCodexHooks,
} from './codexHooksFile.js';

const READING_TOOLS = new Set(['read_file', 'view_image', 'list_dir', 'grep', 'search']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function shellCommandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  const cmd = rec.command ?? rec.cmd;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.filter((p) => typeof p === 'string').join(' ');
  return undefined;
}

function shorten(text: string, max = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

export function formatCodexToolStatus(toolName: string, input?: unknown): string {
  const name = toolName.toLowerCase();
  if (name === 'apply_patch' || name === 'edit' || name === 'write') return 'Editing files';
  if (name === 'update_plan') return 'Planning';
  if (name === 'view_image') return 'Viewing image';
  if (name.startsWith('mcp__') || name.includes('/')) return `Using ${toolName}`;
  const cmd = shellCommandOf(input);
  if (cmd) return `Running: ${shorten(cmd)}`;
  if (name === 'bash' || name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    return 'Running command';
  }
  return toolName ? `Using ${toolName}` : 'Working';
}

export function normalizeCodexHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = str(raw.hook_event_name);
  const sessionId = str(raw.session_id);
  if (!eventName || !sessionId) return null;

  switch (eventName) {
    case 'SessionStart':
      return {
        sessionId,
        event: { kind: 'sessionStart', source: str(raw.source), cwd: str(raw.cwd) },
      };
    case 'PreToolUse': {
      const input =
        typeof raw.tool_input === 'object' && raw.tool_input !== null ? raw.tool_input : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-codex-${str(raw.tool_use_id) ?? Date.now()}`,
          toolName: str(raw.tool_name) ?? 'tool',
          input,
        },
      };
    }
    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current' } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'SessionEnd':
      return { sessionId, event: { kind: 'sessionEnd', reason: str(raw.reason) } };
    case 'SubagentStart':
    case 'SubagentStop': {
      // Codex names the sub-agent (`agent_id`) under its parent's session id,
      // and its tool events carry the same `agent_id`. No spawning tool to
      // hang it on: the child character is keyed by that id (toolId).
      const toolId = str(raw.agent_id);
      if (!toolId) return null;
      return eventName === 'SubagentStart'
        ? {
            sessionId,
            event: {
              kind: 'subagentStart',
              parentToolId: '',
              toolId,
              toolName: str(raw.agent_type) ?? 'subagent',
            },
          }
        : {
            sessionId,
            event: {
              kind: 'subagentEnd',
              parentToolId: '',
              toolId,
              agentTranscriptPath: str(raw.agent_transcript_path),
            },
          };
    }
    default:
      // UserPromptSubmit, compaction, interrupt: not shown.
      return null;
  }
}

function consentDisclosure(): { headline: string; disclosure: string } {
  const file = codexHooksFilePath();
  return {
    headline: 'Show Codex sessions in the office?',
    disclosure: [
      `Pixel Kaisha will add hook entries to ${file} that run a small script on Codex session start/end, tool use, permission prompts, turn end and sub-agent start/stop. The script only forwards the event (session id, event name, tool name and input, sub-agent id and type) and Codex's process id to this local server and never blocks or changes what Codex does.`,
      'Codex runs new hooks only after you trust them: open Codex in that project and review them in /hooks. Until then nothing appears.',
      'Turning hooks off removes these entries and restores the file (a backup is kept next to it until then). Trust records Codex stored in ~/.codex/config.toml are not touched by Pixel Kaisha.',
    ].join('\n\n'),
  };
}

function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'codex', args: [], env: { PWD: cwd } };
}

/** Hooks-only: there is no transcript to tail; a placeholder dir is enough
 *  for the standalone launcher's session path. */
function getSessionDirs(): string[] {
  return [];
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent: normalizeCodexHookEvent,
  buildLaunchCommand,
  getSessionDirs,

  async installHooks(): Promise<void> {
    installCodexHooks();
  },
  async uninstallHooks(): Promise<void> {
    uninstallCodexHooks();
  },
  async areHooksInstalled(): Promise<boolean> {
    return codexHooksInstalled();
  },
  consentDisclosure,

  formatToolStatus: formatCodexToolStatus,
  permissionExemptTools: new Set(['update_plan']),
  subagentToolNames: new Set<string>(),
  readingTools: READING_TOOLS,
};
