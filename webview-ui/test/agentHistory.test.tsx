import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AgentHistory } from '../../core/src/messages.js';
import { AgentHistoryPanel } from '../src/conversations/AgentHistoryPanel.js';
import {
  chronologicalEntries,
  earlierHistoryRequest,
  mergeEarlierEntries,
} from '../src/conversations/agentHistoryView.js';

const entries = [
  {
    ts: 30,
    kind: 'speech' as const,
    role: 'assistant' as const,
    text: 'Done',
    shared: true,
    teamName: 'Team',
    authorAgentId: 2,
  },
  {
    ts: 10,
    kind: 'action' as const,
    toolName: 'Read',
    text: 'Reading',
    shared: true,
    teamName: 'Team',
    authorAgentId: 1,
  },
];

describe('agent history view', () => {
  it('shows entries oldest first and identifies group, author, role, and action tool', () => {
    const rendered = renderToStaticMarkup(
      <AgentHistoryPanel
        history={{
          type: 'agentHistory',
          id: 1,
          entries,
          group: { teamName: 'Team', leadAgentId: 1, memberAgentIds: [1, 2] },
        }}
        agentId={1}
        agentName="Claude"
        mode="side"
        onMode={() => {}}
        onClose={() => {}}
        onEarlier={() => {}}
        names={
          new Map([
            [1, 'Claude'],
            [2, 'Codex'],
          ])
        }
      />,
    );
    expect(rendered.indexOf('Reading')).toBeLessThan(rendered.indexOf('Done'));
    expect(rendered).toContain('Group · Team');
    expect(rendered).toContain('Shared · Team');
    expect(rendered).toContain('Codex');
    expect(rendered).toContain('Speech · assistant');
    expect(rendered).toContain('Action · Read');
  });

  it('sorts ties stably and builds an exclusive before request from the oldest entry', () => {
    expect(chronologicalEntries(entries).map((entry) => entry.ts)).toEqual([10, 30]);
    expect(earlierHistoryRequest(7, entries)).toEqual({
      type: 'requestAgentHistory',
      id: 7,
      before: 10,
    });
    expect(
      mergeEarlierEntries(entries, [{ ts: 1, kind: 'speech', role: 'user', text: 'Earlier' }]).map(
        (entry) => entry.ts,
      ),
    ).toEqual([1, 10, 30]);
  });

  it('renders the two presentations, ignores a different id, and shows reason as an empty warning', () => {
    const props = {
      agentId: 1,
      agentName: 'Claude',
      onMode: () => {},
      onClose: () => {},
      onEarlier: () => {},
      names: new Map<number, string>(),
    };
    const side = renderToStaticMarkup(
      <AgentHistoryPanel
        {...props}
        history={{ type: 'agentHistory', id: 1, entries: [] }}
        mode="side"
      />,
    );
    const overlay = renderToStaticMarkup(
      <AgentHistoryPanel
        {...props}
        history={{ type: 'agentHistory', id: 1, entries: [] }}
        mode="overlay"
      />,
    );
    expect(side).toContain('right-8');
    expect(overlay).toContain('fixed');
    const wrongId = renderToStaticMarkup(
      <AgentHistoryPanel
        {...props}
        history={{ type: 'agentHistory', id: 2, entries }}
        mode="side"
      />,
    );
    expect(wrongId).toContain('No history yet');
    expect(wrongId).not.toContain('Reading');
    const reason: AgentHistory = {
      type: 'agentHistory',
      id: 1,
      entries: [],
      reason: 'unknown-agent',
    };
    expect(
      renderToStaticMarkup(<AgentHistoryPanel {...props} history={reason} mode="side" />),
    ).toContain('unknown-agent');
  });
});
