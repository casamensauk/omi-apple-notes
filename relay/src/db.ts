import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { Command, Mirror, ToolName } from './types.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    tool TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_commands_pending ON commands(status, created_at);
  CREATE TABLE IF NOT EXISTS mirror (
    uid TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

/** Wakes long-polling agents the moment a command lands, and unblocks tool calls on result. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

function rowToCommand(r: Record<string, unknown>): Command {
  return {
    id: r.id as string,
    uid: r.uid as string,
    tool: r.tool as ToolName,
    payload: JSON.parse(r.payload as string),
    status: r.status as Command['status'],
    result: (r.result as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function enqueue(uid: string, tool: ToolName, payload: Record<string, unknown>): Command {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO commands (id, uid, tool, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, uid, tool, JSON.stringify(payload), now, now);
  bus.emit('enqueued');
  return { id, uid, tool, payload, status: 'pending', result: null, createdAt: now, updatedAt: now };
}

/**
 * Atomically hand the oldest pending command to one agent. Claiming rather than peeking
 * means a second agent (or a reconnecting one) cannot apply the same edit twice.
 */
export function claimNext(): Command | null {
  const row = db
    .prepare(`SELECT * FROM commands WHERE status = 'pending' ORDER BY created_at LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const claimed = db
    .prepare(`UPDATE commands SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(Date.now(), row.id as string);
  if (claimed.changes === 0) return null;
  return rowToCommand({ ...row, status: 'claimed' });
}

/** Return commands whose agent went away mid-flight to the queue. */
export function reapStaleClaims(olderThanMs: number): number {
  return db
    .prepare(`UPDATE commands SET status = 'pending' WHERE status = 'claimed' AND updated_at < ?`)
    .run(Date.now() - olderThanMs).changes as number;
}

export function completeCommand(id: string, ok: boolean, result: string): boolean {
  const info = db
    .prepare(`UPDATE commands SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status IN ('pending','claimed')`)
    .run(ok ? 'done' : 'failed', result, Date.now(), id);
  if (info.changes > 0) bus.emit(`result:${id}`, { ok, result });
  return info.changes > 0;
}

export function getCommand(id: string): Command | null {
  const row = db.prepare(`SELECT * FROM commands WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToCommand(row) : null;
}

/** Commands still unclaimed after this long are almost certainly from a Mac that was asleep. */
export function pendingCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM commands WHERE status IN ('pending','claimed')`).get() as {
    n: number;
  };
  return row.n;
}

export function purgeOlderThan(ms: number): number {
  return db
    .prepare(`DELETE FROM commands WHERE status IN ('done','failed') AND updated_at < ?`)
    .run(Date.now() - ms).changes as number;
}

export function saveMirror(uid: string, mirror: Mirror): void {
  db.prepare(
    `INSERT INTO mirror (uid, json, synced_at) VALUES (?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET json = excluded.json, synced_at = excluded.synced_at`,
  ).run(uid, JSON.stringify(mirror.notes), mirror.syncedAt);
}

/**
 * Mirror rows are keyed by uid, but the agent starts syncing before any tool call has
 * revealed one. Those early snapshots land here and are adopted once the uid is known.
 */
export const UNCLAIMED_MIRROR = '__unclaimed__';

/** Re-key the pre-uid snapshot onto the real uid, so reads work from the very first call. */
export function adoptUnclaimedMirror(uid: string): void {
  const unclaimed = loadMirror(UNCLAIMED_MIRROR);
  if (!unclaimed || loadMirror(uid)) return;
  saveMirror(uid, unclaimed);
  db.prepare(`DELETE FROM mirror WHERE uid = ?`).run(UNCLAIMED_MIRROR);
}

export function loadMirror(uid: string): Mirror | null {
  const row = db.prepare(`SELECT json, synced_at FROM mirror WHERE uid = ?`).get(uid) as
    | { json: string; synced_at: number }
    | undefined;
  if (!row) return null;
  return { notes: JSON.parse(row.json), syncedAt: row.synced_at };
}

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Refresh one note in the mirror after an edit. Cheaper and far fresher than waiting for
 * the next full sync, which on a large library takes seconds. syncedAt is deliberately
 * left alone: a patch proves this note is current, not that the whole mirror is.
 */
export function patchMirrorNote(uid: string, note: Mirror['notes'][number]): void {
  const current = loadMirror(uid) ?? { notes: [], syncedAt: 0 };
  const rest = current.notes.filter((n) => n.id !== note.id);
  const notes = [note, ...rest];
  db.prepare(
    `INSERT INTO mirror (uid, json, synced_at) VALUES (?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET json = excluded.json`,
  ).run(uid, JSON.stringify(notes), current.syncedAt);
}
