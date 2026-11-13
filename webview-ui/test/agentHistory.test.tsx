import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AgentHistory, ClientMessage } from '../../core/src/messages.js';
import { AgentHistoryPanel } from '../src/conversations/AgentHistoryPanel.js';
import {
  createAgentHistorySource,
  isHistoryMock,
} from '../src/conversations/agentHistorySource.js';
import {
  chronologicalEntries,
  earlierHistoryRequest,
  historyPanelBottomInset,
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

  it('mock=history never asks the server and a transport answer cannot replace it', () => {
    expect(isHistoryMock('?token=t&mock=history')).toBe(true);
    expect(isHistoryMock('?token=t&mock=summary')).toBe(false);
    const send = vi.fn<(msg: ClientMessage) => void>();
    const source = createAgentHistorySource(true, send);
    const fixture = source.open(1, 1_000_000);
    expect(fixture?.group?.teamName).toBe('Kaisha Web');
    expect(fixture?.entries.every((entry) => entry.shared)).toBe(true);
    const earlier = source.earlier(1, fixture!);
    expect(earlier && 'history' in earlier && earlier.history.entries.length).toBe(4);
    expect(send).not.toHaveBeenCalled();
    // the live office's answer for agent 1 (it does not exist there)
    const live: AgentHistory = {
      type: 'agentHistory',
      id: 1,
      entries: [],
      reason: 'unknown-agent',
    };
    expect(source.accepts(live, 1)).toBe(false);
    const panel = renderToStaticMarkup(
      <AgentHistoryPanel
        history={fixture}
        agentId={1}
        agentName="Claude"
        mode="side"
        phone
        onMode={() => {}}
        onClose={() => {}}
        onEarlier={() => {}}
        names={new Map([[1, 'Claude']])}
      />,
    );
    expect(panel).toContain('Group · Kaisha Web');
    expect(panel).toContain('Shared · Kaisha Web');
    expect(panel).not.toContain('unknown-agent');
  });

  it('without the mock it asks the server and takes its answer for the open agent only', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    const source = createAgentHistorySource(false, send);
    expect(source.open(3)).toBeNull();
    expect(send).toHaveBeenCalledWith({ type: 'requestAgentHistory', id: 3 });
    const answer: AgentHistory = { type: 'agentHistory', id: 3, entries };
    expect(source.accepts(answer, 3)).toBe(true);
    expect(source.accepts(answer, 4)).toBe(false);
    expect(source.earlier(3, answer)).toEqual({ before: 10 });
    expect(send).toHaveBeenLastCalledWith({ type: 'requestAgentHistory', id: 3, before: 10 });
  });

  it('keeps the phone panel above the bottom chrome on 412x915 and 360x374', () => {
    // card bar (marked) and a radio hint button just above it
    expect(
      historyPanelBottomInset(
        { width: 412, height: 915 },
        [
          { top: 843, bottom: 915, left: 0, right: 412, marked: true },
          { top: 810, bottom: 838, left: 150, right: 262 },
          { top: 8, bottom: 48, left: 8, right: 48 }, // the menu button, top: not chrome
          { top: 843, bottom: 915, left: 412, right: 824 }, // the terminal page, off screen
        ],
        8,
        0.8,
      ),
    ).toBe(915 - 810 + 8);
    // a short cover screen: the marked bar counts even above the lowest fifth
    expect(
      historyPanelBottomInset(
        { width: 360, height: 374 },
        [{ top: 290, bottom: 374, left: 0, right: 360, marked: true }],
        8,
        0.8,
      ),
    ).toBe(374 - 290 + 8);
    expect(historyPanelBottomInset({ width: 360, height: 374 }, [], 8, 0.8)).toBe(8);
  });

  it('renders the phone presentations inside the viewport with a bottom inset', () => {
    const props = {
      history: null,
      agentId: 1,
      agentName: 'Claude',
      onMode: () => {},
      onClose: () => {},
      onEarlier: () => {},
      names: new Map<number, string>(),
      phone: true,
    };
    const side = renderToStaticMarkup(<AgentHistoryPanel {...props} mode="side" />);
    const overlay = renderToStaticMarkup(<AgentHistoryPanel {...props} mode="overlay" />);
    for (const html of [side, overlay]) {
      expect(html).toContain('mobile-safe-top');
      expect(html).toContain('bottom:8px');
      expect(html).not.toContain('100dvh');
      expect(html).not.toContain('bottom-8');
    }
    expect(side).toContain('right-8');
    expect(overlay).toContain('m-auto');
  });
});
