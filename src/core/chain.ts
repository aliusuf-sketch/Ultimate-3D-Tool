/**
 * Chain segments into loops. Endpoints are matched through quantised keys (1e-4 mm),
 * independent of segment direction, so inconsistently wound meshes still chain.
 */

const Q = 1e4; // 1 / 1e-4 mm
const NUM_KEY_LIMIT = 1 << 25; // keeps numeric keys below 2^53

export interface ChainResult {
  loops: Float64Array[];
  open: Float64Array[];
}

export function chainSegments(segs: Float64Array): ChainResult {
  const nSeg = segs.length / 4;
  const loops: Float64Array[] = [];
  const open: Float64Array[] = [];
  if (nSeg === 0) return { loops, open };

  // Decide key type: numeric when the quantised coordinates fit, else string.
  let maxAbs = 0;
  for (let i = 0; i < segs.length; i++) {
    const a = Math.abs(segs[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const numeric = maxAbs * Q < NUM_KEY_LIMIT - 1;
  const keyOf = numeric
    ? (x: number, y: number): number | string =>
        (Math.round(x * Q) + NUM_KEY_LIMIT) * (2 * NUM_KEY_LIMIT) + (Math.round(y * Q) + NUM_KEY_LIMIT)
    : (x: number, y: number): number | string => `${Math.round(x * Q)},${Math.round(y * Q)}`;

  // key -> list of incidences (seg * 2 + end)
  const keys: (number | string)[] = new Array(nSeg * 2);
  const adj = new Map<number | string, number[]>();
  for (let s = 0; s < nSeg; s++) {
    for (let e = 0; e < 2; e++) {
      const k = keyOf(segs[s * 4 + e * 2], segs[s * 4 + e * 2 + 1]);
      keys[s * 2 + e] = k;
      const list = adj.get(k);
      if (list) list.push(s * 2 + e);
      else adj.set(k, [s * 2 + e]);
    }
  }
  const used = new Uint8Array(nSeg);

  /** Find an unused segment touching key k; returns incidence or -1. */
  const take = (k: number | string): number => {
    const list = adj.get(k);
    if (!list) return -1;
    for (let i = 0; i < list.length; i++) {
      const inc = list[i];
      if (!used[inc >> 1]) {
        used[inc >> 1] = 1;
        return inc;
      }
    }
    return -1;
  };

  const fwd: number[] = [];
  const back: number[] = [];
  for (let s0 = 0; s0 < nSeg; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    fwd.length = 0;
    back.length = 0;
    const startKey = keys[s0 * 2];
    fwd.push(segs[s0 * 4], segs[s0 * 4 + 1], segs[s0 * 4 + 2], segs[s0 * 4 + 3]);
    let cur = keys[s0 * 2 + 1];
    let closed = false;
    // Walk forward.
    for (;;) {
      if (cur === startKey) { closed = true; break; }
      const inc = take(cur);
      if (inc < 0) break;
      const s = inc >> 1;
      const other = (inc & 1) ^ 1; // leave through the other end
      fwd.push(segs[s * 4 + other * 2], segs[s * 4 + other * 2 + 1]);
      cur = keys[s * 2 + other];
    }
    if (closed) {
      fwd.length -= 2; // last point duplicates the start
      if (fwd.length >= 6) loops.push(Float64Array.from(fwd));
      continue;
    }
    // Still open: walk backward from the start.
    cur = startKey;
    for (;;) {
      const inc = take(cur);
      if (inc < 0) break;
      const s = inc >> 1;
      const other = (inc & 1) ^ 1;
      back.push(segs[s * 4 + other * 2 + 1], segs[s * 4 + other * 2]); // y, x (reversed later)
      cur = keys[s * 2 + other];
    }
    back.reverse();
    const pts = Float64Array.from(back.concat(fwd));
    open.push(pts);
  }
  return { loops, open };
}
