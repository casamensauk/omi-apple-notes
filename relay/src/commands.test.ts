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
