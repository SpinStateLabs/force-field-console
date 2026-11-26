import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { freshStore } from "./helpers";
import {
  createUser,
  verifyUser,
  getUserById,
  BadEmail,
  isAcceptableEmail,
  WeakPassword,
  EmailTaken,
  canonicalEmail,
  emailKey,
} from "../src/lib/users";

const GOOD_PASSWORD = "sufficiently-long-pass";
const NFC = "jos\u00e9@example.fr"; // precomposed e-acute
const NFD = "jose\u0301@example.fr"; // e + combining acute
const oldKey = (typed: string) => "users/" + createHash("sha256").update(typed.trim().toLowerCase()).digest("hex");

describe("users", () => {
  beforeEach(() => {
    freshStore();
  });

  it("registers a user on the sandbox tier with a bcrypt-hashed password", async () => {
    const u = await createUser("alice@example.com", GOOD_PASSWORD);
    expect(u.email).toBe("alice@example.com");
    expect(u.tier).toBe("sandbox");
    expect(u.id).toBeTruthy();
    expect(u.created_at).toBeTruthy();
    expect(Array.isArray(u.keys)).toBe(true);
    expect(u.keys).toHaveLength(0);
    // Password is never stored in the clear.
    expect(u.pw_hash).not.toBe(GOOD_PASSWORD);
    expect(u.pw_hash.startsWith("$2")).toBe(true); // bcrypt marker
  });

  it("rejects a duplicate email with EmailTaken", async () => {
    await createUser("dup@example.com", GOOD_PASSWORD);
    await expect(createUser("dup@example.com", GOOD_PASSWORD)).rejects.toBeInstanceOf(
      EmailTaken
    );
  });

  it("rejects malformed emails with BadEmail", async () => {
    await expect(createUser("plainly-wrong", GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
    await expect(createUser("missing@dot", GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
  });

  it("rejects an email longer than 254 characters, and accepts exactly 254", async () => {
    const local = "a".repeat(64);
    const domainFor = (n: number) => "b".repeat(n - local.length - 1 - ".example".length) + ".example";
    const ok = local + "@" + domainFor(254);
    expect(ok.length).toBe(254);
    expect(isAcceptableEmail(ok)).toBe(true);
    const long = local + "@" + domainFor(255);
    expect(long.length).toBe(255);
    await expect(createUser(long, GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
    await expect(createUser("x@" + "y".repeat(5000) + ".example", GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
  });

  it("rejects control and format characters anywhere in the email", async () => {
    for (const bad of [
      "nul\u0000@example.com",
      "bell\u0007@example.com",
      "del\u007f@example.com",
      "c1\u0085@example.com",
      "zw\u200b@example.com",
      "rlo\u202e@example.com",
      "lri\u2066@example.com",
      "bom\ufeff@example.com",
      "soft\u00adhyphen@example.com",
    ]) {
      expect(isAcceptableEmail(bad), JSON.stringify(bad)).toBe(false);
      await expect(createUser(bad, GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
    }
  });

  it("rejects lone surrogates, and keeps accepting a valid surrogate pair", async () => {
    for (const bad of ["lone\ud800@example.com", "lone\udfff@example.com", "rev\udc00\ud800@example.com", "x@exam\ud83dple.com"]) {
      expect(isAcceptableEmail(bad), JSON.stringify(bad)).toBe(false);
      await expect(createUser(bad, GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
    }
    expect(isAcceptableEmail("pair\ud83d\ude00@example.com")).toBe(true);
  });

  it("applies the 254 bound to the lower-cased form too (lower-casing can lengthen a string)", async () => {
    // U+0130 (capital I with dot above) lower-cases to two code units ("i" + U+0307).
    expect("\u0130".toLowerCase().length).toBe(2);
    const head = "\u0130".repeat(10);
    const tail = "@" + "b".repeat(254 - 10 - 1 - ".example".length) + ".example";
    const asGiven = head + tail;
    expect(asGiven.length).toBe(254);
    expect(asGiven.toLowerCase().length).toBe(264);
    expect(isAcceptableEmail(asGiven)).toBe(false);
    await expect(createUser(asGiven, GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
    const fits = "\u0130".repeat(10) + "@" + "b".repeat(254 - 20 - 1 - ".example".length) + ".example";
    expect(fits.toLowerCase().length).toBe(254);
    expect(isAcceptableEmail(fits)).toBe(true);
  });

  it("keeps accepting ordinary and international addresses, and still refuses whitespace and non-strings", async () => {
    expect(isAcceptableEmail("first.last+tag@sub.example.co.uk")).toBe(true);
    expect(isAcceptableEmail("jos\u00e9@exemple.fr")).toBe(true);
    expect(isAcceptableEmail(" lead@example.com")).toBe(false);
    expect(isAcceptableEmail("tab\t@example.com")).toBe(false);
    expect(isAcceptableEmail(42)).toBe(false);
    expect(isAcceptableEmail("")).toBe(false);
    const u = await createUser("bounded@example.com", GOOD_PASSWORD);
    expect(u.email).toBe("bounded@example.com");
  });

  it("rejects passwords shorter than 10 chars with WeakPassword", async () => {
    await expect(createUser("shorty@example.com", "nine-char")).rejects.toBeInstanceOf(
      WeakPassword
    );
  });

  it("verifyUser accepts the right password and rejects the wrong one", async () => {
    const u = await createUser("verify@example.com", GOOD_PASSWORD);
    const ok = await verifyUser("verify@example.com", GOOD_PASSWORD);
    expect(ok).not.toBeNull();
    expect(ok!.id).toBe(u.id);
    const bad = await verifyUser("verify@example.com", "wrong-password-here");
    expect(bad).toBeNull();
    const unknown = await verifyUser("nobody@example.com", GOOD_PASSWORD);
    expect(unknown).toBeNull();
  });

  it("getUserById round-trips through the uid pointer", async () => {
    const u = await createUser("roundtrip@example.com", GOOD_PASSWORD);
    const found = await getUserById(u.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(u.id);
    expect(found!.email).toBe("roundtrip@example.com");
    expect(found!.tier).toBe("sandbox");
    const missing = await getUserById("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
  });

  describe("normalisation and trailing dot (sweep finding 3 follow-ups)", () => {
    it("stores the NFC form, and the two spellings of one address share one account", async () => {
      expect(NFC).not.toBe(NFD);
      expect(canonicalEmail(NFD)).toBe(NFC);
      expect(emailKey(NFD)).toBe(emailKey(NFC));
      const u = await createUser(NFD, GOOD_PASSWORD);
      expect(u.email).toBe(NFC);
      await expect(createUser(NFC, GOOD_PASSWORD)).rejects.toBeInstanceOf(EmailTaken);
      expect((await verifyUser(NFC, GOOD_PASSWORD))?.id).toBe(u.id);
      expect((await verifyUser(NFD, GOOD_PASSWORD))?.id).toBe(u.id);
    });

    it("keeps every ASCII account on its old key", () => {
      for (const e of ["alice@example.com", "  Mixed.Case+tag@Sub.Example.co.uk "]) {
        expect(emailKey(e)).toBe(oldKey(e));
      }
    });

    it("still finds an account stored under the old (un-normalised NFD) key, for login and for the duplicate check", async () => {
      const store = freshStore();
      const legacy = { id: "11111111-1111-1111-1111-111111111111", email: NFD, pw_hash: "", tier: "sandbox", created_at: "2026-01-01T00:00:00Z", keys: [] };
      const bcrypt = (await import("bcryptjs")).default;
      legacy.pw_hash = bcrypt.hashSync(GOOD_PASSWORD, 4);
      expect(oldKey(NFD)).not.toBe(emailKey(NFD));
      await store.setJSON(oldKey(NFD), legacy);
      await store.setJSON("uid/" + legacy.id, { email_key: oldKey(NFD) });
      expect((await verifyUser(NFD, GOOD_PASSWORD))?.id).toBe(legacy.id);
      expect((await verifyUser(NFC, GOOD_PASSWORD))?.id).toBe(legacy.id);
      expect(await verifyUser(NFC, "wrong-password-here")).toBeNull();
      await expect(createUser(NFC, GOOD_PASSWORD)).rejects.toBeInstanceOf(EmailTaken);
      await expect(createUser(NFD, GOOD_PASSWORD)).rejects.toBeInstanceOf(EmailTaken);
      expect((await getUserById(legacy.id))?.email).toBe(NFD);
    });

    it("refuses a domain that ends in a dot, so one address cannot hold two accounts", async () => {
      for (const bad of ["trail@example.com.", "trail@example.com..", "Trail@Example.COM."]) {
        expect(isAcceptableEmail(bad), bad).toBe(false);
        await expect(createUser(bad, GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
      }
      expect(isAcceptableEmail("trail@example.com")).toBe(true);
    });

    it("applies the 254 bound to the NFC form too (NFC can lengthen a string)", () => {
      // U+0958 is a composition exclusion: NFC turns it into two code units.
      expect("\u0958".normalize("NFC").length).toBe(2);
      const tail = "@" + "b".repeat(254 - 10 - 1 - ".example".length) + ".example";
      const asGiven = "\u0958".repeat(10) + tail;
      expect(asGiven.length).toBe(254);
      expect(canonicalEmail(asGiven).length).toBe(264);
      expect(isAcceptableEmail(asGiven)).toBe(false);
    });
  });
});
