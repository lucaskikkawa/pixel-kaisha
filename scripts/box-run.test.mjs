// Smoke tests for scripts/box-run.sh that never start a server: they use an
// unused port and a throwaway tmux session name, so they are safe on any box.
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./box-run.sh', import.meta.url));
const env = {
  ...process.env,
  KAISHA_PORT: '3999',
  KAISHA_SESSION: `kaisha-test-${process.pid}`,
};
const run = (...args) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });

test('help lists the commands', () => {
  const r = run('help');
  assert.equal(r.status, 0);
  for (const cmd of ['start', 'stop', 'status']) assert.match(r.stdout, new RegExp(cmd));
});

test('unknown command fails with a message', () => {
  const r = run('bogus');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command/);
});

test('status reports DOWN and exits non-zero when nothing runs', () => {
  const r = run('status');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not running/);
  assert.match(r.stdout, /health: DOWN/);
});

test('stop is a no-op when nothing runs', () => {
  const r = run('stop');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not running/);
});
