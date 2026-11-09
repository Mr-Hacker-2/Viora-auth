import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const COST = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Returns an error message, or '' when the password is acceptable. */
export function checkPassword(password) {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!/\S/.test(password)) return 'Password cannot be only spaces.';
  return '';
}

/** Salted scrypt. The plain password is never stored, logged or returned; only this string is kept. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, COST.keylen, { N: COST.N, r: COST.r, p: COST.p });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

/** A fixed hash to compare against when the account does not exist, so a missing account costs the same time as a wrong password. */
export const DUMMY_HASH = await hashPassword('not-a-real-password-' + crypto.randomUUID());
