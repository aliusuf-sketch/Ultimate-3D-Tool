import './ui/styles.css';
import SlicerWorker from './worker/slicer.worker.ts?worker';
import type { FromWorker, ToWorker, SliceSummary, ExtrasSummary } from './worker/protocol';
import type { PackedLayers } from './core/pack';
import { layerName } from './core/extras';
import { StackView } from './view3d/stack';
import { LayerView } from './view2d/layer2d';
import { SettingsForm } from './ui/settings';
import { toast } from './ui/toast';
import { initTheme } from './ui/theme';
import { debounce, download, mm } from './ui/format';
import type { ExtrasSettings, StackAxis } from './types';
import { orientedSize } from './core/transform';
import { estimateCost, formatMoney, MM_PER_FT } from './core/cost';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  fileInput: $<HTMLInputElement>('fileInput'),
  sampleBtns: [$<HTMLButtonElement>('sampleBtn'), $<HTMLButtonElement>('sampleBtn2')],
  fileInfo: $('fileInfo'),
  viewport: $('viewport'),
  canvas3d: $<HTMLCanvasElement>('canvas3d'),
  canvas2d: $<HTMLCanvasElement>('canvas2d'),
  empty: $('emptyState'),
  dropHint: $('dropHint'),
  progress: $('progress'),
  progressLabel: $('progressLabel'),
  progressBar: $('progressBar'),
  legend2d: $('legend2d'),
  tab3d: $<HTMLButtonElement>('tab3d'),
  tab2d: $<HTMLButtonElement>('tab2d'),
  slider: $<HTMLInputElement>('layerSlider'),
  readout: $('layerReadout'),
  stats: $('stats'),
  exportBtn: $<HTMLButtonElement>('exportBtn'),
  layerSvgBtn: $<HTMLButtonElement>('layerSvgBtn'),
  themeBtn: $<HTMLButtonElement>('themeBtn'),
  scaleHint: $('scaleHint'),
  resetSizeBtn: $<HTMLButtonElement>('resetSizeBtn'),
  costCard: $('costCard'),
  costTotal: $('costTotal'),
  costDetail: $('costDetail'),
};

const form = new SettingsForm($<HTMLFormElement>('settings'));
const stackView = new StackView(ui.canvas3d);
const layerView = new LayerView(ui.canvas2d);
initTheme(ui.themeBtn);

// ---- Worker & job bookkeeping ----
const worker = new SlicerWorker();
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

let loadJob = 0;
let sliceJob = 0;
let extrasJob = 0;
let exportJob = 0;
let svgJob = 0;
let lastSliceKey = '';
let lastExtrasKey = '';
let sentExtras: ExtrasSettings | null = null;
let costExtras: ExtrasSettings | null = null;
let reframeNext = true;
let gotSlice = -1;
let gotExtras = -1;

let model: { name: string; triCount: number; size: [number, number, number] } | null = null;
let layers: PackedLayers | null = null;
let sliceSummary: SliceSummary | null = null;
let extrasSummary: ExtrasSummary | null = null;
let current = 0;
let exporting = false;

const busy = () => model !== null && (gotSlice !== sliceJob || gotExtras !== extrasJob);

function setProgress(stage: string | null, f = 0): void {
  if (stage === null) {
    ui.progress.hidden = true;
    return;
  }
  ui.progress.hidden = false;
  ui.progressLabel.textContent = `${stage}… ${Math.round(f * 100)}%`;
  ui.progressBar.style.width = `${Math.round(f * 100)}%`;
}

function syncButtons(): void {
  const ready = !!layers && layers.n > 0 && !busy() && !exporting;
  ui.exportBtn.disabled = !ready;
  ui.layerSvgBtn.disabled = !ready;
  ui.exportBtn.textContent = exporting ? 'Building ZIP…' : 'Download ZIP';
}

// ---- Model size (X / Y / Z in mm, oriented frame) ----
let baseAxis: StackAxis = 'z';

function baseSize(axis: StackAxis = form.axis()): [number, number, number] {
  return model ? orientedSize(model.size, axis) : [0, 0, 0];
}

