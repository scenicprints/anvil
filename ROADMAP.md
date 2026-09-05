# Anvil roadmap

The goal is Fusion 360's feature set, worked through one batch at a time. This
file is the running plan. It is written for whoever picks the work up next,
which is usually a fresh agent with no memory of the last session.

**Read `README.md` first.** It documents what is already here and, importantly,
the places where Anvil deliberately falls short of Fusion. This file only covers
what is *not* built yet.

Current version: **2.3.0**. 305 tests. Batches 1 to 9 shipped, and the first
half of Batch 10.

---

## How to use this document

1. Read the ground rules and the architecture notes below. They are short and
   they are where the time goes when they are skipped.
2. Pick the lowest-numbered batch that is not marked shipped. Do not skip ahead:
   later batches depend on earlier ones, and where they do it says so.
3. For every command in the batch, open its own page in Fusion's help before
   building it:
   <https://help.autodesk.com/view/fusion360/ENU/?guid=GUID-1C665B4D-7BF7-4FDF-98B0-AA7EE12B5AC2>
   That link is the "New to Fusion" landing page; use the site's own search box
   for the command by name. Guessing a `?guid=` slug returns a 404 shell, and
   fetching one as plain HTML returns the same shell, so search rather than
   guess. Fusion's own page fixes the option set and the ordering, which turns
   the work into a checklist instead of a guess. The command lists below are a
   reading of Fusion and are good enough to plan against, not to build against.
4. Ship the whole batch at once, then build, install and report. He prefers one
   big update to a stream of small ones.

---

## Ground rules

These are the owner's, and they are not negotiable.

- **Read the source and the canon before answering. Do not guess.** Grep it.
- **No em dashes.** Commas or periods.
- **Big batched updates**, not a stream of small ones.
- **Never commit or push to any repo without explicit go-ahead.** Building and
  installing locally is expected and does not need asking. Pushing does.
- **Do not over-explain after a correction.** Fix it and move on.
- Comments in this codebase explain *why*, not *what*, and they read as prose.
  Match that. A comment that restates the line below it does not belong.

### The two lessons that cost real time

- **When he says something "isn't working", check whether he can SEE it working
  before hunting for a fault.** An extrude was correct to the millimetre while
  looking completely broken, because a sketch leaves the camera at zero degrees
  off its own normal and the depth goes straight away from the viewer. Every
  test passed. Drive the real path and LOOK at the screenshot.
- **Volume-based tests cannot catch selection, highlight or feedback bugs.** Two
  such bugs sat in heavily tested code for a whole version. If a change touches
  what the user sees or picks, it needs a driven screenshot, not another
  assertion about a volume.

---

## Architecture you must know before touching anything

### Where a feature lives

A new modelling command touches five places. Missing one is the usual failure.

| File | What to add |
|---|---|
| `src/renderer/features.js` | A `doThing(feature, ...)` builder, **nested inside `rebuild()`**, and a `case 'thing':` in the big switch. Also a `FEATURE_LABELS` entry. |
| `src/renderer/app.js` | A `thingFields()` spec, a `startThing()` command, a `case 'thing':` in `runCommand`, and any new `pickInto` kind. |
| `src/renderer/index.html` | The ribbon button, `data-cmd="thing"`. |
| `test/suite.js` | Tests asserting measured quantities against an independently derived reference. |
| `tools/demo-*.js` | A driven run through the real interface if the change is visible. |

The `do*` builders are nested inside `rebuild()` so they close over the kernel
scope and the boolean applier. Put a new one beside its neighbours, not at file
scope, or it will not see `apply` or `ks`.

### The single specs

Every solid command's dialog is one field spec used for both create and edit:
`extrudeFields`, `revolveFields`, `sweepFields`, `loftFields`, `holeFields`,
`blendFieldsFor`, `shellFields`, `draftFields`, `patternRect`/`CircFields`,
`combineFields`, `moveFields`, `scaleFields`, `splitFields`, `mirrorFields`, all
in `app.js`. A new command gets one of these, not a bespoke dialog.

A dialog opens **waiting to be pointed at** rather than requiring a selection
first. That is the Fusion behaviour and it is not optional. The `pick` field
type routes viewport clicks into the open dialog via `state.editing.pickInto`.

### Picking

- `pickIntoEdit(hit)` in `app.js` folds a viewport click into the armed field.
- `acceptPick(hit, e)` folds it into the document selection instead.
- **When you add a pick kind, add it in both places, and check every site that
  gates on the armed name.** `pickProfile` was called only for
  `armed === 'profiles'`, so a loft's section list could never take a profile
  even though the raycast found it.
- `PICK_PROMPTS` in `app.js` gives the callout its wording, and
  `pickCountText()` gives it the running count. Add an entry for a new kind or
  the callout says "Click the edges to use" at everything.

### Geometry helpers

- `profile.js` owns tessellation, `findRegions`, and the curve quality rule
  (`MIN_CIRCULAR_ANGLE` / `MIN_CIRCULAR_EDGE`). Sketch and kernel tessellation
  must come from that one rule or every boolean leaves sliver triangles.
