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
import { ShipForm, SHIP_FIELDS, PRICE_FIELDS } from './ui/shipForm';
import { orientedDims, rankOrientations, smallestBox } from './core/insert';
import { insertLabelText, thicknessLabel } from './core/export/insertZip';
import type { InsertSummary } from './worker/protocol';

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
  modeSlicer: $<HTMLButtonElement>('modeSlicer'),
  modeShip: $<HTMLButtonElement>('modeShip'),
  emptyTitle: $('emptyTitle'),
  reportStatus: $('reportStatus'),
  reportGrid: $('reportGrid'),
  reportWarn: $('reportWarn'),
  explode: $<HTMLInputElement>('explode'),
  xray: $<HTMLInputElement>('xray'),
  autoOrientBtn: $<HTMLButtonElement>('autoOrientBtn'),
  smallestBoxBtn: $<HTMLButtonElement>('smallestBoxBtn'),
};

const form = new SettingsForm($<HTMLFormElement>('settings'));
const ship = new ShipForm(form);
ship.fillPresets();
ship.syncPreset();
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

// Shipping-insert mode state.
let mode: 'slicer' | 'ship' = 'slicer';
let insertJob = 0;
let gotInsert = -1;
let shipSummary: InsertSummary | null = null;
let shipError: string | null = null;

const busy = () =>
  model !== null &&
  (mode === 'ship' ? gotInsert !== insertJob : gotSlice !== sliceJob || gotExtras !== extrasJob);

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

function computeInsert(): void {
  if (!model) return;
  const settings = ship.settings();
  if (!settings.thicknesses.length) {
    showShipError('Tick at least one foam thickness');
    return;
  }
  insertJob++;
  send({
    type: 'insert',
    job: insertJob,
    settings,
    extras: {
      labels: form.checked('labels'),
      labelHeight: form.num('labelHeight', 6, 0.5),
      sheetW: form.extras().sheetW,
      sheetH: form.extras().sheetH,
      gap: form.num('gap', 6, 0),
    },
  });
  setProgress('Planning insert', 0);
  syncButtons();
}
const computeInsertSoon = debounce(computeInsert, 200);

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
      if (mode === 'ship') prepareShip(true);
      else compute();
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
    case 'inserted': {
      if (m.job !== insertJob || mode !== 'ship') return;
      gotInsert = m.job;
      shipError = null;
      layers = m.layers;
      shipSummary = m.summary;
      const S = m.summary;
      const boxMin: [number, number] = [
        (S.rect[0] - ship.box()[0]) / 2,
        (S.rect[1] - ship.box()[1]) / 2,
      ];
      stackView.setPreview(m.preview, [S.rect[0], S.rect[1], S.stackHeight], reframeNext, {
        splitLayer: S.roles.includes('base') ? S.baseCount : undefined,
        item: m.item,
        box: { min: boxMin, size: ship.box() },
      });
      stackView.setExplode(explodeMm());
      reframeNext = false;
      layerView.setLabelText((i) => insertLabelText(S.roles[i] ?? 'layer', i));
      layerView.setData(m.layers, S.rect);
      layerView.setExtras(m.extras);
      ui.slider.max = String(Math.max(0, m.layers.n - 1));
      ui.slider.disabled = m.layers.n === 0;
      current = Math.min(current, Math.max(0, m.layers.n - 1));
      ui.slider.value = String(current);
      selectLayer(current);
      setProgress(null);
      renderReport();
      renderStats();
      renderCost();
      syncButtons();
      break;
    }
    case 'insertError': {
      if (m.job !== insertJob || mode !== 'ship') return;
      gotInsert = m.job;
      showShipError(m.message);
      break;
    }
    case 'exported': {
      if (m.job !== exportJob) return;
      exporting = false;
      syncButtons();
      const base = (model?.name ?? 'model').replace(/\.stl$/i, '');
      const suffix = mode === 'ship' ? 'shipping_insert' : 'foam_layers';
      download(m.zip as Uint8Array<ArrayBuffer>, `${base}_${suffix}.zip`, 'application/zip');
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
  if (mode === 'ship') return renderShipStats();
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
  if (mode === 'ship' && shipSummary) {
    const role = shipSummary.roles[L];
    ui.readout.textContent =
      `${layerName(L)} · ${role === 'layer' ? '' : `${role} · `}` +
      `${thicknessLabel(shipSummary.thickness[L]).replace('in', ' in')} · z ${mm(z0)}–${mm(z1)} mm`;
  } else {
    ui.readout.textContent = `${layerName(L)} · z ${mm(z0)}–${mm(z1)} mm`;
  }
  stackView.setSelected(L);
  layerView.setLayer(L);
}

