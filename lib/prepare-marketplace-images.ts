import { supabaseAdmin } from "./supabase-admin";
import { uploadMarketplaceCover } from "./cloudinary";
import { prepareProductMarketplaceImages } from "./product-marketplace-images";
import { imageIsAvailable } from "./product-image-source";

export async function prepareMarketplaceImages(productId: string) {
  const db = supabaseAdmin();
  const result = await db.from("product_images").select("id,url,local_url,cloudinary_url,position")
    .eq("product_id", productId).order("position").throwOnError();
  return prepareProductMarketplaceImages(result.data || [], {
    available: imageIsAvailable,
    download: async url => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok || Number(response.headers.get("content-length")) > 8 * 1024 * 1024) throw new Error("Original da Foto 1 indisponível ou maior que 8 MB.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Original da Foto 1 maior que 8 MB.");
      return bytes;
    },
    transform: uploadMarketplaceCover,
    persist: async (image, cloudinaryUrl) => {
      let update = db.from("product_images").update({ cloudinary_url: cloudinaryUrl,
        ...(!image.url && !image.local_url ? { url: image.cloudinary_url } : {}) }).eq("id", image.id).eq("position", 1);
      update = image.url == null ? update.is("url", null) : update.eq("url", image.url);
      update = image.local_url == null ? update.is("local_url", null) : update.eq("local_url", image.local_url);
      update = image.cloudinary_url == null ? update.is("cloudinary_url", null) : update.eq("cloudinary_url", image.cloudinary_url);
      const saved = await update.select("id").throwOnError();
      if (saved.data?.length !== 1) throw new Error("A Foto 1 mudou durante o tratamento. Tente novamente.");
    }
  });
}