- `entityRuns(sketch, ent)` is how drawing, picking and box selection walk an
  entity, because one entity can be many closed loops (text). Do not go back to
  calling `tessellate` directly at those sites.
- `entityPoints(ent)` / `remapEntityPoints(ent, fn)` in `sketchview.js` are the
  one place that knows how each entity type carries its point indices. There
  used to be five copies of that walk. Adding a sixth is how a sketch silently
  renumbers out from under itself.
- `meshbuild.js` has `stitchTube`, `pathFrames`, `loftLoops`, `sweepLoop`,
  `helicalSweep` and `variableSweep` already. Reach for these before writing new
  stitching. `helicalSweep` in particular is most of a Coil.
- `edgefeature.js` has `buildEdgeTools`, `buildFacePrism`, and the
  `resolveFaceRefs` / `resolveEdgeRefs` re-matching. `buildFacePrism` is the
  workhorse for anything that has to grow or cut along a face's own normal.
- `kernel.js` is the whole manifold surface. There is no `thicken`, no
  `offsetSolid`, and no surface type. If a command needs one, it belongs in
  Batch 7, not wherever you found it.

### Verification protocol

```bash
npm test
npx electron . --anvil-shot shots/x.png --anvil-script tools/demo-x.js
npm run dist
cmd /c "dist\Anvil-Setup-<version>.exe /S"
```

- Give the `--anvil-shot` runs **300 seconds**. `demo-advanced` exceeds 150.
- Never pipe an `--anvil-shot` run into `head`. SIGPIPE part way through looks
  exactly like a hang in the app. Redirect to a file.
- The NSIS installer **ignores `/S` unless launched through `cmd /c`**. Any
  other way and it hangs as a GUI. Run that from **PowerShell with the full
  path**, not from bash: `cmd /c "dist\Anvil-Setup-x.exe /S"` through bash
  opens an interactive `cmd` and installs nothing, while reporting success.
- After installing, check the installed exe's version *and* that the new code is
  actually inside `resources/app.asar`. `npm run dist` does not install, and a
  stale install has been mistaken for a broken feature before.
- Always `node --check` after editing `src/main/main.js`.
- Bump the version in `package.json` for every shipped batch.
- **Commit and push at the end of every batch.** The repo is
  `scenicprints/anvil`, public, on `main`. Batches 1 to 6 shipped with no
  version control at all because nobody checked `git remote -v` before
  starting. Check it first, push last.

### Traps that have already bitten

The full list is in `README.md` and in the project memory. The ones that keep
recurring:

- `.map(helper)` passes the array index as the helper's second argument. This
  destroyed every text loop after the first by welding it at a tolerance of
  1 mm, 2 mm, 3 mm. Always `.map((x) => helper(x))`.
- `CrossSection.extrude`'s `scaleTop` must be an `[x, y]` pair. The scalar `1`
  is accepted by the typings and silently extrudes a wedge of half the volume.
- `feature.seeds` has three states and they all mean different things:
  `null`/absent is the whole sketch, an array is those profiles, `[]` is nothing
  picked yet. `seeds?.length ? ... : regions` collapses the last two.
- An empty array is truthy, and `feature.suppressed` already means the whole
  feature is off. Do not name a list `suppressed`.
- A dialog's field list is worked out once when it opens. A row that changes
  what rows exist must re-derive from `describeFeature` before re-rendering.
- Fields cannot be redrawn on every rebuild without eating half-typed text, so
  only the message is refreshed, by `syncDialogError()`.
- Colour emoji leak into an otherwise monochrome interface. Check any new ribbon
  glyph renders as text. `℮` and `␣` both looked wrong and had to be replaced.
- Adding ribbon buttons can push a group onto a third row and cost the viewport
  fifty pixels. `.group` is capped at 648px. Check with a screenshot.
- Stitched meshes reach the kernel as float32, so a surface meant to lie exactly
  in a face plane wobbles either side of it. Push it 10 microns clear on purpose.
- Grep for a helper's name before declaring one. A second `bodySpan` clobbered
  the first silently and cost a debugging pass; JavaScript will not complain.
- `''.split(/[\s,]+/)` is `['']`, and `Number('')` is 0. A blank "which ones"
  field parsed as "the first one" until that was filtered.
- Anything that paints a body's material has to be able to put back what was
  there. `_applyHighlights` hardcoded the solid grey, which flattened both the
  surface tone and the analysis vertex colours.
- A surface body has no volume. Mass, section and interference all have to skip
  one, and every boolean has to refuse one, or the kernel produces nonsense
  rather than an error.
- Handedness is not worth deriving. Where a sign depends on whether a frame is
  right handed, compute it at runtime from a dot product and move on. Batch 8's
  bends did this and every measurement was right first time; the arc slots in an
  earlier batch did not, and cost a session.
- Any id a later feature refers to has to come from the feature that made it. A
  counter is reset by the rebuild and renames everything under the references.
- Before adding a field to an object, check what that name already means on it.
  A record's `mesh` was its triangles; a `mesh` flag replaced them with `true`.
- Wrap a driven demo's body in a try/catch that reports `err.stack`. Without it
  a failure is one line with no idea where, and finding it costs a run each
  time. Check it parses first: a demo is an async function body, not a module.
