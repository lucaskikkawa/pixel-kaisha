#!/usr/bin/env node
/**
 * Pixel Kaisha v0.1 capture (F3): starts the webview dev server with the cloud
 * mock (`?mock=cloud`, see docs/kaisha/protocol-cloud.md), takes screenshots in
 * three viewports and records a ~15 s video, converted to mp4 with ffmpeg.
 *
 * Usage:
 *   node scripts/kaisha-capture.mjs [--out DIR] [--url URL] [--seconds 15]
 *
 *   --out      output dir (default /tmp/pixel-kaisha-capture; keep it OUT of the repo)
 *   --url      capture an already running UI instead of starting the dev server
 *              (e.g. the box server http://127.0.0.1:3100/?token=… once B3 lands;
 *              the mock query is only added to the dev server URL)
 *   --seconds  video length (default 15)
 *
 * Browser: Playwright's Chromium, or set KAISHA_CHROME to a Chrome binary
 * (falls back to /usr/bin/google-chrome when present). Binaries produced here
 * are artifacts: do not commit them.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = path.resolve(arg('out', '/tmp/pixel-kaisha-capture'));
const seconds = Number(arg('seconds', '15'));
const externalUrl = arg('url', '');
const port = Number(arg('port', '5187'));

export const VIEWPORTS = [
  { name: 'desktop-1280x800', width: 1280, height: 800, mobile: false },
  { name: 'mobile-412x915', width: 412, height: 915, mobile: true },
  { name: 'cover-360x374', width: 360, height: 374, mobile: true },
];

function chromePath() {
  if (process.env.KAISHA_CHROME) return process.env.KAISHA_CHROME;
  return existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
}

async function waitForHttp(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`UI did not come up at ${url}`);
}

function startDevServer() {
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: path.join(root, 'webview-ui'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

// The dev mock has no server, so the "Connecting…" pill is noise in captures.
const HIDE_CONNECTING = `
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.pixel-panel')) {
      if (el.textContent && el.textContent.startsWith('Connecting')) el.style.display = 'none';
    }
  }).observe(document, { childList: true, subtree: true });
`;

async function settle(page) {
  await page.waitForSelector('[data-testid="cloud-ghosts"]', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let server = null;
  let url = externalUrl;
  if (!url) {
    server = startDevServer();
    url = `http://localhost:${port}/?mock=cloud`;
    await waitForHttp(`http://localhost:${port}/`, 60_000);
  }

  const browser = await chromium.launch({ executablePath: chromePath() });
  const files = [];
  try {
    // 1. Screenshots: one per viewport, after the poll mock turns the running task ready.
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        deviceScaleFactor: vp.mobile ? 2 : 1,
      });
      await ctx.addInitScript(HIDE_CONNECTING);
      const page = await ctx.newPage();
      await page.goto(url);
      await settle(page);
      const first = path.join(outDir, `${vp.name}-polling.png`);
      await page.screenshot({ path: first });
      await page.waitForTimeout(8000);
      const after = path.join(outDir, `${vp.name}.png`);
      await page.screenshot({ path: after });
      files.push(first, after);
      await ctx.close();
    }

    // 2. Video (~15 s, desktop): ghosts appear, the running task turns ready,
    //    a hover over a ghost shows its tooltip.
    const videoDir = path.join(outDir, 'video-raw');
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
    });
    await ctx.addInitScript(HIDE_CONNECTING);
    const page = await ctx.newPage();
    const started = Date.now();
    await page.goto(url);
    await settle(page);
    const ghost = page.locator('[data-testid="cloud-ghost"]').first();
    if (await ghost.count()) await ghost.hover().catch(() => {});
    const left = seconds * 1000 - (Date.now() - started);
    if (left > 0) await page.waitForTimeout(left);
    await ctx.close();
    const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
    if (!webm) throw new Error('no video recorded');
    const webmPath = path.join(outDir, 'pixel-kaisha-v0.1.webm');
    renameSync(path.join(videoDir, webm), webmPath);
    rmSync(videoDir, { recursive: true, force: true });
    const mp4 = path.join(outDir, 'pixel-kaisha-v0.1.mp4');
    const ff = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        webmPath,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { stdio: 'inherit' },
    );
    if (ff.status === 0) {
      rmSync(webmPath);
      files.push(mp4);
    } else {
      console.warn('ffmpeg failed; keeping the webm');
      files.push(webmPath);
    }
  } finally {
    await browser.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid);
      } catch {
        server.kill();
      }
    }
  }

  console.log(`Captured ${files.length} files in ${outDir}:`);
  for (const f of files) console.log(`  ${path.basename(f)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
