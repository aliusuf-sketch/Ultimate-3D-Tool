/**
 * Raster geometry for insert cavities: item slab projection, Euclidean distance
 * transforms, marching-squares contours and foam-island cleanup. Pixel (i, j) covers
 * [i*res, (i+1)*res) x [j*res, (j+1)*res); its centre is ((i+0.5)*res, (j+0.5)*res).
 */

export interface Grid {
  nx: number;
  ny: number;
  res: number;
}

const BIG = 1e20;

// ---- Slab rasterisation ----

const clipA = new Float64Array(3 * 8);
const clipB = new Float64Array(3 * 8);

/** Sutherland–Hodgman clip of a 3D polygon against z >= h (keepAbove) or z <= h. */
function clipZ(
  src: Float64Array,
  n: number,
  h: number,
  keepAbove: boolean,
  dst: Float64Array,
): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const az = src[i * 3 + 2],
      bz = src[j * 3 + 2];
    const ain = keepAbove ? az >= h : az <= h;
    const bin = keepAbove ? bz >= h : bz <= h;
    if (ain) {
      dst[m * 3] = src[i * 3];
      dst[m * 3 + 1] = src[i * 3 + 1];
      dst[m * 3 + 2] = az;
      m++;
    }
    if (ain !== bin) {
      const t = (h - az) / (bz - az);
      dst[m * 3] = src[i * 3] + t * (src[j * 3] - src[i * 3]);
      dst[m * 3 + 1] = src[i * 3 + 1] + t * (src[j * 3 + 1] - src[i * 3 + 1]);
      dst[m * 3 + 2] = h;
      m++;
    }
  }
  return m;
}

export interface SlabRaster {
  mask: Uint8Array;
  /** Highest / lowest item z per pixel within the slab (-/+Infinity where empty). */
  top: Float32Array;
  bottom: Float32Array;
}

export function newSlab(g: Grid): SlabRaster {
  const n = g.nx * g.ny;
  return {
    mask: new Uint8Array(n),
    top: new Float32Array(n).fill(-Infinity),
    bottom: new Float32Array(n).fill(Infinity),
  };
}

function mark(s: SlabRaster, g: Grid, i: number, j: number, zlo: number, zhi: number): void {
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return;
  const k = j * g.nx + i;
  s.mask[k] = 1;
  if (zhi > s.top[k]) s.top[k] = zhi;
  if (zlo < s.bottom[k]) s.bottom[k] = zlo;
}

/** Fill a convex polygon's projection (pixel centres inside) + its vertices (conservative). */
function fillConvex(p: Float64Array, n: number, g: Grid, s: SlabRaster): void {
  const r = g.res;
  let ymin = Infinity,
    ymax = -Infinity,
    zlo = Infinity,
    zhi = -Infinity;
  for (let k = 0; k < n; k++) {
    const y = p[k * 3 + 1],
      z = p[k * 3 + 2];
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
    if (z < zlo) zlo = z;
    if (z > zhi) zhi = z;
  }
  for (let k = 0; k < n; k++)
    mark(s, g, Math.floor(p[k * 3] / r), Math.floor(p[k * 3 + 1] / r), zlo, zhi);
  const j0 = Math.max(0, Math.ceil(ymin / r - 0.5));
  const j1 = Math.min(g.ny - 1, Math.floor(ymax / r - 0.5));
  for (let j = j0; j <= j1; j++) {
    const yc = (j + 0.5) * r;
    let xl = Infinity,
      xr = -Infinity;
    for (let a = 0; a < n; a++) {
      const b = (a + 1) % n;
      const ya = p[a * 3 + 1],
        yb = p[b * 3 + 1];
      if ((ya <= yc && yb >= yc) || (yb <= yc && ya >= yc)) {
        const xa = p[a * 3],
          xb = p[b * 3];
        const x = ya === yb ? Math.min(xa, xb) : xa + ((yc - ya) / (yb - ya)) * (xb - xa);
        const x2 = ya === yb ? Math.max(xa, xb) : x;
        if (x < xl) xl = x;
        if (x2 > xr) xr = x2;
      }
    }
    const i0 = Math.max(0, Math.ceil(xl / r - 0.5));
    const i1 = Math.min(g.nx - 1, Math.floor(xr / r - 0.5));
    for (let i = i0; i <= i1; i++) mark(s, g, i, j, zlo, zhi);
  }
  // Thin (near-vertical) polygons: also walk the edges so walls are never lost.
  let area = 0;
  for (let a = 0; a < n; a++) {
    const b = (a + 1) % n;
    area += p[a * 3] * p[b * 3 + 1] - p[b * 3] * p[a * 3 + 1];
  }
  if (Math.abs(area) < r * r) {
    for (let a = 0; a < n; a++) {
      const b = (a + 1) % n;
      const dx = p[b * 3] - p[a * 3],
        dy = p[b * 3 + 1] - p[a * 3 + 1];
      const steps = Math.ceil(Math.hypot(dx, dy) / (r * 0.5));
      for (let t = 1; t < steps; t++) {
        const x = p[a * 3] + (dx * t) / steps,
          y = p[a * 3 + 1] + (dy * t) / steps;
        mark(s, g, Math.floor(x / r), Math.floor(y / r), zlo, zhi);
      }
    }
  }
}

