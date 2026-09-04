/* Linaw PH — lib/notify.ts
   Application-event emails: a seeker hears when a recruiter moves their
   application; recruiters hear when someone applies. Every send respects
   the user's email_notifications preference (checked by the callers'
   queries) and is fire-and-forget — a mail failure must never fail the
   request that triggered it.

   The wording mirrors the site's core promise: every status is a human
   decision, and a low score or a rejection is never a closed door. */
import { APP_URL, DEBUG } from '../config';
import { mailConfigured, sendMail } from './mailer';
import { InterviewSchedule, googleCalendarUrl, buildIcs, describeSchedule } from './calendar';

/* The href is escaped like any other attribute value. A calendar URL carries
   several `&` separators, and an unescaped `&` in an attribute is at the mercy
   of whatever HTML parser the recipient's mail client happens to use. */
const attr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const btn = (href: string, label: string) =>
  `<p style="margin:22px 0 0"><a href="${attr(href)}" style="display:inline-block;background:#C9A24B;color:#141926;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px">${label}</a></p>`;

const foot = `<p style="margin:22px 0 0;font-size:12px;line-height:1.6;color:#8A8FA0">You’re receiving this because email updates are turned on for your Linaw PH account. Turn them off any time in <b>My account</b>.</p>`;

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Central guard: true when a real send should happen. In development
 *  without SMTP we log what would have been sent instead, so the flow is
 *  visible while testing. */
function deliverable(kind: string, to: string, summary: string): boolean {
  if (mailConfigured()) return true;
  if (DEBUG) console.log(`[notify] SMTP not configured — would email ${to} (${kind}): ${summary}`);
  return false;
}

const STATUS_COPY: Record<string, { subject: (t: string) => string; heading: string; line: (t: string, c: string) => string }> = {
  review: {
    subject: (t) => `Your application for ${t} is being reviewed`,
    heading: 'Someone is reading your application',
    line: (t, c) => `A person at ${c} has started reviewing your application for <b>${t}</b>. No action needed. You’ll hear again when they decide the next step.`,
  },
  scheduling: {
    subject: (t) => `Your ${t} application is moving forward`,
    heading: 'You’re being scheduled',
    line: (t, c) => `A recruiter at ${c} moved your application for <b>${t}</b> to scheduling. They’ll reach you through the contact details on your resume to arrange the next step.`,
  },
  initial_interview: {
    subject: (t) => `Initial interview: ${t}`,
    heading: 'You’re up for an initial interview',
    line: (t, c) => `A recruiter at ${c} has set your application for <b>${t}</b> for an initial interview. Watch the email and phone number on your resume for the details.`,
  },
  testing: {
    subject: (t) => `Assessment stage: ${t}`,
    heading: 'You’ve reached the assessment stage',
    line: (t, c) => `Your application for <b>${t}</b> at ${c} has moved to testing. A recruiter will send you what the assessment involves.`,
  },
  final_interview: {
    subject: (t) => `Final interview: ${t}`,
    heading: 'You’ve reached the final interview',
    line: (t, c) => `Good news: a recruiter at ${c} moved your application for <b>${t}</b> to the final interview and selection stage. Expect them to make contact soon.`,
  },
  offer: {
    subject: (t) => `A job offer for ${t}`,
    heading: 'There’s an offer on the table',
    line: (t, c) => `A recruiter at ${c} marked your application for <b>${t}</b> as a <b>job offer</b>. They’ll be in touch about the details. Congratulations.`,
  },
  shortlisted: {
    subject: (t) => `You’ve been shortlisted for ${t}`,
    heading: 'You made the shortlist',
    line: (t, c) => `Good news: a recruiter at ${c} shortlisted your application for <b>${t}</b>. Expect them to make contact through the details on your resume.`,
  },
  hired: {
    subject: (t) => `Congratulations: ${t}`,
    heading: 'You got the job',
    line: (t, c) => `A person at ${c} marked your application for <b>${t}</b> as <b>hired</b>. Congratulations, they’ll be in touch about what happens next.`,
  },
  rejected: {
    subject: (t) => `An update on your ${t} application`,
    heading: 'Not this one, and that’s a data point, not a verdict',
    line: (t, c) => `A recruiter at ${c} decided not to move forward with your application for <b>${t}</b>. This was a person’s decision about one opening, and it says nothing about the next one. Your dashboard shows roles that fit the skills you already have.`,
  },
  submitted: {
    subject: (t) => `Your application for ${t} was received`,
    heading: 'Application received',
    line: (t, c) => `Your application for <b>${t}</b> at ${c} is in the recruiter’s queue.`,
  },
};

