/**
 * agy hook payloads are camelCase and carry the user's last prompt. The hook
 * script converts them to the small snake_case body the server's hook route
 * expects (`session_id`, `hook_event_name`, …) and drops everything else.
 */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function toWireEvent(
  raw: Record<string, unknown>,
  fallbackEvent?: string,
): Record<string, unknown> | null {
  const sessionId = str(raw.conversationId);
  const eventName = str(raw.hookEventName) ?? str(fallbackEvent);
  if (!sessionId || !eventName) return null;
  const out: Record<string, unknown> = {
    session_id: sessionId,
    hook_event_name: eventName,
  };
  const cwd =
    str(raw.cwd) ?? (Array.isArray(raw.workspacePaths) ? str(raw.workspacePaths[0]) : undefined);
  if (cwd) out.cwd = cwd;
  const call = raw.toolCall;
  if (typeof call === 'object' && call !== null) {
    const c = call as Record<string, unknown>;
    out.tool_name = str(c.name);
    out.tool_use_id = str(c.id);
    const args = c.args;
    if (typeof args === 'object' && args !== null) {
      // Only what the tool label needs; file contents and the like stay out.
      const a = args as Record<string, unknown>;
      const input: Record<string, unknown> = {};
      for (const key of [
        'CommandLine',
        'AbsolutePath',
        'TargetFile',
        'DirectoryPath',
        'Query',
        'Url',
      ]) {
        if (typeof a[key] === 'string') input[key] = (a[key] as string).slice(0, 300);
      }
      out.tool_input = input;
    }
  }
  if (typeof raw.error === 'string' && raw.error !== '') out.error = raw.error.slice(0, 200);
  if (str(raw.terminationReason)) out.termination_reason = raw.terminationReason;
  if (typeof raw.fullyIdle === 'boolean') out.fully_idle = raw.fullyIdle;
  return out;
}
