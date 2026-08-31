import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch, score } from './match.js';

test('a spoken reference finds the differently-named note', () => {
  assert.ok(score('my camping list', 'Camping Kit') >= 0.75);
  assert.ok(score('camping list', 'Camping Kit List') >= 0.75);
});

test('an exact title scores highest', () => {
  assert.equal(score('Camping Kit', 'Camping Kit'), 1);
  assert.ok(score('Camping Kit', 'Camping Kit') > score('my camping list', 'Camping Kit'));
});

test('a short numeric title does not claim a longer unrelated query', () => {
  // Regression: "4176" is a substring of "1788164176", and substring matching once let a
  // test run append to a real, unrelated note.
  assert.equal(score('Omi E2E 1788164176', '4176'), 0);
  assert.equal(score('my shopping list', '1'), 0);
});

test('unrelated titles do not match', () => {
  assert.equal(score('camping list', 'Business Case'), 0);
});

test('bestMatch prefers the exact title over a partial one', () => {
  const notes = [{ name: 'Camping Kit' }, { name: 'Omi E2E 1788164176' }];
  const hit = bestMatch(notes, 'Omi E2E 1788164176', (n) => n.name);
  assert.equal(hit?.item.name, 'Omi E2E 1788164176');
});

test('bestMatch returns null below the threshold', () => {
  assert.equal(bestMatch([{ name: 'Business Case' }], 'camping list', (n) => n.name), null);
});

test('bestMatch breaks ties towards the first candidate, which is the most recent', () => {
  const notes = [{ name: 'Camping Kit' }, { name: 'Camping Gear' }];
  assert.equal(bestMatch(notes, 'camping', (n) => n.name)?.item.name, 'Camping Kit');
});
