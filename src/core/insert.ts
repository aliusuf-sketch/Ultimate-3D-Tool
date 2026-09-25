/**
 * Shipping-insert planner: fills a box with laser-cut foam layers that hold an item.
 *
 * Layers are cut straight through, so a layer's cavity must contain every part of the item
 * that has to pass through it. In two-part mode the stack is split at a parting boundary:
 * base layers are stacked first and the item dropped in (cavity = union of item sections
 * from the item bottom up to the layer top); lid layers are lowered over it (cavity = union
 * from the layer bottom up to the item top). No undercuts, so rigid prints fit.
 */
import type { Mesh, SlicedLayer, StackAxis } from '../types';
import { chainSegments } from './chain';
import {
  blurField,
  contourField,
  distanceTransform,
  fillLoops,
  newSlab,
  rasterizeSlab,
  removeSmallIslands,
  type Grid,
  type SlabRaster,
} from './raster';
import { simplifyLoop } from './simplify';
import { runSync, sliceMesh } from './slice';
import { buildTopology } from './topology';
import { computeBBox, transformMesh } from './transform';

export type InsertMode = 'topLoad' | 'twoPart' | 'contour';
export type LayerRole = 'base' | 'lid' | 'layer';

export interface InsertSettings {
  axis: StackAxis;
  turn90: boolean;
  flip: boolean;
  /** Per-axis scale of the STL in its own frame (X, Y, Z as loaded), 1 = 100 %. */
  scale?: [number, number, number];
  box: [number, number, number]; // inner L, W, H (mm)
  thicknesses: number[]; // available sheet thicknesses (mm)
  layering: 'fewest' | 'finest';
  compress: number; // mm the stack may exceed the box height (foam compresses)
  fitOversize: number; // mm added on each side of the layer outline
  clearance: number; // mm gap around the item
  preload: number; // mm the item may press into the layer above/below (foam compresses)
  minCushion: number; // mm of foam wanted on every side
  mode: InsertMode;
  parting: number; // number of base layers; 0 = auto
  placement: 'auto' | 'center';
  notches: boolean;
  notchDiameter: number;
  minIsland: number; // mm²; smaller loose foam pieces are removed
  tolerance: number; // contour simplification (mm)
  resolution: number; // raster pixel (mm); 0 = auto
}

export interface InsertPlan {
  seq: number[]; // thickness per layer, bottom -> top (mm)
  itemZ: number; // item bottom (mm from stack bottom)
  fillError: number; // stack height - box height (mm, + = compressed)
  topGap: number; // flat gap between item top and the next boundary (mm)
}

export interface InsertResult {
  layers: SlicedLayer[];
  roles: LayerRole[];
  thickness: number[];
  baseCount: number; // layers [0, baseCount) are the base
  topLoad: boolean; // open-top pocket: the item lifts out of the top
  rect: [number, number]; // layer outline size (mm)
  stackHeight: number;
  itemSize: [number, number, number];
  itemOffset: [number, number, number];
  item: Float32Array; // item triangles positioned in layer coordinates
  ghosts: Float64Array[][]; // per layer: item outline inside that layer (no clearance)
  report: InsertReport;
}

