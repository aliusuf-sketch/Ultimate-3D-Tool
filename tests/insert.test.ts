import { describe, expect, it } from 'vitest';
import {
  buildInsert,
  orientItem,
  planStack,
  smallestBox,
  type InsertSettings,
} from '../src/core/insert';
import { contourField, distanceTransform } from '../src/core/raster';
import { chainSegments } from '../src/core/chain';
import { makeBox, makeVase } from '../src/core/sample';
import { signedArea } from '../src/core/topology';

const IN = 25.4;

const base: InsertSettings = {
  axis: 'z',
  turn90: false,
  flip: false,
  box: [8 * IN, 8 * IN, 6 * IN],
  thicknesses: [IN, 2 * IN],
  layering: 'fewest',
  compress: 3,
  fitOversize: 0,
  clearance: 1,
  preload: 1.5,
  minCushion: IN,
  mode: 'twoPart',
  parting: 0,
  placement: 'auto',
  notches: false,
  notchDiameter: 25,
  minIsland: 400,
  tolerance: 0.1,
  resolution: 0.5,
};

describe('stack planning', () => {
  it('fills the box height exactly when possible', () => {
    const p = planStack(6 * IN, 50, [IN, 2 * IN, 3 * IN], {
      compress: 3,
      minCushion: IN,
      layering: 'fewest',
      placement: 'auto',
    });
    expect(p.seq.reduce((a, b) => a + b, 0)).toBeCloseTo(6 * IN, 5);
    expect(p.fillError).toBeCloseTo(0, 5);
  });

  it('rests the item on a boundary and prefers a small top gap', () => {
    // 2-inch item with 1-inch sheets: a boundary sits exactly on its top.
    const p = planStack(6 * IN, 2 * IN, [IN, 2 * IN], {
      compress: 3,
      minCushion: IN,
      layering: 'fewest',
      placement: 'auto',
    });
    const B = [0];
    for (const t of p.seq) B.push(B[B.length - 1] + t);
    expect(B.some((b) => Math.abs(b - p.itemZ) < 1e-6)).toBe(true);
    expect(p.topGap).toBeCloseTo(0, 5);
    expect(p.itemZ).toBeGreaterThanOrEqual(IN - 1e-6);
  });

  it('uses more layers when asked for the finest fit', () => {
    const o = { compress: 3, minCushion: IN, placement: 'auto' as const };
    const few = planStack(6 * IN, 50, [IN, 2 * IN], { ...o, layering: 'fewest' });
    const fine = planStack(6 * IN, 50, [IN, 2 * IN], { ...o, layering: 'finest' });
    expect(fine.seq.length).toBeGreaterThan(few.seq.length);
  });
});

describe('raster contours', () => {
  it('distance field contour of a square mask is a closed loop of the dilated size', () => {
    const nx = 40,
      ny = 40,
      res = 1;
    const m = new Uint8Array(nx * ny);
    for (let j = 10; j < 30; j++) for (let i = 10; i < 30; i++) m[j * nx + i] = 1;
    const d = distanceTransform(m, nx, ny);
    const f = new Float32Array(nx * ny);
    for (let k = 0; k < f.length; k++) f[k] = m[k] ? -2.5 : d[k] * res - 2.5;
    const { loops, open } = chainSegments(contourField(f, { nx, ny, res }));
    expect(open).toHaveLength(0);
    expect(loops).toHaveLength(1);
    // 20 mm square + ~2 mm clearance each side (rounded corners) ≈ 24² minus corners.
    const a = Math.abs(signedArea(loops[0]));
    expect(a).toBeGreaterThan(540);
    expect(a).toBeLessThan(580);
  });
});

