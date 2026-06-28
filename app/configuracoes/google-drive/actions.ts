"use server";

import {
  deleteGoogleDriveFolder,
  saveGoogleDriveFolder,
  saveGoogleDriveSettings,
  saveGoogleDriveTestResult
} from "@/lib/google-drive-config";
import { testGoogleDriveConnection, testGoogleDriveFolderAccess } from "@/lib/google-drive";

export async function saveGoogleDriveSettingsAction(formData: FormData) {
  try {
    await saveGoogleDriveSettings(formData);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Erro ao salvar GoogleDrive.";
    const { redirect } = await import("next/navigation");
    redirect(`/configuracoes/google-drive?erro=${encodeURIComponent(message)}`);
  }
}

export async function saveGoogleDriveFolderAction(formData: FormData) {
  try {
    const folderId = String(formData.get("folderId") || "").trim();
    const name = String(formData.get("name") || "").trim() || "Pasta auxiliar";
    await testGoogleDriveFolderAccess(folderId, name);
    await saveGoogleDriveFolder(formData);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    const details = error instanceof Error ? ` ${error.message}` : "";
    const message = `Pasta nao encontrada ou sem acesso.${details}`;
    const { redirect } = await import("next/navigation");
    redirect(`/configuracoes/google-drive?erro=${encodeURIComponent(message)}`);
  }
}

export async function deleteGoogleDriveFolderAction(formData: FormData) {
  await deleteGoogleDriveFolder(formData);
}

export async function testGoogleDriveConnectionAction() {
  try {
    const result = await testGoogleDriveConnection();
    await saveGoogleDriveTestResult("Sucesso", result);
  } catch (error) {
    await saveGoogleDriveTestResult("Falha", {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const { redirect } = await import("next/navigation");
  redirect("/configuracoes/google-drive");
}

function isRedirectError(error: unknown) {
  return (
    error instanceof Error &&
    ("digest" in error ? String(error.digest).startsWith("NEXT_REDIRECT") : error.message === "NEXT_REDIRECT")
  );
}