export interface InsertReport {
  fits: boolean;
  sideWall: number; // min foam between cavity and box wall (mm)
  bottomCushion: number; // solid foam below the item (mm)
  topCushion: number; // solid foam above the item (mm)
  playUp: number; // how far the item can lift before touching foam (mm)
  playDown: number;
  fillError: number;
  cavityVolume: number; // mm³
  foamVolume: number; // mm³ of foam in the layers (after cutting)
  islands: number; // loose foam pieces kept (glue these in)
  preloaded: number; // mm the item presses into the foam above
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Orientation

/** Rotate the item so the chosen axis is up, optionally turn 90° about Z / flip over. */
export function orientItem(
  mesh: Mesh,
  axis: StackAxis,
  turn90: boolean,
  flip: boolean,
  scale: [number, number, number] = [1, 1, 1],
) {
  // Scale is given in the STL's own frame; permute it into the oriented frame.
  const [a, b, c] = scale;
  const k: [number, number, number] =
    axis === 'y' ? [a, c, b] : axis === 'x' ? [c, b, a] : [a, b, c];
  const p = transformMesh(mesh, axis, k).mesh.positions;
  if (turn90 || flip) {
    for (let i = 0; i < p.length; i += 3) {
      let x = p[i],
        y = p[i + 1],
        z = p[i + 2];
      if (turn90) {
        const t = x;
        x = -y;
        y = t;
      }
      if (flip) {
        y = -y;
        z = -z;
      } // 180° about X (proper rotation)
      p[i] = x;
      p[i + 1] = y;
      p[i + 2] = z;
    }
  }
  const bb = computeBBox(p);
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= bb.min[0];
    p[i + 1] -= bb.min[1];
    p[i + 2] -= bb.min[2];
  }
  const size: [number, number, number] = [
    bb.max[0] - bb.min[0],
    bb.max[1] - bb.min[1],
    bb.max[2] - bb.min[2],
  ];
  return { positions: p, size };
}

// ---------------------------------------------------------------------------
// Stack planning

const U = 10; // planning units per mm (0.1 mm)

/**
 * Choose sheet thicknesses and their order plus the item height so that the stack fills
 * the box, the item rests on a layer boundary and its top lands as close as possible
 * under another boundary (less vertical play).
 */
