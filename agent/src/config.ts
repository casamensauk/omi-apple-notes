import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Load KEY=VALUE pairs from the first config file we find. Kept dependency-free so the
 * agent can run under launchd with nothing but a system Node.
 */
function loadEnvFile(): void {
  const candidates = [
    process.env.OMI_NOTES_ENV,
    join(homedir(), '.config', 'omi-notes', 'config.env'),
    join(process.cwd(), '.env'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return;
  }
}

loadEnvFile();

export const config = {
  /**
   * The cloud relay is optional. It exists for Omi builds that can call chat tools or
   * trigger webhooks; a push-to-talk user needs none of it, since chat polling reaches
   * Omi directly. Leave RELAY_URL unset and the agent simply does not use it.
   */
  relayUrl: (process.env.RELAY_URL ?? '').replace(/\/+$/, ''),
  agentToken: process.env.AGENT_TOKEN ?? '',
  /** Optional: only needed to seed the mirror before the first tool call pins a uid. */
  uid: process.env.OMI_UID ?? '',
  /** Bodies are fetched for this many most-recently-modified notes to answer read tools. */
  mirrorLimit: Number(process.env.MIRROR_LIMIT ?? 60),
  mirrorIntervalMs: Number(process.env.MIRROR_INTERVAL_MS ?? 5 * 60 * 1000),
  longPollSeconds: Number(process.env.LONG_POLL_SECONDS ?? 25),
  /** Omi's MCP endpoint — the only place chat history is exposed. */
  omiMcpUrl: process.env.OMI_MCP_URL ?? 'https://api.omi.me/v1/mcp/sse',
  omiMcpKey: process.env.OMI_MCP_KEY ?? '',
  /**
   * How often to check Omi chat for new note commands. Defaults to 60s: Omi's managed
   * cloud appears to meter account usage, and its LLM began returning 402s about four
   * minutes after a 15s poll went live — ~240 calls/hour reads as abuse to a metering
   * system. A minute of latency on a shopping-list item costs nothing.
   */
  chatPollMs: Number(process.env.CHAT_POLL_MS ?? 60_000),
  /**
   * Everything in the chat is already addressed to Omi, so no wake word is demanded —
   * but speech-to-text prefixes mangled versions of it ("Omit", "Ome"), which are
   * stripped when they lead the message.
   */
  chatWakeWord: process.env.CHAT_WAKE_WORD ?? 'omi|omit|ome|omni',
  chatRequireWakeWord: (process.env.CHAT_REQUIRE_WAKE_WORD ?? 'false').toLowerCase() === 'true',
  /** Folder new notes land in. Empty means the default account's default folder. */
  defaultFolder: process.env.DEFAULT_FOLDER ?? '',
  /**
   * Folders never listed or matched against. Apple Notes exposes its trash as an ordinary
   * folder, and its name is localised, so this is configurable for non-English systems.
   */
  excludeFolders: (process.env.EXCLUDE_FOLDERS ?? 'Recently Deleted')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
