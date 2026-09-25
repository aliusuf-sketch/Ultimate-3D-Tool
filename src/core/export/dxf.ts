/** Minimal DXF R12 (AC1009) writer. Units: millimetres. */
import type { Drawing } from '../../types';

const f = (n: number) => (Math.round(n * 1e4) / 1e4).toString();

export function drawingToDXF(d: Drawing): string {
  const o: string[] = [];
  const g = (code: number, value: string | number) => {
    o.push(String(code), typeof value === 'number' ? f(value) : value);
  };
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  o.push('70', '4');
  g(9, '$EXTMIN');
  g(10, 0);
  g(20, 0);
  g(30, 0);
  g(9, '$EXTMAX');
  g(10, d.width);
  g(20, d.height);
  g(30, 0);
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  o.push('70', '2');
  for (const [name, color] of [
    ['CUT', 1],
    ['ENGRAVE', 5],
  ] as const) {
    g(0, 'LAYER');
    g(2, name);
    o.push('70', '0', '62', String(color));
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  for (const pts of d.cuts) {
    g(0, 'POLYLINE');
    g(8, 'CUT');
    o.push('66', '1');
    g(10, 0);
    g(20, 0);
    g(30, 0);
    o.push('70', '1');
    for (let i = 0; i < pts.length; i += 2) {
      g(0, 'VERTEX');
      g(8, 'CUT');
      g(10, pts[i]);
      g(20, pts[i + 1]);
      g(30, 0);
    }
    g(0, 'SEQEND');
    g(8, 'CUT');
  }
  for (const c of d.circles) {
    g(0, 'CIRCLE');
    g(8, 'CUT');
    g(10, c.x);
    g(20, c.y);
    g(30, 0);
    g(40, c.r);
  }
  for (const t of d.texts) {
    g(0, 'TEXT');
    g(8, 'ENGRAVE');
    g(10, t.x);
    g(20, t.y);
    g(30, 0);
    g(40, t.h);
    g(1, t.text);
    o.push('72', '1'); // centre
    g(11, t.x);
    g(21, t.y);
    g(31, 0);
    o.push('73', '2'); // middle
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return o.join('\n') + '\n';
}
