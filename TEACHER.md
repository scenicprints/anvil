# Teacher Mode

An assistant that walks you through building a real part, pointing at what to
press, one step at a time, until the thing is finished and you know how the
program works.

It has two jobs and they are equally important.

**It teaches the program.** Anvil has 315 tools. Nothing tells you what they are
for, in what order they are meant to be used, or which of them you need for the
part in front of you. A reference manual answers the first question and none of
the others.

**It finds bugs.** A lesson step says what should be true when the step is done.
That is a test. Walking the campaign means driving all 315 tools by hand, with
an assertion behind every one of them, which is the only sweep of this program
that has ever been attempted. The texture fault found on 2026-09-14, where
picked faces were silently ignored, would have been caught by one step in
chapter 2 asserting that the unpicked faces did not move.

**Read `README.md` first** for what the tools actually do, and `ROADMAP.md` for
what is not built yet. This file covers only Teacher Mode.

---

## Decided

These were settled before writing anything and are not open unless said so.

- **Chapters, not one project.** No honest part uses sheet metal and Form and
  simulation and mesh repair. One project covering all 315 would be a
  Frankenstein and you would feel it. Nine chapters, each a part that makes
  sense on its own, with a ledger running across all of them.
- **Show Me points, it does not press.** The hint highlights the control and
  says what to do. It never does the step. A step the app performed for you
  teaches nothing and tests nothing.
- **100% coverage is the target**, counted by tool, with option depth reported
  as a second number.
- **It blocks.** While a step is live, everything except that step's target is
  refused. This is the one decision taken against the recommendation in the
  brainstorm, on the grounds that a guided lesson should guide.
- **Skip is therefore mandatory.** Blocked everywhere else and pointed at one
  control, a step whose condition never comes true because the app is broken
  would trap you with no way out. Skip is always live, and skipping files a bug.

---

## The inventory

Worked out from the source rather than estimated. `app.js` has 287 `runCommand`
cases; 20 of those are file plumbing or aliases that resolve to a command
already counted, leaving **267 commands**. The sketcher does not go through
`runCommand`, so it is counted separately: **12 sketch tools** on `data-tool`
buttons, **24 tool variants** behind the rectangle, circle, arc, polygon, slot
and spline family menus, and **12 constraints** on `data-con` buttons.

**315 tools.** That is the denominator, and 100% means all of it.

Every one of them is addressable already. Ribbon buttons carry `data-cmd`,
family menus carry `data-menu`, sketch tools carry `data-tool`, constraints
carry `data-con`. Nothing needs marking up to be pointed at.

### A tool is not a command

`extrude` is one id. It is also distance, to object, to next, symmetric, two
sided, thin, tapered, and join against cut against intersect against new body.
Ticking Extrude by doing one extrude exercises perhaps a tenth of it, and the
branches are where the faults live.

So the ledger carries two numbers. **Tools** is the 315 and it is the number the
campaign is built to finish. **Depth** is the option branches, declared by the
steps that exercise them, reported as a list of what has and has not been
reached. Depth has no target. It is there to be honest about what 100% means.

---

## A lesson is data

Lessons live in `lessons/` as plain data, not code. New chapters need no
changes to the application, the auto-player can walk any of them without
knowing what they contain, and a chapter can be rewritten without a rebuild.

A lesson is a chapter: a title, the part it builds, and a list of steps.

### A step

```
{
  say:    'Round the top front edge. 3 mm.',
  point:  '[data-cmd="fillet"]',
  covers: ['fillet', 'fillet:constant'],
  done:   (s) => s.doc.features.some((f) => f.type === 'fillet'),
  check:  (s) => s.volumeDropped(55, 62)
}
```

`say` is the instruction, written the way a person would say it.

`point` is a CSS selector for the control, or a geometry reference for something
in the viewport. It drives both the highlight and the block, because they are
the same question asked twice.

`covers` is what this step ticks on the ledger. A step may tick several, and a
tool may be ticked by several steps.

`done` is the condition. It is read after every rebuild and every command, and
the step ticks the moment it returns true.

`check` is the assertion, and it is the half that finds bugs. `done` says the
feature exists. `check` says it did the right thing.

### Why the condition reads the document

Not the clicks. Watching clicks knows how you did it and breaks the moment you
use the keyboard shortcut, the context menu, or a different order. It also
teaches the button rather than the idea.

The document does not care how. `doc.features` records every modelling action
with its inputs, so a step asserts on the result. Use the ribbon, press F,
right click, it makes no difference.

### Why `check` is separate from `done`

