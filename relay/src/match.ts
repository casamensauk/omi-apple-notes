// Deliberately duplicated in relay/ and agent/: the two packages deploy independently
// (one to Railway, one to a Mac) and neither should need a shared build step.
/** Normalise a title for comparison: lowercase, strip punctuation and filler words. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(my|the|a|an|note|notes|list|lists)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalise(s).split(' ').filter(Boolean));
}

/**
 * Score how well a candidate title answers a spoken reference to it. Speech gives us
 * "my camping list" for a note actually called "Camping Kit", so token overlap beats
 * exact equality here.
 */
export function score(query: string, candidate: string): number {
  const q = normalise(query);
  const c = normalise(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.9;

  const qt = tokens(query);
  const ct = tokens(candidate);
  if (qt.size === 0 || ct.size === 0) return 0;
  let shared = 0;
  for (const t of qt) if (ct.has(t)) shared++;
  // Jaccard, nudged up when every spoken word is present in the candidate.
  const union = new Set([...qt, ...ct]).size;
  const jaccard = shared / union;
  return shared === qt.size ? Math.max(jaccard, 0.75) : jaccard;
}

export function bestMatch<T>(
  items: T[],
  query: string,
  titleOf: (item: T) => string,
  threshold = 0.4,
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const s = score(query, titleOf(item));
    if (s >= threshold && (!best || s > best.score)) best = { item, score: s };
  }
  return best;
}
