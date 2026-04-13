/**
 * Deterministic tests for getTaskBucket().
 * Mocked "now": 2026-04-13 15:00:00 Mountain Daylight Time (UTC-6 = 21:00 UTC)
 * Run with: node scripts/test-dates.js
 */

// ── Mock Date ─────────────────────────────────────────────────────────────────
// Fixed now: April 13 2026 at 3:00 PM MDT (UTC-6 → UTC 21:00)
const FIXED_NOW_MS = Date.UTC(2026, 3, 13, 21, 0, 0); // month is 0-indexed

const OriginalDate = Date;
class MockDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) {
      super(FIXED_NOW_MS);
    } else {
      super(...args);
    }
  }
  static now() { return FIXED_NOW_MS; }
}
global.Date = MockDate;

// ── getTaskBucket (copied verbatim from index.html) ───────────────────────────
function getTaskBucket(dueDateStr) {
  if (!dueDateStr) return 'no-date';

  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowMidnight = new Date(todayMidnight.getTime() + 86400000);
  const dayAfterMidnight = new Date(tomorrowMidnight.getTime() + 86400000);

  const isDateOnly = !dueDateStr.includes('T');

  if (isDateOnly) {
    const [year, month, day] = dueDateStr.split('-').map(Number);
    const taskDate = new Date(year, month - 1, day);

    if (taskDate < todayMidnight) return 'overdue';
    if (taskDate.getTime() === todayMidnight.getTime()) return 'today';
    if (taskDate.getTime() === tomorrowMidnight.getTime()) return 'tomorrow';
    return 'upcoming';
  } else {
    const taskTime = new Date(dueDateStr);

    if (taskTime < now) return 'overdue';
    if (taskTime < tomorrowMidnight) return 'later-today';
    if (taskTime < dayAfterMidnight) return 'tomorrow';
    return 'upcoming';
  }
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(description, input, expected) {
  const actual = getTaskBucket(input);
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`      input:    ${JSON.stringify(input)}`);
    console.error(`      expected: ${expected}`);
    console.error(`      actual:   ${actual}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
// Mocked now: 2026-04-13 15:00 MDT

console.log('\nDate-only inputs:');
test('null/missing → no-date',         null,         'no-date');
test('empty string → no-date',         '',           'no-date');
test('date-only yesterday → overdue',  '2026-04-12', 'overdue');
test('date-only today → today',        '2026-04-13', 'today');
test('date-only tomorrow → tomorrow',  '2026-04-14', 'tomorrow');
test('date-only upcoming → upcoming',  '2026-04-15', 'upcoming');

console.log('\nDatetime inputs (timed):');
// 8pm MDT = 20:00-06:00 → it's 3pm, so future → later-today
test('datetime today 8pm MDT when now=3pm → later-today',
     '2026-04-13T20:00:00.000-06:00', 'later-today');

// 8am MDT = 08:00-06:00 → it's 3pm, so past → overdue
test('datetime today 8am MDT when now=3pm → overdue',
     '2026-04-13T08:00:00.000-06:00', 'overdue');

// -06:00 offset: 9pm MDT (21:00-06:00) → still today but future → later-today
test('datetime with -06:00 offset parsed correctly → later-today',
     '2026-04-13T21:00:00.000-06:00', 'later-today');

// +00:00 offset (UTC): 21:00 UTC = 15:00 MDT → exactly now → overdue (not strictly future)
test('datetime +00:00 equal to now → overdue',
     '2026-04-13T21:00:00.000+00:00', 'overdue');

// +00:00 offset: 23:00 UTC = 17:00 MDT → future today → later-today
test('datetime +00:00 offset future today → later-today',
     '2026-04-13T23:00:00.000+00:00', 'later-today');

// Tomorrow with time
test('datetime tomorrow → tomorrow',
     '2026-04-14T10:00:00.000-06:00', 'tomorrow');

// Beyond tomorrow
test('datetime day after tomorrow → upcoming',
     '2026-04-15T10:00:00.000-06:00', 'upcoming');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
