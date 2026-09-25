/// <reference lib="webworker" />
import {
  buildExportFiles,
  buildZip,
  layerDrawing,
  layerFileBase,
  type ExportInput,
} from '../core/export/zip';
import { drawingToSVG } from '../core/export/svg';
import { computeExtras } from '../core/extras';
import { partsArea } from '../core/cost';
import { signedArea } from '../core/topology';
import { buildParts, nestParts } from '../core/nest';
import { extrasTransferables, packedTransferables, packExtras, packLayers } from '../core/pack';
import { sliceModelIter } from '../core/pipeline';
import { buildPreview, previewTolerance } from '../core/preview';
import { makeTorus } from '../core/sample';
import { parseSTL } from '../core/stl';
import { computeBBox, transformMesh } from '../core/transform';
import type {
  ExtrasSettings,
  LayerExtras,
  Mesh,
  NestResult,
  Part,
  SliceSettings,
  SlicedLayer,
} from '../types';
import type { FromWorker, ToWorker } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

class Cancelled extends Error {}

// ---- State ----
let source: { mesh: Mesh; name: string } | null = null;
let sourceVersion = 0;

const want = {
  sliceJob: -1,
  slice: null as SliceSettings | null,
  extrasJob: -1,
  extras: null as ExtrasSettings | null,
};

let sliced: {
  sliceJob: number;
  sourceVersion: number;
  settings: SliceSettings;
  size: [number, number, number];
  layers: SlicedLayer[];
} | null = null;

let extrasDone: {
  key: string;
  extras: LayerExtras[];
  parts: Part[];
  nest: NestResult;
} | null = null;

// ---- Cooperative yielding (lets newer messages supersede running work) ----
const channel = new MessageChannel();
const waiters: (() => void)[] = [];
channel.port1.onmessage = () => waiters.shift()?.();
const yieldNow = () =>
  new Promise<void>((res) => {
    waiters.push(res);
    channel.port2.postMessage(0);
  });

async function drive<T>(
  it: Generator<number, T>,
  stage: string,
  stillWanted: () => boolean,
): Promise<T> {
  let last = performance.now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    const now = performance.now();
    if (now - last > 30) {
      post({ type: 'progress', stage, f: r.value });
      await yieldNow();
      if (!stillWanted()) throw new Cancelled();
      last = performance.now();
    }
  }
}

// ---- Pipeline ----
async function doSlice(): Promise<void> {
  const job = want.sliceJob;
  const settings = want.slice!;
  const src = source!;
  const version = sourceVersion;
  const stillWanted = () => want.sliceJob === job && sourceVersion === version;
  const t0 = performance.now();
  post({ type: 'progress', stage: 'Transforming', f: 0 });
  const { mesh, size } = transformMesh(src.mesh, settings.axis, settings.scale);
  await yieldNow();
  if (!stillWanted()) throw new Cancelled();
  const out = await drive(
    sliceModelIter(mesh, size[2], settings.thickness, settings.tolerance),
    'Slicing',
    stillWanted,
  );
  post({ type: 'progress', stage: 'Building preview', f: 1 });
  const preview = buildPreview(out.layers, previewTolerance(settings.tolerance, size[0], size[1]));
  sliced = { sliceJob: job, sourceVersion: version, settings, size, layers: out.layers };
  extrasDone = null;
  const layers = packLayers(out.layers);
  post(
    {
      type: 'sliced',
      sliceJob: job,
      summary: {
        size,
        layerCount: out.layers.length,
        openCount: out.openCount,
        ms: performance.now() - t0,
      },
      layers,
      preview,
    },
    [
      ...packedTransferables(layers),
      preview.positions.buffer,
      preview.normals.buffer,
      preview.colors.buffer,
      preview.layerStart.buffer,
    ],
  );
}

async function doExtras(): Promise<void> {
  const s = sliced!;
  const settings = want.extras!;
  const job = want.extrasJob;
  const key = `${s.sliceJob}:${job}`;
  await yieldNow();
  if (want.extrasJob !== job || want.sliceJob !== s.sliceJob) throw new Cancelled();
  const { extras, pinsMissingLayers } = computeExtras(s.layers, s.size[0], s.size[1], settings);
  const parts = buildParts(s.layers, extras);
  const nest = nestParts(parts, settings.sheetW, settings.sheetH, settings.gap);
  extrasDone = { key, extras, parts, nest };
  const packed = packExtras(extras);
  post(
    {
      type: 'extras',
      sliceJob: s.sliceJob,
      extrasJob: job,
      summary: {
        pinsMissingLayers,
        sheetCount: nest.sheets.length,
        sheets: nest.sheets,
        partArea: partsArea(parts, signedArea),
        oversizeCount: nest.oversizeCount,
        partCount: parts.length,
      },
      extras: packed,
    },
    extrasTransferables(packed),
  );
}

let pumping = false;
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (!source || !want.slice || !want.extras) break;
      try {
        if (
          !sliced ||
          sliced.sliceJob !== want.sliceJob ||
          sliced.sourceVersion !== sourceVersion
        ) {
          await doSlice();
          continue;
        }
        if (!extrasDone || extrasDone.key !== `${sliced.sliceJob}:${want.extrasJob}`) {
          await doExtras();
          continue;
        }
      } catch (e) {
        if (e instanceof Cancelled) continue;
        throw e;
      }
      break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    pumping = false;
  }
}

function setSource(mesh: Mesh, name: string, job: number) {
  source = { mesh, name };
  sourceVersion++;
  want.slice = null; // wait for the next compute request with settings for this model
  sliced = null;
  extrasDone = null;
  const bb = computeBBox(mesh.positions);
  const size: [number, number, number] = [
    bb.max[0] - bb.min[0],
    bb.max[1] - bb.min[1],
    bb.max[2] - bb.min[2],
  ];
  post({ type: 'loaded', job, name, triCount: mesh.triCount, size });
}

function exportInput(): ExportInput {
  if (!sliced || !extrasDone || !source) throw new Error('Nothing to export yet');
  return {
    sourceName: source.name,
    thickness: sliced.settings.thickness,
    size: sliced.size,
    layers: sliced.layers,
    extras: extrasDone.extras,
    parts: extrasDone.parts,
    nest: extrasDone.nest,
  };
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'load':
        post({ type: 'progress', stage: 'Parsing', f: 0 });
        setSource(parseSTL(m.buffer), m.name, m.job);
        void pump();
        break;
      case 'loadSample':
        setSource(makeTorus(), 'sample-torus.stl', m.job);
        void pump();
        break;
      case 'compute':
        want.sliceJob = m.sliceJob;
        want.slice = m.slice;
        want.extrasJob = m.extrasJob;
        want.extras = m.extras;
        void pump();
        break;
      case 'export': {
        const files = buildExportFiles(
          { ...exportInput(), sheetW: want.extras!.sheetW, sheetH: want.extras!.sheetH },
          m.opts,
        );
        const zip = await buildZip(files);
        post({ type: 'exported', job: m.job, zip, fileCount: files.length }, [zip.buffer]);
        break;
      }
      case 'layerSvg': {
        const input = exportInput();
        const layer = input.layers[m.layer];
        if (!layer) throw new Error('No such layer');
        post({
          type: 'layerSvg',
          job: m.job,
          name: `${layerFileBase(layer)}.svg`,
          svg: drawingToSVG(layerDrawing(input, m.layer)),
        });
        break;
      }
    }
  } catch (e) {
    post({
      type: 'error',
      job: 'job' in m ? m.job : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
