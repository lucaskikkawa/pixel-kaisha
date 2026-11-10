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
 *   --only-dir NAME  real server only: before capturing, turn "Watch All
 *              Sessions" off (the office's own setting) and dismiss every
 *              agent whose directory is not NAME (e.g. `sandbox`) — dismissing
 *              only stops the office from tracking a session, it never touches
 *              the session itself. After capturing, the office is checked again
 *              and the script fails if any other directory shows up.
 *
 *   --ui-dist DIR  real server only: serve this webview build (e.g. dist/webview
 *              from `npm run build` on this branch) on a local port and proxy
 *              /ws, /api and anything not in DIR to the real server. Lets a
 *              branch's UI be captured against the running server without
 *              rebuilding or restarting it.
 *
 *   The tokened URL can come from KAISHA_URL instead of --url, so the token
 *   stays out of the process list, e.g.
 *     KAISHA_URL="$(scripts/box-run.sh url)" node scripts/kaisha-capture.mjs --only-dir sandbox
 *
 * Browser: Playwright's Chromium, or set KAISHA_CHROME to a Chrome binary
 * (falls back to /usr/bin/google-chrome when present). Binaries produced here
 * are artifacts: do not commit them.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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
const externalUrl = arg('url', process.env.KAISHA_URL ?? '');
const onlyDir = arg('only-dir', '');
const uiDist = arg('ui-dist', '');
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

// Noise in captures, hidden in the page only (no setting is changed): the
// dev mock's "Connecting…" pill and the first-run hooks tooltip.
const HIDE_CONNECTING = `
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.pixel-panel')) {
      const t = el.textContent || '';
      if (t.startsWith('Connecting') || t.startsWith('Instant Detection Active')) el.style.display = 'none';
    }
  }).observe(document, { childList: true, subtree: true });
`;

async function settle(page) {
  await page.waitForSelector('[data-testid="cloud-ghosts"]', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/**
 * Talk to the real server over its WebSocket (same protocol as the UI): read
 * the agent snapshot and, with `fix`, turn Watch All Sessions off and dismiss
 * agents outside `dir`. Returns the directory of every agent left.
 */
async function officeAgents(pageUrl, dir, fix) {
  const u = new URL(pageUrl);
  const token = u.searchParams.get('token');
  if (!token) throw new Error('--only-dir needs the tokened URL (?token=)');
  const ws = new WebSocket(`ws://${u.host}/ws?token=${encodeURIComponent(token)}`, {
    headers: { Origin: `http://${u.host}` },
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no existingAgents from server')), 10_000);
    ws.onerror = () => reject(new Error('WebSocket error'));
    ws.onopen = () => send({ type: 'webviewReady' });
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === 'existingAgents') {
        clearTimeout(timer);
        resolve(m);
      }
    };
  });
  const dirs = snapshot.directoryNames ?? {};
  const outside = (snapshot.agents ?? []).filter((id) => dirs[id] !== dir);
  if (fix) {
    send({ type: 'setWatchAllSessions', enabled: false });
    for (const id of outside) send({ type: 'closeAgent', id });
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`Watch All Sessions off; dismissed ${outside.length} agent(s) outside "${dir}".`);
  }
  ws.close();
  return (snapshot.agents ?? []).map((id) => dirs[id] ?? '?');
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Serve `dist` and proxy the rest (HTTP + WebSocket upgrades) to `target`. */
function startUiProxy(dist, target, listenPort) {
  const t = new URL(target);
  const forward = (req, res) => {
    const up = http.request(
      { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const isApi =
      pathname === '/ws' || pathname.startsWith('/api/') || pathname.startsWith('/terminal');
    let file = path.join(dist, pathname === '/' ? 'index.html' : pathname);
    if (!isApi && file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      });
      createReadStream(file).pipe(res);
      return;
    }
    forward(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)));
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

  if (onlyDir) {
    if (!externalUrl)
      throw new Error('--only-dir only applies to a real server (--url / KAISHA_URL)');
    await officeAgents(url, onlyDir, true);
  }

  let pageUrl = url;
  let proxy = null;
  if (uiDist) {
    if (!externalUrl)
      throw new Error('--ui-dist only applies to a real server (--url / KAISHA_URL)');
    const dist = path.resolve(uiDist);
    if (!existsSync(path.join(dist, 'index.html'))) throw new Error(`no index.html in ${dist}`);
    proxy = await startUiProxy(dist, url, port + 1);
    const u = new URL(url);
    pageUrl = `http://localhost:${port + 1}/${u.search}`;
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
      await page.goto(pageUrl);
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
    await page.goto(pageUrl);
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
    proxy?.close();
    if (server?.pid) {
      try {
        process.kill(-server.pid);
      } catch {
        server.kill();
      }
    }
  }

  if (onlyDir) {
    const left = await officeAgents(url, onlyDir, false);
    const stray = left.filter((d) => d !== onlyDir);
    if (stray.length) throw new Error(`agents outside "${onlyDir}" appeared: ${stray.join(', ')}`);
    console.log(`Checked: ${left.length} agent(s), all in "${onlyDir}".`);
  }

  console.log(`Captured ${files.length} files in ${outDir}:`);
  for (const f of files) console.log(`  ${path.basename(f)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