- A body handle does not survive a rebuild: the last result's solids are freed.
  Keep ids across a rebuild and look the body up again, never the object.
- A demo that puts everything at the origin proves the arithmetic and shows
  nothing. Lay the work out along an axis before taking the picture.

---

## Batch 1, shipped in v1.1.0

The three outstanding UI items, and Fusion's Sketch tab brought up to parity for
everything the existing machinery could reach.

- Profile picking toggles instead of adding twice (`samePoint` was comparing
  `{x, y}` as `[0]`/`[1]`, so the comparison was always NaN). `sameSection`
  replaces the loft list's broken comparator.
- Profiles are coloured from whichever list owns the selection right now, so one
  picked into a dialog looks picked. Hover highlighting while a pick is armed.
  Deeper blue, `#1f4f9c` selected and `#5a86c8` hovered.
- The viewport bar is replaced by a callout that follows the cursor, carrying
  the command name, what it wants, a running count and Escape to let go.
- Sketch: **ellipse**, **text**, **break**, **extend**, **rectangular pattern**,
  **circular pattern**, **scale**.
- Text is real traced outlines. `src/renderer/textoutline.js`.

---

## Batch 2, shipped in v1.2.0

Coil, Emboss, Web, Align, Delete Face and Silhouette Split, all to Fusion's own
dialogs. Two bugs turned up on the way, both of which had been sitting there:

- **A cylindrical face could never be matched back.** `faceReference` stored the
  average of the face's normals, and a bore's facet normals point every way
  round and average to nothing, so no stored reference to a round face ever
  resolved. It now records the axis and the radius. This was silently blocking
  anything that wanted to keep hold of a bore.
- **A bore under 4 mm radius was not read as a cylinder at all.** The rule that
  promotes a flat patch to its own face is a two percent share of its group,
  which every facet of a coarse bore passes, so a 3 mm hole came back as forty
  flat faces. Every M3 and M4 screw hole was affected. A uniform ring of facets
  is now kept whole.

Scope kept as planned: Delete Face fills a round bore and refuses anything else,
Silhouette Split needs a flat parting line, and Emboss needs the sketch parallel
to the face. Each says so rather than guessing.

The ribbon ran out of room on the way, so **Primitive** and **Pattern** became
dropdown buttons. That was scheduled for Batch 3 and is done.

---

## Batch 2 as originally planned

**Depends on:** nothing. Start here.

### What ships

| Command | What it is | Notes |
|---|---|---|
| **Coil** | A helical solid: revolutions, height, angle, section shape | `meshbuild.js` already has `helicalSweep` for threads. This is mostly a dialog. Do this one first, it is the easy win. |
| **Emboss** | A sketch profile raised or engraved on a face | Planar face is `buildFacePrism` plus a boolean. A cylindrical face needs the contour wrapped round the axis. Do both; refuse anything else with a clear message. |
| **Web** | Thin walls from open sketch curves, bounded by the body | Rib generalised: several intersecting chains, each thickened, then trimmed to the body. `doRib` and `thickenPolyline` are the starting point. |
| **Align** | Move a body so a face, edge or point lands on another | A `move` variant with three modes. `moveFields` already has point-to-point; this adds face-to-face and axis-to-axis. |
| **Delete Face** | Remove a face and heal the body | Planar: extend the neighbours to close it. A cylindrical through-bore: fill it with its own cylinder. Refuse the general case rather than producing a non-watertight body. |
| **Silhouette Split** | Split a body at its silhouette relative to a direction | Sweep the silhouette loop along the direction into a cutting tool, then `doSplit`. Used for parting lines. |

### The hard parts

- **Emboss on a cylinder.** Take the contour in sketch space, treat one axis as
  arc length round the cylinder, and map to the cylinder's frame. Facet it at
  the shared curve quality rule or the boolean strips.
- **Web trimming.** Fusion trims each wall to the body it lands in. Build the
  wall generously, then intersect with the body, then union. Getting the order
  wrong leaves walls hanging in space.
- **Delete Face healing.** Say no clearly. A body that comes back with a hole in
  it is worse than a refused command, and manifold's watertightness guarantee is
  the whole reason the kernel was chosen.

### Verify

- Tests: coil volume against Pappus (section area times the centroid's path
  length); emboss volume against contour area times height; a web's volume
  against thickness times length times depth; delete face leaves genus and
  volume as derived.
- Demo: `tools/demo-solid2.js` building one part that uses all six, with a
  screenshot. Emboss especially needs looking at, not just measuring.

### Done when

Six new ribbon buttons, six `FEATURE_LABELS` entries, tests green, the demo
screenshot shows recognisable geometry, installed and version bumped to 1.2.0.

---

## Batch 3, shipped in v1.3.0

Three point rectangle, two and three tangent circles, inscribed, circumscribed
and edge polygons, all five slot variants, the conic curve, the control point
spline, and Insert SVG and Insert DXF. Sides and Rho got a control, since the
polygon tool had been hardcoded to six sides with no way to change it.

Two bugs turned up, both older than this batch:

