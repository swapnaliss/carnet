// Hand-rolled seeded generator for property tests (mulberry32): reproducible, no dependency.
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  /** A bigint with up to `maxDigits` decimal digits, either sign. */
  const bigint = (maxDigits: number): bigint => {
    const len = int(1, maxDigits);
    let s = String(int(1, 9));
    for (let i = 1; i < len; i++) s += String(int(0, 9));
    const v = int(0, 9) === 0 ? 0n : BigInt(s);
    return int(0, 1) === 0 ? v : -v;
  };
  return { next, int, pick, bigint };
}

export const RUNS = 1000;
