/** Shipping-insert settings: reading the form, unit handling and box presets. */
import { BOX_PRESETS_IN, type InsertSettings } from '../core/insert';
import type { StackAxis } from '../types';
import type { SettingsForm } from './settings';

export const IN = 25.4;
export type Units = 'in' | 'mm';

/** Field names whose value is shown in the selected unit (stored in mm internally). */
const UNIT_FIELDS = [
  'itemX',
  'itemY',
  'itemZ',
  'boxL',
  'boxW',
  'boxH',
  'minCushion',
  'foamT0',
  'foamT1',
  'foamT2',
  'foamT3',
];
export const FOAM_ROWS = 4;

/** Every field that affects the insert geometry (changes trigger a re-plan). */
export const SHIP_FIELDS = new Set([
  ...UNIT_FIELDS,
  'stlUnits',
  'itemScale',
  'itemLock',
  'shipAxis',
  'turn90',
  'flip',
  'layering',
  'insertMode',
  'clearance',
  'preload',
  'compress',
  'placement',
  'parting',
  'notches',
  'notchDiameter',
  'fitOversize',
  'minIsland',
  'foamOn0',
  'foamOn1',
  'foamOn2',
  'foamOn3',
  'boxPreset',
]);
export const PRICE_FIELDS = new Set([
  'foamP0',
  'foamP1',
  'foamP2',
  'foamP3',
  'sheetPrice',
  'currency',
]);

export class ShipForm {
  private currentUnits: Units = 'in';
  private modelSize: [number, number, number] = [0, 0, 0];

  constructor(private f: SettingsForm) {}

  get units(): Units {
    return this.currentUnits;
  }

  private radio(name: string): string {
    return (
      this.f.form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? ''
    );
  }

  private select(name: string): string {
    return (this.f.form.elements.namedItem(name) as HTMLSelectElement).value;
  }

  private u(): number {
    return this.currentUnits === 'in' ? IN : 1;
  }

  /** Length field in mm. */
  len(name: string, fallbackMm: number): number {
    const v = this.f.num(name, NaN, 0);
    return Number.isFinite(v) ? v * this.u() : fallbackMm;
  }

  setLen(name: string, mm: number): void {
    this.f.set(name, mm / this.u());
  }

  /** Re-express unit fields after the units radio changed. */
  switchUnits(): void {
    const next = (this.radio('units') as Units) || 'in';
    if (next === this.currentUnits) return;
    const values = UNIT_FIELDS.map((n) => this.len(n, 0));
    this.currentUnits = next;
    UNIT_FIELDS.forEach((n, i) => this.setLen(n, values[i]));
    this.f.form.querySelectorAll('.u').forEach((el) => (el.textContent = next));
    this.fillPresets();
  }

  box(): [number, number, number] {
    return [this.len('boxL', 8 * IN), this.len('boxW', 8 * IN), this.len('boxH', 8 * IN)];
  }

  setBox(b: [number, number, number]): void {
    this.setLen('boxL', b[0]);
    this.setLen('boxW', b[1]);
    this.setLen('boxH', b[2]);
    this.syncPreset();
  }

  foam(): { thickness: number; price: number; on: boolean }[] {
    const rows = [];
    for (let i = 0; i < FOAM_ROWS; i++) {
      rows.push({
        thickness: this.len(`foamT${i}`, 0),
        price: this.f.num(`foamP${i}`, 0, 0),
        on: this.f.checked(`foamOn${i}`),
      });
    }
    return rows;
  }

  orientation(): { axis: StackAxis; turn90: boolean; flip: boolean } {
    return {
      axis: (this.radio('shipAxis') as StackAxis) || 'z',
      turn90: this.f.checked('turn90'),
      flip: this.f.checked('flip'),
    };
  }

  setOrientation(axis: StackAxis, turn90: boolean): void {
    const r = this.f.form.querySelector<HTMLInputElement>(
      `input[name="shipAxis"][value="${axis}"]`,
    );
    if (r) r.checked = true;
    (this.f.form.elements.namedItem('turn90') as HTMLInputElement).checked = turn90;
  }

  // ---- Item size / scale (STL frame) ----

  /** Raw STL bounding-box size (file units). */
  setModelSize(size: [number, number, number]): void {
    this.modelSize = size;
  }

  private stlUnit(): number {
    return +this.select('stlUnits') || 1;
  }

  /** Item size at 100 % in mm (file size x STL units). */
  originalSize(): [number, number, number] {
    const u = this.stlUnit();
    return this.modelSize.map((v) => v * u) as [number, number, number];
  }

