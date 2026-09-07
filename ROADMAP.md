# Anvil roadmap

The goal is Fusion 360's feature set, worked through one batch at a time. This
file is the running plan. It is written for whoever picks the work up next,
which is usually a fresh agent with no memory of the last session.

**Read `README.md` first.** It documents what is already here and, importantly,
the places where Anvil deliberately falls short of Fusion. This file only covers
what is *not* built yet.

Current version: **2.24.1**. 516 tests.

**Everything on this roadmap has shipped.** Batches 11 to 20b, and all four
workspaces in Batch 21: Render, Animation, Simulation and Generative Design.

What is left is not on this list: it is whatever the next thing turns out to be.
The sections below are kept as the record of what was built and, more usefully,
of what was learned building it.

---

## Read this before writing another demo

Twelve versions of features went out on top of an extrude that did not work.
Not subtly: clicking the middle of a face selected nothing, so no arrow came up,
so there was nothing to pull. The demos were green the whole time.

They were green because they pressed things with `element.click()`, which
dispatches no pointer events, and because they read state back out of the app
rather than off the screen. Neither of those can see:

- **`pickEntity` returned any edge hit before it considered the face.** The ray
  carries on through the solid, so every edge on the far side of the part lies
  along it, and one of them always won. Fixed by finding the surface first and
  making an edge prove it is at least as near, within a few pixels of slack.
- **The arrow was a zero-length dot** after finishing a sketch, because the view
  was square on to the plane the arrow points out of. The turn that fixes that
  was happening at pointerdown, which also moved the target out from under the
  cursor. It now happens when the handle appears.
- **The value box outlived its feature.** Only the dialog's own OK and Cancel
  cleared it, so every other way out of a pull left it floating by the pointer
  for the rest of the session. It is now swept up wherever the handle is
  refreshed, which is every exit.

Three rules came out of that, and they cost a lot to learn:

1. **Anything that tests a gesture has to make the gesture.** Real
   `PointerEvent`s, at real screen coordinates, with `pointermove` in them.
2. **Measure what is on screen, not what is in state.** "There is a handle" and
   "there is an arrow you can aim at" are different claims, and only the second
   one is the feature.
3. **Test the ways out, not only the way through.** Escape, clicking away, and
   changing your mind are most of what a person does.

`tools/demo-pull.js` is written that way and covers all three failures.

**And then a fourth, found the same way and only because he tried it.** The
ribbon's Extrude was a dead end. It opens with a distance of zero, on purpose,
and it opens asking to be pointed at. Point at a profile and that was as far as
it went: the callout said "1 chosen", the dialog held a zero, and nothing on
screen would change it. The arrow was suppressed while any dialog was open, and
the value box only exists during a drag, so there was no drag to have one.

Three fixes, and the second and third only exist because the first was made:

- **The dialog gets the arrow.** `editingPullTarget()` stands one on whatever
  the open extrude is working from, and the drag writes into that feature rather
  than making a new one.
- **A press on the arrow that never moves is a click on what is under it.**
  Without that the arrow the first click puts up covers the profile, and it can
  be chosen but never let go of.
- **`commitEdit` never called `syncPickBar`.** Cancel took the callout down and
  OK did not, so accepting an extrude left "EXTRUDE, click the profiles to use"
  floating by the pointer, with no dialog behind it, for the rest of the session.

`tools/demo-extrude.js` covers all of it, from an empty document.

**And then it still was not there**, because the arrow was under the callout.
The callout follows the pointer, and the pointer is exactly where the arrow has
just stood up. It passes clicks through, so the arrow was grabbable the whole
time, which made it worse rather than better: nothing on screen said there was
anything to grab. It now takes the first position round the cursor that clears
the arrow's span, and `refreshPullHandle` tells it to move the moment the arrow
appears rather than at the next mouse move. The demo measures the two rectangles
and asserts they do not overlap.

The same screenshot showed the second half of it: "Extrude has nothing to work
from" under **Problems** in the browser, a red mark beside it, and "1 problem"
in the corner, all from pressing the button. A new feature's dialog that has not
been given its number yet is not a failure, and `visibleErrors()` keeps those
out of the browser, the timeline and the corner. They stay in the dialog's own
footer. An existing feature edited into a state that will not build is a real
problem and still reads as one.

That is the same lesson a third time: **look at the screen, not at the state.**
Every one of these was invisible to a check that asks the app how it is doing.

A fourth rule, then, and it is the one that would have caught all four:
**walk the path a person walks on the day they open it.** Every demo before
these started from a box that was already there. Nobody starts from a box.

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
- The name check applies to methods on a class as much as to fields on an
  object. A second `worldToScreen` with a different signature won silently and
  returned NaN from every call.
- Anything meant to be grabbed needs to be thick enough to hit. Drawing it
  correctly is a different question from being able to pick it.

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
v2.3.0 and the second in v2.4.0.**

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

### Session two, shipped in v2.4.0

**Edit Form**, the direct manipulation half.

- A manipulator on the selection: three arrows to drag along, three squares to
  drag in, three rings to turn about, three cubes to scale by and one to scale
  everything. Transform Mode narrows it to Multi, Translation, Rotation or
  Scale.
- Coordinate Space: World, View, Selection, and Local Per Entity, which moves
  each point along its own normal.
- Selection Filter: Vertex, Edge, Face, All and Body. Vertex picking is new to
  the whole app: cage points are drawn as marks of their own and hit tested in
  screen space, because a click cannot land on a point any other way.
