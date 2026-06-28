import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import path from "path";

export type LocalImageFile = {
  name: string;
  absolutePath: string;
  localPath: string;
  localUrl: string;
  sizeBytes: number;
  modifiedAt: string;
};

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads", "products");
const PUBLIC_ROOT = path.join(process.cwd(), "public");

export async function saveProcessedProductImage(input: {
  sku: string;
  position: number;
  sourceUrl: string;
  originalName: string;
}) {
  const response = await fetch(input.sourceUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Nao foi possivel baixar imagem processada do Cloudinary: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const extension = extensionFromContentType(response.headers.get("content-type")) || ".jpg";
  const fileName = `${String(input.position).padStart(2, "0")}-${safeFilePart(input.originalName)}${extension}`;
  const directory = path.join(UPLOAD_ROOT, safeFilePart(input.sku));
  await mkdir(directory, { recursive: true });

  const absolutePath = path.join(directory, fileName);
  await writeFile(absolutePath, bytes);

  return {
    localPath: absolutePath,
    localUrl: toLocalUrl(absolutePath),
    bytes: bytes.length
  };
}

export async function listLocalProductImages(): Promise<LocalImageFile[]> {
  const files = await listFilesRecursive(UPLOAD_ROOT);
  const images = [];

  for (const file of files) {
    if (!isImageFile(file)) {
      continue;
    }

    const info = await stat(file);
    images.push({
      name: path.basename(file),
      absolutePath: file,
      localPath: file,
      localUrl: toLocalUrl(file),
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString()
    });
  }

  return images.sort((a, b) => a.localUrl.localeCompare(b.localUrl));
}

export async function deleteLocalImageByUrl(localUrl: string) {
  const target = localUrlToPath(localUrl);
  if (!target) {
    return;
  }

  await rm(target, { force: true });
}

export async function deleteLocalImagePath(localPath: string | null | undefined) {
  if (!localPath) {
    return;
  }

  const target = path.resolve(localPath);
  if (!target.startsWith(PUBLIC_ROOT)) {
    return;
  }

  await rm(target, { force: true });
}

export async function deleteLocalProductFolder(sku: string) {
  await rm(path.join(UPLOAD_ROOT, safeFilePart(sku)), { recursive: true, force: true });
}

export async function readLocalImageSize(localUrl: string) {
  const target = localUrlToPath(localUrl);
  if (!target) {
    return 0;
  }

  const bytes = await readFile(target).catch(() => null);
  return bytes?.length || 0;
}

function toLocalUrl(absolutePath: string) {
  const relative = path.relative(PUBLIC_ROOT, absolutePath).replace(/\\/g, "/");
  return `/${relative}`;
}

function localUrlToPath(localUrl: string) {
  if (!localUrl.startsWith("/uploads/products/")) {
    return null;
  }

  const target = path.resolve(PUBLIC_ROOT, localUrl.replace(/^\//, ""));
  return target.startsWith(UPLOAD_ROOT) ? target : null;
}

async function listFilesRecursive(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function isImageFile(filePath: string) {
  return /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(filePath);
}

function extensionFromContentType(contentType: string | null) {
  if (!contentType) {
    return "";
  }

  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  return "";
}

function safeFilePart(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "imagem";
}
