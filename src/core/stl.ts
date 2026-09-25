import type { Mesh } from '../types';

/** True when the buffer length matches the binary STL layout exactly. */
export function isBinarySTL(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 84) return false;
  const triCount = new DataView(buf).getUint32(80, true);
  return 84 + triCount * 50 === buf.byteLength;
}

export function parseSTL(buf: ArrayBuffer): Mesh {
  return isBinarySTL(buf) ? parseBinary(buf) : parseASCII(buf);
}

function parseBinary(buf: ArrayBuffer): Mesh {
  const dv = new DataView(buf);
  const triCount = dv.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  let o = 84;
  for (let i = 0, p = 0; i < triCount; i++) {
    o += 12; // skip facet normal
    for (let k = 0; k < 9; k++, o += 4) positions[p++] = dv.getFloat32(o, true);
    o += 2; // attribute byte count
  }
  return { positions, triCount };
}

const VERTEX_RE = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;

function parseASCII(buf: ArrayBuffer): Mesh {
  const text = new TextDecoder().decode(buf);
  const out: number[] = [];
  VERTEX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VERTEX_RE.exec(text))) out.push(+m[1], +m[2], +m[3]);
  const triCount = Math.floor(out.length / 9);
  if (triCount === 0) throw new Error('No triangles found — is this an STL file?');
  const positions = new Float32Array(out.slice(0, triCount * 9));
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error('STL contains invalid numbers');
  }
  return { positions, triCount };
}

/** Encode a mesh as binary STL (used for the procedural sample and tests). */
export function toBinarySTL(mesh: Mesh): ArrayBuffer {
  const buf = new ArrayBuffer(84 + mesh.triCount * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, mesh.triCount, true);
  let o = 84;
  const p = mesh.positions;
  for (let i = 0; i < mesh.triCount; i++) {
    const b = i * 9;
    const ux = p[b + 3] - p[b],
      uy = p[b + 4] - p[b + 1],
      uz = p[b + 5] - p[b + 2];
    const vx = p[b + 6] - p[b],
      vy = p[b + 7] - p[b + 1],
      vz = p[b + 8] - p[b + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++, o += 4) dv.setFloat32(o, p[b + k], true);
    o += 2;
  }
  return buf;
}