- Soft Modification: extent by distance or by face count, transition smooth,
  linear or bulge, and a weight.
- Grow, Shrink, Loop, Ring, Invert and Select All.
- Live symmetry: a drag on one half moves the other as it happens.
- Pull, which lifts the picked faces and hands them back as the selection.

A whole drag is one undo entry: the cage as it stood before the press.

### What was learned

- **`worldToScreen` already existed**, taking three numbers rather than a point
  and returning `clientX`/`clientY` rather than `x`/`y`. Adding a second one
  later in the same class silently won, and every projection came back NaN. This
  is the same mistake as Batch 9's `mesh` field, one level up: check what a name
  already means on a class, not just on an object.
- **A sign in the closest-approach formula** dragged everything backwards. The
  vector between the two origins runs from the line to the ray. Measured by
  dragging up and reading the number, which is the only way that kind of error
  shows itself.
- **A handle a pixel thick is not a handle.** The shafts and rings drew
  correctly and could not be grabbed at all. Thickness for picking is a separate
  question from thickness for drawing.
- **A demo that selects everything and then tests Grow** proves nothing. Reset
  the state between what is being demonstrated.

### Done when

Version 2.4.0, and a face can be dragged out into a limb with the other half of
a mirrored body following it. **Both are done**: the driven demo pulls a face
out of a box and drags it 18 mm into a limb, and drags one point of a mirrored
quadball while checking its twin moves by the same amount.

---

## After the batches, shipped in v2.5.0

The five gaps the batches left, done in one pass.

**Chord length and hold line fillets.** A chord asks how wide the blend reads
across and lets the radius fall out of the angle each edge sits at, which is
R = chord / 2 sin(half the dihedral). A hold line asks for the edge the blend
has to run out on and takes the radius from the distance to it. Both want a
radius per edge rather than one for the set, so `buildEdgeTools` takes a
`sizeFor` and the ball that fills a vertex takes the smallest of the edges
meeting there.

**A sheet metal rule library.** A document keeps named rules and one of them is
active. A feature can name a rule of its own, so a bracket in aluminium and its
steel mount are one document. A part records the rule it was built to, so a
later feature cuts at the thickness that part actually has, which was a latent
bug the moment a second rule could exist.

**Miter.** Two flanges off adjoining edges do not overlap. Each stands outside
its own edge, so what they leave between them is a notch the width of the
material: the miter runs both into it and then cuts them on the bisector. The
cut is square through the thickness, because the blank is cut flat.

**Three bend corner relief.** Three bends never pass through one point. The
third belongs to a flange that has been folded away, so what ties it to the
corner is the tree rather than the geometry.

**Rebuild caching.** Every feature gets a key covering itself and everything
outside it that it reads. The run starts again at the first key that differs.

**Face groups by hand.** A triangle carrying a label belongs to that group and
to nothing else, whatever the angle says. Everything left unlabelled is worked
out the usual way, so pinning one face does not throw the rest away.

### What was learned

- **A miter is a fill, not a trim.** The whole thing was written as a trim
  first, on the assumption that two flanges at a corner overlap. They do not.
  Probing the actual panel frames rather than reasoning about them is what
  turned that up, and the same probe gave the closed form the test now checks.
- **A square cut through the thickness has to be measured from the far face.**
  With the gap measured on the contour's own plane the two flanges cleared at
  one face and bit into each other at the other, which is invisible in a volume
  and obvious the moment the numbers are written out by hand.
- **Three bends meeting is a fact about the tree, not about the geometry.** The
  first version looked for three lines through a point and found none, ever.
- **A feature is brought up to date as it is built.** A fillet written before it
  had sets grows them the first time it runs, so a cache key taken before the
  run never matches the one taken after. The key is worked out at the
  checkpoint, which is the only place it is true.
- **`faceReference` puts the name under `src`**, not at the top level. A test
  that asserted the wrong shape passed nothing useful until it was read.

---

## Direct manipulation, shipped in v2.6.0

He said it plainly: "Why can't I just click the face I want to extrude and then
drag it? Why does the crosshair not have the length I am dragging it, or how
much I am typing? I shouldn't have to click extra stuff to do something
obvious." All three were fair.

- A single planar face or a single sketch profile grows a pull arrow. Dragging
  it drives the real feature, not a preview, so what is on screen while pulling
  is what lands.
- The distance follows the cursor in the same box the sketcher already used for
  typed sizes while drawing. It was only ever wired up in two dimensions.
- Let go and the box keeps focus, so the exact number goes straight over the
  dragged one.

### What was learned

- **The sketcher had already solved this**, and only for sketching. Typed
  dimension boxes that track the cursor have been in `sketchview.js` since the
  sketch work; nothing in three dimensions had them. Look for the answer in the
  part of the application that already faced the question.
- **A demo that calls `element.click()` is not a demo of clicking.** It sends a
  click and no pointer events, which is a path no mouse can take. Every menu in
  the application was dead and twenty demos driving the real interface all
  agreed it was fine.
- **`openFeatureEditor` turns the camera** to show the depth of a new feature.
  Right when a dialog opens, wrong when a drag is in hand, because it moves the
  thing being aimed at out from under the pointer. Right again at the moment of
  the press, before anything has moved, which is where it ended up.
- **An extrude has no negative length.** It is a length one way and a `flip`
  that turns it round; `direction` is one / two / symmetric. Inventing
  `side1`/`side2` gave two values that both fell through to the same branch, so
  it could only ever be dragged outward, which is exactly what he reported.
