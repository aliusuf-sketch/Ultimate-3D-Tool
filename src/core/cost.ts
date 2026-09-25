/** Material usage and cost estimate from a nesting result. */
import type { SheetInfo } from '../types';

export const MM_PER_FT = 304.8;

export interface CostEstimate {
  /** Stock sheets to buy. Oversize sheets count as the whole sheets their area needs. */
  sheets: number;
  regularSheets: number;
  oversizeSheets: number;
  total: number;
  /** Part area / purchased sheet area, 0..1. */
  utilisation: number;
  sheetArea: number; // mm²
  partArea: number; // mm²
}

export function estimateCost(
  sheets: SheetInfo[],
  sheetW: number,
  sheetH: number,
  partArea: number,
  pricePerSheet: number,
): CostEstimate {
  const sheetArea = sheetW * sheetH;
  let regular = 0,
    oversize = 0,
    count = 0;
  for (const s of sheets) {
    if (s.oversize) {
      oversize++;
      count += Math.max(1, Math.ceil((s.w * s.h) / sheetArea - 1e-9));
    } else {
      regular++;
      count++;
    }
  }
  const price = Number.isFinite(pricePerSheet) && pricePerSheet > 0 ? pricePerSheet : 0;
  return {
    sheets: count,
    regularSheets: regular,
    oversizeSheets: oversize,
    total: count * price,
    utilisation: count > 0 ? Math.min(1, partArea / (count * sheetArea)) : 0,
    sheetArea,
    partArea,
  };
}

/** Net area of parts: outer loop minus holes. */
export function partsArea(
  parts: { loops: Float64Array[] }[],
  signedArea: (p: Float64Array) => number,
): number {
  let a = 0;
  for (const p of parts) {
    p.loops.forEach((l, i) => {
      const s = Math.abs(signedArea(l));
      a += i === 0 ? s : -s;
    });
  }
  return a;
}

export function formatMoney(amount: number, currency: string): string {
  const v = amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency}${v}`;
}
