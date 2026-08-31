import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./jxa/notes.js', import.meta.url));

export interface NoteRef {
  id: string;
  name: string;
  folder: string;
  account: string;
  updatedAt: string;
}

export interface NoteBody {
  id: string;
  name: string;
  body: string;
}

interface JxaResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Run one op against Apple Notes. The payload goes via a temp file because note bodies
 * contain quotes and newlines that have no business on a command line.
 */
async function jxa<T>(payload: Record<string, unknown>): Promise<T> {
  const file = join(tmpdir(), `omi-notes-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(payload), 'utf8');
  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', SCRIPT, file], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
    });
    const parsed = JSON.parse(stdout.trim()) as JxaResult<T>;
    if (!parsed.ok) throw new Error(parsed.error ?? 'Apple Notes call failed');
    return parsed.data as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not authori[sz]ed|not allowed|-1743/i.test(message)) {
      throw new Error(
        'macOS has not granted this agent permission to control Apple Notes. ' +
          'Approve it under System Settings > Privacy & Security > Automation.',
      );
    }
    throw new Error(`Apple Notes: ${message}`);
  } finally {
    await unlink(file).catch(() => {});
  }
}

export const notes = {
  list: () => jxa<NoteRef[]>({ op: 'list', excludeFolders: config.excludeFolders }),
  get: (id: string) => jxa<NoteBody>({ op: 'get', id }),
  getMany: (ids: string[]) => jxa<NoteBody[]>({ op: 'getMany', ids }),
  create: (html: string, folder?: string) =>
    jxa<{ id: string; name: string }>({ op: 'create', html, folder: folder || '' }),
  setBody: (id: string, html: string) =>
    jxa<{ id: string; name: string }>({ op: 'setBody', id, html }),
};
