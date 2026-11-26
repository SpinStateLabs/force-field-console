// signer.ts: the estate's attestation signer statement and the identity text the console writes into an estate.
//
// Rules:
//  - The signer statement is at most SIGNER_MAX (200) characters, the platform's limit for FIELD_ATTEST_SIGNER (a longer
//    one makes the estate's packs go unsigned: fail closed). Length is counted in UTF-16 code units, which is never fewer
//    than the platform's count of code points, so a statement that fits here fits there.
//  - It names the account email when the whole statement fits and the email is safe identity text; otherwise it names a
//    short, stable account reference with the same wording. An email is never cut mid-address.
//  - Safe identity text: a string of 1 to 254 characters with no Unicode control (Cc) or format (Cf) character and no
//    lone surrogate. The same rule guards the grantor and owner-roster row the console writes into an estate.

export const SIGNER_MAX = 200;
export const IDENTITY_MAX = 254;

const SIGNER_PREFIX = "Force-Field estate key for ";
const SIGNER_SUFFIX = " (provisioned by Spin State Labs — standing attestation)";

const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]/u;
const LONE_SURROGATE = /\p{Cs}/u;

/** True for text the console may write into an estate as a grantor, owner row or signer subject. */
export function isSafeIdentityText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > IDENTITY_MAX) return false;
  if (LONE_SURROGATE.test(value)) return false;
  return !UNSAFE_CHARS.test(value);
}

/**
 * A short, stable reference to the account: "account " plus the first 12 hex digits of the user id (a server-generated
 * UUID; dashes removed, lower case). It never changes for an account and contains no personal data.
 */
export function accountRef(userId: string): string {
  const hex = String(userId).toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length < 12) throw new Error("account id has fewer than 12 hex digits");
  return "account " + hex.slice(0, 12);
}

function statement(subject: string): string {
  return SIGNER_PREFIX + subject + SIGNER_SUFFIX;
}

/** The signer statement for an estate: the email when it is safe and the whole statement fits, else the account ref. */
export function estateSigner(grantor: string, userId: string): string {
  if (isSafeIdentityText(grantor)) {
    const s = statement(grantor);
    if (s.length <= SIGNER_MAX) return s;
  }
  return statement(accountRef(userId));
}

/** The longest email that still appears in the statement itself (117 with the current wording). */
export const SIGNER_EMAIL_MAX = SIGNER_MAX - SIGNER_PREFIX.length - SIGNER_SUFFIX.length;
