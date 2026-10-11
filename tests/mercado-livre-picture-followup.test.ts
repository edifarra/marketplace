import assert from "node:assert/strict";
import test from "node:test";
import { processOutgoingActivities } from "../lib/outgoing-activities";
import { ML_PHOTO_PENDING_MESSAGE, nextMercadoLivrePhotoCheck, compareMercadoLivrePictures } from "../lib/mercado-livre-picture-confirmation";

const sources = ["https://res.cloudinary.com/demo/image/upload/e_background_removal,b_white/v1/cover.jpg", ...[2,3,4].map(n => "https://cdn.example/" + n + ".jpg")];
const ready = sources.map((_, i) => ({ id: "PIC-" + i, secure_url: "https://ml.example/" + i + ".jpg" }));
const pending = ready.map(p => ({ ...p, secure_url: "https://ml.example/processing-image/O-PT.jpg" }));

async function fixture(run: (f: { rows: any[]; calls: Array<{url: URL; method: string}>; process: () => Promise<any>; setPhotos: (v: any) => void; reject: (status: number) => void }) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-key";
  const rows: any[] = [{ id: "activity-1", destination: "mercado_livre", activity_type: "listing_update", status: "queued", attempt_count: 0,
    product_id: "product-1", sku: "818PFD", marketplace_account_id: "account-1", listing_id: "MLB5133589853",
    requested_data: { payload: { pictures: sources.map(source => ({ source })) } } }];
  const calls: Array<{url: URL; method: string}> = [];
  let photos: any = pending, rejection = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method || "GET";
    calls.push({url, method});
    const json = (value: unknown, status=200) => new Response(JSON.stringify(value), {status, headers: {"content-type":"application/json"}});
    if (url.hostname === "test.supabase.co") {
      if (url.pathname.endsWith("/rpc/claim_outgoing_marketplace_activity_queue")) {
        assert.equal(JSON.parse(String(init?.body)).p_include_photos, true);
        const claimed = rows.filter(r => ["queued","retry"].includes(r.status) || r.status === "completed" && r.photo_next_at);
        for (const row of claimed) { if (row.status !== "completed") { row.status="processing"; row.attempt_count++; } else row.photo_lease_at = new Date().toISOString(); }
        return json(structuredClone(claimed));
      }
      if (url.pathname.endsWith("/rpc/requeue_outgoing_marketplace_activity")) {
        const body = JSON.parse(String(init?.body)); const row = rows.find(r => r.id===body.p_id);
        row.status = row.attempt_count >= 5 ? "error" : "retry"; row.processing_error = body.p_error;
        return json(null);
      }
      if (url.pathname.endsWith("/config_marketplace_accounts")) return json({id:url.searchParams.get("id")?.slice(3),access_token:"token",token_expires_at:"2099-01-01"});
      if (url.pathname.endsWith("/product_images")) return json(sources.map((url,i) => ({id: "img-"+i,url,cloudinary_url: i===0 ? url : null,position:i+1})));
      if (url.pathname.endsWith("/outgoing_marketplace_activities") && method==="PATCH") {
        const id = url.searchParams.get("id")?.slice(3); const row=rows.find(r => r.id===id);
        Object.assign(row,JSON.parse(String(init?.body))); return json(null);
      }
      return json(null);
    }
    if (url.hostname === "api.mercadolibre.com") {
      if (rejection && method==="PUT") return json({error:"rejected"},rejection);
      if (photos instanceof Error && method==="GET") return json({error:photos.message},503);
      const id=url.pathname.split("/").pop();
      return json({id,status:"active",title:"Produto",price:12,pictures:photos});
    }
    if (method === "HEAD") return new Response(null,{headers:{"content-type":"image/jpeg"}});
    throw new Error("Unexpected request: " + method + " " + url);
  };
  try { await run({rows,calls,process:()=>processOutgoingActivities(10),setPhotos:v=>{photos=v;},reject:s=>{rejection=s;}}); }
  finally { globalThis.fetch=originalFetch; if(originalUrl===undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL=originalUrl;
    if(originalKey===undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY=originalKey; }
}

test("200 com quatro fotos pendentes conclui atualizacao sem GET imediato e agenda 30s", async () => fixture(async f => {
  assert.equal((await f.process()).completed,1);
  assert.equal(f.rows[0].status,"completed"); assert.equal(f.rows[0].confirmed_data.pictureConfirmation.processingPending,true);
  assert.equal(f.rows[0].photo_next_at,nextMercadoLivrePhotoCheck(f.rows[0].photo_confirmation.acceptedAt,0));
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.mercadolibre.com" && c.method==="GET").length,0);
  assert.equal(ML_PHOTO_PENDING_MESSAGE,"Produto atualizado com sucesso. Fotos ainda em processamento pelo Mercado Livre.");
}));
test("200 com fotos prontas nao agenda consultas", async () => fixture(async f => {
  f.setPhotos(ready); await f.process(); assert.equal(f.rows[0].photo_next_at,null);
  assert.equal(f.rows[0].confirmed_data.pictureConfirmation.processingPending,false);
}));
test("confirmacao na primeira consulta encerra e nunca repete PUT", async () => fixture(async f => {
  await f.process(); f.setPhotos(ready); await f.process(); await f.process();
  assert.equal(f.rows[0].photo_confirmation.state,"confirmed"); assert.equal(f.rows[0].photo_next_at,null);
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.mercadolibre.com" && c.method==="PUT").length,1);
}));
test("pendencia atravessa cinco prazos absolutos, reinicios e encerra apos seis horas", async () => fixture(async f => {
  await f.process(); const accepted=f.rows[0].photo_confirmation.acceptedAt;
  for(let i=0;i<5;i++) {
    // Round-trip persisted state, as a restarted worker reads a fresh claimed snapshot.
    f.rows[0]=JSON.parse(JSON.stringify(f.rows[0])); await f.process();
    assert.equal(f.rows[0].photo_next_at,nextMercadoLivrePhotoCheck(accepted,i+1));
  }
  assert.equal(f.rows[0].photo_confirmation.state,"unconfirmed"); assert.equal(f.rows[0].status,"completed");
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.mercadolibre.com" && c.method==="GET").length,5);
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.mercadolibre.com" && c.method==="PUT").length,1);
}));
test("GET 503 avanca ao proximo prazo sem reenviar ou reabrir erro", async () => fixture(async f => {
  await f.process(); f.setPhotos(new Error("temporario")); await f.process();
  assert.equal(f.rows[0].photo_confirmation.checks,1); assert.equal(f.rows[0].status,"completed");
  assert.equal(f.rows[0].photo_next_at,nextMercadoLivrePhotoCheck(f.rows[0].photo_confirmation.acceptedAt,1));
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.mercadolibre.com" && c.method==="PUT").length,1);
}));
for (const status of [400,200]) test("rejeicao real do PUT preservada: HTTP "+status, async () => fixture(async f => {
  f.reject(status); const result=await f.process(); assert.equal(result.failed,1);
  assert.equal(f.rows[0].status,"retry"); assert.equal(f.rows[0].photo_next_at,undefined);
}));
test("mesmo SKU em duas contas acompanha anuncios independentemente", async () => fixture(async f => {
  f.rows.push({...structuredClone(f.rows[0]),id:"activity-2",listing_id:"MLB5133589829",marketplace_account_id:"account-2"});
  await f.process(); f.setPhotos(ready); await f.process();
  assert.ok(f.rows.every(r=>r.photo_confirmation.state==="confirmed"));
  assert.equal(new Set(f.calls.filter(c=>c.method==="GET" && c.url.hostname==="api.mercadolibre.com").map(c=>c.url.pathname)).size,2);
}));
test("mesma quantidade com IDs distintos ou sem identidade nao confirma", () => {
  assert.equal(compareMercadoLivrePictures(sources,ready,ready.map(p=>({...p,id:p.id+"old"}))).matches,false);
  assert.equal(compareMercadoLivrePictures(sources,[],ready).matches,false);
});
test("offsets sao exclusivos e contados da aceitacao", () => {
  const at="2026-10-09T12:00:00.000Z";
  assert.deepEqual([0,1,2,3,4].map(i=>Date.parse(nextMercadoLivrePhotoCheck(at,i)!)-Date.parse(at)),[30000,120000,600000,3600000,21600000]);
});

test("atualizacao ML sem fotos conserva GET de confirmacao e nao cria acompanhamento", async () => fixture(async f => {
  f.rows[0].requested_data={payload:{price:12}}; await f.process();
  assert.equal(f.rows[0].status,"completed"); assert.equal(f.rows[0].photo_confirmation,undefined);
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.mercadolibre.com" && c.method==="GET").length,1);
}));
test("IDs duplicados nao comprovam quatro fotografias", () => {
  const duplicated = sources.map(()=>ready[0]);
  assert.equal(compareMercadoLivrePictures(sources,duplicated,duplicated).matches,false);
});

test("retomada apos PUT aceito reutiliza checkpoint sem preparar ou reenviar fotos", async () => fixture(async f => {
  await f.process(); const accepted=f.rows[0].photo_confirmation.acceptedAt;
  f.rows[0].status="retry"; const before=f.calls.length; await f.process();
  assert.equal(f.rows[0].photo_confirmation.acceptedAt,accepted);
  assert.equal(f.calls.slice(before).filter(c=>c.method==="HEAD" || c.method==="PUT" || c.url.pathname.endsWith("/product_images")).length,0);
  assert.equal(f.rows[0].status,"completed");
}));
test("IDs sem URLs finais continuam pendentes", async () => fixture(async f => {
  f.setPhotos(ready.map(p=>({id:p.id}))); await f.process();
  assert.equal(f.rows[0].confirmed_data.pictureConfirmation.processingPending,true);
}));