- **The snapper threw on any sketch holding a spline, a point, text or a
  conic.** It read `points[ent.c]` for every entity that was not a line, and
  those four have no centre. A pointer handler swallows what it throws, so the
  sketch simply stopped answering clicks, silently, from the moment one was
  drawn.
- **Every slot ever drawn had its ends bitten in rather than rounded off.** The
  end arcs were wound the short way round, which is back through the middle. It
  is close enough to right at a glance that it survived since the tool was
  written; the area is the rectangle minus a circle instead of plus one. Both
  slot shapes now have an area test.

The second one is worth remembering as a method: it was caught by looking at
the screenshot, then confirmed against the formula for a stadium. Three of the
four cap windings produce a plausible looking shape, so it was settled by
measuring all four rather than by reasoning about which was right.

Finished in v1.4.0 with the tangent arc, Intersect, and Project's linked and
copy forms. A third old bug turned up doing it:

- **The live projection path was dead code.** `projectInto` in `features.js` has
  always read `sk.projections`, and nothing has ever written it. Project made
  frozen geometry with fixed constraints, while eighty five lines of
  associative projection sat unreachable and the README claimed projections were
  live. They are now: Project writes edge references and the rebuild flattens
  them every time, with the old frozen behaviour kept as "project as a copy",
  which is Fusion's Projection Link unticked.

Derived geometry, projected edges and sections both, needed display work that
did not exist: the sketch editor draws it, snaps to it, and counts it when
finding regions, and finished sketches draw it too. Without that a section is
geometry you can measure but not see, which is the same trap as the extrude that
was correct and invisible.

**Moved to Batch 7 rather than left undone:** Include 3D Geometry, and with it
Project To Surface, Intersection Curve and Isoparametric Curve. Each produces a
curve that does not lie in the sketch plane, so all four wait on the 3D sketch,
and three of them on surfaces as well. They are listed there.

---

## Batch 3 as originally planned

**Depends on:** Batch 1's entity plumbing (`entityRuns`, `entityPoints`).

### What ships

**Curve variants Fusion has and Anvil does not:**

- Conic curve (rho-controlled, between two endpoints and an apex)
- 3-point rectangle
- Tangent circles: 2-tangent, 3-tangent
- Tangent arc
- Slot variants: overall length, centre point, three-point arc slot, centre
  point arc slot (Anvil has centre-to-centre only)
- Polygon: circumscribed, inscribed, edge (Anvil has one of the three)
- Control-point spline as well as the existing fit-point spline

**Project variants:**

- Intersect (where the sketch plane cuts a body)
- Include 3D Geometry

**Insert:**

- **Insert SVG.** Parse path data into sketch entities. Lines and arcs keep
  their kind; beziers come in as splines. This is the highest-value item in the
  batch for a printed part.
- **Insert DXF.** Same idea, and DXF is closer to CAD so more of it survives.

### The hard parts

- **Tangency has to be solved, not constructed.** A 3-tangent circle is a small
  solve. `solver.js` already carries a tangent constraint, so place the circle
  approximately and let the solver settle it, rather than deriving it in closed
  form.
- **A control-point spline is a different curve from a fit-point spline.** It
  needs its own entity type and its own tessellation. Do not reuse `spline` with
  a flag; the two behave differently under dragging and it will confuse the
  freedom analysis.
- **SVG's Y axis points down** and its transforms nest. Flatten the transform
  stack before emitting points, and flip Y once at the end, in one place.

### Verify

- Tests: a conic's area at rho = 0.5 against the parabola it is; each slot
  variant's area against its own derived formula; an SVG rectangle's four
  corners against the file's own numbers.
- Demo: import an SVG and extrude it.

### Done when

Version 1.3.0, tests green, an SVG round-trips into a solid.

---

## Batch 4, shipped in v1.5.0

Construct gained Plane Along Path, Plane Tangent At Point, Point Along Path and
Point Where 3 Planes Meet, and Axis Normal now takes a face as readily as a
plane. Inspect gained Section Analysis, Centre Of Mass, Interference and Draft
Analysis, with a materials table behind the mass.

Section Analysis takes the boolean rather than clipping, as this file said it
should. That is worth keeping: a clipping plane hides the triangles in front and
shows what is behind them, which is the inside of the closed surface, so a solid
reads as hollow and a wall has no thickness. There is a test that the cut half of
a box has exactly half its volume, which only holds if the cut was capped, and
another that the body is the same size afterwards.

One bug, and it was mine from an hour earlier: `K.Scope` has `dispose()`, not
`delete()`, and two call sites in `app.js` had `scope.delete()`. It would have
thrown the moment Interference or a Section was used. The tests caught it because
they exercised the same call, which is the argument for writing the test against
the real helper rather than around it.

**Finished in v1.6.0**, having first been left out on the argument that they
judge styled surfaces rather than functional parts. That was the wrong call to
make on someone else's behalf, and the work was a couple of hours: curvature
comb, curvature map, minimum radius, zebra, environment map and accessibility
are all in. Curvature is per vertex, Gaussian from the angle deficit and mean
from the cotangent Laplacian; the mean was out by a factor of two until a sphere
of radius 20 was made to read 1/20 rather than 1/40.