  /** Current target item size in mm. */
  itemSize(): [number, number, number] {
    const o = this.originalSize();
    return [this.len('itemX', o[0]), this.len('itemY', o[1]), this.len('itemZ', o[2])];
  }

  /** Current item bounding-box size in mm (alias used by orientation/box helpers). */
  scaledSize(): [number, number, number] {
    return this.itemSize();
  }

  /** Scale relative to the raw STL numbers (includes the unit conversion). */
  scale(): [number, number, number] {
    const s = this.itemSize();
    return s.map((v, i) => (this.modelSize[i] > 0 ? v / this.modelSize[i] : 1)) as [
      number,
      number,
      number,
    ];
  }

  /** Scale relative to the original size (what the user thinks of as %). */
  factors(): [number, number, number] {
    const o = this.originalSize();
    const s = this.itemSize();
    return s.map((v, i) => (o[i] > 0 ? v / o[i] : 1)) as [number, number, number];
  }

  setItemFactors(k: [number, number, number]): void {
    const o = this.originalSize();
    this.setLen('itemX', o[0] * k[0]);
    this.setLen('itemY', o[1] * k[1]);
    this.setLen('itemZ', o[2] * k[2]);
    if (k[0] === k[1] && k[1] === k[2]) this.f.set('itemScale', k[0] * 100);
  }

  /** After editing one size field: keep proportions if locked. */
  onItemSizeEdited(axis: 0 | 1 | 2): void {
    const k = this.factors()[axis];
    if (this.f.checked('itemLock') && k > 0) this.setItemFactors([k, k, k]);
  }

  scaleHint(): string {
    const f = this.factors().map((v) => Math.round(v * 1000) / 10);
    return f[0] === f[1] && f[1] === f[2]
      ? `Scale ${f[0]} %`
      : `Scale X ${f[0]} % · Y ${f[1]} % · Z ${f[2]} %`;
  }

  settings(): InsertSettings {
    const o = this.orientation();
    return {
      ...o,
      scale: this.scale(),
      box: this.box(),
      thicknesses: this.foam()
        .filter((r) => r.on && r.thickness > 0)
        .map((r) => r.thickness),
      layering: this.select('layering') as InsertSettings['layering'],
      compress: this.f.num('compress', 3, 0),
      fitOversize: this.f.num('fitOversize', 0),
      clearance: this.f.num('clearance', 1, 0),
      preload: this.f.num('preload', 1.5, 0),
      minCushion: this.len('minCushion', IN),
      mode: this.select('insertMode') as InsertSettings['mode'],
      parting: Math.round(this.f.num('parting', 0, 0)),
      placement: this.select('placement') as InsertSettings['placement'],
      notches: this.f.checked('notches'),
      notchDiameter: this.f.num('notchDiameter', 25, 1),
      minIsland: this.f.num('minIsland', 4, 0) * 100,
      tolerance: 0.1,
      resolution: 0,
    };
  }

  fmtLen(mm: number, digits = 2): string {
    const v = mm / this.u();
    const f = 10 ** digits;
    return `${Math.round(v * f) / f} ${this.currentUnits}`;
  }

  // ---- Box presets ----
  fillPresets(): void {
    const sel = this.f.form.elements.namedItem('boxPreset') as HTMLSelectElement;
    const keep = sel.value;
    sel.length = 1;
    for (const b of BOX_PRESETS_IN) {
      const o = document.createElement('option');
      o.value = b.join('x');
      o.textContent =
        this.currentUnits === 'in'
          ? `${b[0]} × ${b[1]} × ${b[2]} in`
          : `${b.map((v) => Math.round(v * IN)).join(' × ')} mm`;
      sel.append(o);
    }
    sel.value = keep;
  }

  applyPreset(): boolean {
    const v = this.select('boxPreset');
    if (!v) return false;
    const b = v.split('x').map((n) => +n * IN) as [number, number, number];
    this.setLen('boxL', b[0]);
    this.setLen('boxW', b[1]);
    this.setLen('boxH', b[2]);
    return true;
  }

  syncPreset(): void {
    const b = this.box().map((v) => Math.round((v / IN) * 1000) / 1000);
    const sel = this.f.form.elements.namedItem('boxPreset') as HTMLSelectElement;
    const key = b.join('x');
    sel.value = BOX_PRESETS_IN.some((p) => p.join('x') === key) ? key : '';
  }
}
