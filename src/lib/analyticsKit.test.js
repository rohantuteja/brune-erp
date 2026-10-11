import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSizeOf, pageCount, clampPage, pageSpan, pageWindow, inRange, normalizeRange, sortRows, csvCell, toCsv } from './analyticsKit.js';

test('page size is one of the offered sizes, else 25', () => {
  assert.equal(pageSizeOf('50'), 50);
  assert.equal(pageSizeOf('100'), 100);
  assert.equal(pageSizeOf('7'), 25);
  assert.equal(pageSizeOf(null), 25);
});

test('an empty list is page 1 of 1, and a saved page is pulled back inside the list', () => {
  assert.equal(pageCount(0, 25), 1);
  assert.equal(pageCount(133, 25), 6);
  assert.equal(clampPage('9', 133, 25), 6);      // a filter shrank the list under the saved page
  assert.equal(clampPage('0', 133, 25), 1);
  assert.equal(clampPage('abc', 133, 25), 1);
  assert.equal(clampPage(null, 0, 25), 1);
});

test('the "showing x–y of z" span', () => {
  assert.deepEqual(pageSpan(1, 25, 133), [1, 25]);
  assert.deepEqual(pageSpan(6, 25, 133), [126, 133]);
  assert.deepEqual(pageSpan(1, 25, 0), [0, 0]);
});

test('page buttons: ends and neighbours, gaps only where two or more pages are skipped', () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 4), [1, 2, 3, 4]);   // one skipped page is drawn, not hidden
  assert.deepEqual(pageWindow(1, 6), [1, 2, null, 6]);
  assert.deepEqual(pageWindow(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageWindow(5, 9), [1, null, 4, 5, 6, null, 9]);
  assert.deepEqual(pageWindow(3, 9), [1, 2, 3, 4, null, 9]);   // page 2 is not hidden behind a gap
  assert.deepEqual(pageWindow(9, 9), [1, null, 8, 9]);
});

test('date ranges are inclusive; with a range set a row without a date is out', () => {
  assert.equal(inRange('2026-10-05', '', ''), true);
  assert.equal(inRange(null, '', ''), true);
  assert.equal(inRange(null, '2026-10-01', ''), false);
  assert.equal(inRange('2026-10-01', '2026-10-01', '2026-10-05'), true);
  assert.equal(inRange('2026-10-05', '2026-10-01', '2026-10-05'), true);
  assert.equal(inRange('2026-10-06', '2026-10-01', '2026-10-05'), false);
  assert.equal(inRange('2026-09-30', '2026-10-01', ''), false);
  assert.equal(inRange('2026-12-31', '', '2026-10-05'), false);
});

test('an end date typed before the start drags the other bound along', () => {
  assert.deepEqual(normalizeRange('2026-10-10', '2026-10-05', 'from'), { from: '2026-10-10', to: '2026-10-10' });
  assert.deepEqual(normalizeRange('2026-10-10', '2026-10-05', 'to'), { from: '2026-10-05', to: '2026-10-05' });
  assert.deepEqual(normalizeRange('2026-10-01', '2026-10-05', 'to'), { from: '2026-10-01', to: '2026-10-05' });
  assert.deepEqual(normalizeRange('', '2026-10-05', 'to'), { from: '', to: '2026-10-05' });
});

test('sorting: numbers as numbers, text with numeric awareness, missing values last in both directions, stable', () => {
  const rows = [{ n: '37801', d: 3 }, { n: '37800', d: null }, { n: '37810', d: 10 }, { n: '37809', d: 3 }];
  assert.deepEqual(sortRows(rows, r => r.n, 'asc').map(r => r.n), ['37800', '37801', '37809', '37810']);
  assert.deepEqual(sortRows(rows, r => r.n, 'desc').map(r => r.n), ['37810', '37809', '37801', '37800']);
  assert.deepEqual(sortRows(rows, r => r.d, 'asc').map(r => r.n), ['37801', '37809', '37810', '37800']);
  assert.deepEqual(sortRows(rows, r => r.d, 'desc').map(r => r.n), ['37810', '37801', '37809', '37800']);   // ties keep their order
  assert.deepEqual(sortRows([{ k: 'A10' }, { k: 'A2' }], r => r.k).map(r => r.k), ['A2', 'A10']);
});

test('CSV: quoting, embedded quotes and line breaks, and formulas defused', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(-1599), '-1599');                 // a negative amount stays a number
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(toCsv(['Order', 'Note'], [['37800', 'a, b']]), 'Order,Note\r\n37800,"a, b"');
});
