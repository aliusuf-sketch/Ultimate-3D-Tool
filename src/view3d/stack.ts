/** three.js stack view: one merged mesh + selected-layer overlay, rendered on demand. */
import {
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
    new ResizeObserver(() => this.requestRender()).observe(canvas.parentElement ?? canvas);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.requestRender();
  }

  /** Replace the stack geometry. `reframe` re-fits the camera (new model / axis). */
  setPreview(p: PreviewGeometry, size: [number, number, number], reframe: boolean): void {
    this.disposeMeshes();
    this.preview = p;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(p.positions, 3));
    g.setAttribute('normal', new BufferAttribute(p.normals, 3));
    g.setAttribute('color', new BufferAttribute(p.colors, 3));
    g.computeBoundingSphere();
    this.stack = new Mesh(g, this.stackMat);
    this.group.add(this.stack);
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
      this.group.remove(this.overlay);
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
      this.group.add(this.overlay);
    }
    this.requestRender();
  }

  clear(): void {
    this.disposeMeshes();
    this.preview = null;
    this.selected = -1;
    this.requestRender();
  }

  private disposeMeshes(): void {
    for (const m of [this.stack, this.overlay]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.stack = null;
    this.overlay = null;
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
