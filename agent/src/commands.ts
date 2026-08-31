// Deliberately duplicated in relay/ and agent/: the two packages deploy independently
// (one to Railway, one to a Mac) and neither should need a shared build step.
/**
 * Turns spoken words into note commands.
 *
 * Omi's trigger webhooks deliver everything the wearer says, so precision matters far more
 * than recall here: a false positive writes into someone's real notes. Every pattern
 * therefore needs an explicit verb, and by default an explicit wake word too.
 */

export type CommandTool = 'create_note' | 'add_to_note' | 'remove_from_note';

export interface ParsedCommand {
  tool: CommandTool;
  title: string;
  items: string[];
  /** The utterance this came from, used to suppress duplicate triggers. */
  source: string;
}

const FILLER = /\b(?:please|just|erm|um|uh|like)\b/g;

function tidy(text: string): string {
  return text
    .toLowerCase()
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    // Removing filler can strand punctuation ("omi, um, add" -> "omi, , add"), which would
    // stop a pattern anchoring at the start of the utterance.
    .replace(/,\s*(?=,)/g, '')
    .replace(/^[\s,.:;!?-]+/, '')
    .replace(/[\s.,!?;:]+$/, '')
    .trim();
}

/** "tent pegs, a gas canister and some matches" -> ["Tent pegs", "Gas canister", "Matches"] */
export function splitItems(text: string): string[] {
  return text
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/)
    .map((part) =>
      part
        .replace(/^(?:a|an|some|the)\s+/i, '')
        .replace(/[.,!?;]+$/g, '')
        .trim(),
    )
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .slice(0, 50);
}

function titleCase(text: string): string {
  return text
    .replace(/^(?:my|the|a|an)\s+/i, '')
    .replace(/[.,!?;]+$/g, '')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Strip a leading wake word. Returns null when one is required but absent.
 *
 * The wake word may be given as alternatives ("omi|omit|ome") because speech-to-text
 * mangles it constantly — real messages have arrived as "Omit Add Ten Pegs to my camping
 * list" and "Ome Add A Generator". A leading one of those is always a mis-heard "Omi".
 */
function afterWakeWord(text: string, wakeWord: string, required: boolean): string | null {
  const wake = wakeWord.toLowerCase().trim();
  if (!wake) return text;
  const alternatives = wake.split('|').map((w) => w.trim()).filter(Boolean).join('|');
  if (!alternatives) return text;

  // Anchored at the start: that is where an address to Omi belongs, and stripping a
  // mid-sentence "omi" would silently eat half the command.
  const leading = new RegExp(`^(?:hey\\s+|ok(?:ay)?\\s+)?(?:${alternatives})\\b[,.:]?\\s*`, 'i');
  const atStart = leading.exec(text);
  if (atStart) return text.slice(atStart[0].length).trim();

  if (!required) return text;

  // A required wake word may legitimately appear mid-utterance in a live transcript,
  // where the wearer is mid-conversation when they address Omi.
  const anywhere = new RegExp(`\\b(?:hey\\s+|ok(?:ay)?\\s+)?(?:${alternatives})\\b[,.:]?\\s*`, 'i');
  const found = anywhere.exec(text);
  if (!found) return null;
  return text.slice(found.index + found[0].length).trim();
}

interface Pattern {
  tool: CommandTool;
  re: RegExp;
  build: (m: RegExpMatchArray) => { title: string; items: string[] } | null;
}

// Order matters: the more specific phrasings must be tried before the general ones.
const PATTERNS: Pattern[] = [
  {
    tool: 'remove_from_note',
    re: /^(?:remove|delete|take|cross|tick)\s+(?:off\s+)?(.+?)\s+(?:from|off|out\s+of)\s+(?:of\s+)?(?:my|the)?\s*(.+)$/,
    build: (m) => ({ title: m[2], items: splitItems(m[1]) }),
  },
  {
    tool: 'add_to_note',
    re: /^(?:add|put|append|stick)\s+(.+?)\s+(?:to|on|onto|in|into)\s+(?:my|the)?\s*(.+)$/,
    build: (m) => ({ title: m[2], items: splitItems(m[1]) }),
  },
  {
    // "create a new list called wiston" names the note Wiston, not "New List".
    tool: 'create_note',
    re: /^(?:start|create|make|begin|new)\s+(?:a|an|my|the)?\s*(?:new\s+)?(?:list|note)\s+(?:called|named|titled)\s+(.+?)(?:\s+(?:with|containing|including)\s+(.+))?$/,
    build: (m) => ({ title: m[1], items: m[2] ? splitItems(m[2]) : [] }),
  },
  {
    tool: 'create_note',
    re: /^(?:start|create|make|begin|new)\s+(?:a|an|my|the)?\s*(?:new\s+)?(.+?)\s+(?:with|containing|including)\s+(.+)$/,
    build: (m) => ({ title: m[1], items: splitItems(m[2]) }),
  },
  {
    tool: 'create_note',
    // Title ends at "list"/"note": "create the camping list we talked about in Notion"
    // should make "Camping List", not a note named after the whole sentence.
    re: /^(?:start|create|make|begin|new)\s+(?:a|an|my|the)?\s*(?:new\s+)?(.+?\b(?:list|note)\b)/,
    build: (m) => ({ title: m[1], items: [] }),
  },
];

/**
 * Parse one utterance. Returns null unless it is unambiguously a note command, which is
 * the common case — most of what the wearer says is not addressed to Omi at all.
 */
export function parseSpokenCommand(
  utterance: string,
  options: { wakeWord: string; requireWakeWord: boolean },
): ParsedCommand | null {
  if (!utterance || utterance.length > 2000) return null;
  const source = utterance.trim();

  const afterWake = afterWakeWord(tidy(source), options.wakeWord, options.requireWakeWord);
  if (afterWake === null) return null;
  const text = tidy(afterWake);
  if (!text) return null;

  for (const pattern of PATTERNS) {
    const m = text.match(pattern.re);
    if (!m) continue;
    const built = pattern.build(m);
    if (!built) continue;

    const title = titleCase(built.title);
    // A bare verb with no object is almost always mis-heard speech, not a command.
    if (!title || title.length < 2) continue;
    if (pattern.tool !== 'create_note' && built.items.length === 0) continue;

    return { tool: pattern.tool, title, items: built.items, source };
  }
  return null;
}

/** A stable key for one utterance, so the same command is not applied twice. */
export function commandKey(uid: string, command: ParsedCommand): string {
  const items = command.items.map((i) => i.toLowerCase()).sort().join('|');
  return `${uid}:${command.tool}:${command.title.toLowerCase()}:${items}`;
}
