export const MARKETPLACE_IMAGE_MIN_PX = 500;
export const MARKETPLACE_IMAGE_MAX_PX = 1920;
export const MARKETPLACE_IMAGE_MAX_BYTES = 2_000_000;

export type MarketplaceImageMetadata = { width: number; height: number; bytes: number };

export function validateMarketplaceImage(metadata: Partial<MarketplaceImageMetadata>) {
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const bytes = Number(metadata.bytes || 0);
  const errors: string[] = [];
  if (!width || !height) errors.push("Não foi possível identificar as dimensões da foto.");
  else {
    if (width < MARKETPLACE_IMAGE_MIN_PX && height < MARKETPLACE_IMAGE_MIN_PX) errors.push(`Tamanho mínimo: pelo menos um dos lados deve ter ${MARKETPLACE_IMAGE_MIN_PX} px.`);
    if (width > MARKETPLACE_IMAGE_MAX_PX || height > MARKETPLACE_IMAGE_MAX_PX) errors.push(`Dimensão máxima: ${MARKETPLACE_IMAGE_MAX_PX} × ${MARKETPLACE_IMAGE_MAX_PX} px.`);
  }
  if (!bytes) errors.push("Não foi possível identificar o tamanho do arquivo.");
  else if (bytes > MARKETPLACE_IMAGE_MAX_BYTES) errors.push("Tamanho máximo: 2 MB.");
  return errors;
}

export function readImageDimensions(buffer: Uint8Array) {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: readU32BE(buffer, 16), height: readU32BE(buffer, 20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer[6] | (buffer[7] << 8), height: buffer[8] | (buffer[9] << 8) };
  }
  if (buffer.length >= 30 && ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP") {
    const kind = ascii(buffer, 12, 4);
    if (kind === "VP8X") return { width: 1 + readU24LE(buffer, 24), height: 1 + readU24LE(buffer, 27) };
    if (kind === "VP8L") {
      const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (length < 2) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        return { height: (buffer[offset + 5] << 8) | buffer[offset + 6], width: (buffer[offset + 7] << 8) | buffer[offset + 8] };
      }
      offset += length + 2;
    }
  }
  return { width: 0, height: 0 };
}

function readU32BE(buffer: Uint8Array, offset: number) { return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0; }
function readU24LE(buffer: Uint8Array, offset: number) { return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16); }
function ascii(buffer: Uint8Array, offset: number, length: number) { return String.fromCharCode(...buffer.slice(offset, offset + length)); }
