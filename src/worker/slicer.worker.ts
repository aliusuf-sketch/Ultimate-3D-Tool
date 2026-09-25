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
import { makeTorus, makeVase } from '../core/sample';
import { buildInsertIter, type InsertResult, type InsertSettings } from '../core/insert';
import {
  buildInsertFiles,
  insertLabelText,
  insertLayerFileBase,
  insertLayerSVG,
  type InsertExportInput,
  type ThicknessGroup,
} from '../core/export/insertZip';
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
import type { FromWorker, InsertExtrasSettings, ToWorker } from './protocol';

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

// Shipping-insert mode.
let activeMode: 'slicer' | 'ship' = 'slicer';
const insertWant = {
  job: -1,
  settings: null as InsertSettings | null,
  extras: null as InsertExtrasSettings | null,
};
let insertDone: {
  job: number;
  sourceVersion: number;
  data: InsertExportInput | null; // null when the job failed
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

/** Nest each foam thickness separately, skipping removed layers. */
function nestGroups(
  result: InsertResult,
  extras: LayerExtras[],
  ex: InsertExtrasSettings,
  removed: Set<number>,
): ThicknessGroup[] {
  const groups: ThicknessGroup[] = [];
  const kept = result.thickness.flatMap((v, i) => (removed.has(i) ? [] : [v]));
  for (const t of [...new Set(kept.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b)) {
    const idx = result.thickness.flatMap((v, i) =>
      Math.abs(v - t) < 0.01 && !removed.has(i) ? [i] : [],
    );
    const parts = buildParts(
      idx.map((i) => result.layers[i]),
      extras,
    );
    const nest = nestParts(parts, ex.sheetW, ex.sheetH, ex.gap);
    groups.push({ thickness: t, layers: idx, parts, nest, partArea: partsArea(parts, signedArea) });
  }
  return groups;
}

const groupSummary = (groups: ThicknessGroup[]) =>
  groups.map((g) => ({
    thickness: g.thickness,
    layerCount: g.layers.length,
    sheets: g.nest.sheets,
    partArea: g.partArea,
  }));

async function doInsert(): Promise<void> {
  const job = insertWant.job;
  const settings = insertWant.settings!;
  const ex = insertWant.extras!;
  const src = source!;
  const version = sourceVersion;
  const stillWanted = () =>
    insertWant.job === job && sourceVersion === version && activeMode === 'ship';
  const t0 = performance.now();
  let result: InsertResult;
  try {
    result = await drive(buildInsertIter(src.mesh, settings), 'Planning insert', stillWanted);
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    insertDone = { job, sourceVersion: version, data: null };
    post({ type: 'insertError', job, message: e instanceof Error ? e.message : String(e) });
    return;
  }
  post({ type: 'progress', stage: 'Labels and nesting', f: 1 });
  const { extras } = computeExtras(
    result.layers,
    result.rect[0],
    result.rect[1],
    {
      pinMode: 'none',
      pinDiameter: 0,
      pinSpacing: 0,
      pinOffsetX: 0,
      pinOffsetY: 0,
      labels: ex.labels,
      labelHeight: ex.labelHeight,
      sheetW: ex.sheetW,
      sheetH: ex.sheetH,
      gap: ex.gap,
    },
    (i) => insertLabelText(result.roles[i], i),
  );
  const groups = nestGroups(result, extras, ex, new Set());
  const data: InsertExportInput = {
    sourceName: src.name,
    result,
    extras,
    groups,
    sheetW: ex.sheetW,
    sheetH: ex.sheetH,
  };
  insertDone = { job, sourceVersion: version, data };
  const preview = buildPreview(
    result.layers,
    previewTolerance(0.1, result.rect[0], result.rect[1]),
  );
  const layers = packLayers(result.layers, result.ghosts);
  const packedExtras = packExtras(extras);
  const item = result.item.slice();
  post(
    {
      type: 'inserted',
      job,
      summary: {
        rect: result.rect,
        stackHeight: result.stackHeight,
        thickness: result.thickness,
        roles: result.roles,
        baseCount: result.baseCount,
        topLoad: result.topLoad,
        itemSize: result.itemSize,
        itemOffset: result.itemOffset,
        report: result.report,
        groups: groupSummary(groups),
        sheetW: ex.sheetW,
        sheetH: ex.sheetH,
        ms: performance.now() - t0,
      },
      layers,
      preview,
      extras: packedExtras,
      item,
    },
    [
      ...packedTransferables(layers),
      ...extrasTransferables(packedExtras),
      preview.positions.buffer,
      preview.normals.buffer,
      preview.colors.buffer,
      preview.layerStart.buffer,
      item.buffer,
    ],
  );
}

let pumping = false;
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (!source) break;
      if (activeMode === 'ship') {
        if (!insertWant.settings || !insertWant.extras) break;
        try {
          if (
            !insertDone ||
            insertDone.job !== insertWant.job ||
            insertDone.sourceVersion !== sourceVersion
          ) {
            await doInsert();
            continue;
          }
        } catch (e) {
          if (e instanceof Cancelled) continue;
          throw e;
        }
        break;
      }
      if (!want.slice || !want.extras) break;
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
  insertWant.settings = null;
  insertDone = null;
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
        if (m.kind === 'vase') setSource(makeVase(), 'sample-vase.stl', m.job);
        else setSource(makeTorus(), 'sample-torus.stl', m.job);
        void pump();
        break;
      case 'insert':
        activeMode = 'ship';
        insertWant.job = m.job;
        insertWant.settings = m.settings;
        insertWant.extras = m.extras;
        void pump();
        break;
      case 'insertRemoved': {
        const d = insertDone;
        if (!d?.data || d.job !== m.job) break;
        const removed = new Set(m.removed);
        d.data.removed = removed;
        d.data.groups = nestGroups(d.data.result, d.data.extras, insertWant.extras!, removed);
        post({ type: 'insertGroups', job: m.job, groups: groupSummary(d.data.groups) });
        break;
      }
      case 'exportInsert': {
        const data = insertDone?.data;
        if (!data) throw new Error('Nothing to export yet');
        const files = buildInsertFiles(data, m.opts);
        const zip = await buildZip(files);
        post({ type: 'exported', job: m.job, zip, fileCount: files.length }, [zip.buffer]);
        break;
      }
      case 'compute':
        activeMode = 'slicer';
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
        if (activeMode === 'ship') {
          const data = insertDone?.data;
          if (!data || !data.result.layers[m.layer]) throw new Error('Nothing to export yet');
          post({
            type: 'layerSvg',
            job: m.job,
            name: `${insertLayerFileBase(data.result, m.layer)}.svg`,
            svg: insertLayerSVG(data, m.layer),
          });
          break;
        }
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
