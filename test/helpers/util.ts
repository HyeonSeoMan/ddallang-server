/** Prisma가 감싼 오류에서 PostgreSQL SQLSTATE(5자)를 찾는다. */
export function sqlState(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.originalCode === 'string') return o.originalCode;
    if (typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code) && !/^P\d{4}$/.test(o.code)) {
      return o.code;
    }
    for (const k of Object.keys(o)) {
      const r = walk(o[k]);
      if (r) return r;
    }
    return undefined;
  };
  return walk(err);
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
