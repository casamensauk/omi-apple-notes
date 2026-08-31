import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { buildManifest } from './manifest.js';
import { bestMatch } from './match.js';
import {
  bus,
  claimNext,
  completeCommand,
  enqueue,
  loadMirror,
  pendingCount,
  purgeOlderThan,
  reapStaleClaims,
  releaseClaim,
  saveMirror,
  adoptUnclaimedMirror,
  resetPinnedUid,
  UNCLAIMED_MIRROR,
  patchMirrorNote,
  getSetting,
  setSetting,
  markCommandSeen,
} from './db.js';
import { commandKey, parseSpokenCommand } from './commands.js';
import type { Mirror, ToolName, ToolReply } from './types.js';

const MAX_BODY_BYTES = 1_000_000;

/**
 * Read a JSON body of any shape. Omi's real-time transcript trigger POSTs a bare array of
 * segments, so the object-only reader below cannot be used for webhook payloads.
 */
async function readJsonAny(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function agentAuthorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token.length > 0 && constantTimeEquals(token, config.agentToken);
}

/** ---- coercion helpers: Omi's LLM is loose about shapes, so accept what it plausibly sends ---- */

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asItems(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(/\r?\n|,(?![^(]*\))/)
      : [];
  return raw
    .map((x) => (typeof x === 'string' ? x : String(x ?? '')))
    .map((s) => s.replace(/^\s*[-*•●]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 200);
}

/**
 * Decide whether this caller may drive the user's notes. With ALLOWED_UIDS unset we pin
 * the first uid we ever see, so an unlisted manifest cannot be used by a stranger who
 * finds the URL later.
 */
function uidAllowed(uid: string): boolean {
  if (!uid) return false;
  if (config.allowedUids.length > 0) return config.allowedUids.includes(uid);
  const pinned = getSetting('pinned_uid');
  if (!pinned) {
    setSetting('pinned_uid', uid);
    adoptUnclaimedMirror(uid);
    console.log(`[relay] pinned first-seen uid ${uid}`);
    return true;
  }
  return pinned === uid;
}

function waitForResult(id: string, ms: number): Promise<{ ok: boolean; result: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bus.off(`result:${id}`, onResult);
      resolve(null);
    }, ms);
    function onResult(payload: { ok: boolean; result: string }) {
      clearTimeout(timer);
      resolve(payload);
    }
    bus.once(`result:${id}`, onResult);
  });
}

/** Queue a mutation and, where possible, report what actually happened rather than "queued". */
async function dispatchWrite(
  uid: string,
  tool: ToolName,
  payload: Record<string, unknown>,
): Promise<ToolReply> {
  const cmd = enqueue(uid, tool, payload);
  const outcome = await waitForResult(cmd.id, config.writeWaitMs);
  if (!outcome) {
    return {
      result:
        "Saved to the queue. Your Mac isn't reachable right now, so I'll write this to " +
        'Apple Notes as soon as it comes back online.',
    };
  }
  return outcome.ok ? { result: outcome.result } : { error: outcome.result };
}

function mirrorFor(uid: string): { mirror: Mirror | null; stale: boolean } {
  const mirror = loadMirror(uid) ?? loadMirror(UNCLAIMED_MIRROR);
  if (!mirror) return { mirror: null, stale: true };
  return { mirror, stale: Date.now() - mirror.syncedAt > config.mirrorStaleMs };
}