Because blocking removes wandering, and wandering was going to be half the bug
finding. What is left is the strength of the assertions, so they have to be
about the result and not about the command having run.

`done: a fillet exists` proves almost nothing. `check: the volume dropped by
what a 3 mm round on a 30 mm edge should take, and no other face moved` is the
thing that catches a fault. Every `check` is a small version of the probes in
`tools/`, written the same way and reusable by the auto-player.

A failed `check` does not block progress. It files a bug and lets you carry on.

---

## The engine

### Where it taps in

Two funnels already exist and they are enough. `runCommand` sees every command.
`rebuildAll` sees every change to the model. A step re-reads its `done` and
`check` after either. No new event system.

### Blocking, and what can never be blocked

While a step is live, controls that are not the step's target are refused, and
the reason is said out loud rather than the click being swallowed in silence.

Always live, regardless of the step:

- **Camera.** Orbit, pan, zoom, Fit, Home, the view cube. You cannot press what
  you cannot see.
- **Undo and redo.** Do the step wrong, undo, do it again. Without this the
  first mistake is a dead end.
- **Skip and Exit**, and the lesson panel itself.
- **The viewport**, when the step is a pick. Blocking the ribbon while asking
  you to click a face is the point; blocking the face is not.

### Pointing

`vp.setHighlight({ faces, edges })` already draws the translucent overlay for
"pick this one", and it is what Teacher Mode uses for anything in the model.
For chrome it is a spotlight ring on the selector in `point`, with the rest of
the ribbon dimmed by the block anyway.

A step that points into a family menu has to open it first, so `point` may be a
list: open the menu, then the item in it.

---

## The ledger

Two numbers, both always visible.

**Tools: 0 of 315.** Derived at startup from the same places this document
counted them, so a tool added to the app appears in the ledger without anybody
remembering to add it. A tool with no chapter claiming it is itself reported,
because that is a gap in the campaign rather than a gap in the app.

**Depth.** The option branches reached, listed against the branches declared.
No target, no percentage, just what has and has not been touched.

The ledger is per document or global? Global. It is a record of what you have
exercised, not of what this part uses.

---

## When it goes wrong

Three things file a report, and they all file the same thing:

- **Skip.** You could not do the step.
- **A failed `check`.** The step completed and the result was wrong.
- **An error during a step.** Anything in `state.result.errors`, and anything
  `window.onerror` caught.

A report holds the chapter and step, the instruction as written, the document as
JSON, the last few commands run, and any errors. That is enough to reproduce it
without a conversation, which is the whole point.

Reports go to a folder, one file each. They are not sent anywhere.

---

## The auto-player

Every lesson can be walked by the existing probe harness. `--anvil-script` drives
the real UI with real pointer events, and a lesson already declares what it
wants and how to know it happened. Add a `do` to each step, which is what the
probes already do, and a chapter can be played start to finish with nobody
watching.

That means a lesson is verifiable before you ever see it. A chapter whose step
never satisfies under the auto-player is either a broken lesson or a broken
feature, and it is found in a batch run rather than at step 14 on a Sunday.

It also means the campaign doubles as an integration test over all 315 tools,
which is something the 620 unit tests cannot be.

---

## The chapters

Nine parts, 315 tools, every tool claimed by exactly one chapter. The assignment
below was checked against the source: nothing is named here that the app does
not have, and nothing in the app is left unassigned.

| Chapter | Part | Tools |
|---|---|---|
| 1 | Bracket | 50 |
| 2 | Knob | 31 |
| 3 | Enclosure | 45 |
| 4 | Sheet metal tray | 15 |
| 5 | Bottle | 35 |
| 6 | Handle | 54 |
| 7 | A part somebody scanned | 28 |
| 8 | The engineering pass | 40 |
| 9 | Presentation and housekeeping | 17 |

### 1. Bracket

Sketching, constraining, and the four solid tools that do most of the work.
Ends with a part you could print.

Sketch tools: select, line, rectangle, centre rectangle, three point rectangle,
circle, two point circle, three point circle, two tangent circle, three tangent
circle, arc, three point arc, tangent arc, dimension, trim, extend, offset,
fillet, chamfer, break, point.
Constraints: coincident, collinear, concentric, equal, fix, horizontal,
midpoint, parallel, perpendicular, symmetric, tangent, vertical.
Commands: newSketch, finishSketch, lookAt, construction, centerline, construct,
offsetPlane, extrude, hole, fillet, chamfer, pressPull, measure,
physicalMaterial, exportStl, deleteFeature, suppress.

