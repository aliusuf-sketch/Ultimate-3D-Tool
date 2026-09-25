/** Douglas–Peucker simplification for closed loops (points interleaved x,y). */

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px,
    ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

/** Marks kept vertices of the open polyline idx[a..b] (indices into pts) in `keep`. */
function dpOpen(
  pts: Float64Array,
  idx: Int32Array,
  a: number,
  b: number,
  tol2: number,
  keep: Uint8Array,
): void {
  const stack = [a, b];
  keep[idx[a]] = 1;
  keep[idx[b]] = 1;
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j - i < 2) continue;
    const ai = idx[i] * 2,
      bi = idx[j] * 2;
    const ax = pts[ai],
      ay = pts[ai + 1],
      bx = pts[bi],
      by = pts[bi + 1];
    let best = -1,
      bestD = tol2;
    for (let k = i + 1; k < j; k++) {
      const p = idx[k] * 2;
      const d = segDist2(pts[p], pts[p + 1], ax, ay, bx, by);
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[idx[best]] = 1;
      stack.push(i, best, best, j);
    }
  }
}

/**
 * Simplify a closed loop: split at the point farthest from the start, then simplify
 * both halves. Returns a loop with >= 3 points (or the input if it cannot shrink).
 */
export function simplifyLoop(pts: Float64Array, tol: number): Float64Array {
  const n = pts.length / 2;
  if (n <= 3 || tol <= 0) return pts;
  const x0 = pts[0],
    y0 = pts[1];
  let far = 1,
    farD = -1;
  for (let i = 1; i < n; i++) {
    const dx = pts[i * 2] - x0,
      dy = pts[i * 2 + 1] - y0;
    const d = dx * dx + dy * dy;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  // Index sequence 0..n (n wraps back to 0).
  const idx = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx[n] = 0;
  const keep = new Uint8Array(n);
  const tol2 = tol * tol;
  dpOpen(pts, idx, 0, far, tol2, keep);
  dpOpen(pts, idx, far, n, tol2, keep);
  let count = 0;
  for (let i = 0; i < n; i++) count += keep[i];
  if (count < 3) {
    // Degenerate result: keep the three most spread points so the loop stays closed.
    let third = -1,
      thirdD = -1;
    const fx = pts[far * 2],
      fy = pts[far * 2 + 1];
    for (let i = 1; i < n; i++) {
      if (i === far) continue;
      const d = segDist2(pts[i * 2], pts[i * 2 + 1], x0, y0, fx, fy);
      if (d > thirdD) {
        thirdD = d;
        third = i;
      }
    }
    keep[third] = 1;
    count = 3;
  }
  // The start point is always kept by the split; drop it too if it lies on the line
  // between its kept neighbours.
  if (count > 3) {
    let prev = n - 1;
    while (!keep[prev]) prev--;
    let next = 1;
    while (!keep[next]) next++;
    const d = segDist2(x0, y0, pts[prev * 2], pts[prev * 2 + 1], pts[next * 2], pts[next * 2 + 1]);
    let ok = d <= tol2;
    for (let i = prev + 1; ok && i < n; i++) {
      ok =
        segDist2(
          pts[i * 2],
          pts[i * 2 + 1],
          pts[prev * 2],
          pts[prev * 2 + 1],
          pts[next * 2],
          pts[next * 2 + 1],
        ) <= tol2;
    }
    for (let i = 1; ok && i < next; i++) {
      ok =
        segDist2(
          pts[i * 2],
          pts[i * 2 + 1],
          pts[prev * 2],
          pts[prev * 2 + 1],
          pts[next * 2],
          pts[next * 2 + 1],
        ) <= tol2;
    }
    if (ok) {
      keep[0] = 0;
      count--;
    }
  }
  const out = new Float64Array(count * 2);
  for (let i = 0, o = 0; i < n; i++) {
    if (keep[i]) {
      out[o++] = pts[i * 2];
      out[o++] = pts[i * 2 + 1];
    }
  }
  return out;
}
