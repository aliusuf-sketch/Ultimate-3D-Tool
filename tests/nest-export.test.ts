import { describe, expect, it } from 'vitest';
import { buildParts, nestParts, placeTransform } from '../src/core/nest';
import { drawingToDXF } from '../src/core/export/dxf';
import { drawingToSVG } from '../src/core/export/svg';
import { computeExtras } from '../src/core/extras';
import { sliceModel } from '../src/core/pipeline';
import { makeTorus } from '../src/core/sample';
import { transformMesh } from '../src/core/transform';
import type { ExtrasSettings, Part } from '../src/types';

function rectPart(w: number, h: number, layer = 0): Part {
  return {
    layer,
    loops: [Float64Array.from([0, 0, w, 0, w, h, 0, h])],
    pins: [],
    label: null,
    bbox: [0, 0, w, h],
  };
}

describe('nesting', () => {
  it('never overlaps parts and respects the margins', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const parts = Array.from({ length: 60 }, (_, i) =>
      rectPart(20 + rnd() * 300, 20 + rnd() * 250, i),
    );
    const W = 1200,
      H = 600,
      gap = 6;
    const res = nestParts(parts, W, H, gap);
    expect(res.placements).toHaveLength(parts.length);
    const rects = res.placements.map((pl) => {
      const part = parts[pl.part];
      const tf = placeTransform(part, pl);
      const xs: number[] = [],
        ys: number[] = [];
      const pts = part.loops[0];
      for (let i = 0; i < pts.length; i += 2) {
        const [x, y] = tf(pts[i], pts[i + 1]);
        xs.push(x);
        ys.push(y);
      }
      return {
        s: pl.sheet,
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      };
    });
    for (const r of rects) {
      expect(r.x0).toBeGreaterThanOrEqual(gap - 1e-9);
      expect(r.y0).toBeGreaterThanOrEqual(gap - 1e-9);
      expect(r.x1).toBeLessThanOrEqual(W - gap + 1e-9);
      expect(r.y1).toBeLessThanOrEqual(H - gap + 1e-9);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i],
          b = rects[j];
        if (a.s !== b.s) continue;
        const sep =
          a.x1 + gap <= b.x0 + 1e-9 ||
          b.x1 + gap <= a.x0 + 1e-9 ||
          a.y1 + gap <= b.y0 + 1e-9 ||
          b.y1 + gap <= a.y0 + 1e-9;
        expect(sep).toBe(true);
      }
    }
  });

  it('rotates when that is the only way to fit and flags oversize parts', () => {
    const res = nestParts([rectPart(100, 800), rectPart(2000, 100)], 1200, 600, 6);
    const p0 = res.placements.find((p) => p.part === 0)!;
    expect(p0.rotated).toBe(true);
    expect(res.oversizeCount).toBe(1);
    expect(res.sheets.filter((s) => s.oversize)).toHaveLength(1);
  });

  it('rotation is proper (keeps loop orientation)', () => {
    const part = rectPart(10, 30);
    const tf = placeTransform(part, { part: 0, sheet: 0, rotated: true, x: 6, y: 6 });
    const pts = part.loops[0];
    let a = 0;
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = tf(pts[i * 2], pts[i * 2 + 1]);
      const [xj, yj] = tf(pts[j * 2], pts[j * 2 + 1]);
      a += xj * yi - xi * yj;
    }
    expect(a / 2).toBeCloseTo(300);
  });
});

const extrasSettings: ExtrasSettings = {
  pinMode: 'two',
  pinDiameter: 6,
  pinSpacing: 40,
  pinOffsetX: 0,
  pinOffsetY: 0,
  labels: true,
  labelHeight: 6,
  sheetW: 1200,
  sheetH: 600,
  gap: 6,
};

describe('pins and labels on a torus', () => {
  it('places no pins in the hole and labels inside the ring', () => {
    const { mesh, size } = transformMesh(makeTorus(), 'z', 1);
    const { layers } = sliceModel(mesh, size[2], 10, 0.05);
    // Centre pin lands in the hole -> missing on every layer.
    const one = computeExtras(layers, size[0], size[1], { ...extrasSettings, pinMode: 'one' });
    expect(one.pinsMissingLayers).toBe(layers.length);
    // Two pins 120 mm apart sit in the ring on the middle layers.
    const two = computeExtras(layers, size[0], size[1], { ...extrasSettings, pinSpacing: 120 });
    const mid = two.extras[2];
    expect(mid.pins).toHaveLength(2);
    expect(mid.label?.text).toBe('L03');
    const parts = buildParts(layers, two.extras);
    expect(parts).toHaveLength(layers.length);
    expect(parts[2].loops).toHaveLength(2);
    expect(parts[2].pins).toHaveLength(2);
  });
});

describe('writers', () => {
  const d = {
    width: 100,
    height: 50,
    cuts: [Float64Array.from([5, 5, 95, 5, 95, 45, 5, 45])],
    circles: [{ x: 20, y: 25, r: 3 }],
    texts: [{ text: 'L01', x: 50, y: 25, h: 6 }],
  };

  it('DXF starts with the header section and ends with EOF', () => {
    const s = drawingToDXF(d);
    const lines = s.trim().split('\n');
    expect(lines.slice(0, 4)).toEqual(['0', 'SECTION', '2', 'HEADER']);
    expect(lines.slice(-2)).toEqual(['0', 'EOF']);
    expect(s).toContain('AC1009');
    expect(s).toMatch(/\$INSUNITS\n70\n4\n/);
    expect(s).toContain('POLYLINE\n8\nCUT');
    expect(s).toContain('CIRCLE\n8\nCUT');
    expect(s).toContain('TEXT\n8\nENGRAVE');
    expect(s.split('\nVERTEX\n')).toHaveLength(5);
    expect(lines.length % 2).toBe(0); // group code / value pairs
  });

  it('SVG viewBox matches the mm size and y is flipped', () => {
    const s = drawingToSVG(d);
    expect(s).toContain('width="100mm" height="50mm" viewBox="0 0 100 50"');
    expect(s).toContain('stroke="#FF0000" stroke-width="0.1"');
    expect(s).toContain('fill="#0000FF"');
    expect(s).toContain('M5 45L95 45L95 5L5 5Z');
    expect(s).toContain('<circle cx="20" cy="25" r="3"/>');
  });
});
