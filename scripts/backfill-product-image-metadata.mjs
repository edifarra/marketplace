import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data, error } = await db.from("product_images").select("id,cloudinary_url,url,bytes,width_px,height_px").or("width_px.is.null,height_px.is.null,bytes.is.null");
if (error) throw error;
let updated = 0;
let failed = 0;
for (const [groupIndex, group] of batches(data || [], 20).entries()) {
  await Promise.all(group.map(async image => {
    try {
      const response = await fetch(image.cloudinary_url || image.url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const dimensions = readImageDimensions(buffer);
      if (!dimensions.width || !dimensions.height) throw new Error("dimensões não identificadas");
      const result = await db.from("product_images").update({ bytes: buffer.byteLength, width_px: dimensions.width, height_px: dimensions.height }).eq("id", image.id);
      if (result.error) throw result.error;
      updated++;
    } catch (error) {
      failed++;
      console.error(`${image.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  console.log(JSON.stringify({ progress: Math.min((groupIndex + 1) * 20, data?.length || 0), total: data?.length || 0, updated, failed }));
}
console.log(JSON.stringify({ total: data?.length || 0, updated, failed }));
if (failed) process.exitCode = 1;

function batches(items, size) { const result = []; for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size)); return result; }
function readImageDimensions(buffer) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { width: u32(buffer, 16), height: u32(buffer, 20) };
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return { width: buffer[6] | buffer[7] << 8, height: buffer[8] | buffer[9] << 8 };
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) { let offset = 2; while (offset + 8 < buffer.length) { if (buffer[offset] !== 0xff) { offset++; continue; } const marker = buffer[offset + 1]; const length = buffer[offset + 2] << 8 | buffer[offset + 3]; if (length < 2) break; if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { height: buffer[offset + 5] << 8 | buffer[offset + 6], width: buffer[offset + 7] << 8 | buffer[offset + 8] }; offset += length + 2; } }
  return { width: 0, height: 0 };
}
function u32(buffer, offset) { return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0; }