- **Where the pointer's ray comes nearest the axis is the wrong measure** for a
  handle. It is exact, and it runs away to infinity as the axis turns to face
  the camera. Measuring along the axis as it appears on screen has no such
  singularity.
- **A rebuild takes the handle away**, so the drag has to be recorded before the
  dialog that rebuilds is opened, or the arrow vanishes under the pointer that
  just grabbed it.
- **Undo restored the document and not the interface around it.** A sketch is
  hidden when something is built on it; undoing that something left it hidden,
  so its profiles could not be clicked again. Anything derived from the document
  but stored beside it has to be re-derived when the document goes back.

---

## The restyle, first pass, shipped in v2.7.0

He said it looked like it was developed on Windows 95, and he was right. What
was actually doing it, in order of how much each mattered:

1. **Arial.** `--font` asked for Helvetica first, which on Windows resolves to
   Arial. Asking for the system text face instead is the single largest change
   in the whole pass and it is one line.
2. **A border round every control.** Buttons were filled and outlined at 1px
   with square corners. They are quiet until hovered now.
3. **One grey everywhere**, model included: the body was within a shade of the
   ground it stood on. Surfaces step now, the ground is cooler than the chrome
   and carries a gradient, and the body is the one warm thing on screen.
4. **No elevation.** Menus and callouts were hairline boxes, so they read as
   part of the page rather than in front of it.
5. **No type hierarchy.** Group labels were barely legible; tabs, labels and
   headings now have weights that separate them.

Chrome grew eighteen pixels in the first cut and six were given back. The rest
buys real comfort in the top bar, and the ribbon is a row shorter than it was.

### Still to do on the look

- **The icons.** Sixty-odd Unicode glyphs of wildly different weights and
  widths, which is the largest remaining thing that dates it. They are
  normalised to one size and colour now, which helps and is not the answer. A
  real drawn set is its own piece of work and wants his eye on it.
- **Dark mode.** `theme/style.dark.css` still has not tracked any of this.
- **Discoverability**, which he put third: hover previews, a command search,
  better empty states.

---

## The rehaul, shipped in v2.8.0

The first pass repainted and he said, correctly, that it looked like nothing had
changed. The paint was not the problem: thirty labelled buttons in two rows is
the shape of a toolbar from the nineties, and no palette fixes a shape. He
pointed at Fusion's dark UI and named what he wanted from it.

- **Dark**, with the chrome lighter than the viewport. The first dark cut had
  that the wrong way round and read as a black bar on a grey window.
- **One toolbar row.** Each group is its most used commands as bare icons with
  the group name beneath, and the name opens the rest. Ribbon went from about
  250 pixels to 69.
- **Ctrl K searches every command**, which is what makes folding them away
  affordable rather than merely tidier.
- **The browser floats** over the model instead of walling a column off it.
- **The view cube shades the corner you are looking from.**

`theme/style.dark.css` is gone. It had not tracked the reskin for three
versions, and half a theme is worse than none.

### What was learned

- **An unclosed block comment is silent.** `/*` with no `*/` at the top of the
  stylesheet swallowed the whole `:root` block; the file still parsed, most
  rules still applied, and the only symptom was that every custom property
  resolved to nothing. Two screenshots went by before it was measured rather
  than looked at. `getComputedStyle` said it in one run.
- **Repainting is not redesigning.** Told the look was dated, the cheap reading
  is the palette. The expensive and correct one is the layout.
- **A facet on a corner where three faces meet cannot be depth tested.** It is
  a coin toss per pixel. Draw it over the top with a render order.

### Still to do on the look

- **The icons.** Sixty-odd Unicode glyphs of very different weights, which is
  now the largest remaining thing that dates it. A drawn set is its own piece
  of work and wants his eye on the direction first.
- **Discoverability**, which he ranked third: hover previews, better empty
  states, and putting the shortcut for a command on its row in search.

---

## Everything missing, in one list

Compiled 2026-09-06 from the audit against Fusion's own help, from the README's
own account of where each tool stops, and from what the measurements turned up
along the way. Kept in one place so it can be read straight through rather than
reassembled from six sections. Every line is either something Fusion does that
this does not, or something this does less well than it should.

### 1. Import, which he ranked first

| | State |
|---|---|
| STEP: planes, cylinders, cones, spheres, tori | **shipped v2.10.0** |
| STEP: B-spline surfaces and trimmed curves | missing, and the larger half of a real file |
| STEP: assembly structure, per body colour, units from the header | missing |
| 3MF: colour, materials, build hierarchy | read and thrown away today |
| OBJ: groups and materials as face groups | read and thrown away today |
| f3d | no public specification; look inside one before promising anything |
| Decimation that keeps its faces | 20 percent of the triangles turns 33 faces into 163 |
| Convert Mesh keeping its faces | 33 in, 19 out |
| Refitting analytic surfaces on a mesh | a facetted bore should become a true cylinder |
| Recognise: acting on what it found | it selects holes and fillets; it cannot yet change them |
| Recognise: blend shells | fillets that run together are one surface and stay one |

### 2. Fusion commands that are simply absent

Every panel walked, 2026-09-06. The count went 17, then 29, then **66**, because
the first pass had opened eight of Fusion's panels and the second twelve. This
is the pass where every panel was opened.

**Solid, Create** (4)
Boss, Snap Fit, Rest, Lip. All four are plastic part features.

