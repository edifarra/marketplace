"use server";

import { revalidatePath } from "next/cache";
import { deleteLocalImageByUrl } from "@/lib/local-images";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function deleteSelectedPhotosAction(formData: FormData) {
  const photos = formData.getAll("photos").map(String).filter(Boolean);
  if (photos.length === 0) {
    return;
  }

  for (const photo of photos) {
    await deleteLocalImageByUrl(photo);
  }

  const supabase = supabaseAdmin();
  await supabase.from("product_images").delete().in("local_url", photos);
  await supabase.from("product_images").delete().in("url", photos);

  revalidatePath("/fotos");
  revalidatePath("/produtos");
}
