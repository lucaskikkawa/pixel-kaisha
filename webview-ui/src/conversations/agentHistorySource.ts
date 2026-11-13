import type { AgentHistory, ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import { earlierHistoryRequest } from './agentHistoryView.js';

/** `?mock=history`: the panel shows the fixture below and never talks to the server. */
export function isHistoryMock(search: string): boolean {
  return new URLSearchParams(search).get('mock') === 'history';
}

/** The history panel's source: the server (requestAgentHistory → agentHistory) or the fixture. */
export interface AgentHistorySource {
  readonly mock: boolean;
  /** Open agent `id`: live, sends the request and returns null; mocked, returns the fixture. */
  open(id: number, now?: number): AgentHistory | null;
  /**
   * The page before `current`'s oldest entry: live, sends the request and returns its
   * `before`; mocked, returns the fixture with an earlier entry. Null when there is nothing to ask.
   */
  earlier(id: number, current: AgentHistory): { before: number } | { history: AgentHistory } | null;
  /** Whether a transport message is history for agent `id` (never while mocked: the fixture stays). */
  accepts(msg: ServerMessage, id: number | null): msg is AgentHistory;
}

export function createAgentHistorySource(
  mock: boolean,
  send: (msg: ClientMessage) => void,
): AgentHistorySource {
  return {
    mock,
    open(id, now = Date.now()) {
      if (mock) return mockAgentHistory(id, now);
      send({ type: 'requestAgentHistory', id });
      return null;
    },
    earlier(id, current) {
      if (!current.entries.length) return null;
      if (mock) return { history: mockEarlierHistory(id, current) };
      const request = earlierHistoryRequest(id, current.entries);
      if (!request) return null;
      send(request);
      return { before: request.before };
    },
    accepts(msg, id): msg is AgentHistory {
      return !mock && msg.type === 'agentHistory' && msg.id === id;
    },
  };
}

/** The fixture: agents 1 and 2 share the "Kaisha Web" group, agent 1 has an earlier page. */
export function mockAgentHistory(id: number, now: number): AgentHistory {
  const shared = id === 1 || id === 2;
  const author = id;
  const actionEntries = [
    {
      ts: now - 120000,
      kind: 'action' as const,
      toolName: 'Read',
      text: 'Leu os módulos de sessão e autenticação.',
      ...(shared ? { shared: true, teamName: 'Kaisha Web' } : {}),
      authorAgentId: author,
    },
    {
      ts: now - 60000,
      kind: 'action' as const,
      toolName: id === 2 ? 'Search' : 'Edit',
      text:
        id === 2 ? 'Pesquisou referências de autenticação.' : 'Atualizou o estado local do agente.',
      ...(shared ? { shared: true, teamName: 'Kaisha Web' } : {}),
      authorAgentId: author,
    },
  ];
  const entries =
    id === 1
      ? [
          {
            ts: now - 180000,
            kind: 'speech' as const,
            role: 'user' as const,
            text: 'Revise o fluxo de autenticação e resuma os próximos passos.',
            shared: true,
            teamName: 'Kaisha Web',
            authorAgentId: id,
          },
          actionEntries[0],
          {
            ts: now - 60000,
            kind: 'speech' as const,
            role: 'assistant' as const,
            text: 'O fluxo está consistente; vou registrar os testes que faltam.',
            shared: true,
            teamName: 'Kaisha Web',
            authorAgentId: 2,
          },
        ]
      : actionEntries;
  return {
    type: 'agentHistory',
    id,
    entries,
    more: id === 1,
    ...(shared
      ? { group: { teamName: 'Kaisha Web', leadAgentId: 1, memberAgentIds: [1, 2] } }
      : {}),
  };
}

/** The fixture's earlier page: one older entry, and nothing more after it. */
export function mockEarlierHistory(id: number, current: AgentHistory): AgentHistory {
  return {
    ...current,
    more: false,
    entries: [
      {
        ts: current.entries[0].ts - 60000,
        kind: 'action',
        toolName: 'Search',
        text: 'Pesquisou referências anteriores do histórico.',
        shared: true,
        teamName: current.group?.teamName,
        authorAgentId: id,
      },
      ...current.entries,
    ],
  };
}
