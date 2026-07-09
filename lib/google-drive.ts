import { getGoogleDriveFolders, getGoogleDriveSettings } from "./google-drive-config";
import { getGoogleDriveAccessToken, getGoogleDriveAccountEmail, hasGoogleDriveServerCredentials } from "./google-drive-auth";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  fileExtension?: string;
  fullFileExtension?: string;
  webViewLink?: string;
  size?: string;
  md5Checksum?: string;
};

type DriveSourceFolder = {
  label: string;
  folderId: string;
  kind: "root" | "auxiliary" | "destination";
};

export type DriveCollectResult = {
  folders: Array<{
    label: string;
    folderId: string;
    kind: "root" | "auxiliary" | "destination";
    query: string;
    found: number;
    valid: number;
    ignored: number;
    transferable: number;
    moved: number;
    copied: number;
    failed: number;
    files: string[];
    validFiles: string[];
    ignoredFiles: Array<{ name: string; reason: string }>;
    transferableFiles: string[];
    movedFiles: string[];
    errorFiles: Array<{ name: string; message: string }>;
  }>;
  totalFound: number;
  totalValid: number;
  totalIgnored: number;
  totalTransferable: number;
  totalMoved: number;
  totalCopied: number;
  totalFailed: number;
};

export type DriveCollectProgress = {
  status: string;
  totalFiles: number;
  processedFiles: number;
  percent: number;
  message?: string;
};

export type DriveTestResult = {
  ok: boolean;
  clientEmail: string;
  checkedAt: string;
  folders: Array<{
    label: string;
    folderId: string;
    kind: "root" | "auxiliary" | "destination";
    foundImages: number;
    validImages: number;
    files: Array<DriveTestFile>;
  }>;
  totalFound: number;
  totalValid: number;
};

export type DriveTestFile = {
  id: string;
  name: string;
  mimeType: string;
  fileExtension?: string;
  valid: boolean;
  parsed?: ParsedDriveProductFileName;
};

export type ParsedDriveProductFileName = {
  normalizedName: string;
  typeCode: string;
  brandCode: string;
  model: string;
  boardCode?: string;
  version?: string;
  photoOrder: string;
};

export type DriveDiagnosticFile = DriveFile & {
  sourceLabel: string;
  folderId: string;
  normalizedName: string;
  validName: boolean;
  validationStatus: string;
  ignoredReason: string;
  transferable: boolean;
  targetMatch: boolean;
  parsed?: ParsedDriveProductFileName;
};

export type DriveDiagnosticFolder = {
  label: string;
  folderId: string;
  kind: "root" | "auxiliary" | "destination";
  query: string;
  found: number;
  valid: number;
  ignored: number;
  transferable: number;
  files: DriveDiagnosticFile[];
  error?: string;
};

export type DriveDiagnosticResult = {
  ok: boolean;
  clientEmail: string;
  checkedAt: string;
  targetFileName: string;
  targetStatus: string;
  targetReason: string;
  folders: DriveDiagnosticFolder[];
  totalFound: number;
  totalValid: number;
  totalIgnored: number;
  totalTransferable: number;
  totalMoved: number;
  totalErrors: number;
  rawTests: Array<DriveRawQueryTest>;
};

