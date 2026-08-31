import { config } from './config.js';
import { applyCommand, buildMirror, mirrorNoteFor, type Command } from './apply.js';
import { pollChatOnce } from './chat.js';

const AUTH = { authorization: `Bearer ${config.agentToken}` };
let running = true;

function log(message: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${config.relayUrl}${path}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
}

/** Push a snapshot of recent notes so read-side tools can answer without the Mac. */
async function syncMirror(): Promise<void> {
  const notes = await buildMirror();
  await postJson('/agent/mirror', { uid: config.uid || undefined, notes });
  log(`mirror synced (${notes.length} notes)`);
}

/**
 * Hold a long poll open on the relay. The relay answers the moment Omi queues a command,
 * so a spoken note reaches Apple Notes in about as long as the round trip takes.
 */
async function pollOnce(): Promise<boolean> {
  const url = `${config.relayUrl}/agent/next?wait=${config.longPollSeconds * 1000}`;
  const res = await fetch(url, {
    headers: AUTH,
    signal: AbortSignal.timeout((config.longPollSeconds + 15) * 1000),
  });

  if (res.status === 204) return false;
  if (res.status === 401) throw new Error('Relay rejected AGENT_TOKEN. Check your config.');
  if (!res.ok) throw new Error(`/agent/next -> HTTP ${res.status}`);

  const cmd = (await res.json()) as Command;
  log(`applying ${cmd.tool}`, cmd.payload);

  try {
    const { message, noteId } = await applyCommand(cmd);
    await postJson('/agent/result', { id: cmd.id, ok: true, result: message });
    log(`done: ${message.split('\n')[0]}`);

    // Refresh just the note we touched, so an immediate "what's on my list?" is correct
    // without paying for a full library resync.
    if (noteId) {
      const note = await mirrorNoteFor(noteId);
      if (note) await postJson('/agent/mirror-patch', { uid: config.uid || undefined, note });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postJson('/agent/result', { id: cmd.id, ok: false, error: message });
    log(`failed: ${message}`);
  }

  return true;
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  log(`omi-notes-agent starting; relay=${config.relayUrl}`);

  await syncMirror().catch((e) => {
    log(`initial mirror sync failed: ${e.message}`);
    if (/permission|Automation/i.test(e.message)) process.exitCode = 1;
  });

  if (config.omiMcpKey) {
    await pollChatOnce(log).catch((e) => log(`chat poll failed: ${e.message}`));
  }

  if (once) {
    log('--once: draining any queued commands, then exiting');
    while (await pollOnce().catch(() => false)) {
      /* keep draining while work remains */
    }
    return;
  }

  const mirrorTimer = setInterval(() => {
    syncMirror().catch((e) => log(`mirror sync failed: ${e.message}`));
  }, config.mirrorIntervalMs);
  mirrorTimer.unref();

  // Omi's chat is the only channel that actually reaches this user's Omi, so it is polled
  // independently of the relay queue. Both can drive Apple Notes.
  if (config.omiMcpKey) {
    const chatTimer = setInterval(() => {
      pollChatOnce(log).catch((e) => log(`chat poll failed: ${e.message}`));
    }, config.chatPollMs);
    chatTimer.unref();
    log(`watching Omi chat every ${Math.round(config.chatPollMs / 1000)}s`);
  } else {
    log('OMI_MCP_KEY not set; Omi chat will not be watched');
  }

  let backoffMs = 1000;
  while (running) {
    try {
      await pollOnce();
      backoffMs = 1000; // healthy round trip resets the backoff
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`poll error: ${message}; retrying in ${Math.round(backoffMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    running = false;
    setTimeout(() => process.exit(0), 200).unref();
  });
}

main().catch((err) => {
  console.error('[omi-notes-agent] fatal:', err);
  process.exit(1);
});
