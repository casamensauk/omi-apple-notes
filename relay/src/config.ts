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
  /** Spoken prefix that marks an utterance as addressed to Omi rather than to a person. */
  wakeWord: process.env.WAKE_WORD ?? 'omi',
  /**
   * Requiring the wake word is the main defence against writing notes from ordinary
   * conversation, since trigger webhooks deliver everything the wearer says.
   */
  requireWakeWord: (process.env.REQUIRE_WAKE_WORD ?? 'true').toLowerCase() !== 'false',
  /**
   * Log webhook payload shape (and, when on, a truncated transcript) to diagnose what Omi
   * actually sends. Off by default: this is the wearer's private speech.
   */
  debugWebhook: (process.env.DEBUG_WEBHOOK ?? 'false').toLowerCase() === 'true',
  /** How long a handled utterance is remembered, to suppress duplicate triggers. */
  dedupeTtlMs: Number(process.env.DEDUPE_TTL_MS ?? 60 * 60 * 1000),
};
