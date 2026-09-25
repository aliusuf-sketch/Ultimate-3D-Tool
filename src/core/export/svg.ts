/** SVG writer. Width/height and viewBox in millimetres; y is flipped (drawing y is up). */
import type { Drawing } from '../../types';

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const CUT_COLOR = '#FF0000';
export const ENGRAVE_COLOR = '#0000FF';

export function drawingToSVG(d: Drawing): string {
  const H = d.height;
  const W = d.width;
  const out: string[] = [];
  out.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">`,
  );
  if (d.cuts.length || d.circles.length) {
    out.push(`<g id="cut" fill="none" stroke="${CUT_COLOR}" stroke-width="0.1">`);
    for (const pts of d.cuts) {
      let p = '';
      for (let i = 0; i < pts.length; i += 2) {
        p += (i === 0 ? 'M' : 'L') + f(pts[i]) + ' ' + f(H - pts[i + 1]);
      }
      out.push(`<path d="${p}Z"/>`);
    }
    for (const c of d.circles) {
      out.push(`<circle cx="${f(c.x)}" cy="${f(H - c.y)}" r="${f(c.r)}"/>`);
    }
    out.push('</g>');
  }
  if (d.texts.length) {
    out.push(
      `<g id="engrave" fill="${ENGRAVE_COLOR}" font-family="Barlow, Arial, sans-serif" text-anchor="middle" dominant-baseline="central">`,
    );
    for (const t of d.texts) {
      out.push(`<text x="${f(t.x)}" y="${f(H - t.y)}" font-size="${f(t.h)}">${esc(t.text)}</text>`);
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
