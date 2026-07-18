/* ResumeMatch PH — lib/password.ts
   One password rule for everything that SETS a password (register, reset,
   change, create-admin). Never applied at login, so accounts made under
   the older 6-character rule keep working until their next change.
   Mirrored client-side in client/src/app/core/engine.ts. */

export const PASSWORD_MIN = 8;
export const PASSWORD_HINT = 'At least 8 characters, including a letter and a number.';

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(p: string): string | null {
  if (typeof p !== 'string' || p.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Use both letters and at least one number.';
  return null;
}