**Isocurve Analysis** is the one still outstanding, and it is a dependency
rather than a decision: it draws a surface's U and V curves and a triangle mesh
has neither. It waits on Batch 7.

---

## Batch 4 as originally planned

**Depends on:** nothing, can be done in parallel with Batch 3.

### What ships

**Construct, filling out `CONSTRUCTION_LABELS`:**

- Plane along path
- Plane tangent to face at point
- Axis perpendicular to face at point
- Point through three planes
- Point along path

**Inspect, which is display and measurement only and adds nothing to the model:**

- **Section analysis.** A clipping plane in the viewport, driven by a construct
  plane and an offset. Very high value, quite reachable: three.js has clipping
  planes and the kernel is not involved at all.
- **Centre of mass.** Trivial from the mesh, and it wants a density, which means
  a material.
- **Interference.** Boolean intersection of every pair of bodies, reporting the
  volume of any overlap.
- **Draft analysis.** Colour each face by the angle between its normal and a
  pull direction. `topology.js` already gives per-face normals.
- **Curvature comb** on sketch curves, and **zebra** on faces. Lower value for a
  printed part; do them last or leave them.

**Materials, which Inspect needs:**

- Physical material with a density, per body, so mass and centre of mass mean
  something. Appearance is cosmetic; density is not.

### The hard parts

- **Section analysis must not lie.** A clipped solid shows its own hollow
  interior unless the cut is capped. Either cap it with a stencil pass or
  actually boolean against a halfspace and show that, which is slower but
  honest. Prefer honest.

### Verify

- Tests: centre of mass of an off-centre box against the arithmetic; the
  interference volume of two overlapping boxes against the overlap; a plane
  along a path landing normal to the path at the stated fraction.
- Demo: section a part and screenshot it.

### Done when

Version 1.4.0, and the status bar can report mass.

---

## Batch 5, shipped in v1.6.0

All of it: ball, planar and pin-slot joints on top of the four that existed,
as-built joints, rigid groups, motion links, per degree of freedom limits,
contact, and closed loop solving.

The loop solver is Gauss-Newton with Levenberg damping over the free joint
variables round each loop, the residual being whatever a closing joint fails to
line up in a direction it does not allow. Three things were worth getting right:

- **Loop detection is union-find, not "two joints share a child".** A four bar
  gives each of its four components a different parent and still comes back on
  itself, so the first attempt found no loops at all. A joint closes a loop when
  its two components are already connected, or when its child is grounded.
- **Only the joints round the loop are free.** Letting every undriven joint move
  makes the normal equations flat in the directions that do not matter and
  shifts parts nobody asked it to touch.
- **The damping is not optional.** A four bar passing through the position where
  it lines up straight makes the Jacobian go thin.

Contact is a walk, not a simulation: the driven degree of freedom is stepped
from rest towards the target and stopped at the last position with no overlap.
That is enough to keep a lid off its own hinge, and the dialog says it is
nothing more.

---

## Batch 5 as originally planned

**Depends on:** nothing, but it is the batch most likely to need real thought.

### What ships

- The three joint types Fusion has that Anvil does not: **ball**, **planar**,
  **pin-slot**. `JOINT_TYPES` in `assembly.js` currently has rigid, revolute,
  slider, cylindrical.
- **As-built joint** (joint the parts where they already are, no motion of the
  components on creation).
- **Joint origin** as a named, reusable thing rather than captured inline.
- **Rigid group.**
- **Motion link** (one joint's value drives another's, with a ratio).
- **Closed loops.** Today a closed chain of joints is reported rather than
  solved. This is the real work in the batch.
- **Motion limits** beyond the current simple clamping, and **contact sets**.

### The hard parts

- **The closed loop.** `solveAssembly` walks open chains. A loop needs an actual
  constraint solve over component transforms. The sketch solver in `solver.js`
  is Newton on a Jacobian and the same shape of problem, so read it before
  writing a second one; the residuals are different but the machinery is not.
- **Contact sets are a simulation, not a constraint.** Fusion's are approximate
  and slow. Scope this to "stop at first contact along the driven degree of
  freedom", not a physics engine, and say so.

### Verify

- Tests: a four-bar linkage closing, with the coupler's position checked against
  the analytic solution at three crank angles; a ball joint's reachable set; a
  motion link's ratio.
- Demo: drive a linkage and screenshot three positions.

### Done when

Version 1.5.0, and a closed four-bar solves instead of reporting.

---

## Batch 6, shipped in v1.7.0

Solved at the source rather than by better guessing. manifold can mark a solid
as an original, after which every triangle of it, and of anything later cut or
joined out of it, still says which original it belongs to and which flat face of
that original it was. Each feature's geometry is marked with the feature's own id
before it goes into any boolean, and a reference stores that name. An edge stores
the names of the two faces it lies between, which is what an edge is.

Three things had to be got right, each found by measuring rather than reasoning:

- **The kernel's face ids are not stable.** They come from a counter that climbs
  through the whole run, so the same face of the same shape gets a different
  number on the next rebuild. They are renumbered against each feature's own mesh
  in order of first appearance.
- **A curved face has no single face id.** It is a ring of coplanar facets with
  an id each, so taking whichever had the most triangles gave a name that changed
  for no reason. Such a face records its feature and admits the rest is not
  knowable; position tells it from its siblings.