**Sketch, Create** (2)
3-Point Circle. Spun Profile. Every other family matches: three rectangles,
three arcs, three polygons, five slots, two splines, conic, ellipse, point,
text, mirror, both patterns, and six of Fusion's seven project and include
tools.

**Sketch, Constraints** (2)
Collinear. Curvature, which is the G2 constraint.

**Sketch, Modify** (1)
Blend Curve.

**Surface, Modify** (2)
Untrim. Merge.

**Mesh** (6)
Direct Edit, Stitch, Patch, Physical Material, Appearance, Compute All.

**Sheet Metal** (3)
Hem. Lofted Flange. A flat pattern as a tracked derived body that knows when it
is out of date and can be updated, rather than a body made once.

**Construct** (4)
Perpendicular Plane, Plane Through Two Edges, Point Through Two Edges, User
Coordinate System.

**Inspect** (2)
Isocurve Analysis. Design Advice.

**Assemble** (3)
As-Built Joint. Joint Origin. Constrain Components, which is Fusion's older
constraint based positioning kept alongside joints.

**Insert** (4)
Insert Component from a file. Insert Derive. Decal. Canvas.

**Make** (1)
3D Print. Here that is Export STL with no send to a slicer.

**Form, Create** (6)
Extrude, Revolve, Sweep and Loft, which in the Form environment build a T-Spline
body from sketch geometry rather than a solid. Two primitives: Pipe and Face.

**Form, Modify** (12)
Edit By Curve, Merge Edge, Erase and Fill, Bevel Edge, Slide Edge, Smooth,
Cylindrify, Straighten, Match, Interpolate, Freeze, Unfreeze. Of Fusion's
twenty five Form Modify tools, thirteen are here.

**Form, Utilities** (1)
Repair Body.

**Select** (13)
The whole panel, which barely exists here. Selection modes: Window, Freeform,
Paint, Adjacent Faces. Selection tools: Select By Name, Select By Boundary,
Select By Size, Invert Selection, Seed And Boundary. Priority filters for body,
face, edge and component. Isolate and Unisolate. This application has All Edges
and Show All, and picking filters that dialogs set for themselves.

Library or cloud backed rather than geometry, so they belong with the cloud work
below: Insert Fastener, McMaster-Carr, manufacturer parts, TraceParts, Fastener
Stack, Display Component Colors, Display Mesh Face Groups, Find Similar
Components, Select All Occurrences, Select Similar Occurrences, Show All
Components, Enable Better Performance.

**Where the sixty six sit**, largest first: Select 13, Form Modify 12, Mesh 6,
Form Create 6, Solid Create 4, Construct 4, Insert 4, Assemble 3, Sheet Metal 3,
Sketch Create 2, Sketch Constraints 2, Surface Modify 2, Inspect 2, Sketch
Modify 1, Form Utilities 1, Make 1.

### 3. Where this application's own tools stop

Not absences so much as edges, and each one is a decision that could be revisited.

- **Patterns.** Fusion's compute options for a pattern that lands on different
  geometry at each instance.
- **Silhouette Split** works only where the parting line is flat.
- **Form.** Circular symmetry is remembered but a drag is not mirrored round it;
  only mirror symmetry follows live. No range selection, no Select Next. Pull
  is its own button rather than a key held during a drag.
- **Sheet metal.** A converted body has no panel tree until it is given one, so
  it cannot be laid flat straight away.
- **Rebuild cache.** A change to a parameter, a base body, the sheet metal
  rules, the component list or a body's name invalidates the whole run. Correct
  and conservative; finer grain would need to know which feature reads what.
- **Surfaces.** A surface that folds back on itself cannot divide a body.
  Isoparametric curves need a surface built here rather than a face lifted off a
  solid. Patch fills a non-flat boundary with the simplest surface that meets
  it, not a curvature-continuous one.
- **Text** is traced from a raster rather than read out of the font's own
  curves. Right for a printed part, wrong for typography.
- **Joint contact** stops the parts where they meet along the one degree of
  freedom being driven. A walk, not a simulation: it will not find a collision
  that happens partway through some other joint's travel.
- **Linked projection** keeps the kind of a line and of a circle; anything else
  arrives as a polyline.
- **Threads** are real geometry and cost real triangles, which is the point for
  a printed part and is why Fusion leaves them cosmetic.

### 4. The interface

- **Icons.** Sixty-odd Unicode glyphs of very different weights. The largest
  remaining thing that dates the look, and a drawn set wants his eye on the
  direction first.
- **Discoverability**, which he ranked third of three: hover previews, better
  empty states, and the keyboard shortcut for a command shown on its row in
  search.

### 5. Workspaces he ruled in

Each a project rather than a batch.

| | What it needs |
|---|---|
| **Render** | Materials, lighting, and a photoreal path separate from the flat viewport shading, which stays. |
| **Animation** | Exploded views and assembly motion. The assembly solver and joint limits already exist, so what is missing is the timeline and the exploding, not the kinematics. |
| **Simulation** | A mesher and an FEA solver. Cost it in front of him before starting. |
| **Generative design** | Fusion uses a compute farm. On one machine this has to be a smaller thing honestly named: a shape optimiser on a coarse voxel field. Cost it before starting. |

### 6. Hubs, data management and the cloud

This was one dismissive paragraph until he asked where the hubs were, and the
paragraph was wrong as well as thin. Lumping everything Fusion delivers over a
network into "not for us" hid several features that need no network at all.
Three buckets, and only the first is genuinely out.

