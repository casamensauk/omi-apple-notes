import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./index.js', import.meta.url));
const TOKEN = 'test-token';
const PORT = 39411;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('relay did not start');
}

/**
 * Regression: an agent that disconnects mid-poll must not take a queued command with it.
 * The orphaned handler used to claim the command and write it to a dead socket, losing it
 * until the 60s stale-claim reaper ran.
 */
test('a command queued after an agent disconnects is still delivered to the next poll', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omi-relay-test-'));
  const server: ChildProcess = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: join(dir, 'test.db'),
      AGENT_TOKEN: TOKEN,
      WRITE_WAIT_MS: '400',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  await waitForHealth();
  const auth = { authorization: `Bearer ${TOKEN}` };

  // An agent opens a long poll, then goes away (a restart, or a dropped connection).
  const abandoned = new AbortController();
  const abandonedPoll = fetch(`${BASE}/agent/next?wait=20000`, {
    headers: auth,
    signal: abandoned.signal,
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 300));
  abandoned.abort();
  await abandonedPoll;
  await new Promise((r) => setTimeout(r, 200));

  // A command arrives while nothing is listening.
  const queued = await fetch(`${BASE}/tools/create_note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: 'u1', tool_name: 'create_note', title: 'Longpoll Check' }),
  }).then((r) => r.json());
  assert.ok('result' in queued, 'the write should be accepted and queued');

  // The replacement agent must get it promptly, not after the 60s reaper.
  const started = Date.now();
  const res = await fetch(`${BASE}/agent/next?wait=5000`, { headers: auth });
  assert.equal(res.status, 200, 'the queued command should be delivered');
  const cmd = (await res.json()) as { tool: string; payload: { title: string } };
  assert.equal(cmd.tool, 'create_note');
  assert.equal(cmd.payload.title, 'Longpoll Check');
  assert.ok(Date.now() - started < 5000, 'it should arrive without waiting for the reaper');
});