- **Coplanar is not enough to weld two faces into one.** The face grouping breaks
  where the source differs, which is what makes Split Face leave a trace rather
  than being welded straight back into one face.

Measured on a plate with four identical bosses and a fillet on the third, while
the spacing is edited. The same check both sides:

| | Before | After |
|---|---|---|
| Face references lost | 6 of 8 | 0 of 8 |
| Fillets on the wrong boss | 6 of 9 | 0 of 9 |

**Split Face** shipped with it, since it is the feature this unblocked. Position
is still the fallback everywhere, so a file saved before this opens unchanged.

---

## Batch 6 as originally planned

**Depends on:** nothing. **Unlocks:** Split Face, and makes every later batch
less fragile.

This is not a Fusion feature. It is the thing standing between Anvil and several
of them, and it is the hardest problem in the codebase.

### The problem

manifold has no stable face or edge names. References are re-matched after each
rebuild by orientation, size and position (`resolveFaceRefs` / `resolveEdgeRefs`
in `edgefeature.js`). It fails toward reporting a lost reference rather than
silently filleting the wrong edge, which is the right failure, but it still
fails on parts where it should not.

### What ships

- A generation-to-generation matcher rather than a per-rebuild one: carry the
  previous rebuild's topology and match against it, so a dimension change is a
  small move rather than an unrecognisable new face.
- Provenance where it is free: a face produced by extruding profile *n* of
  sketch *s* can say so, and that beats any geometric match.
- **Split Face**, which needs a face to keep an identity across the split to be
  worth anything.

### Verify

- Tests: fillet an edge, then change an upstream dimension by 1 mm, 10 mm and
  100 mm, and assert the fillet is still on the same edge each time. That test
  should fail today on the 100 mm case.

### Done when

Version 1.6.0, and the reference-loss rate on a dimension sweep is measurably
lower than it is now. Record the before figure first.

---

## Batch 7, shipped in v2.0.0

Surfaces and the three dimensional sketch: two subsystems that share a reason,
both being geometry that is neither a closed solid nor a flat sketch. This is
the major version because it changes what a body is.

### The 3D sketch

- A sketch carries `is3d`, its points carry a `z`, and its curves are not
  required to be planar. The solver is skipped for one: every residual in
  `solver.js` is written in two variables per point, so running it would quietly
  flatten the third. A 3D sketch is reference geometry, deliberately.
- `findRegions` returns nothing for a 3D sketch. A loop that is not flat bounds
  no area, and pretending otherwise invents a profile that is not there.
- `sketchview.insertWorldCurves` is the one way curves get in without being
  flattened, and it is what sets `is3d`.
- **Include 3D Geometry**, **Intersection Curve**, **Project To Surface** and
  **Isoparametric Curve**, the four commands carried here from Batch 3.
  Intersection Curve reads the answer off the solid the two bodies share, using
  the provenance tagging from Batch 6, rather than working it out geometrically.

### Surfaces

- `src/renderer/sheet.js`, about a thousand lines, holds the lot: an open
  triangle mesh in the same shape a solid's mesh arrives in, so topology,
  display, picking and export work on one without knowing it is one.
- A body is now a tagged union. `meshOf(body)` and `isSheet(body)` in
  `features.js` are the only two things that need to know which is which;
  `pickBodies` filters to solids unless a feature asks otherwise, and
  `applyBoolean` will not touch a sheet.
- Create: Extrude, Revolve, Sweep, Loft, Patch, Ruled, Offset. All work off
  curves rather than closed profiles, so an open line is a valid input.
- Modify: Trim, Extend, Stitch, Unstitch, Reverse Normal, Thicken.
- Unlocked in the Solid tab: Boundary Fill, Replace Face, general Delete Face,
  and Split Face by a surface.
- `buildTopology` now returns rim edges, with `faceB === -1` and `boundary`
  true, plus `open` on the topology. Without them an open surface has nothing
  selectable to point Patch, Stitch, Extend or Trim at.

### What was learned building it

- **`_applyHighlights` painted every body the same grey**, which had been
  quietly flattening the analysis vertex colours too. Each body now carries its
  own base colour and highlight puts that back.
- **An offset has to mitre.** The average vertex normal lands short of both
  faces at a corner: a wall meant to be 2 thick came out 1.4. The point is
  solved for directly instead, as the one that is the offset distance clear of
  every face meeting there, which is a small least squares problem per vertex.
- **Ear clipping has to compare bridge points by position, not by index.**
  Bridging a hole leaves two copies of two vertices; compared by index they look
  like different points inside the ear, every ear is refused, and the fill
  degrades to a fan across the hole.
- **Stitching has to wind the mesh consistently** before the kernel sees it.
  Surfaces made separately have no reason to agree on which side is out.
- **`bodySpan` already existed** and took a list. A new one taking a body
  clobbered it silently and cost a debugging pass. Grep before naming.
- **An empty string splits to `['']`, which is cell zero.** Boundary Fill kept
  one cell out of two until that was filtered.

### Where it stops

