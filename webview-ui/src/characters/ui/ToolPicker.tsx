/**
 * A character's default tool (Claude / Codex / agy), labelled and coloured like the office's
 * engine badges. An edit of the draft like any other: it reaches the server on Save.
 */

import type { CharacterProfile } from '../../../../core/src/characterProfiles.js';
import { engineBadgeFor } from '../../cloud/engineBadge.js';
import { ENGINE_BADGE_TEXT_COLOR } from '../../constants.js';
import { castStore } from '../castStore.js';
import { DEFAULT_TOOLS, defaultToolOf, setDefaultTool } from '../defaultTool.js';

interface ToolPickerProps {
  profile: CharacterProfile;
  index: number;
  /** A one-line select (the roster cards) instead of a row of buttons (the phone sheet). */
  compact?: boolean;
}

export function ToolPicker({ profile, index, compact }: ToolPickerProps) {
  const tool = defaultToolOf(profile);
  const choose = (next: string) =>
    castStore.updateAt(index, (draft) => {
      setDefaultTool(draft, next);
    });
  const label = `Default tool for ${profile.name || `char_${index}`}`;
  if (compact) {
    return (
      <select
        className="chv-tool-select"
        value={tool}
        aria-label={label}
        title={label}
        style={{ borderLeftColor: engineBadgeFor(tool).color }}
        onChange={(e) => choose(e.target.value)}
      >
        {DEFAULT_TOOLS.map((id) => (
          <option key={id} value={id}>
            {engineBadgeFor(id).label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="chv-tool-row" role="radiogroup" aria-label={label}>
      {DEFAULT_TOOLS.map((id) => {
        const badge = engineBadgeFor(id);
        const on = id === tool;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            className="chv-tool-opt"
            style={
              on
                ? {
                    background: badge.color,
                    borderColor: badge.color,
                    color: ENGINE_BADGE_TEXT_COLOR,
                  }
                : undefined
            }
            onClick={() => choose(id)}
          >
            {badge.label}
          </button>
        );
      })}
    </div>
  );
}
