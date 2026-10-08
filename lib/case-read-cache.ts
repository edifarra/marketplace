export const CASE_CACHE_MS = 15 * 60_000;
type Entry<T> = { value: T; expires: number };
// Hard expiry, successful loads only, bounded memory, and one promise per key.
export class CaseReadCache<T> {
  private entries = new Map<string, Entry<T>>();
  private pending = new Map<string, Promise<T>>();
  constructor(private now = () => Date.now(), private maximum = 100) {}
  invalidate(key: string) { this.entries.delete(key); this.pending.delete(key); }
  put(key: string, value: T, expires = this.now() + CASE_CACHE_MS) {
    this.entries.delete(key); this.entries.set(key, { value, expires });
    while (this.entries.size > this.maximum) this.entries.delete(this.entries.keys().next().value!);
  }
  async get(key: string, load: () => Promise<T>, valid: (v: T) => boolean = v => v != null, expires?: (v: T) => number): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) return entry.value;
    if (this.pending.has(key)) return this.pending.get(key)!;
    const task = Promise.resolve().then(load).then(value => {
      if (!valid(value)) throw new Error("Resposta local incompleta.");
      if (this.pending.get(key) === task) this.put(key, value, expires?.(value));
      return value;
    }).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    this.pending.set(key, task); return task;
  }
}