Trim is mesh against mesh, so it is exact to the tessellation and no further. A
surface cuts a solid by being stretched past it and thickened by the span of the
model, so one that folds back on itself over that distance cannot divide a body,
and says so rather than producing a quiet mess. Patch fills a flat boundary
exactly and a boundary that is not flat with the simplest surface that meets it,
which is not curvature continuous. An isoparametric curve needs a surface with a
parameterisation, meaning one built here rather than a face lifted off a solid.

---

## Batch 8, shipped in v2.1.0

Sheet metal. The roadmap said to ask whether this was wanted before spending a
session on it; he said to start it, so it was built.

### What ships

`src/renderer/sheetmetal.js`, and a Sheet Metal tab. One rule per document
(thickness, bend radius, K factor, gap, bend relief, corner relief), Base
Flange, Flange, Contour Flange, Fold, Unfold, Refold, Rip, Corner Relief,
Convert To Sheet Metal, Flat Pattern, and DXF export of the flat.

### How it is modelled

A part is a tree of flat **panels** joined by **bends**. A panel is a contour in
its own frame with the material one thickness deep. A bend stores the line it
folds about in its parent's frame, and the child's frame is that parent's frame
rotated about the bend axis. Lay the child in the same plane instead, pushed out
by the bend allowance, and that is the flat.

So the folded part and the flat pattern are the same walk over the same tree,
differing only in what a bend does to its child. There is no second model to
keep in step. Unfold is the same thing again, per bend rather than for all of
them, which is why it costs nothing extra.

### What was learned building it

- **The handedness cost more than the geometry.** Which way a positive angle
  folds depends on whether the panel's frame is right handed, which is not
  something to reason about at three in the morning. The triad is now built
  once, the bend line is ordered when the bend is made so it always comes out
  right handed, and the two remaining signs are *measured at runtime*
  (`g.sense`, and the direction the bend section sweeps) rather than baked in.
  Every number was right on the first run after that.
- **Ids must come from the feature, never a counter.** The timeline replays from
  scratch, so a counter renames every panel on every rebuild and Unfold loses
  its grip the moment a dimension changes.
- **`[]` is truthy** bit again, in `chainPath`'s entity filter: an empty "which
  entities" list filtered every entity out and Contour Flange saw an empty
  sketch. That is the third time this shape of bug has appeared.
- **Counting a polygon's own corners is not a test of anything.** Fold refused
  every fold because a rectangle cut across the middle has two corners either
  side, and the check wanted three. The clip decides, not the count.

### Done when

Version 2.1.0, and a flat pattern exports as DXF that measures correctly. It
does: the DXF is read back by Anvil's own DXF reader in the test suite, and the
blank measures the legs plus the bend allowance to a hundredth.

---

## Batch 9, shipped in v2.2.0

The Mesh tab. `src/renderer/meshtools.js`, mesh readers in `meshutil.js`, and a
Mesh tab with Create, Prepare, Modify and Convert.

### What ships

Insert Mesh (STL binary and ASCII, OBJ, 3MF), Tessellate, Generate Face Groups,
Repair, Merge, Separate, Reduce, Remesh, Smooth, Plane Cut, Erase And Fill,
Reverse Normal, Texture Extrude, Convert Mesh, and Create Mesh Section Sketch on
the Sketch tab.

The real algorithms, not approximations of them: quadric error metric
decimation, Botsch and Kobbelt incremental remeshing with reprojection onto the
original surface, Taubin smoothing, and Ericson's closest-point-on-triangle
behind a uniform grid so the reprojection is not quadratic.

### The measurements that matter

- Reduce to a quarter of the triangles on a sphere costs 2.8 per cent of its
  volume; to six per cent of them it still measures 19.3 to 19.8 against 20.
- Remesh to an edge of 4 gives edges 2.4 to 5.2 and holds a sphere of 20 to
  within 0.06.
- A plane cut of a 40 box gives two capped halves of exactly 32000 each.
- Repair closes a box missing a face back to exactly 64000.

### What was learned building it

- **A record's `mesh` field already held its triangles.** Adding a boolean
  `mesh` flag to the same object replaced the geometry with `true` and the
  viewport threw on the next rebuild. Renamed to `isMesh`. Check what a name
  already means on an object before adding to it.
- **Collapsing an edge can leave an edge from a vertex to itself**, and
  collapsing one of those marks the surviving vertex dead. Decimation stalled at
  exactly the same triangle count whatever it was asked for.
- **Ear clipping cannot use a point that its own boundary runs straight
  through**, and a cut boundary is full of them: cut a box in half and the rim
  has a point wherever the cut crossed a face's diagonal. `fillLoops` in
  `sheet.js` now sets those aside, clips what is left, and puts each back by
  splitting the one fill triangle whose edge it lies on. Surfaces get this too.
- **Hole filling can create the fold it was meant to fix**, so the pass that
  takes the surplus off a non-manifold edge has to run after it as well as
  before.
- **A demo script is an async function body**, so `node --check` will not parse
  one. `new (Object.getPrototypeOf(async function(){}).constructor)(src)` will,
  and it catches the syntax errors that otherwise come back as "Script failed to
  execute" with no line number.

---

## Batch 10. Form, the sculpt workspace

