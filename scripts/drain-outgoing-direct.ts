import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
(async () => {
  const { drainOutgoingActivities } = await import("../lib/outgoing-activities");
  console.log(JSON.stringify(await drainOutgoingActivities(), null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
