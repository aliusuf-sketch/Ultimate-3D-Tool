/** 2D canvas inspector for one layer's cut pattern. Draws on demand. */
import { layerLoops, layerOpenChains, type PackedExtras, type PackedLayers } from '../core/pack';
import { layerName } from '../core/extras';

export class LayerView {
  private ctx: CanvasRenderingContext2D;
  private frame = 0;
  private layers: PackedLayers | null = null;
  private extras: PackedExtras | null = null;
  private footprint: [number, number] = [1, 1];
  private layer = 0;
  private visible = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.requestRender()).observe(canvas.parentElement ?? canvas);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.requestRender();
  }

  setData(layers: PackedLayers | null, footprint: [number, number]): void {
    this.layers = layers;
    this.extras = null;
    this.footprint = footprint;
    this.requestRender();
  }

  setExtras(extras: PackedExtras | null): void {
    this.extras = extras;
    this.requestRender();
  }

  setLayer(L: number): void {
    this.layer = L;
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || !this.visible) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = c.clientWidth,
      ch = c.clientHeight;
    if (!cw || !ch) return;
    const bw = Math.round(cw * dpr),
      bh = Math.round(ch * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    const P = this.layers;
    if (!P || P.n === 0) return;
    const L = Math.min(this.layer, P.n - 1);

    // Fit footprint with padding, y up.
    const [W, D] = this.footprint;
    const pad = 48;
    const s = Math.min((cw - pad * 2) / Math.max(W, 1e-6), (ch - pad * 2) / Math.max(D, 1e-6));
    const ox = (cw - W * s) / 2;
    const oy = (ch + D * s) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const X = (x: number) => ox + x * s;
    const Y = (y: number) => oy - y * s;

    const pathOf = (loops: Float64Array[]) => {
      const p = new Path2D();
      for (const pts of loops) {
        for (let i = 0; i < pts.length; i += 2) {
          if (i === 0) p.moveTo(X(pts[i]), Y(pts[i + 1]));
          else p.lineTo(X(pts[i]), Y(pts[i + 1]));
        }
        p.closePath();
      }
      return p;
    };

    // Layer below: dashed outline.
    if (L > 0) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.stroke(pathOf(layerLoops(P, L - 1).map((l) => l.pts)));
      ctx.restore();
    }

    // Current layer: even-odd fill + cut outline.
    const loops = layerLoops(P, L);
    const path = pathOf(loops.map((l) => l.pts));
    ctx.fillStyle = 'rgba(242, 139, 176, 0.88)';
    ctx.fill(path, 'evenodd');
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ff3b3b';
    ctx.stroke(path);

    // Open contours (mesh gaps).
    const open = layerOpenChains(P, L);
    if (open.length) {
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffd23f';
      for (const pts of open) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          if (i === 0) ctx.moveTo(X(pts[i]), Y(pts[i + 1]));
          else ctx.lineTo(X(pts[i]), Y(pts[i + 1]));
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Pins and label.
    const E = this.extras;
    if (E && E.layerPins.length === P.n + 1) {
      for (let k = E.layerPins[L]; k < E.layerPins[L + 1]; k++) {
        const x = E.pins[k * 3],
          y = E.pins[k * 3 + 1],
          r = E.pins[k * 3 + 2];
        ctx.beginPath();
        ctx.arc(X(x), Y(y), Math.max(r * s, 2), 0, Math.PI * 2);
        ctx.fillStyle = '#2c5f4a';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ff3b3b';
        ctx.stroke();
      }
      const h = E.labels[L * 3 + 2];
      if (h > 0) {
        ctx.fillStyle = '#1740c9';
        ctx.font = `600 ${Math.max(h * s, 8)}px Barlow, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(layerName(L), X(E.labels[L * 3]), Y(E.labels[L * 3 + 1]));
      }
    }

    // Part dimensions (bbox of this layer).
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const { pts } of loops) {
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]);
        x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]);
        y1 = Math.max(y1, pts[i + 1]);
      }
    }
    if (x1 > x0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.font = '600 13px "Barlow Condensed", Barlow, system-ui, sans-serif';
      const by = Y(y0) + 18;
      ctx.beginPath();
      ctx.moveTo(X(x0), by);
      ctx.lineTo(X(x1), by);
      ctx.moveTo(X(x0), by - 4);
      ctx.lineTo(X(x0), by + 4);
      ctx.moveTo(X(x1), by - 4);
      ctx.lineTo(X(x1), by + 4);
      const rx = X(x1) + 18;
      ctx.moveTo(rx, Y(y0));
      ctx.lineTo(rx, Y(y1));
      ctx.moveTo(rx - 4, Y(y0));
      ctx.lineTo(rx + 4, Y(y0));
      ctx.moveTo(rx - 4, Y(y1));
      ctx.lineTo(rx + 4, Y(y1));
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${fmt(x1 - x0)} mm`, (X(x0) + X(x1)) / 2, by + 5);
      ctx.translate(rx + 6, (Y(y0) + Y(y1)) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${fmt(y1 - y0)} mm`, 0, 0);
      ctx.restore();
    }
  }
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