export type DriveRawQueryTest = {
  label: string;
  q: string;
  ok: boolean;
  raw: unknown;
  error?: string;
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const RAW_DRIVE_FIELDS = "nextPageToken, files(id,name,mimeType,parents,trashed,fileExtension,fullFileExtension,webViewLink,size,md5Checksum)";
const TARGET_DIAGNOSTIC_FILE_NAME = "PPSA_TESTEMODELO_TESTECODPLACA_01";

export async function hasGoogleDriveConfig() {
  const settings = await getGoogleDriveSettings();
  return Boolean(settings.imagesFolderId && await hasGoogleDriveServerCredentials());
}

export async function collectDriveImages(onProgress?: (progress: DriveCollectProgress) => Promise<void>): Promise<DriveCollectResult> {
  const settings = await getGoogleDriveSettings();
  const imagesFolderId = requiredValue(settings.imagesFolderId, "GOOGLE_DRIVE_IMAGES_FOLDER_ID");
  const sourceFolders = await getSourceFolders();
  const accessToken = await getGoogleDriveAccessToken();
  const accountEmail = await getGoogleDriveAccountEmail();

  const result: DriveCollectResult = {
    folders: [],
    totalFound: 0,
    totalValid: 0,
    totalIgnored: 0,
    totalTransferable: 0,
    totalMoved: 0,
    totalCopied: 0,
    totalFailed: 0
  };

  await reportDriveProgress(onProgress, {
    status: "running",
    totalFiles: 0,
    processedFiles: 0,
    percent: 0,
    message: "Iniciando busca no Google Drive."
  });

  for (const folder of sourceFolders) {
    const query = buildRawFolderSearchQuery(folder.folderId);
    const files = await listRawDriveFiles(accessToken, folder, accountEmail);
    const decisions = files.map((file) => buildFileDecision(file, folder, imagesFolderId));
    const validFiles = decisions.filter((decision) => decision.validName);
    const ignoredFiles = decisions.filter((decision) => decision.ignoredReason);
    const transferableFiles = decisions.filter((decision) => decision.transferable);
    result.totalFound += files.length;
    result.totalValid += validFiles.length;
    result.totalIgnored += ignoredFiles.length;
    result.totalTransferable += transferableFiles.length;

    const folderResult = {
      ...folder,
      query,
      found: files.length,
      valid: validFiles.length,
      ignored: ignoredFiles.length,
      transferable: transferableFiles.length,
      moved: 0,
      copied: 0,
      failed: 0,
      files: files.map((file) => file.name),
      validFiles: validFiles.map((decision) => decision.name),
      ignoredFiles: ignoredFiles.map((decision) => ({ name: decision.name, reason: decision.ignoredReason })),
      transferableFiles: transferableFiles.map((decision) => decision.name),
      movedFiles: [] as string[],
      errorFiles: [] as Array<{ name: string; message: string }>
    };

    await reportDriveProgress(onProgress, buildDriveProgress(result, `Pasta ${folder.label}: ${files.length} item(ns) localizado(s).`));

    for (const file of transferableFiles) {
      try {
        const moved = await moveFile(accessToken, file, folder.folderId, imagesFolderId);
        if (moved === "moved") {
          folderResult.moved++;
          result.totalMoved++;
        } else {
          folderResult.copied++;
          result.totalCopied++;
        }
        folderResult.movedFiles.push(file.name);
      } catch (error) {
        const message = getErrorMessage(error);
        folderResult.failed++;
        folderResult.errorFiles.push({ name: file.name, message });
        result.totalFailed++;
        console.error(`Erro ao mover ${file.name}:`, message);
      }

      await reportDriveProgress(onProgress, buildDriveProgress(result, `Fotos processados ${driveProcessedFiles(result)} de ${result.totalTransferable}.`));
    }

    result.folders.push(folderResult);
  }

  await reportDriveProgress(onProgress, {
    status: result.totalFailed > 0 ? "failed" : "done",
    totalFiles: result.totalTransferable,
    processedFiles: driveProcessedFiles(result),
    percent: result.totalTransferable > 0 ? 100 : 0,
    message: "Coleta do Google Drive concluida."
  });

  return result;
}

function buildDriveProgress(result: DriveCollectResult, message: string): DriveCollectProgress {
  const processedFiles = driveProcessedFiles(result);
  const totalFiles = result.totalTransferable;

  return {
    status: "running",
    totalFiles,
    processedFiles,
    percent: totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0,
    message
  };
}

function driveProcessedFiles(result: DriveCollectResult) {
  return result.totalMoved + result.totalCopied + result.totalFailed;
}

async function reportDriveProgress(
  onProgress: ((progress: DriveCollectProgress) => Promise<void>) | undefined,
  progress: DriveCollectProgress
) {
  if (!onProgress) {
    return;
  }

  await onProgress(progress);
}

export async function diagnoseGoogleDriveFolder(folderId: string, label: string): Promise<DriveDiagnosticFolder> {
  const settings = await getGoogleDriveSettings();
  const imagesFolderId = requiredValue(settings.imagesFolderId, "GOOGLE_DRIVE_IMAGES_FOLDER_ID");
  const accessToken = await getGoogleDriveAccessToken();
  const accountEmail = await getGoogleDriveAccountEmail();
  const folder: DriveSourceFolder = {
    label,
    folderId,
    kind: folderId === "root" ? "root" : folderId === imagesFolderId ? "destination" : "auxiliary"
  };
  const files = await listRawDriveFiles(accessToken, folder, accountEmail);
  return buildDiagnosticFolder(folder, files, imagesFolderId);
}

export async function diagnoseGoogleDrive(): Promise<DriveDiagnosticResult> {
  const settings = await getGoogleDriveSettings();
  const imagesFolderId = requiredValue(settings.imagesFolderId, "GOOGLE_DRIVE_IMAGES_FOLDER_ID");
  const sourceFolders = await getSourceFolders();
  const accessToken = await getGoogleDriveAccessToken();
  const accountEmail = await getGoogleDriveAccountEmail();
  const foldersToDiagnose: DriveSourceFolder[] = [
    ...sourceFolders,
    { label: "Pasta Imagens", folderId: imagesFolderId, kind: "destination" }
  ];

  const result: DriveDiagnosticResult = {
    ok: true,
    clientEmail: accountEmail,
    checkedAt: new Date().toISOString(),
    targetFileName: TARGET_DIAGNOSTIC_FILE_NAME,
    targetStatus: "",
    targetReason: "",
    folders: [],
    totalFound: 0,
    totalValid: 0,
    totalIgnored: 0,
    totalTransferable: 0,
    totalMoved: 0,
    totalErrors: 0,
    rawTests: []
  };

  result.rawTests = await runRawDriveQueryTests(accessToken);

  for (const folder of foldersToDiagnose) {
    try {
      const files = await listRawDriveFiles(accessToken, folder, accountEmail);
      const folderResult = buildDiagnosticFolder(folder, files, imagesFolderId);
      result.folders.push(folderResult);
      result.totalFound += folderResult.found;
      result.totalValid += folderResult.valid;
      result.totalIgnored += folderResult.ignored;
      result.totalTransferable += folderResult.transferable;
    } catch (error) {
      result.ok = false;
      result.totalErrors++;
      result.folders.push({
        ...folder,
        query: buildRawFolderSearchQuery(folder.folderId),
        found: 0,
        valid: 0,
        ignored: 0,
        transferable: 0,
        files: [],
        error: getErrorMessage(error)
      });
    }
  }

  const targetFiles = result.folders.flatMap((folder) => folder.files).filter((file) => file.targetMatch);
  const targetInSources = targetFiles.find((file) => file.folderId !== imagesFolderId);
  const targetInDestination = targetFiles.find((file) => file.folderId === imagesFolderId);
  const destinationError = result.folders.find((folder) => folder.kind === "destination" && folder.error)?.error;

  if (targetInSources) {
    result.targetStatus = "Arquivo alvo encontrado";
    result.targetReason = destinationError
      ? `pasta destino sem permissao: ${destinationError}`
      : targetInSources.transferable
      ? "Arquivo transferivel pelo diagnostico bruto."
      : targetInSources.ignoredReason || "outro erro do Google Drive";
  } else if (targetInDestination) {
    result.targetStatus = "Arquivo alvo encontrado";
    result.targetReason = "arquivo ja esta na pasta destino";
  } else {
    result.targetStatus = "Arquivo alvo nao encontrado na ROOT nem nas pastas auxiliares";
    result.targetReason = "Arquivo alvo tambem nao foi localizado na pasta destino.";
  }

  return result;
}

export async function testGoogleDriveConnection(): Promise<DriveTestResult> {
  const settings = await getGoogleDriveSettings();
  requiredValue(settings.imagesFolderId, "GOOGLE_DRIVE_IMAGES_FOLDER_ID");
  const accessToken = await getGoogleDriveAccessToken();
  const accountEmail = await getGoogleDriveAccountEmail();
  const rootFolder: DriveSourceFolder = { label: "ROOT", folderId: "root", kind: "root" };

  const result: DriveTestResult = {
    ok: true,
    clientEmail: accountEmail,
    checkedAt: new Date().toISOString(),
    folders: [],
    totalFound: 0,
    totalValid: 0
  };

  const files = await listRawDriveFiles(accessToken, rootFolder, accountEmail, 1000);
  const validImages = files.filter((file) => isValidProductFileName(file.name)).length;
  result.folders.push({
    ...rootFolder,
    foundImages: files.length,
    validImages,
    files: []
  });
  result.totalFound = files.length;
  result.totalValid = validImages;

  return result;
}

export async function testGoogleDriveFolderAccess(folderId: string, label = "Pasta auxiliar") {
  const settings = await getGoogleDriveSettings();
  const accessToken = await getGoogleDriveAccessToken();
  const accountEmail = await getGoogleDriveAccountEmail();
  const folder: DriveSourceFolder = { label, folderId, kind: "auxiliary" };
  const files = await listRawDriveFiles(accessToken, folder, accountEmail, 1000);
  return {
    foundImages: files.length,
    validImages: files.filter((file) => isValidProductFileName(file.name)).length,
    files: files.slice(0, 10).map(toDriveTestFile)
  };
}

export async function listDriveImagesFolderFiles() {
  const settings = await getGoogleDriveSettings();
  const imagesFolderId = requiredValue(settings.imagesFolderId, "GOOGLE_DRIVE_IMAGES_FOLDER_ID");
  const accessToken = await getGoogleDriveAccessToken();
  const accountEmail = await getGoogleDriveAccountEmail();
  return listRawDriveFiles(
    accessToken,
    { label: "Pasta Imagens", folderId: imagesFolderId, kind: "destination" },
    accountEmail,
    1000
  );
}

export async function downloadDriveFile(fileId: string) {
  const accessToken = await getGoogleDriveAccessToken();
  const response = await fetch(`${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(formatGoogleDriveError(json));
  }

  return Buffer.from(await response.arrayBuffer());
}

async function getSourceFolders(): Promise<DriveSourceFolder[]> {
  const configuredFolders = await getGoogleDriveFolders();
  const folders = configuredFolders
    .filter((folder) => folder.active)
    .map((folder) => ({ label: folder.name, folderId: folder.folder_id, kind: "auxiliary" as const }));

  return [
    { label: "ROOT", folderId: "root", kind: "root" },
    ...folders
  ];
}

async function listRawDriveFiles(
  accessToken: string,
  folder: DriveSourceFolder,
  clientEmail: string,
  maxFiles = 1000
) {
  const files: DriveFile[] = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      q: buildRawFolderSearchQuery(folder.folderId),
      fields: RAW_DRIVE_FIELDS,
      pageSize: String(Math.min(maxFiles, 1000)),
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await driveFetch(accessToken, `/files?${params.toString()}`, {}, {
      folder,
      clientEmail,
      operation: "listar arquivos"
    });
    files.push(...((response.files || []) as DriveFile[]));
    pageToken = String(response.nextPageToken || "");
  } while (pageToken && files.length < maxFiles);

  return files.slice(0, maxFiles);
}

async function listFilesByQuery(accessToken: string, q: string) {
  const params = new URLSearchParams({
    q,
    fields: RAW_DRIVE_FIELDS,
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true"
  });

  return driveFetch(accessToken, `/files?${params.toString()}`);
}

async function runRawDriveQueryTests(accessToken: string): Promise<DriveRawQueryTest[]> {
  const queries = [
    { label: "Todos nao excluidos", q: "trashed = false" },
    { label: "ROOT nao excluidos", q: "'root' in parents and trashed = false" },
    {
      label: "Arquivo alvo por nome",
      q: "name = 'PPSA_TESTEMODELO_TESTECODPLACA_01' and trashed = false"
    }
  ];

  const tests: DriveRawQueryTest[] = [];
  for (const query of queries) {
    try {
      tests.push({
        ...query,
        ok: true,
        raw: await listFilesByQuery(accessToken, query.q)
      });
    } catch (error) {
      tests.push({
        ...query,
        ok: false,
        raw: null,
        error: getErrorMessage(error)
      });
    }
  }

  return tests;
}

export function buildRawFolderSearchQuery(folderId: string) {
  return `'${folderId}' in parents and trashed = false`;
}

export function normalizeDriveFileName(name: string) {
  return name.replace(/\.(jpg|jpeg|png|webp|heic|heif)$/i, "");
}

export function parseDriveProductFileName(name: string): ParsedDriveProductFileName {
  const normalizedName = normalizeDriveFileName(name).trim();
  const regex = /^[A-Za-z0-9]{4,5}_.{3,}_(0?[1-6])$/;

  if (!regex.test(normalizedName)) {
    throw new Error("Nome fora do padrao oficial.");
  }

  const parts = normalizedName.split("_");
  if (parts.length < 3) {
    throw new Error("Nome sem blocos suficientes.");
  }

  const firstBlock = parts[0];
  const photoOrder = parts[parts.length - 1];
  const middleBlocks = parts.slice(1, -1);
  const model = middleBlocks[0];

  return {
    normalizedName,
    typeCode: firstBlock.slice(0, 2),
    brandCode: firstBlock.slice(2, 4),
    model,
    boardCode: middleBlocks[1],
    version: middleBlocks.length > 2 ? middleBlocks.slice(2).join("_") : undefined,
    photoOrder
  };
}

export function isValidProductFileName(name: string) {
  try {
    parseDriveProductFileName(name);
    return true;
  } catch {
    return false;
  }
}

function buildDiagnosticFolder(folder: DriveSourceFolder, files: DriveFile[], imagesFolderId: string): DriveDiagnosticFolder {
  const diagnosticFiles = files.map((file) => buildFileDecision(file, folder, imagesFolderId));

  return {
    ...folder,
    query: buildRawFolderSearchQuery(folder.folderId),
    found: diagnosticFiles.length,
    valid: diagnosticFiles.filter((file) => file.validName).length,
    ignored: diagnosticFiles.filter((file) => file.ignoredReason).length,
    transferable: diagnosticFiles.filter((file) => file.transferable).length,
    files: diagnosticFiles
  };
}

function buildFileDecision(file: DriveFile, folder: DriveSourceFolder, imagesFolderId: string): DriveDiagnosticFile {
  const parsed = safeParseDriveProductFileName(file.name);
  let ignoredReason = "";

  if (file.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    ignoredReason = "pasta";
  } else if (file.trashed) {
    ignoredReason = "lixeira";
  } else if (!parsed) {
    ignoredReason = "nome invalido";
  } else if (file.parents?.includes(imagesFolderId)) {
    ignoredReason = "arquivo ja esta na pasta destino";
  } else if (!file.parents?.length) {
    ignoredReason = "arquivo sem parent";
  }

  const normalizedName = normalizeDriveFileName(file.name).trim();

  return {
    ...file,
    sourceLabel: folder.label,
    folderId: folder.folderId,
    normalizedName,
    validName: Boolean(parsed),
    validationStatus: parsed
      ? file.mimeType === DRIVE_FOLDER_MIME_TYPE
        ? "Nome valido; mimeType pasta"
        : "Nome valido; mimeType arquivo"
      : file.mimeType === DRIVE_FOLDER_MIME_TYPE
      ? "Nome invalido; mimeType pasta"
      : "Nome invalido; mimeType arquivo",
    ignoredReason,
    transferable: !ignoredReason && Boolean(parsed),
    targetMatch: normalizedName === TARGET_DIAGNOSTIC_FILE_NAME,
    parsed
  };
}

async function moveFile(accessToken: string, file: DriveFile, sourceFolderId: string, imagesFolderId: string) {
  if (file.parents?.includes(imagesFolderId)) {
    return "moved" as const;
  }

  if (!file.parents?.length) {
    throw new Error("arquivo sem parent");
  }

  const params = new URLSearchParams({
    addParents: imagesFolderId,
    removeParents: sourceFolderId,
    fields: "id,name,parents",
    supportsAllDrives: "true"
  });

  try {
    await driveFetch(accessToken, `/files/${file.id}?${params.toString()}`, {
      method: "PATCH"
    });
    return "moved" as const;
  } catch (error) {
    await copyThenTrash(accessToken, file, imagesFolderId);
    return "copied" as const;
  }
}

async function copyThenTrash(accessToken: string, file: DriveFile, imagesFolderId: string) {
  await driveFetch(accessToken, `/files/${file.id}/copy?supportsAllDrives=true&fields=id,name,parents`, {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      parents: [imagesFolderId]
    })
  });

  await driveFetch(accessToken, `/files/${file.id}?supportsAllDrives=true&fields=id,trashed`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: true })
  });
}

async function driveFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  context?: { folder: DriveSourceFolder; clientEmail: string; operation: string }
) {
  const response = await fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatGoogleDriveError(json, context));
  }

  return json;
}

function formatGoogleDriveError(json: unknown, context?: { folder: DriveSourceFolder; clientEmail: string; operation: string }) {
  const raw = JSON.stringify(json);
  const status = typeof json === "object" && json && "error" in json
    ? (json as { error?: { code?: number; message?: string; status?: string } }).error
    : undefined;
  const message = status?.message || raw;
  const code = status?.code;

  if (context && (code === 403 || code === 404)) {
    return `Google Drive sem acesso para ${context.operation} na pasta "${context.folder.label}" (${context.folder.folderId}) usando ${context.clientEmail}. Compartilhe a pasta com a Service Account configurada no servidor. Erro Google Drive: ${message}. Retorno completo: ${raw}`;
  }

  return `Erro Google Drive: ${message}. Retorno completo: ${raw}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toDriveTestFile(file: DriveFile): DriveTestFile {
  const parsed = safeParseDriveProductFileName(file.name);
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    valid: Boolean(parsed),
    parsed
  };
}

function safeParseDriveProductFileName(name: string) {
  try {
    return parseDriveProductFileName(name);
  } catch {
    return undefined;
  }
}

function requiredValue(value: string, name: string) {
  if (!value) {
    throw new Error(`Variavel obrigatoria ausente: ${name}`);
  }

  return value;
}
