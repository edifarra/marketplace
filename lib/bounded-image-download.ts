export async function readBoundedImage(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Falha ao baixar fotografia: HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Fotografia excede o limite de bytes.");
  }
  if (!response.body) throw new Error("Fotografia sem conteúdo.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Fotografia excede o limite de bytes.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
