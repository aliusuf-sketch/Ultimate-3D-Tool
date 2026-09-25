import { describe, expect, it } from 'vitest';
import { chainSegments } from '../src/core/chain';
import { simplifyLoop } from '../src/core/simplify';
import { signedArea } from '../src/core/topology';

describe('chaining', () => {
  it('handles reversed segment orientation', () => {
    // Square with two segments reversed and shuffled order.
    const segs = Float64Array.from([
      0, 0, 1, 0,
      0, 1, 1, 1, // reversed (should be 1,1 -> 0,1)
      1, 0, 1, 1,
      0, 0, 0, 1, // reversed (should be 0,1 -> 0,0)
    ]);
    const { loops, open } = chainSegments(segs);
    expect(open).toHaveLength(0);
    expect(loops).toHaveLength(1);
    expect(loops[0].length).toBe(8);
    expect(Math.abs(signedArea(loops[0]))).toBeCloseTo(1);
  });

  it('flags open chains and walks backward to include the whole chain', () => {
    const segs = Float64Array.from([1, 0, 2, 0, 0, 0, 1, 0, 2, 0, 3, 0]);
    const { loops, open } = chainSegments(segs);
    expect(loops).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(Array.from(open[0])).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
  });

  it('matches endpoints within the 1e-4 mm quantum', () => {
    const e = 1e-6;
    const segs = Float64Array.from([0, 0, 1, 0, 1 + e, 0, 1, 1, 1, 1 - e, 0, 0]);
    expect(chainSegments(segs).loops).toHaveLength(1);
  });
});

describe('simplify', () => {
  it('keeps the loop closed and reduces point count', () => {
    const n = 400;
    const pts = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts[i * 2] = 50 * Math.cos(a);
      pts[i * 2 + 1] = 50 * Math.sin(a);
    }
    const s = simplifyLoop(pts, 0.05);
    expect(s.length / 2).toBeLessThan(n);
    expect(s.length / 2).toBeGreaterThanOrEqual(3);
    // Every kept point is an original vertex; closing edge is implicit.
    const orig = new Set<string>();
    for (let i = 0; i < pts.length; i += 2) orig.add(`${pts[i]},${pts[i + 1]}`);
    for (let i = 0; i < s.length; i += 2) expect(orig.has(`${s[i]},${s[i + 1]}`)).toBe(true);
    expect(signedArea(s)).toBeCloseTo(signedArea(pts), -1);
    expect(signedArea(s)).toBeGreaterThan(0);
  });

  it('removes collinear points on a square', () => {
    const pts = Float64Array.from([0, 0, 0.5, 0, 1, 0, 1, 0.5, 1, 1, 0.5, 1, 0, 1, 0, 0.5]);
    expect(simplifyLoop(pts, 0.01).length / 2).toBe(4);
  });
});
