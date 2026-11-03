import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { elements, loadPage } from "./helpers/page-harness";
import { mergeRecoveredImages } from "../lib/product-image-source";

test("visual removal then leaving without saving neither submits nor requests physical deletion", async () => {
  const states: any[] = [], effects: Array<() => void> = [];
  let cursor = 0, submissions = 0, requests = 0;
  const listeners: Record<string, (event: any) => void> = {};
  const window = { location: { href: "/produtos/p1" }, addEventListener(name: string, fn: any) { listeners[name] = fn; }, removeEventListener() {} };
  const document = { addEventListener(name: string, fn: any) { listeners[name] = fn; }, removeEventListener() {} };
  const source = readFileSync("app/produtos/[id]/product-editor.tsx", "utf8");
  const module = loadPage("app/produtos/[id]/product-editor.tsx", {
    react: {
      useRef: (current: any) => ({ current }),
      useEffect: (fn: () => void) => { effects.push(fn); },
      useState(initial: any) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (next: any) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      }
    },
    "../actions": { updateProductDetailsAction: () => { submissions++; } },
    "@/lib/product-image-source": { mergeRecoveredImages },
    runtime: { window, document, fetch: () => { requests++; throw Error("No request expected"); } }
  }, 'const { window, document, fetch } = require("runtime");\n' + source);
  const props = { product: { id: "p1", title: "Board", sku: "SKU", type_code: "PP", brand_code: "BR", model: "Model" }, types: [], brands: [], specials: [],
    images: [{ id: "old", name: "old.jpg", url: "https://vps.test/old.jpg", position: 1, bytes: 100, width: 800, height: 800 },
      { id: "kept", name: "kept.jpg", url: "https://vps.test/kept.jpg", position: 2, bytes: 100, width: 800, height: 800 }],
    temporaryImages: null, categoryMappings: [], marketplaceLinks: { mercado_livre: false, shopee: false }, returnTo: "/produtos", actionReturnTo: "/produtos/p1", showSend: false };
  function render() { cursor = 0; effects.length = 0; const tree = module.ProductEditor(props); effects.forEach(fn => fn()); return elements(tree); }
  let tree = render();
  tree.find(node => node.props["aria-label"] === "Excluir old.jpg")!.props.onClick();
  tree = render();
  assert.equal(tree.find(node => node.props.name === "imageOrder")!.props.value, "existing:kept");
  listeners.click({ button: 0, defaultPrevented: false, preventDefault() {}, target: { closest: () => ({ target: "", href: "/produtos", getAttribute: () => "/produtos" }) } });
  tree = render();
  tree.find(node => node.type === "button" && node.props.children === "Não")!.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(window.location.href, "/produtos");
  assert.equal(submissions, 0); assert.equal(requests, 0);
  assert.equal(props.images.length, 2);
});
