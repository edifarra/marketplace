import { createHash } from "crypto";
import { saveProcessedProductImage } from "./local-images";
import { supabaseAdmin } from "./supabase-admin";

type CloudinaryUploadResult = {
  secure_url: string;
  public_id: string;
  resource_type: string;
};

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
  const { cloudName, apiKey, apiSecret } = await getCloudinarySettings();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `produtos/${safeCloudinaryPart(input.brandCode)}`;
  const cloudinaryFileName = buildCloudinaryImageName(input);
  const paramsToSign = {
    folder,
    public_id: cloudinaryFileName,
    timestamp: String(timestamp)
  };
  const signature = signCloudinaryParams(paramsToSign, apiSecret);
  const formData = new FormData();
  formData.set("file", new Blob([new Uint8Array(input.buffer)]), input.fileName);
  formData.set("api_key", apiKey);
  formData.set("timestamp", String(timestamp));
  formData.set("folder", folder);
  formData.set("public_id", cloudinaryFileName);
  formData.set("signature", signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: formData
  });
  const json = await response.json().catch(() => ({})) as Partial<CloudinaryUploadResult> & { error?: { message?: string } };
  if (!response.ok || !json.secure_url) {
    throw new Error(`Falha no upload Cloudinary: ${json.error?.message || JSON.stringify(json)}`);
  }

  const publicId = json.public_id || `${folder}/${cloudinaryFileName}`;
  const cloudinaryUrl = transformCloudinaryUrl(cloudName, publicId, input.position);
  if (input.position === 1) {
    console.log("Imagem arquivo " + cloudinaryFileName + " link: " + cloudinaryUrl);
  }

  return {
    publicId,
    cloudinaryFileName,
    originalUrl: json.secure_url,
    cloudinaryUrl,
    ...await saveProcessedProductImage({
      sku: input.sku,
      position: input.position,
      sourceUrl: cloudinaryUrl,
      originalName: cloudinaryFileName
    })
  };
}

function transformCloudinaryUrl(cloudName: string, publicId: string, position: number) {
  const normalizedPublicId = publicId.replace(/\.(jpg|jpeg|png|webp|heic|heif)$/i, "");

  if (position === 1) {
    return `https://res.cloudinary.com/${cloudName}/image/upload/e_background_removal,b_white,q_auto:good,f_jpg,w_800,h_800,c_limit/${normalizedPublicId}.jpg`;
  }

  return `https://res.cloudinary.com/${cloudName}/image/upload/q_auto:good,w_800,h_800,c_limit,f_auto/${normalizedPublicId}`;
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

export async function deleteCloudinaryResource(publicId: string | null | undefined) {
  if (!publicId) {
    return;
  }

  const { cloudName, apiKey, apiSecret } = await getCloudinarySettings();
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    public_id: publicId,
    timestamp: String(timestamp)
  };
  const signature = signCloudinaryParams(paramsToSign, apiSecret);
  const formData = new FormData();
  formData.set("public_id", publicId);
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
