import { createHash } from "crypto";
import { supabaseAdmin } from "./supabase-admin";
import { readImageDimensions, validateMarketplaceImage } from "./marketplace-image-validation";

type CloudinaryUploadResult = {
  secure_url: string;
  public_id: string;
  resource_type: string;
  version?: number;
};

type CloudinaryCredentials = { cloudName: string; apiKey: string; apiSecret: string; reserve: boolean };
const CLOUDINARY_REQUEST_TIMEOUT_MS = 30_000;

type CloudinaryResource = {
  public_id: string;
  secure_url?: string;
  bytes?: number;
  created_at?: string;
  format?: string;
};

type CloudinaryResourcesResponse = {
  resources?: CloudinaryResource[];
  next_cursor?: string;
};

export type CloudinaryProductImage = {
  publicId: string;
  name: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
  format: string;
};

export async function uploadSystemImage(input: { buffer: Buffer; fileName: string; assetName: string }) {
  const { cloudName, apiKey, apiSecret } = await getCloudinarySettings();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "sistema/identidade";
  const contentHash = createHash("sha1").update(input.buffer).digest("hex").slice(0, 10);
  const publicName = `${safeCloudinaryPart(input.assetName)}_${contentHash}`;
  const paramsToSign = { folder, invalidate: "true", overwrite: "true", public_id: publicName, timestamp: String(timestamp) };
  const formData = new FormData();
  formData.set("file", new Blob([new Uint8Array(input.buffer)]), input.fileName);
  formData.set("api_key", apiKey); formData.set("timestamp", String(timestamp)); formData.set("folder", folder);
  formData.set("invalidate", "true"); formData.set("overwrite", "true"); formData.set("public_id", publicName);
  formData.set("signature", signCloudinaryParams(paramsToSign, apiSecret));
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: "POST", body: formData });
  const json = await response.json().catch(() => ({})) as Partial<CloudinaryUploadResult> & { error?: { message?: string } };
  if (!response.ok || !json.secure_url || !json.public_id) throw new Error(`Falha no upload Cloudinary: ${json.error?.message || JSON.stringify(json)}`);
  return { url: json.secure_url, publicId: json.public_id };
}

export async function uploadProductImageToCloudinary(input: {
  buffer: Buffer;
  fileName: string;
  sku: string;
  typeCode: string;
  brandCode: string;
  model: string;
  boardCode?: string;
  position: number;
}) {
  const accounts = await getCloudinaryAccounts();
  try {
    return await uploadProductImageWithAccount(input, accounts.primary);
  } catch (error) {
    if (!isCloudinaryQuotaOrBillingError(error)) throw error;
    if (!accounts.reserve) throw new Error(`${error instanceof Error ? error.message : String(error)} Conta Cloudinary reserva não configurada.`);
    console.warn("Cloudinary principal atingiu limite de uso ou cobrança; acionando a conta reserva.");
    return uploadProductImageWithAccount(input, accounts.reserve);
  }
}

async function uploadProductImageWithAccount(input: {
  buffer: Buffer; fileName: string; sku: string; typeCode: string; brandCode: string;
  model: string; boardCode?: string; position: number;
}, account: CloudinaryCredentials) {
  const { cloudName, apiKey, apiSecret } = account;
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `produtos/${safeCloudinaryPart(input.brandCode)}`;
  const cloudinaryFileName = buildCloudinaryImageName(input);
  const contentHash = createHash("sha1").update(input.buffer).digest("hex").slice(0, 10);
  const uniquePublicName = `${cloudinaryFileName}_${contentHash}`;
  const paramsToSign = {
    folder,
    invalidate: "true",
    overwrite: "true",
    public_id: uniquePublicName,
    timestamp: String(timestamp)
  };
  const signature = signCloudinaryParams(paramsToSign, apiSecret);
  const formData = new FormData();
  formData.set("file", new Blob([new Uint8Array(input.buffer)]), input.fileName);
  formData.set("api_key", apiKey);
  formData.set("timestamp", String(timestamp));
  formData.set("folder", folder);
  formData.set("invalidate", "true");
  formData.set("overwrite", "true");
  formData.set("public_id", uniquePublicName);
  formData.set("signature", signature);

  const response = await fetchWithTimeout(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: "POST", body: formData }, CLOUDINARY_REQUEST_TIMEOUT_MS, "upload");
  const json = await response.json().catch(() => ({})) as Partial<CloudinaryUploadResult> & { error?: { message?: string } };
  if (!response.ok || !json.secure_url) {
    throw new Error(`Falha no upload Cloudinary: ${json.error?.message || JSON.stringify(json)}`);
  }

  const publicId = json.public_id || `${folder}/${uniquePublicName}`;
  const delivery = await ensureCloudinaryImageWithinMarketplaceLimit(publicId, input.position, cloudName, json.version);
  const cloudinaryUrl = delivery.url;
  if (input.position === 1) {
    console.log("Imagem arquivo " + cloudinaryFileName + " link: " + cloudinaryUrl);
  }

  return {
    cloudName,
    publicId: encodeCloudinaryPublicId(cloudName, publicId),
    cloudinaryFileName,
    originalUrl: json.secure_url,
    cloudinaryUrl,
    bytes: delivery.bytes,
    width: delivery.width,
    height: delivery.height
  };
}

