import { useEffect, useState } from 'react';

import type { CharacterMemory as CharacterMemoryReply } from '../../../../core/src/messages.js';
import { transport } from '../../transport/index.js';
import { castStore } from '../castStore.js';
import {
  CHARACTER_MEMORY_WARNINGS,
  normalizeMemoryPathInput,
  requestCharacterMemory,
} from '../memory.js';
import { useStudio } from './studio.js';
import { ViewButton } from './ViewButton.js';

/** Profile path editor and read-only result from the B2.4 memory protocol. */
export function CharacterMemory() {
  const { profile } = useStudio();
  const [path, setPath] = useState(profile.memoryPath ?? '');
  const [reply, setReply] = useState<CharacterMemoryReply | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(
    () =>
      transport.onMessage((message) => {
        if (message.type !== 'characterMemory' || message.profileId !== profile.id) return;
        setReply(message);
        setLoading(false);
      }),
    [profile.id],
  );

  const updatePath = (value: string) => {
    setPath(value);
    castStore.update((draft) => {
      const clean = normalizeMemoryPathInput(value);
      if (clean) draft.memoryPath = clean;
      else delete draft.memoryPath;
    });
    setReply(null);
  };

  const request = () => {
    if (!profile.id) return;
    setLoading(true);
    setReply(null);
    transport.send(requestCharacterMemory(profile.id, path, profile.memoryPath));
    if (new URLSearchParams(window.location.search).get('mock') === 'memory') {
      const warning = profile.name?.includes('Missing') ? 'not-found' : undefined;
      window.setTimeout(() => {
        setReply({
          type: 'characterMemory',
          profileId: profile.id!,
          path: path || '~/work/pixel-kaisha/CLAUDE.md',
          ...(warning
            ? { warning }
            : {
                content:
                  '# Character memory\n\nFixture notes for this character.\n\nRead-only preview.',
              }),
          ...(!warning ? { files: ['CLAUDE.md'] } : {}),
        });
        setLoading(false);
      }, 80);
    }
  };

  const warning = reply?.warning
    ? (CHARACTER_MEMORY_WARNINGS[reply.warning] ?? 'Memory could not be read.')
    : null;
  return (
    <section className="chv-memory" aria-label="Character memory">
      <label className="chv-memory-path">
        <span>Memory path</span>
        <input
          value={path}
          placeholder="CLAUDE.md, AGENTS.md, GEMINI.md, or ~/.claude/projects/<proj>/memory/"
          aria-label="Memory path"
          onChange={(event) => updatePath(event.target.value)}
        />
      </label>
      <ViewButton primary disabled={loading} onClick={request}>
        {loading ? 'Reading…' : 'Show memory'}
      </ViewButton>
      {warning && (
        <p className="chv-memory-warning" role="status">
          {warning}
        </p>
      )}
      {reply?.content !== undefined && !warning && (
        <div className="chv-memory-result" aria-label="Read-only memory contents">
          {reply.files?.length ? <p>Files: {reply.files.join(', ')}</p> : null}
          <pre>{reply.content || '(This folder has no readable memory files.)'}</pre>
        </div>
      )}
    </section>
  );
}
