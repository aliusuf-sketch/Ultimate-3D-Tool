# Foam Slicer

Turn an STL model into a stack of flat, foam-sheet-thick layers. Foam Slicer exports each layer as a 2D cut pattern (DXF and SVG) for CNC hot-wire, router, or laser cutting. Glue the cut layers back together in order to rebuild the 3D shape.

Everything runs in your browser. Files are never uploaded, and there is no backend.

## Features

- **Load** binary or ASCII STL files by file picker or drag-and-drop, or use the procedural sample torus. Units are millimetres.
- **Orient and size**: choose the stack direction (Z / Y / X, using proper rotations, never mirroring). Set the model size as X / Y / Z in mm (Z is the stack height). With **Lock proportions** on, the scale stays uniform; turn it off to scale each axis independently.
- **Slice** at your sheet thickness (default 10 mm). Each cutting plane sits mid-layer, and mid-remainder for a partial top layer. Contours are chained into closed loops, simplified with Douglas–Peucker, and sorted into outlines and holes.
- **Add alignment pins**: 1 or 2 dowel holes at the same XY position on every layer. A pin is only drawn where it clears the material edge by at least `r + 0.8 mm`, and layers that can't fit every pin are reported.
- **Engrave labels**: `L01`, `L02`, … placed at the point of maximum clearance. The text shrinks to fit narrow parts.
- **Nest onto sheets**: shelf packing onto stock sheets sized in feet (default 4 × 2 ft, 6 mm gap and margin). Parts rotate 90° when that helps, and parts too big for a sheet get their own `_oversize` sheet.
- **Estimate material cost**: enter a price per sheet and the bottom-left corner of the viewport shows, live, the sheets to buy, the total cost and the % of material used. Oversize parts count as the whole sheets their area needs.
- **Export a ZIP** with:
  - `layers/L01_z0-10.dxf|svg`: one file per layer. All layer files share the model's XY origin, so the pin holes line up.
  - `sheets/sheet_01.dxf|svg`: the nested sheets.
  - `README.txt`: the settings used and a colour legend.
  - DXF files are R12 (`AC1009`) with `$INSUNITS = 4` (mm). Cuts are closed polylines and circles on layer `CUT`; labels are text on layer `ENGRAVE`.
  - SVG files are sized in mm. Cuts are red `#FF0000` (0.1 stroke) and engraving is blue `#0000FF`.
- **Inspect** the result two ways:
  - A 3D stack view with orbit controls; the selected layer is highlighted.
  - A 2D layer pattern view showing the current layer, the layer below as a dashed outline, pins, the label, dimensions, and open contours (mesh gaps) in yellow.

## Layout

- **Left: Setup.** One step at a time: _Item → Box → Foam → Fit → Output_ for shipping inserts, or _Model → Layers → Pins → Output_ for the slicer. Rarely needed settings are folded under **More options**.
- **Centre: the view.** 3D stack or cut pattern, the selected layer, an always-visible **Download ZIP** button, and (shipping) a one-line summary of the fit with any warnings.
- **Right: Layers** (shipping only). The stack, top first: show/hide, lock or remove layers and play the packing animation.
- The in/mm switch for shipping inserts is in the top bar.

## Shipping insert mode

Switch to **Shipping insert** in the top bar to make laser-cut foam packaging that holds a 3D print securely in a box.

1. Load the STL of the item (or **Load sample** for a vase). Under **Item size**, set the STL's units (mm / cm / inch) and scale it by % or by exact X / Y / Z size (proportions locked or free).
2. Enter the box's **inside** dimensions (inches or mm), pick a standard size, or click **Smallest box that fits**.
3. **Base & top layers**: the base is _Closed_ (default) or _Open_ (the item sits on the box floor); the top is _Open_ (default, the item lifts out of the top) or _Closed_. For a closed side, choose how many layers (1–4) and each layer's thickness. The pocket layers between them fill the rest of the box. With an open top the report shows the space left to the box lid.
4. Tick the foam thicknesses you can buy (½, 1, 2, 3 in by default) and their price per sheet.
5. The planner then:
   - chooses the sheets and their order so the stack fills the box height, with the item resting on a layer and its top as close as possible under the next layer;
   - picks the orientation with the most foam and the least vertical play (or set it yourself);
   - cuts each layer's cavity with a clearance gap. The default **Open-top pocket** style glues every layer the item touches into one pocket block whose cavity only widens going up, so the item lifts straight out of the top; solid lid pads sit above it. In **Base + lid** style the stack splits at the best parting layer and the cavities have no undercuts, so a rigid print drops into the base and the lid closes over it. **Follow the shape** cuts each layer to the item's own outline, for soft foam;
   - adds finger notches so the item can be lifted out, and drops tiny loose foam bits.
