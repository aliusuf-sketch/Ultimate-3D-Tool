import type { PackedExtras, PackedLayers } from '../core/pack';
import type { PreviewGeometry } from '../core/preview';
import type { SheetInfo, ExportOptions, ExtrasSettings, SliceSettings } from '../types';

export type ToWorker =
  | { type: 'load'; job: number; buffer: ArrayBuffer; name: string }
  | { type: 'loadSample'; job: number }
  | {
      type: 'compute';
      sliceJob: number;
      slice: SliceSettings;
      extrasJob: number;
      extras: ExtrasSettings;
    }
  | { type: 'export'; job: number; opts: ExportOptions }
  | { type: 'layerSvg'; job: number; layer: number };

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
  | { type: 'exported'; job: number; zip: Uint8Array; fileCount: number }
  | { type: 'layerSvg'; job: number; name: string; svg: string }
  | { type: 'error'; job?: number; message: string };
