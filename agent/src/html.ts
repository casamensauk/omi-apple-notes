/**
 * Apple Notes stores note bodies as a small, machine-generated subset of HTML: <div> lines,
 * <ul>/<li> bullets, and inline formatting. We edit that string surgically rather than
 * reformatting it, so a note the user has hand-crafted keeps its structure, spacing and
 * styling when Omi appends a line to it.
 *
 * Note: Apple Notes silently strips class attributes, so real tappable checklists cannot be
 * created via AppleScript/JXA. Bullets are the native scriptable list form.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Build the body for a brand-new note. The leading <h1> becomes the note's title. */
export function buildNoteHtml(title: string, items: string[], body?: string): string {
  const parts = [`<div><h1>${escapeHtml(title)}</h1></div>`, '<div><br></div>'];
  if (body && body.trim()) {
    for (const line of body.split(/\r?\n/)) {
      parts.push(line.trim() ? `<div>${escapeHtml(line.trim())}</div>` : '<div><br></div>');
    }
    if (items.length > 0) parts.push('<div><br></div>');
  }
  if (items.length > 0) {
    parts.push(`<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`);
  }
  return parts.join('');
}

interface Block {
  start: number;
  end: number;
}

/** Locate every <ul>...</ul> span in document order. */
function findLists(html: string): Block[] {
  const blocks: Block[] = [];
  const re = /<ul\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const close = html.toLowerCase().indexOf('</ul>', m.index);
    if (close === -1) break;
    blocks.push({ start: m.index, end: close + '</ul>'.length });
    re.lastIndex = close;
  }
  return blocks;
}

/**
 * Find where a named section starts. Apple Notes has no section construct, so a "section"
 * is just a line whose text matches - typically a bolded or underlined heading.
 */
function findSectionOffset(html: string, section: string): number | null {
  const wanted = section.toLowerCase().trim();
  if (!wanted) return null;
  const lineRe = /<(div|h1|h2|h3|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(html)) !== null) {
    const text = stripTags(m[2]).toLowerCase();
    if (text && (text === wanted || text.replace(/[:\s]+$/, '') === wanted)) {
      return m.index + m[0].length;
    }
  }
  return null;
}

/**
 * Insert items as bullets. With a section, they join the first list under that heading;
 * without one, they join the last list in the note, or start a new list at the end.
 */
export function appendItems(html: string, items: string[], section?: string): string {
  if (items.length === 0) return html;
  const lis = items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
  const lists = findLists(html);

  if (section) {
    const offset = findSectionOffset(html, section);
    if (offset !== null) {
      const nextList = lists.find((b) => b.start >= offset);
      if (nextList) {
        const close = html.lastIndexOf('</ul>', nextList.end);
        return html.slice(0, close) + lis + html.slice(close);
      }
      // Heading exists but has no list under it yet.
      return html.slice(0, offset) + `<ul>${lis}</ul>` + html.slice(offset);
    }
    // Unknown heading: create it, then the list, at the end of the note.
    return `${html}<div><br></div><div><b><u>${escapeHtml(section)}</u></b></div><ul>${lis}</ul>`;
  }

  if (lists.length > 0) {
    const last = lists[lists.length - 1];
    const close = html.lastIndexOf('</ul>', last.end);
    return html.slice(0, close) + lis + html.slice(close);
  }
  return `${html}<ul>${lis}</ul>`;
}

/** Every bullet in the note, in document order, as plain text. */
export function extractItems(html: string): string[] {
  const out: string[] = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[1]);
    if (text) out.push(text);
  }
  return out;
}

function matchesTarget(itemText: string, target: string): boolean {
  const a = itemText.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const b = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Delete bullets matching the given targets, tidying away any list left empty. */
export function removeItems(html: string, targets: string[]): { html: string; removed: string[] } {
  const removed: string[] = [];
  let out = html.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (whole, inner: string) => {
    const text = stripTags(inner);
    if (text && targets.some((t) => matchesTarget(text, t))) {
      removed.push(text);
      return '';
    }
    return whole;
  });
  out = out.replace(/<ul\b[^>]*>\s*<\/ul>/gi, '');
  return { html: out, removed };
}

/** A short human-readable summary of a note, for the read-side mirror. */
export function preview(html: string, maxChars = 400): string {
  const text = html
    .replace(/<\/(div|p|h1|h2|h3|li|ul)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const clean = decodeEntities(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
}