**6z. A synced folder is the hub.** His idea, and better than anything that was
on this list. Google Drive, or any folder that syncs, already provides storage,
sync across machines, file version history, sharing by link and permissions.
Those are the expensive parts of a hub and they are done. What it does not give
is a comment pinned to a face, a merge of two edits, or a viewer for a file
nobody else has the application for.

What it needs from this end is safety, not features, because a folder that
syncs turns rare failures into likely ones:

- **Atomic writes. Done in v2.10.1.** Saving wrote the document in place, so a
  crash halfway left it truncated and a sync client could upload a half written
  file. It writes beside and renames now, which either happens or does not.
- **Noticing a change made elsewhere. Done in v2.10.1.** The same file edited on
  another machine and pulled down while it sat open here used to be overwritten
  in silence. Saving over it is now a choice with Save a copy offered.
- **Still to do:** exporting a viewable form beside the document so a share link
  opens for someone without Anvil, and a lock file so two machines editing at
  once is noticed at the start rather than at the save.

**6a. Needs a server. Out, and not a judgement call.**

Hubs. Joining a hub by invitation or approval. Projects as shared spaces.
Project and folder permissions. Cloud storage. The Data Panel. Sharing a design
by link. Public links and viewer access. Collaborating with teammates on one
design. Comment threads between people, replies and mentions. The Fusion web
client. The mobile client. Fusion Manage and PLM. Cloud rendering, cloud
simulation and generative compute. Component libraries served from a supplier:
McMaster-Carr, TraceParts, manufacturer parts, Insert Fastener.

Anvil is offline on purpose. None of this is a gap in it.

**6b. Fusion delivers these through the cloud. The capability itself is local,
and these were filed wrongly.**

- **Configurations** is not a cloud feature at all. It is a Configuration Table
  driving parametric variants of one design, and every part of it runs on one
  machine. Eleven configurable aspects: Parameters, Part Number, Description,
  Features, Visibility, Suppression, Physical Material, Appearance, Sheet Metal
  Rules, Plastic Rules, Custom. Around fourteen table operations: add, activate,
  rename, duplicate, delete, edit, sort by row and column, move rows and
  columns, add parameters and aspects, and theme tables. **This is a real
  modelling feature, it is missing, and it is reachable**: parameters, feature
  suppression and a timeline already exist here, so a configuration is a named
  set of overrides on things the document already has.
- **Version history.** Fusion keeps every version of a design with a name and a
  reason. Anvil has undo within a session and a file on disk. Named, restorable
  versions are a local feature.
- **Branch and merge** a design and reconcile the two. Local in principle and
  the hardest thing in this bucket.
- **Comments and markup on your own model**: a note pinned to a face or a
  point, markers shown or hidden, a snapshot of the feedback. Useful alone, not
  only in a team.
- **A project as a folder of related documents**, with links between them that
  survive a move. Insert Derive, already on the command list, is the same idea.
- **Part Number and Description** as document properties. Small, and
  Configurations needs them.

**6c. Already here.** Undo and redo with named steps, the timeline, parameters,
and physical materials on a body.

## Where the work goes next, decided 2026-09-06

He audited Anvil against Fusion's own help and ruled on the workspaces. Three
stay out. Four come in. And he named the thing he wants that Fusion does badly.

### Still deliberately not planned

| | Why not |
|---|---|
| Drawings | A drafting application. Weeks of work, and a slicer never sees a drawing. |
| CAM and toolpaths | A post-processor per machine, plus a simulation. He does not own a mill. |
| PCB and Electronics | Unrelated to the reason this exists. |
| Cloud, hubs, collaboration | Anvil is offline on purpose. This is the point of it, not a gap in it. He has not asked for it; do not start it on a guess. |

### Now in scope, on his instruction

- **Render.** Not the flat shading with feature edges that the viewport draws on
  purpose, which stays. A separate photoreal path: materials, lighting, and an
  image you can show someone.
- **Animation.** Exploded views and assembly motion. The assembly solver and the
  joint limits already exist, so what is missing is the timeline and the
  exploding, not the kinematics.
- **Simulation.** FEA. A mesher and a solver, each a project of its own. Say
  what it costs before starting it.
- **Generative design.** Fusion needs a compute farm for this. On one machine it
  has to be a smaller thing honestly named: a shape optimiser on a coarse voxel
  field, not a cloud farm in miniature.

### Import, which is the one he called out

> "Fusion 360 can only import the mesh, I think we can do much much better."

He is right about the gap and right that this is where Anvil has an unfair
advantage. Fusion's kernel is a boundary representation, so a mesh arriving
from outside is a second class object it has to convert before it can do
anything real with it. **Anvil's kernel is already a mesh kernel.** An imported
mesh is not a foreign body here; it is the same kind of thing every feature
already operates on.

So the goal is not "read more file formats". It is: **an imported model should
arrive as something you can edit, not as a bag of triangles.**

1. **Recognise features on any body, imported or not.** The topology already
   finds planar faces and fits cylinders. Build on that to find holes with an
   axis, a diameter, a depth and whether they go through; constant radius
   fillets; and the flats worth calling faces. Then let them be acted on:
   change every 5 mm hole to 5.2, take a fillet off, fill a bore. That is the
   thing Fusion cannot do to an imported mesh, and it is reachable from where
   the code already is.
