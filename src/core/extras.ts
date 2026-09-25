/** Alignment pins and layer labels. */
import type { ExtrasSettings, Label, LayerExtras, Pin, SlicedLayer } from '../types';
import { edgeDistance, insideSolid } from './topology';

export const PIN_CLEARANCE = 0.8; // mm of material required around a pin hole

/** Pin centres shared by every layer, placed along the longer footprint axis. */
export function pinPositions(footW: number, footD: number, s: ExtrasSettings): Pin[] {
  if (s.pinMode === 'none' || s.pinDiameter <= 0) return [];
  const r = s.pinDiameter / 2;
  const cx = footW / 2 + s.pinOffsetX;
  const cy = footD / 2 + s.pinOffsetY;
  if (s.pinMode === 'one') return [{ x: cx, y: cy, r }];
  const h = s.pinSpacing / 2;
  return footW >= footD
    ? [
        { x: cx - h, y: cy, r },
        { x: cx + h, y: cy, r },
      ]
    : [
        { x: cx, y: cy - h, r },
        { x: cx, y: cy + h, r },
      ];
}

export function layerName(i: number): string {
  return `L${String(i + 1).padStart(2, '0')}`;
}

/** Approximate half-diagonal of a text box, in units of text height. */
function textRadiusFactor(text: string): number {
  const halfW = 0.5 * text.length * 0.72;
  return Math.hypot(halfW, 0.5);
}

export const MIN_LABEL_HEIGHT = 1.5;

export function placeLabel(
  layer: SlicedLayer,
  pins: Pin[],
  s: ExtrasSettings,
  text = layerName(layer.index),
): Label | null {
  const main = layer.loops.find((l) => l.depth === 0);
  if (!main) return null;
  const [x0, y0, x1, y1] = main.bbox;
  const G = 11;
  let best: { x: number; y: number; c: number } | null = null;
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      const x = x0 + ((i + 0.5) / G) * (x1 - x0);
      const y = y0 + ((j + 0.5) / G) * (y1 - y0);
      if (!insideSolid(x, y, layer.loops)) continue;
      let c = edgeDistance(x, y, layer.loops);
      for (const p of pins) c = Math.min(c, Math.hypot(x - p.x, y - p.y) - p.r - PIN_CLEARANCE);
      if (c <= 0) continue;
      if (!best || c > best.c) best = { x, y, c };
    }
  }
  if (!best) return null;
  const f = textRadiusFactor(text);
  const h = Math.min(s.labelHeight, (best.c * 0.9) / f);
  if (h < MIN_LABEL_HEIGHT) return null;
  return { text, x: best.x, y: best.y, h };
}

export function computeExtras(
  layers: SlicedLayer[],
  footW: number,
  footD: number,
  s: ExtrasSettings,
  labelText?: (index: number) => string,
): { extras: LayerExtras[]; pinsMissingLayers: number } {
  const all = pinPositions(footW, footD, s);
  let pinsMissingLayers = 0;
  const extras = layers.map((layer) => {
    const pins = all.filter(
      (p) =>
        insideSolid(p.x, p.y, layer.loops) &&
        edgeDistance(p.x, p.y, layer.loops) >= p.r + PIN_CLEARANCE,
    );
    const missingPins = all.length - pins.length;
    if (missingPins > 0) pinsMissingLayers++;
    const label = s.labels
      ? placeLabel(layer, pins, s, labelText ? labelText(layer.index) : undefined)
      : null;
    return { pins, label, missingPins };
  });
  return { extras, pinsMissingLayers };
}
