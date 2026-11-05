// Full-range V3 position math in BigInt (identical formulas to the contract's V3Math / Uniswap LiquidityAmounts).
const Q96 = 1n << 96n;

export function amount0ForLiquidity(a: bigint, b: bigint, l: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return ((l << 96n) * (b - a)) / b / a;
}

export function amount1ForLiquidity(a: bigint, b: bigint, l: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  return (l * (b - a)) / Q96;
}

export function amountsForLiquidity(p: bigint, a: bigint, b: bigint, l: bigint): [bigint, bigint] {
  if (a > b) [a, b] = [b, a];
  if (p <= a) return [amount0ForLiquidity(a, b, l), 0n];
  if (p < b) return [amount0ForLiquidity(p, b, l), amount1ForLiquidity(a, p, l)];
  return [0n, amount1ForLiquidity(a, b, l)];
}

export function liquidityForAmounts(p: bigint, a: bigint, b: bigint, x0: bigint, x1: bigint): bigint {
  if (a > b) [a, b] = [b, a];
  if (p <= a) return (x0 * ((a * b) / Q96)) / (b - a);
  if (p < b) {
    const l0 = (x0 * ((p * b) / Q96)) / (b - p);
    const l1 = (x1 * Q96) / (p - a);
    return l0 < l1 ? l0 : l1;
  }
  return (x1 * Q96) / (b - a);
}

/** For the full-range position at spot sqrt price p: amount of the other token that pairs with `known`.
 *  knownIs0 = the known amount is token0. */
export function pairedAmount(p: bigint, a: bigint, b: bigint, known: bigint, knownIs0: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  if (p <= a || p >= b || known === 0n) return 0n;
  if (knownIs0) {
    const l = (known * ((p * b) / Q96)) / (b - p);
    return amount1ForLiquidity(a, p, l);
  }
  const l = (known * Q96) / (p - a);
  return amount0ForLiquidity(p, b, l);
}