ui.slider.addEventListener('input', () => selectLayer(+ui.slider.value));

// ---- Settings ----
form.form.addEventListener('input', (ev) => {
  const name = (ev.target as HTMLInputElement).name;
  if (mode === 'ship') return onShipInput(name);
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
  if (mode === 'ship') return renderShipCost();
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
    send({ type: 'loadSample', job: loadJob, kind: mode === 'ship' ? 'vase' : 'torus' });
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
  if (mode === 'ship') {
    const b = ship.box();
    send({
      type: 'exportInsert',
      job: ++exportJob,
      opts: {
        ...opts,
        prices: ship.foam().map((r) => ({ thickness: r.thickness, price: r.price })),
        boxLabel: `${b.map((v) => ship.fmtLen(v, 2).split(' ')[0]).join(' x ')} ${ship.units}`,
      },
    });
  } else {
    send({ type: 'export', job: ++exportJob, opts });
  }
});
ui.layerSvgBtn.addEventListener('click', () => {
  send({ type: 'layerSvg', job: ++svgJob, layer: current });
});

// Expose a tiny hook for automated smoke tests.
(window as unknown as { __foam: unknown }).__foam = {
  state: () => ({
    mode,
    layers: layers?.n ?? 0,
    current,
    busy: busy(),
    sliceSummary,
    extrasSummary,
    shipSummary,
    shipError,
  }),
};

// ---------------------------------------------------------------------------
// Shipping-insert mode

function explodeMm(): number {
  const H = shipSummary?.stackHeight ?? 0;
  return (+ui.explode.value / 100) * H * 0.9;
}
ui.explode.addEventListener('input', () => stackView.setExplode(explodeMm()));
ui.xray.addEventListener('change', () => stackView.setXray(ui.xray.checked));

function setMode(next: 'slicer' | 'ship'): void {
  if (next === mode) return;
  mode = next;
  document.body.classList.toggle('mode-ship', mode === 'ship');
  ui.modeSlicer.setAttribute('aria-selected', String(mode === 'slicer'));
  ui.modeShip.setAttribute('aria-selected', String(mode === 'ship'));
  ui.modeSlicer.tabIndex = mode === 'slicer' ? 0 : -1;
  ui.modeShip.tabIndex = mode === 'ship' ? 0 : -1;
  ui.emptyTitle.textContent =
    mode === 'ship' ? 'Drop the STL of the item you want to ship' : 'Drop an STL file here';
  ui.explode.value = '0';
  stackView.setExplode(0);
  stackView.clear();
  layerView.setData(null, [1, 1]);
  layerView.setLabelText(layerName);
  layers = null;
  shipSummary = null;
  shipError = null;
  sliceSummary = null;
  extrasSummary = null;
  ui.costCard.hidden = true;
  reframeNext = true;
  if (model) {
    if (mode === 'ship') prepareShip(false);
    else {
      lastSliceKey = '';
      lastExtrasKey = '';
      compute();
    }
  } else {
    renderReport();
  }
  renderStats();
  syncButtons();
}
ui.modeSlicer.addEventListener('click', () => setMode('slicer'));
ui.modeShip.addEventListener('click', () => setMode('ship'));
for (const b of [ui.modeSlicer, ui.modeShip]) {
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const other = b === ui.modeSlicer ? ui.modeShip : ui.modeSlicer;
    other.focus();
    other.click();
  });
}

