/** Export for shipping inserts: per-layer cut files, sheets per foam thickness, docs. */
import type { ExportOptions, LayerExtras, NestResult, Part } from '../../types';
import { estimateCost, formatMoney, MM_PER_FT } from '../cost';
import { layerName } from '../extras';
import type { InsertResult, LayerRole, LayerSection } from '../insert';
import { drawingToDXF } from './dxf';
import { drawingToSVG } from './svg';
import { layerDrawing, sheetDrawing, type ExportInput } from './zip';

export interface ThicknessGroup {
  thickness: number; // mm
  layers: number[]; // layer indices
  parts: Part[];
  nest: NestResult;
  partArea: number;
}

export interface InsertExportInput {
  sourceName: string;
  result: InsertResult;
  extras: LayerExtras[];
  groups: ThicknessGroup[];
  sheetW: number;
  sheetH: number;
  /** Layers the user removed: not cut, not nested, listed as removed. */
  removed?: Set<number>;
}

export interface InsertExportOptions extends ExportOptions {
  prices: { thickness: number; price: number }[];
  boxLabel: string;
}

/** "2in", "0.5in" for inch-ish thicknesses, else "12mm". */
export function thicknessLabel(mm: number): string {
  const inch = mm / 25.4;
  if (Math.abs(inch * 16 - Math.round(inch * 16)) < 0.02)
    return `${Math.round(inch * 1000) / 1000}in`;
  return `${Math.round(mm * 10) / 10}mm`;
}

/** Human role of layer i: base / pocket / lid / top (or the two-part base / lid halves). */
export function displayRole(
  r: { roles: LayerRole[]; sections?: LayerSection[]; topLoad: boolean },
  i: number,
): string {
  const sec = r.sections?.[i];
  if (sec === 'base') return 'base';
  if (sec === 'top') return 'top';
  if (r.topLoad) return r.roles[i] === 'base' ? 'pocket' : 'lid';
  return roleName(r.roles[i]);
}

/** Role of layer i as named in files. */
export function layerRole(r: InsertResult, i: number): string {
  return displayRole(r, i);
}

export function roleName(role: LayerRole): string {
  return role === 'base' ? 'base' : role === 'lid' ? 'lid' : 'layer';
}

export function insertLabelText(role: LayerRole, index: number): string {
  return `${layerName(index)}${role === 'base' ? ' B' : role === 'lid' ? ' T' : ''}`;
}

export function insertLayerFileBase(r: InsertResult, i: number): string {
  return `${layerName(i)}_${layerRole(r, i)}_${thicknessLabel(r.thickness[i])}`;
}

function asExportInput(x: InsertExportInput, group?: ThicknessGroup): ExportInput {
  const r = x.result;
  return {
    sourceName: x.sourceName,
    thickness: group?.thickness ?? r.thickness[0],
    size: [r.rect[0], r.rect[1], r.stackHeight],
    layers: r.layers,
    extras: x.extras,
    parts: group?.parts ?? [],
    nest: group?.nest ?? { placements: [], sheets: [], oversizeCount: 0 },
    sheetW: x.sheetW,
    sheetH: x.sheetH,
  };
}

export function insertLayerSVG(x: InsertExportInput, i: number): string {
  return drawingToSVG(layerDrawing(asExportInput(x), i));
}

export function priceFor(opts: Pick<InsertExportOptions, 'prices'>, thickness: number): number {
  return opts.prices.find((p) => Math.abs(p.thickness - thickness) < 0.05)?.price ?? 0;
}

