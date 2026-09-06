import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shapePage as shapePageJs } from '../../src/routes/messages.js';

type Row = { id: number; body?: string };
const shapePage = shapePageJs as (
  newestFirst: Row[],
  limit: number,
) => { rows: Row[]; hasMore: boolean; nextBefore: number | null };

/**
 * N2 — keyset pagination. `shapePage` is the cursor arithmetic pulled out of the
 * GET /api/messages handler so it can be checked without a database. The query
 * asks for `limit + 1` rows, newest first; the extra row is how we know an older
 * page exists.
 */
describe('N2: shapePage', () => {
  const row = (id: number) => ({ id, body: `m${id}` });

  it('reports no older page when the query returns exactly `limit` rows', () => {
    const newestFirst = [row(30), row(29), row(28)];
    const page = shapePage(newestFirst, 3);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.rows.map((r) => r.id), [28, 29, 30], 'rows come back oldest-first');
    assert.equal(page.nextBefore, 28, 'cursor is the oldest id on the page');
  });

  it('detects an older page and drops the sentinel row', () => {
    // limit 3, so the query fetched 4. The 4th (oldest) is the sentinel.
    const newestFirst = [row(30), row(29), row(28), row(27)];
    const page = shapePage(newestFirst, 3);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.rows.map((r) => r.id), [28, 29, 30], 'only `limit` rows returned');
    assert.equal(page.nextBefore, 28);
    assert.ok(!page.rows.some((r) => r.id === 27), 'sentinel row is not leaked to the client');
  });

  it('handles a short final page', () => {
    const page = shapePage([row(2), row(1)], 50);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.rows.map((r) => r.id), [1, 2]);
    assert.equal(page.nextBefore, 1);
  });

  it('handles an empty result', () => {
    const page = shapePage([], 50);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.rows, []);
    assert.equal(page.nextBefore, null);
  });

  it('walks a 125-row history without gaps or repeats', () => {
    // Simulate the table: ids 1..125. The handler orders by id DESC and, when
    // `before` is set, filters id < before.
    const ALL = Array.from({ length: 125 }, (_, i) => i + 1);
    const queryNewestFirst = (before: number | null, take: number) =>
      ALL.filter((id) => before === null || id < before)
        .sort((a, b) => b - a)
        .slice(0, take)
        .map(row);

    const limit = 50;
    const seen: number[] = [];
    let before: number | null = null;
    let guard = 0;

    while (guard++ < 100) {
      const newestFirst = queryNewestFirst(before, limit + 1);
      const page = shapePage(newestFirst, limit);
      // Pages arrive oldest-first; prepend so `seen` stays ascending overall.
      seen.unshift(...page.rows.map((r) => r.id));
      if (!page.hasMore) break;
      before = page.nextBefore!;
    }

    assert.deepEqual(seen, ALL, 'every id seen exactly once, in order');
    assert.equal(new Set(seen).size, 125, 'no duplicates');
  });

  it('new rows arriving mid-scroll do not shift an in-progress page', () => {
    // Page 1 taken from a 60-row table.
    const table = Array.from({ length: 60 }, (_, i) => i + 1);
    const q = (before: number | null) =>
      table.filter((id) => before === null || id < before).sort((a, b) => b - a).slice(0, 51).map(row);

    const first = shapePage(q(null), 50);
    assert.equal(first.nextBefore, 11);

    // 5 more messages land (ids 61..65) before the reader scrolls up.
    table.push(61, 62, 63, 64, 65);

    const second = shapePage(q(first.nextBefore), 50);
    assert.deepEqual(
      second.rows.map((r) => r.id),
      Array.from({ length: 10 }, (_, i) => i + 1),
      'older page is ids 1..10 — the new rows at the top are never revisited',
    );
    assert.equal(second.hasMore, false);
  });
});
