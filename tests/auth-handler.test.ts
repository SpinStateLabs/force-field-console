// The auth handler (netlify/functions/auth.mts): register, login and logout as a caller sees them through the
// function itself: routes and methods, status codes, response bodies, the session cookie, and what the error answers
// do and do not reveal. The user and session functions underneath have their own tests (users.test.ts and others).
import { describe, it, expect, beforeEach } from "vitest";
import handler, { config } from "../netlify/functions/auth.mts";
import { freshStore, type MemStore } from "./helpers";
import { readSession } from "../src/lib/session";
import { emailKey } from "../src/lib/users";

const ctx = {} as any;
const SITE = "https://force-field-console.netlify.app";
const GOOD = "sufficiently-long-pass";

let store: MemStore;
beforeEach(() => {
  store = freshStore();
});

function call(path: string, body?: unknown, init: RequestInit = {}) {
  return handler(
    new Request(SITE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
    ctx,
  );
}
const register = (email: unknown, password: unknown) => call("/api/auth/register", { email, password });
const login = (email: unknown, password: unknown) => call("/api/auth/login", { email, password });

/** The ff_session token from a Set-Cookie header, as a browser would send it back. */
async function sessionUser(res: Response): Promise<string | null> {
  const set = res.headers.get("set-cookie") ?? "";
  const token = set.split(";")[0];
  return readSession(new Request(SITE + "/api/me", { headers: { cookie: token } }));
}

describe("auth handler: routes and methods", () => {
  it("serves exactly the three auth paths", () => {
    expect(config.path).toEqual(["/api/auth/register", "/api/auth/login", "/api/auth/logout"]);
  });

  for (const path of ["/api/auth/register", "/api/auth/login", "/api/auth/logout"]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      it(`${method} ${path} is 405 and sets no cookie`, async () => {
        const res = await call(path, undefined, { method });
        expect(res.status).toBe(405);
        expect((await res.json()).error.code).toBe("method_not_allowed");
        expect(res.headers.get("set-cookie")).toBeNull();
      });
    }
  }

  it("an unknown path under the function is 404", async () => {
    const res = await call("/api/auth/other", { email: "a@example.com", password: GOOD });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("a body that is not JSON is 400 bad_json on register and login", async () => {
    for (const path of ["/api/auth/register", "/api/auth/login"]) {
      const res = await call(path, "{not json");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_json");
    }
  });
});

describe("auth handler: register", () => {
  it("creates the account: 201, the stored (lower-cased) address and tier, nothing secret in the body", async () => {
    const res = await register("New.User@Example.com", GOOD);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ email: "new.user@example.com", tier: "sandbox" });
    expect(JSON.stringify(body)).not.toContain(GOOD);
    const stored = (await store.get(emailKey("new.user@example.com"), { type: "json" })) as any;
    expect(stored.email).toBe("new.user@example.com");
    expect(stored.pw_hash).not.toContain(GOOD);
  });

  it("sets a session cookie that is HttpOnly, Secure, SameSite=Lax, Path=/, seven days, and names the new user", async () => {
    const res = await register("cookie@example.com", GOOD);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/^ff_session=[^;]+; /);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(set).toContain(flag);
    const stored = (await store.get(emailKey("cookie@example.com"), { type: "json" })) as any;
    expect(await sessionUser(res)).toBe(stored.id);
  });

  it("a second registration of the same address (any case, same letters) is 409 and changes nothing", async () => {
    await register("dup@example.com", GOOD);
    const before = await store.get(emailKey("dup@example.com"), { type: "json" });
    for (const again of ["dup@example.com", "DUP@Example.COM"]) {
      const res = await register(again, "another-long-password");
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("email_taken");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(await store.get(emailKey("dup@example.com"), { type: "json" })).toEqual(before);
  });

  it("a password under 10 characters is 400 weak_password; exactly 10 is accepted", async () => {
    const short = await register("short@example.com", "123456789");
    expect(short.status).toBe(400);
    expect((await short.json()).error.code).toBe("weak_password");
    expect(await store.get(emailKey("short@example.com"), { type: "json" })).toBeNull();
    expect((await register("ten@example.com", "1234567890")).status).toBe(201);
  });

  for (const [label, email] of [
    ["no @", "not-an-address"],
    ["no dot in the domain", "a@localhost"],
    ["a space inside", "a b@example.com"],
    ["a leading space", " a@example.com"],
    ["two @", "a@b@example.com"],
    ["empty", ""],
    ["not a string", 42],
    ["missing", undefined],
  ] as const) {
    it(`an address with ${label} is 400 bad_email and creates nothing`, async () => {
      const res = await register(email, GOOD);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_email");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect((await store.list({ prefix: "users/" })).blobs).toEqual([]);
    });
  }

  it("a password that is not a string is 400 weak_password", async () => {
    const res = await register("np@example.com", 1234567890123);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("weak_password");
  });

  it("no error answer echoes the address or the password it was given", async () => {
    await register("echo@example.com", GOOD);
    const answers = await Promise.all([
      register("echo@example.com", "echo-password-123"),
      register("echo-bad-address", "echo-password-123"),
      register("echo2@example.com", "short"),
    ]);
    for (const r of answers) {
      const text = await r.text();
      expect(text).not.toContain("echo");
    }
  });
});

describe("auth handler: login", () => {
  beforeEach(async () => {
    await register("member@example.com", GOOD);
  });

  it("the right password: 200, the account's address and tier, and a session cookie for that account", async () => {
    const res = await login("member@example.com", GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "member@example.com", tier: "sandbox" });
    const stored = (await store.get(emailKey("member@example.com"), { type: "json" })) as any;
    expect(await sessionUser(res)).toBe(stored.id);
    const set = res.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) expect(set).toContain(flag);
  });

  it("the address is matched without regard to case or surrounding spaces", async () => {
    expect((await login("MEMBER@Example.com", GOOD)).status).toBe(200);
    expect((await login("  member@example.com ", GOOD)).status).toBe(200);
  });

  it("a wrong password and an unknown address get the same answer: 401, same body, no cookie", async () => {
    const wrong = await login("member@example.com", "wrong-password-123");
    const unknown = await login("nobody@example.com", GOOD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = await wrong.json();
    const b = await unknown.json();
    expect(a).toEqual(b);
    expect(a.error.code).toBe("invalid_credentials");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(unknown.headers.get("set-cookie")).toBeNull();
  });

  it("an empty, missing or non-string password never logs in", async () => {
    for (const pw of ["", undefined, null, 1234567890, ["x"]]) {
      const res = await login("member@example.com", pw);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("a malformed address is the same 401 as a wrong password (login does not say which part was wrong)", async () => {
    const res = await login("not-an-address", GOOD);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_credentials");
  });
});

describe("auth handler: logout", () => {
  it("is 204 with an expiring ff_session cookie carrying the same flags, and needs no body", async () => {
    const res = await call("/api/auth/logout");
    expect(res.status).toBe(204);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/^ff_session=; /);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"]) expect(set).toContain(flag);
    expect(await res.text()).toBe("");
  });

  it("ignores a body that is not JSON (nothing is parsed on logout)", async () => {
    expect((await call("/api/auth/logout", "{not json")).status).toBe(204);
  });
});
