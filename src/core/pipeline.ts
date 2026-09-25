/** High-level slicing pipeline built from the core pieces (DOM-free, worker-safe). */
import type { Mesh, SlicedLayer } from '../types';
import { chainSegments } from './chain';
import { simplifyLoop } from './simplify';
import { layerRange, planLayers, sliceMesh } from './slice';
import { buildTopology } from './topology';

export interface SliceOutput {
  layers: SlicedLayer[];
  openCount: number;
}

/** Slice a normalised mesh (bbox min at origin) of height H into layers of thickness t. */
export function sliceModel(
  mesh: Mesh,
  H: number,
  t: number,
  tol: number,
  onProgress?: (f: number) => void,
): SliceOutput {
  const plan = planLayers(H, t);
  const segs = sliceMesh(mesh.positions, plan, (f) => onProgress?.(f * 0.7));
  let openCount = 0;
  const layers: SlicedLayer[] = segs.map((s, L) => {
    const { loops, open } = chainSegments(s);
    openCount += open.length;
    const simplified = loops.map((l) => simplifyLoop(l, tol));
    const [z0, z1] = layerRange(plan, L);
    onProgress?.(0.7 + (0.3 * (L + 1)) / plan.n);
    return { index: L, z0, z1, plane: plan.planes[L], loops: buildTopology(simplified), open };
  });
  return { layers, openCount };
}
