#!/usr/bin/env node
// Unit tests for getTaskBucket()
// Run with: node scripts/test-dates.js
//
// Tests use MockDate to pin "now" so results are deterministic.
// All datetime cases assume the user is in Mountain Time (UTC-7 in MDT).

// ── Inline getTaskBucket (copied verbatim from index.html) ──────────────────
function getTaskBucket(dueDateStr) {
  if (!dueDateStr) return 'no-date';

  const now = new Date();
  const isDateOnly = !dueDateStr.includes('T');

  if (isDateOnly) {
    const [year, month, day] = dueDateStr.split('-').map(Number);
    const taskDate          = new Date(year, month - 1, day);
    const todayMidnight     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight  = new Date(todayMidnight.getTime() + 86400000);

    if (taskDate < todayMidnight)                          return 'overdue';
    if (taskDate.getTime() === todayMidnight.getTime())    return 'today';
    if (taskDate.getTime() === tomorrowMidnight.getTime()) return 'tomorrow';
    return 'upcoming';
  } else {
    const taskTime          = new Date(dueDateStr);
    const todayMidnight     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight  = new Date(todayMidnight.getTime() + 86400000);

    if (taskTime < now)                                                 return 'overdue';
    if (taskTime < tomorrowMidnight)                                    return 'later-today';
    if (taskTime < new Date(tomorrowMidnight.getTime() + 86400000))     return 'tomorrow';
    return 'upcoming';
  }
}

// ── Minimal test harness ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    console.error(`       expected: ${expected}`);
    console.error(`       actual:   ${actual}`);
    failed++;
  }
}

// Pin "now" to 2026-04-13 15:00:00 Mountain (UTC-7 = 22:00:00 UTC)
// i.e. 3 pm Mountain on April 13 2026.
const FAKE_NOW = new Date('2026-04-13T22:00:00.000Z'); // 3 pm MDT

const _OrigDate = global.Date;
class MockDate extends _OrigDate {
  constructor(...args) {
    if (args.length === 0) return super(FAKE_NOW);
    super(...args);
  }
  static now() { return FAKE_NOW.getTime(); }
}
global.Date = MockDate;

// ── Test cases ──────────────────────────────────────────────────────────────

console.log('\nDate-only strings (calendar-date comparisons, no timezone):');

assert(
  'yesterday date-only → overdue',
  getTaskBucket('2026-04-12'),
  'overdue'
);

assert(
  'today date-only → today',
  getTaskBucket('2026-04-13'),
  'today'
);

assert(
  'tomorrow date-only → tomorrow',
  getTaskBucket('2026-04-14'),
  'tomorrow'
);

assert(
  'two days out date-only → upcoming',
  getTaskBucket('2026-04-15'),
  'upcoming'
);

console.log('\nDatetime strings — user in Mountain time (UTC-7), now = 3 pm MDT:');

assert(
  '8 pm Mountain (-07:00) today, currently 3 pm → later-today',
  getTaskBucket('2026-04-13T20:00:00.000-07:00'),
  'later-today'
);

assert(
  '8 am Mountain (-07:00) today, currently 3 pm → overdue',
  getTaskBucket('2026-04-13T08:00:00.000-07:00'),
  'overdue'
);

assert(
  '8 pm expressed as CST (-06:00) = 9 pm Mountain, still future → later-today',
  getTaskBucket('2026-04-13T20:00:00.000-06:00'),
  'later-today'
);

assert(
  'midnight tonight UTC (= 5 pm Mountain, future) → later-today',
  getTaskBucket('2026-04-13T23:59:00.000-07:00'),
  'later-today'
);

assert(
  'tomorrow 8 am Mountain → tomorrow',
  getTaskBucket('2026-04-14T08:00:00.000-07:00'),
  'tomorrow'
);

assert(
  'two days out datetime → upcoming',
  getTaskBucket('2026-04-15T08:00:00.000-07:00'),
  'upcoming'
);

assert(
  'no date → no-date',
  getTaskBucket(null),
  'no-date'
);

assert(
  'empty string → no-date',
  getTaskBucket(''),
  'no-date'
);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
