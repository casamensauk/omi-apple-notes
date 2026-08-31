export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Public https origin Railway serves this on, e.g. https://omi-notes.up.railway.app */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
  /**
   * Shared secret the macOS agent presents to drain the queue. Optional at boot on
   * purpose: a relay that crash-loops on missing config is harder to diagnose than one
   * that starts, serves /health, and refuses the agent endpoints with a clear reason.
   */
  agentToken: process.env.AGENT_TOKEN ?? '',
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
  /**
   * How long a write tool waits for the Mac to confirm before replying "queued".
   * Omi requires tool endpoints to answer within 5 seconds, so this must stay under
   * that budget or a successful write reads as a timeout to the user.
   */
  writeWaitMs: Number(process.env.WRITE_WAIT_MS ?? 4000),
  /** Mirror older than this is treated as stale, so read tools admit they may be behind. */
  mirrorStaleMs: Number(process.env.MIRROR_STALE_MS ?? 10 * 60 * 1000),
  dbPath: process.env.DB_PATH ?? '/data/omi-notes.db',
};