function factors(): [number, number, number] {
  const b = baseSize(baseAxis);
  const s = form.size(b);
  return [0, 1, 2].map((i) => (b[i] > 0 ? s[i] / b[i] : 1)) as [number, number, number];
}

function setSize(k: [number, number, number]): void {
  const b = baseSize();
  (['sizeX', 'sizeY', 'sizeZ'] as const).forEach((n, i) => form.set(n, b[i] * k[i]));
  updateScaleHint();
}

function updateScaleHint(): void {
  const f = factors().map((v) => Math.round(v * 1000) / 10);
  ui.scaleHint.textContent =
    f[0] === f[1] && f[1] === f[2]
      ? `Scale ${f[0]} %`
      : `Scale X ${f[0]} % · Y ${f[1]} % · Z ${f[2]} %`;
}

// ---- Compute requests ----
function compute(): void {
  if (!model) return;
  const slice = form.slice(baseSize());
  const extras = form.extras();
  const sKey = JSON.stringify(slice);
  const eKey = JSON.stringify(extras);
  if (sKey !== lastSliceKey) {
    const prev = lastSliceKey ? JSON.parse(lastSliceKey) : null;
    if (
      !prev ||
      prev.axis !== slice.axis ||
      JSON.stringify(prev.scale) !== JSON.stringify(slice.scale)
    )
      reframeNext = true;
    sliceJob++;
    extrasJob++;
  } else if (eKey !== lastExtrasKey) {
    extrasJob++;
  } else {
    return;
  }
  lastSliceKey = sKey;
  lastExtrasKey = eKey;
  sentExtras = extras;
  send({ type: 'compute', sliceJob, slice, extrasJob, extras });
  if (gotSlice !== sliceJob) setProgress('Slicing', 0);
  syncButtons();
}
const computeSoon = debounce(compute, 200);

// ---- Worker messages ----
worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'progress':
      if (busy() || !model) setProgress(m.stage, m.f);
      break;
    case 'loaded': {
      if (m.job !== loadJob) return;
      model = { name: m.name, triCount: m.triCount, size: m.size };
      ui.fileInfo.innerHTML = '';
      const b = document.createElement('strong');
      b.textContent = m.name;
      ui.fileInfo.append(
        b,
        ` · ${m.triCount.toLocaleString()} triangles · ${mm(m.size[0])} × ${mm(m.size[1])} × ${mm(m.size[2])} mm`,
      );
      ui.empty.hidden = true;
      lastSliceKey = '';
      lastExtrasKey = '';
      reframeNext = true;
      baseAxis = form.axis();
      setSize([1, 1, 1]);
      compute();
      break;
    }
    case 'sliced': {
      if (m.sliceJob !== sliceJob) return;
      gotSlice = m.sliceJob;
      layers = m.layers;
      sliceSummary = m.summary;
      extrasSummary = null;
      renderCost();
      stackView.setPreview(m.preview, m.summary.size, reframeNext);
      reframeNext = false;
      layerView.setData(m.layers, [m.summary.size[0], m.summary.size[1]]);
      ui.slider.max = String(Math.max(0, m.layers.n - 1));
      ui.slider.disabled = m.layers.n === 0;
      current = Math.min(current, Math.max(0, m.layers.n - 1));
      ui.slider.value = String(current);
      selectLayer(current);
      setProgress('Placing pins, labels and nesting', 1);
      renderStats();
      syncButtons();
      break;
    }
    case 'extras': {
      if (m.sliceJob !== sliceJob || m.extrasJob !== extrasJob) return;
      gotExtras = m.extrasJob;
      extrasSummary = m.summary;
      costExtras = sentExtras;
      renderCost();
      layerView.setExtras(m.extras);
      setProgress(null);
      renderStats();
      syncButtons();
      break;
    }
    case 'exported': {
      if (m.job !== exportJob) return;
      exporting = false;
      syncButtons();
      const base = (model?.name ?? 'model').replace(/\.stl$/i, '');
      download(m.zip as Uint8Array<ArrayBuffer>, `${base}_foam_layers.zip`, 'application/zip');
      toast(`ZIP ready — ${m.fileCount} files`);
      break;
    }
    case 'layerSvg':
      if (m.job !== svgJob) return;
      download(m.svg, m.name, 'image/svg+xml');
      break;
    case 'error':
      exporting = false;
      setProgress(null);
      syncButtons();
      toast(m.message, 'error', 6000);
      if (m.job === loadJob && !layers) ui.empty.hidden = false;
      break;
  }
};
worker.onerror = (e) => {
  setProgress(null);
  toast(`Worker error: ${e.message}`, 'error', 6000);
};

