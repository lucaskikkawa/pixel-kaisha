import { Fragment, useEffect, useRef, useState } from 'react';

import { agentEngineBadge } from '../../cloud/engineBadge.js';
import { useShortScreen } from '../../cloud/useShortScreen.js';
import { Button } from '../../components/ui/Button.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_GAUGE_GAP_PX,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTROL_RECTS_REFRESH_MS,
  ENGINE_BADGE_TEXT_COLOR,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  SUMMARY_BALLOON_GAP_PX,
  SUMMARY_BALLOON_MAX_LIFT_TILES,
  SUMMARY_BALLOON_STEP_PX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_GAP_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { ContextBar } from '../ContextBar.js';
import { contextLeft } from '../contextGauge.js';
import type { BalloonLines } from '../engine/agentSummary.js';
import { balloonLines } from '../engine/agentSummary.js';
import type { BalloonOffset, BalloonRequest, Rect } from '../engine/balloonLayout.js';
import { placeBalloons, rectsOverlap } from '../engine/balloonLayout.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { ToolActivity } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';
import { SummaryBalloon } from './SummaryBalloon.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

/** The office's own overlay elements, never obstacles to its balloons. */
const OVERLAY_SELECTOR = '[data-testid="agent-overlay"], [data-testid="summary-balloon"]';
/** UI over the office a balloon must not sit under: controls, panels, notices. */
const CONTROL_SELECTOR = 'button, a[href], input, select, textarea, [role="button"], .pixel-panel';

/**
 * F2.1: the rects (office-relative CSS px) of the UI drawn over the office —
 * buttons, panels, cards, the radio, notices — so no balloon hides under them.
 * Cached for CONTROL_RECTS_REFRESH_MS: reading layout every frame is wasteful.
 */