2. **Then read the formats that carry more than triangles.** 3MF already
   carries colour and an assembly tree that is currently thrown away. STEP is
   the real prize and the real cost: a parser plus surface evaluation for
   planes, cylinders, cones, tori and B-splines. Do not start it until the
   recognition work above has proved itself, because recognition is what makes
   an imported body useful whatever it arrived as.

Order: recognition first, because it pays off on every body in the application
rather than only on newly imported ones.

### Recognition, first slice, shipped in v2.9.0

`src/renderer/recognise.js`, and a **Recognise** command on the Mesh tab. Holes
with a diameter, an axis, a depth and through or blind; fillets with a radius
and a length; both grouped by size, and each group selects what it names.
Measured on a plate of four bores in two sizes, and again on the same plate
after an STL round trip, where it reads identically.

**It found a real bug in `fitCylinder` on the way.** The centre of a fitted
cylinder was the average of the face's points. That lands on the axis only for a
face that goes all the way round, so bores fitted and fillets did not: a fillet
is a quarter of a cylinder and its average sits out on the surface. Every fillet
in the application had been coming back as an unrecognised curve. It is an
algebraic circle fit now, which does not care how much of the arc it is given.

### The import plan, decided 2026-09-06

He asked for f3d, 3mf, step, obj and stl, and to be able to edit what comes in.
Measured first, because the complaint was about Fusion and it was worth knowing
whether Anvil shares it. A drilled, filleted plate, 7,584 triangles and 33
faces, imported as STL and converted:

| | triangles | faces |
|---|---|---|
| modelled here | 7,584 | 33 |
| imported as STL | 7,584 | 33 |
| after Convert Mesh | 5,948 | 19 |

**Anvil cannot have Fusion's problem.** Fusion turns a mesh into a boundary
representation and needs a face per triangle, which is where the assload comes
from. This kernel is a mesh kernel, so converting hands it the triangles it
already had, and the count went down. A mesh can also be cut against a solid
directly, without converting at all: measured, it works.

What the numbers did show is two problems of our own. Converting loses faces,
33 down to 19, so there is less to point at afterwards than before. And
decimating destroys them: 20 percent of the triangles gives 163 faces instead
of 33, because every flat is chipped into fragments. Lighter currently means
less editable, which is the same complaint one level down.

So the order is by what makes an import editable, not by file format count.

**Batch 11. STEP. Slices 1 and 2 shipped in v2.10.0**, which is the parser and
every analytic surface. B-splines and assemblies remain.

The one that changes the answer. A STEP file carries real
surfaces, so a bracket arrives as six flats and two bores rather than as
thousands of facets, and it is editable because it was never triangles.
1. Part 21 parser: tokeniser, entity graph, forward references. Self contained
   and testable on its own.
2. Geometry: planes first, then cylinders, cones, spheres, tori. Faces with
   bounds, tessellated into the kernel at a chosen tolerance.
3. B-spline surfaces and trimmed curves.
4. Assembly structure and colour.

**Batch 12. The formats that already half work.**
- 3MF carries colour, materials and a build hierarchy, all of which is thrown
  away today. Read it into components and body colours.
- OBJ carries groups and materials; make them face groups on arrival.
- STL stays what it is, one lump of triangles, and that is honest.
- **f3d is a Fusion archive with no public specification.** Investigate what is
  actually inside one before promising anything. If it is a container we cannot
  read, say so plainly rather than half read it.

**Batch 13. Editable after import.**
- Decimation that keeps its faces: preserve flats and feature edges while
  collapsing, so lighter does not mean unselectable.
- Drop the conversion step where it is only ceremony.
- Refit analytic surfaces on a mesh: turn a facetted bore back into a true
  cylinder. This is what makes an STL editable rather than merely usable, and
  it is where the recognition work already points.

### The Fusion gaps, as batches

The old plan here said "Batch 14, the commands" and listed seventeen. Walking
every panel found sixty six, so one batch was never the right shape. Ordered by
what is felt soonest per hour spent, not by where things sit in the menus.

**Batch 14. Select. Shipped in v2.11.0.** Box selection both ways, by size,
seed and boundary, tangent run, similar, grow, shrink, invert, priority
filters, isolate. What is still missing from the panel: freeform lasso, paint,
and select by name.

Thirteen commands, and the highest value block on the
whole list. Window, freeform and paint dragging; select by name, by size, by
boundary; seed and boundary; invert; priority filters for body, face, edge and
component; isolate and unisolate. On a fifty thousand triangle import, "select
every face under two square millimetres" is the difference between a model you
can work on and one you cannot. It also makes every other batch cheaper,
because every one of them begins by choosing something.

**Batch 15. Form Modify. Shipped in v2.14.0.** All twelve sculpting verbs, under
a Shape menu on the Form tab: Smooth, Straighten, Cylindrify, Slide Edge, Bevel
Edge, Erase And Fill, Merge Edge, Match, Edit Form By Curve, Freeze, Unfreeze,
Interpolate.

Two of them are worth knowing about before touching this code again. A bevel on
a control cage is more edges, not a cut face: one edge smooths away and two
close together hold a shape, so Bevel Edge inserts loops either side rather than
doing surgery. And Interpolate is a corner weight rather than a flag of its own,
because Catmull-Clark already has a way to say "pass exactly through this
point", and a second mechanism would be one more thing to keep in step.

Freezing is enforced in `softWeights`, which every drag goes through, rather
than in each command. That is why a frozen point survives a drag, a smooth and a
match alike.

The thirteen that were already here are the topological verbs: insert edge,
subdivide, weld, crease, bridge.