/** On a new item: pick the best orientation for the box, or a box that fits. */
function prepareShip(newItem: boolean): void {
  if (!model) return;
  const s = ship.settings();
  if (newItem) {
    const best = rankOrientations(model.size, s)[0];
    if (best.margin >= s.minCushion) {
      ship.setOrientation(best.axis, best.turn90);
    } else {
      const b = smallestBox(model.size, s.minCushion, s.clearance);
      if (b) {
        ship.setBox(b.box);
        const o = rankOrientations(model.size, ship.settings())[0];
        ship.setOrientation(o.axis, o.turn90);
        toast(
          `Box set to ${b.box.map((v) => ship.fmtLen(v, 2).split(' ')[0]).join(' × ')} ${ship.units} so the item fits with cushion`,
        );
      } else {
        ship.setOrientation(best.axis, best.turn90);
        toast('No standard box gives the full cushion — enter a custom box size', 'error', 6000);
      }
    }
  }
  reframeNext = true;
  computeInsert();
}

function onShipInput(name: string): void {
  if (name === 'units') {
    ship.switchUnits();
    renderReport();
    renderShipStats();
    return;
  }
  if (name === 'boxPreset') {
    if (!ship.applyPreset()) return;
    reframeNext = true;
  } else if (name === 'boxL' || name === 'boxW' || name === 'boxH') {
    ship.syncPreset();
    reframeNext = true;
  }
  if (PRICE_FIELDS.has(name)) return renderShipCost();
  if (['fmtDxf', 'fmtSvg', 'outLayers', 'outSheets'].includes(name)) return;
  if (
    SHIP_FIELDS.has(name) ||
    ['labels', 'labelHeight', 'sheetWft', 'sheetHft', 'gap'].includes(name)
  ) {
    computeInsertSoon();
  }
}

ui.autoOrientBtn.addEventListener('click', () => {
  if (!model) return;
  const s = ship.settings();
  const best = rankOrientations(model.size, s)[0];
  ship.setOrientation(best.axis, best.turn90);
  const d = orientedDims(model.size, best.axis, best.turn90);
  toast(
    `Item sits ${d.map((v) => mm(v)).join(' × ')} mm in the box` +
      (Number.isFinite(best.gap)
        ? ` · ${best.gap < 0.05 ? 'no' : `${mm(best.gap)} mm`} vertical gap`
        : ''),
  );
  reframeNext = true;
  computeInsert();
});

ui.smallestBoxBtn.addEventListener('click', () => {
  if (!model) return toast('Load the item first', 'error');
  const s = ship.settings();
  const b = smallestBox(model.size, s.minCushion, s.clearance);
  if (!b) return toast('No standard box is big enough — enter a custom size', 'error');
  ship.setBox(b.box);
  const best = rankOrientations(model.size, ship.settings())[0];
  ship.setOrientation(best.axis, best.turn90);
  reframeNext = true;
  computeInsert();
});

function showShipError(message: string): void {
  shipError = message;
  shipSummary = null;
  layers = null;
  stackView.clear();
  layerView.setData(null, [1, 1]);
  ui.slider.disabled = true;
  ui.readout.textContent = '—';
  setProgress(null);
  renderReport();
  renderShipStats();
  renderShipCost();
  syncButtons();
}

