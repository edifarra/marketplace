import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
type ProductRow = { id: string; sku: string; title: string | null };
type StockRow = { product_id: string; estoque_fisico: number; estoque_disponivel: number };

export async function GET() {
  const db = supabaseAdmin();
  const products: ProductRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const result = await db.from("products").select("id,sku,title").order("sku").range(from, from + pageSize - 1);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
    const page = (result.data || []) as ProductRow[];
    products.push(...page);
    if (page.length < pageSize) break;
  }
  const stockByProduct = new Map<string, StockRow>();
  for (let index = 0; index < products.length; index += 500) {
    const ids = products.slice(index, index + 500).map((product) => product.id);
    const result = await db.from("estoque").select("product_id,estoque_fisico,estoque_disponivel").in("product_id", ids);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
    for (const stock of (result.data || []) as StockRow[]) stockByProduct.set(stock.product_id, stock);
  }
  const lines: unknown[][] = [["SKU", "Titulo do Produto", "Estoque Físico", "Estoque Disponível"]];
  for (const product of products) {
    const stock = stockByProduct.get(product.id);
    lines.push([product.sku, product.title || "", stock?.estoque_fisico ?? 0, stock?.estoque_disponivel ?? 0]);
  }
  const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(";")).join("\r\n")}\r\n`;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  return new NextResponse(csv, { headers: {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="relatorio-produtos-estoques-${date}.csv"`,
    "cache-control": "no-store"
  }});
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
