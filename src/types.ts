/** Shared types. Everything here is plain data so it can cross the worker boundary. */

export type StackAxis = 'z' | 'y' | 'x';

/** Triangle soup: 9 floats per triangle (x0,y0,z0,x1,y1,z1,x2,y2,z2), millimetres. */
export interface Mesh {
  positions: Float32Array;
  triCount: number;
}

export interface BBox3 {
  min: [number, number, number];
  max: [number, number, number];
}

/** Closed loop, points interleaved x,y. The closing edge (last -> first) is implicit. */
export type Loop = Float64Array;

export interface SlicedLoop {
  pts: Loop;
  area: number; // signed; solids CCW (>0), holes CW (<0) after orientation fixup
  depth: number; // even = solid, odd = hole
  parent: number; // index into the layer's loops, -1 for none
  bbox: [number, number, number, number]; // minX, minY, maxX, maxY
}

export interface SlicedLayer {
  index: number;
  z0: number;
  z1: number;
  plane: number;
  loops: SlicedLoop[]; // sorted by |area| descending
  open: Float64Array[]; // unclosed chains (mesh gaps)
}

export interface SliceSettings {
  axis: StackAxis;
  scale: [number, number, number]; // per-axis factors applied after orientation (1 = 100 %)
  thickness: number; // mm
  tolerance: number; // Douglas–Peucker tolerance, mm
}

export type PinMode = 'none' | 'one' | 'two';

export interface ExtrasSettings {
  pinMode: PinMode;
  pinDiameter: number;
  pinSpacing: number;
  pinOffsetX: number;
  pinOffsetY: number;
  labels: boolean;
  labelHeight: number;
  sheetW: number;
  sheetH: number;
  gap: number;
}

export interface Pin {
  x: number;
  y: number;
  r: number;
}

export interface Label {
  text: string;
  x: number;
  y: number;
  h: number;
}

export interface LayerExtras {
  pins: Pin[];
  label: Label | null;
  missingPins: number;
}

/** A cuttable piece: one solid outline plus its direct holes. */
export interface Part {
  layer: number;
  loops: Loop[]; // [outer, ...holes]
  pins: Pin[];
  label: Label | null;
  bbox: [number, number, number, number];
}

export interface Placement {
  part: number;
  sheet: number;
  rotated: boolean; // 90° CCW proper rotation
  x: number; // sheet position of the (rotated) part's bbox min corner
  y: number;
}

export interface SheetInfo {
  index: number;
  oversize: boolean;
  w: number;
  h: number;
}

export interface NestResult {
  placements: Placement[];
  sheets: SheetInfo[];
  oversizeCount: number;
}

/** Generic 2-D drawing handed to the DXF / SVG writers. y points up, mm. */
export interface Drawing {
  width: number;
  height: number;
  cuts: Loop[];
  circles: Pin[];
  texts: Label[];
}

export interface ExportOptions {
  dxf: boolean;
  svg: boolean;
  perLayer: boolean;
  sheets: boolean;
  pricePerSheet: number;
  currency: string;
}
