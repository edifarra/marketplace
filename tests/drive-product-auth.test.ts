import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import test from "node:test";

function load(file: string, mocks: Record<string, unknown>, env: Record<string, string> = {}) {
  const module = { exports: {} as any };
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  } }).outputText;
  runInNewContext(source, { module, exports: module.exports, Headers, process: { env },
    require: (name: string) => { if (!(name in mocks)) throw new Error(`Unexpected import ${name}`); return mocks[name]; }
  });
  return module.exports;
}

test("force and forged dashboard header cannot authorize the product loading route", async () => {
  for (const pathname of ["/api/pipeline/products", "/api/pipeline/run"]) {
    const proxy = load("proxy.ts", {
      "next/server": { NextResponse: { next: (options: unknown) => options } },
      "@/lib/auth-session": { AUTH_COOKIE_NAME: "auth", verifySessionToken: async () => null }
    });
    const passed = await proxy.proxy({ nextUrl: { pathname }, cookies: { get: () => undefined },
      headers: new Headers({ "x-dashboard-authenticated": "1" }) });
    assert.equal(passed.request.headers.has("x-dashboard-authenticated"), false);
  }
  for (const secret of [undefined, "configured"]) {
    const route = load("app/api/pipeline/products/route.ts", {
      "next/server": { NextResponse: { json: (body: unknown, options: any) => ({ body, ...options }) } },
      "@/lib/product-loader": { loadProductsFromDriveImages: () => { throw new Error("must not run"); } },
      "@/lib/supabase-admin": { supabaseAdmin: () => { throw new Error("must not write"); } }
    }, secret ? { CRON_SECRET: secret } : {});
    const response = await route.GET({ headers: new Headers(), nextUrl: new URL("https://example.test/api/pipeline/products?force=1") });
    assert.equal(response.status, 401);
  }
});
