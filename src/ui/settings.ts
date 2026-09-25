/** Reads the settings form into typed settings objects. */
import { MM_PER_FT } from '../core/cost';
import type { ExportOptions, ExtrasSettings, PinMode, SliceSettings, StackAxis } from '../types';

export class SettingsForm {
  constructor(readonly form: HTMLFormElement) {}

  private el(name: string): HTMLInputElement {
    return this.form.elements.namedItem(name) as HTMLInputElement;
  }

  num(name: string, fallback: number, min = -Infinity): number {
    const v = parseFloat(this.el(name).value);
    return Number.isFinite(v) && v >= min ? v : fallback;
  }

  set(name: string, value: number): void {
    this.el(name).value = String(Math.round(value * 1000) / 1000);
  }

  text(name: string, fallback: string): string {
    return this.el(name).value.trim() || fallback;
  }

  checked(name: string): boolean {
    return this.el(name).checked;
  }

  axis(): StackAxis {
    const r = this.form.querySelector<HTMLInputElement>('input[name="axis"]:checked');
    return (r?.value as StackAxis) ?? 'z';
  }

  /** Target model size (mm) in the oriented frame; falls back to `base` per axis. */
  size(base: [number, number, number]): [number, number, number] {
    return [
      this.num('sizeX', base[0], 1e-3),
      this.num('sizeY', base[1], 1e-3),
      this.num('sizeZ', base[2], 1e-3),
    ];
  }

  /** `base` = oriented model size at 100 %. */
  slice(base: [number, number, number]): SliceSettings {
    const size = this.size(base);
    const f = (i: number) => (base[i] > 0 ? size[i] / base[i] : 1);
    return {
      axis: this.axis(),
      scale: [f(0), f(1), f(2)],
      thickness: this.num('thickness', 10, 0.1),
      tolerance: this.num('tolerance', 0.05, 0),
    };
  }

  extras(): ExtrasSettings {
    return {
      pinMode: (this.form.elements.namedItem('pinMode') as HTMLSelectElement).value as PinMode,
      pinDiameter: this.num('pinDiameter', 6, 0.1),
      pinSpacing: this.num('pinSpacing', 40, 0),
      pinOffsetX: this.num('pinOffsetX', 0),
      pinOffsetY: this.num('pinOffsetY', 0),
      labels: this.checked('labels'),
      labelHeight: this.num('labelHeight', 6, 0.5),
      sheetW: this.num('sheetWft', 4, 0.01) * MM_PER_FT,
      sheetH: this.num('sheetHft', 2, 0.01) * MM_PER_FT,
      gap: this.num('gap', 6, 0),
    };
  }

  exportOptions(): ExportOptions {
    return {
      dxf: this.checked('fmtDxf'),
      svg: this.checked('fmtSvg'),
      perLayer: this.checked('outLayers'),
      sheets: this.checked('outSheets'),
      pricePerSheet: this.num('sheetPrice', 0, 0),
      currency: this.text('currency', '$'),
    };
  }
}