async function handleTool(tool: ToolName, body: Record<string, unknown>): Promise<ToolReply> {
  const uid = asString(body.uid);
  if (!uid) return { error: 'Missing uid.' };
  if (config.omiAppId && asString(body.app_id) !== config.omiAppId) {
    return { error: 'This request did not come from the configured Omi app.' };
  }
  if (!uidAllowed(uid)) {
    return { error: 'This Apple Notes relay is not set up for your account.' };
  }

  switch (tool) {
    case 'create_note': {
      const title = asString(body.title);
      if (!title) return { error: 'I need a title for the note.' };
      return await dispatchWrite(uid, tool, {
        title,
        items: asItems(body.items),
        body: asString(body.body),
        folder: asString(body.folder),
      });
    }
    case 'add_to_note': {
      const title = asString(body.title);
      const items = asItems(body.items);
      if (!title) return { error: 'I need to know which note to add to.' };
      if (items.length === 0) return { error: 'I need at least one item to add.' };
      return await dispatchWrite(uid, tool, { title, items, section: asString(body.section) });
    }
    case 'remove_from_note': {
      const title = asString(body.title);
      const items = asItems(body.items);
      if (!title) return { error: 'I need to know which note to update.' };
      if (items.length === 0) return { error: 'I need at least one item to remove.' };
      return await dispatchWrite(uid, tool, { title, items });
    }
    case 'read_note': {
      const title = asString(body.title);
      if (!title) return { error: 'I need to know which note to read.' };
      const { mirror, stale } = mirrorFor(uid);
      if (!mirror || mirror.notes.length === 0) {
        return { error: "I can't reach your Mac, so I can't read your notes right now." };
      }
      const hit = bestMatch(mirror.notes, title, (n) => n.name);
      if (!hit) return { error: `I couldn't find a note matching "${title}".` };
      const note = hit.item;
      const lines = note.items.length > 0 ? note.items.join('\n- ') : note.preview;
      const prefix = note.items.length > 0 ? `${note.name}:\n- ${lines}` : `${note.name}:\n${lines}`;
      return { result: stale ? `${prefix}\n\n(This may be slightly out of date.)` : prefix };
    }
    case 'list_notes': {
      const query = asString(body.query);
      const { mirror } = mirrorFor(uid);
      if (!mirror || mirror.notes.length === 0) {
        return { error: "I can't reach your Mac, so I can't list your notes right now." };
      }
      const names = mirror.notes
        .filter((n) => !query || bestMatch([n], query, (x) => x.name, 0.3) !== null)
        .slice(0, 40)
        .map((n) => n.name);
      if (names.length === 0) return { result: `No notes matched "${query}".` };
      return { result: `Your notes:\n- ${names.join('\n- ')}` };
    }
  }
}

/**
 * Omi's trigger webhooks deliver speech in batches, and a command can straddle two of
 * them ("Omi, add tent pegs" / "to my camping list"). A short rolling buffer per user
 * stitches those back together; it is in-memory because losing it on restart costs
 * nothing worse than one missed command.
 */
const BUFFER_TTL_MS = 60_000;
const BUFFER_MAX_CHARS = 600;
const transcriptBuffers = new Map<string, { text: string; updatedAt: number }>();

function bufferUtterance(uid: string, text: string): string {
  const now = Date.now();
  const current = transcriptBuffers.get(uid);
  const carried = current && now - current.updatedAt < BUFFER_TTL_MS ? current.text : '';
  const combined = `${carried} ${text}`.trim().slice(-BUFFER_MAX_CHARS);
  transcriptBuffers.set(uid, { text: combined, updatedAt: now });
  return combined;
}

interface TranscriptSegment {
  text?: string;
  is_user?: boolean;
}

/** Pull the wearer's own speech out of either trigger payload shape. */
function wearerSpeech(body: unknown): string {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const segments: TranscriptSegment[] = Array.isArray(body)
    ? (body as TranscriptSegment[])
    : Array.isArray(record.transcript_segments)
      ? (record.transcript_segments as TranscriptSegment[])
      : [];
  return segments
    // Segments attributed to another speaker are conversation, not instructions to Omi.
    .filter((s) => s && typeof s.text === 'string' && s.is_user !== false)
    .map((s) => (s.text as string).trim())
    .filter(Boolean)
    .join(' ');
}

