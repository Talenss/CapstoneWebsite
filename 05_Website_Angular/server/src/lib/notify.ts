/* ResumeMatch PH — lib/notify.ts
   Application-event emails: a seeker hears when a recruiter moves their
   application; recruiters hear when someone applies. Every send respects
   the user's email_notifications preference (checked by the callers'
   queries) and is fire-and-forget — a mail failure must never fail the
   request that triggered it.

   The wording mirrors the site's core promise: every status is a human
   decision, and a low score or a rejection is never a closed door. */
import { APP_URL, DEBUG } from '../config';
import { mailConfigured, sendMail } from './mailer';

const btn = (href: string, label: string) =>
  `<p style="margin:22px 0 0"><a href="${href}" style="display:inline-block;background:#C9A24B;color:#141926;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:8px">${label}</a></p>`;

const foot = `<p style="margin:22px 0 0;font-size:12px;line-height:1.6;color:#8A8FA0">You’re receiving this because email updates are turned on for your ResumeMatch PH account. Turn them off any time in <b>My account</b>.</p>`;

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
    line: (t, c) => `A person at ${c} has started reviewing your application for <b>${t}</b>. No action needed — you’ll hear again when they decide the next step.`,
  },
  shortlisted: {
    subject: (t) => `You’ve been shortlisted for ${t}`,
    heading: 'You made the shortlist',
    line: (t, c) => `Good news — a recruiter at ${c} shortlisted your application for <b>${t}</b>. Expect them to make contact through the details on your resume.`,
  },
  hired: {
    subject: (t) => `Congratulations — ${t}`,
    heading: 'You got the job',
    line: (t, c) => `A person at ${c} marked your application for <b>${t}</b> as <b>hired</b>. Congratulations — they’ll be in touch about what happens next.`,
  },
  rejected: {
    subject: (t) => `An update on your ${t} application`,
    heading: 'Not this one — and that’s a data point, not a verdict',
    line: (t, c) => `A recruiter at ${c} decided not to move forward with your application for <b>${t}</b>. This was a person’s decision about one opening — it says nothing about the next one. Your dashboard shows roles that fit the skills you already have.`,
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
  if (!deliverable('status', seekerEmail, `${status} — ${postingTitle}`)) return;
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
      <p style="margin:10px 0 0;font-size:14.5px;line-height:1.65;color:#4C5566"><b>${esc(seekerName)}</b> just applied to <b>${t}</b>, scoring <b>${Math.round(score)}%</b> against the posting’s requirements. The score ranks the list — the read, and the decision, are yours.</p>
      ${btn(`${APP_URL}/hr-dashboard`, 'Review applicants')}
      ${foot}`,
  );
}