function renderReport(): void {
  const grid = ui.reportGrid;
  const warn = ui.reportWarn;
  grid.innerHTML = '';
  warn.innerHTML = '';
  const st = ui.reportStatus;
  if (!model) {
    st.dataset.state = 'idle';
    st.textContent = 'Load the item you want to ship';
    return;
  }
  if (shipError) {
    st.dataset.state = 'bad';
    st.textContent = 'Won’t fit';
    const li = document.createElement('li');
    li.textContent = shipError;
    warn.append(li);
    return;
  }
  const S = shipSummary;
  if (!S) {
    st.dataset.state = 'idle';
    st.textContent = 'Planning…';
    return;
  }
  const r = S.report;
  const play = r.playUp + r.playDown;
  const minC = ship.settings().minCushion;
  const weak =
    r.sideWall < minC - 0.05 || r.bottomCushion < minC - 0.05 || r.topCushion < minC - 0.05;
  const state = r.warnings.length === 0 ? 'good' : play > 3 || r.sideWall < 6 ? 'bad' : 'check';
  st.dataset.state = state;
  st.textContent =
    state === 'good'
      ? 'Secure fit'
      : state === 'check'
        ? weak
          ? 'Fits — thin cushion'
          : 'Fits — check notes'
        : 'Item can move';
  const L = (v: number) => ship.fmtLen(v, 2);
  const counts = new Map<number, number>();
  for (const t of S.thickness) counts.set(t, (counts.get(t) ?? 0) + 1);
  const rows: [string, string][] = [
    [
      'Stack',
      `${S.thickness.length} layers · ${[...counts].map(([t, c]) => `${c} × ${thicknessLabel(t).replace('in', ' in')}`).join(', ')}`,
    ],
    ...(S.roles.includes('base')
      ? ([
          [
            'Split',
            `base L01–${layerName(S.baseCount - 1)} · lid ${layerName(S.baseCount)}–${layerName(S.thickness.length - 1)}`,
          ],
        ] as [string, string][])
      : []),
    ['Item', S.itemSize.map((v) => mm(v)).join(' × ') + ' mm'],
    ['Foam sides', L(r.sideWall)],
    ['Foam below / above', `${L(r.bottomCushion)} / ${L(r.topCushion)}`],
    [
      'Vertical play',
      play < 0.05
        ? r.preloaded > 0
          ? `none (presses ${mm(r.preloaded)} mm)`
          : 'none'
        : `${mm(play)} mm`,
    ],
    [
      'Stack vs box',
      Math.abs(r.fillError) < 0.05
        ? 'exact'
        : r.fillError > 0
          ? `${mm(r.fillError)} mm taller (compresses)`
          : `${mm(-r.fillError)} mm short`,
    ],
  ];
  if (r.islands) rows.push(['Loose inserts', `${r.islands} (glue in place)`]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    grid.append(dt, dd);
  }
  for (const w of r.warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    warn.append(li);
  }
}

function renderShipStats(): void {
  const S = shipSummary;
  if (!model) {
    ui.stats.textContent = 'Load the item you want to ship.';
    return;
  }
  if (!S) {
    ui.stats.textContent = shipError ? `⚠ ${shipError}` : 'Planning…';
    return;
  }
  const b = ship.box();
  const sheets = S.groups.reduce((a, g) => a + g.sheets.length, 0);
  const parts = [
    `box <b>${b.map((v) => ship.fmtLen(v, 2).split(' ')[0]).join(' × ')} ${ship.units}</b>`,
    `<b>${S.thickness.length}</b> layers`,
    `stack <b>${ship.fmtLen(S.stackHeight)}</b>`,
    `<b>${sheets}</b> foam ${sheets === 1 ? 'sheet' : 'sheets'}`,
  ];
  const n = S.report.warnings.length;
  ui.stats.innerHTML =
    parts.join(' · ') +
    (n ? ` · <span class="warn">⚠ ${n} note${n > 1 ? 's' : ''} in the report</span>` : '') +
    ` <span title="Planning time">(${Math.round(S.ms)} ms)</span>`;
}

function renderShipCost(): void {
  const S = shipSummary;
  if (!S) {
    ui.costCard.hidden = true;
    return;
  }
  const currency = form.text('currency', '$');
  const foam = ship.foam();
  let total = 0;
  let missingPrice = false;
  const bits: string[] = [];
  let used = 0,
    bought = 0;
  for (const g of S.groups) {
    const row = foam.find((r) => Math.abs(r.thickness - g.thickness) < 0.05);
    const price = row?.price ?? 0;
    if (!price) missingPrice = true;
    const c = estimateCost(g.sheets, S.sheetW, S.sheetH, g.partArea, price);
    total += c.total;
    used += g.partArea;
    bought += c.sheets * c.sheetArea;
    bits.push(
      `${thicknessLabel(g.thickness).replace('in', '″')}: ${c.sheets} × ${formatMoney(price, currency)}`,
    );
  }
  const ft = (v: number) => mm(v / MM_PER_FT, 2);
  ui.costCard.hidden = false;
  ui.costTotal.textContent =
    missingPrice && total === 0 ? 'Set sheet prices' : formatMoney(total, currency);
  ui.costDetail.textContent =
    `${bits.join(' · ')} · sheets ${ft(S.sheetW)} × ${ft(S.sheetH)} ft · ` +
    `${bought > 0 ? Math.round((used / bought) * 100) : 0} % used`;
}
