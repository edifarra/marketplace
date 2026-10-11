import { CaseReadCache } from "./case-read-cache";
export type ReturnCost = { currency_id: string; amount: number };
export function validReturnCost(value: unknown): value is ReturnCost {
  const v = value as ReturnCost | null;
  return Boolean(v && typeof v.amount === "number" && Number.isFinite(v.amount) && v.amount >= 0
    && typeof v.currency_id === "string" && /^[A-Z]{3}$/.test(v.currency_id));
}
export class ClaimReturnCostCache {
  private cache = new CaseReadCache<ReturnCost>();
  private refreshing = new Map<string, Promise<ReturnCost | null>>();
  async read(key: string, load: () => Promise<unknown>, fresh = false): Promise<ReturnCost | null> {
    if (fresh) {
      const pending = this.refreshing.get(key);
      if (pending) return pending;
      this.cache.invalidate(key);
      const task = this.read(key, load).finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, task);
      return task;
    }
    try { return await this.cache.get(key, async () => {
      const value = await load();
      if (!validReturnCost(value)) throw new Error("Custo inválido");
      return value;
    }); } catch { return null; }
  }
}
export function returnCostLabel(cost: ReturnCost | null, modal = false) {
  if (!cost) return modal ? "Não disponível para consulta." : "Não disponível";
  if (cost.amount === 0) return modal ? "Gratuito para você." : "Gratuito";
  return cost.amount.toLocaleString("pt-BR", { style: "currency", currency: cost.currency_id });
}
