import { describe, expect, it } from 'vitest';
import { makeBox, makeTorus } from '../src/core/sample';
import { planLayers, sliceMesh } from '../src/core/slice';
import { chainSegments } from '../src/core/chain';
import { sliceModel } from '../src/core/pipeline';
import { transformMesh } from '../src/core/transform';
import { signedArea } from '../src/core/topology';

describe('layer plan', () => {
  it('uses ceil(H/t) layers with mid-layer / mid-remainder planes', () => {
    const p = planLayers(25, 10);
    expect(p.n).toBe(3);
    expect(Array.from(p.planes)).toEqual([5, 15, 22.5]);
    expect(planLayers(30, 10).n).toBe(3);
  });
});

describe('slicing', () => {
  it('slices a unit cube at mid-height into one closed square of area 1', () => {
    const { layers, openCount } = sliceModel(makeBox(), 1, 1, 0.05);
    expect(layers).toHaveLength(1);
    expect(openCount).toBe(0);
    expect(layers[0].loops).toHaveLength(1);
    const l = layers[0].loops[0];
    expect(l.area).toBeCloseTo(1, 9);
    expect(l.depth).toBe(0);
    expect(l.pts.length / 2).toBe(4);
  });

  it('raw loops are CCW for an outward-wound mesh', () => {
    const segs = sliceMesh(makeBox(2, 3, 4).positions, planLayers(4, 1));
    for (const s of segs) {
      const { loops } = chainSegments(s);
      expect(loops).toHaveLength(1);
      expect(signedArea(loops[0])).toBeCloseTo(6, 9);
    }
  });

  it('slices a torus into 2 loops per layer with correct hole parenting', () => {
    const { mesh, size } = transformMesh(makeTorus(60, 25, 64, 32), 'z', 1);
    const { layers, openCount } = sliceModel(mesh, size[2], 10, 0.05);
    expect(layers).toHaveLength(5);
    expect(openCount).toBe(0);
    for (const layer of layers) {
      expect(layer.loops).toHaveLength(2);
      const [outer, hole] = layer.loops;
      expect(outer.depth).toBe(0);
      expect(outer.parent).toBe(-1);
      expect(outer.area).toBeGreaterThan(0);
      expect(hole.depth).toBe(1);
      expect(hole.parent).toBe(0);
      expect(hole.area).toBeLessThan(0);
    }
  });
});

describe('axis rotation', () => {
  // An asymmetric L-prism so any mirroring would be visible.
  function lPrism() {
    const box1 = makeBox(3, 1, 2).positions;
    const box2 = makeBox(1, 2, 2).positions;
    return {
      positions: Float32Array.from([...box1, ...box2.map((v, i) => (i % 3 === 1 ? v + 1 : v))]),
      triCount: (box1.length + box2.length) / 9,
    };
  }

  for (const axis of ['z', 'y', 'x'] as const) {
    it(`keeps orientation (positive signed area) when stacking along ${axis.toUpperCase()}`, () => {
      const { mesh, size } = transformMesh(lPrism(), axis, 1);
      const segs = sliceMesh(mesh.positions, planLayers(size[2], size[2] / 3));
      for (const s of segs) {
        const { loops } = chainSegments(s);
        const total = loops.reduce((a, l) => a + signedArea(l), 0);
        expect(total).toBeGreaterThan(0);
      }
    });
  }

  it('maps axes as proper rotations', () => {
    const tri = { positions: Float32Array.from([1, 2, 3, 0, 0, 0, 0, 0, 0]), triCount: 1 };
    const y = transformMesh(tri, 'y', 1).mesh.positions;
    // (x, y, z) -> (x, -z, y), then normalised to min 0: (1, -3, 2) -> (1, 0, 2)
    expect(Array.from(y.slice(0, 3))).toEqual([1, 0, 2]);
    const x = transformMesh(tri, 'x', 2).mesh.positions;
    // (x, y, z) -> (-z, y, x) * 2 = (-6, 4, 2) -> (0, 4, 2)
    expect(Array.from(x.slice(0, 3))).toEqual([0, 4, 2]);
  });
});

describe('per-axis scale', () => {
  it('scales X, Y and Z independently after orientation', async () => {
    const { orientedSize } = await import('../src/core/transform');
    const { size } = transformMesh(makeBox(10, 20, 30), 'y', [2, 0.5, 1]);
    // Y stacking: oriented size is (10, 30, 20), then scaled.
    expect(orientedSize([10, 20, 30], 'y')).toEqual([10, 30, 20]);
    expect(size.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([20, 15, 20]);
    const { layers } = sliceModel(
      transformMesh(makeBox(10, 20, 30), 'x', [1, 2, 3]).mesh,
      30,
      10,
      0.01,
    );
    expect(layers[0].loops[0].area).toBeGreaterThan(0);
  });
});
