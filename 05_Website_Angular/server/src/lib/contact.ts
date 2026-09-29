/* Linaw PH — lib/contact.ts
   The contact-detail rules, mirrored 1:1 from client/src/app/core/engine.ts
   (emailProblem, phoneProblem, linkedinProblem), where the reasoning is
   written out. The builder checks first so the applicant is told on the
   field; this is where the rule binds. A parity test runs both over the same
   inputs. */
/* CONTACT DETAILS THAT CAN ACTUALLY BE USED. A recruiter replies by email
   or phone, so a value that cannot reach anyone is worse than a blank: the
   resume looks contactable and is not. Checked only when something is typed;
   whether one of the two is present at all is a separate rule. Kept
   deliberately permissive about FORMATTING (spaces, dashes, brackets, a
   leading +) and strict about SUBSTANCE (an @ and a domain; a plausible
   count of digits). Mirrored in server/src/lib/contact.ts — the two must
   agree, and a parity test runs both over the same inputs. */
export function emailProblem(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)
    ? null : 'Enter a valid email address, for example juan@gmail.com.';
}
/** Philippine mobile and landline numbers (0917 123 4567, (045) 123 4567,
 *  +63 917 123 4567), and an international number written with a leading +. */
export function phoneProblem(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = s.replace(/[\s\-().]/g, '');
  return /^0\d{8,10}$/.test(d) || /^\+?63\d{9,10}$/.test(d) || /^\+\d{8,15}$/.test(d)
    ? null : 'Enter a valid phone number, for example 0917 123 4567 or +63 917 123 4567.';
}
/** A LinkedIn PROFILE link: linkedin.com/in/… (any country subdomain, with or
 *  without https:// and www.). The field is labelled LinkedIn, so anything
 *  else typed there is a mistake a recruiter would click into. */
export function linkedinProblem(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return /^(https?:\/\/)?([a-z]{2,3}\.|www\.)?linkedin\.com\/(in|pub)\/[A-Za-z0-9\-_%.]{2,100}\/?$/i.test(s)
    ? null : 'Enter your LinkedIn profile link, for example linkedin.com/in/juandelacruz.';
}

