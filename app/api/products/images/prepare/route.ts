import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { processAndStoreDrivePhoto } from "@/lib/drive-photo-processing";
import { storeVpsImage } from "@/lib/vps-image-storage";
import { signPreparedPhoto } from "@/lib/product-photo-edit-policy";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sessão expirada." }, { status: 401 });
  try {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Selecione uma imagem para enviar.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error("Use JPG, PNG ou WebP com até 8 MB.");
    const productId = String(data.get("productId") || "");
    const product = await supabaseAdmin().from("products").select("id").eq("id", productId).single().throwOnError();
    const position = Number(data.get("position"));
    const upload = await processAndStoreDrivePhoto({ buffer: Buffer.from(await file.arrayBuffer()), sourceKey: "product-edit:" + product.data.id, position }, storeVpsImage);
    const photo = { ...upload, name: file.name, productId, userId: user.id, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    return NextResponse.json({ ok: true, image: { ...upload, name: file.name, position, receipt: signPreparedPhoto(photo) } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
// Final files are immutable: a timed-out save may already reference them.
export async function DELETE() {
  return NextResponse.json({ ok: false, error: "Exclusão física de fotografias desabilitada." }, { status: 405 });
}
