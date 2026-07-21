import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "./session.js";

/**
 * Session invalidation on password change (User.sessionEpoch).
 *
 * attachUser admits a request only when the token's epoch equals the user's
 * current sessionEpoch column, so bumping that column strands every token minted
 * before the bump. These tests pin the two properties that make it work:
 * round-tripping the stamp, and normalizing pre-existing (epoch-less) tokens to
 * 0 so a deploy doesn't mass-log-out users whose sessionEpoch defaults to 0.
 */

/** The comparison attachUser performs, isolated from the DB. */
const admits = (tokenEpoch: number, userEpoch: number) => tokenEpoch === userEpoch;

describe("session epoch", () => {
  it("round-trips the epoch stamped at issue time", () => {
    const token = signSession({ userId: "u1", role: "OWNER", epoch: 7 });
    expect(verifySession(token)?.epoch).toBe(7);
  });

  it("normalizes a token minted before the epoch field existed to 0", () => {
    // Simulates a session issued by the previous build: no `epoch` claim. The
    // column defaults to 0, so such a token must still be admitted.
    const legacy = signSession({ userId: "u1", role: "ASSOCIATE" });
    const session = verifySession(legacy);
    expect(session?.epoch).toBe(0);
    expect(admits(session!.epoch, 0)).toBe(true);
  });

  it("strands tokens issued before a password change", () => {
    const stolen = verifySession(signSession({ userId: "u1", role: "OWNER", epoch: 3 }))!;
    // User changes their password → sessionEpoch 3 → 4.
    expect(admits(stolen.epoch, 4)).toBe(false);
  });

  it("admits the token re-issued to the user who changed the password", () => {
    const reissued = verifySession(signSession({ userId: "u1", role: "OWNER", epoch: 4 }))!;
    expect(admits(reissued.epoch, 4)).toBe(true);
  });

  it("still rejects a token with a valid epoch but a broken signature", () => {
    const token = signSession({ userId: "u1", role: "OWNER", epoch: 1 });
    expect(verifySession(`${token}tampered`)).toBeNull();
  });
});
