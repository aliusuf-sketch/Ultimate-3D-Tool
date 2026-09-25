/** Flat typed-array packing so results cross the worker boundary as transferables. */
import type { LayerExtras, SlicedLayer } from '../types';

export interface PackedLayers {
  n: number;
  z: Float64Array; // z0, z1 per layer
  coords: Float64Array;
  loopOffsets: Uint32Array; // per loop start in coords; length nLoops + 1
  loopDepth: Int32Array;
  layerLoops: Uint32Array; // per layer first loop; length n + 1
  openCoords: Float64Array;
  openOffsets: Uint32Array;
  layerOpen: Uint32Array;
}

function packChains(chains: Float64Array[][]): [Float64Array, Uint32Array, Uint32Array] {
  let total = 0,
    count = 0;
  for (const list of chains)
    for (const c of list) {
      total += c.length;
      count++;
    }
  const coords = new Float64Array(total);
  const offsets = new Uint32Array(count + 1);
  const layerIdx = new Uint32Array(chains.length + 1);
  let o = 0,
    k = 0;
  chains.forEach((list, L) => {
    layerIdx[L] = k;
    for (const c of list) {
      offsets[k++] = o;
      coords.set(c, o);
      o += c.length;
    }
  });
  offsets[count] = o;
  layerIdx[chains.length] = k;
  return [coords, offsets, layerIdx];
}

export function packLayers(layers: SlicedLayer[]): PackedLayers {
  const z = new Float64Array(layers.length * 2);
  layers.forEach((l, i) => {
    z[i * 2] = l.z0;
    z[i * 2 + 1] = l.z1;
  });
  const [coords, loopOffsets, layerLoops] = packChains(
    layers.map((l) => l.loops.map((x) => x.pts)),
  );
  const loopDepth = Int32Array.from(layers.flatMap((l) => l.loops.map((x) => x.depth)));
  const [openCoords, openOffsets, layerOpen] = packChains(layers.map((l) => l.open));
  return {
    n: layers.length,
    z,
    coords,
    loopOffsets,
    loopDepth,
    layerLoops,
    openCoords,
    openOffsets,
    layerOpen,
  };
}

export function packedTransferables(p: PackedLayers): ArrayBuffer[] {
  return [
    p.z,
    p.coords,
    p.loopOffsets,
    p.loopDepth,
    p.layerLoops,
    p.openCoords,
    p.openOffsets,
    p.layerOpen,
  ].map((a) => a.buffer as ArrayBuffer);
}

/** Loops of one layer as zero-copy views. */
export function layerLoops(p: PackedLayers, L: number): { pts: Float64Array; depth: number }[] {
  const out = [];
  for (let k = p.layerLoops[L]; k < p.layerLoops[L + 1]; k++) {
    out.push({
      pts: p.coords.subarray(p.loopOffsets[k], p.loopOffsets[k + 1]),
      depth: p.loopDepth[k],
    });
  }
  return out;
}

export function layerOpenChains(p: PackedLayers, L: number): Float64Array[] {
  const out = [];
  for (let k = p.layerOpen[L]; k < p.layerOpen[L + 1]; k++) {
    out.push(p.openCoords.subarray(p.openOffsets[k], p.openOffsets[k + 1]));
  }
  return out;
}

export interface PackedExtras {
  pins: Float64Array; // x, y, r
  layerPins: Uint32Array; // per layer first pin; length n + 1
  labels: Float64Array; // x, y, h per layer (h = 0 => none)
  missing: Uint32Array; // missing pins per layer
}

export function packExtras(extras: LayerExtras[]): PackedExtras {
  const total = extras.reduce((a, e) => a + e.pins.length, 0);
  const pins = new Float64Array(total * 3);
  const layerPins = new Uint32Array(extras.length + 1);
  const labels = new Float64Array(extras.length * 3);
  const missing = new Uint32Array(extras.length);
  let k = 0;
  extras.forEach((e, L) => {
    layerPins[L] = k;
    for (const p of e.pins) {
      pins.set([p.x, p.y, p.r], k * 3);
      k++;
    }
    if (e.label) labels.set([e.label.x, e.label.y, e.label.h], L * 3);
    missing[L] = e.missingPins;
  });
  layerPins[extras.length] = k;
  return { pins, layerPins, labels, missing };
}

export function extrasTransferables(e: PackedExtras): ArrayBuffer[] {
  return [e.pins, e.layerPins, e.labels, e.missing].map((a) => a.buffer as ArrayBuffer);
}