function readme(x: InsertExportInput, opts: InsertExportOptions): string {
  const r = x.result;
  const rep = r.report;
  const f = (v: number) => String(Math.round(v * 10) / 10);
  const inch = (v: number) => `${Math.round((v / 25.4) * 100) / 100} in`;
  const lines = [
    'Foam Slicer — shipping insert',
    '=============================',
    '',
    `Item:              ${x.sourceName} (${r.itemSize.map(f).join(' x ')} mm)`,
    `Box (inside):      ${opts.boxLabel}`,
    `Layer outline:     ${f(r.rect[0])} x ${f(r.rect[1])} mm`,
    `Stack:             ${r.layers.length} layers, ${f(r.stackHeight)} mm (${inch(r.stackHeight)})`,
    `Foam around item:  sides ${f(rep.sideWall)} mm, below ${f(rep.bottomCushion)} mm, above ${f(rep.topCushion)} mm`,
    `Vertical play:     up ${f(rep.playUp)} mm, down ${f(rep.playDown)} mm${rep.preloaded > 0.05 ? ` (item presses ${f(rep.preloaded)} mm into the lid)` : ''}`,
    '',
    'Layers (bottom to top)',
    '----------------------',
  ];
  r.layers.forEach((l, i) => {
    if (x.removed?.has(i)) {
      lines.push(`${layerName(i)}  REMOVED (not cut) — ${thicknessLabel(r.thickness[i])}`);
      return;
    }
    lines.push(
      `${layerName(i)}  ${layerRole(r, i).padEnd(6)}  ${thicknessLabel(r.thickness[i]).padEnd(7)}  z ${f(l.z0)}-${f(l.z1)} mm  ${l.loops.length > 1 ? `${l.loops.length - 1} cut-out(s)` : 'solid'}`,
    );
  });
  lines.push('', 'Foam to buy', '-----------');
  let total = 0;
  for (const g of x.groups) {
    const price = priceFor(opts, g.thickness);
    const c = estimateCost(g.nest.sheets, x.sheetW, x.sheetH, g.partArea, price);
    total += c.total;
    lines.push(
      `${thicknessLabel(g.thickness).padEnd(7)} ${c.sheets} sheet(s) of ${f(x.sheetW / MM_PER_FT)} x ${f(x.sheetH / MM_PER_FT)} ft` +
        (price > 0 ? `  = ${formatMoney(c.total, opts.currency)}` : ''),
    );
  }
  if (total > 0) lines.push(`Total material:  ${formatMoney(total, opts.currency)}`);
  lines.push(
    '',
    'Assembly',
    '--------',
    r.roles.includes('base') && !r.roles.includes('lid')
      ? `1. Glue all layers (L01-${layerName(r.layers.length - 1)}) into one block, L01 at the bottom; drop the item in from the top.`
      : r.topLoad
        ? [
            `1. Glue the pocket layers (L01-${layerName(r.baseCount - 1)}, engraved "B") into one block, L01 at the bottom.`,
            `2. Glue the lid pad layers (${layerName(r.baseCount)}-${layerName(r.layers.length - 1)}, engraved "T") into a second block.`,
            '3. Put the pocket block in the box and drop the item in from the top.',
            '   To unpack: lift the lid pad off, then pull the item straight up out of the pocket',
            '   (use the finger notches on either side).',
          ].join('\n')
        : r.roles.includes('base')
          ? [
              `1. Glue the base layers (L01-${layerName(r.baseCount - 1)}, engraved "B") into one block, L01 at the bottom.`,
              `2. Glue the lid layers (${layerName(r.baseCount)}-${layerName(r.layers.length - 1)}, engraved "T") into a second block.`,
              '3. Put the base in the box, drop the item in, close with the lid block, tape the box.',
              '   The cavities have no undercuts, so the item lifts straight out.',
            ].join('\n')
          : '1. Stack the layers in order, L01 at the bottom, placing the item as you go.',
    rep.islands > 0
      ? `Note: ${rep.islands} loose foam insert(s) sit inside cavities — glue them to the layer below.`
      : '',
    '',
    'Colours: red #FF0000 / DXF layer CUT = cut through; blue #0000FF / ENGRAVE = engrave only.',
    'Layer files share one origin (+5 mm margin); sheets/<thickness>/ are nested per foam thickness.',
    ...(rep.warnings.length
      ? ['', 'Warnings', '--------', ...rep.warnings.map((w) => `- ${w}`)]
      : []),
    '',
  );
  return lines.join('\n');
}

function cutList(x: InsertExportInput): string {
  const r = x.result;
  const rows = ['layer,role,thickness_mm,thickness,z0_mm,z1_mm,cutouts,foam_area_mm2'];
  r.layers.forEach((l, i) => {
    if (x.removed?.has(i)) return;
    const area = l.loops.reduce((a, q) => a + q.area, 0);
    rows.push(
      [
        layerName(i),
        layerRole(r, i),
        r.thickness[i].toFixed(2),
        thicknessLabel(r.thickness[i]),
        l.z0.toFixed(2),
        l.z1.toFixed(2),
        l.loops.length - 1,
        area.toFixed(0),
      ].join(','),
    );
  });
  return rows.join('\n') + '\n';
}

export function buildInsertFiles(
  x: InsertExportInput,
  opts: InsertExportOptions,
): { path: string; data: string }[] {
  const files: { path: string; data: string }[] = [];
  const all = asExportInput(x);
  if (opts.perLayer) {
    x.result.layers.forEach((_, i) => {
      if (x.removed?.has(i)) return;
      const d = layerDrawing(all, i);
      const base = `layers/${insertLayerFileBase(x.result, i)}`;
      if (opts.dxf) files.push({ path: `${base}.dxf`, data: drawingToDXF(d) });
      if (opts.svg) files.push({ path: `${base}.svg`, data: drawingToSVG(d) });
    });
  }
  if (opts.sheets) {
    for (const g of x.groups) {
      const input = asExportInput(x, g);
      g.nest.sheets.forEach((sh, k) => {
        const d = sheetDrawing(input, k);
        const name = `sheet_${String(k + 1).padStart(2, '0')}${sh.oversize ? '_oversize' : ''}`;
        const base = `sheets/${thicknessLabel(g.thickness)}/${name}`;
        if (opts.dxf) files.push({ path: `${base}.dxf`, data: drawingToDXF(d) });
        if (opts.svg) files.push({ path: `${base}.svg`, data: drawingToSVG(d) });
      });
    }
  }
  files.push({ path: 'cut_list.csv', data: cutList(x) });
  files.push({ path: 'README.txt', data: readme(x, opts) });
  return files;
}
