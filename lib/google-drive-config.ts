import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getGoogleOAuthToken, type GoogleOAuthToken } from "./google-oauth";
import { supabaseAdmin } from "./supabase-admin";

export type GoogleDriveFolder = {
  id: string;
  name: string;
  folder_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type GoogleDriveSettings = {
  imagesFolderId: string;
  intervalMinutes: number;
};

export type GoogleDriveConfigPageData = {
  settings: GoogleDriveSettings;
  folders: GoogleDriveFolder[];
  editFolder?: GoogleDriveFolder;
  setupError?: string;
  testStatus: string;
  testResult: unknown;
  diagnosticStatus: string;
  diagnosticResult: unknown;
  oauthToken: GoogleOAuthToken | null;
};

export async function getGoogleDriveSettings(): Promise<GoogleDriveSettings> {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("key,value")
    .in("key", ["GOOGLE_DRIVE_IMAGES_FOLDER_ID", "GOOGLE_DRIVE_INTERVAL_MINUTES"])
    .throwOnError();

  const settings = new Map((data ?? []).map((row) => [row.key, row.value]));

  return {
    imagesFolderId: settingToString(settings.get("GOOGLE_DRIVE_IMAGES_FOLDER_ID")) || process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID || "",
    intervalMinutes: settingToNumber(settings.get("GOOGLE_DRIVE_INTERVAL_MINUTES"), 60)
  };
}

export async function getGoogleDriveFolders(query = "") {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("google_drive_folders")
    .select("*")
    .order("name")
    .throwOnError();

  const folders = (data ?? []) as GoogleDriveFolder[];
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return folders;
  }

  return folders.filter((folder) =>
    normalize(`${folder.name} ${folder.folder_id} ${folder.active ? "ativo" : "inativo"}`).includes(normalizedQuery)
  );
}

export async function getGoogleDriveConfigPageData(query: string, editId?: string): Promise<GoogleDriveConfigPageData> {
  const settings = await getGoogleDriveSettings();
  const foldersResult = await getGoogleDriveFoldersSafe(query);
  const folders = foldersResult.folders;
  const editFolder = editId ? folders.find((folder) => folder.id === editId) : undefined;

  return {
    settings,
    folders,
    editFolder,
    setupError: foldersResult.setupError,
    testStatus: await getSettingString("GOOGLE_DRIVE_TEST_STATUS"),
    testResult: await getSettingValue("GOOGLE_DRIVE_TEST_RESULT"),
    diagnosticStatus: await getSettingString("GOOGLE_DRIVE_DIAGNOSTIC_STATUS"),
    diagnosticResult: await getSettingValue("GOOGLE_DRIVE_DIAGNOSTIC_RESULT"),
    oauthToken: await getGoogleOAuthToken()
  };
}

export async function saveGoogleDriveTestResult(status: "Sucesso" | "Falha", result: unknown) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert([
    {
      key: "GOOGLE_DRIVE_TEST_STATUS",
      value: status,
      description: "[GOOGLE_DRIVE] Status do ultimo teste de conexao"
    },
    {
      key: "GOOGLE_DRIVE_TEST_RESULT",
      value: result,
      description: "[GOOGLE_DRIVE] Resultado do ultimo teste de conexao"
    }
  ]).throwOnError();

  revalidateGoogleDrive();
}

export async function saveGoogleDriveDiagnosticResult(status: "Sucesso" | "Falha", result: unknown) {
  const supabase = supabaseAdmin();
  await supabase.from("settings").upsert([
    {
      key: "GOOGLE_DRIVE_DIAGNOSTIC_STATUS",
      value: status,
      description: "[GOOGLE_DRIVE] Status do ultimo diagnostico bruto"
    },
    {
      key: "GOOGLE_DRIVE_DIAGNOSTIC_RESULT",
      value: result,
      description: "[GOOGLE_DRIVE] Resultado do ultimo diagnostico bruto"
    }
  ]).throwOnError();

  revalidateGoogleDrive();
}