export function planStack(
  H: number,
  itemH: number,
  thicknesses: number[],
  opts: {
    compress: number;
    minCushion: number;
    layering: 'fewest' | 'finest';
    placement: 'auto' | 'center';
    preload?: number;
  },
): InsertPlan {
  const ts = [...new Set(thicknesses.filter((t) => t > 0).map((t) => Math.round(t * U)))].sort(
    (a, b) => b - a,
  );
  if (!ts.length) throw new Error('Enable at least one foam thickness');
  const HU = Math.round(H * U);
  const maxU = HU + Math.round(Math.max(0, opts.compress) * U);
  const maxLayers = 40;

  // Enumerate count vectors whose total is near the box height.
  const vectors: { counts: number[]; sum: number; n: number }[] = [];
  const counts = new Array(ts.length).fill(0);
  const rec = (k: number, sum: number, n: number) => {
    if (k === ts.length) {
      if (n > 0 && sum > HU - ts[0] - 1) vectors.push({ counts: counts.slice(), sum, n });
      return;
    }
    for (let c = 0; n + c <= maxLayers && sum + c * ts[k] <= maxU; c++) {
      counts[k] = c;
      rec(k + 1, sum + c * ts[k], n + c);
    }
    counts[k] = 0;
  };
  rec(0, 0, 0);
  if (!vectors.length) throw new Error('Box is too tall for 40 layers of the chosen foam');

  // Fill error: compression within budget is fine; any shortfall is a gap (bad).
  const fillCost = (sum: number) => (sum >= HU ? (sum - HU) / U : ((HU - sum) / U) * 20);
  const bestFill = Math.min(...vectors.map((v) => Math.round(fillCost(v.sum) * 2)));
  const pool = vectors.filter((v) => Math.round(fillCost(v.sum) * 2) === bestFill);

  const hU = itemH * U;
  const cushU = opts.minCushion * U;
  const preU = (opts.preload ?? 0) * U;
  let best: { key: number[]; plan: InsertPlan } | null = null;
  let budget = 60000;

  const evaluate = (seq: number[], sum: number) => {
    const B = [0];
    for (const t of seq) B.push(B[B.length - 1] + t);
    const cands: number[] = [];
    if (opts.placement === 'center') cands.push((sum - hU) / 2);
    else for (const b of B) if (b + hU <= sum) cands.push(b);
    for (const o of cands) {
      const top = o + hU;
      let next = sum;
      for (const b of B) if (b >= top - 1e-6 && b < next) next = b;
      let gap = (next - top) / U;
      // Item top pressing slightly into the layer above counts as a snug fit.
      if (B.some((b) => b < top && top - b <= preU + 1e-6)) gap = 0;
      const botC = o / U,
        topC = (sum - top) / U;
      const cushionShort = Math.max(0, cushU / U - botC) + Math.max(0, cushU / U - topC);
      const n = seq.length;
      const key = [
        Math.round(cushionShort * 2), // meet the cushion first
        Math.round(gap * 2), // then minimise vertical play
        opts.layering === 'fewest' ? n : -n,
        Math.round(Math.abs(botC - topC)), // balanced cushions
      ];
      if (!best || lexLess(key, best.key)) {
        best = {
          key,
          plan: {
            seq: seq.map((t) => t / U),
            itemZ: o / U,
            fillError: (sum - HU) / U,
            topGap: gap,
          },
        };
      }
    }
  };

  for (const v of pool) {
    // Alternating arrangement (thick sheets outside, thin around the item) always tried.
    const sorted: number[] = [];
    v.counts.forEach((c, k) => {
      for (let i = 0; i < c; i++) sorted.push(ts[k]);
    });
    const left: number[] = [],
      right: number[] = [];
    sorted.forEach((t, i) => (i % 2 === 0 ? left.push(t) : right.unshift(t)));
    evaluate(left.concat(right), v.sum);
    // Then every distinct permutation while the budget lasts.
    const c = v.counts.slice();
    const seq: number[] = [];
    const perm = () => {
      if (budget <= 0) return;
      if (seq.length === v.n) {
        budget--;
        evaluate(seq, v.sum);
        return;
      }
      for (let k = 0; k < ts.length; k++) {
        if (!c[k]) continue;
        c[k]--;
        seq.push(ts[k]);
        perm();
        seq.pop();
        c[k]++;
      }
    };
    perm();
  }
  return best!.plan;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// ---------------------------------------------------------------------------
// Box presets

export const BOX_PRESETS_IN: [number, number, number][] = [
  [4, 4, 4],
  [6, 4, 4],
  [6, 6, 4],
  [6, 6, 6],
  [8, 6, 4],
  [8, 6, 6],
  [8, 8, 4],
  [8, 8, 6],
  [8, 8, 8],
  [10, 8, 4],
  [10, 8, 6],
  [10, 8, 8],
  [10, 10, 6],
  [10, 10, 10],
  [12, 9, 4],
  [12, 9, 6],
  [12, 10, 8],
  [12, 12, 6],
  [12, 12, 8],
  [12, 12, 12],
  [14, 10, 6],
  [14, 12, 8],
  [14, 14, 10],
  [14, 14, 14],
  [16, 12, 8],
  [16, 12, 12],
  [16, 16, 8],
  [16, 16, 16],
  [18, 12, 12],
  [18, 18, 12],
  [18, 18, 18],
  [20, 16, 12],
  [20, 20, 12],
  [20, 20, 20],
  [24, 18, 12],
  [24, 18, 18],
  [24, 24, 24],
];

export const ORIENTATIONS: { axis: StackAxis; turn90: boolean }[] = [
  { axis: 'z', turn90: false },
  { axis: 'z', turn90: true },
  { axis: 'y', turn90: false },
  { axis: 'y', turn90: true },
  { axis: 'x', turn90: false },
  { axis: 'x', turn90: true },
];

/** Item extents for each orientation from its source bbox size. */
export function orientedDims(
  src: [number, number, number],
  axis: StackAxis,
  turn90: boolean,
): [number, number, number] {
  const [x, y, z] = src;
  const d: [number, number, number] =
    axis === 'y' ? [x, z, y] : axis === 'x' ? [z, y, x] : [x, y, z];
  return turn90 ? [d[1], d[0], d[2]] : d;
}

/** Worst-side cushion of an item (dims) in a box. */
export function fitMargin(
  dims: [number, number, number],
  box: [number, number, number],
  clearance: number,
): number {
  return (
    Math.min((box[0] - dims[0]) / 2, (box[1] - dims[1]) / 2, (box[2] - dims[2]) / 2) - clearance
  );
}

/** Orientation that leaves the most foam on its thinnest side. */
export function bestOrientation(
  src: [number, number, number],
  box: [number, number, number],
  clearance: number,
) {
  let best = ORIENTATIONS[0],
    bestM = -Infinity;
  for (const o of ORIENTATIONS) {
    const m = fitMargin(orientedDims(src, o.axis, o.turn90), box, clearance);
    if (m > bestM + 1e-6) {
      bestM = m;
      best = o;
    }
  }
  return { ...best, margin: bestM };
}

/** Smallest preset box (by volume) giving at least `cushion` on every side. */
export function smallestBox(src: [number, number, number], cushion: number, clearance: number) {
  const IN = 25.4;
  let best: {
    box: [number, number, number];
    axis: StackAxis;
    turn90: boolean;
    volume: number;
  } | null = null;
  for (const b of BOX_PRESETS_IN) {
    const box = b.map((v) => v * IN) as [number, number, number];
    for (const o of ORIENTATIONS) {
      // Boxes can be used on any side; the preset lists L >= W, H is free.
      if (fitMargin(orientedDims(src, o.axis, o.turn90), box, clearance) >= cushion) {
        const volume = box[0] * box[1] * box[2];
        if (!best || volume < best.volume) best = { box, ...o, volume };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Layer construction

function sectionLoops(pos: Float32Array, h: number): Float64Array[] {
  const segs = sliceMesh(pos, { n: 1, t: Infinity, H: Infinity, planes: Float64Array.of(h) })[0];
  return chainSegments(segs).loops;
}

function orInto(dst: Uint8Array, src: Uint8Array): void {
  for (let k = 0; k < dst.length; k++) dst[k] |= src[k];
}

function countOn(m: Uint8Array): number {
  let c = 0;
  for (let k = 0; k < m.length; k++) c += m[k];
  return c;
}

export function buildInsert(mesh: Mesh, s: InsertSettings): InsertResult {
  return runSync(buildInsertIter(mesh, s));
}

export function* buildInsertIter(mesh: Mesh, s: InsertSettings): Generator<number, InsertResult> {
  const warnings: string[] = [];
  const { positions, size } = orientItem(mesh, s.axis, s.turn90, s.flip, s.scale);
  const [L, W, H] = s.box;
  if (size[2] > H)
    throw new Error(`Item is ${fmt(size[2])} mm tall but the box is only ${fmt(H)} mm deep`);
  if (size[0] + 2 * s.clearance >= L || size[1] + 2 * s.clearance >= W) {
    throw new Error(
      `Item footprint ${fmt(size[0])} × ${fmt(size[1])} mm doesn't fit a ${fmt(L)} × ${fmt(W)} mm box — try another orientation or a bigger box`,
    );
  }

  const plan = planStack(H, size[2], s.thicknesses, s);
  const seq = plan.seq;
  const n = seq.length;
  const B = [0];
  for (const t of seq) B.push(B[B.length - 1] + t);
  const S = B[n];

  // Layer outline and item placement (centred in XY).
  const fit = s.fitOversize;
  const rect: [number, number] = [L + 2 * fit, W + 2 * fit];
  const off: [number, number, number] = [
    (rect[0] - size[0]) / 2,
    (rect[1] - size[1]) / 2,
    plan.itemZ,
  ];
  const item = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    item[i] = positions[i] + off[0];
    item[i + 1] = positions[i + 1] + off[1];
    item[i + 2] = positions[i + 2] + off[2];
  }
  yield 0.05;

  // Raster grid over the layer outline.
  const res =
    s.resolution > 0 ? s.resolution : Math.max(0.3, Math.sqrt((rect[0] * rect[1]) / 300000));
  const g: Grid = { nx: Math.ceil(rect[0] / res), ny: Math.ceil(rect[1] / res), res };

  // A top that pokes at most `preload` into a layer compresses it instead of cutting it.
  let itemTop = off[2] + size[2];
  let preloaded = 0;
  for (const b of B) {
    if (b > off[2] && b < itemTop && itemTop - b <= s.preload + 1e-6) {
      preloaded = itemTop - b;
      itemTop = b;
      break;
    }
  }

  // Item presence per layer slab.
  const eps = 1e-4;
  const slabs: SlabRaster[] = [];
  for (let i = 0; i < n; i++) {
    const sl = newSlab(g);
    const z0 = B[i],
      z1 = B[i + 1];
    if (z1 > off[2] + eps && z0 < itemTop - eps) {
      rasterizeSlab(item, z0, z1, g, sl);
      const zc = Math.max(z0, off[2]) + eps;
      fillLoops(sectionLoops(item, zc), zc, g, sl);
    }
    slabs.push(sl);
    yield 0.05 + (0.35 * (i + 1)) / n;
  }
  const occupied = slabs.map((sl) => countOn(sl.mask) > 0);
  const first = occupied.indexOf(true);
  const last = occupied.lastIndexOf(true);

  // Cavity masks.
  const cav: Uint8Array[] = slabs.map(() => new Uint8Array(g.nx * g.ny));
  let baseCount: number;
  const roles: LayerRole[] = [];
  if (s.mode === 'contour') {
    slabs.forEach((sl, i) => cav[i].set(sl.mask));
    for (let i = 0; i < n; i++) roles.push('layer');
    baseCount = Math.min(n, last + 1);
  } else {
    const pre = slabs.map(() => new Uint8Array(g.nx * g.ny));
    const suf = slabs.map(() => new Uint8Array(g.nx * g.ny));
    for (let i = 0; i < n; i++) {
      if (i > 0) pre[i].set(pre[i - 1]);
      orInto(pre[i], slabs[i].mask);
    }
    for (let i = n - 1; i >= 0; i--) {
      if (i < n - 1) suf[i].set(suf[i + 1]);
      orInto(suf[i], slabs[i].mask);
    }
    const preA = pre.map(countOn),
      sufA = suf.map(countOn);
    const excess = (k: number) => {
      let v = 0;
      for (let i = 0; i < n; i++) v += seq[i] * (i < k ? preA[i] : sufA[i]);
      return v;
    };
    if (s.mode === 'topLoad') {
      // One open-top pocket: every layer the item touches widens upward, so the item
      // lifts straight out of the top; the layers above it are solid lid pads.
      baseCount = Math.max(1, last + 1);
    } else if (s.parting > 0) {
      baseCount = Math.min(n - 1, Math.max(1, Math.round(s.parting)));
    } else {
      // Parting boundaries inside the item span; least wasted cavity wins, then the middle.
      let bestK = first + 1,
        bestV = Infinity;
      const mid = (first + last + 1) / 2;
      for (let k = first + 1; k <= Math.max(first + 1, last); k++) {
        const v = excess(k);
        if (
          v < bestV * 0.999 ||
          (Math.abs(v - bestV) <= bestV * 0.001 && Math.abs(k - mid) < Math.abs(bestK - mid))
        ) {
          bestV = v;
          bestK = k;
        }
      }
      baseCount = Math.min(n, bestK);
    }
    for (let i = 0; i < n; i++) {
      cav[i].set(i < baseCount ? pre[i] : suf[i]);
      roles.push(i < baseCount ? 'base' : 'lid');
    }
  }
  yield 0.45;

  // Finger notches: in the upper base layers, both sides across the item's narrow width.
  const notches: { x: number; y: number; r: number; fromZ: number }[] = [];
  if (s.notches && s.mode !== 'contour' && baseCount > first) {
    const r = s.notchDiameter / 2;
    const alongX = size[0] >= size[1];
    const cx = off[0] + size[0] / 2,
      cy = off[1] + size[1] / 2;
    const top = cav[baseCount - 1];
    for (const dir of [-1, 1]) {
      // Walk outward from the centre until leaving the cavity footprint.
      let x = cx,
        y = cy;
      for (let step = 0; step < 100000; step++) {
        const i = Math.floor(x / res),
          j = Math.floor(y / res);
        if (i < 0 || j < 0 || i >= g.nx || j >= g.ny || !top[j * g.nx + i]) break;
        if (alongX) y += dir * res * 0.5;
        else x += dir * res * 0.5;
      }
      const edge = s.clearance + r * 0.35;
      const nx2 = alongX ? x : x + dir * edge,
        ny2 = alongX ? y + dir * edge : y;
      // Keep the notch inside the outline with some wall left.
      const wall = Math.min(nx2 - r, rect[0] - nx2 - r, ny2 - r, rect[1] - ny2 - r);
      if (wall > 3) {
        // Top-loading pockets get deeper notches so fingers reach the item's sides.
        const reach = s.notchDiameter * (s.mode === 'topLoad' ? 2.5 : 1.5);
        const depth = Math.min((B[baseCount] - off[2]) * 0.6, reach);
        notches.push({ x: nx2, y: ny2, r, fromZ: B[baseCount] - Math.max(depth, 1) });
      } else {
        warnings.push('Not enough side wall for finger notches');
        break;
      }
    }
  }

  // Contours per layer.
  const c = s.clearance + res * 0.5;
  const tol = Math.max(s.tolerance, res * 0.4);
  const layers: SlicedLayer[] = [];
  const ghosts: Float64Array[][] = [];
  const foamMasks: Uint8Array[] = [];
  let islands = 0,
    cavityVolume = 0,
    foamVolume = 0;
  const outline = Float64Array.from([0, 0, rect[0], 0, rect[0], rect[1], 0, rect[1]]);
  for (let i = 0; i < n; i++) {
    const z0 = B[i],
      z1 = B[i + 1];
    const loops: Float64Array[] = [outline];
    const foam = new Uint8Array(g.nx * g.ny).fill(1);
    const hasNotch =
      notches.length &&
      i < baseCount &&
      z1 > notches[0].fromZ &&
      occupied.slice(0, i + 1).some(Boolean);
    if (countOn(cav[i]) > 0 || hasNotch) {
      const d = distanceTransform(cav[i], g.nx, g.ny);
      const field = new Float32Array(g.nx * g.ny);
      for (let k = 0; k < field.length; k++) field[k] = cav[i][k] ? -c : d[k] * res - c;
      if (hasNotch) {
        for (const nt of notches) {
          for (let j = 0; j < g.ny; j++) {
            for (let q = 0; q < g.nx; q++) {
              const k = j * g.nx + q;
              const dd = Math.hypot((q + 0.5) * res - nt.x, (j + 0.5) * res - nt.y) - nt.r;
              if (dd < field[k]) field[k] = dd;
            }
          }
        }
      }
      blurField(field, g);
      islands += removeSmallIslands(field, g, s.minIsland);
      for (let k = 0; k < field.length; k++) if (field[k] < 0) foam[k] = 0;
      const { loops: raw } = chainSegments(contourField(field, g));
      for (const l of raw) loops.push(simplifyLoop(l, tol));
    }
    foamMasks.push(foam);
    const topo = buildTopology(loops);
    const solidArea = topo.reduce((a, l) => a + l.area, 0);
    foamVolume += solidArea * (z1 - z0);
    cavityVolume += (rect[0] * rect[1] - solidArea) * (z1 - z0);
    layers.push({ index: i, z0, z1, plane: (z0 + z1) / 2, loops: topo, open: [] });

    // Ghost: the item's own outline within this layer (no clearance), for the 2D view.
    if (occupied[i]) {
      const dg = distanceTransform(slabs[i].mask, g.nx, g.ny);
      const fg = new Float32Array(g.nx * g.ny);
      for (let k = 0; k < fg.length; k++)
        fg[k] = slabs[i].mask[k] ? -res * 0.5 : dg[k] * res - res * 0.5;
      ghosts.push(chainSegments(contourField(fg, g)).loops.map((l) => simplifyLoop(l, tol)));
    } else ghosts.push([]);
    yield 0.45 + (0.45 * (i + 1)) / n;
  }

  // Vertical play: how far the item moves before any column meets foam that sits closer
  // than the design clearance (i.e. where the cavity narrows or a solid layer begins).
  const near = Math.max(0, s.clearance - res);
  const blocked = foamMasks.map((f) => {
    const d = distanceTransform(f, g.nx, g.ny);
    const b = new Uint8Array(f.length);
    for (let k = 0; k < f.length; k++) b[k] = d[k] * res <= near ? 1 : 0;
    return b;
  });
  const N = g.nx * g.ny;
  let playUp = S - (off[2] + size[2]);
  let playDown = off[2];
  const runTop = new Float32Array(N).fill(-Infinity);
  for (let j = 0; j < n; j++) {
    if (j > 0) {
      const t = slabs[j - 1].top;
      for (let k = 0; k < N; k++) if (t[k] > runTop[k]) runTop[k] = t[k];
    }
    const b = blocked[j];
    for (let k = 0; k < N; k++)
      if (b[k] && runTop[k] > -Infinity) playUp = Math.min(playUp, B[j] - runTop[k]);
  }
  const runBot = new Float32Array(N).fill(Infinity);
  for (let j = n - 1; j >= 0; j--) {
    if (j < n - 1) {
      const t = slabs[j + 1].bottom;
      for (let k = 0; k < N; k++) if (t[k] < runBot[k]) runBot[k] = t[k];
    }
    const b = blocked[j];
    for (let k = 0; k < N; k++)
      if (b[k] && runBot[k] < Infinity) playDown = Math.min(playDown, runBot[k] - B[j + 1]);
  }
  playUp = preloaded > 0 ? 0 : Math.max(0, playUp);
  playDown = Math.max(0, playDown);
  yield 0.97;

  // Report.
  const sideWall = Math.min((L - size[0]) / 2, (W - size[1]) / 2) - s.clearance;
  const bottomCushion = first >= 0 ? B[first] : 0;
  const topCushion = last >= 0 ? S - B[last + 1] : 0;
  if (sideWall < s.minCushion - 0.05)
    warnings.push(
      `Side walls are ${fmt(sideWall)} mm — less than the ${fmt(s.minCushion)} mm cushion`,
    );
  if (bottomCushion < s.minCushion - 0.05)
    warnings.push(`Only ${fmt(bottomCushion)} mm of solid foam under the item`);
  if (topCushion < s.minCushion - 0.05)
    warnings.push(`Only ${fmt(topCushion)} mm of solid foam above the item`);
  if (plan.fillError < -0.5)
    warnings.push(
      `Stack is ${fmt(-plan.fillError)} mm short of the box height — add a thinner sheet`,
    );
  if (plan.fillError > s.compress + 0.05)
    warnings.push(`Stack is ${fmt(plan.fillError)} mm taller than the box`);
  if (playUp + playDown > 3) {
    warnings.push(
      `Item can move ${fmt(playUp + playDown)} mm up/down — add a thinner foam option (e.g. ¼ in), let the item press that much into the foam, or try another orientation`,
    );
  }
  if (s.mode === 'topLoad' && last === n - 1)
    warnings.push('Item reaches the top of the stack — no lid pad above it; use a deeper box');
  if (s.mode === 'twoPart' && first === last)
    warnings.push('Item sits inside a single layer; lid/base split is at its top');

  return {
    layers,
    roles,
    thickness: seq,
    baseCount,
    topLoad: s.mode === 'topLoad',
    rect,
    stackHeight: S,
    itemSize: size,
    itemOffset: off,
    item,
    ghosts,
    report: {
      fits: true,
      sideWall,
      bottomCushion,
      topCushion,
      playUp,
      playDown,
      fillError: plan.fillError,
      cavityVolume,
      foamVolume,
      islands,
      preloaded,
      warnings,
    },
  };
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

/**
 * Rank orientations for a box: those giving the full cushion first, then the least
 * vertical play (flat top gap from the stack plan), then the most side foam.
 */
export function rankOrientations(src: [number, number, number], s: InsertSettings) {
  const out = ORIENTATIONS.map((o) => {
    const dims = orientedDims(src, o.axis, o.turn90);
    const margin = fitMargin(dims, s.box, s.clearance);
    let gap = Infinity;
    if (margin >= 0 && s.thicknesses.length) {
      try {
        gap = planStack(s.box[2], dims[2], s.thicknesses, s).topGap;
      } catch {
        gap = Infinity;
      }
    }
    return { ...o, margin, gap };
  });
  out.sort(
    (a, b) =>
      Number(b.margin >= s.minCushion) - Number(a.margin >= s.minCushion) ||
      Math.round(a.gap * 2) - Math.round(b.gap * 2) ||
      b.margin - a.margin,
  );
  return out;
}