**Batch 16. Form Create. Shipped in v2.15.0.** All six, under a From Curves menu
on the Form tab: Extrude, Revolve, Sweep, Loft, Pipe and Face. They all come out
of one `gridCage`, because a run of control points carried along, turned about,
swept or lofted is a grid and the only thing that changes is how the rows were
made.

The thing to know before touching this again is the resampling rule, which is
not the same for all three kinds of input. A profile is only cut down, never
filled in: a square asked for eight points comes back with a point in the middle
of each side and a cage that rounds off corners the sketch drew square. A path is
resampled either way, because the row count was asked for. A loft resamples every
section to one count, because sections drawn at different times are never divided
alike.

Six. Extrude, Revolve, Sweep and Loft in the Form
environment, building a T-Spline rather than a solid, plus the Pipe and Face
primitives. The solid versions already exist, so this is the same intent
against a different output.

**Batch 17. Mesh. Shipped in v2.16.0.** All six. Stitch and Patch are the two
halves of Repair split apart, which is worth doing because the weld tolerance is
a real decision and hole filling is wrong as often as it is right. Direct Edit
moves part of a mesh with a falloff, which is what keeps the surface continuous
instead of tearing at the edge of what moved.

Material and Appearance are deliberately two commands over two separate stores.
A colour must never change a mass. Both live on the document rather than in the
timeline: rolling back past a material should not turn a steel bracket into a
plastic one.

Compute All drops the rebuild cache and replays everything. Anvil rebuilds
eagerly, so this is not the everyday command it is in Fusion; it is the answer
to "is the cache lying to me", which otherwise looks exactly like a modelling
mistake.

**Batch 18. The geometry singles.** Fifteen, all small and unrelated to each
other. **Three of the four Construct ones shipped in v2.11.0**: a plane square
across an axis, a plane through two edges, and the point where two edges meet.
Skew edges are refused rather than averaged into a plane that is a lie.

**Most of the rest shipped in v2.12.0**: Sketch 3-Point Circle, Collinear and
Blend Curve; Surface Untrim and Merge; Inspect Design Advice; Make 3D Print,
which writes a 3MF and hands it to the slicer rather than exporting into a
folder to be found later.

**The rest shipped in v2.13.0**: the **User Coordinate System**, which is one
entry that registers seven referenceable things; **Spun Profile**, measured
against the material with rays rather than against the corners; and Form
**Repair Body**.

Two on the original list turned out to be there already and had been miscounted
against the source rather than checked in it: sketch **Curvature** is the
curvature comb under Analyse, and **Isocurve Analysis** is the Isoparametric
Curve command, which extracts the curves rather than shading them over the
surface.

**Batch 18 is done.**

**Batch 19. Plastic parts. Shipped in v2.17.0.** All four, under a Plastic menu:
Boss, Rest, Snap Fit, Lip. One command over four sets of numbers, because they
share everything awkward: finding the face, standing something square on it, and
placing it. The shapes themselves are in `plastic.js` as plain outlines with no
kernel in sight, which is what lets a lead-in angle be checked against a number
rather than against a picture.

Two things caught here that would catch anyone again. A boss rib is drawn flat
and tipped up with a quarter turn about X; tipping it by swapping two axes
instead adds exactly the same volume and lays every rib on its side, so the
volume test passed and the model was wrong. And a snap catch has to run into the
material rather than out of it, or cutting it from the face the hook stands on
removes nothing at all.

**Batch 20. Assembly and insertion.** Nine, not ten: **As-Built Joint is already
built** and was counted against Fusion's page rather than checked in the source.
Checked in the source on 2026-09-07, the real list is:

Assemble: Joint Origin as a command of its own (the capture function exists and
is used by the joint picker, but there is no way to place one and reference it
later), Constrain Components. Insert: Insert Component from a file, Insert
Derive, Decal, Canvas. Sheet Metal: Hem, Lofted Flange, and a flat pattern that
tracks whether it is out of date.

**Five shipped in v2.18.0**: sheet metal Hem and Lofted Flange, the flat pattern
that knows its exported DXF is behind the model, Joint Origin, and Constrain
Components.

Two things worth knowing. `sections` is taken as a field name by Loft, where it
holds a list of profiles, and a second feature using it for a count crashes the
whole rebuild rather than its own feature; the lofted flange calls it `around`.
And a bend shows on a flat pattern as two lines, not one: a bend takes up a
width of flat and what is marked is where it starts and where it stops. A single
line down the middle is the commonest way a flat pattern gets folded in the
wrong place.

**The other four shipped in v2.19.0**: Insert Component, Insert Derive with a
Refresh, Canvas and Decal. **Batch 20 is done.**

Three things worth knowing. A document read for insertion is never made current,
never locked and never saved to, which is a separate IPC from opening one and
has to stay separate. Derived parts refresh when told, not when watched: a part
that changes shape under somebody's hands is worse than one that is a day old.
And the decal really clips the triangles it lands on, in the image's own flat
frame, rather than keeping or dropping them whole; the clipped corners carry
barycentric weights so they can be lifted back onto the surface.

**Batch 20b. Configurations and document history. Shipped in v2.20.0.** The
configuration table, named versions, document properties, and notes pinned to
geometry.

Seven kinds of column rather than Fusion's eleven, and the difference is
deliberate: each kind here names the one place the value already lives, and the
four not built are ones where Anvil has no second place to point at. Parameter,
feature suppression, body visibility, colour, material, sheet metal rule, joint
position.

