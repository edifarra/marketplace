export type ProductImageSource = { url?: string | null; local_url?: string | null; cloudinary_url?: string | null; position?: number };

export function isVpsImageUrl(value: unknown): value is string {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "api.gestaomarketplace.tech" && url.pathname.startsWith("/Imagens/");
  } catch { return false; }
}

export function productImageUrl(image?: ProductImageSource | null): string {
  if (!image) return "";
  if (isVpsImageUrl(image.url)) return image.url;
  if (isVpsImageUrl(image.local_url)) return image.local_url;
  return image.cloudinary_url || image.url || image.local_url || "";
}

export function productImageCandidates(image?: ProductImageSource | null): string[] {
  if (!image) return [];
  return [...new Set([productImageUrl(image), image.url, image.local_url, image.cloudinary_url]
    .filter((url): url is string => Boolean(url) && (/^https?:\/\//i.test(url!) || url!.startsWith("/uploads/"))))];
}

export function mergeRecoveredImages<T extends { position: number }, R extends { position: number }>(originals: T[], recovered: R[]): Array<T | R> {
  if (!originals.length) return [...recovered].sort((a, b) => a.position - b.position);
  const replacements = new Map(recovered.map(image => [image.position, image]));
  return [...originals].sort((a, b) => a.position - b.position).map(image => replacements.get(image.position) || image);
}

export async function imageIsAvailable(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (response.status === 405) {
      const get = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const ok = get.ok && Boolean(get.headers.get("content-type")?.startsWith("image/"));
      await get.body?.cancel();
      return ok;
    }
    return response.ok && Boolean(response.headers.get("content-type")?.startsWith("image/"));
  } catch { return false; }
}

export function activityNeedsProductImages(activity: { destination: string; activity_type: string; requested_data?: Record<string, any> }): boolean {
  return ["mercado_livre", "shopee"].includes(activity.destination)
    && (activity.activity_type === "listing_create" || (activity.activity_type === "listing_update"
      && (Array.isArray(activity.requested_data?.imageUrls) || Array.isArray(activity.requested_data?.payload?.pictures))));
}

export async function prepareActivityImageRequest(activity: {
  destination: string; activity_type: string; product_id?: string | null; requested_data?: Record<string, any>;
}, prepare: (productId: string) => Promise<string[]>) {
  if (!activityNeedsProductImages(activity)) return activity.requested_data;
  if (!activity.product_id) throw new Error("Envio de fotos bloqueado: atividade sem produto associado.");
  const urls = await prepare(activity.product_id);
  return activity.destination === "mercado_livre"
    ? { ...activity.requested_data, payload: { ...activity.requested_data?.payload, pictures: urls.map(source => ({ source })) } }
    : { ...activity.requested_data, imageUrls: urls };
}
