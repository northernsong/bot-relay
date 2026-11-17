import { afterEach, describe, expect, it } from "vitest";

import { login, makeApp } from "./helpers.js";

const open: Array<{ close: () => void | Promise<void> }> = [];

afterEach(async () => {
  while (open.length) {
    const item = open.pop();
    if (item) await item.close();
  }
});

function directives(csp: string | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of (csp ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
}

describe("HTML Content-Security-Policy", () => {
  it("lets the admin console and register page fetch same-origin APIs, and nothing else", async () => {
    const { app, deps } = makeApp();
    open.push({ close: () => deps.db.close() });
    const session = await login(app);

    const pages: Array<[string, Record<string, string>]> = [
      ["/admin", { accept: "text/html", cookie: session.cookie }],
      ["/admin/login", { accept: "text/html" }],
      ["/register", { accept: "text/html" }],
    ];
    for (const [path, headers] of pages) {
      const res = await app.request(path, { headers });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type") ?? "", path).toContain("text/html");
      const csp = directives(res.headers.get("content-security-policy"));
      // default-src 'none' would otherwise block fetch() to /admin/api/* and /v1/register.
      expect(csp.get("connect-src"), path).toEqual(["'self'"]);
      expect(csp.get("default-src"), path).toEqual(["'none'"]);
      expect(csp.get("script-src"), path).toEqual(["'self'"]);
      expect(csp.get("form-action"), path).toEqual(["'self'"]);
    }
  });
});
