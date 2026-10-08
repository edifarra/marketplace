import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
export function loadPage(path: string, mocks: Record<string, unknown>, source?: string) {
  const module = { exports: {} as any };
  const compiled = ts.transpileModule(source ?? readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  runInNewContext(compiled, {
    module, exports: module.exports, URLSearchParams,
    require(name: string) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "react/jsx-runtime") return requireModule(name);
      if (name === "next/link") return { default: "a", __esModule: true };
      if (name === "next/image") return { default: "img", __esModule: true };
      if (name.endsWith(".module.css")) return { default: {}, __esModule: true };
      // Leaf components and action references are never executed. Test the page's
      // own React tree and props without mounting clients or submitting forms.
      if (name.startsWith(".") || name.startsWith("@/app/")) {
        return new Proxy({ __esModule: true }, { get(target, key) {
          return key === "__esModule" ? target.__esModule : `test-component:${String(key)}`;
        } });
      }
      throw new Error(`Unexpected dependency in ${path}: ${name}`);
    },
  });
  return module.exports;
}
export function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...elements(node.props.children)];
}
export function textContent(node: any): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "object") return textContent(node.props?.children);
  return String(node);
}
export type QueryCall = { table: string; method: string; args: any[] };
export function memoryDatabase(data: Record<string, any[]> = {}, count = 250) {
  const calls: QueryCall[] = [];
  return {
    calls,
    from(table: string) {
      calls.push({ table, method: "from", args: [] });
      let single = false;
      const builder: any = new Proxy({}, { get(_target, method: string) {
        if (method === "then") return (resolve: any, reject: any) => Promise.resolve({
          data: single ? data[table]?.[0] ?? null : data[table] ?? [], error: null, count,
        }).then(resolve, reject);
        return (...args: any[]) => {
          if (["insert", "update", "upsert", "delete"].includes(method)) throw new Error("Database writes forbidden in page regression tests");
          calls.push({ table, method, args });
          if (["single", "maybeSingle"].includes(method)) single = true;
          return builder;
        };
      } });
      return builder;
    },
    async rpc(name: string, input: Record<string, unknown> = {}) {
      calls.push({ table: name, method: "rpc", args: [input] });
      if (name !== "get_marketplace_conversation_page") return { data: [], error: null };
      return { data: { conversationIds: [], total: count, page: input.p_page, pageSize: input.p_page_size }, error: null };
    },
  };
}