function controlRects(officeRect: DOMRect, cache: { at: number; rects: Rect[] }): Rect[] {
  const now = performance.now();
  if (now - cache.at < CONTROL_RECTS_REFRESH_MS) return cache.rects;
  const rects: Rect[] = [];
  for (const node of document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
    if (node.closest(OVERLAY_SELECTOR)) continue;
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || !rectsOverlap(r, officeRect)) continue;
    rects.push({
      left: r.left - officeRect.left,
      top: r.top - officeRect.top,
      right: r.right - officeRect.left,
      bottom: r.bottom - officeRect.top,
    });
  }
  cache.at = now;
  cache.rects = rects;
  return rects;
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  // Short screen (~360×374): compact labels — smaller text, no directory line.
  const short = useShortScreen();
  // F2.1: the balloons' and labels' last measured sizes (CSS px), keyed
  // `balloon:<id>` / `label:<id>`. The overlay re-renders every frame, so a
  // size measured on one frame places the balloons on the next.
  const sizesRef = useRef(new Map<string, { w: number; h: number }>());
  const measure = (key: string) => (node: HTMLElement | null) => {
    if (node) sizesRef.current.set(key, { w: node.offsetWidth, h: node.offsetHeight });
  };
  // F2.1: the balloons' offsets last frame (kept while still clear) and the
  // office's controls, re-read every CONTROL_RECTS_REFRESH_MS.
  const offsetsRef = useRef(new Map<number, BalloonOffset>());
  const controlsRef = useRef({ at: 0, rects: [] as Rect[] });
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const containerRect = el.getBoundingClientRect();
  const project = overlayProjection(
    officeState.getLayout(),
    containerRect,
    zoom,
    panRef.current,
    dpr,
  );
  const sizes = sizesRef.current;
  // F2.1: what the balloons must keep clear of, and the balloons to place.
  const obstacles: Rect[] = [...controlRects(containerRect, controlsRef.current)];
  const balloonRequests: Array<BalloonRequest & { lines: BalloonLines; front: boolean }> = [];

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  // Hovering a sub-agent swaps its lead's label for its own (they'd overlap).
  const hoveredSubParentId =
    hoveredId !== null
      ? subagentCharacters.find((s) => s.id === hoveredId)?.parentAgentId
      : undefined;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  const characterNodes = allIds.map((id) => {
    const ch = officeState.characters.get(id);
    if (!ch) return null;

    const isSelected = selectedId === id;
    const isHovered = hoveredId === id;
    const isSub = ch.isSubagent;

    // Speech bubble (permission dots / done checkmark) — rendered here in
    // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
    // character regardless of label visibility. Mirrors the geometry the
    // canvas renderer used. The idle "Waiting for input" state speaks
    // through its label, not a bubble.
    let bubbleNode = null;
    // Screen y of the bubble's top edge, when one shows: the label stacks above it.
    let bubbleTop: number | null = null;
    if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
      const cachedBubble = getCachedSprite(
        ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
        zoom,
      );
      const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
      const alpha =
        ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
          ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
          : 1;
      bubbleTop =
        project.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
        (cachedBubble.height + zoom) / dpr;
      bubbleNode = (
        <div
          className="absolute -translate-x-1/2 pointer-events-none"
          style={{
            left: project.toScreenX(ch.x),
            // Bubble bottom sits one sprite pixel above the character's
            // anchor: project the anchor, then lift by the bubble's own
            // device-pixel height plus one zoomed pixel, in CSS px.
            top: bubbleTop,
            opacity: alpha,
            zIndex: OVERLAY_BUBBLE_Z_INDEX,
          }}
        >
          <OverlayBubble cached={cachedBubble} dpr={dpr} />
        </div>
      );
    }

    // Position above character: the sprite's top edge (the tallest hair
    // reaches it), or the bubble's when one shows over the head.
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const screenX = project.toScreenX(ch.x);
    const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);
    const labelBottom = Math.min(screenY, bubbleTop ?? screenY) - TOOL_OVERLAY_GAP_PX;

    // Pixel Kaisha F2.1: the character's sprite (and bubble) are obstacles
    // no balloon may cover. Its own balloon is asked for here and placed
    // after every character is known (placeBalloons, below).
    if (ch.matrixEffect !== 'despawn') {
      obstacles.push({
        left: project.toScreenX(ch.x - CHARACTER_HIT_HALF_WIDTH),
        right: project.toScreenX(ch.x + CHARACTER_HIT_HALF_WIDTH),
        top: Math.min(screenY, bubbleTop ?? screenY),
        bottom: project.toScreenY(ch.y + sittingOffset),
      });
    }
    const lines = isSub ? null : balloonLines(officeState.getAgentSummary(id));
    // Gives way, with the label, to a hovered sub-agent's label.
    const askBalloon = (labelShown: boolean) => {
      if (!lines || id === hoveredSubParentId) return;
      const size = sizes.get(`balloon:${id}`) ?? { w: 0, h: 0 };
      const labelH = labelShown ? (sizes.get(`label:${id}`)?.h ?? 0) : 0;
      balloonRequests.push({
        id,
        lines,
        front: isSelected || isHovered,
        centerX: screenX,
        bottom: labelBottom - labelH - SUMMARY_BALLOON_GAP_PX,
        width: size.w,
        height: size.h,
        prefer: offsetsRef.current.get(id),
      });
    };

    // Only show the label for hovered or selected agents (unless
    // always-show is on) — the bubble renders regardless.
    if (!alwaysShowOverlay && !isSelected && !isHovered) {
      askBalloon(false);
      return bubbleNode && <Fragment key={id}>{bubbleNode}</Fragment>;
    }

    // A "Done" agent (finished turn: waiting bubble without awaitingInput)
    // shows ONLY its floating green checkmark bubble, never the label panel
    // (the panel would cover the bubble). Render an empty positioned marker
    // so overlay counts stay stable and hover/select can still bring the
    // panel back. When always-show is off, the early return above already
    // keeps the panel hidden for idle agents.
    // Likewise for a label that gives way: a sub-agent's shows only while
    // hovered or selected, even with always-show on (the lead's label
    // already names the subtask), and a hovered sub-agent's lead hides
    // its own so the sub's isn't covered.
    const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
    const givesWay = (isSub && !isSelected && !isHovered) || id === hoveredSubParentId;
    if ((isDone && !isSelected && !isHovered) || givesWay) {
      askBalloon(false);
      return (
        <Fragment key={id}>
          {bubbleNode}
          <div
            className="absolute"
            style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
            data-testid="agent-overlay"
            data-agent-id={id}
          />
        </Fragment>
      );
    }

    // Get activity text
    const hasWaitingBubble = ch.bubbleType === 'waiting';
    const subHasPermission = isSub && ch.bubbleType === 'permission';
    let activityText: string;
    if (hasWaitingBubble && ch.waitingAwaitingInput) {
      // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
      // shows only the checkmark and falls through to the normal idle text.
      activityText = WAITING_INPUT_ACTIVITY_TEXT;
    } else if (isSub) {
      if (subHasPermission) {
        activityText = 'Needs approval';
      } else {
        // Hover shows the subtask title; SELECTING the sub reveals its live
        // tool activity (watched sub-agents stream it via subagentToolStart).
        const sub = subagentCharacters.find((s) => s.id === id);
        const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
        const activeRow = isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
        activityText = activeRow?.status ?? (sub?.label || 'Subtask');
      }
    } else {
      activityText = getActivityText(
        id,
        agentTools,
        ch.isActive,
        ch.bubbleType,
        ch.waitingAwaitingInput ?? false,
      );
    }

    // Determine dot color
    const tools = agentTools[id];
    const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
    const hasActiveTools = tools?.some((t) => !t.done);
    const isActive = ch.isActive;
    const hasWaiting = ch.bubbleType === 'waiting';

    let dotColor: string | null = null;
    if (hasPermission || hasWaiting) {
      dotColor = 'var(--color-status-permission)';
    } else if (isActive && hasActiveTools) {
      dotColor = 'var(--color-status-active)';
    }

    // Team info
    const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;

    // Context gauge. Every agent gets one — lead, teammate, adopted,
    // headless — as soon as the server reports its context (a cleared
    // session's 0 included: a full gauge). Sub-agents never do: they have
    // no session of their own, so nothing is ever reported for them.
    // Drawn as a health bar: full when the context is empty, draining as
    // it fills (the colour still warns by the share used).
    const contextRatio = ch.contextTokens / ch.maxContextTokens;
    const showContextGauge = !isSub && ch.contextReported === true;

    const labelSize = sizes.get(`label:${id}`);
    if (labelSize) {
      obstacles.push({
        left: screenX - labelSize.w / 2,
        right: screenX + labelSize.w / 2,
        top: labelBottom - labelSize.h,
        bottom: labelBottom,
      });
    }
    askBalloon(true);

    return (
      <Fragment key={id}>
        {bubbleNode}
        <div
          // The label grows upward from labelBottom, so extra lines and the
          // context gauge never reach down over the head.
          className="absolute flex flex-col items-center -translate-x-1/2 -translate-y-full"
          style={{
            left: screenX,
            top: labelBottom,
            pointerEvents: isSelected ? 'auto' : 'none',
            opacity: alwaysShowOverlay && !isSelected && !isHovered ? 0.75 : 1,
            zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
          }}
          data-testid="agent-overlay"
          data-agent-id={id}
          ref={measure(`label:${id}`)}
        >
          <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
            {dotColor && (
              <span
                className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                style={{ background: dotColor }}
              />
            )}
            <div className="flex flex-col gap-0 overflow-hidden">
              {teamRoleLabel && (
                <span
                  className="overflow-hidden text-ellipsis block leading-none"
                  style={{
                    fontSize: '18px',
                    color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                    fontWeight: ch.isTeamLead ? 'bold' : undefined,
                  }}
                >
                  {teamRoleLabel}
                </span>
              )}
              {!isSub && (
                <span
                  className="self-start leading-none px-3 text-2xs"
                  data-testid="engine-badge"
                  style={{
                    background: agentEngineBadge(id).color,
                    color: ENGINE_BADGE_TEXT_COLOR,
                  }}
                >
                  {agentEngineBadge(id).label}
                </span>
              )}
              <span
                className="overflow-hidden text-ellipsis block leading-none"
                style={{
                  fontSize: short ? '18px' : isSub ? '20px' : '22px',
                  fontStyle: isSub ? 'italic' : undefined,
                }}
              >
                {activityText}
              </span>
              {ch.directoryName && !short && (
                <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                  {ch.directoryName}
                </span>
              )}
            </div>
            {isSelected && !isSub && (
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseAgent(id);
                }}
                title="Close agent"
                className="ml-2 shrink-0"
              >
                {/* The panel's padding favours the text (pb > pt) and the × fills
                        rows 1–5 of its grid: 3px lower centres it on the label line. */}
                <PixelIcon name="close" className="translate-y-3" />
              </Button>
            )}
          </div>
          {showContextGauge && (
            <ContextBar
              used={contextRatio}
              width={CONTEXT_GAUGE_WIDTH_PX}
              height={CONTEXT_GAUGE_HEIGHT_PX}
              style={{ marginTop: CONTEXT_GAUGE_GAP_PX }}
              title={`${Math.round(contextLeft(contextRatio) * 100)}% context left (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens used)`}
              testId="context-gauge"
              pct={Math.round(contextRatio * 100)}
            />
          )}
        </div>
      </Fragment>
    );
  });

  // F2.1: place the balloons — the selected/hovered agent's first, then front
  // to back — clear of every character, label and other balloon.
  balloonRequests.sort((a, b) => Number(b.front) - Number(a.front) || b.bottom - a.bottom);
  const placements = placeBalloons(balloonRequests, obstacles, {
    bounds: { width: containerRect.width, height: containerRect.height },
    maxLiftPx: (SUMMARY_BALLOON_MAX_LIFT_TILES * TILE_SIZE * zoom) / dpr,
    stepPx: SUMMARY_BALLOON_STEP_PX,
    marginPx: SUMMARY_BALLOON_GAP_PX,
  });
  offsetsRef.current = new Map(
    [...placements].filter(([, p]) => p.clear).map(([id, p]) => [id, { dx: p.dx, lift: p.lift }]),
  );

  return (
    <>
      {characterNodes}
      {balloonRequests.map((r) => {
        const at = placements.get(r.id);
        // No clear spot: hidden, except for the agent in focus (hovered or
        // selected), whose balloon is first in line and is never lost.
        const shown = r.width > 0 && (at?.clear || r.front);
        return (
          <div
            key={`balloon-${r.id}`}
            ref={measure(`balloon:${r.id}`)}
            className="absolute pointer-events-none"
            style={{
              // Its own size wherever it sits, so the measurement holds near an edge.
              width: 'max-content',
              left: at?.left ?? r.centerX,
              top: at?.top ?? r.bottom,
              // Unmeasured (first frame) or no room: laid out but not shown.
              visibility: shown ? 'visible' : 'hidden',
              zIndex: r.front ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
            }}
          >
            <SummaryBalloon lines={r.lines} short={short} expanded={r.front} agentId={r.id} />
          </div>
        );
      })}
    </>
  );
}