/** Email the seeker when a recruiter changes their application's status.
 *  Callers skip 'submitted' (that's the seeker's own action). */
export async function notifyStatusChange(
  seekerEmail: string,
  seekerName: string,
  postingTitle: string,
  companyName: string,
  status: string,
): Promise<void> {
  const c = STATUS_COPY[status];
  if (!c) return;
  const t = esc(postingTitle);
  const co = esc(companyName);
  if (!deliverable('status', seekerEmail, `${status}: ${postingTitle}`)) return;
  await sendMail(
    seekerEmail,
    c.subject(postingTitle),
    `${c.heading}\n\n${c.line(postingTitle, companyName).replace(/<[^>]+>/g, '')}\n\nTrack it: ${APP_URL}/seeker-dashboard`,
    `
      <h1 style="margin:0 0 10px;font-size:22px">${c.heading}</h1>
      <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${esc(seekerName)},</p>
      <p style="margin:10px 0 0;font-size:14.5px;line-height:1.65;color:#4C5566">${c.line(t, co)}</p>
      ${btn(`${APP_URL}/seeker-dashboard`, 'Open my dashboard')}
      ${foot}`,
  );
}

/** A recruiter's personal message to an applicant (interview invitation).
 *  Unlike the fire-and-forget notifications, the caller needs to know
 *  whether it went out — the recruiter is waiting on the result. */
export async function sendInterviewInvite(
  seekerEmail: string,
  seekerName: string,
  recruiterName: string,
  recruiterEmail: string,
  postingTitle: string,
  companyName: string,
  message: string,
  schedule?: InterviewSchedule,
): Promise<{ ok: true; sent: boolean } | { ok: false; error: string }> {
  if (!mailConfigured()) {
    if (DEBUG) {
      console.log(`[notify] SMTP not configured — would email ${seekerEmail} (invite from ${recruiterName}): ${message.slice(0, 80)}…`);
      return { ok: true, sent: false };
    }
    return { ok: false, error: "Email sending isn't configured on this server, so the message can't be delivered." };
  }
  const t = esc(postingTitle);

  /* If the recruiter picked a time, turn it into a friendly line, an
     "Add to Google Calendar" button and an .ics the applicant can import
     into any calendar. A bad/missing time simply skips the calendar bits —
     the message still goes out. */
  const eventTitle = `Interview: ${postingTitle} at ${companyName}`;
  const eventDetails = `Interview for your ${postingTitle} application with ${companyName}. Contact: ${recruiterName} (${recruiterEmail}).`;
  const when = schedule ? describeSchedule(schedule) : null;
  const gcalUrl = schedule ? googleCalendarUrl(schedule, eventTitle, eventDetails) : null;
  const ics = schedule
    ? buildIcs(schedule, { title: eventTitle, description: eventDetails, organizerName: recruiterName, organizerEmail: recruiterEmail, attendeeEmail: seekerEmail })
    : null;

  const whenBlockHtml = when
    ? `<div style="margin:16px 0 0;border:1px solid #E3DCCB;border-radius:10px;padding:14px 18px;background:#FFFDF8">
        <p style="margin:0;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;color:#8A8FA0">Proposed interview time</p>
        <p style="margin:6px 0 0;font-size:15px;font-weight:700;color:#1E2430">📅 ${esc(when)}</p>
        ${schedule?.location ? `<p style="margin:4px 0 0;font-size:13.5px;color:#4C5566">Where: ${esc(schedule.location)}</p>` : ''}
        ${gcalUrl ? btn(gcalUrl, 'Add to Google Calendar') : ''}
        <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#8A8FA0">A calendar file is attached too. Open it to add this to Apple Calendar, Outlook or any other app. Reply to confirm or suggest another time.</p>
      </div>`
    : '';
  const whenTextLine = when ? `\n\nProposed interview time: ${when}${schedule?.location ? `, ${schedule.location}` : ''}${gcalUrl ? `\nAdd to Google Calendar: ${gcalUrl}` : ''}` : '';

  try {
    await sendMail(
      seekerEmail,
      `${companyName}: about your ${postingTitle} application`,
      `A message about your application\n\nFrom ${recruiterName} (${companyName}) regarding ${postingTitle}:\n\n${message}${whenTextLine}\n\nReply to this email to answer them directly.`,
      `
        <h1 style="margin:0 0 10px;font-size:22px">A message about your application</h1>
        <p style="margin:0 0 14px;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${esc(seekerName)}, <b>${esc(recruiterName)}</b> of <b>${esc(companyName)}</b> wrote to you about your application for <b>${t}</b>:</p>
        <div style="border-left:3px solid #C9A24B;background:#FAF6EE;padding:14px 18px;border-radius:0 8px 8px 0;font-size:14.5px;line-height:1.7;color:#1E2430;white-space:pre-wrap">${esc(message)}</div>
        ${whenBlockHtml}
        <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#8A8FA0">Reply to this email to answer ${esc(recruiterName)} directly.</p>`,
      {
        replyTo: recruiterEmail,
        ...(ics ? { attachment: { filename: 'interview.ics', content: ics, contentType: 'text/calendar; method=REQUEST' } } : {}),
      },
    );
    return { ok: true, sent: true };
  } catch (e: any) {
    console.error('invite send failed:', e?.message || e);
    return { ok: false, error: 'The email could not be sent right now. Try again in a moment.' };
  }
}

