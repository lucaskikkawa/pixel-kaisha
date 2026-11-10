/**
 * Engine badge (Pixel Kaisha): which motor drives each LOCAL agent, so the
 * office can tag it Claude / Codex / agy.
 *
 * INTEGRATION POINT (B2/B4 → UI): `agentCreated` and `existingAgents` gain an
 * optional, additive `providerId` (per agent: `agentCreated.providerId`, and
 * `existingAgents.providerIds: Record<agentId, providerId>`). Missing means
 * the upstream default, Claude.
 */

import {
  ENGINE_AGY_COLOR,
  ENGINE_CLAUDE_COLOR,
  ENGINE_CODEX_COLOR,
  ENGINE_OTHER_COLOR,
} from '../constants.js';

export interface EngineBadge {
  label: string;
  color: string;
}

const BADGES: Record<string, EngineBadge> = {
  claude: { label: 'Claude', color: ENGINE_CLAUDE_COLOR },
  codex: { label: 'Codex', color: ENGINE_CODEX_COLOR },
  agy: { label: 'agy', color: ENGINE_AGY_COLOR },
  antigravity: { label: 'agy', color: ENGINE_AGY_COLOR },
};

const providers = new Map<number, string>();

export function engineBadgeFor(providerId: string | undefined): EngineBadge {
  if (!providerId) return BADGES.claude;
  return BADGES[providerId] ?? { label: providerId, color: ENGINE_OTHER_COLOR };
}

export function setAgentProvider(id: number, providerId: unknown): void {
  if (typeof providerId === 'string' && providerId) providers.set(id, providerId);
}

export function agentEngineBadge(id: number): EngineBadge {
  return engineBadgeFor(providers.get(id));
}

export function forgetAgentProvider(id: number): void {
  providers.delete(id);
}

export function resetEngineBadgesForTests(): void {
  providers.clear();
}
