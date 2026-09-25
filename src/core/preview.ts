/** Extruded preview geometry for the 3D stack: one merged, non-indexed triangle buffer. */
import { ShapeUtils, Vector2 } from 'three';
import type { SlicedLayer } from '../types';
import { simplifyLoop } from './simplify';

export interface PreviewGeometry {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Vertex offset of each layer; length n + 1. */
  layerStart: Uint32Array;
}

const COLOR_A: [number, number, number] = [0.96, 0.62, 0.72];
const COLOR_B: [number, number, number] = [0.86, 0.47, 0.6];

class Buf {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(cap);
  }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
}

export function previewTolerance(userTol: number, footW: number, footD: number): number {
  return Math.max(userTol, Math.hypot(footW, footD) / 500);
}

export function buildPreview(layers: SlicedLayer[], tol: number): PreviewGeometry {
  const pos = new Buf(1 << 16);
  const nor = new Buf(1 << 16);
  const col = new Buf(1 << 16);
  const layerStart = new Uint32Array(layers.length + 1);

  for (const layer of layers) {
    layerStart[layer.index] = pos.n / 3;
    const c = layer.index % 2 === 0 ? COLOR_A : COLOR_B;
    const { z0, z1 } = layer;
    const simp = layer.loops.map((l) => simplifyLoop(l.pts, tol));
    const tri = (
      ax: number,
      ay: number,
      az: number,
      bx: number,
      by: number,
      bz: number,
      cx: number,
      cy: number,
      cz: number,
      nx: number,
      ny: number,
      nz: number,
    ) => {
      pos.push3(ax, ay, az);
      pos.push3(bx, by, bz);
      pos.push3(cx, cy, cz);
      for (let k = 0; k < 3; k++) {
        nor.push3(nx, ny, nz);
        col.push3(c[0], c[1], c[2]);
      }
    };

    layer.loops.forEach((loop, k) => {
      // Side walls for every loop (solids CCW, holes CW -> normals point out of material).
      const p = simp[k];
      const n = p.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = p[j * 2],
          ay = p[j * 2 + 1],
          bx = p[i * 2],
          by = p[i * 2 + 1];
        const dx = bx - ax,
          dy = by - ay;
        const l = Math.hypot(dx, dy) || 1;
        const nx = dy / l,
          ny = -dx / l;
        tri(ax, ay, z0, bx, by, z0, bx, by, z1, nx, ny, 0);
        tri(ax, ay, z0, bx, by, z1, ax, ay, z1, nx, ny, 0);
      }
      if (loop.depth % 2 !== 0) return;
      // Caps for each solid with its direct holes.
      const toV = (q: Float64Array) => {
        const v: Vector2[] = [];
        for (let i = 0; i < q.length; i += 2) v.push(new Vector2(q[i], q[i + 1]));
        return v;
      };
      const contour = toV(p);
      const holes: Vector2[][] = [];
      layer.loops.forEach((h, hk) => {
        if (h.parent === k && h.depth % 2 === 1) holes.push(toV(simp[hk]));
      });
      const faces = ShapeUtils.triangulateShape(contour, holes);
      const all = contour.concat(...holes);
      for (const [a, b, d] of faces) {
        const A = all[a],
          B = all[b],
          D = all[d];
        // Ensure CCW for the top cap.
        const cross = (B.x - A.x) * (D.y - A.y) - (B.y - A.y) * (D.x - A.x);
        const [P, Q] = cross >= 0 ? [B, D] : [D, B];
        tri(A.x, A.y, z1, P.x, P.y, z1, Q.x, Q.y, z1, 0, 0, 1);
        tri(A.x, A.y, z0, Q.x, Q.y, z0, P.x, P.y, z0, 0, 0, -1);
      }
    });
  }
  layerStart[layers.length] = pos.n / 3;
  return {
    positions: pos.a.slice(0, pos.n),
    normals: nor.a.slice(0, nor.n),
    colors: col.a.slice(0, col.n),
    layerStart,
  };
}
