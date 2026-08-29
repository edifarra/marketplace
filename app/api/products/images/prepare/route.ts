import { NextResponse } from "next/server";
import { deleteCloudinaryResource, uploadProductImageToCloudinary } from "@/lib/cloudinary";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Selecione uma imagem para enviar.");
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) throw new Error("A imagem deve ser JPG, PNG ou WebP e ter no máximo 8 MB.");
    const text = (key: string) => String(data.get(key) || "").trim();
    const position = Number(text("position"));
    if (!text("sku") || !text("typeCode") || !text("brandCode") || !text("model") || !Number.isInteger(position) || position < 1 || position > 6) throw new Error("Preencha os dados do produto antes de enviar a foto.");
    const upload = await uploadProductImageToCloudinary({ buffer: Buffer.from(await file.arrayBuffer()), fileName: file.name,
      sku: text("sku"), typeCode: text("typeCode"), brandCode: text("brandCode"), model: text("model"), boardCode: text("boardCode"), position });
    return NextResponse.json({ ok: true, image: { name: file.name, position, url: upload.cloudinaryUrl, cloudinaryUrl: upload.cloudinaryUrl,
      publicId: upload.publicId, cloudName: upload.cloudName, bytes: upload.bytes, width: upload.width, height: upload.height } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { publicId } = await request.json();
    await deleteCloudinaryResource(String(publicId || ""));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
