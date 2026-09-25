/**
 * Plane/triangle intersection. Produces raw oriented segments per layer.
 * Segment direction follows the triangle winding so that, for an outward-facing mesh,
 * solid outlines come out counter-clockwise when viewed from +Z.
 */

export interface LayerPlan {
  n: number;
  t: number;
  H: number;
  planes: Float64Array;
}

export function planLayers(H: number, t: number): LayerPlan {
  const n = H > 0 && t > 0 ? Math.max(1, Math.ceil(H / t - 1e-9)) : 0;
  const planes = new Float64Array(n);
  for (let L = 0; L < n; L++) planes[L] = Math.min((L + 0.5) * t, (L * t + H) / 2);
  return { n, t, H, planes };
}

export function layerRange(plan: LayerPlan, L: number): [number, number] {
  return [L * plan.t, Math.min((L + 1) * plan.t, plan.H)];
}

/** Growable float buffer. */
export class FloatBuf {
  data: Float64Array;
  length = 0;
  constructor(cap = 64) {
    this.data = new Float64Array(cap);
  }
  push4(a: number, b: number, c: number, d: number): void {
    if (this.length + 4 > this.data.length) {
      const n = new Float64Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    const o = this.length;
    this.data[o] = a;
    this.data[o + 1] = b;
    this.data[o + 2] = c;
    this.data[o + 3] = d;
    this.length += 4;
  }
  view(): Float64Array {
    return this.data.subarray(0, this.length);
  }
}

// Scratch for edge intersection results.
const P = new Float64Array(2);

/**
 * Intersect edge (a, b) with plane z = h. Endpoints are ordered lexicographically first,
 * so the two triangles sharing an edge produce bit-identical points.
 */
function edgePoint(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  h: number,
): void {
  if (ax > bx || (ax === bx && (ay > by || (ay === by && az > bz)))) {
    let s = ax;
    ax = bx;
    bx = s;
    s = ay;
    ay = by;
    by = s;
    s = az;
    az = bz;
    bz = s;
  }
  if (az === h) {
    P[0] = ax;
    P[1] = ay;
    return;
  }
  if (bz === h) {
    P[0] = bx;
    P[1] = by;
    return;
  }
  const s = (h - az) / (bz - az);
  P[0] = ax + s * (bx - ax);
  P[1] = ay + s * (by - ay);
}

/**
 * Slice a normalised mesh (z >= 0). Returns one segment buffer per layer
 * (x1, y1, x2, y2 per segment).
 */
export function sliceMesh(pos: Float32Array, plan: LayerPlan): Float64Array[] {
  return runSync(sliceMeshIter(pos, plan));
}

/** Runs a progress generator to completion. */
export function runSync<T>(it: Generator<number, T>): T {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Generator form: yields progress fractions (0..1) every chunk so callers can pause. */
export function* sliceMeshIter(
  pos: Float32Array,
  plan: LayerPlan,
): Generator<number, Float64Array[]> {
  const { n, t, planes } = plan;
  const bufs: FloatBuf[] = [];
  for (let L = 0; L < n; L++) bufs.push(new FloatBuf(256));
  const triCount = pos.length / 9;
  const CHUNK = 20000;

  for (let i = 0; i < triCount; i++) {
    if (i > 0 && i % CHUNK === 0) yield i / triCount;
    const b = i * 9;
    const x0 = pos[b],
      y0 = pos[b + 1],
      z0 = pos[b + 2];
    const x1 = pos[b + 3],
      y1 = pos[b + 4],
      z1 = pos[b + 5];
    const x2 = pos[b + 6],
      y2 = pos[b + 7],
      z2 = pos[b + 8];
    const zmin = Math.min(z0, z1, z2);
    const zmax = Math.max(z0, z1, z2);
    if (zmin === zmax) continue; // flat triangle: never crosses (consistent >= rule)
    const lo = Math.max(0, Math.floor(zmin / t));
    const hi = Math.min(n - 1, Math.floor(zmax / t));
    for (let L = lo; L <= hi; L++) {
      const h = planes[L];
      if (h < zmin || h > zmax) continue;
      const a0 = z0 >= h,
        a1 = z1 >= h,
        a2 = z2 >= h;
      if (a0 === a1 && a1 === a2) continue;
      // Find the edge crossing upward (below -> above) and downward (above -> below)
      // in winding order 0->1->2->0. Segment runs from the downward to the upward crossing.
      let ux = 0,
        uy = 0,
        dx = 0,
        dy = 0;
      if (a0 !== a1) {
        edgePoint(x0, y0, z0, x1, y1, z1, h);
        if (a1) {
          ux = P[0];
          uy = P[1];
        } else {
          dx = P[0];
          dy = P[1];
        }
      }
      if (a1 !== a2) {
        edgePoint(x1, y1, z1, x2, y2, z2, h);
        if (a2) {
          ux = P[0];
          uy = P[1];
        } else {
          dx = P[0];
          dy = P[1];
        }
      }
      if (a2 !== a0) {
        edgePoint(x2, y2, z2, x0, y0, z0, h);
        if (a0) {
          ux = P[0];
          uy = P[1];
        } else {
          dx = P[0];
          dy = P[1];
        }
      }
      if (ux === dx && uy === dy) continue; // degenerate (touches plane at a vertex)
      bufs[L].push4(dx, dy, ux, uy);
    }
  }
  return bufs.map((b) => b.view().slice());
}
