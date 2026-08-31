import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandKey, parseSpokenCommand, splitItems } from './commands.js';

const opts = { wakeWord: 'omi', requireWakeWord: true };
const parse = (s: string) => parseSpokenCommand(s, opts);

test('adds spoken items to an existing list', () => {
  const c = parse('Omi, add tent pegs to my camping list.');
  assert.equal(c?.tool, 'add_to_note');
  assert.equal(c?.title, 'Camping List');
  assert.deepEqual(c?.items, ['Tent pegs']);
});

test('splits multiple items on commas and "and"', () => {
  const c = parse('Omi, add tent pegs, a gas canister and some matches to my camping list');
  assert.deepEqual(c?.items, ['Tent pegs', 'Gas canister', 'Matches']);
});

test('creates a list with initial items', () => {
  const c = parse('Hey Omi, start a camping list with tent, stove and pegs');
  assert.equal(c?.tool, 'create_note');
  assert.equal(c?.title, 'Camping List');
  assert.deepEqual(c?.items, ['Tent', 'Stove', 'Pegs']);
});

test('creates an empty list', () => {
  const c = parse('Okay Omi, make a new packing list');
  assert.equal(c?.tool, 'create_note');
  assert.equal(c?.title, 'Packing List');
  assert.deepEqual(c?.items, []);
});

test('removes items from a list', () => {
  const c = parse('Omi, take the head torch off my camping list');
  assert.equal(c?.tool, 'remove_from_note');
  assert.equal(c?.title, 'Camping List');
  assert.deepEqual(c?.items, ['Head torch']);
});

test('ignores ordinary conversation that happens to contain a verb', () => {
  // This is the whole risk of a transcript trigger: it hears everything.
  assert.equal(parse('we should add some pegs to the order before Friday'), null);
  assert.equal(parse('I put the shopping in the car'), null);
  assert.equal(parse('can you take the bins out'), null);
});

test('ignores speech addressed to Omi that is not a note command', () => {
  assert.equal(parse("Omi, what's the weather like today?"), null);
  assert.equal(parse('Omi, remind me about the meeting'), null);
});

test('ignores a bare verb with no object', () => {
  assert.equal(parse('Omi, add'), null);
  assert.equal(parse('Omi, add pegs to'), null);
});

test('ignores very long utterances', () => {
  assert.equal(parse(`Omi, add x to my list ${'y'.repeat(2100)}`), null);
});

test('the wake word can be made optional', () => {
  const c = parseSpokenCommand('add pegs to my camping list', {
    wakeWord: 'omi',
    requireWakeWord: false,
  });
  assert.equal(c?.tool, 'add_to_note');
});

test('filler words do not defeat matching', () => {
  const c = parse('Omi, um, please just add a head torch to my camping list');
  assert.deepEqual(c?.items, ['Head torch']);
});

test('the same utterance produces a stable dedup key regardless of item order', () => {
  const a = parse('Omi, add pegs and rope to my camping list');
  const b = parse('Omi, add rope and pegs to my camping list');
  assert.equal(commandKey('u1', a!), commandKey('u1', b!));
  assert.notEqual(commandKey('u1', a!), commandKey('u2', a!));
});

test('splitItems strips articles and capitalises', () => {
  assert.deepEqual(splitItems('a tent, the stove and some pegs'), ['Tent', 'Stove', 'Pegs']);
});

// Chat messages are all addressed to Omi already, so no wake word is demanded there —
// but speech-to-text still prefixes mangled versions of it.
const chat = { wakeWord: 'omi|omit|ome|omni', requireWakeWord: false };
const parseChat = (s: string) => parseSpokenCommand(s, chat);

test('a mis-heard wake word does not break the command', () => {
  // These are verbatim from real Omi chat history.
  const a = parseChat('Omit Add Ten Pegs to my camping list');
  assert.equal(a?.tool, 'add_to_note');
  assert.equal(a?.title, 'Camping List');
  assert.deepEqual(a?.items, ['Ten pegs']);

  const b = parseChat('Ome Add A Generator to my camping list');
  assert.equal(b?.tool, 'add_to_note');
  assert.deepEqual(b?.items, ['Generator']);
});

test('a chat command with no wake word at all still works', () => {
  const c = parseChat('Add a hey toss to my camping list.');
  assert.equal(c?.tool, 'add_to_note');
  assert.equal(c?.title, 'Camping List');
  assert.deepEqual(c?.items, ['Hey toss']);
});

test('chat chatter is still ignored without a note verb', () => {
  assert.equal(parseChat("I can't see the list in Notion."), null);
  assert.equal(parseChat('I know. I want you to investigate why we can\'t do that to Notion.'), null);
  assert.equal(parseChat('Update Camping List started and is working in the background.'), null);
});

test('a mid-sentence wake word is not stripped when it is not leading', () => {
  // Stripping "omi" mid-sentence would eat the verb and mangle the command.
  const c = parseChat('add the omi charger to my packing list');
  assert.deepEqual(c?.items, ['Omi charger']);
});

test('a created list title stops at the word "list"', () => {
  const c = parseChat('Create the camping list we talked about in Notion.');
  assert.equal(c?.tool, 'create_note');
  assert.equal(c?.title, 'Camping List');
});

test('a list named with "called" takes that name', () => {
  // Regression: this produced a note titled "New List", dropping the actual name.
  const a = parseChat('Create a new list called wiston.');
  assert.equal(a?.tool, 'create_note');
  assert.equal(a?.title, 'Wiston');
  assert.deepEqual(a?.items, []);

  const b = parseChat('Omi, make a note called Packing with passport and charger');
  assert.equal(b?.title, 'Packing');
  assert.deepEqual(b?.items, ['Passport', 'Charger']);
});
