import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * scrypt from node:crypto rather than argon2 or bcrypt. Both of those are native
 * addons, and this repo has already been bitten once by a node_modules built for
 * the wrong platform. scrypt is memory-hard, ships with Node, and OWASP lists it
 * as an acceptable choice when argon2id is not available. The cost parameters
 * are stored in the hash string, so they can be raised later without stranding
 * existing credentials.
 *
 * Format: scrypt$N$r$p$<salt hex>$<key hex>
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // A user with no credential must cost the same as a wrong password, or the
  // response time tells an attacker which accounts exist.
  if (!stored) {
    await scrypt(password, randomBytes(16), KEYLEN);
    return false;
  }

  const [scheme, , , , saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