async function getGoogleDriveFoldersSafe(query: string) {
  try {
    return { folders: await getGoogleDriveFolders(query), setupError: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingTableError(message)) {
      return {
        folders: [] as GoogleDriveFolder[],
        setupError: "A tabela google_drive_folders ainda nao existe no Supabase. Execute a migration 002_google_drive_config.sql."
      };
    }

    throw error;
  }
}

export async function saveGoogleDriveSettings(formData: FormData) {
  const imagesFolderId = requiredString(formData.get("imagesFolderId"), "Pasta Imagens");
  const intervalMinutes = positiveInteger(formData.get("intervalMinutes"), "Executar busca a cada");

  const supabase = supabaseAdmin();
  const result = await supabase.from("settings").upsert([
    {
      key: "GOOGLE_DRIVE_IMAGES_FOLDER_ID",
      value: imagesFolderId,
      description: "[GOOGLE_DRIVE] Pasta Imagens de destino"
    },
    {
      key: "GOOGLE_DRIVE_INTERVAL_MINUTES",
      value: intervalMinutes,
      description: "[GOOGLE_DRIVE] Intervalo em minutos entre coletas automaticas"
    }
  ]);

  if (result.error) {
    redirect(`/configuracoes/google-drive?erro=${encodeURIComponent(result.error.message)}`);
  }

  revalidateGoogleDrive();
  redirect("/configuracoes/google-drive");
}

export async function saveGoogleDriveFolder(formData: FormData) {
  const originalId = optionalString(formData.get("originalId"));
  const payload = {
    name: requiredString(formData.get("name"), "Nome da pasta"),
    folder_id: requiredString(formData.get("folderId"), "ID da pasta"),
    active: formData.get("active") === "on",
    updated_at: new Date().toISOString()
  };
  const supabase = supabaseAdmin();
  const result = originalId
    ? await supabase.from("google_drive_folders").update(payload).eq("id", originalId)
    : await supabase.from("google_drive_folders").insert(payload);

  if (result.error) {
    if (isMissingTableError(result.error.message)) {
      redirect(`/configuracoes/google-drive?erro=${encodeURIComponent("A tabela google_drive_folders ainda nao existe no Supabase. Execute a migration 002_google_drive_config.sql.")}`);
    }

    redirect(`/configuracoes/google-drive?erro=${encodeURIComponent(result.error.message)}`);
  }

  revalidateGoogleDrive();
  redirect("/configuracoes/google-drive");
}

export async function deleteGoogleDriveFolder(formData: FormData) {
  const id = requiredString(formData.get("id"), "ID");
  const supabase = supabaseAdmin();
  const result = await supabase.from("google_drive_folders").delete().eq("id", id);

  if (result.error) {
    if (isMissingTableError(result.error.message)) {
      redirect(`/configuracoes/google-drive?erro=${encodeURIComponent("A tabela google_drive_folders ainda nao existe no Supabase. Execute a migration 002_google_drive_config.sql.")}`);
    }

    redirect(`/configuracoes/google-drive?erro=${encodeURIComponent(result.error.message)}`);
  }

  revalidateGoogleDrive();
  redirect("/configuracoes/google-drive");
}

function revalidateGoogleDrive() {
  revalidatePath("/");
  revalidatePath("/configuracoes/google-drive");
}

function settingToString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

async function getSettingString(key: string) {
  const value = await getSettingValue(key);
  return settingToString(value);
}

async function getSettingValue(key: string) {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", key)
    .maybeSingle()
    .throwOnError();

  return data?.value ?? "";
}

function settingToNumber(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function requiredString(value: FormDataEntryValue | null, field: string) {
  const text = optionalString(value);
  if (!text) {
    throw new Error(`Campo obrigatorio: ${field}`);
  }

  return text;
}

function optionalString(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: FormDataEntryValue | null, field: string) {
  const number = Number(optionalString(value));
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${field} precisa ser um numero inteiro positivo em minutos.`);
  }

  return number;
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isMissingTableError(message: string) {
  return message.includes("google_drive_folders") && (
    message.includes("schema cache") ||
    message.includes("does not exist") ||
    message.includes("Could not find the table")
  );
}
