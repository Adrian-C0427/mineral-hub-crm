import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "../config.js";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A fixed, valid bcrypt digest used to spend the same ~work as a real verify on
// the "no such user" login path. Computed once at module load; the plaintext is
// irrelevant — nothing ever needs to compare equal to it.
const DUMMY_HASH = bcrypt.hashSync("timing-equalizer", BCRYPT_COST);

/**
 * Run a throwaway password comparison purely to equalize response timing. The
 * login handler calls this when the email matches no active user, so that a
 * missing account takes the same ~bcrypt time as a wrong password and can't be
 * distinguished by latency (user enumeration).
 */
export async function dummyVerifyPassword(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}