export async function ensureCloudinaryImageWithinMarketplaceLimit(publicId: string, position: number, knownCloudName?: string, version?: number) {
  const cloudName = knownCloudName || (await getCloudinarySettings()).cloudName;
  const normalizedPublicId = publicId.replace(/\.(jpg|jpeg|png|webp|heic|heif)$/i, "");
  const baseEffects = position === 1 ? "e_background_removal,b_white," : "";
  const transformations = [
    `${baseEffects}f_jpg,fl_lossy,q_auto:good,w_800,h_800,c_fit`,
    `${baseEffects}f_jpg,fl_lossy,q_75,w_800,h_800,c_fit`,
    `${baseEffects}f_jpg,fl_lossy,q_60,w_700,h_700,c_fit`,
    `${baseEffects}f_jpg,fl_lossy,q_50,w_600,h_600,c_fit`
  ];

  let lastBytes = 0;
  for (const transformation of transformations) {
    const versionPart = version ? `/v${version}` : "";
    const url = `https://res.cloudinary.com/${cloudName}/image/upload/${transformation}${versionPart}/${normalizedPublicId}.jpg`;
    const response = await fetchWithTimeout(url, { cache: "no-store" }, CLOUDINARY_REQUEST_TIMEOUT_MS, "transformação");
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Nao foi possivel validar a imagem processada no Cloudinary: ${response.status} ${details}`.trim());
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    lastBytes = buffer.byteLength;
    const dimensions = readImageDimensions(buffer);
    if (validateMarketplaceImage({ ...dimensions, bytes: lastBytes }).length === 0) return { url, bytes: lastBytes, ...dimensions };
  }

  throw new Error(`A imagem processada não atingiu o padrão dos marketplaces após o tratamento no Cloudinary (${formatBytes(lastBytes)}).`);
}

export async function listCloudinaryProductImages() {
  const { cloudName, apiKey, apiSecret } = await getCloudinarySettings();
  const images: CloudinaryProductImage[] = [];
  let nextCursor = "";

  do {
    const params = new URLSearchParams({
      type: "upload",
      max_results: "500"
    });

    if (nextCursor) {
      params.set("next_cursor", nextCursor);
    }

    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/resources/image?${params.toString()}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`
      },
      cache: "no-store"
    });

    const json = await response.json().catch(() => ({})) as CloudinaryResourcesResponse & { error?: { message?: string } };
    if (!response.ok) {
      throw new Error(`Falha ao listar imagens Cloudinary: ${json.error?.message || JSON.stringify(json)}`);
    }

    for (const resource of json.resources || []) {
      if (!resource.public_id || !resource.secure_url) {
        continue;
      }

      images.push({
        publicId: resource.public_id,
        name: resource.public_id.split("/").at(-1) || resource.public_id,
        url: resource.secure_url,
        sizeBytes: Number(resource.bytes || 0),
        createdAt: resource.created_at || "",
        format: resource.format || ""
      });
    }

    nextCursor = json.next_cursor || "";
  } while (nextCursor);

  return images.sort((a, b) => a.publicId.localeCompare(b.publicId));
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function buildCloudinaryImageName(input: {
  sku: string;
  typeCode: string;
  model: string;
  boardCode?: string;
  position: number;
}) {
  const sequence = String(input.position).padStart(2, "0");
  const baseParts = [
    `${safeCloudinaryPart(input.sku)}${safeCloudinaryPart(input.typeCode)}`,
    safeCloudinaryPart(input.model)
  ];

  const boardCode = safeCloudinaryPart(input.boardCode || "");
  if (boardCode) {
    baseParts.push(boardCode);
  }

  return `${baseParts.join("_")}_${sequence}`;
}