const TOOL_PATHS: Record<string, ToolName> = {
  '/tools/create_note': 'create_note',
  '/tools/add_to_note': 'add_to_note',
  '/tools/remove_from_note': 'remove_from_note',
  '/tools/read_note': 'read_note',
  '/tools/list_notes': 'list_notes',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      // Mirror counters make "is my Mac actually syncing?" answerable without log access.
      const pinned = getSetting('pinned_uid');
      const health = mirrorFor(pinned ?? UNCLAIMED_MIRROR);
      return send(res, 200, {
        ok: true,
        pending: pendingCount(),
        agentConfigured: config.agentToken.length > 0,
        mirrorNotes: health.mirror?.notes.length ?? 0,
        mirrorAgeSeconds: health.mirror
          ? Math.round((Date.now() - health.mirror.syncedAt) / 1000)
          : null,
      });
    }

    if (req.method === 'GET' && path === '/.well-known/omi-tools.json') {
      return send(res, 200, buildManifest());
    }

    /**
     * Omi's "Setup Completed URL". Setup here means the Mac agent is actually reachable,
     * so this reports real state rather than a constant true — if the agent is not running,
     * Omi tells the user their setup is incomplete instead of silently queueing forever.
     */
    if (req.method === 'GET' && path === '/setup-complete') {
      const pinned = getSetting('pinned_uid');
      const uid = asString(url.searchParams.get('uid') ?? '') || pinned || UNCLAIMED_MIRROR;
      const { mirror, stale } = mirrorFor(uid);
      const ready = config.agentToken.length > 0 && !!mirror && mirror.notes.length > 0 && !stale;
      return send(res, 200, { is_setup_completed: ready });
    }

    /**
     * Trigger webhook. Omi builds without the chat-tools manifest field can still drive
     * this app by pointing a Memory Creation or Real-Time Transcript trigger here.
     */
    if (req.method === 'POST' && (path === '/omi/webhook' || path === '/webhook')) {
      const body = await readJsonAny(req).catch(() => ({}));
      const asRecord = (v: unknown): Record<string, unknown> =>
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      // Omi's account-level developer webhooks may not carry a uid at all, unlike app
      // tool calls. This relay serves one person, so fall back to whoever already claimed
      // it rather than rejecting a payload we can perfectly well act on.
      const uid =
        asString(url.searchParams.get('uid') ?? '') ||
        asString(asRecord(body).uid) ||
        asString(asRecord(body).user_id) ||
        getSetting('pinned_uid') ||
        'default';
      if (!uidAllowed(uid)) {
        return send(res, 403, { error: 'This Apple Notes relay is not set up for your account.' });
      }

      const speech = wearerSpeech(body);
      if (config.debugWebhook) {
        // Shape only by default; the text itself is the user's private speech.
        const shape = Array.isArray(body) ? `array(${body.length})` : Object.keys(asRecord(body)).join(',');
        console.log(`[relay] webhook uid=${uid} shape=${shape} speechChars=${speech.length}`);
        if (speech) console.log(`[relay] speech: ${speech.slice(0, 300)}`);
      }
      if (!speech) return send(res, 200, { ok: true, matched: false });

      const parseOptions = {
        wakeWord: config.wakeWord,
        requireWakeWord: config.requireWakeWord,
      };
      // Try this batch alone before the rolling buffer: a command that is complete on its
      // own must never be contaminated by whatever was said a moment earlier.
      const combined = bufferUtterance(uid, speech);
      const command =
        parseSpokenCommand(speech, parseOptions) ?? parseSpokenCommand(combined, parseOptions);
      if (!command) return send(res, 200, { ok: true, matched: false });

      // Clear on any match, including a duplicate — leaving the utterance in the buffer
      // would prepend it to the next one.
      transcriptBuffers.delete(uid);

      // The real-time and memory-creation triggers both see the same utterance.
      if (!markCommandSeen(commandKey(uid, command), config.dedupeTtlMs)) {
        return send(res, 200, { ok: true, matched: true, duplicate: true });
      }
      console.log(`[relay] matched ${command.tool} "${command.title}" from speech`);

      const reply = await dispatchWrite(uid, command.tool, {
        title: command.title,
        items: command.items,
      });
      return send(res, 200, {
        ok: true,
        matched: true,
        command: command.tool,
        message: 'result' in reply ? reply.result : reply.error,
      });
    }

    if (req.method === 'POST' && path in TOOL_PATHS) {
      const body = await readJson(req);
      const reply = await handleTool(TOOL_PATHS[path], body);
      return send(res, 'error' in reply ? 400 : 200, reply);
    }

    // ---- macOS agent endpoints ----
    if (path.startsWith('/agent/')) {
      if (!config.agentToken) {
        return send(res, 503, {
          error: 'This relay has no AGENT_TOKEN set yet, so the Mac agent cannot connect.',
        });
      }
      if (!agentAuthorised(req)) return send(res, 401, { error: 'Unauthorized' });

      if (req.method === 'GET' && path === '/agent/next') {
        const waitMs = Math.min(Number(url.searchParams.get('wait') ?? 25000) || 25000, 55000);
        reapStaleClaims(60_000);
        const immediate = claimNext();
        if (immediate) return send(res, 200, immediate);

        const cmd = await new Promise<ReturnType<typeof claimNext>>((resolve) => {
          let settled = false;
          const finish = (value: ReturnType<typeof claimNext>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            bus.off('enqueued', onEnqueued);
            req.off('close', onClose);
            resolve(value);
          };
          const timer = setTimeout(() => finish(null), waitMs);
          function onEnqueued() {
            // An agent that has gone away must not take a command with it: claiming here
            // and writing to a dead socket loses the command until the reaper rescues it.
            if (req.destroyed || res.writableEnded) return finish(null);
            const claimed = claimNext();
            if (!claimed) return; // another waiter won the race; keep waiting
            if (req.destroyed || res.writableEnded) {
              releaseClaim(claimed.id);
              return finish(null);
            }
            finish(claimed);
          }
          // The agent restarting, or any dropped connection, closes the request. Without
          // this the handler lingers and swallows the next command that arrives.
          function onClose() {
            finish(null);
          }
          bus.on('enqueued', onEnqueued);
          req.on('close', onClose);
        });
        if (!cmd) {
          if (req.destroyed || res.writableEnded) return;
          return send(res, 204, {});
        }
        if (req.destroyed || res.writableEnded) {
          releaseClaim(cmd.id);
          return;
        }
        return send(res, 200, cmd);
      }

      if (req.method === 'POST' && path === '/agent/result') {
        const body = await readJson(req);
        const id = asString(body.id);
        const ok = body.ok === true;
        const result = asString(body.result) || asString(body.error) || (ok ? 'Done.' : 'Failed.');
        if (!id) return send(res, 400, { error: 'Missing id' });
        const applied = completeCommand(id, ok, result);
        return send(res, 200, { applied });
      }

      if (req.method === 'POST' && path === '/agent/reset-uid') {
        const previous = resetPinnedUid();
        console.log(`[relay] pinned uid reset (was ${previous ?? 'unset'})`);
        return send(res, 200, { reset: true, previous });
      }

      if (req.method === 'POST' && path === '/agent/mirror-patch') {
        const body = await readJson(req);
        const uid = asString(body.uid) || getSetting('pinned_uid') || UNCLAIMED_MIRROR;
        const note = body.note as Mirror['notes'][number] | undefined;
        if (!note || typeof note.id !== 'string') return send(res, 400, { error: 'Missing note' });
        patchMirrorNote(uid, note);
        return send(res, 200, { patched: note.id });
      }

      if (req.method === 'POST' && path === '/agent/mirror') {
        const body = await readJson(req);
        const uid = asString(body.uid) || getSetting('pinned_uid') || UNCLAIMED_MIRROR;
        const notes = Array.isArray(body.notes) ? (body.notes as Mirror['notes']) : [];
        saveMirror(uid, { notes, syncedAt: Date.now() });
        return send(res, 200, { stored: notes.length });
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[relay] request failed', err);
    return send(res, 500, { error: 'Internal error' });
  }
});

setInterval(() => purgeOlderThan(7 * 24 * 60 * 60 * 1000), 60 * 60 * 1000).unref();

server.listen(config.port, () => {
  console.log(`[relay] listening on :${config.port}`);
  if (!config.agentToken) {
    console.warn('[relay] AGENT_TOKEN is unset; the Mac agent cannot connect until it is set.');
  }
  if (!config.publicBaseUrl) {
    console.warn('[relay] PUBLIC_BASE_URL is unset; manifest will advertise relative endpoints.');
  }
});
