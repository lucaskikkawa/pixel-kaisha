import {
  SUMMARY_BALLOON_COMPACT_MAX_WIDTH_PX,
  SUMMARY_BALLOON_MAX_WIDTH_PX,
  SUMMARY_BALLOON_SHORT_MAX_WIDTH_PX,
  SUMMARY_BALLOON_SPEECH_LINES,
} from '../../constants.js';
import type { BalloonLines } from '../engine/agentSummary.js';

interface SummaryBalloonProps {
  lines: BalloonLines;
  /** Short screen (~360×374): smaller text, narrowest. */
  short: boolean;
  /** The agent in focus (hovered/selected): speech wraps to more lines, wider.
   *  Otherwise compact: one line per row, so balloons fit between colleagues. */
  expanded: boolean;
  agentId: number;
}

/**
 * Pixel Kaisha F2.1: what an agent last said and what it is doing, over its
 * head. Text exactly as the server sent it (already cut to length); a row
 * shows only when it has text, so a hooks-only agent (agy, Codex — no speech)
 * gets just its action. A row too long for the balloon ends in an ellipsis
 * (CSS only — the text itself is untouched) and the full text is the title.
 * Never takes the pointer: the character under it stays clickable.
 */
export function SummaryBalloon({ lines, short, expanded, agentId }: SummaryBalloonProps) {
  const title = [lines.speech, lines.action].filter((t) => t !== null).join('\n');
  const wrap = expanded && !short;
  const maxWidth = short
    ? SUMMARY_BALLOON_SHORT_MAX_WIDTH_PX
    : expanded
      ? SUMMARY_BALLOON_MAX_WIDTH_PX
      : SUMMARY_BALLOON_COMPACT_MAX_WIDTH_PX;
  const oneLine = 'whitespace-nowrap overflow-hidden text-ellipsis';
  return (
    <div
      className="pixel-panel px-6 pt-1 pb-3 flex flex-col gap-1 pointer-events-none"
      style={{ maxWidth }}
      title={title}
      data-testid="summary-balloon"
      data-agent-id={agentId}
    >
      {lines.speech !== null && (
        <span
          className={`leading-none break-words ${short ? 'text-2xs' : 'text-xs'} ${wrap ? '' : oneLine}`}
          style={
            wrap
              ? {
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: SUMMARY_BALLOON_SPEECH_LINES,
                  overflow: 'hidden',
                }
              : undefined
          }
          data-testid="summary-speech"
        >
          {lines.speech}
        </span>
      )}
      {lines.action !== null && (
        <span
          className={`text-2xs leading-none ${oneLine}`}
          style={{ color: 'var(--color-text-muted-solid)' }}
          data-testid="summary-action"
        >
          {lines.action}
        </span>
      )}
    </div>
  );
}