function safeCloudinaryPart(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function signCloudinaryParams(params: Record<string, string>, apiSecret: string) {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

async function getCloudinarySettings() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("key,value")
    .in("key", ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"])
    .throwOnError();

  const settings = new Map((data ?? []).map((row) => [row.key, settingToString(row.value)]));

  return {
    cloudName: requiredSetting("CLOUDINARY_CLOUD_NAME", settings.get("CLOUDINARY_CLOUD_NAME") || process.env.CLOUDINARY_CLOUD_NAME),
    apiKey: requiredSetting("CLOUDINARY_API_KEY", settings.get("CLOUDINARY_API_KEY") || process.env.CLOUDINARY_API_KEY),
    apiSecret: requiredSetting("CLOUDINARY_API_SECRET", settings.get("CLOUDINARY_API_SECRET") || process.env.CLOUDINARY_API_SECRET)
  };
}

async function getCloudinaryAccounts() {
  const keys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_CLOUD_NAME_RESERVA", "CLOUDINARY_API_KEY_RESERVA", "CLOUDINARY_API_SECRET_RESERVA"];
  const { data } = await supabaseAdmin().from("settings").select("key,value").in("key", keys).throwOnError();
  const settings = new Map((data ?? []).map(row => [row.key, settingToString(row.value)]));
  const value = (key: string) => settings.get(key) || process.env[key];
  const primary: CloudinaryCredentials = {
    cloudName: requiredSetting("CLOUDINARY_CLOUD_NAME", value("CLOUDINARY_CLOUD_NAME")),
    apiKey: requiredSetting("CLOUDINARY_API_KEY", value("CLOUDINARY_API_KEY")),
    apiSecret: requiredSetting("CLOUDINARY_API_SECRET", value("CLOUDINARY_API_SECRET")), reserve: false
  };
  const reserveValues = [value("CLOUDINARY_CLOUD_NAME_RESERVA"), value("CLOUDINARY_API_KEY_RESERVA"), value("CLOUDINARY_API_SECRET_RESERVA")];
  const reserve = reserveValues.every(Boolean) ? { cloudName: reserveValues[0]!, apiKey: reserveValues[1]!, apiSecret: reserveValues[2]!, reserve: true } : null;
  return { primary, reserve };
}

export async function deleteCloudinaryResource(publicId: string | null | undefined) {
  if (!publicId) {
    return;
  }

  const accounts = await getCloudinaryAccounts();
  const decoded = decodeCloudinaryPublicId(publicId);
  const account = [accounts.primary, accounts.reserve].find(item => item?.cloudName === decoded.cloudName) || accounts.primary;
  const { cloudName, apiKey, apiSecret } = account;
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    public_id: decoded.publicId,
    timestamp: String(timestamp)
  };
  const signature = signCloudinaryParams(paramsToSign, apiSecret);
  const formData = new FormData();
  formData.set("public_id", decoded.publicId);
  formData.set("api_key", apiKey);
  formData.set("timestamp", String(timestamp));
  formData.set("signature", signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(`Falha ao excluir imagem Cloudinary: ${JSON.stringify(json)}`);
  }
}

function encodeCloudinaryPublicId(cloudName: string, publicId: string) { return `${cloudName}::${publicId}`; }
function decodeCloudinaryPublicId(value: string) {
  const separator = value.indexOf("::");
  return separator > 0 ? { cloudName: value.slice(0, separator), publicId: value.slice(separator + 2) } : { cloudName: "", publicId: value };
}

function isCloudinaryQuotaOrBillingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|usage limit|rate limit|too many requests|credits?|billing|payment|required|upgrade|plan limit|monthly limit|over limit|limite|tarifa|cota/i.test(message);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, stage: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) throw new Error(`Cloudinary excedeu ${Math.round(timeoutMs / 1000)} segundos na etapa de ${stage}.`);
    throw error;
  } finally { clearTimeout(timer); }
}

function requiredSetting(key: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Configuracao obrigatoria ausente: ${key}. Preencha em Configuracoes > Cloudinary.`);
  }

  return value;
}

function settingToString(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : String(value);
}
