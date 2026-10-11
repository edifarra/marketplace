import { loadEnvConfig } from "@next/env";
import fs from "node:fs";
import { supabaseAdmin } from "../lib/supabase-admin";
import { linkMercadoLivreConversationOrder, localMercadoLivreOrderForPack } from "../lib/mercado-livre-pack-resolution";

loadEnvConfig(process.cwd());

async function main() {
  const apply = process.argv.includes("--apply");
  const reportPath = process.argv.find(arg => arg.startsWith("--report="))?.slice(9);
  if (!reportPath) throw new Error("Informe --report=<arquivo.json> para registrar a auditoria (somente leitura por padrão).");
  // Reserve the report before any mutation; append each outcome immediately.
  fs.writeFileSync(reportPath, JSON.stringify({ startedAt: new Date().toISOString(), apply }) + "\n", { flag: "wx" });
  const db = supabaseAdmin();
  let cursor = "";
  let checked = 0;
  let unique = 0;
  while (true) {
    let query = db.from("marketplace_conversations").select("id,marketplace_account_id,pack_id")
      .eq("marketplace", "mercado_livre").eq("conversation_type", "post_sale")
      .is("order_id", null).not("pack_id", "is", null).order("id").limit(100);
    if (cursor) query = query.gt("id", cursor);
    const { data } = await query.throwOnError();
    if (!data?.length) break;
    for (const conversation of data) {
      const local = await localMercadoLivreOrderForPack(db, conversation.marketplace_account_id, conversation.pack_id);
      const entry = { at: new Date().toISOString(), ...conversation, before: null, ...local };
      fs.appendFileSync(reportPath, JSON.stringify({ phase: "validated", ...entry }) + "\n");
      let applied = false;
      if (apply && local.orderId) {
        const result = await linkMercadoLivreConversationOrder(db, conversation, local.orderId);
        applied = !!result.data?.length;
      }
      fs.appendFileSync(reportPath, JSON.stringify({ phase: "result", ...entry, applied }) + "\n");
      checked += 1;
      if (local.orderId) unique += 1;
    }
    cursor = data.at(-1)!.id;
  }
  console.log(JSON.stringify({ apply, checked, unique, reportPath }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
