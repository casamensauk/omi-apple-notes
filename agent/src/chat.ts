import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { getChatMessages, type ChatMessage } from './omi.js';
import { parseSpokenCommand } from './commands.js';
import { applyCommand } from './apply.js';

const STATE_PATH = process.env.OMI_NOTES_STATE ?? join(homedir(), '.config', 'omi-notes', 'state.json');

interface State {
  /** Only messages newer than this are considered. */
  lastSeenIso: string;
  /** Guards against reprocessing when timestamps tie or the clock stutters. */
  seenIds: string[];
}

function loadState(): State | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<State>;
    if (typeof parsed.lastSeenIso !== 'string') return null;
    return { lastSeenIso: parsed.lastSeenIso, seenIds: parsed.seenIds ?? [] };
  } catch {
    return null;
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ ...state, seenIds: state.seenIds.slice(-200) }, null, 2), {
    mode: 0o600,
  });
}

/** Omi timestamps look like "2026-08-31 08:57:23.782241+00:00" — not quite ISO 8601. */
export function parseOmiDate(value: string): number {
  const normalised = value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Check Omi chat for new note commands and apply them.
 *
 * Omi's own assistant answers these messages with "…started and is working in the
 * background" and then does nothing, so this is what actually writes the note.
 */
export async function pollChatOnce(log: (message: string) => void): Promise<number> {
  let state = loadState();
  if (!state) {
    // First run: start from now. Replaying the whole history would write every list
    // command the user has ever typed.
    state = { lastSeenIso: new Date().toISOString(), seenIds: [] };
    saveState(state);
    log('watching Omi chat for new commands from now');
    return 0;
  }

  const messages = await getChatMessages(25);
  const since = Date.parse(state.lastSeenIso);
  const seen = new Set(state.seenIds);

  const fresh = messages
    .filter((m): m is ChatMessage => !!m && m.sender === 'human' && typeof m.text === 'string')
    .filter((m) => parseOmiDate(m.created_at) > since && !seen.has(m.id))
    .sort((a, b) => parseOmiDate(a.created_at) - parseOmiDate(b.created_at));

  let applied = 0;
  for (const message of fresh) {
    seen.add(message.id);
    const command = parseSpokenCommand(message.text, {
      wakeWord: config.chatWakeWord,
      requireWakeWord: config.chatRequireWakeWord,
    });
    if (!command) continue;

    log(`chat: "${message.text}" -> ${command.tool} "${command.title}"`);
    try {
      const { message: result } = await applyCommand({
        id: message.id,
        tool: command.tool,
        payload: { title: command.title, items: command.items },
      });
      log(`chat: ${result}`);
      applied++;
    } catch (err) {
      log(`chat: failed - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Advance past everything examined, so an unparsed message is not re-read forever.
  const newest = messages.reduce((max, m) => Math.max(max, parseOmiDate(m.created_at)), since);
  saveState({ lastSeenIso: new Date(newest).toISOString(), seenIds: [...seen] });
  return applied;
}
