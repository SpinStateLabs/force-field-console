// Rule: the estate signer statement is at most 200 characters whatever the email (the platform refuses a longer one and
// the estate's packs would go unsigned). It names the email when the whole statement fits, otherwise a stable account
// reference; an email is never cut. The grantor the console writes into an estate is safe identity text.
import { describe, it, expect } from "vitest";
import { SIGNER_EMAIL_MAX, SIGNER_MAX, accountRef, estateSigner, isSafeIdentityText } from "../src/lib/signer";
import { attestSigner, updateEstateRoster, EstateError, type Estate } from "../src/lib/estates";

const UID = "123e4567-e89b-42d3-a456-426614174000";
const REF = "account 123e4567e89b";

/** An email of exactly `n` characters. */
function emailOfLength(n: number): string {
  const domain = "@example.com";
  return "a".repeat(n - domain.length) + domain;
}

describe("estateSigner: at most 200 characters, never a cut email", () => {
  it("the email limit that fits is 117 with the current wording", () => {
    expect(SIGNER_EMAIL_MAX).toBe(117);
  });

  it("a statement of exactly 200 characters names the email", () => {
    const email = emailOfLength(SIGNER_EMAIL_MAX);
    const s = estateSigner(email, UID);
    expect(s.length).toBe(SIGNER_MAX);
    expect(s).toContain(email);
    expect(s).not.toContain("account ");
  });

  it("an email one character longer (a 201-character statement) uses the account reference", () => {
    const email = emailOfLength(SIGNER_EMAIL_MAX + 1);
    const s = estateSigner(email, UID);
    expect(s.length).toBeLessThanOrEqual(SIGNER_MAX);
    expect(s).toContain(REF);
    expect(s).not.toContain("@");
    expect(s).not.toContain("aaaa");
  });

  it("an email of 254 characters uses the account reference", () => {
    const email = emailOfLength(254);
    const s = estateSigner(email, UID);
    expect(s.length).toBeLessThanOrEqual(SIGNER_MAX);
    expect(s).toBe("Force-Field estate key for " + REF + " (provisioned by Spin State Labs — standing attestation)");
  });

  it.each(["nul\u0000@example.com", "rlo‮@example.com", "zw​@example.com", "lone\ud800@example.com", "", "x".repeat(255)])(
    "unsafe identity text %j uses the account reference",
    (email) => {
      const s = estateSigner(email, UID);
      expect(s).toContain(REF);
      expect(s.length).toBeLessThanOrEqual(SIGNER_MAX);
      expect(/[\p{Cc}\p{Cf}]/u.test(s)).toBe(false);
    },
  );

  it("an ordinary email is named in full", () => {
    expect(estateSigner("ceo@example.com", UID)).toBe("Force-Field estate key for ceo@example.com (provisioned by Spin State Labs — standing attestation)");
  });

  it("attestSigner is the same function, keyed by the estate's user id", () => {
    expect(attestSigner(emailOfLength(200), UID)).toBe(estateSigner(emailOfLength(200), UID));
  });
});

describe("accountRef: stable, short, no personal data", () => {
  it("is 'account ' plus the first 12 hex digits of the user id", () => {
    expect(accountRef(UID)).toBe(REF);
    expect(accountRef(UID.toUpperCase())).toBe(REF);
    expect(accountRef(UID)).toBe(accountRef(UID));
  });

  it("refuses an id with fewer than 12 hex digits", () => {
    expect(() => accountRef("abc")).toThrow();
  });
});

describe("isSafeIdentityText: the rule for the grantor and owner row", () => {
  it.each(["ceo@example.com", "josé@exemple.fr", "pair😀@example.com", "x".repeat(254)])("accepts %j", (v) => {
    expect(isSafeIdentityText(v)).toBe(true);
  });
  it.each(["", "x".repeat(255), "a\u0000b", "a\u007fb", "a\u0085b", "a​b", "a‮b", "a﻿b", "a\ud800b", 42, null])("refuses %j", (v) => {
    expect(isSafeIdentityText(v)).toBe(false);
  });
});

describe("the grantor is checked where the console writes it", () => {
  it("updateEstateRoster refuses an unsafe grantor before any Fly call", async () => {
    let flyCalls = 0;
    const fly = { exec: async () => { flyCalls += 1; return { exit_code: 0, stdout: "{}", stderr: "" }; } } as any;
    const e = { app: "ff-est-00000000", machine_id: "m", status: "ready", grantor: "evil‮@example.com", user_id: UID } as unknown as Estate;
    await expect(updateEstateRoster(e, fly, { allowed_scope: ["draft"], max_ttl_days: 30 })).rejects.toMatchObject({ code: "grantor_unsafe" });
    await expect(updateEstateRoster(e, fly, { allowed_scope: ["draft"], max_ttl_days: 30 })).rejects.toBeInstanceOf(EstateError);
    expect(flyCalls).toBe(0);
  });
});
