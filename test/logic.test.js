// Plain-node unit tests (no framework). Run with: npm test
const assert = require('assert');
const { summaryCharLimit } = require('../summarize');
const {
  mergeBuffers,
  isImageEntry,
  isDescribedImage,
  mergeImageEntries,
  mapLimit,
  isPageDeadError,
} = require('../index');
const cal = require('../calendar');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

(async () => {
  console.log('summaryCharLimit — généreux 300/500/700/900');
  await test('≤15 messages → 300', () => {
    assert.strictEqual(summaryCharLimit(0), 300);
    assert.strictEqual(summaryCharLimit(15), 300);
  });
  await test('16–40 → 500', () => {
    assert.strictEqual(summaryCharLimit(16), 500);
    assert.strictEqual(summaryCharLimit(40), 500);
  });
  await test('41–100 → 700', () => {
    assert.strictEqual(summaryCharLimit(41), 700);
    assert.strictEqual(summaryCharLimit(100), 700);
  });
  await test('>100 → 900', () => {
    assert.strictEqual(summaryCharLimit(101), 900);
    assert.strictEqual(summaryCharLimit(5000), 900);
  });

  console.log('\nimage detection helpers');
  await test('placeholder & caption are images, not described', () => {
    assert.ok(isImageEntry({ body: '[Image]' }));
    assert.ok(isImageEntry({ body: '[Image — un chat]' }));
    assert.ok(isImageEntry({ isImage: true, body: '[Image]' }));
    assert.ok(!isDescribedImage({ body: '[Image]' }));
    assert.ok(!isDescribedImage({ body: '[Image — un chat]' }));
  });
  await test('"[Image : …]" is a described image', () => {
    assert.ok(isImageEntry({ body: '[Image : un chat sur un canapé]' }));
    assert.ok(isDescribedImage({ body: '[Image : un chat sur un canapé]' }));
  });
  await test('plain text is not an image', () => {
    assert.ok(!isImageEntry({ body: 'Bonjour tout le monde' }));
  });

  console.log('\nmergeImageEntries — prefer described, keep mediaId');
  await test('described copy wins, mediaId preserved', () => {
    const m = mergeImageEntries(
      { body: '[Image : un chat]', timestamp: 1, author: 'A' },
      { body: '[Image]', mediaId: 'X', isImage: true, timestamp: 1, author: 'A' },
    );
    assert.strictEqual(m.body, '[Image : un chat]');
    assert.strictEqual(m.mediaId, 'X');
  });

  console.log('\nmergeBuffers — dedup (the duplicate-image prod bug)');
  await test('live described + historical placeholder → 1 described entry, mediaId kept', () => {
    const live = { g1: [{ author: 'Alice', body: '[Image : un chat sur un canapé]', timestamp: 100 }] };
    const hist = { g1: [{ author: 'Alice', body: '[Image]', timestamp: 100, mediaId: 'X', isImage: true }] };
    const m = mergeBuffers(live, hist);
    assert.strictEqual(m.g1.length, 1);
    assert.strictEqual(m.g1[0].body, '[Image : un chat sur un canapé]');
    assert.strictEqual(m.g1[0].mediaId, 'X');
  });
  await test('historical-only image (restart) → placeholder kept with mediaId', () => {
    const hist = { g1: [{ author: 'Bob', body: '[Image]', timestamp: 200, mediaId: 'Y', isImage: true }] };
    const m = mergeBuffers({}, hist);
    assert.strictEqual(m.g1.length, 1);
    assert.strictEqual(m.g1[0].mediaId, 'Y');
    assert.ok(!isDescribedImage(m.g1[0]));
  });
  await test('live fallback [Image] (no mediaId) + historical [Image] (mediaId) → mediaId filled', () => {
    const live = { g1: [{ author: 'C', body: '[Image]', timestamp: 300 }] };
    const hist = { g1: [{ author: 'C', body: '[Image]', timestamp: 300, mediaId: 'Z', isImage: true }] };
    const m = mergeBuffers(live, hist);
    assert.strictEqual(m.g1.length, 1);
    assert.strictEqual(m.g1[0].mediaId, 'Z');
  });
  await test('two different images (same author, diff timestamp) → both kept', () => {
    const a = { g1: [
      { author: 'A', body: '[Image]', timestamp: 1, mediaId: 'm1', isImage: true },
      { author: 'A', body: '[Image]', timestamp: 2, mediaId: 'm2', isImage: true },
    ] };
    const m = mergeBuffers(a, {});
    assert.strictEqual(m.g1.length, 2);
  });
  await test('text + image at same timestamp+author → both kept (distinct keys)', () => {
    const a = { g1: [
      { author: 'A', body: 'Regarde ça', timestamp: 5 },
      { author: 'A', body: '[Image]', timestamp: 5, mediaId: 'm', isImage: true },
    ] };
    const m = mergeBuffers(a, {});
    assert.strictEqual(m.g1.length, 2);
  });
  await test('plain-text dedup unchanged (dup collapses, distinct kept)', () => {
    const a = { g1: [{ author: 'A', body: 'Salut', timestamp: 1 }] };
    const b = { g1: [
      { author: 'A', body: 'Salut', timestamp: 1 },
      { author: 'A', body: 'Ça va ?', timestamp: 2 },
    ] };
    const m = mergeBuffers(a, b);
    assert.strictEqual(m.g1.length, 2);
  });

  console.log('\nmapLimit — order preserved, concurrency capped');
  await test('preserves order and maps all items', async () => {
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => x * 2);
    assert.deepStrictEqual(out, [2, 4, 6, 8, 10]);
  });
  await test('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    await mapLimit([...Array(10).keys()], 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    assert.ok(maxActive <= 3, `maxActive=${maxActive}`);
  });

  console.log('\nisPageDeadError — detects a detached/dead Puppeteer page');
  await test('matches the real "detached Frame" error (the prod outage)', () => {
    assert.ok(isPageDeadError(new Error("Attempted to use detached Frame 'D406BED559FC9A218E5347AEA10DDAE7'.")));
  });
  await test('matches other dead-page errors', () => {
    assert.ok(isPageDeadError(new Error('Session closed. Most likely the page has been closed.')));
    assert.ok(isPageDeadError(new Error('Target closed')));
    assert.ok(isPageDeadError(new Error('Execution context was destroyed, most likely because of a navigation.')));
  });
  await test('does NOT match ordinary errors', () => {
    assert.ok(!isPageDeadError(new Error('chat introuvable')));
    assert.ok(!isPageDeadError(new Error('ETELEGRAM: 502 Bad Gateway')));
    assert.ok(!isPageDeadError(undefined));
  });

  console.log('\ncalendar — XCM match, H-24 alert timing, dedup');
  await test('matchesXCM: case-insensitive, in title', () => {
    assert.ok(cal.matchesXCM('XCM demandé'));
    assert.ok(cal.matchesXCM('GVA - CDG R2 ok xcm ok'));
    assert.ok(!cal.matchesXCM('réunion équipage'));
    assert.ok(!cal.matchesXCM(null));
  });
  await test('alertTimeFor: timed = start-24h, all-day = start-15h', () => {
    const start = new Date('2026-09-07T15:00:00Z');
    assert.strictEqual(+cal.alertTimeFor(start, false), +new Date('2026-09-06T15:00:00Z'));
    assert.strictEqual(+cal.alertTimeFor(start, true), +new Date(start.getTime() - 15 * 3600 * 1000));
  });
  await test('dueAlerts: fires only once H-24 reached, before start, unless already alerted', () => {
    const now = new Date('2026-09-06T15:05:00Z'); // just past H-24 of a 09-07T15:00 event
    const occ = [
      { uid: 'A', start: new Date('2026-09-07T15:00:00Z'), isAllDay: false, summary: 'XCM A' }, // due
      { uid: 'B', start: new Date('2026-09-08T15:00:00Z'), isAllDay: false, summary: 'XCM B' }, // >24h → not yet
      { uid: 'C', start: new Date('2026-09-06T10:00:00Z'), isAllDay: false, summary: 'XCM C' }, // already started
    ];
    const due = cal.dueAlerts(occ, now, new Set());
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].uid, 'A');
    // already-alerted key suppresses it
    assert.strictEqual(cal.dueAlerts(occ, now, new Set([cal.dedupKey('A', occ[0].start)])).length, 0);
  });
  await test('dueAlerts: event added late (<24h out) alerts immediately', () => {
    const now = new Date('2026-09-06T15:05:00Z');
    const late = [{ uid: 'D', start: new Date('2026-09-06T18:00:00Z'), isAllDay: false, summary: 'XCM D' }];
    assert.strictEqual(cal.dueAlerts(late, now, new Set()).length, 1);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