### 2. Knob

Turning, repeating and decorating. The chapter where the timeline starts to be
worth having, because everything downstream moves when a dimension changes.

Sketch tools: polygon, circumscribed polygon, edge polygon, slot, overall slot,
centre point slot, three point arc slot, centre point arc slot, ellipse, text.
Commands: editText, sketchMove, sketchCopy, sketchPaste, mirrorSketch,
sketchScale, sketchPatternRect, sketchPatternCirc, revolve, coil, thread,
mirror, patternRect, patternCirc, patternPath, patternFeature, draft,
textureRelief, makeTexture, print3D, parameters.

### 3. Enclosure

Two parts that have to fit each other, which is where bodies, components and
joints stop being the same thing.

Commands: primBox, primCyl, primSphere, primTorus, primPipe, shell, splitBody,
splitFace, silhouetteSplit, combine, move, align, scale, deleteBody, deleteFace,
replaceFace, boundaryFill, offsetFace, newComponent, groundToParent, newJoint,
asBuiltJoint, jointOrigin, constrainComponents, rigidGroup, motionLink,
driveJoints, duplicateComponent, interference, sectionAnalysis, isolate,
unisolate, hideSelected, showAll, insertComponent, insertDerive, refreshDerived,
editInPlace, breakLink, chooseLibrary, searchLibrary, addProfile, switchProfile,
profilePicture, clearProfilePicture.

### 4. Sheet metal tray

The smallest chapter and the most self contained. A rule, some flanges, and a
flat pattern that could go to a laser.

Commands: smRule, baseFlange, flange, hem, loftedFlange, contourFlange,
sheetFold, unfold, refold, rip, cornerRelief, miter, convertToSheetMetal,
flatPattern, exportFlatDXF.

### 5. Bottle

Curves that are not arcs, and the surface tools that build a shape too soft for
extrude and revolve.

Sketch tools: spline, control point spline, conic, blend curve, G1 blend curve.
Commands: sweep, loft, rib, web, emboss, fullRound, surfaceExtrude,
surfaceRevolve, surfaceSweep, surfaceLoft, patch, ruled, offsetSurface,
trimSurface, extendSurface, untrimSurface, mergeSurface, stitch, unstitch,
reverseNormal, thicken, project, projectCopy, intersect, include3D,
intersectionCurve, projectToSurface, isoCurve, insertSvg, insertDxf.

### 6. Handle

The largest chapter, and unavoidably so: Form is 54 tools and none of them mean
anything outside it. A grip shaped by pushing a cage about.

Commands: formBox, formPlane, formCylinder, formSphere, formTorus, formQuadball,
formExtrudeCurve, formRevolveCurve, formSweepCurve, formLoftCurves,
formPipeCurve, formFace, editForm, formPull, formGrow, formShrink, formLoop,
formRing, formInvert, formSelectAll, formInsertEdge, formInsertPoint,
formSubdivide, formBridge, formFillHole, formDelete, formWeld, formUnweld,
formCrease, formUncrease, formSmooth, formStraighten, formCylindrify, formSlide,
formBevel, formErase, formMergeEdge, formFreeze, formUnfreeze, formMatch,
formByCurve, formInterpolate, formUninterpolate, formFlatten, formUniform,
formMirror, formCircular, formClearSymmetry, formRepair, formThicken,
finishForm, formDisplayBox, formDisplayControl, formDisplaySmooth.

### 7. A part somebody scanned

A mesh arrives broken, as they do, and comes out a solid you can model on.

Commands: insertMesh, tessellate, convertMesh, recognise, meshStitch, meshPatch,
meshDirectEdit, meshRepair, meshMerge, meshScale, meshSeparate, faceGroups,
createFaceGroup, combineFaceGroups, releaseFaceGroups, faceGroupEdit,
meshReduce, meshRemesh, meshSmooth, meshPlaneCut, meshShell, meshAlign,
meshErase, meshReverse, textureExtrude, meshSection, meshPalette, validate.

### 8. The engineering pass

No new shape. Taking a part already built and asking whether it is any good,
which is the half of CAD nobody teaches.

Commands: configurations, simulate, generative, clearStress, designAdvice,
draftAnalysis, curvatureComb, curvatureMap, minimumRadius, zebraAnalysis,
accessibility, surfaceContinuity, isocurveAnalysis, centreOfMass, spunProfile,
colourByComponent, colourByFeature, clearAnalysis, boss, rest, snapFit, lip,
selectAllEdges, selectGrow, selectShrink, selectInvert, selectTangent,
selectSimilar, selectSeedBoundary, selectBySize, selectByName,
createSelectionSet, priorityAuto, priorityFace, priorityEdge, priorityBody,
priorityComponent, prioritySketch, toggleHistory, computeAll.

