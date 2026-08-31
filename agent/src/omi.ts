import { config } from './config.js';

/**
 * Minimal client for Omi's MCP server.
 *
 * Chat history is the one thing Omi exposes nowhere else — there is no REST endpoint and
 * no CLI command for it — so reading it means speaking MCP. The server accepts plain
 * stateless JSON-RPC POSTs (no initialize handshake, no session id) and replies with an
 * SSE-framed body, which is why the response needs unwrapping rather than a plain
 * res.json().
 */
export interface ChatMessage {
  id: string;
  text: string;
  sender: 'human' | 'ai';
  created_at: string;
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { message?: string };
}

/** Pull the JSON-RPC payload out of an `event: message\ndata: {...}` body. */
function parseSseFrames(body: string): JsonRpcResponse | null {
  const payloads = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.result || parsed.error) return parsed;
    } catch {
      // Keep-alive and partial frames are expected; skip them.
    }
  }
  return null;
}

async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!config.omiMcpKey) throw new Error('OMI_MCP_KEY is not set');

  const res = await fetch(config.omiMcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.omiMcpKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Omi MCP ${name} -> HTTP ${res.status}`);
  const body = await res.text();
  const rpc = parseSseFrames(body);
  if (!rpc) throw new Error(`Omi MCP ${name}: no JSON-RPC frame in response`);
  if (rpc.error) throw new Error(`Omi MCP ${name}: ${rpc.error.message ?? 'error'}`);

  const text = rpc.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`Omi MCP ${name}: no text content`);
  return JSON.parse(text) as T;
}

export async function getChatMessages(limit = 20): Promise<ChatMessage[]> {
  const data = await callTool<{ messages?: ChatMessage[] }>('get_chat_messages', { limit });
  return Array.isArray(data.messages) ? data.messages : [];
}
