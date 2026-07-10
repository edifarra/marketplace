import { BrandConfig, BuiltProduct, PhotoNameParts, SpecialConfig, TypeConfig } from "./types";

const VALID_IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|webp|heic|heif)$/i;

function removeKnownImageExtension(fileName: string) {
  return fileName.replace(VALID_IMAGE_EXTENSIONS, "");
}

export function isValidPhotoName(fileName: string) {
  const baseName = removeKnownImageExtension(fileName).trim();
  console.log("Entrou no IsValidPhotoName ", fileName);
  return /^[A-Za-z0-9]{4,5}_.{3,}_(0?[1-6])$/.test(baseName);
}

export function parsePhotoName(fileName: string): PhotoNameParts {
  const baseName = removeKnownImageExtension(fileName).trim();
  if (!/^[A-Za-z0-9]{4,5}_.{3,}_(0?[1-6])$/.test(baseName)) {
    throw new Error(`Nome de foto invalido: ${fileName}`);
  }

  const parts = baseName.split("_");
  const firstBlock = parts[0];
  const photoNumber = Number(parts[parts.length - 1]);
  const middleBlocks = parts.slice(1, -1);
  const [typeCode, brandCode, prefixSpecialCode] = splitPrefix(firstBlock);
  const tailTokens = middleBlocks.slice(2).flatMap((block) => block.split("-")).filter(Boolean);
  const specialCandidate = tailTokens.at(-1);
  const hasSpecial = !!specialCandidate && specialCandidate.length <= 3 && specialCandidate === specialCandidate.toUpperCase();
  const versionTokens = hasSpecial ? tailTokens.slice(0, -1) : tailTokens;

  return {
    sourceKey: `${firstBlock}_${middleBlocks.join("_")}`,
    typeCode,
    brandCode,
    model: middleBlocks[0] || "",
    version: versionTokens.join("-") || undefined,
    boardCode: middleBlocks[1],
    specialCode: prefixSpecialCode || (hasSpecial ? specialCandidate : undefined),
    photoNumber
  };
}

export function groupPhotos(fileNames: string[]) {
  const groups = new Map<string, string[]>();
  console.log ("Entrou no agrupador de Fotos")
  for (const fileName of fileNames.filter(isValidPhotoName)) {
    const parts = parsePhotoName(fileName);
    const current = groups.get(parts.sourceKey) || [];
    console.log("Entrou nno GroupPhotos - Current", current);
    console.log("Entrou nno GroupPhotos - Parts", parts);
    current.push(fileName);
    groups.set(parts.sourceKey, current);
  }

  return [...groups.entries()].map(([sourceKey, photos]) => ({
    sourceKey,
    photos: photos.sort((a, b) => parsePhotoName(a).photoNumber - parsePhotoName(b).photoNumber)
  }));
}

export function applyTemplate(template: string, data: Record<string, string | undefined>) {
  let text = String(template || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  for (const key of ["tipo", "marca", "especial", "modelo", "versao", "codigo", "sku", "nome_produto_completo"]) {
    const value = data[key] || "";
    const block = new RegExp(`<${key}>[\\s\\S]*?<\\/${key}>`, "gi");
    text = value ? text.replace(new RegExp(`<\\/?${key}>`, "gi"), "") : text.replace(block, "");
  }

  const replacements: Record<string, string> = {
    TIPO: data.tipo || "",
    MARCA: data.marca || "",
    ESPECIAL: data.especial || "",
    MODELO: data.modelo || "",
    VERSAO: data.versao || "",
    CODIGO: data.codigo || "",
    SKU: data.sku || "",
    NOME_PRODUTO_COMPLETO: data.nome_produto_completo || ""
  };

  for (const [key, value] of Object.entries(replacements)) {
    text = text.replace(new RegExp(`\\[${key}\\]`, "gi"), value);
  }
  console.log("saindo da Função applyTemplate. Retornando : ", text);
  return text.replace(/\s+/g, " ").replace(/\/\s*$/g, "").trim();
}

export function nextSku(type: TypeConfig, currentNumber: number, specialCode?: string) {
  const nextNumber = currentNumber + 1;
  const specialSuffix = String(specialCode || "").trim().toUpperCase();
  return {
    sku: `${nextNumber}${type.code.slice(0, 2).toUpperCase()}${specialSuffix}`,
    nextNumber
  };
}

export function buildProduct(input: {
  photos: string[];
  type: TypeConfig;
  brand: BrandConfig;
  special?: SpecialConfig;
  currentSkuNumber: number;
  price: number;
  initialStock: number;
}): BuiltProduct {
  if (input.photos.length === 0) {
    throw new Error("Produto sem fotos.");
  }
  console.log("Entrou no buildProdut");
  const main = parsePhotoName(input.photos[0]);
  if (main.photoNumber !== 1) {
    throw new Error("Produto sem foto principal _01.");
  }

  const skuInfo = nextSku(input.type, input.currentSkuNumber, main.specialCode);
  console.log("SKU Info ", skuInfo);
  const title = applyTemplate(input.type.titleTemplate, {
    tipo: input.type.description,
    marca: input.brand.includeInTitle ? input.brand.name : "",
    modelo: main.model,
    versao: main.version,
    codigo: main.boardCode,
    especial: input.special?.includeDescription || "",
    sku: skuInfo.sku
  });
  console.log("Formou o titulo, ", title);
  let description = applyTemplate(input.type.descriptionTemplate, {
    nome_produto_completo: title,
    tipo: input.type.description,
    marca: input.brand.name,
    modelo: main.model,
    versao: main.version,
    codigo: main.boardCode,
    especial: input.special?.includeDescription || "",
    sku: skuInfo.sku
  });
  console.log("formou descrição", description);
  if (input.special?.removeDescription) {
    description = description.replace(input.special.removeDescription, "");
  }

  return {
    sku: skuInfo.sku,
    sourceKey: main.sourceKey,
    title,
    description,
    typeCode: main.typeCode,
    brandCode: main.brandCode,
    specialCode: main.specialCode,
    model: main.model,
    version: main.version,
    boardCode: main.boardCode,
    price: Math.max(input.price, 20),
    stock: input.initialStock,
    imageNames: input.photos.slice(0, 6)
  };
}

function splitPrefix(prefix: string) {
  if (prefix.length <= 4) {
    return [prefix.slice(0, 2), prefix.slice(2), undefined] as const;
  }

  return [prefix.slice(0, 2), prefix.slice(2, 4), prefix.slice(4) || undefined] as const;
}
