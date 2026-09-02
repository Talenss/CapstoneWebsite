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
