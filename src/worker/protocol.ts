import type { PackedExtras, PackedLayers } from '../core/pack';
import type { PreviewGeometry } from '../core/preview';
import type { InsertReport, InsertSettings, LayerRole, LayerSection } from '../core/insert';
import type { InsertExportOptions } from '../core/export/insertZip';
import type { SheetInfo, ExportOptions, ExtrasSettings, SliceSettings } from '../types';

export type ToWorker =
  | { type: 'load'; job: number; buffer: ArrayBuffer; name: string }
  | { type: 'loadSample'; job: number; kind: 'torus' | 'vase' }
  | {
      type: 'compute';
      sliceJob: number;
      slice: SliceSettings;
      extrasJob: number;
      extras: ExtrasSettings;
    }
  | { type: 'insert'; job: number; settings: InsertSettings; extras: InsertExtrasSettings }
  | { type: 'export'; job: number; opts: ExportOptions }
  | { type: 'exportInsert'; job: number; opts: InsertExportOptions }
  | { type: 'insertRemoved'; job: number; removed: number[] }
  | { type: 'layerSvg'; job: number; layer: number };

export interface InsertExtrasSettings {
  labels: boolean;
  labelHeight: number;
  sheetW: number;
  sheetH: number;
  gap: number;
}

export interface InsertGroupSummary {
  thickness: number;
  layerCount: number;
  sheets: SheetInfo[];
  partArea: number;
}

export interface InsertSummary {
  rect: [number, number];
  stackHeight: number;
  thickness: number[];
  roles: LayerRole[];
  baseCount: number;
  topLoad: boolean;
  sections: LayerSection[];
  itemSize: [number, number, number];
  itemOffset: [number, number, number];
  report: InsertReport;
  groups: InsertGroupSummary[];
  sheetW: number;
  sheetH: number;
  ms: number;
}

export interface SliceSummary {
  size: [number, number, number];
  layerCount: number;
  openCount: number;
  ms: number;
}

export interface ExtrasSummary {
  pinsMissingLayers: number;
  sheetCount: number;
  sheets: SheetInfo[];
  partArea: number; // mm², net of holes
  oversizeCount: number;
  partCount: number;
}

export type FromWorker =
  | { type: 'progress'; stage: string; f: number }
  | {
      type: 'loaded';
      job: number;
      name: string;
      triCount: number;
      size: [number, number, number];
    }
  | {
      type: 'sliced';
      sliceJob: number;
      summary: SliceSummary;
      layers: PackedLayers;
      preview: PreviewGeometry;
    }
  | {
      type: 'extras';
      sliceJob: number;
      extrasJob: number;
      summary: ExtrasSummary;
      extras: PackedExtras;
    }
  | {
      type: 'inserted';
      job: number;
      summary: InsertSummary;
      layers: PackedLayers;
      preview: PreviewGeometry;
      extras: PackedExtras;
      item: Float32Array;
    }
  | { type: 'insertError'; job: number; message: string }
  | { type: 'insertGroups'; job: number; groups: InsertGroupSummary[] }
  | { type: 'exported'; job: number; zip: Uint8Array; fileCount: number }
  | { type: 'layerSvg'; job: number; name: string; svg: string }
  | { type: 'error'; job?: number; message: string };
