import { config } from './config.js';
import { bestMatch } from './match.js';
import { appendItems, buildNoteHtml, extractItems, preview, removeItems } from './html.js';
import { notes, type NoteRef } from './notes.js';

export interface Command {
  id: string;
  tool: string;
  payload: Record<string, unknown>;
}

export interface MirrorNote {
  id: string;
  name: string;
  folder: string;
  updatedAt: string;
  items: string[];
  preview: string;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const asItems = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

function countPhrase(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/** Speech gives partial titles, so search live note names rather than requiring an exact one. */
async function findNote(title: string, threshold: number): Promise<NoteRef | null> {
  const all = await notes.list();
  const hit = bestMatch(all, title, (n) => n.name, threshold);
  return hit?.item ?? null;
}

export interface ApplyResult {
  /** The sentence Omi speaks back to the user. */
  message: string;
  /** The note this command touched, so its mirror entry can be refreshed on its own. */
  noteId?: string;
}

/**
 * Run one queued command against Apple Notes and return the sentence Omi should speak back.
 * Throws on genuine failure; the caller reports that to the relay as an error.
 */
export async function applyCommand(cmd: Command): Promise<ApplyResult> {
  const { tool, payload } = cmd;

  switch (tool) {
    case 'create_note': {
      const title = asString(payload.title);
      const items = asItems(payload.items);
      const body = asString(payload.body);
      const folder = asString(payload.folder) || config.defaultFolder;

      // "Start a camping list" when Camping Kit already exists should extend it, not
      // silently create a near-duplicate the user will never find again.
      const existing = await findNote(title, 0.75);
      if (existing && items.length > 0) {
        const note = await notes.get(existing.id);
        await notes.setBody(existing.id, appendItems(note.body, items));
        return {
          noteId: existing.id,
          message: `You already had a note called "${existing.name}", so I added ${countPhrase(
            items.length,
            'item',
          )} to it instead of making a new one.`,
        };
      }

      const created = await notes.create(buildNoteHtml(title, items, body), folder);
      if (items.length > 0) {
        return {
          noteId: created.id,
          message: `Created "${created.name || title}" in Apple Notes with ${countPhrase(
            items.length,
            'item',
          )}.`,
        };
      }
      return { noteId: created.id, message: `Created "${created.name || title}" in Apple Notes.` };
    }

    case 'add_to_note': {
      const title = asString(payload.title);
      const items = asItems(payload.items);
      const section = asString(payload.section);
      if (items.length === 0) throw new Error('No items to add.');

      const target = await findNote(title, 0.4);
      if (!target) {
        const made = await notes.create(buildNoteHtml(title, items), config.defaultFolder);
        return {
          noteId: made.id,
          message: `I couldn't find a note called "${title}", so I created one with ${countPhrase(
            items.length,
            'item',
          )}.`,
        };
      }

      const note = await notes.get(target.id);
      await notes.setBody(target.id, appendItems(note.body, items, section || undefined));
      const where = section ? ` under ${section}` : '';
      return {
        noteId: target.id,
        message: `Added ${countPhrase(items.length, 'item')} to "${target.name}"${where}: ${items.join(
          ', ',
        )}.`,
      };
    }

    case 'remove_from_note': {
      const title = asString(payload.title);
      const items = asItems(payload.items);
      const target = await findNote(title, 0.4);
      if (!target) throw new Error(`I couldn't find a note called "${title}".`);

      const note = await notes.get(target.id);
      const { html, removed } = removeItems(note.body, items);
      if (removed.length === 0) {
        return {
          message: `Nothing on "${target.name}" matched ${items.join(', ')}, so I left it alone.`,
        };
      }
      await notes.setBody(target.id, html);
      return {
        noteId: target.id,
        message: `Removed ${removed.join(', ')} from "${target.name}".`,
      };
    }

    case 'read_note': {
      const title = asString(payload.title);
      const target = await findNote(title, 0.4);
      if (!target) throw new Error(`I couldn't find a note called "${title}".`);
      const note = await notes.get(target.id);
      const items = extractItems(note.body);
      if (items.length > 0) return { message: `${target.name}:\n- ${items.join('\n- ')}` };
      return { message: `${target.name}:\n${preview(note.body)}` };
    }

    case 'list_notes': {
      const all = await notes.list();
      const query = asString(payload.query);
      const names = (query ? all.filter((n) => bestMatch([n], query, (x) => x.name, 0.3)) : all)
        .slice(0, 40)
        .map((n) => n.name);
      return {
        message: names.length > 0 ? `Your notes:\n- ${names.join('\n- ')}` : 'No notes matched.',
      };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/**
 * Snapshot recent notes so the relay can answer "what's on my camping list?" instantly,
 * without waiting for a round trip to a Mac that might be asleep.
 */
export async function buildMirror(limit = config.mirrorLimit): Promise<MirrorNote[]> {
  const all = await notes.list();
  const recent = all.slice(0, limit);
  const bodies = await notes.getMany(recent.map((n) => n.id));
  const byId = new Map(bodies.map((b) => [b.id, b]));

  return all.slice(0, 300).map((ref) => {
    const body = byId.get(ref.id);
    return {
      id: ref.id,
      name: ref.name,
      folder: ref.folder,
      updatedAt: ref.updatedAt,
      items: body ? extractItems(body.body) : [],
      preview: body ? preview(body.body, 300) : '',
    };
  });
}

/** Build the mirror entry for a single note, so one edit does not force a full resync. */
export async function mirrorNoteFor(id: string): Promise<MirrorNote | null> {
  const all = await notes.list();
  const ref = all.find((n) => n.id === id);
  if (!ref) return null;
  const body = await notes.get(id).catch(() => null);
  return {
    id: ref.id,
    name: ref.name,
    folder: ref.folder,
    updatedAt: ref.updatedAt,
    items: body ? extractItems(body.body) : [],
    preview: body ? preview(body.body, 300) : '',
  };
}
