import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
(async () => {
  const { enqueueDirectListingUpdates } = await import("../lib/direct-marketplace-publisher");
  const ids = await enqueueDirectListingUpdates("1b474303-3643-4b0b-ba39-7c62ba41cfab");
  console.log(JSON.stringify({ sku: "381TC", activities: ids }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
