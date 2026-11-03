import type { SupabaseClient } from "@supabase/supabase-js";
import { photoDigest, VPS_IMAGE_ORIGIN } from "./drive-photo-processing";
import { deleteVpsImage } from "./vps-image-storage";

type Image = { id: string; position: number; url?: string | null; local_url?: string | null; cloudinary_url?: string | null };

export function ownedImagePath(url: string | null | undefined, productId: string, sourceKey?: string | null) {
  if (!url?.startsWith(VPS_IMAGE_ORIGIN)) return null;
  const relative = url.slice(VPS_IMAGE_ORIGIN.length);
  const match = relative.match(/^produtos\/([a-f0-9]{2})\/([a-f0-9]{64})\/[1-6]-[a-f0-9]{64}\.jpg$/);
  if (!match || match[1] !== match[2].slice(0, 2)) return null;
  const sources = ["product-edit:" + productId, ...(sourceKey ? [sourceKey] : [])];
  return sources.some(source => photoDigest(Buffer.from(source)) === match[2]) ? relative : null;
}

// Best-effort post-save cleanup; intentionally no background/retroactive sweep.
// The reference check and SFTP unlink are separate: this does not serialize writers.
export async function cleanupRemovedProductImages(input: {
  db: SupabaseClient; productId: string; sourceKey?: string | null;
  previous: Image[]; final: Array<{ id: string; position: number }>;
}, remove: (relativePath: string) => Promise<void> = deleteVpsImage) {
  const { db, productId, previous, final } = input;
  const removed = previous.filter(image => !final.some(row => row.id === image.id));
  if (!removed.length) return;
  const confirmed = await db.from("product_images").select("id,position").eq("product_id", productId).throwOnError();
  if (!confirmed.data || confirmed.data.length !== final.length || final.some(row => !confirmed.data.some(image => image.id === row.id && image.position === row.position))) {
    throw new Error("Limpeza de fotos bloqueada: o conjunto confirmado no Supabase difere do salvamento.");
  }
  const paths = new Set(removed.flatMap(image => [image.url, image.local_url].map(url => ownedImagePath(url, productId, input.sourceKey)).filter((value): value is string => Boolean(value))));
  const failures: string[] = [];
  for (const relative of paths) {
    try {
      const url = VPS_IMAGE_ORIGIN + relative;
      // Include this product too: a concurrent save may have linked it again.
      const references = await db.from("product_images").select("id").or(`url.eq.${url},local_url.eq.${url},cloudinary_url.eq.${url},local_path.eq.${relative}`).limit(1).throwOnError();
      if (!references.data) throw new Error("Consulta de vínculos sem confirmação.");
      if (references.data.length) continue;
      await remove(relative);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("product-image-cleanup failed", { productId, path: relative, error: message });
      failures.push(`${relative}: ${message}`);
    }
  }
  if (failures.length) throw new Error(`As fotos foram salvas, mas a limpeza na VPS falhou: ${failures.join("; ")}`);
}
