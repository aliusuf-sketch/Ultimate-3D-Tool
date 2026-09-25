/** Split layers into parts and shelf-pack them onto sheets. */
import type { LayerExtras, NestResult, Part, Placement, SheetInfo, SlicedLayer } from '../types';
import { pointInPolygon } from './topology';

/** One part per solid (even-depth) loop, carrying its direct holes, pins and label. */
export function buildParts(layers: SlicedLayer[], extras: LayerExtras[]): Part[] {
  const parts: Part[] = [];
  for (const layer of layers) {
    const ex = extras[layer.index];
    const ownerOf = (x: number, y: number): number => {
      let owner = -1;
      layer.loops.forEach((l, k) => {
        if (l.depth % 2 === 0 && pointInPolygon(x, y, l.pts)) owner = k;
      });
      return owner;
    };
    const pinOwner = ex ? ex.pins.map((p) => ownerOf(p.x, p.y)) : [];
    const labelOwner = ex?.label ? ownerOf(ex.label.x, ex.label.y) : -1;
    layer.loops.forEach((l, k) => {
      if (l.depth % 2 !== 0) return;
      const loops = [l.pts];
      for (const h of layer.loops) if (h.parent === k && h.depth % 2 === 1) loops.push(h.pts);
      parts.push({
        layer: layer.index,
        loops,
        pins: ex ? ex.pins.filter((_, i) => pinOwner[i] === k) : [],
        label: ex && labelOwner === k ? ex.label : null,
        bbox: l.bbox,
      });
    });
  }
  return parts;
}

interface Shelf {
  sheet: number;
  y: number;
  h: number;
  x: number; // next free x
}

/**
 * First-fit decreasing-height shelf packing. `gap` is both the spacing between parts
 * and the sheet margin. Parts are rotated 90° when that is the only way they fit, or
 * to make them landscape. Parts larger than a sheet get their own oversize sheet.
 */
export function nestParts(parts: Part[], sheetW: number, sheetH: number, gap: number): NestResult {
  const usableW = sheetW - 2 * gap;
  const usableH = sheetH - 2 * gap;
  const fits = (w: number, h: number) => w <= usableW + 1e-9 && h <= usableH + 1e-9;

  const items = parts.map((p, i) => {
    const w = p.bbox[2] - p.bbox[0];
    const h = p.bbox[3] - p.bbox[1];
    let rotated = false;
    let oversize = false;
    if (!fits(w, h)) {
      if (fits(h, w)) rotated = true;
      else oversize = true;
    } else if (h > w && fits(h, w)) {
      rotated = true; // make landscape
    }
    return { i, w: rotated ? h : w, h: rotated ? w : h, rotated, oversize };
  });

  const regular = items.filter((it) => !it.oversize).sort((a, b) => b.h - a.h || b.w - a.w);
  const placements: Placement[] = [];
  const sheets: SheetInfo[] = [];
  const shelves: Shelf[] = [];
  const sheetUsedH: number[] = []; // y of next shelf per sheet

  for (const it of regular) {
    let shelf = shelves.find((s) => it.h <= s.h + 1e-9 && s.x + it.w <= gap + usableW + 1e-9);
    if (!shelf) {
      let sheet = sheetUsedH.findIndex((y) => y + it.h <= gap + usableH + 1e-9);
      if (sheet < 0) {
        sheet = sheets.length;
        sheets.push({ index: sheet, oversize: false, w: sheetW, h: sheetH });
        sheetUsedH.push(gap);
      }
      shelf = { sheet, y: sheetUsedH[sheet], h: it.h, x: gap };
      sheetUsedH[sheet] += it.h + gap;
      shelves.push(shelf);
    }
    placements.push({ part: it.i, sheet: shelf.sheet, rotated: it.rotated, x: shelf.x, y: shelf.y });
    shelf.x += it.w + gap;
  }

  let oversizeCount = 0;
  for (const it of items) {
    if (!it.oversize) continue;
    oversizeCount++;
    const sheet = sheets.length;
    sheets.push({ index: sheet, oversize: true, w: it.w + 2 * gap, h: it.h + 2 * gap });
    placements.push({ part: it.i, sheet, rotated: false, x: gap, y: gap });
  }
  placements.sort((a, b) => a.sheet - b.sheet || a.part - b.part);
  return { placements, sheets, oversizeCount };
}

/** Maps a part-space point to sheet space for a placement. */
export function placeTransform(part: Part, pl: Placement): (x: number, y: number) => [number, number] {
  const [bx0, by0, , by1] = part.bbox;
  if (pl.rotated) {
    // (x, y) -> (-y, x); rotated bbox min = (-by1, bx0)
    return (x, y) => [-y + by1 + pl.x, x - bx0 + pl.y];
  }
  return (x, y) => [x - bx0 + pl.x, y - by0 + pl.y];
}
