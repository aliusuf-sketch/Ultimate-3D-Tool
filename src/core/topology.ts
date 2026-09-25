/** Loop topology helpers: area, bbox, point-in-polygon, nesting. */
import type { SlicedLoop } from '../types';

export function signedArea(pts: Float64Array): number {
  const n = pts.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  }
  return a / 2;
}

export function loopBBox(pts: Float64Array): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i],
      y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Even-odd ray casting. */
export function pointInPolygon(x: number, y: number, pts: Float64Array): boolean {
  const n = pts.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2],
      yi = pts[i * 2 + 1];
    const xj = pts[j * 2],
      yj = pts[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inBBox(x: number, y: number, b: [number, number, number, number]): boolean {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

/** Even-odd test against every loop of a layer: odd count = inside solid material. */
export function insideSolid(x: number, y: number, loops: SlicedLoop[]): boolean {
  let c = 0;
  for (const l of loops) if (inBBox(x, y, l.bbox) && pointInPolygon(x, y, l.pts)) c++;
  return (c & 1) === 1;
}

/** Minimum distance from (x, y) to any loop edge. */
export function edgeDistance(x: number, y: number, loops: { pts: Float64Array }[]): number {
  let best = Infinity;
  for (const { pts } of loops) {
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[j * 2],
        ay = pts[j * 2 + 1];
      const dx = pts[i * 2] - ax,
        dy = pts[i * 2 + 1] - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x,
        ey = ay + t * dy - y;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

export const MIN_LOOP_AREA = 1e-3; // mm²

/**
 * Build nested loops: drop tiny loops, sort by |area| descending, compute depth
 * (number of larger loops containing the first point) and parent (smallest such).
 * Orientation is normalised: solids CCW, holes CW.
 */
export function buildTopology(raw: Float64Array[]): SlicedLoop[] {
  const loops: SlicedLoop[] = [];
  for (const pts of raw) {
    const area = signedArea(pts);
    if (Math.abs(area) < MIN_LOOP_AREA) continue;
    loops.push({ pts, area, depth: 0, parent: -1, bbox: loopBBox(pts) });
  }
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  for (let i = 0; i < loops.length; i++) {
    const li = loops[i];
    const x = li.pts[0],
      y = li.pts[1];
    let depth = 0,
      parent = -1;
    for (let j = 0; j < i; j++) {
      const lj = loops[j];
      if (inBBox(x, y, lj.bbox) && pointInPolygon(x, y, lj.pts)) {
        depth++;
        parent = j; // later j = smaller area
      }
    }
    li.depth = depth;
    li.parent = parent;
    const wantPositive = depth % 2 === 0;
    if (li.area > 0 !== wantPositive) {
      li.pts = reverseLoop(li.pts);
      li.area = -li.area;
    }
  }
  return loops;
}

export function reverseLoop(pts: Float64Array): Float64Array {
  const n = pts.length / 2;
  const out = new Float64Array(pts.length);
  for (let i = 0; i < n; i++) {
    out[i * 2] = pts[(n - 1 - i) * 2];
    out[i * 2 + 1] = pts[(n - 1 - i) * 2 + 1];
  }
  return out;
}