/**
 * Rasterise the part of a mesh between z0 and z1 into `s`. Covers the projection of the
 * surface inside the slab; combine with `fillLoops` of the section at z0 for solids.
 */
export function rasterizeSlab(
  pos: Float32Array,
  z0: number,
  z1: number,
  g: Grid,
  s: SlabRaster,
): void {
  const tri = new Float64Array(9);
  for (let t = 0; t < pos.length; t += 9) {
    const za = pos[t + 2],
      zb = pos[t + 5],
      zc = pos[t + 8];
    if (Math.max(za, zb, zc) < z0 || Math.min(za, zb, zc) > z1) continue;
    for (let k = 0; k < 9; k++) tri[k] = pos[t + k];
    let n = clipZ(tri, 3, z0, true, clipA);
    if (n < 3) {
      if (n > 0) fillConvex(clipA, n, g, s);
      continue;
    }
    n = clipZ(clipA, n, z1, false, clipB);
    if (n > 0) fillConvex(clipB, n, g, s);
  }
}

/** Even-odd fill of closed loops (a solid cross-section at height z). */
export function fillLoops(loops: Float64Array[], z: number, g: Grid, s: SlabRaster): void {
  const r = g.res;
  const xs: number[] = [];
  for (let j = 0; j < g.ny; j++) {
    const yc = (j + 0.5) * r;
    xs.length = 0;
    for (const pts of loops) {
      const n = pts.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ya = pts[a * 2 + 1],
          yb = pts[b * 2 + 1];
        if (ya > yc !== yb > yc)
          xs.push(pts[a * 2] + ((yc - ya) / (yb - ya)) * (pts[b * 2] - pts[a * 2]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / r - 0.5));
      const i1 = Math.min(g.nx - 1, Math.floor(xs[k + 1] / r - 0.5));
      for (let i = i0; i <= i1; i++) mark(s, g, i, j, z, z);
    }
  }
}

// ---- Distance transform (Felzenszwalb & Huttenlocher) ----

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Distance (in pixels) from every pixel centre to the nearest pixel where mask = 1. */
export function distanceTransform(mask: Uint8Array, nx: number, ny: number): Float32Array {
  const m = Math.max(nx, ny);
  const f = new Float64Array(m),
    d = new Float64Array(m),
    z = new Float64Array(m + 1);
  const v = new Int32Array(m);
  const tmp = new Float64Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = mask[j * nx + i] ? 0 : BIG;
    edt1d(f, ny, d, v, z);
    for (let j = 0; j < ny; j++) tmp[j * nx + i] = d[j];
  }
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = tmp[j * nx + i];
    edt1d(f, nx, d, v, z);
    for (let i = 0; i < nx; i++) out[j * nx + i] = Math.sqrt(d[i]);
  }
  return out;
}

// ---- Foam islands ----

/**
 * Foam = field > 0. Foam regions not connected to the grid border are islands (loose
 * pieces inside a cavity). Islands smaller than `minArea` (mm²) become cavity.
 * Returns the number of islands kept.
 */