// ---- Stats & readout ----
function renderStats(): void {
  const s = sliceSummary;
  if (!s || !layers) {
    ui.stats.textContent = 'Load a model to begin.';
    return;
  }
  const t = layers.n > 0 ? layers.z[1] - layers.z[0] : 0;
  const parts: string[] = [
    `<b>${s.layerCount}</b> layers`,
    `<b>${mm(t, 2)} mm</b> sheets`,
    `stack <b>${mm(s.size[2])} mm</b>`,
    `footprint <b>${mm(s.size[0])} × ${mm(s.size[1])} mm</b>`,
  ];
  const e = extrasSummary;
  parts.push(
    e ? `<b>${e.sheetCount}</b> ${e.sheetCount === 1 ? 'sheet' : 'sheets'} needed` : 'nesting…',
  );
  const warns: string[] = [];
  if (e?.oversizeCount)
    warns.push(`${e.oversizeCount} part${e.oversizeCount > 1 ? 's' : ''} larger than a sheet`);
  if (e?.pinsMissingLayers)
    warns.push(
      `pins don't fit on ${e.pinsMissingLayers} layer${e.pinsMissingLayers > 1 ? 's' : ''}`,
    );
  if (s.openCount)
    warns.push(`${s.openCount} open contour${s.openCount > 1 ? 's' : ''} (mesh gaps)`);
  ui.stats.innerHTML =
    parts.join(' · ') +
    (warns.length ? ` · <span class="warn">⚠ ${warns.join(' · ')}</span>` : '') +
    ` <span title="Slice time">(${Math.round(s.ms)} ms)</span>`;
}

function selectLayer(L: number): void {
  current = L;
  if (!layers || layers.n === 0) {
    ui.readout.textContent = '—';
    return;
  }
  const z0 = layers.z[L * 2],
    z1 = layers.z[L * 2 + 1];
  ui.readout.textContent = `${layerName(L)} · z ${mm(z0)}–${mm(z1)} mm`;
  stackView.setSelected(L);
  layerView.setLayer(L);
}

ui.slider.addEventListener('input', () => selectLayer(+ui.slider.value));

// ---- Settings ----
form.form.addEventListener('input', (ev) => {
  const name = (ev.target as HTMLInputElement).name;
  if (name === 'sizeX' || name === 'sizeY' || name === 'sizeZ') {
    const i = name === 'sizeX' ? 0 : name === 'sizeY' ? 1 : 2;
    const k = factors()[i];
    if (form.checked('lockRatio') && k > 0) {
      const b = baseSize();
      (['sizeX', 'sizeY', 'sizeZ'] as const).forEach((n, j) => {
        if (j !== i) form.set(n, b[j] * k);
      });
    }
    updateScaleHint();
  } else if (name === 'axis') {
    // Keep a uniform scale across orientations; reset non-uniform scaling.
    const f = factors();
    const k = f[0] === f[1] && f[1] === f[2] ? f[0] : 1;
    baseAxis = form.axis();
    setSize([k, k, k]);
  } else if (name === 'lockRatio' && form.checked('lockRatio')) {
    const k = factors()[2];
    setSize([k, k, k]);
  }
  if (name === 'sheetPrice' || name === 'currency') return renderCost();
  if (['fmtDxf', 'fmtSvg', 'outLayers', 'outSheets'].includes(name)) return;
  computeSoon();
});
form.form.addEventListener('submit', (e) => e.preventDefault());
ui.resetSizeBtn.addEventListener('click', () => {
  if (!model) return;
  setSize([1, 1, 1]);
  computeSoon();
});

