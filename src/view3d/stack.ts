/**
 * three.js stack view: merged layer meshes + selected-layer overlay, rendered on demand.
 * Insert mode adds the item, a cardboard box, an explodable lid, per-layer visibility and
 * an assembly animation (the only time a continuous render loop runs).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PreviewGeometry } from '../core/preview';

export type AssemblyStep =
  { kind: 'layer'; index: number; label: string } | { kind: 'item'; label: string };

interface Anim {
  steps: AssemblyStep[];
  meshes: (Mesh | null)[]; // per step
  start: number;
  stepMs: number;
  gapMs: number;
  lift: number;
  onStep: (label: string, i: number) => void;
  onDone: () => void;
  lastStep: number;
  raf: number;
}

export class StackView {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 1, 1, 100000);
  private controls: OrbitControls;
  private group = new Group();
  private lidGroup = new Group();
  private stack: Mesh | null = null;
  private lid: Mesh | null = null;
  private overlay: Mesh | null = null;
  private itemMesh: Mesh | null = null;
  private boxGroup: Group | null = null;
  private animGroup = new Group();
  private splitLayer = -1;
  private explode = 0;
  private layerVisible: boolean[] | null = null;
  private itemMat = new MeshLambertMaterial({
    color: new Color('#8fb3d9'),
    emissive: new Color('#0d1c2b'),
  });
  private boxLineMat = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  private cardboardMat = new MeshLambertMaterial({
    color: new Color('#c49a6c'),
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: DoubleSide,
  });
  private preview: PreviewGeometry | null = null;
  private attrs: { pos: BufferAttribute; nor: BufferAttribute; col: BufferAttribute } | null = null;
  private stackMat = new MeshLambertMaterial({ vertexColors: true });
  private overlayMat = new MeshLambertMaterial({
    color: new Color('#ff2f6d'),
    emissive: new Color('#5a0020'),
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private frame = 0;
  private w = 0;
  private h = 0;
  private selected = -1;
  private visible = true;
  private size: [number, number, number] = [1, 1, 1];
  private anim: Anim | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(300, -400, 300);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());
    this.scene.add(new HemisphereLight(0xffffff, 0x4a5a52, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, -0.8, 1.4);
    this.scene.add(sun);
    const fill = new DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, 0.7, -0.4);
    this.scene.add(fill);
    this.scene.add(this.group);
    this.group.add(this.lidGroup);
    this.group.add(this.animGroup);
    new ResizeObserver(() => this.requestRender()).observe(canvas.parentElement ?? canvas);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.requestRender();
  }

  /**
   * Replace the stack geometry. `reframe` re-fits the camera (new model / axis).
   * Insert mode passes `splitLayer` (first lid layer, drawn in an explodable group),
   * the item triangles and the box (min corner + inner size) in layer coordinates.
   */
  setPreview(
    p: PreviewGeometry,
    size: [number, number, number],
    reframe: boolean,
    opts: {
      splitLayer?: number;
      item?: Float32Array;
      box?: { min: [number, number]; size: [number, number, number] };
    } = {},
  ): void {
    this.stopAnimation();
    this.disposeMeshes();
    this.preview = p;
    this.size = size;
    this.attrs = {
      pos: new BufferAttribute(p.positions, 3),
      nor: new BufferAttribute(p.normals, 3),
      col: new BufferAttribute(p.colors, 3),
    };
    const nLayers = p.layerStart.length - 1;
    this.splitLayer =
      opts.splitLayer !== undefined && opts.splitLayer < nLayers ? opts.splitLayer : -1;
    if (this.layerVisible && this.layerVisible.length !== nLayers) this.layerVisible = null;
    this.rebuildStack();
    this.lidGroup.position.z = this.splitLayer >= 0 ? this.explode : 0;
    if (opts.item) {
      const ig = new BufferGeometry();
      ig.setAttribute('position', new BufferAttribute(opts.item, 3));
      ig.computeVertexNormals();
      this.itemMesh = new Mesh(ig, this.itemMat);
      this.group.add(this.itemMesh);
    }
    if (opts.box) this.buildBox(opts.box.min, opts.box.size);
    this.group.position.set(-size[0] / 2, -size[1] / 2, 0);
    if (reframe) this.frameModel(size);
    const sel = this.selected;
    this.selected = -1;
    this.setSelected(sel < 0 ? 0 : Math.min(sel, nLayers - 1));
  }

  /** Show or hide individual layers (null = all visible). */
  setLayerVisibility(v: boolean[] | null): void {
    this.layerVisible = v;
    if (!this.preview) return;
    this.rebuildStack();
    const sel = this.selected;
    this.selected = -1;
    this.setSelected(sel);
  }

  private isVisible(L: number): boolean {
    return !this.layerVisible || this.layerVisible[L] !== false;
  }

  /** Geometry holding only the visible layers in [from, to). */
  private layersGeometry(from: number, to: number): BufferGeometry | null {
    const p = this.preview!;
    let count = 0;
    for (let L = from; L < to; L++)
      if (this.isVisible(L)) count += p.layerStart[L + 1] - p.layerStart[L];
    if (count === 0) return null;
    const pos = new Float32Array(count * 3),
      nor = new Float32Array(count * 3),
      col = new Float32Array(count * 3);
    let o = 0;
    for (let L = from; L < to; L++) {
      if (!this.isVisible(L)) continue;
      const a = p.layerStart[L] * 3,
        b = p.layerStart[L + 1] * 3;
      pos.set(p.positions.subarray(a, b), o);
      nor.set(p.normals.subarray(a, b), o);
      col.set(p.colors.subarray(a, b), o);
      o += b - a;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nor, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  }

  private rebuildStack(): void {
    for (const m of [this.stack, this.lid]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.stack = this.lid = null;
    const p = this.preview;
    if (!p) return;
    const n = p.layerStart.length - 1;
    const split = this.splitLayer >= 0 ? this.splitLayer : n;
    const base = this.layersGeometry(0, split);
    if (base) {
      this.stack = new Mesh(base, this.stackMat);
      this.group.add(this.stack);
    }
    if (split < n) {
      const lid = this.layersGeometry(split, n);
      if (lid) {
        this.lid = new Mesh(lid, this.stackMat);
        this.lidGroup.add(this.lid);
      }
    }
    this.requestRender();
  }

  /** Open cardboard box (bottom + 4 walls) around the inner volume, plus edge lines. */
  private buildBox(min: [number, number], size: [number, number, number]): void {
    const [L, W, H] = size;
    const t = Math.max(2, Math.min(L, W) * 0.015);
    const g = new Group();
    const add = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const m = new Mesh(new BoxGeometry(sx, sy, sz), this.cardboardMat);
      m.position.set(x, y, z);
      m.renderOrder = 2;
      g.add(m);
    };
    const cx = min[0] + L / 2,
      cy = min[1] + W / 2;
    add(L + 2 * t, W + 2 * t, t, cx, cy, -t / 2);
    add(t, W + 2 * t, H, min[0] - t / 2, cy, H / 2);
    add(t, W + 2 * t, H, min[0] + L + t / 2, cy, H / 2);
    add(L, t, H, cx, min[1] - t / 2, H / 2);
    add(L, t, H, cx, min[1] + W + t / 2, H / 2);
    const lines = new LineSegments(new EdgesGeometry(new BoxGeometry(L, W, H)), this.boxLineMat);
    lines.position.set(cx, cy, H / 2);
    g.add(lines);
    this.boxGroup = g;
    this.group.add(g);
  }

  setSelected(L: number): void {
    if (L === this.selected || !this.preview) return;
    this.selected = L;
    if (this.overlay) {
      this.overlay.removeFromParent();
      this.overlay.geometry.dispose();
      this.overlay = null;
    }
    const p = this.preview;
    const a = p.layerStart[L],
      b = p.layerStart[L + 1];
    if (b > a && this.isVisible(L) && !this.anim) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(p.positions.slice(a * 3, b * 3), 3));
      g.setAttribute('normal', new BufferAttribute(p.normals.slice(a * 3, b * 3), 3));
      this.overlay = new Mesh(g, this.overlayMat);
      this.overlay.renderOrder = 1;
      (this.splitLayer >= 0 && L >= this.splitLayer ? this.lidGroup : this.group).add(this.overlay);
    }
    this.requestRender();
  }

  clear(): void {
    this.stopAnimation();
    this.disposeMeshes();
    this.preview = null;
    this.selected = -1;
    this.requestRender();
  }

  /** Lift the lid layers (insert mode) by `mm`. */
  setExplode(mm: number): void {
    this.explode = mm;
    this.lidGroup.position.z = this.splitLayer >= 0 ? mm : 0;
    this.requestRender();
  }

  /** See-through foam so the item inside is visible. */
  setXray(on: boolean): void {
    this.stackMat.transparent = on;
    this.stackMat.opacity = on ? 0.35 : 1;
    this.stackMat.depthWrite = !on;
    this.stackMat.needsUpdate = true;
    if (this.itemMesh) this.itemMesh.renderOrder = on ? -1 : 0;
    this.requestRender();
  }

  // ---- Assembly animation ----

  get animating(): boolean {
    return this.anim !== null;
  }

  /**
   * Drop the steps into the box one after another (layers, then the item, then the lid).
   * Each piece falls from above the box; with reduced motion they appear in place.
   */
  playAssembly(
    steps: AssemblyStep[],
    onStep: (label: string, i: number) => void,
    onDone: () => void,
  ): void {
    if (!this.preview || !this.attrs) return;
    this.stopAnimation();
    const p = this.preview;
    const { pos, nor, col } = this.attrs;
    // Hide the static stack; build one mesh per step sharing the preview buffers.
    for (const m of [this.stack, this.lid, this.overlay]) if (m) m.visible = false;
    if (this.itemMesh) this.itemMesh.visible = false;
    this.lidGroup.position.z = 0;
    const meshes = steps.map((s) => {
      if (s.kind === 'item') return this.itemMesh;
      const g = new BufferGeometry();
      g.setAttribute('position', pos);
      g.setAttribute('normal', nor);
      g.setAttribute('color', col);
      g.setDrawRange(p.layerStart[s.index], p.layerStart[s.index + 1] - p.layerStart[s.index]);
      g.boundingSphere = null;
      const m = new Mesh(g, this.stackMat);
      m.frustumCulled = false;
      m.visible = false;
      this.animGroup.add(m);
      return m;
    });
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.anim = {
      steps,
      meshes,
      start: performance.now(),
      stepMs: reduced ? 0 : 750,
      gapMs: reduced ? 450 : 180,
      lift: this.size[2] * 1.6 + 60,
      onStep,
      onDone,
      lastStep: -1,
      raf: 0,
    };
    this.frameModel([this.size[0], this.size[1], this.size[2] * 1.6]);
    const tick = () => {
      const a = this.anim;
      if (!a) return;
      const t = performance.now() - a.start;
      const per = a.stepMs + a.gapMs;
      const active = Math.min(a.steps.length - 1, Math.floor(t / per));
      for (let i = 0; i < a.steps.length; i++) {
        const m = a.meshes[i];
        if (!m) continue;
        const local = t - i * per;
        if (local < 0) {
          m.visible = false;
          continue;
        }
        m.visible = true;
        const k = a.stepMs > 0 ? Math.min(1, local / a.stepMs) : 1;
        const ease = 1 - Math.pow(1 - k, 3); // ease-out cubic
        const dur = a.steps[i].kind === 'item' ? 1.25 : 1;
        m.position.z = a.lift * (1 - Math.min(1, ease * dur));
      }
      if (active !== a.lastStep) {
        a.lastStep = active;
        a.onStep(a.steps[active].label, active);
      }
      this.renderNow();
      if (t < a.steps.length * per + 400) a.raf = requestAnimationFrame(tick);
      else this.finishAnimation();
    };
    this.anim.raf = requestAnimationFrame(tick);
  }

  private finishAnimation(): void {
    const a = this.anim;
    if (!a) return;
    // Keep the assembled result on screen (every animated piece at rest).
    for (const m of a.meshes) if (m) m.position.z = 0;
    this.renderNow();
    a.onDone();
  }

  /** Stop any animation and restore the normal view. */
  stopAnimation(): void {
    const a = this.anim;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    this.anim = null;
    for (const m of [...this.animGroup.children]) {
      m.removeFromParent();
      (m as Mesh).geometry.dispose?.();
    }
    if (this.itemMesh) {
      this.itemMesh.position.z = 0;
      this.itemMesh.visible = true;
    }
    for (const m of [this.stack, this.lid]) if (m) m.visible = true;
    this.lidGroup.position.z = this.splitLayer >= 0 ? this.explode : 0;
    const sel = this.selected;
    this.selected = -1;
    this.setSelected(sel);
    this.requestRender();
  }

  private disposeMeshes(): void {
    for (const m of [this.stack, this.overlay, this.lid, this.itemMesh]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
    }
    if (this.boxGroup) {
      this.boxGroup.traverse((o) => (o as Mesh).geometry?.dispose());
      this.boxGroup.removeFromParent();
    }
    this.stack = null;
    this.overlay = null;
    this.lid = null;
    this.itemMesh = null;
    this.boxGroup = null;
    this.splitLayer = -1;
  }

  private frameModel(size: [number, number, number]): void {
    const r = Math.max(1, Math.hypot(size[0], size[1], size[2]) / 2);
    const target = new Vector3(0, 0, size[2] / 2);
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.1;
    const dir = new Vector3(0.75, -1, 0.7).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.1, dist / 100);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
  }

  requestRender(): void {
    if (this.frame || !this.visible) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private renderNow(): void {
    if (this.visible) this.render();
  }

  private render(): void {
    const el = this.canvas;
    const w = el.clientWidth,
      h = el.clientHeight;
    if (w === 0 || h === 0) return;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }
}
