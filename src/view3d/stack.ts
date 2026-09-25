/** three.js stack view: one merged mesh + selected-layer overlay, rendered on demand. */
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PreviewGeometry } from '../core/preview';

export class StackView {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 1, 1, 100000);
  private controls: OrbitControls;
  private group = new Group();
  private stack: Mesh | null = null;
  private overlay: Mesh | null = null;
  private lid: Mesh | null = null;
  private lidGroup = new Group();
  private itemMesh: Mesh | null = null;
  private boxLines: LineSegments | null = null;
  private splitLayer = -1;
  private explode = 0;
  private itemMat = new MeshLambertMaterial({
    color: new Color('#8fb3d9'),
    emissive: new Color('#0d1c2b'),
  });
  private boxMat = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  private preview: PreviewGeometry | null = null;
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
    new ResizeObserver(() => this.requestRender()).observe(canvas.parentElement ?? canvas);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.requestRender();
  }

  /** Replace the stack geometry. `reframe` re-fits the camera (new model / axis). */
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
    this.disposeMeshes();
    this.preview = p;
    const pos = new BufferAttribute(p.positions, 3);
    const nor = new BufferAttribute(p.normals, 3);
    const col = new BufferAttribute(p.colors, 3);
    const g = new BufferGeometry();
    g.setAttribute('position', pos);
    g.setAttribute('normal', nor);
    g.setAttribute('color', col);
    g.computeBoundingSphere();
    this.stack = new Mesh(g, this.stackMat);
    this.group.add(this.stack);
    const nLayers = p.layerStart.length - 1;
    this.splitLayer =
      opts.splitLayer !== undefined && opts.splitLayer < nLayers ? opts.splitLayer : -1;
    if (this.splitLayer >= 0) {
      const at = p.layerStart[this.splitLayer];
      const end = p.layerStart[nLayers];
      g.setDrawRange(0, at);
      const lg = new BufferGeometry();
      lg.setAttribute('position', pos);
      lg.setAttribute('normal', nor);
      lg.setAttribute('color', col);
      lg.setDrawRange(at, end - at);
      lg.computeBoundingSphere();
      this.lid = new Mesh(lg, this.stackMat);
      this.lidGroup.add(this.lid);
    }
    this.lidGroup.position.z = this.splitLayer >= 0 ? this.explode : 0;
    if (opts.item) {
      const ig = new BufferGeometry();
      ig.setAttribute('position', new BufferAttribute(opts.item, 3));
      ig.computeVertexNormals();
      this.itemMesh = new Mesh(ig, this.itemMat);
      this.group.add(this.itemMesh);
    }
    if (opts.box) {
      const [L, W, H] = opts.box.size;
      const eg = new EdgesGeometry(new BoxGeometry(L, W, H));
      this.boxLines = new LineSegments(eg, this.boxMat);
      this.boxLines.position.set(opts.box.min[0] + L / 2, opts.box.min[1] + W / 2, H / 2);
      this.group.add(this.boxLines);
    }
    this.group.position.set(-size[0] / 2, -size[1] / 2, 0);
    if (reframe) this.frameModel(size);
    const sel = this.selected;
    this.selected = -1;
    this.setSelected(sel < 0 ? 0 : Math.min(sel, p.layerStart.length - 2));
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
    if (b > a) {
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

  private disposeMeshes(): void {
    for (const m of [this.stack, this.overlay, this.lid, this.itemMesh, this.boxLines]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.stack = null;
    this.overlay = null;
    this.lid = null;
    this.itemMesh = null;
    this.boxLines = null;
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
