import { describe, expect, it } from 'vitest';
import { isBinarySTL, parseSTL, toBinarySTL } from '../src/core/stl';
import { makeBox } from '../src/core/sample';

const ascii = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex 1e0 0 1.5
  vertex -2.5E-1 0 0
  vertex 0 +1 0
 endloop
endfacet
endsolid t
`;

describe('STL parser', () => {
  it('detects binary files by exact length', () => {
    const bin = toBinarySTL(makeBox());
    expect(isBinarySTL(bin)).toBe(true);
    expect(isBinarySTL(new TextEncoder().encode(ascii).buffer as ArrayBuffer)).toBe(false);
  });

  it('parses binary STL', () => {
    const box = makeBox(2, 3, 4);
    const m = parseSTL(toBinarySTL(box));
    expect(m.triCount).toBe(12);
    expect(Array.from(m.positions)).toEqual(Array.from(box.positions));
  });

  it('parses ASCII STL, including exponents and signs', () => {
    const m = parseSTL(new TextEncoder().encode(ascii).buffer as ArrayBuffer);
    expect(m.triCount).toBe(2);
    expect(Array.from(m.positions.slice(9, 12))).toEqual([1, 0, 1.5]);
    expect(m.positions[12]).toBeCloseTo(-0.25);
  });

  it('treats an ASCII file that starts with "solid" but has binary length as binary', () => {
    // Binary files may legally begin with "solid"; length rule decides.
    const bin = new Uint8Array(toBinarySTL(makeBox()));
    bin.set(new TextEncoder().encode('solid binary'), 0);
    expect(parseSTL(bin.buffer).triCount).toBe(12);
  });

  it('rejects garbage', () => {
    expect(() => parseSTL(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow();
  });
});