// ---- Material cost (updates live, no worker round-trip) ----
function renderCost(): void {
  const e = extrasSummary;
  const x = costExtras;
  if (!e || !x || !layers || layers.n === 0) {
    ui.costCard.hidden = true;
    return;
  }
  const price = form.num('sheetPrice', 0, 0);
  const currency = form.text('currency', '$');
  const c = estimateCost(e.sheets, x.sheetW, x.sheetH, e.partArea, price);
  const ft = (v: number) => mm(v / MM_PER_FT, 2);
  ui.costCard.hidden = false;
  ui.costTotal.textContent = price > 0 ? formatMoney(c.total, currency) : 'Set a sheet price';
  ui.costDetail.textContent =
    `${c.sheets} sheet${c.sheets === 1 ? '' : 's'} of ${ft(x.sheetW)} × ${ft(x.sheetH)} ft` +
    (price > 0 ? ` × ${formatMoney(price, currency)}` : '') +
    ` · ${Math.round(c.utilisation * 100)} % material used` +
    (c.oversizeSheets ? ` · incl. ${c.sheets - c.regularSheets} for oversize parts` : '');
}

// ---- Views ----
function showView(which: '3d' | '2d'): void {
  const is3d = which === '3d';
  ui.tab3d.setAttribute('aria-selected', String(is3d));
  ui.tab2d.setAttribute('aria-selected', String(!is3d));
  ui.tab3d.tabIndex = is3d ? 0 : -1;
  ui.tab2d.tabIndex = is3d ? -1 : 0;
  ui.canvas3d.hidden = !is3d;
  ui.canvas2d.hidden = is3d;
  ui.legend2d.hidden = is3d;
  stackView.setVisible(is3d);
  layerView.setVisible(!is3d);
}
ui.tab3d.addEventListener('click', () => showView('3d'));
ui.tab2d.addEventListener('click', () => showView('2d'));
for (const tab of [ui.tab3d, ui.tab2d]) {
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tab === ui.tab3d ? ui.tab2d : ui.tab3d;
    next.focus();
    next.click();
  });
}
showView('3d');

// ---- Loading ----
async function loadFile(file: File): Promise<void> {
  if (!/\.stl$/i.test(file.name) && file.type && !/stl|sla|octet/.test(file.type)) {
    toast('Please choose an .stl file', 'error');
    return;
  }
  const buffer = await file.arrayBuffer();
  loadJob++;
  setProgress('Parsing', 0);
  send({ type: 'load', job: loadJob, buffer, name: file.name }, [buffer]);
}

ui.fileInput.addEventListener('change', () => {
  const f = ui.fileInput.files?.[0];
  if (f) void loadFile(f);
  ui.fileInput.value = '';
});
for (const b of ui.sampleBtns) {
  b.addEventListener('click', () => {
    loadJob++;
    send({ type: 'loadSample', job: loadJob });
  });
}

let dragDepth = 0;
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
ui.viewport.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  ui.dropHint.hidden = false;
});
ui.viewport.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.dropHint.hidden = true;
});
ui.viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  ui.dropHint.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

// ---- Export ----
ui.exportBtn.addEventListener('click', () => {
  const opts = form.exportOptions();
  if (!opts.dxf && !opts.svg) return toast('Pick at least one format (DXF or SVG)', 'error');
  if (!opts.perLayer && !opts.sheets)
    return toast('Pick per-layer files and/or nested sheets', 'error');
  exporting = true;
  syncButtons();
  send({ type: 'export', job: ++exportJob, opts });
});
ui.layerSvgBtn.addEventListener('click', () => {
  send({ type: 'layerSvg', job: ++svgJob, layer: current });
});

// Expose a tiny hook for automated smoke tests.
(window as unknown as { __foam: unknown }).__foam = {
  state: () => ({ layers: layers?.n ?? 0, current, busy: busy(), sliceSummary, extrasSummary }),
};
