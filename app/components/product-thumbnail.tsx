"use client";

import { useState } from "react";
import { productImageCandidates, type ProductImageSource } from "@/lib/product-image-source";

export function ProductThumbnail({ image, alt, className, width, height }: {
  image?: ProductImageSource | null; alt: string; className?: string; width: number; height: number;
}) {
  const candidates = productImageCandidates(image);
  const [failed, setFailed] = useState<string[]>([]);
  const src = candidates.find(url => !failed.includes(url));
  if (!src) return <span className="product-thumb-placeholder" aria-label="Foto indisponível">Sem foto</span>;
  return <img className={className} src={src} alt={alt} width={width} height={height}
    onError={() => setFailed(current => [...current, src])} />;
}