### 9. Presentation and housekeeping

Making it look like something, and the handful of tools that belong to the
application rather than to the model.

Commands: appearance, render, animate, environmentMap, insertCanvas,
insertDecal, wrapImage, documentInfo, addNote, namedVersions, renameDesign,
home, toggleProjection, rollbackStart, rollbackPrev, rollbackNext, rollbackEnd.

---

## Settled while building

- **The panel is a card in the bottom left**, clear of the ribbon it points at
  and of the browser on the right. The instruction is set larger than anything
  else in the chrome, because the gesture is: read the line, look up, press the
  ringed thing.
- **The viewport is never blocked.** Orbiting and picking are the same drag on
  the same canvas, so there is no honest way to allow one and refuse the other,
  and a lesson you cannot look around is not a lesson. Blocking is the ribbon.
- **The command search is an escape hatch and stays one.** Ctrl K reaches every
  command whatever the step says. Closing that would have meant a step that goes
  wrong has no way round it but Skip, and the palette costs a deliberate
  keystroke, so nobody wanders into it.
- **Free play is how it already works.** The ledger records what you use whether
  or not a lesson is running, so ordinary modelling counts towards the 315.
- **Every tool the app has is counted from the app.** Ribbon buttons, family
  menus, sketch tools and constraints are read out of the DOM; the six commands
  with no button anywhere are listed in `OFF_RIBBON` in `app.js`, and
  `test/coverage.test.js` fails the run if that list and the command switch
  stop agreeing.

## Resuming

Where each chapter was left is kept per machine, so the chooser says "step 12 of
41" rather than only the chapter's name, and opening one puts you back there. A
chapter that was finished starts again, because that is what opening a finished
thing means.

## Chapters that need something to work on

Chapter 7 repairs a broken mesh and chapter 8 asks whether a part is any good,
and neither question can be put to an empty document. Both carry a `start` that
lays one out: chapter 7 builds a sphere of triangles with three patches missing,
which is what a scanner leaves behind, and chapter 8 a shelled box with rounded
corners, which has enough faces for the selection rules to be worth using.

`start` runs into an empty document and never into one with work in it. A
lesson must not be the reason somebody's model went away.

## The auto-player

`play` walks a chapter with nobody watching. Almost every step in the campaign
is the same gesture, so there is a default: press the control the ring is round,
opening its group first if it is folded, and accept whatever dialog opens. A
step that needs something else carries its own `play`.

A step the default cannot satisfy comes back marked `never`, and one it drove
into a wrong result comes back `wrong`. `tools/demo-campaign.js` plays all nine
and reports both.

**The player accuses nobody.** It accepts whatever a dialog offers, and half the
dialogs here open at a deliberate zero waiting to be given a size, so a wrong
result under the player usually means nothing typed a number rather than that
anything is broken. It files no reports for that reason. What it is for is rot:
a step that used to be satisfied and no longer is has changed underneath the
lesson, and that is worth knowing. Finding actual faults is what a person
walking the chapter does, and a person knows whether they did the step.

## Still open

- **Most steps cannot play themselves.** The default reaches about a fifth of
  the campaign. The rest want geometry picked or a dialog filled with real
  numbers, and each needs a `play` of its own, written the way the probes in
  `tools/` are. That is the remaining work on this, and it is the difference
  between a campaign that is checked and one that is only counted.
- **Picking something plausible for the player was tried and did not work.**
  Selecting the biggest flat face, or every outside edge, before pressing moved
  the figure by one step in two hundred and thirty three, so the table that did
  it was taken back out rather than left in looking useful.
- **Depth has no chapters behind it yet.** The option branches are declared by
  the steps that claim them, and only a handful do so far, so the second number
  is thin. It is honest, it is just small.

## Built

All of it except the auto-player's step scripts.

- `src/renderer/teacher.js`, the engine: steps, blocking, the spotlight, the
  ledger, the reports, and `play`.
- `src/renderer/lessons/`, the nine chapters and the kit they are written with.
- `test/coverage.test.js`, which proves the campaign reaches all 315 tools and
  fails the run when a tool is added and nothing teaches it.
- `tools/demo-teacher.js`, which opens a chapter in a real window and checks
  that the wrong button is refused, the right one is not, a step ticks off the
  document rather than off the click, Skip files a report, and leaving puts the
  ribbon back.