The two rules that hold the whole thing up. A blank cell means "as drawn", not
zero, so a row can be silent about a column. And the document is never written
to when a row is applied: an in-place edit would mean switching back to the
first row no longer gave the first part. Suppression works both ways, because a
variant needs to be able to be the one that has the hole as well as the one that
has not.

Notes are not in the timeline on purpose. Rolling back past a remark would be a
strange thing for it to do.

**Batch 21. The workspaces he ruled in.** Render and Animation **shipped in
v2.21.0**. Simulation and Generative Design have not, and are not to be started
without costing them in front of him first.

Render is accumulation rather than ray tracing: many passes with the camera
jittered a fraction of a pixel and the lights jittered a little, averaged. That
gives antialiasing past what the hardware does and soft shadows for nothing. The
scatter is repeatable on purpose, so two renders of an unchanged model are
identical and a change can be seen.

Animation is display-only. A step is a transform laid over a body, never an edit
to the assembly, so scrubbing costs nothing and the playhead can stop anywhere.
`setBodyOffsets` on the viewport is where that lives.

What is left, and why each is a project rather than a batch:

**Simulation shipped in v2.22.0**, and it is a real finite element solve
validated against beam theory. `fea.js` holds all of it and nothing there
touches the kernel or the renderer.

Four things in it are load-bearing, and three of them were bugs first:

1. **Sized by the thinnest direction.** Cubes that divide the long side will not
   divide the short one, and stiffness goes as the thickness cubed, so a section
   a quarter too fat is two and a half times too stiff with nothing else looking
   wrong. The grid also reports its own volume against the part's, which catches
   this whenever it happens anyway.
2. **The scanline samples a hair off the cell centre.** Cell centres land on the
   diagonal of a square face constantly, because both sit on the same regular
   spacing, and the edge rule then has to break a tie by an exact floating point
   comparison. Sometimes both triangles claim the point, sometimes neither, and
   a whole row of cells comes out wrong.
3. **The element has incompatible bending modes**, condensed out once. Without
   them a cantilever at one element through the depth gives two thirds of the
   right answer; with them, within a fraction of a percent.
4. **Stress is read at element corners, not centres.** The middle of a section
   in bending has no stress in it, so a centre reading is zero for a beam at
   yield.

**Generative Design shipped in v2.23.0.** Topology optimisation on the same grid
the stress solver uses, which is the reason it was built that way. `generative.js`
holds it, and it never has to know how a part is solved: the solve is handed in.

Three things in it, and two were bugs first:

1. **The bisection is on the logarithm, and its bracket comes from the data.**
   How hard to push material about depends on how much energy is in the part,
   which varies by many powers of ten between problems. Bisected the ordinary
   way between fixed bounds, the search spends every step in the top decade and
   never reaches the bottom ones, and the answer empties the whole part.
2. **The sensitivity is blurred before it is acted on**, or the answer becomes a
   checkerboard, which is not a shape.
3. **The solve is warm started from the previous round.** The shape barely
   changes from one round to the next, so the last answer is nearly this one.

Material at the fixtures and under the load is locked solid. Optimising away the
face that is bolted down solves a different problem.

**Not scheduled, deliberately:** the twelve library and cloud backed commands
listed with the inventory, and everything in section 6 of it.

### Reading the order

Import first because he asked for it and because it is the one thing here that
beats Fusion rather than catching up with it. Then Select, because everything
else starts by choosing something and it is the largest hole. Then the Form
sculpting verbs, which is the biggest single block of real modelling capability
missing. Then the long tail, which is mostly a session each.

The workspaces are last not because they matter least but because each is
months, and three of the four have no user waiting on them yet.

### What STEP taught

- **Keep the grammar and the geometry apart.** `stepfile.js` knows what a Part
  21 file is and nothing about what a cylinder means; `stepread.js` is the
  other way round. Each is testable on its own, and the parser tests do not
  need a solid kernel to run.
- **Triangulate in the surface's own parameters, not in the world.** A
  cylindrical face unrolled is a polygon, and so is a conical one, and so is a
  flat one. One triangulator serves all of them and only the map back out
  differs. Trying to do it in three dimensions would have meant a separate
  routine per surface kind.
- **Count what you cannot read.** A face on a B-spline is reported by name. A
  part silently missing a face is a part that gets printed wrong.
- **`earcut` here is not the usual one.** It takes rings of points and returns
  index triples, where the common library takes flat coordinates and hole start
  offsets. Called the wrong way it returned degenerate triangles rather than
  throwing, and the only symptom was the kernel refusing the mesh with a
  complaint about non-finite vertices, which was not the problem at all.

### Still to do here

- **Act on what was found**, not only select it: change every 5 mm hole to 5.2,
  take a fillet off, fill a bore. The recognition carries the axis and the depth
  precisely so a feature can be built on it without re-deriving anything.
- **Blend shells.** Fillets that run together are one surface. Splitting one
  into its constituent blends needs more than a cylinder fit.
- **Then the formats.** 3MF already carries colour and an assembly tree that is
  currently thrown away. STEP after that, and not before recognition has proved
  itself.

---

## Cross-cutting work, to fold into whichever batch touches it

- **Performance.** Unchanged prefixes are cached as of v2.5.0: see
  `RebuildCache` in `features.js` and the Rebuilding section of the README. A
  thread is still tens of thousands of triangles, so the feature that builds one
  is still slow the first time. What is not cached is anything inside a single
  feature.
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
