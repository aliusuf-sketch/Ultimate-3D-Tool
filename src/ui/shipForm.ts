/** Shipping-insert settings: reading the form, unit handling and box presets. */
import { BOX_PRESETS_IN, type InsertSettings } from '../core/insert';
import type { StackAxis } from '../types';
import type { SettingsForm } from './settings';

export const IN = 25.4;
export type Units = 'in' | 'mm';

/** Field names whose value is shown in the selected unit (stored in mm internally). */
const UNIT_FIELDS = ['boxL', 'boxW', 'boxH', 'minCushion', 'foamT0', 'foamT1', 'foamT2', 'foamT3'];
export const FOAM_ROWS = 4;

/** Every field that affects the insert geometry (changes trigger a re-plan). */
export const SHIP_FIELDS = new Set([
  ...UNIT_FIELDS,
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

  settings(): InsertSettings {
    const o = this.orientation();
    return {
      ...o,
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
