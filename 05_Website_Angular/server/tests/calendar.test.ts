/* ============================================================
   CALENDAR TESTS
   ------------------------------------------------------------
   The interview scheduler turns a chosen time into a Google
   Calendar link and an .ics file. These prove both come out in
   the exact shape calendars accept, that the end time honours
   the duration, and that a bad time fails closed (null) rather
   than producing a broken invite.

     cd server && npm run test:calendar
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleCalendarUrl, buildIcs, describeSchedule } from '../src/lib/calendar';
import {
  googleCalendarUrl as clientGoogleCalendarUrl,
  describeSchedule as clientDescribeSchedule,
} from '../../client/src/app/core/calendar';

const sched = { startIso: '2026-09-10T06:30:00.000Z', durationMinutes: 45, location: 'Video call' };

test('google calendar url carries a TEMPLATE action and a start/end range', () => {
  const url = googleCalendarUrl(sched, 'Interview: Analyst — Clark Outsourcing', 'Details here');
  assert.ok(url);
  const u = new URL(url!);
  assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(u.searchParams.get('action'), 'TEMPLATE');
  // 06:30 + 45 min = 07:15, both stamped as compact UTC.
  assert.equal(u.searchParams.get('dates'), '20260910T063000Z/20260910T071500Z');
  assert.equal(u.searchParams.get('text'), 'Interview: Analyst — Clark Outsourcing');
  assert.equal(u.searchParams.get('location'), 'Video call');
});

test('default duration is one hour when none is given', () => {
  const url = googleCalendarUrl({ startIso: '2026-09-10T06:30:00.000Z' }, 'x', 'y');
  assert.equal(new URL(url!).searchParams.get('dates'), '20260910T063000Z/20260910T073000Z');
});

test('ics document is well-formed and reflects the event', () => {
  const ics = buildIcs(sched, {
    title: 'Interview: Analyst — Clark Outsourcing',
    description: 'Details, with a comma',
    organizerName: 'Jane Cruz', organizerEmail: 'jane@co.example',
    attendeeEmail: 'applicant@example.com',
  });
  assert.ok(ics);
  assert.match(ics!, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics!, /\r\nEND:VCALENDAR$/);
  assert.match(ics!, /\r\nDTSTART:20260910T063000Z\r\n/);
  assert.match(ics!, /\r\nDTEND:20260910T071500Z\r\n/);
  assert.match(ics!, /\r\nLOCATION:Video call\r\n/);
  assert.match(ics!, /\r\nORGANIZER;CN=Jane Cruz:mailto:jane@co\.example\r\n/);
  // Commas in free text must be escaped so the line doesn't split.
  assert.match(ics!, /DESCRIPTION:Details\\, with a comma/);
  // CRLF line endings throughout, per RFC 5545.
  assert.ok(ics!.split('\r\n').length > 10);
});

test('a bad start time fails closed rather than emitting junk', () => {
  const bad = { startIso: 'not-a-date' };
  assert.equal(googleCalendarUrl(bad, 'x', 'y'), null);
  assert.equal(buildIcs(bad, { title: 'x', description: 'y', organizerName: 'a', organizerEmail: 'b', attendeeEmail: 'c' }), null);
  assert.equal(describeSchedule(bad), null);
});

test('human description renders in Philippine time', () => {
  // 06:30 UTC is 14:30 (2:30 PM) in Asia/Manila (UTC+8).
  const txt = describeSchedule(sched);
  assert.ok(txt);
  assert.match(txt!, /2:30/);
  assert.match(txt!, /45 minutes/);
});

/* ------------------------------------------------------------
   The bug these two exist for: URLSearchParams percent-encodes the
   separator in `dates`, giving 20260910T063000Z%2F20260910T073000Z.
   Google's TEMPLATE screen does not decode that one — the event opened
   with its title and details filled in and no date or time at all, which
   is exactly what "the Add to Google Calendar button doesn't work" looks
   like from the outside. Nothing here asserted the parameter's shape
   before, which is how it shipped.
   ------------------------------------------------------------ */
test('the dates range keeps a literal slash, not %2F', () => {
  const url = googleCalendarUrl(sched, 'Interview', 'Details');
  assert.ok(url);
  assert.ok(!url!.includes('%2F'), 'the start/end separator must not be percent-encoded');
  assert.match(url!, /[?&]dates=\d{8}T\d{6}Z\/\d{8}T\d{6}Z(&|$)/);
});

test('the dates range carries the real start and end stamps', () => {
  const url = googleCalendarUrl({ startIso: '2026-09-10T06:30:00.000Z', durationMinutes: 60 }, 'x', 'y');
  const dates = new URL(url!).searchParams.get('dates');
  assert.equal(dates, '20260910T063000Z/20260910T073000Z');
});

/* The client keeps its own copy so the demo build — which has no server —
   can still show the recruiter the link before it is sent. Same input must
   give byte-identical output, or the preview stops being a preview. */
test('client and server build the same link and the same wording', () => {
  const cases = [
    { startIso: '2026-09-10T06:30:00.000Z', durationMinutes: 60, location: 'Berthaphil III, Clark' },
    { startIso: '2026-12-01T01:00:00.000Z', durationMinutes: 45 },
    { startIso: '2026-07-04T23:15:00.000Z', durationMinutes: 120, location: 'Video call' },
    { startIso: '2026-01-15T09:00:00.000Z' },
  ];
  for (const sch of cases) {
    assert.equal(
      clientGoogleCalendarUrl(sch, 'Interview: Role at Company', 'Details here.'),
      googleCalendarUrl(sch, 'Interview: Role at Company', 'Details here.'),
      `link differs for ${sch.startIso}`,
    );
    assert.equal(clientDescribeSchedule(sch), describeSchedule(sch), `wording differs for ${sch.startIso}`);
  }
});

test('both sides fail closed on the same bad input', () => {
  assert.equal(clientGoogleCalendarUrl({ startIso: 'nope' }, 'x', 'y'), null);
  assert.equal(googleCalendarUrl({ startIso: 'nope' }, 'x', 'y'), null);
  assert.equal(clientDescribeSchedule({ startIso: 'nope' }), null);
  assert.equal(describeSchedule({ startIso: 'nope' }), null);
});
