/* Linaw PH — lib/calendar.ts
   Turns an interview time into two things a recruiter's invite email can
   carry: a one-click "Add to Google Calendar" link, and a standard .ics
   file that any calendar app (Google, Outlook, Apple) can import.

   No Google account, no OAuth, no API keys, no extra npm packages — the
   link is a plain URL and the .ics is a few lines of text we format by
   hand. That keeps it inside the app's strict Content-Security-Policy and
   means it works the moment email is configured. */

export interface InterviewSchedule {
  /** The instant the interview starts, as an ISO string (e.g. the value of
   *  a browser datetime-local field converted with Date.toISOString()).
   *  Stored and sent as UTC; every calendar shows it in the viewer's own
   *  timezone, so the recruiter and applicant see the same wall-clock time. */
  startIso: string;
  /** How long to block out, in minutes. Defaults to 60 when omitted. */
  durationMinutes?: number;
  /** Optional: "Video call", an office address, a meeting link, etc. */
  location?: string;
}

/** Format a Date as the compact UTC stamp calendars expect: 20260910T063000Z. */
function stampUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Fold and escape a value for an ICS line (commas, semicolons, newlines). */
function icsEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Resolve a schedule into the two Date objects everything else needs.
 *  Returns null if the start time can't be parsed. */
function resolve(sch: InterviewSchedule): { start: Date; end: Date; minutes: number } | null {
  const start = new Date(sch.startIso);
  if (Number.isNaN(start.getTime())) return null;
  const minutes = sch.durationMinutes && sch.durationMinutes > 0 ? Math.round(sch.durationMinutes) : 60;
  const end = new Date(start.getTime() + minutes * 60_000);
  return { start, end, minutes };
}

/** The URL that pre-fills Google Calendar's "new event" screen. Opening it
 *  (signed in to any Google account) shows the event ready to save. */
export function googleCalendarUrl(sch: InterviewSchedule, title: string, details: string): string | null {
  const r = resolve(sch);
  if (!r) return null;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, details });
  if (sch.location) params.set('location', sch.location);

  /* `dates` is appended by hand rather than through URLSearchParams, which
     percent-encodes the separator to `20260910T063000Z%2F20260910T073000Z`.
     Google's TEMPLATE screen wants a literal slash between the two stamps and
     does not decode that one: the event opened with the title and details
     filled in but no date or time, which is precisely "the button doesn't
     work". The stamps are digits, T and Z only, so nothing here needs
     escaping. */
  const dates = `${stampUtc(r.start)}/${stampUtc(r.end)}`;
  return `https://calendar.google.com/calendar/render?${params.toString()}&dates=${dates}`;
}

/** A full VCALENDAR document for the interview — the .ics attachment. */
export function buildIcs(
  sch: InterviewSchedule,
  opts: { title: string; description: string; organizerName: string; organizerEmail: string; attendeeEmail: string },
): string | null {
  const r = resolve(sch);
  if (!r) return null;
  const uid = `${stampUtc(r.start)}-${Math.random().toString(36).slice(2, 10)}@linaw.ph`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Linaw PH//Interview//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stampUtc(new Date())}`,
    `DTSTART:${stampUtc(r.start)}`,
    `DTEND:${stampUtc(r.end)}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(opts.description)}`,
    ...(sch.location ? [`LOCATION:${icsEscape(sch.location)}`] : []),
    `ORGANIZER;CN=${icsEscape(opts.organizerName)}:mailto:${opts.organizerEmail}`,
    `ATTENDEE;CN=${icsEscape(opts.attendeeEmail)};RSVP=TRUE:mailto:${opts.attendeeEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // ICS lines are joined with CRLF per the spec.
  return lines.join('\r\n');
}

/** A short, human-readable rendering of the time, for the email body.
 *  Uses Philippine time since that's where the partner and applicants are. */
export function describeSchedule(sch: InterviewSchedule): string | null {
  const r = resolve(sch);
  if (!r) return null;
  const fmt = new Intl.DateTimeFormat('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila', timeZoneName: 'short',
  });
  const when = fmt.format(r.start);
  const dur = r.minutes % 60 === 0 ? `${r.minutes / 60} hour${r.minutes === 60 ? '' : 's'}` : `${r.minutes} minutes`;
  return `${when} (about ${dur})`;
}
