// GMUD 1: the legacy reprocessor cannot preserve reconciled finance safely.
// Disabled before loading credentials or making any API/database requests.
throw new Error("Reprocessamento histórico bloqueado: requer conciliação financeira e aprovação específica.");
