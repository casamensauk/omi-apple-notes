import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendItems,
  buildNoteHtml,
  escapeHtml,
  extractItems,
  preview,
  removeItems,
} from './html.js';

// Verbatim body of a real Apple Notes note, so the tests exercise the shape Notes emits
// (two sibling <ul> blocks separated by spacer divs, a bold+underline pseudo-heading).
const CAMPING = `<div><h1>Camping Kit</h1></div>
<div><br></div>
<div><b><u>Trailer</u></b><br></div>
<div><br></div>
<ul>
<li>Bunk beds 2</li>
<li>Awning poles</li>
<li>Pegs</li>
</ul>
<div><br></div>
<ul>
<li>Guy line</li>
<li>Fan</li>
</ul>
<div><br></div>`;

test('append with no section goes to the last list', () => {
  const out = appendItems(CAMPING, ['Head torch']);
  const items = extractItems(out);
  assert.deepEqual(items, ['Bunk beds 2', 'Awning poles', 'Pegs', 'Guy line', 'Fan', 'Head torch']);
});

test('append to a named section goes into that section list', () => {
  const out = appendItems(CAMPING, ['Spare wheel'], 'Trailer');
  const items = extractItems(out);
  assert.deepEqual(items, [
    'Bunk beds 2',
    'Awning poles',
    'Pegs',
    'Spare wheel',
    'Guy line',
    'Fan',
  ]);
});

test('append to an unknown section creates that heading at the end', () => {
  const out = appendItems(CAMPING, ['Matches'], 'Kitchen');
  assert.ok(out.includes('<b><u>Kitchen</u></b>'));
  assert.equal(extractItems(out).at(-1), 'Matches');
});

test('append to a note with no list starts one', () => {
  const out = appendItems('<div><h1>Ideas</h1></div><div>some prose</div>', ['first']);
  assert.deepEqual(extractItems(out), ['first']);
});

test('existing structure is preserved byte-for-byte around the insertion', () => {
  const out = appendItems(CAMPING, ['Head torch']);
  assert.ok(out.includes('<div><b><u>Trailer</u></b><br></div>'));
  assert.ok(out.startsWith('<div><h1>Camping Kit</h1></div>'));
  assert.equal((out.match(/<ul>/g) ?? []).length, 2, 'no new list should appear');
});

test('new note puts the title in an h1 so Notes adopts it as the name', () => {
  const html = buildNoteHtml('Camping List', ['Tent', 'Stove']);
  assert.ok(html.startsWith('<div><h1>Camping List</h1></div>'));
  assert.deepEqual(extractItems(html), ['Tent', 'Stove']);
});

test('new note supports dictated prose instead of a list', () => {
  const html = buildNoteHtml('Meeting', [], 'Line one\nLine two');
  assert.ok(html.includes('<div>Line one</div>'));
  assert.ok(html.includes('<div>Line two</div>'));
});

test('user text is escaped, not injected as markup', () => {
  const html = buildNoteHtml('Plans & <b>stuff</b>', ['5 < 6 & "quoted"']);
  assert.ok(html.includes('Plans &amp; &lt;b&gt;stuff&lt;/b&gt;'));
  assert.ok(!html.includes('<b>stuff</b>'));
  assert.deepEqual(extractItems(html), ['5 < 6 & "quoted"']);
});

test('escapeHtml handles the ampersand first', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('remove matches loosely and tidies an emptied list', () => {
  const { html, removed } = removeItems(CAMPING, ['pegs', 'guy line', 'fan']);
  assert.deepEqual(removed.sort(), ['Fan', 'Guy line', 'Pegs']);
  assert.deepEqual(extractItems(html), ['Bunk beds 2', 'Awning poles']);
  assert.equal((html.match(/<ul>/g) ?? []).length, 1, 'emptied list should be removed');
});

test('remove reports nothing when no bullet matches', () => {
  const { removed } = removeItems(CAMPING, ['kayak']);
  assert.deepEqual(removed, []);
});

test('preview renders readable plain text', () => {
  const text = preview(CAMPING);
  assert.ok(text.startsWith('Camping Kit'));
  assert.ok(text.includes('Guy line'));
  assert.ok(!text.includes('<'));
});
