/** Procedural sample models. */
import type { Mesh } from '../types';

/** Grid-parametrised surface -> outward-wound triangle soup. */
function paramSurface(
  nu: number, nv: number,
  f: (u: number, v: number) => [number, number, number],
): Mesh {
  const tris: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = f(i / nu, j / nv), b = f((i + 1) / nu, j / nv);
      const c = f((i + 1) / nu, (j + 1) / nv), d = f(i / nu, (j + 1) / nv);
      tris.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  return { positions: new Float32Array(tris), triCount: tris.length / 9 };
}

/** Torus lying flat (axis = Z). Dimensions in mm. */
export function makeTorus(R = 60, r = 25, nu = 96, nv = 48): Mesh {
  return paramSurface(nu, nv, (s, t) => {
    const u = s * Math.PI * 2, v = t * Math.PI * 2;
    // Snap the seam exactly so neighbouring quads share bit-identical vertices.
    const cu = s === 1 ? 1 : Math.cos(u), su = s === 1 ? 0 : Math.sin(u);
    const cv = t === 1 ? 1 : Math.cos(v), sv = t === 1 ? 0 : Math.sin(v);
    return [(R + r * cv) * cu, (R + r * cv) * su, r * sv];
  });
}

/** Axis-aligned box from (0,0,0) to (w,d,h), outward winding. */
export function makeBox(w = 1, d = 1, h = 1): Mesh {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const out: number[] = [];
  for (const [a, b, c, d2] of quads) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d2]);
  return { positions: new Float32Array(out), triCount: out.length / 9 };
}