He asked for it, and said it could take two sessions. **The first shipped in
v2.3.0.** The second is below and has not been started.

### Session one, shipped in v2.3.0

`src/renderer/form.js` and a Form tab. The control cage, Catmull-Clark with
creases, the six primitives, every topological operation, symmetry, the three
display modes, Finish Form and Thicken.

A form is one timeline entry whose cage lives in `doc.forms`, beside the
sketches and for the same reason: it is drawn rather than derived. The Form tab
commands change the cage in place, the way sketch tools change a sketch, rather
than adding a feature each.

**What it is measured against.** Creased hard all round, Catmull-Clark
reproduces the cage exactly, so a box of 20 stays 8000 at every level, to twelve
decimal places. Face counts are exactly four times per step. A quadball of 20
finishes at 33626 against a true sphere's 33510. Those are the checks worth
keeping: a subdivision surface has few exact answers and those are three of them.

**What was learned.**

- **Subdivision does not pass through its own cage.** A round primitive has to
  be fitted to its own limit surface or it comes out four fifths of the size
  that was asked for. `fitToLimit` builds it, measures the limit, and scales.
- **A cage face is one face only if the topology is told so.** Following smooth
  joins splits a curved quad in two and merges a flat cage into one. A cage mesh
  now tags each triangle with its cage face and sets `splitBySource`, which both
  skips the angle test and skips the flat-patch pass. Solids are untouched.
- **Mirror has to cut before it reflects.** Reflecting a cage whose faces
  straddle the plane doubles them instead of halving it: 40 faces where there
  should be 24. `splitCageByPlane` runs first.
- **A cage built by hand has no reason to wind consistently.** Every primitive
  goes through `orientCage`, or the kernel reads a negative volume and every
  normal in the viewport points inward.
- **The ribbon went to three rows** the moment the Modify group had twelve
  buttons, exactly as the cross-cutting note warns. Insert, Weld, Crease and
  Display are dropdown groups now.

### Session two, not started

**Edit Form**, which is the direct manipulation half and the reason the rest was
built first. Everything below is documented on Fusion's own Edit Form reference
page, which gives the option set verbatim:

- A **3D gizmo** on the selection: translate along an axis or in a plane, rotate
  about an axis, scale. Transform Mode picks which manipulators show: Multi,
  Translation, Rotation, Scale.
- **Coordinate Space**: World, View, Selection, Local Per Entity.
- **Selection Filter**: Vertex, Edge, Face, All, Body. Vertex picking does not
  exist anywhere in the app yet and will have to be built; face and edge picking
  already work on a cage.
- **Soft Modification**: Extent as a distance, a face count or a rectangular
  face count; Transition smooth, linear or bulge; a weight.
- **Selection helpers**: Grow and Shrink, Loop Grow and Shrink, Ring Grow and
  Shrink, Select Next, Invert, Range.
- **Live symmetry**: a drag on one half moves the other as it happens.
  `mirrorMoves` in `form.js` already does the arithmetic; nothing calls it yet.
- **Edit Form can also pull a new face out** of a selected one, which is how a
  limb is drawn out of a body and the single most used thing in the workspace.

The groundwork is all in place: cage picking works through the ordinary face and
edge selection, `doc.forms` holds the cage, and `editCage` in `app.js` is the
one place a change goes through.

### Done when

Version 2.4.0, and a face can be dragged out into a limb with the other half of
a mirrored body following it.

---

## Deliberately not planned

These are each their own application rather than a missing button, and the
README already says so. They are listed here so it is a decision on the record
rather than an omission.

| | Why not |
|---|---|
| Drawings | A drafting application. Weeks of work, and a slicer never sees a drawing. |
| CAM and toolpaths | A post-processor per machine, plus a simulation. He does not own a mill. |
| Simulation (FEA) | A solver and a mesher, each a project of its own. |
| Generative design | Needs a compute farm. |
| Render | Anvil renders flat with feature edges on purpose. A photoreal renderer is a different program. |
| PCB and Electronics | Unrelated to the reason this exists. |
| Cloud, hubs, collaboration | Anvil is offline on purpose. This is the point of it, not a gap in it. |

If he asks for any of these, say what it would actually cost before starting.

---

## Cross-cutting work, to fold into whichever batch touches it

- **Performance.** A thread is tens of thousands of triangles and a rebuild
  replays the whole timeline. There is no caching of unchanged prefixes yet.
  Worth doing when a rebuild first crosses a second on a real part.
- **The ribbon is nearly full.** Dropdown groups exist now (`RIBBON_MENUS` in
  `app.js`, a button with `data-menu`), and Primitive and Pattern use them.
  The Sketch tab uses them too, for the rectangle, circle, arc, polygon, slot
  and spline families. Group a new family as it lands rather than after, or the
  tab takes a third row. Widening `.group` past 648px does not help: it pushes
  the groups to its right off the window instead.
- **`plugins.js`-style regeneration does not apply here**, but the same lesson
  does: defaults belong in code, not in a file a tool rewrites.
- **The dark theme** is kept at `theme/style.dark.css`. It has not tracked the
  reskin. Either bring it forward or delete it; leaving it half-right is the
  worst of the three.
