import type { BBox3, Mesh, StackAxis } from '../types';

export function computeBBox(positions: ArrayLike<number>): BBox3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (positions.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/**
 * Rotate so the chosen axis becomes the stacking (Z) axis, scale, then translate the
 * bounding-box minimum to the origin. Rotations are proper (det = +1), never mirrors:
 *   Y: (x, y, z) -> (x, -z, y)
 *   X: (x, y, z) -> (-z, y, x)
 */
export function transformMesh(
  mesh: Mesh,
  axis: StackAxis,
  scale: number,
): { mesh: Mesh; size: [number, number, number] } {
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    let a = x, b = y, c = z;
    if (axis === 'y') { a = x; b = -z; c = y; }
    else if (axis === 'x') { a = -z; b = y; c = x; }
    out[i] = a * scale;
    out[i + 1] = b * scale;
    out[i + 2] = c * scale;
  }
  const bb = computeBBox(out);
  for (let i = 0; i < out.length; i += 3) {
    out[i] -= bb.min[0];
    out[i + 1] -= bb.min[1];
    out[i + 2] -= bb.min[2];
  }
  const size: [number, number, number] = [
    bb.max[0] - bb.min[0],
    bb.max[1] - bb.min[1],
    bb.max[2] - bb.min[2],
  ];
  return { mesh: { positions: out, triCount: mesh.triCount }, size };
}

/** Model height along the stack axis for a given source bbox (scale 1). */
export function stackExtent(bb: BBox3, axis: StackAxis): number {
  const k = axis === 'z' ? 2 : axis === 'y' ? 1 : 0;
  return bb.max[k] - bb.min[k];
}
