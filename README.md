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

Switch to **Shipping insert** in the top bar to make laser-cut foam packaging that holds a 3D print securely in a box. The setup follows the order you'd think about it:

1. **Ship**: how the item ships (**Open-top pocket**, the default, lifts straight out; **Base + lid** splits at the widest point; **Follow the shape** hugs the item for soft foam), its **orientation** (_Auto_ picks the one needing the smallest box, or _Manual_ locks it), and the **item size** (STL units mm / cm / inch, scale %, or exact X / Y / Z).
2. **Foam**: the base (closed by default, 1–4 layers, each thickness) and top (open by default so the item lifts out), plus the foam thicknesses you can buy and their prices.
3. **Box**: _Best fit_ chooses the box for you from the item, its orientation, the base/top layers and the side foam: the smallest of your saved boxes and the standard sizes, or an _exact custom size_. _I have a box_ lets you enter one (inside or outside sizes, saved boxes); "Suggest the smallest box" keeps a locked orientation. If a box can't hold the item, the 3D view shows the item in the box with the reason and a one-click fix.
4. **Fit**: gap around the item, finger notches, and more options (press-in, overfill, outline oversize, loose-bit removal, two-part split).
5. **Output**: labels, sheet size and cost, and the ZIP (one DXF/SVG per layer, sheets nested per thickness, `cut_list.csv`, and a README with the stack order and gluing steps).

The summary bar under the view shows the fit (side foam, below/above, vertical play or space to the box lid) and warnings. The corner card shows the material cost per thickness. The **Layers** panel on the right shows/hides, locks or removes layers; with every layer locked, **Packing animation** shows the layers, then the item, then any top layers going into the box.

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
