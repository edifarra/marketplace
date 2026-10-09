import { createHash } from "node:crypto";
import { isVpsImageUrl, type ProductImageSource } from "./product-image-source";

export function coverTransformationId(original: string, bytes: Uint8Array) {
  return `marketplace-covers/white-bg-v1_${createHash("sha256").update(original).update("\0").update(bytes).digest("hex")}`;
}

export function matchesCoverTransformation(url: string, id: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "res.cloudinary.com"
      && parsed.pathname.endsWith(`/${id}.jpg`);
  } catch { return false; }
}

// Legacy delivery URLs can prove the treatment when they reference the exact
// same versioned asset. This evidence does not establish a link to a VPS original.
export function matchesLegacyCoverTreatment(original: string, transformed: string) {
  function asset(value: string) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") return null;
      const parts = url.pathname.split("/image/upload/");
      if (parts.length !== 2) return null;
      const segments = parts[1].split("/");
      const effects: string[] = [];
      while (segments[0]?.includes(",") || /^[a-z]+_/.test(segments[0] || "")) {
        // A folder can contain underscores; only known transformation prefixes count.
        if (!/^(?:e_|b_|q_|f_|w_|h_|c_|a_|fl_)/.test(segments[0])) break;
        effects.push(...segments.shift()!.split(","));
      }
      return { asset: `${parts[0]}/${segments.join("/")}`, effects };
    } catch { return null; }
  }
  const source = asset(original), cover = asset(transformed);
  return Boolean(source && cover && source.asset === cover.asset
    && (original === transformed || /\/v\d+\//.test(source.asset))
    && cover.effects.includes("e_background_removal") && cover.effects.includes("b_white"));
}

export async function prepareProductMarketplaceImages<T extends ProductImageSource>(images: T[], deps: {
  download: (url: string) => Promise<Uint8Array>;
  available: (url: string) => Promise<boolean>;
  transform: (bytes: Uint8Array, id: string) => Promise<string>;
  persist: (image: T, transformed: string) => Promise<void>;
}) {
  const ordered = [...images].sort((a, b) => Number(a.position) - Number(b.position)).slice(0, 6);
  if (!ordered.length || ordered[0].position !== 1 || new Set(ordered.map(i => i.position)).size !== ordered.length) {
    throw new Error("Envio bloqueado: configure a Foto 1 e posições únicas das fotos.");
  }
  const sources = ordered.map(image => isVpsImageUrl(image.url) ? image.url : isVpsImageUrl(image.local_url) ? image.local_url : image.url || image.local_url || image.cloudinary_url || "");
  for (const [index, source] of sources.entries()) {
    if (!await deps.available(source)) throw new Error(`Envio bloqueado: original da Foto ${ordered[index].position} indisponível.`);
  }
  const legacyCover = ordered[0].cloudinary_url || sources[0];
  if (!isVpsImageUrl(sources[0]) && matchesLegacyCoverTreatment(sources[0], legacyCover)) {
    if (!await deps.available(legacyCover)) throw new Error("Envio bloqueado: transformação da Foto 1 indisponível.");
    return [legacyCover, ...sources.slice(1)];
  }
  const bytes = await deps.download(sources[0]);
  const id = coverTransformationId(sources[0], bytes);
  let cover = ordered[0].cloudinary_url || "";
  if (matchesCoverTransformation(cover, id)) {
    if (!await deps.available(cover)) throw new Error("Envio bloqueado: transformação da Foto 1 indisponível.");
  } else {
    try {
      cover = await deps.transform(bytes, id);
      if (!matchesCoverTransformation(cover, id) || !await deps.available(cover)) throw new Error("Transformação inválida ou indisponível.");
      await deps.persist(ordered[0], cover);
    } catch (error) {
      throw new Error(`Envio bloqueado: não foi possível remover o fundo e aplicar branco à Foto 1. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [cover, ...sources.slice(1)];
}