/** Job alert: a brand-new opening scores well against the seeker's active
 *  resume. The engine did the matching — the email just reports it. */
export async function notifyNewPostingMatch(
  seekerEmail: string,
  seekerName: string,
  postingTitle: string,
  companyName: string,
  score: number,
  tier: string,
): Promise<void> {
  if (!deliverable('job-alert', seekerEmail, `${postingTitle} (${score}%)`)) return;
  const t = esc(postingTitle);
  const label = tier === 'strong' ? 'a strong match' : 'a possible match';
  await sendMail(
    seekerEmail,
    `New opening that fits you: ${postingTitle} (${Math.round(score)}% match)`,
    `A new opening fits your resume\n\n${companyName} just posted ${postingTitle}, and your active resume scores ${Math.round(score)}% against its requirements: ${label}.\n\nSee it: ${APP_URL}/browse`,
    `
      <h1 style="margin:0 0 10px;font-size:22px">A new opening fits your resume</h1>
      <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${esc(seekerName)},</p>
      <p style="margin:10px 0 0;font-size:14.5px;line-height:1.65;color:#4C5566">${esc(companyName)} just posted <b>${t}</b>, and your active resume scores <b>${Math.round(score)}%</b> against its stated requirements: ${label}. The score reflects the skills, education and experience this opening asks for; open it to see the exact breakdown.</p>
      ${btn(`${APP_URL}/browse`, 'See the opening')}
      ${foot}`,
  );
}

/** Email a recruiter when a new application lands on one of their postings. */
export async function notifyNewApplication(
  recruiterEmail: string,
  recruiterName: string,
  postingTitle: string,
  seekerName: string,
  score: number,
): Promise<void> {
  if (!deliverable('new-application', recruiterEmail, `${seekerName} → ${postingTitle}`)) return;
  const t = esc(postingTitle);
  await sendMail(
    recruiterEmail,
    `New applicant for ${postingTitle}`,
    `New applicant\n\n${seekerName} applied to ${postingTitle} with a compatibility score of ${score}%.\n\nReview: ${APP_URL}/hr-dashboard`,
    `
      <h1 style="margin:0 0 10px;font-size:22px">New applicant</h1>
      <p style="margin:0;font-size:14.5px;line-height:1.65;color:#4C5566">Hi ${esc(recruiterName)},</p>
      <p style="margin:10px 0 0;font-size:14.5px;line-height:1.65;color:#4C5566"><b>${esc(seekerName)}</b> just applied to <b>${t}</b>, scoring <b>${Math.round(score)}%</b> against the posting’s requirements. The score ranks the list. The read, and the decision, are yours.</p>
      ${btn(`${APP_URL}/hr-dashboard`, 'Review applicants')}
      ${foot}`,
  );
}
