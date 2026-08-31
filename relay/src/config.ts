function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Public https origin Railway serves this on, e.g. https://omi-notes.up.railway.app */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
  /** Shared secret the macOS agent presents to drain the queue. */
  agentToken: required('AGENT_TOKEN'),
  /** Omi app id; tool calls carrying a different app_id are rejected. Empty disables the check. */
  omiAppId: process.env.OMI_APP_ID ?? '',
  /**
   * Comma-separated Omi uids allowed to use this relay. Empty means "trust on first
   * use": the first uid seen is pinned and everything else is refused thereafter.
   */
  allowedUids: (process.env.ALLOWED_UIDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** How long a write tool waits for the Mac to confirm before replying "queued". */
  writeWaitMs: Number(process.env.WRITE_WAIT_MS ?? 9000),
  /** Mirror older than this is treated as stale, so read tools admit they may be behind. */
  mirrorStaleMs: Number(process.env.MIRROR_STALE_MS ?? 10 * 60 * 1000),
  dbPath: process.env.DB_PATH ?? '/data/omi-notes.db',
};
