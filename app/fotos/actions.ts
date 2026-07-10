"use server";

import { revalidatePath } from "next/cache";
import { deleteCloudinaryResource } from "@/lib/cloudinary";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function deleteSelectedPhotosAction(formData: FormData) {
  const publicIds = formData.getAll("photos").map(String).filter(Boolean);
  if (publicIds.length === 0) {
    return;
  }

  for (const publicId of publicIds) {
    await deleteCloudinaryResource(publicId);
  }

  const supabase = supabaseAdmin();
  const cleanup = await supabase.from("product_images").delete().in("cloudinary_public_id", publicIds);
  if (cleanup.error && !isMissingColumnError(cleanup.error.message)) {
    throw cleanup.error;
  }

  revalidatePath("/fotos");
  revalidatePath("/produtos");
}

function isMissingColumnError(message: string) {
  return /column .* does not exist|schema cache|Could not find/i.test(message);
}
