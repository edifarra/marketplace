"use server";

import { deleteConfiguration, saveConfiguration } from "@/lib/configurations";

export async function saveConfigurationAction(formData: FormData) {
  await saveConfiguration(formData);
}

export async function deleteConfigurationAction(formData: FormData) {
  await deleteConfiguration(formData);
}
