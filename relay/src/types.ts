/** A note command produced by an Omi chat tool call, queued for the macOS agent. */
export interface Command {
  id: string;
  uid: string;
  tool: ToolName;
  payload: Record<string, unknown>;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ToolName =
  | 'create_note'
  | 'add_to_note'
  | 'remove_from_note'
  | 'read_note'
  | 'list_notes';

/** One note as mirrored up from the Mac, so read tools can answer instantly. */
export interface MirrorNote {
  id: string;
  name: string;
  folder: string;
  updatedAt: string;
  items: string[];
  preview: string;
}

export interface Mirror {
  notes: MirrorNote[];
  syncedAt: number;
}

/** Every tool endpoint answers with exactly one of these, per the Omi contract. */
export type ToolReply = { result: string } | { error: string };
