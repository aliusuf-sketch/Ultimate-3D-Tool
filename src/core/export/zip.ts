/** Assemble export files (per-layer + nested sheets) and zip them. */
import JSZip from 'jszip';
import type {
  Drawing,
  ExportOptions,
  LayerExtras,
  NestResult,
  Part,
  SlicedLayer,
} from '../../types';
import { formatMoney, estimateCost, MM_PER_FT, partsArea } from '../cost';
import { layerName } from '../extras';
import { signedArea } from '../topology';
import { placeTransform } from '../nest';
import { drawingToDXF } from './dxf';
import { drawingToSVG } from './svg';

export const LAYER_MARGIN = 5;

export interface ExportInput {
  sourceName: string;
  thickness: number;
  size: [number, number, number];
  layers: SlicedLayer[];
  extras: LayerExtras[];
  parts: Part[];
  nest: NestResult;
  sheetW?: number; // mm
  sheetH?: number; // mm
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function layerFileBase(layer: SlicedLayer): string {
  return `${layerName(layer.index)}_z${fmt(layer.z0)}-${fmt(layer.z1)}`;
}

/** Layer drawing sharing the model's XY origin (+ margin) so pins line up when stacked. */
export function layerDrawing(input: ExportInput, i: number): Drawing {
  const m = LAYER_MARGIN;
  const layer = input.layers[i];
  const ex = input.extras[i];
  const shift = (pts: Float64Array) => {
    const o = new Float64Array(pts.length);
    for (let k = 0; k < pts.length; k += 2) {
      o[k] = pts[k] + m;
      o[k + 1] = pts[k + 1] + m;
    }
    return o;
  };
  return {
    width: input.size[0] + 2 * m,
    height: input.size[1] + 2 * m,
    cuts: layer.loops.map((l) => shift(l.pts)),
    circles: (ex?.pins ?? []).map((p) => ({ x: p.x + m, y: p.y + m, r: p.r })),
    texts: ex?.label ? [{ ...ex.label, x: ex.label.x + m, y: ex.label.y + m }] : [],
  };
}

export function sheetDrawing(input: ExportInput, sheet: number): Drawing {
  const info = input.nest.sheets[sheet];
  const d: Drawing = { width: info.w, height: info.h, cuts: [], circles: [], texts: [] };
  for (const pl of input.nest.placements) {
    if (pl.sheet !== sheet) continue;
    const part = input.parts[pl.part];
    const tf = placeTransform(part, pl);
    for (const pts of part.loops) {
      const o = new Float64Array(pts.length);
      for (let k = 0; k < pts.length; k += 2) {
        const [x, y] = tf(pts[k], pts[k + 1]);
        o[k] = x;
        o[k + 1] = y;
      }
      d.cuts.push(o);
    }
    for (const p of part.pins) {
      const [x, y] = tf(p.x, p.y);
      d.circles.push({ x, y, r: p.r });
    }
    if (part.label) {
      const [x, y] = tf(part.label.x, part.label.y);
      d.texts.push({ ...part.label, x, y });
    }
  }
  return d;
}

export function sheetFileBase(input: ExportInput, sheet: number): string {
  const s = `sheet_${String(sheet + 1).padStart(2, '0')}`;
  return input.nest.sheets[sheet].oversize ? `${s}_oversize` : s;
}

export function readmeText(
  input: ExportInput,
  opts?: Pick<ExportOptions, 'pricePerSheet' | 'currency'>,
): string {
  const [w, d, h] = input.size;
  const costLines: string[] = [];
  if (input.sheetW && input.sheetH) {
    const ft = (v: number) => fmt(v / MM_PER_FT);
    costLines.push(
      `Stock sheet:      ${ft(input.sheetW)} x ${ft(input.sheetH)} ft (${fmt(input.sheetW)} x ${fmt(input.sheetH)} mm)`,
    );
    if (opts) {
      const c = estimateCost(
        input.nest.sheets,
        input.sheetW,
        input.sheetH,
        partsArea(input.parts, signedArea),
        opts.pricePerSheet,
      );
      costLines.push(`Sheets to buy:    ${c.sheets}`);
      if (opts.pricePerSheet > 0)
        costLines.push(
          `Material cost:    ${formatMoney(c.total, opts.currency)} (${formatMoney(opts.pricePerSheet, opts.currency)} per sheet)`,
        );
      costLines.push(`Material used:    ${Math.round(c.utilisation * 100)} %`);
    }
  }
  return [
    'Foam Slicer export',
    '==================',
    '',
    `Source file:      ${input.sourceName}`,
    `Sheet thickness:  ${fmt(input.thickness)} mm`,
    `Layers:           ${input.layers.length}`,
    `Model size:       ${fmt(w)} x ${fmt(d)} x ${fmt(h)} mm (W x D x H)`,
    `Sheets (nested):  ${input.nest.sheets.length}${input.nest.oversizeCount ? ` (${input.nest.oversizeCount} oversize)` : ''}`,
    ...costLines,
    '',
    'Colour / layer legend',
    '  Red   #FF0000  / DXF layer CUT      - cut through (outlines, holes, pin holes)',
    '  Blue  #0000FF  / DXF layer ENGRAVE  - engrave only (layer numbers)',
    '',
    'All units are millimetres.',
    'layers/ files share the model XY origin (+5 mm margin), so pin holes line up.',
    'sheets/ files are the same parts nested onto stock sheets.',
    '',
    'Assembly: stack L01 at the bottom, then L02, L03 ... upward.',
    'Push dowels/skewers through the pin holes to keep layers aligned while gluing.',
    '',
  ].join('\n');
}

export function buildExportFiles(
  input: ExportInput,
  opts: ExportOptions,
): { path: string; data: string }[] {
  const files: { path: string; data: string }[] = [];
  if (opts.perLayer) {
    input.layers.forEach((layer, i) => {
      const d = layerDrawing(input, i);
      const base = `layers/${layerFileBase(layer)}`;
      if (opts.dxf) files.push({ path: `${base}.dxf`, data: drawingToDXF(d) });
      if (opts.svg) files.push({ path: `${base}.svg`, data: drawingToSVG(d) });
    });
  }
  if (opts.sheets) {
    input.nest.sheets.forEach((_, s) => {
      const d = sheetDrawing(input, s);
      const base = `sheets/${sheetFileBase(input, s)}`;
      if (opts.dxf) files.push({ path: `${base}.dxf`, data: drawingToDXF(d) });
      if (opts.svg) files.push({ path: `${base}.svg`, data: drawingToSVG(d) });
    });
  }
  files.push({ path: 'README.txt', data: readmeText(input, opts) });
  return files;
}

export async function buildZip(files: { path: string; data: string }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
