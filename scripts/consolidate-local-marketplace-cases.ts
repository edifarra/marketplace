import { consolidateLocalCases } from "../lib/marketplace-cases";

// Deliberately manual; no scheduler, external client, order processing, or queue replay.
consolidateLocalCases().then(result => console.log(JSON.stringify(result))).catch(() => {
  console.error("Consolidacao local falhou. Verifique a migration e o banco configurado; pode ser retomada idempotentemente.");
  process.exitCode = 1;
});