6. **Boxes**: enter sizes as _inside_ or _outside_ (with a wall thickness), and **Save box** to keep your own box sizes under "My boxes" (stored in this browser). "Smallest box that fits" can search your boxes, the standard sizes, or both.
7. **Layers panel**: show/hide any layer in the 3D view, remove a layer (it is left out of the cut files, nesting and cost, and the report warns about the gap), or lock layers. When every layer is locked the design is frozen and **Play packing animation** shows the layers dropping into the box, then the item, then the lid pads.
8. The **protection report** shows foam on each side, above and below, how far the item can still move vertically, and anything to fix. The corner card shows the cost per foam thickness.
9. **Download ZIP**: one DXF/SVG per layer (named like `L02_pocket_2in`), sheets nested per thickness (`sheets/2in/…`), `cut_list.csv`, and a README with the stack order and gluing steps.

## How to use (model slicer)

1. Click **Open STL** (or drop a file on the viewport), or click **Load sample**.
2. Pick the stack direction and the X / Y / Z size in mm, then set the sheet thickness to match your foam.
3. Set up pins, labels, the sheet size (ft) and the price per sheet. Watch the stats line for warnings and the cost card for the material total.
4. Scrub through the layers with the slider. Switch to **Layer pattern** to check each cut.
5. Click **Download ZIP**, then cut the parts. Stack **L01 at the bottom**, push dowels through the pin holes, and glue.

## Local development

Requires Node 20.19+ and npm.

```bash
npm install
npm run dev       # start the dev server at http://localhost:5173
npm test          # run the Vitest unit tests for src/core
npm run lint      # run ESLint and the Prettier check
npm run build     # type-check, then build a production bundle to dist/
npm run preview   # serve dist/ locally
npm run bench     # optional: time slicing a 500k-triangle model
```

### Architecture

```
src/
  main.ts              app bootstrap and UI wiring
  ui/                  settings form, theme, toasts, styles
  view3d/stack.ts      three.js stack (one merged mesh + selection overlay, render on demand)
  view2d/layer2d.ts    canvas layer inspector
  core/                pure geometry, no DOM (safe to run in the worker)
    stl.ts transform.ts slice.ts chain.ts simplify.ts topology.ts
    extras.ts nest.ts preview.ts pack.ts pipeline.ts sample.ts
    export/dxf.ts export/svg.ts export/zip.ts
  worker/slicer.worker.ts   parsing, slicing, pins/labels, nesting and export
tests/                 Vitest specs for core/
```

Notes on performance:

- All heavy work runs in a Web Worker, and results come back as transferable typed arrays.
- Superseded jobs are cancelled by job id. The worker yields cooperatively, so a new request interrupts a running slice.
- Pin, label and sheet changes don't re-slice, and moving the slider never talks to the worker.
- The 3D view draws the whole stack in a single draw call and only renders when something changes.

## Deploy to Vercel

The repo includes `vercel.json`:

- It uses the Vite framework preset, builds with `npm run build`, and serves `dist/`.
- `/assets/*` files are cached for a long time (immutable).
- Every response sends `X-Content-Type-Options: nosniff`.

**Option A: dashboard**

1. Go to <https://vercel.com/new> and import this GitHub repository.
2. Keep the detected settings (Vite, `npm run build`, `dist`) and click **Deploy**.
3. Pushes to `main` deploy to production, and pull requests get preview deployments automatically.

**Option B: CLI**

```bash
npx vercel link
npx vercel --prod
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, lint, test and build on Node 20 for every push and pull request.

## License

MIT. See [LICENSE](LICENSE).
