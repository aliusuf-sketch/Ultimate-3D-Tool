/** Reads the settings form into typed settings objects. */
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

  checked(name: string): boolean {
    return this.el(name).checked;
  }

  axis(): StackAxis {
    const r = this.form.querySelector<HTMLInputElement>('input[name="axis"]:checked');
    return (r?.value as StackAxis) ?? 'z';
  }

  slice(): SliceSettings {
    return {
      axis: this.axis(),
      scale: this.num('scale', 100, 0.001) / 100,
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
      sheetW: this.num('sheetW', 1200, 1),
      sheetH: this.num('sheetH', 600, 1),
      gap: this.num('gap', 6, 0),
    };
  }

  exportOptions(): ExportOptions {
    return {
      dxf: this.checked('fmtDxf'),
      svg: this.checked('fmtSvg'),
      perLayer: this.checked('outLayers'),
      sheets: this.checked('outSheets'),
    };
  }
}