describe('insert builder', () => {
  it('cuts a box item into a rectangle-with-hole in the layers it occupies', () => {
    const item = makeBox(100, 60, 2 * IN);
    const r = buildInsert(item, base);
    const total = r.thickness.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(6 * IN, 5);
    const withHole = r.layers.filter((l) => l.loops.length > 1);
    expect(withHole.length).toBeGreaterThanOrEqual(1);
    for (const l of withHole) {
      expect(l.loops[0].depth).toBe(0);
      expect(l.loops[1].depth).toBe(1);
      const [x0, y0, x1, y1] = l.loops[1].bbox;
      expect(x1 - x0).toBeGreaterThan(100 + 1.5);
      expect(x1 - x0).toBeLessThan(100 + 4);
      expect(y1 - y0).toBeGreaterThan(60 + 1.5);
      expect(y1 - y0).toBeLessThan(60 + 4);
    }
    expect(r.report.bottomCushion).toBeGreaterThanOrEqual(IN - 1e-6);
    expect(r.report.topCushion).toBeGreaterThanOrEqual(IN - 1e-6);
    expect(r.report.playUp + r.report.playDown).toBeLessThan(1);
    expect(r.report.sideWall).toBeCloseTo((8 * IN - 100) / 2 - 1, 5);
  });

  it('two-part cavities have no undercuts for a vase (base grows upward, lid shrinks)', () => {
    const r = buildInsert(makeVase(), {
      ...base,
      box: [8 * IN, 8 * IN, 10 * IN],
      thicknesses: [IN],
    });
    const cavArea = (i: number) =>
      r.layers[i].loops.filter((l) => l.depth % 2 === 1).reduce((a, l) => a - l.area, 0);
    for (let i = 1; i < r.baseCount; i++)
      expect(cavArea(i)).toBeGreaterThanOrEqual(cavArea(i - 1) - 1);
    for (let i = r.baseCount + 1; i < r.layers.length; i++)
      expect(cavArea(i)).toBeLessThanOrEqual(cavArea(i - 1) + 1);
    expect(r.roles.filter((x) => x === 'base').length).toBe(r.baseCount);
    expect(r.baseCount).toBeGreaterThan(0);
    expect(r.baseCount).toBeLessThan(r.layers.length);
  });

  it('rejects items that do not fit', () => {
    expect(() => buildInsert(makeBox(300, 50, 50), base)).toThrow(/doesn't fit/);
  });

  it('flip keeps a proper rotation (positive volume orientation)', () => {
    const { positions } = orientItem(makeBox(10, 20, 30), 'y', true, true);
    let vol = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(i, i + 9);
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    expect(vol).toBeCloseTo(6000, 0);
  });

  it('finds the smallest preset box with enough cushion', () => {
    const b = smallestBox([100, 60, 40], IN, 1)!;
    expect(b).not.toBeNull();
    expect(b.box.every((v) => v >= 40 + 2 * IN)).toBe(true);
  });
});

describe('preload', () => {
  it('lets a top that barely pokes into a layer compress it instead of cutting it', async () => {
    const { planStack } = await import('../src/core/insert');
    const o = {
      compress: 3,
      minCushion: IN,
      layering: 'fewest' as const,
      placement: 'auto' as const,
    };
    // Item 1 mm taller than 2 in: without preload the next 1 in layer leaves ~24 mm play.
    expect(planStack(6 * IN, 2 * IN + 1, [IN], { ...o, preload: 0 }).topGap).toBeGreaterThan(20);
    expect(planStack(6 * IN, 2 * IN + 1, [IN], { ...o, preload: 1.5 }).topGap).toBe(0);
  });
});

describe('top-loading pocket', () => {
  it('opens every item layer upward and keeps the layers above solid', () => {
    const r = buildInsert(makeVase(), {
      ...base,
      mode: 'topLoad',
      box: [8 * IN, 8 * IN, 8 * IN],
      thicknesses: [IN / 2, IN, 2 * IN],
    });
    expect(r.topLoad).toBe(true);
    const cav = (i: number) =>
      r.layers[i].loops.filter((l) => l.depth % 2 === 1).reduce((a, l) => a - l.area, 0);
    // Pocket widens (never narrows) going up, so the item can be pulled out of the top.
    for (let i = 1; i < r.baseCount; i++) expect(cav(i)).toBeGreaterThanOrEqual(cav(i - 1) - 1);
    // Top pocket layer is at least as wide as every layer below it.
    const top = cav(r.baseCount - 1);
    for (let i = 0; i < r.baseCount; i++) expect(top).toBeGreaterThanOrEqual(cav(i) - 1);
    // Lid pads above are solid.
    for (let i = r.baseCount; i < r.layers.length; i++) expect(r.layers[i].loops).toHaveLength(1);
    expect(r.baseCount).toBeLessThan(r.layers.length);
    expect(r.report.topCushion).toBeGreaterThanOrEqual(IN - 0.05);
  });
});

describe('item scale', () => {
  it('scales in the STL frame regardless of orientation', () => {
    const box = makeBox(10, 20, 30);
    expect(orientItem(box, 'z', false, false, [2, 1, 0.5]).size.map(Math.round)).toEqual([
      20, 20, 15,
    ]);
    // Y up: oriented (X, Z, Y) of the scaled STL (20, 20, 15) -> (20, 15, 20)
    expect(orientItem(box, 'y', false, false, [2, 1, 0.5]).size.map(Math.round)).toEqual([
      20, 15, 20,
    ]);
    // X up + turn: oriented (Z, Y, X) = (15, 20, 20), turned -> (20, 15, 20)
    expect(orientItem(box, 'x', true, false, [2, 1, 0.5]).size.map(Math.round)).toEqual([
      20, 15, 20,
    ]);
  });

  it('a scaled-up item that no longer fits is rejected', () => {
    const item = makeBox(100, 60, 50);
    expect(() => buildInsert(item, { ...base, scale: [3, 3, 1] })).toThrow(/doesn't fit/);
  });
});

describe('insert export', () => {
  it('skips removed layers and names top-loading roles', async () => {
    const { buildInsertFiles } = await import('../src/core/export/insertZip');
    const r = buildInsert(makeBox(100, 60, 2 * IN), { ...base, mode: 'topLoad' });
    const data = {
      sourceName: 'box.stl',
      result: r,
      extras: r.layers.map(() => ({ pins: [], label: null, missingPins: 0 })),
      groups: [],
      sheetW: 1219.2,
      sheetH: 609.6,
      removed: new Set([r.layers.length - 1]),
    };
    const files = buildInsertFiles(data, {
      dxf: true,
      svg: false,
      perLayer: true,
      sheets: false,
      pricePerSheet: 0,
      currency: '$',
      prices: [],
      boxLabel: '8 x 8 x 6 in',
    });
    const layerFiles = files.filter((f) => f.path.startsWith('layers/'));
    expect(layerFiles).toHaveLength(r.layers.length - 1);
    expect(layerFiles[0].path).toMatch(/^layers\/L01_pocket_/);
    const readme = files.find((f) => f.path === 'README.txt')!.data;
    expect(readme).toContain('REMOVED (not cut)');
  });
});
