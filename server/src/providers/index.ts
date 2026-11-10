/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { copyBundledScript } from './hook/claude/bundledScripts.js';
import { claudeProvider } from './hook/claude/claude.js';
import { CLAUDE_HOOK_SCRIPT_NAME } from './hook/claude/constants.js';
import { codexProvider } from './hook/codex/codex.js';
import { CODEX_HOOK_SCRIPT_NAME } from './hook/codex/constants.js';

export { claudeProvider, codexProvider };
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';

/** The bundled hook script each provider's hooks run (dist/hooks/<name>). */
const HOOK_SCRIPT_BY_PROVIDER: Readonly<Record<string, string>> = {
  [claudeProvider.id]: CLAUDE_HOOK_SCRIPT_NAME,
  [codexProvider.id]: CODEX_HOOK_SCRIPT_NAME,
};

/** Copy the hook script of `providerId` from the package to
 *  ~/.pixel-agents/hooks/. False when it is missing (do not install then). */
export function copyProviderHookScript(packageRoot: string, providerId: string): boolean {
  const name = HOOK_SCRIPT_BY_PROVIDER[providerId];
  return name ? copyBundledScript(packageRoot, name) : false;
}

/** Every bundled hook provider, in registration order. The consent gate loops
 *  over this at the webviewReady handshake (one ask per provider that needs
 *  one) and `hooksConsentResponse` resolves its provider id against it. */
export const hookProviders: readonly HookProvider[] = [claudeProvider, codexProvider];

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}
