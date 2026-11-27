// A new account's email address is plain ASCII. Existing accounts sign in as before.
import { describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import handler from "../netlify/functions/auth.mts";
import { BadEmail, NOT_PLAIN_ASCII, NonAsciiEmail, createUser, emailKey, verifyUser } from "../src/lib/users";
import { freshStore, type MemStore } from "./helpers";

const SITE = "https://force-field-console.netlify.app";
const PASSWORD = "sufficiently-long-pass";

let store: MemStore;
beforeEach(() => {
  store = freshStore();
  process.env.SESSION_SECRET = "test-secret-0123456789";
});

const post = (path: string, email: string) =>
  handler(
    new Request(SITE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
    {} as any,
  );

// built from code points, so that the file itself stays plain
const at = (...points: number[]) => String.fromCodePoint(...points);
const REFUSED: [string, string][] = [
  ["an accented letter in the name", `jos${at(0xe9)}@example.com`],
  ["the same letter as two code points", `jose${at(0x301)}@example.com`],
  ["a full-width letter", `${at(0xff41)}nna@example.com`],
  ["a ligature", `${at(0xfb01)}n@example.com`],
  ["a Cyrillic look-alike", `${at(0x430)}nna@example.com`],
  ["a sign that lower-cases to an ASCII letter", `${at(0x212a)}im@example.com`],
  ["a domain written in other letters", `anna@b${at(0xfc)}cher.example`],
  ["a zero-width character", `an${at(0x200b)}na@example.com`],
  ["a control character", `an${at(0x7)}na@example.com`],
  ["a delete character", `an${at(0x7f)}na@example.com`],
];
const ACCEPTED = [
  "anna@example.com",
  "Anna.O'Neil+tag@Sub.Example.co.uk",
  "a!#$%&*-/=?^_`{|}~@example.com",
  "anna@xn--bcher-kva.example",
];

describe("a new account's address", () => {
  for (const [label, email] of REFUSED) {
    it(`with ${label} is refused with the reason, and nothing is written`, async () => {
      const res = await post("/api/auth/register", email);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toEqual({ code: "bad_email", message: NOT_PLAIN_ASCII });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect((await store.list()).blobs).toEqual([]);
      await expect(createUser(email, PASSWORD)).rejects.toBeInstanceOf(NonAsciiEmail);
    });
  }

  for (const email of ACCEPTED) {
    it(`${email} is accepted and signs in`, async () => {
      expect((await post("/api/auth/register", email)).status).toBe(201);
      expect((await post("/api/auth/login", email)).status).toBe(200);
    });
  }

  it("that is not an address at all keeps its own answer", async () => {
    const res = await post("/api/auth/register", "no-at-sign");
    expect((await res.json()).error.message).not.toBe(NOT_PLAIN_ASCII);
    await expect(createUser("no-at-sign", PASSWORD)).rejects.toBeInstanceOf(BadEmail);
  });
});

describe("an existing account with another address", () => {
  it("signs in as before", async () => {
    const email = `jos${at(0xe9)}@example.com`;
    const user = { id: "u-1", email, pw_hash: bcrypt.hashSync(PASSWORD, 4), tier: "sandbox", created_at: "2026-01-01T00:00:00Z", keys: [] };
    await store.setJSON(emailKey(email), user);
    await store.setJSON("uid/u-1", { email_key: emailKey(email) });
    expect((await verifyUser(email, PASSWORD))?.id).toBe("u-1");
    expect((await post("/api/auth/login", email)).status).toBe(200);
  });
});
