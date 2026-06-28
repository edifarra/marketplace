"use server";

import { revalidatePath } from "next/cache";
import { sendPendingProductsToConfiguredTarget } from "@/lib/product-sender";

export async function runDrivePipelineNowAction() {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` ||
    "http://127.0.0.1:3000";

  await fetch(`${baseUrl}/api/pipeline/run?force=1`, {
    method: "POST",
    headers: process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : {},
    cache: "no-store"
  });

  revalidatePath("/");
}

export async function runProductLoadNowAction() {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` ||
    "http://127.0.0.1:3000";

  await fetch(`${baseUrl}/api/pipeline/products`, {
    method: "POST",
    headers: process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : {},
    cache: "no-store"
  });

  revalidatePath("/");
  revalidatePath("/produtos");
}

export async function runBatchProductSendAction() {
  await sendPendingProductsToConfiguredTarget();

  revalidatePath("/");
  revalidatePath("/produtos");
}
