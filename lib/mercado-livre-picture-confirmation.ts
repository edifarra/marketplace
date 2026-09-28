export type MercadoLivrePicture = {
  id?: string | null;
  source?: string | null;
  url?: string | null;
  secure_url?: string | null;
  status?: string | null;
};

export function requestedMercadoLivrePictureSources(payload: Record<string, any>) {
  if (!Array.isArray(payload.pictures)) return [];
  return payload.pictures.map((picture: Record<string, unknown>) => String(picture?.source || "").trim());
}

export function summarizeMercadoLivrePictures(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((picture: MercadoLivrePicture, index) => ({
    position: index + 1,
    id: picture?.id ? String(picture.id) : null,
    source: picture?.source ? String(picture.source) : null,
    url: picture?.secure_url ? String(picture.secure_url) : picture?.url ? String(picture.url) : null,
    status: picture?.status ? String(picture.status) : null,
  }));
}

export function hasProcessingMercadoLivrePictures(value: unknown) {
  return summarizeMercadoLivrePictures(value).some((picture) =>
    String(picture.status || "").toLowerCase().includes("process")
    || String(picture.url || "").toLowerCase().includes("processing-image"));
}

export function compareMercadoLivrePictures(
  requestedSources: string[],
  updatePicturesValue: unknown,
  finalPicturesValue: unknown,
) {
  const updatePictures = summarizeMercadoLivrePictures(updatePicturesValue);
  const finalPictures = summarizeMercadoLivrePictures(finalPicturesValue);
  const finalIds = new Set(finalPictures.map((picture) => picture.id).filter(Boolean));
  const missingPositions = requestedSources.flatMap((source, index) => {
    const updatePicture = updatePictures[index];
    const existsInFinal = updatePicture?.id
      ? finalIds.has(updatePicture.id)
      : index < finalPictures.length;
    return existsInFinal ? [] : [{ position: index + 1, source }];
  });

  return {
    expectedCount: requestedSources.length,
    updateCount: updatePictures.length,
    finalCount: finalPictures.length,
    requestedSources,
    updatePictures,
    finalPictures,
    missingPositions,
    matches: finalPictures.length === requestedSources.length && missingPositions.length === 0,
  };
}
