import type { drivePhotoRows } from "./drive-photo-processing";

type DriveProductInput = {
  product: Record<string, unknown>;
  images: ReturnType<typeof drivePhotoRows>;
  accounts: Array<{ id?: string; name: string; marketplace: string }>;
};

export async function persistDriveProduct(input: DriveProductInput,
  rpc: (args: { p_product: Record<string, unknown>; p_images: DriveProductInput["images"]; p_accounts: DriveProductInput["accounts"] }) => Promise<unknown>) {
  // One transaction: product + image metadata + internal drafts. No metadata-dropping fallback.
  const result = await rpc({ p_product: input.product, p_images: input.images, p_accounts: input.accounts });
  const row = result as { id?: string; sku?: string; created?: boolean } | null;
  if (!row?.id || !row.sku || typeof row.created !== "boolean") throw new Error("Resposta inválida da criação atômica do produto.");
  return { id: row.id, sku: row.sku, created: row.created };
}