export function removeSmallIslands(field: Float32Array, g: Grid, minArea: number): number {
  const { nx, ny, res } = g;
  const seen = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const flood = (start: number, collect: number[] | null) => {
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      collect?.push(k);
      const i = k % nx,
        j = (k - i) / nx;
      const nb = [
        i > 0 ? k - 1 : -1,
        i < nx - 1 ? k + 1 : -1,
        j > 0 ? k - nx : -1,
        j < ny - 1 ? k + nx : -1,
      ];
      for (const q of nb) {
        if (q >= 0 && !seen[q] && field[q] > 0) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
  };
  for (let i = 0; i < nx; i++) {
    for (const k of [i, (ny - 1) * nx + i]) if (!seen[k] && field[k] > 0) flood(k, null);
  }
  for (let j = 0; j < ny; j++) {
    for (const k of [j * nx, j * nx + nx - 1]) if (!seen[k] && field[k] > 0) flood(k, null);
  }
  let kept = 0;
  const comp: number[] = [];
  for (let k = 0; k < nx * ny; k++) {
    if (seen[k] || field[k] <= 0) continue;
    comp.length = 0;
    flood(k, comp);
    if (comp.length * res * res < minArea) for (const q of comp) field[q] = -res;
    else kept++;
  }
  return kept;
}

// ---- Marching squares ----

/**
 * Zero-level contour of a field sampled at pixel centres (negative = inside). The grid is
 * padded with a positive border so every contour closes. Returns segments (x1,y1,x2,y2).
 */
export function contourField(field: Float32Array, g: Grid): Float64Array {
  const { nx, ny, res } = g;
  const PAD = res * 4;
  const val = (i: number, j: number) =>
    i < 0 || j < 0 || i >= nx || j >= ny ? PAD : field[j * nx + i];
  const out: number[] = [];
  // Interpolated crossing on an axis-aligned edge; endpoints always passed low-index first.
  const px = (
    i1: number,
    j1: number,
    v1: number,
    i2: number,
    j2: number,
    v2: number,
  ): [number, number] => {
    const t = v1 / (v1 - v2);
    return [(i1 + t * (i2 - i1) + 0.5) * res, (j1 + t * (j2 - j1) + 0.5) * res];
  };
  for (let j = -1; j < ny; j++) {
    for (let i = -1; i < nx; i++) {
      const a = val(i, j),
        b = val(i + 1, j),
        c = val(i + 1, j + 1),
        d = val(i, j + 1);
      const code = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const E = () => px(i, j, a, i + 1, j, b); // bottom
      const R = () => px(i + 1, j, b, i + 1, j + 1, c); // right
      const T = () => px(i, j + 1, d, i + 1, j + 1, c); // top
      const L = () => px(i, j, a, i, j + 1, d); // left
      const seg = (p: [number, number], q: [number, number]) => out.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1:
        case 14:
          seg(L(), E());
          break;
        case 2:
        case 13:
          seg(E(), R());
          break;
        case 3:
        case 12:
          seg(L(), R());
          break;
        case 4:
        case 11:
          seg(R(), T());
          break;
        case 6:
        case 9:
          seg(E(), T());
          break;
        case 7:
        case 8:
          seg(L(), T());
          break;
        case 5:
        case 10: {
          const centreIn = (a + b + c + d) / 4 < 0;
          if ((code === 5) === centreIn) {
            seg(L(), T());
            seg(E(), R());
          } else {
            seg(L(), E());
            seg(R(), T());
          }
          break;
        }
      }
    }
  }
  return Float64Array.from(out);
}

/** 3x3 box blur of a field (smooths raster stair-steps before contouring). */
export function blurField(field: Float32Array, g: Grid): void {
  const { nx, ny } = g;
  const tmp = new Float32Array(field.length);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      tmp[k] = (field[i > 0 ? k - 1 : k] + field[k] + field[i < nx - 1 ? k + 1 : k]) / 3;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      field[k] = (tmp[j > 0 ? k - nx : k] + tmp[k] + tmp[j < ny - 1 ? k + nx : k]) / 3;
    }
  }
}
