/** High-level slicing pipeline built from the core pieces (DOM-free, worker-safe). */
import type { Mesh, SlicedLayer } from '../types';
import { chainSegments } from './chain';
import { simplifyLoop } from './simplify';
import { layerRange, planLayers, runSync, sliceMeshIter } from './slice';
import { buildTopology } from './topology';

export interface SliceOutput {
  layers: SlicedLayer[];
  openCount: number;
}

/**
 * Slice a normalised mesh (bbox min at origin) of height H into layers of thickness t.
 * Yields progress (0..1) at safe pause points.
 */
export function* sliceModelIter(
  mesh: Mesh,
  H: number,
  t: number,
  tol: number,
): Generator<number, SliceOutput> {
  const plan = planLayers(H, t);
  const it = sliceMeshIter(mesh.positions, plan);
  let r = it.next();
  while (!r.done) {
    yield r.value * 0.6;
    r = it.next();
  }
  const segs = r.value;
  let openCount = 0;
  const layers: SlicedLayer[] = [];
  for (let L = 0; L < plan.n; L++) {
    const { loops, open } = chainSegments(segs[L]);
    openCount += open.length;
    const simplified = loops.map((l) => simplifyLoop(l, tol));
    const [z0, z1] = layerRange(plan, L);
    layers.push({
      index: L,
      z0,
      z1,
      plane: plan.planes[L],
      loops: buildTopology(simplified),
      open,
    });
    yield 0.6 + (0.4 * (L + 1)) / plan.n;
  }
  return { layers, openCount };
}

export function sliceModel(mesh: Mesh, H: number, t: number, tol: number): SliceOutput {
  return runSync(sliceModelIter(mesh, H, t, tol));
}
