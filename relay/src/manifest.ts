import { config } from './config.js';

const str = (description: string) => ({ type: 'string', description });
const strArray = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

/**
 * Descriptions are prompts: Omi's assistant picks a tool from these alone, so each one
 * says plainly when to reach for it and how it differs from its neighbours.
 */
export function buildManifest() {
  return {
    name: 'Apple Notes Sync',
    description:
      "Create and update notes and lists in the user's Apple Notes by voice. " +
      'Use these tools whenever the user asks to write something down, start a list, ' +
      'add items to a list, or check what is on one of their notes.',
    tools: [
      {
        name: 'create_note',
        description:
          'Create a NEW note or list in Apple Notes. Use when the user asks to start, ' +
          'make, or begin a new note or list (e.g. "start a camping list", "make a note ' +
          'about the meeting"). If a note with this title already exists, use add_to_note ' +
          'instead so the existing note is not duplicated.',
        endpoint: '/tools/create_note',
        method: 'POST',
        parameters: {
          type: 'object',
          properties: {
            title: str('Title of the note, e.g. "Camping List". Keep it short and human.'),
            items: strArray(
              'Bullet points to put in the note. Use this for lists. One short item per entry, ' +
                'without leading dashes or numbering.',
            ),
            body: str(
              'Free-form prose for the note, used instead of items when the user is dictating ' +
                'a paragraph rather than a list.',
            ),
            folder: str('Optional Apple Notes folder name. Omit to use the default folder.'),
          },
          required: ['title'],
        },
        auth_required: false,
        status_message: 'Writing to Apple Notes...',
      },
      {
        name: 'add_to_note',
        description:
          'Add one or more items to an EXISTING note or list in Apple Notes. Use when the ' +
          'user says to add, append, or put something on a list they already have ' +
          '(e.g. "add tent pegs to my camping list"). The title is matched loosely, so ' +
          '"camping list" will find a note called "Camping Kit".',
        endpoint: '/tools/add_to_note',
        method: 'POST',
        parameters: {
          type: 'object',
          properties: {
            title: str('Title of the existing note to add to, as the user referred to it.'),
            items: strArray('The items to add. One short item per entry, no leading dashes.'),
            section: str(
              'Optional heading within the note to add under, e.g. "Trailer". Omit to add ' +
                'to the end of the note.',
            ),
          },
          required: ['title', 'items'],
        },
        auth_required: false,
        status_message: 'Adding to your note...',
      },
      {
        name: 'remove_from_note',
        description:
          'Remove or tick off items from an existing Apple Notes list. Use when the user ' +
          'says they have packed, bought, done, or no longer need something on a list ' +
          '(e.g. "take pegs off the camping list").',
        endpoint: '/tools/remove_from_note',
        method: 'POST',
        parameters: {
          type: 'object',
          properties: {
            title: str('Title of the note to remove items from.'),
            items: strArray('The items to remove. Matched loosely against existing lines.'),
          },
          required: ['title', 'items'],
        },
        auth_required: false,
        status_message: 'Updating your note...',
      },
      {
        name: 'read_note',
        description:
          'Read back the contents of one of the user\'s Apple Notes. Use when the user asks ' +
          'what is on a list or note (e.g. "what\'s on my camping list?").',
        endpoint: '/tools/read_note',
        method: 'POST',
        parameters: {
          type: 'object',
          properties: { title: str('Title of the note to read, as the user referred to it.') },
          required: ['title'],
        },
        auth_required: false,
        status_message: 'Reading your note...',
      },
      {
        name: 'list_notes',
        description:
          'List the titles of the user\'s Apple Notes. Use when the user asks what notes or ' +
          'lists they have, or when you need to find the right note title before acting.',
        endpoint: '/tools/list_notes',
        method: 'POST',
        parameters: {
          type: 'object',
          properties: {
            query: str('Optional word to filter titles by. Omit to list the most recent notes.'),
          },
          required: [],
        },
        auth_required: false,
        status_message: 'Checking your notes...',
      },
    ].map((t) => ({
      ...t,
      // Omi needs absolute URLs when the manifest is hosted off-origin; keep both forms valid.
      endpoint: config.publicBaseUrl ? `${config.publicBaseUrl}${t.endpoint}` : t.endpoint,
    })),
  };
}
