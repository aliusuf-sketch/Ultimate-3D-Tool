// Benchmark (skipped by default): npm run bench
import { it } from 'vitest';
import { makeTorus } from '../src/core/sample';
import { transformMesh } from '../src/core/transform';
import { sliceModel } from '../src/core/pipeline';
import { buildPreview, previewTolerance } from '../src/core/preview';
import { computeExtras } from '../src/core/extras';
import { buildParts, nestParts } from '../src/core/nest';

it.runIf(process.env.BENCH)(
  '500k triangles at 10 mm layers',
  () => {
    const src = makeTorus(300, 150, 1000, 250);
    for (const axis of ['z', 'y'] as const) {
      let t = performance.now();
      const { mesh, size } = transformMesh(src, axis, 1);
      const tr = performance.now() - t;
      t = performance.now();
      const out = sliceModel(mesh, size[2], 10, 0.05);
      const sl = performance.now() - t;
      t = performance.now();
      const pv = buildPreview(out.layers, previewTolerance(0.05, size[0], size[1]));
      const pr = performance.now() - t;
      t = performance.now();
      const ex = computeExtras(out.layers, size[0], size[1], {
        pinMode: 'two',
        pinDiameter: 6,
        pinSpacing: 40,
        pinOffsetX: 0,
        pinOffsetY: 0,
        labels: true,
        labelHeight: 6,
        sheetW: 1200,
        sheetH: 600,
        gap: 6,
      });
      const nest = nestParts(buildParts(out.layers, ex.extras), 1200, 600, 6);
      const exn = performance.now() - t;
      console.log(
        `${axis}: tris ${src.triCount}, layers ${out.layers.length}, transform ${tr.toFixed(0)} ms, slice ${sl.toFixed(0)} ms, preview ${pr.toFixed(0)} ms (${pv.positions.length / 9} tris), extras+nest ${exn.toFixed(0)} ms, sheets ${nest.sheets.length}, open ${out.openCount}`,
      );
    }
  },
  60000,
);
