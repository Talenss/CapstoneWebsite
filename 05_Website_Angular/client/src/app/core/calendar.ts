/* Linaw PH — core/calendar.ts
   The client's copy of the server's lib/calendar.ts link builder.

   It exists for two reasons. The demo build has no server, so without this
   the whole scheduling feature is invisible there: the demo adapter takes a
   schedule and throws it away, which made "Add to Google Calendar" untestable
   and undemonstrable. And in either mode a recruiter should be able to see
   the exact link and the exact wording the applicant will receive BEFORE
   sending it, rather than finding out from the applicant that the time was
   wrong.

   Kept deliberately in step with server/src/lib/calendar.ts; the parity test
   in the server suite compares the two outputs for the same input. */

export interface InterviewSchedule {
  startIso: string;
  durationMinutes?: number;
  location?: string;
}

/** 20260910T063000Z — the compact UTC stamp calendars expect. */
function stampUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function resolve(sch: InterviewSchedule): { start: Date; end: Date; minutes: number } | null {
  const start = new Date(sch.startIso);
  if (Number.isNaN(start.getTime())) return null;
  const minutes = sch.durationMinutes && sch.durationMinutes > 0 ? Math.round(sch.durationMinutes) : 60;
  return { start, end: new Date(start.getTime() + minutes * 60_000), minutes };
}

/** The URL that pre-fills Google Calendar's "new event" screen. */
export function googleCalendarUrl(sch: InterviewSchedule, title: string, details: string): string | null {
  const r = resolve(sch);
  if (!r) return null;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, details });
  if (sch.location) params.set('location', sch.location);
  // Appended by hand: URLSearchParams would encode the separator as %2F, and
  // Google's TEMPLATE screen then opens the event with no date on it. Same
  // reasoning, and the same fix, as the server copy.
  const dates = `${stampUtc(r.start)}/${stampUtc(r.end)}`;
  return `https://calendar.google.com/calendar/render?${params.toString()}&dates=${dates}`;
}

/** "Thursday, September 10, 2026 at 2:30 PM GMT+8 (about 1 hour)" — the line
 *  the applicant reads in the email, shown to the recruiter unchanged. */
export function describeSchedule(sch: InterviewSchedule): string | null {
  const r = resolve(sch);
  if (!r) return null;
  const when = new Intl.DateTimeFormat('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila', timeZoneName: 'short',
  }).format(r.start);
  const dur = r.minutes % 60 === 0 ? `${r.minutes / 60} hour${r.minutes === 60 ? '' : 's'}` : `${r.minutes} minutes`;
  return `${when} (about ${dur})`;
}
