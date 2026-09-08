# Fusion feature inventory

Every command Fusion has, the options it carries, and where Anvil stands against
it. Compiled by reading Autodesk's own Fusion help, one reference page at a time,
rather than from memory. This is a working index for parity: command names and
option names, in compressed form, with a status. It is not a copy of Autodesk's
documentation, and it is not a substitute for reading the reference page for a
command before building it — read that page when the work starts, because it
fixes the option set and the ordering.

Status means:

- **has** — Anvil does this, with the same options.
- **partial** — Anvil does this, missing named options.
- **missing** — not built.
- **n/a** — belongs to a part of Fusion Anvil is not (CAM, PCB, cloud data).

What has been read page by page, and what has only been listed, is recorded
under **Crawl status** near the bottom. Anything marked *pending* is a dialog
whose options have not been compared option by option yet.

---

## Design > Solid > Create

### Extrude — partial

Adds depth to profiles or planar faces.

| Option | Values | Anvil |
|---|---|---|
| Type | Extrude, Thin Extrude | has |
| Profiles | sketch profiles or faces; a whole sketch from the browser | has |
| Tangent Chain | thin extrude only | missing |
| Start | Profile Plane, Offset, Object | has |
| Direction | One Side, Two Sides, Symmetric | has |
| Measurement | Half Length, Whole Length (symmetric only) | has |
| Extent Type | Distance, To Object, All | has |
| Extend | To Selected Face, To Adjacent Faces, To Body, Through Body | has |
| Offset | from profile plane, or from the object reached | has |
| Flip | all extent only | has |
| Taper Angle | per side | has |
| Wall Thickness / Wall Location | Side 1, Side 2, Center | has |
| Operation | Join, Cut, Intersect, New Body, New Component | partial — no New Component |
| Objects To Cut | Auto-Select, # Bodies | has |

Fusion auto-selects the profile when only one is visible in the design. Anvil
does this as of v2.28.0. What is actually left here is **New Component** as an
operation, and **Tangent Chain** on thin extrude.

### Revolve — near complete

| Option | Values | Anvil |
|---|---|---|
| Profile | coplanar profiles or faces | has |
| Axis | a linear or circular object | has |
| Project Axis | project the axis onto the profile's sketch plane, or leave it where it is | has, v2.29.0 |
| Extent Type | Partial, To Object, Full | has |
| Angle | or the object to revolve to | has |
| Direction | One Side, Two Sides, Symmetric | has |
| Operation / Objects To Cut | | has, less New Component |

### Sweep — partial

| Option | Values | Anvil |
|---|---|---|
| Type | Single Path, Path + Guide Rail, Path + Guide Surface, Solid Sweep | partial — first two |
| Profile / Body | profile or planar face; a solid for Solid Sweep | partial |
| Path | | has |
| Guide Rail | scales and orients the profile along the path | has |
| Chain Selection | pick tangentially connected geometry as one | **missing** |
| Distance | fraction of the path, 0 to 1 | **missing** |
| Taper Angle, Twist Angle | | has |
| Extent | Perpendicular To Path, Full Extents | **missing** |
| Profile Scaling | Scale, Stretch, None | **missing** |
| Orientation | Perpendicular, Parallel, Aligned | **missing** |
| Operation / Objects To Cut | as Extrude | partial |
| Analysis tab | None, Zebra, Curvature Map, Isocurve | **missing** here (Anvil has zebra elsewhere) |

### Loft — partial

| Option | Values | Anvil |
|---|---|---|
| Profiles | sketch, edge or face, in an order you can change | partial — no reorder |
| End condition (per profile) | Free, Direction, Tangent, Smooth, Sharp, Point Tangent | partial — connected and tangent only |
| Guide Type | **Rail**, **Centerline** | partial — rails only |
| Rails / Guide | any number of rails; one centerline | has (rails) |
| Chain Selection | adjacent edges taken as one profile | **missing** |
| Closed | join the first and last profile into a loop | has |
| Takeoff Weight / Takeoff Angle | with the Direction end condition | **missing** |
| Tangency Weight | with Tangent, Smooth or Point Tangent | has (start and end weight) |
| Tangent Edges | Merge, Keep | **missing** |
| Operation / Objects To Cut | | partial |
| Analysis tab | None, Zebra, Curvature Map, Isocurve | **missing** here |

Fusion also maps matching corners between closed sections with the same number
of corners, so the orientation is worked out rather than guessed. Worth knowing:
that is the thing that makes a loft between two rectangles not twist.

### Rib — partial

| Option | Values | Anvil |
|---|---|---|
| **Presets** | last used, defaults, save, rename, delete, set as default | **missing** (and missing app-wide) |
| Profile | an open sketch profile | has |
| Direction | Symmetric, One Direction | **missing** |
| Start | Bottom, Top | **missing** |
| Thickness | | has |
| Extent Type | **To Next**, Depth | partial — depth only |
| Depth | | has |
| Flip Direction | | has |
| Draft Angle + Draft Pull Direction + flip | | **missing** |
| Fillet Radius | a fillet at the foot of the rib | **missing** — Anvil has this on Boss, not Rib |

**Presets are a Fusion-wide idea Anvil has nowhere.** A dialog can save its
current values under a name and reuse them, with one marked as the default for
new features. Rib is where the reference documents it, but it belongs to the
dialog machinery rather than to Rib.
### Web — near complete

Same option set as Rib, but perpendicular to the sketch plane rather than
parallel. Anvil has profile, thickness, extent type (To Next or Depth), depth,
flip, draft angle and extend curves. Missing: **Presets**, **Direction**
(Symmetric or One Direction), **Start** (Bottom or Top), **Fillet Radius**.

Note the pairing: Rib is parallel to the sketch plane, Web is perpendicular.
Anvil's Web has To Next and its Rib does not, which is the wrong way round from
the point of view of matching.

### Emboss — near complete

| Option | Values | Anvil |
|---|---|---|
| Sketch Profiles / Faces | | has |
| Tangent Chain | | **missing** |
| Effect | Emboss, Deboss | has |
| Flip Normal | | has |
| Depth | positive embosses, negative debosses | has |
| Horizontal Distance / Vertical Distance / Rotation Angle | move and turn the emboss on the face | has |
## Design > Plastic

All four of these sit behind the **Fusion Design Extension**, a paid add-on, which
is worth knowing before treating them as core parity. Anvil has all four already,
in much simpler form.

They also lean on a Fusion concept Anvil has nothing like: a **plastic rule**
assigned to a component, from which these features inherit some of their
dimensions. That is the piece to build first if any of this is to be matched
properly, because it is what stops eleven dialogs each carrying its own wall
thickness.

### Boss — partial

Fusion: sketch points position them; a Fastener section specifies the screw
itself (Create Component, Head type of seven, Drive type of ten, Thread Form of
four, thread angle, diameter, length, material, surface finish); Side 1 and
Side 2 each get a Hole Type (Simple, Counterbore, Countersink), a Step Type (In,
Out, None), a Hole Depth Type on side 2 (From Bottom, From Top, Through Body),
and an Advanced section; a separate **Ribs tab** carries quantity, total angle,
rotation angle, profile (Chamfer or Fillet), thickness, draft angle, rib length,
step offset, outer fillet radius and base fillet radius, per side. Editing aids:
Side 1 and Side 2 transparency, and a section analysis cut through the boss.

Anvil: outside diameter, bore, height, bore through or to a depth, fillet at the
foot, and ribs as a count with thickness, height and reach. **Missing: the whole
fastener specification, the two-sided hole and step types, per-side ribs, and
the visibility aids.**

### Snap Fit — partial

Fusion: three types — Parallel Hook And Groove, Perpendicular Hook And Groove,
Hook And Loop. Sketch points place them. Rotation Type of Uniform, Independent
or Aligned (to a plane, line or point, with a flip). Extent Type of To Next
(with a base fillet radius) or Distance (with a depth). Hook and Groove sections
each take a body and their own dimensions. Selection Mode of Automatic or Manual
for the sketch points.

Anvil: one cantilever, with beam length, thickness and width, hook height,
lead-in and retention angles, facing angle, hook or catch, and a clearance.
**Missing: the other two types, rotation types, extent types, and placing
several from sketch points at once.**

### Rest — partial

Anvil has shape (round or rectangular), diameter or width and depth, corner
radius, height, draft angle, and raised or sunken. Fusion's reference page is
*pending*.

### Lip and Groove — *pending* (Anvil has it)

---

## Design > Solid > Modify

### Fillet — partial

| Option | Values | Anvil |
|---|---|---|
| Type | Fillet, **Rule Fillet**, **Full Round Fillet** | partial — first only |
| Selection sets | several, each with its own radius and settings | has |
| Radius Type | Constant, Chord Length, Variable, **Asymmetric** | partial — plus a hold-line type Fusion does not have |
| Continuity | Tangent (G1), Curvature (G2) | **missing** |
| Tangent Chain | select tangentially connected edges as one | **missing** |
| Tangency Weight | | **missing** |
| Radius Points | radius and position along one edge (variable only) | has |
| Corner Type | Rolling Ball, Setback | **missing** |
| Rule | All Edges, Between Faces/Features (rule fillet) | **missing** |
| Round/Fillets | Rounds and Fillets, Rounds Only, Fillets Only (rule fillet) | **missing** |
| Center Faces / Side 1 / Side 2 | full round fillet | **missing** |

Note: **Rule Fillet with the rule "All Edges" is Fusion's named way to round a
whole part.** That is exactly what Anvil used to do silently when nothing was
picked, and what it now hides behind the `all` flag on a set. It wants to be a
type in the dropdown.

### Move/Copy — partial

| Option | Values | Anvil |
|---|---|---|
| Move Object | Components, Bodies, **Faces**, **Sketch Objects** | partial — bodies |
| Move Type | **Free Move**, Translate, Rotate, Point to Point, **Point to Position** | partial — three of five |
| Direction | Component XYZ, Design XYZ, **Pick Direction** (along an edge or axis) | **missing** |
| Set Pivot | centre of rotation within the selection | **missing** |
| X/Y/Z Distance, X/Y/Z Angle | | has |
| Create Copy | move a copy instead of the original | **missing** |

Free Move is explicitly not captured parametrically in Fusion, which is worth
knowing before matching it.

### Chamfer — partial

| Option | Values | Anvil |
|---|---|---|
| Selection sets | several, each with its own type, distance and angle | has |
| Type | Equal Distance, Two Distance, Distance And Angle | has |
| Edges/Faces/Features | | partial — edges only |
| Distance, Angle | | has |
| Tangent Chain | | **missing** |
| Corner Type | Chamfer, Miter, Blend | **missing** |

### Draft — partial

| Option | Values | Anvil |
|---|---|---|
| Type | Fixed Plane, **Parting Line** | partial — fixed plane |
| Pull Direction | a plane or face | has (neutral plane) |
| Parting Tool | plane, face, edge or sketch curve | **missing** |
| Faces | | has |
| Tangent Chain | | **missing** |
| Flip Pull Direction | | **missing** |
| Angle | one, or Angle 1 and Angle 2 for two-sided | has |
| Draft Sides | One Side, Two Side, **Symmetric** | partial — one and two |
| Parting Line Type | Fix Parting Line, Move Parting Line | **missing** |
| Direction (move parting line) | Angle Above, Both, Angle Below | **missing** |
| Fixed Edges (move parting line) | edges held against deformation | **missing** |

### Combine — near complete

| Option | Values | Anvil |
|---|---|---|
| Target Body / Tool Bodies | | has |
| Operation | Join, Cut, Intersect | has |
| Objects To Cut | Auto-Select, # Bodies | n/a — Anvil names the tool bodies explicitly, so there is nothing to infer from visibility |
| New Component | | has |
| Keep Tools | | has |

### Silhouette Split — partial

| Option | Values | Anvil |
|---|---|---|
| View Direction | the direction the silhouette is taken from | has |
| Target Body | | has |
| Operation | Split Faces Only, Split Shelled Body, Split Solid Body | **missing** — Anvil always splits the solid |

### Scale — *pending* (Anvil: factor or per-axis, about the middle, the origin, or a point)

### Tangent Chain — a setting, not a command — partial

Checked by default in Fillet and Chamfer, and present in Sweep, Draft, Loft and
Thin Extrude. When on, picking an edge takes every edge tangentially connected
to it, and a rolled-back edit that adds edges updates the later feature's
selection to match.

**Correction to an earlier reading of this file:** Anvil does have the capability,
as a Select command (`selectTangent`, on `select.js`'s `tangentRun`). What it does
not have is the per-dialog checkbox. The difference is not cosmetic: as a
selection command it happens once, before the dialog; as a dialog setting it stays
live, so adding edges to an earlier feature updates every later feature that was
picked with it on. The first is a convenience, the second is a rule the model
keeps.

### Press Pull — partial, and worth reading closely

Press Pull is not a feature of its own. It is a router: what you click decides
which dialog opens.

| Clicked | Fusion opens | Anvil |
|---|---|---|
| Sketch profile | Extrude | has |
| **Edge** | **Fillet** | has, v2.29.0 |
| Face | Offset Face | has |

Anvil's arrow-on-the-selection gesture is the same idea, and as of v2.29.0 it
routes all three. An edge stands the arrow on the bisector of its two faces,
which is the direction a fillet grows in whether it is rounding a corner off or
filling one in, and the value box asks for a radius rather than a distance.

Fusion's Press Pull also honours Tangent Chain when selecting faces.

### Edit Face — missing

T-Spline faces, edges and vertices created on a BRep face, in direct modelling
mode only. Face; Transform Mode (World Space, View Space, Local); Selection
Filter (Vertex, Edge, Face, All); Loop Selection; Preview Check; Subdivide Faces
(Length, Width, Contour Spacing); Curvature Combs; Symmetry; numerical inputs.

Anvil has an Edit Form manipulator for T-spline bodies, but nothing that turns a
BRep face into an editable cage.

### Offset Face — has

One or more faces shifted in or out by a distance, dragged or typed. Adjoining
curved tangent faces come with it where the geometry allows. Anvil has this, and
it is what the arrow on a selected face drives.

### Split Body — partial

| Option | Values | Anvil |
|---|---|---|
| Body to Split | | has |
| Splitting Tool(s) | **several tools at once** | partial — one face or plane |
| Extend Splitting Tool(s) | on by default; uncheck when the tool already crosses the body | **missing** |

Anvil also offers a Result of two bodies or keeping only the near side, which
Fusion does not have here.

### Align — partial

| Option | Values | Anvil |
|---|---|---|
| Object | Bodies, Components | partial — bodies |
| From / To geometry | **point, line, plane, circle, or coordinate system** | partial — face to face |
| Flip | invert 180 degrees | has |
| Angle | rotate 90 degrees per click | has, as a typed angle rather than a click |

Align creates no relationship between the objects, unlike a joint. Anvil's
version puts a face of one body flat against another, which is the plane-to-plane
case only.

### Replace Face — partial

Source faces come off, the neighbouring faces are trimmed or extended to reach
the Target faces, and new faces are stitched in. Targets may be planar or not,
and may be solid faces, surface patches or workplanes; they have to cross the
whole of the part being trimmed. Anvil swaps a face for a surface, which is the
same idea with a narrower set of targets.

### Split Face — partial

| Option | Values | Anvil |
|---|---|---|
| Face to split | several at once | has |
| Splitting Tool | a sketch, face or workplane | has |
| Split Type | Split with Surface, **Along Vector**, **Closest Point** | **missing** — surface projection only |
| Extend Splitting Tool | | **missing** |

Fusion notes the point of it: a split face isolates an area so Draft or Press
Pull can act on part of a face. Worth remembering, since it makes Draft's
parting-line work.

### Shell — partial

| Option | Values | Anvil |
|---|---|---|
| Type | Sharp Offset, **Rounded Offset** | **missing** — sharp only |
| Object | Faces to remove, or a whole Body with no opening | has |
| Direction | Inside, Outside, Both | has |
| Inside Thickness / Outside Thickness | two values when the direction is Both | has, v2.29.0 |
| Tangent Chain | | **missing** |

### Boundary Fill — partial

Planes, surfaces and bodies are the tools; the enclosed volumes where they cross
are the cells; you choose which cells to keep.

| Option | Values | Anvil |
|---|---|---|
| Select Tools | planes, surfaces, bodies | has |
| Select Cells | | has |
| Operation | Join, Cut, Intersect, New Body, New Component | **missing** — Anvil only keeps cells |
| Objects To Cut | Auto-Select, # Bodies | **missing** |

### Delete Face — *pending* (Anvil has it)

---

## Design > Solid > Create > Primitives

| Primitive | Anvil |
|---|---|
| Box | has |
| Cylinder | has |
| Sphere | has |
| Torus | has |
| Pipe | has |
| **Coil** | **missing** |

### Coil — missing

The one primitive Anvil does not have, and the one that carries real settings.

| Option | Values |
|---|---|
| Type | Revolution And Height, Revolution And Pitch, Height And Pitch, Spiral |
| Rotation | clockwise or counterclockwise |
| Radius | centre of the coil to the centre of the section |
| Revolutions, Height, Pitch | which are asked for depends on the type |
| Angle | taper, on every type but spiral |
| Section | Circular, Square, Triangular (External), Triangular (Internal) |
| Section Position | Inside, On Center, Outside |
| Section Size | diameter of a circumscribed circle |
| Operation / Objects To Cut | as elsewhere |

Anvil has a modelled thread, which is a harder version of the same sweep, so the
path to this is short.

---

## Design > Sketch

Anvil's sketcher is the strongest part of it against Fusion. Tools: line, arc,
circle (centre and diameter), ellipse, rectangle (corner and centre), polygon,
slot, spline, control-point spline, conic, point, text, fillet, chamfer, trim,
extend, offset, break, mirror, and rectangular and circular pattern, plus copy,
paste, move and scale. Constraints: coincident, collinear, concentric, equal,
fix, horizontal, vertical, midpoint, parallel, perpendicular, symmetric,
tangent. Dimensions carry expressions.

**3D sketch tools**, Fusion's list: Line, Arc, Spline, Rectangle, Circle,
Ellipse, Point, Text, Conic Curve. Anvil has all nine as tools and has 3D
sketching. **3D sketch constraints**, Fusion's list: horizontal/vertical,
coincident, tangent, equal, parallel, perpendicular, fix/unfix, midpoint,
concentric, colinear. Anvil has all ten.

### Sketch Palette — partial

The palette that follows an open sketch. Contextual options change with the
active tool or selected object: line types when Line is up, slot types when Slot
is up, and for a selected spline, normal or construction plus a curvature comb,
with the degree editable on a control-point spline.

| Option | Anvil |
|---|---|
| Linetype (convert geometry to another line type) | **missing** |
| Construction | has |
| Centerline | has |
| **Look At** (turn the camera square to the sketch plane) | **missing** |
| Sketch Grid on/off | has |
| Snap on/off | has |
| **Slice** (cut through bodies at the sketch plane while sketching) | **missing** |
| Show Profile | has |
| Show Points / Dimensions / Constraints | partial |
| Show Construction Geometries | **missing** as a toggle |
| Show Projected Geometries | **missing** as a toggle |
| 3D Sketch on/off | has |

**Slice is the one worth having.** Sketching inside a part you cannot see into is
the common case, and a temporary cut at the sketch plane is how Fusion solves it.

### Sketch lifecycle — *pending*

Create a sketch · start on a plane or face · construction and centerline
geometry · finish · edit · **copy a sketch** · **redefine a sketch plane** ·
**export as DXF**. Anvil has create, start on a plane or face, construction,
centreline, finish and edit. Copy, redefine the plane, and DXF export are
*pending* confirmation.

---

## Design > Surface

### Create — near complete

| Fusion | Anvil |
|---|---|
| Patch | has |
| Extrude | has |
| Revolve | has |
| Sweep | has |
| Loft | has |
| Ruled | has |
| Offset | has |

Option-by-option comparison of each is *pending*; the Loft reference has its own
surface variant page.

### Modify — near complete

| Fusion | Anvil |
|---|---|
| **Fillet or chamfer surface edges** | **missing** |
| Trim | has |
| Untrim | has |
| Extend | has |
| Stitch | has |
| Unstitch | has |
| Reverse normal | has |

The only gap in the surface workspace is filleting and chamfering the edges of a
surface body, as opposed to a solid.

---

## Design > Mesh

| Fusion | Anvil |
|---|---|
| Direct Edit | has |
| Remesh | has |
| Reduce | has |
| Plane Cut (trim or split with a plane) | has |
| Shell | **missing** |
| Combine | has (merge) |
| Smooth | has |
| Reverse normal | has |
| Erase and Fill | has |
| Align to a plane | **missing** |
| **Extrude texture** | **missing** |
| Separate | has |
| Scale | **missing** as a mesh command |
| Convert to solid | has |
| Mesh Selection Palette | **missing** |

Anvil also has patch, repair, stitch and section, which are its own. The gaps are
mesh shell, align to a plane, texture extrude, a mesh scale command, and the
selection palette that governs how clicking picks mesh faces.

---

## Design > Sheet Metal

| Fusion | Anvil |
|---|---|
| Base / Edge / Contour flange | has (base and edge; contour needs checking) |
| Lofted flange | has (lofted runs) |
| Hem | has |
| Bend / Fold | has |
| Unfold / Refold | has |
| Flat pattern | has, with DXF out |
| Corner seams and relief cuts | has (mitre corners, relief cuts) |
| **Sheet metal rules**: create, edit, **override per feature**, configure | partial — Anvil has a rule library, override is *pending* |

### Flange (base, edge, contour) — partial

The three flange types are one command in Fusion, with a selection box where
every row carries its own settings.

| Option | Values | Anvil |
|---|---|---|
| Type | Base, Edge, Contour | has, as three commands |
| Selection box, per-row settings | several flanges in one feature | **missing** — one at a time |
| Edges / Profiles | | has |
| **Flange Width Type** (edge) | Full Edge, Symmetric, Two Sides, **Two Offsets** against reference faces | **missing** — full edge only |
| Extent Type (edge) | Distance, **To Object** with an offset | partial — distance |
| Angle (edge) | | has |
| **Height Datum** (edge) | Inner Faces, Outer Faces, Tangent To Bend | **missing** |
| Bend Position (edge) | Inside, Outside, Adjacent, Tangent | has |
| Flip (edge) | | *pending* |
| Miter Corners (edge) | | has, as its own command |
| Orientation (base, contour) | Side 1, Side 2, Center | **missing** |
| Operation (base, contour) | New Body, New Component | **missing** |
| Direction (contour) | One Side, Two Sides, Symmetric | **missing** |
| Sheet Metal Rule | pick the rule when the first body is made | partial |
| **Override Rules** | per-flange overrides of bend radius, bend relief, and 2- and 3-bend corner relief | **missing** |

The overrides are the substantial gap, and they are the reason the rules system
exists: a rule sets the defaults for a component and any one feature can depart
from it without changing the rule. Anvil has the rules and not the departures.

Anvil's sheet metal is closer to parity than any other workspace bar the sketcher
and Form. The lofted flange and hem references are *pending*.

## Design > Form (T-Splines) — near complete

The closest match in the whole inventory after the sketcher, which is a surprise
given how large Fusion's Form toolbar is.

**Create**: Box, Plane, Cylinder, Sphere, Torus, Quadball, Face, plus extrude,
revolve, sweep and loft into a T-Spline. Anvil has every one.

**Modify**, Fusion's list against Anvil's `form.js`:

| Fusion | Anvil |
|---|---|
| Edit Form | has |
| Insert Edge | has |
| Subdivide | has |
| Insert Point | has |
| Merge Edge | has |
| Bridge | has |
| Fill Hole | has |
| Erase and Fill | has |
| Weld / Unweld Vertices | has |
| Crease / Uncrease | has |
| Bevel Edge | has |
| Slide Edge | has |
| Smooth | has |
| Cylindrify | has |
| Pull to a target body | has |
| Flatten | has |
| Straighten | has |
| Match to solid, surface or sketch geometry | has |
| Interpolate | has |
| Thicken / shell | has |
| Freeze / Thaw | has |
| Modify neighbouring vertices (soft falloff) | has |
| Delete T-Spline geometry | has |
| Convert to a solid | has |
| Mirror-Internal / Circular-Internal symmetry | has |
| **Edit By Curve** (drive edges with a curve) | **missing** |
| **Tangent handles** | **missing** |
| **Snap vertices to objects** | **missing** |
| **Display Mode** (box, control frame, smooth) | **missing** |
| **Control points and surface points** as separate things to grab | **missing** |

Anvil also has `makeUniform`, which Fusion does not list.

Four gaps, and three of them are about *how you grab a point* rather than about
what the cage can do: tangent handles, snapping a vertex onto other geometry, and
switching between the box, control-frame and smooth displays. Display Mode is the
cheapest and the one people reach for constantly.

---

## Design > Assemblies

### Relationships — near complete

| Fusion | Anvil |
|---|---|
| Joint | has |
| Joint types: rigid, revolute, slider, cylindrical, pin-slot, planar, ball | has, all seven |
| As-Built Joint | has |
| Joint Origin | has |
| Rigid Group | has |
| Drive Joints | has |
| Motion Link | has |
| Joint Motion Limits | has |
| **Assembly Constraints** (the older constraint system alongside joints) | **missing** |
| **Duplicate With Joints** | **missing** |
| Edit joints | has |

Anvil's known limit stands: joints are open chains only, and a closed loop is
reported rather than solved.

### Components and external references — mostly missing

| Fusion | Anvil |
|---|---|
| New Component | has |
| Ground to parent | **missing** |
| **Edit In Place** (edit an external component inside the assembly) | **missing** |
| **Update components in an assembly** | **missing** |
| **Derived design features** (reference geometry from another design) | **missing** |
| **Break the link** to an external component, and on assembly contexts | **missing** |
| Switch the design's workflow / enable modeling | **missing** |

This whole group depends on a design being able to reference *another design on
disk*, which Anvil has no notion of: a `.anvil` file is self-contained. It is the
largest single architectural gap in the inventory, and everything in this row
follows from it rather than being separate work.

---

## Designs, documents and data

Fusion's document handling assumes a cloud hub. Anvil's is a `.anvil` file on
disk. Recording it all anyway, because most of it has a local meaning.

| Fusion | Anvil |
|---|---|
| Create and save designs | has |
| Open designs | has |
| Edit a design | has |
| Rename designs | **missing** (rename the file outside the app) |
| Move designs | n/a — folders on disk |
| Copy designs | **missing** as a command |
| Move to Trash / delete | n/a |
| **Update designs** (pull newer versions of referenced components) | **missing**, follows external references |
| **Open older versions** | partial — Anvil keeps versions in the document |
| **View design history and related data** | partial — versions exist, no history view |
| Export designs | has (STL, STEP, 3MF, DXF) |
| Insert designs into another | **missing**, follows external references |
| Add the active design to an assembly | **missing** |
| Import a new version of an existing design | **missing** |
| Recover designs | **missing** — no crash recovery |
| Convert a design's type (parametric or direct) | has (direct modelling mode) |
| Upload designs / web client / component tab | n/a — cloud |
| Supported file formats | partial — see the import and export lists |

**Recover designs is the one to take seriously.** Anvil has an undo stack and
versions inside the document, and nothing that survives the process dying with
unsaved work.

---

## Configurations — missing

One design carrying several variants: rows of a table, each row a set of
parameter values, feature suppressions and component choices, all resolved into
one member of the family. Sheet metal rules can be configured per row too.

Anvil has a `configure.js` module and a Configurations command. What it does
against Fusion's table is *pending*, but the concept is present.

## Generative Design — partial

Fusion's Generative Design is a workspace, not a command, laid out left to right
as the order of work:

| Panel | What it holds | Anvil |
|---|---|---|
| Study | create and manage studies, and their settings | **missing** — one run, no studies |
| Edit Model | a contextual environment with the ordinary modelling tools, used to make **obstacle** and **preserve** geometry | partial — Anvil locks material at fixtures and loads only |
| Design Space | assign a geometry type to each body: design space, preserve, obstacle, starting shape | **missing** — Anvil uses one body |
| Design Conditions | constraints and loads | has |
| Design Criteria | objectives, and **manufacturing constraints** (additive, milling, die casting, 2-axis cutting) | **missing** |
| Materials | several materials tried across a study | partial — one material |
| Generate | pre-check, run, watch progress | partial |
| Explore | a contextual environment for comparing outcomes: filter, sort, scatter plot, compare | **missing** — Anvil produces one result |

Anvil's generative design is one solve of one body against one material with one
objective. Fusion's is a **study**: many outcomes across combinations of
material and manufacturing method, then a tool for choosing between them. The
solver underneath is the part Anvil has; the study and explore layers are what
is missing, and they are most of the value in the workspace.

**Obstacle and preserve geometry is the cheapest thing here.** Anvil already
locks material under fixtures and loads. Letting a whole body be marked keep-out
or keep-in is a small extension of the same flag, and it is what makes generative
output fit an assembly rather than merely be strong.

---

## Render — partial

| Fusion | Anvil |
|---|---|
| Appearance | has |
| Scene settings / environmental lighting | partial |
| **Point Light** | **missing** |
| **Spot Light** | **missing** |
| **Photometric Light** | **missing** |
| Dielectric priority for overlapping transparent volumes | **missing** |
| Insert canvas (image) | has |
| Decal | has |
| In-canvas render / render gallery | partial — Anvil renders by accumulation |
| Render configurations | **missing** |

Anvil renders by jittering the camera and lights and averaging the frames.
**Placeable lights are the gap**: three types in Fusion, each with its own
dialog, against Anvil's fixed rig.

## Animation — partial

| Fusion | Anvil |
|---|---|
| Storyboards | has |
| Steps and a timeline | has |
| Transform components | has |
| **Auto Explode** (one level and all levels) | has |
| Manual explode | partial |
| Callouts / captions | has |
| **Restore home / view changes as animation steps** | *pending* |
| Publish video | **missing** |
| Create a drawing from an animation | **missing** |
| Animate configurations | **missing** |

---

## Simulation — partial

Every Fusion simulation study runs in the cloud on Autodesk's solvers. Anvil's
runs on the machine in front of you, which is a real difference in kind, not
only in coverage.

| Study type | Anvil |
|---|---|
| Static stress | has |
| Shape optimisation | has (as Generative Design) |
| Modal frequencies | **missing** |
| Thermal (steady state) | **missing** |
| Thermal stress | **missing** |
| Structural buckling | **missing** |
| Nonlinear static stress | **missing** |
| Quasi-static event simulation | **missing** |
| Dynamic event simulation | **missing** |
| Electronics cooling | **missing** |
| Plastic injection moulding | **missing** |
| Contacts between bodies in a study | **missing** |

Anvil has one of the eleven, plus shape optimisation. Its static stress reports
displacement and von Mises; Fusion's also reports safety factor, reactions and
failure criteria.

**Modal frequencies and buckling are the two that fall out of what is already
built.** Both are eigenvalue problems on the same stiffness matrix the static
solver assembles, so the meshing, the element and the boundary conditions are
all done. Thermal is a different physics but a simpler one: the same grid, one
value per node instead of three.

---

## Drawings — missing entirely

Anvil has no drawing workspace. This is the largest block of work in the whole
inventory, and the one a printed part arguably needs least, but it is also the
only way a design leaves the machine as a document rather than as geometry.

A drawing is made from a design or from an animation, on sheets, with templates
carrying title blocks, borders, document and sheet settings, placeholder views
and placeholder tables.

| Panel | Commands |
|---|---|
| Create | Base View, Projected View, Section View, Detail View, Break View, Create Sketch |
| Modify | Move, Rotate, Delete |
| Geometry | Center Line, Center Mark, Center Mark Pattern, Edge Extension, Create Sketch |
| Dimensions | Dimension, Ordinate, Linear, Aligned, Angular, Radius, Diameter, Baseline, Chain, Dimension Break |
| Text | Text, Leader |
| Symbols | Surface Texture, Feature Control Frame, Datum Identifier |
| Insert | Image |
| Tables | Table (parts list), Balloon, Bend Identifier, Renumber, Align Balloon |
| Export | PDF, DWG, sheet as DXF, table as CSV |

Anvil has one adjacent piece already: sheet metal flat patterns export to DXF.
The bend identifier in the Tables panel is the drawing-side counterpart of that.

---

## Manufacture (CAM) — missing entirely

A separate application inside Fusion, not a set of commands to bolt on. Recorded
so the inventory is complete.

Machines, tool library, setups, then four process families: **Milling**,
**Turning**, **Additive**, **Fabrication** (cutting). Operation parameters,
toolpath simulation, and post processing to G-code.

For a 3D-printed-parts tool the only part with an obvious pull is the additive
side, and even there the market is served by slicers. Anvil exports STL and 3MF,
which is where it hands over.

## Electronics (PCB) — missing entirely

Schematic capture, PCB layout, library management, and the 3D coupling between
board and enclosure. A separate application again. The one part that touches
Anvil's world is fitting an enclosure around a board, which today means importing
the board as a mesh or step.

## Hubs, projects, folders and members — missing entirely

The whole cloud data layer, and the part of Fusion that Anvil deliberately is
not: `.anvil` files are plain JSON on disk with no account and no server.

Hubs · projects, roles and folders · the Data Panel and Home tab · create a
project · access projects and folders · project details · create, rename and
trash folders · find project members · search across projects · pin projects ·
track project activity · wiki pages · project administration · member groups ·
permissions.

Two things in here have a local meaning and are worth stealing:

- **Search across everything**, rather than opening files to find out what is in
  them. Anvil has a command search; it has no search over saved documents.
- **Track project activity**, which locally is "what did I change and when".
  Anvil keeps versions inside a document already, so a per-file history view is
  a short step.

The rest — roles, members, permissions, wikis, the web client — has no meaning
without a server, and building one is a different product.

## Advanced capabilities, tokens, Autodesk Assistant, Fusion MCPs — n/a

Extensions gated by subscription, cloud credits for solving, an in-app assistant,
and Fusion's own Model Context Protocol servers. Commercial and cloud
scaffolding rather than modelling features. The Design Extension is the one that
matters for reading the rest of this file: **Boss, Snap Fit, Rest and Lip and
Groove all sit behind it**, so they are not part of what a Fusion subscription
gives you by default.

---

## Fusion-wide: Inspect and Analysis — near complete

| Fusion | Anvil |
|---|---|
| Measure | has |
| Interference and coincident faces | has |
| Curvature comb on edges | has |
| Curvature map on surfaces | has |
| Zebra | has |
| Draft analysis | has |
| Accessibility | has |
| Minimum tool radius | has |
| Section analysis (a 3D section view) | has |
| Centre of mass and mass properties | has |
| Find similar components | has |
| **Surface continuity** | **missing** |
| **Isocurve analysis** | **missing** |
| **Environment map reflections** | **missing** |
| **Validate** | **missing** |
| **Colour code components and features** | **missing** |
| Fastener stack analysis | **missing** (Design Extension) |

Anvil also has a wall-thickness reading and a design-advice pass, which Fusion
does not carry here.

## Fusion-wide: Parameters — partial

| Fusion | Anvil |
|---|---|
| User parameters with name, expression, value and comment | has |
| Model parameters listed per component and feature | partial |
| Unit type per parameter | has |
| **Text parameters**, joined with `+` | **missing** |
| **Name a parameter inline** by typing `Width=50` into any field, which creates it and adds it to favourites | **missing** |
| Favourites | **missing** |
| **Automatic Compute off** while editing several parameters | **missing** |
| **Import and export parameters** | **missing** |

**Typing `Width=50` into a field to create the parameter there and then is the
one to steal.** It removes the trip to a dialog entirely, and Anvil's fields
already evaluate expressions, so the machinery is present.

Automatic Compute is the other: Anvil rebuilds on every keystroke in the
parameters table, which on a heavy part is the difference between editing five
numbers and waiting five times.

## Fusion-wide: Construction geometry — complete

Every plane, axis and point Fusion offers, Anvil has: offset, at an angle,
tangent, midplane, through two edges, through three points, perpendicular,
tangent at a point and along a path for planes; through a cylinder, through two
planes, through two points, along an edge and normal to a face for axes; at a
vertex, where two edges meet, at three planes, at a circle centre, at an edge and
plane, and along a path for points. Plus a user coordinate system and joint
origins.

The only thing listed and not found: **showing or hiding plane names in the
canvas**.

## Fusion-wide: Selection — partial

| Fusion | Anvil |
|---|---|
| Select objects, and selection modes for several | has |
| Select by boundary | has (seed and boundary) |
| Select by size | has |
| Invert the selection | has |
| Seed and boundary | has |
| Selection priority filters | partial |
| Selection filters | has |
| **Select by name** | **missing** |
| **Selection sets** (name a selection and come back to it) | **missing** |

Anvil adds select similar and select tangent run, which Fusion carries as the
Tangent Chain setting instead.

**Selection sets are the one worth having**, because they are what makes a
thirty-edge fillet survive being edited: name the set once, and every later
feature that wants those edges refers to the name.

---

## Crawl status

**Read page by page:** Solid Create (extrude, revolve, sweep, loft, rib, web,
emboss, primitives, coil), Solid Modify (fillet, chamfer, draft, shell, combine,
split body, split face, replace face, offset face, align, silhouette split,
boundary fill, press pull, edit face, tangent chain), Move/Copy, Plastic (boss,
snap fit), Sketch palette and 3D sketch, Surface create and modify lists, Mesh
modify list, Sheet metal rules and flanges, Assemblies relationships and designs,
Generative Design toolbar, Simulation study types, Drawing workspace.

**Also read:** the Form create and modify toolbars in full, the base/edge/contour
flange reference, parameters, the analysis and inspect list, construction
geometry, and selection.

**Listed but not read option by option:** each surface tool's own dialog, the
lofted flange and hem references, rest and lip, scale, delete face,
configurations, the three render light dialogs, the animation commands, and the
remaining Fusion-wide pieces (timeline behaviour, appearance and physical
materials, view settings, keyboard shortcuts, preferences). These are all cases
where Anvil already has the command and only the option list is unconfirmed.

**Deliberately not expanded:** Manufacture, Electronics, and the cloud data
layer, which are separate applications rather than commands.

Design: Solid (remainder) · Design: Surface · Design: Mesh ·

## How to read a page

`https://help.autodesk.com/view/fusion360/ENU/?guid=<id>` — ids are readable
(`SLD-REF-EXTRUDE`, `SLD-FILLET-SOLID`) but not all of them; some only exist as
`GUID-<uuid>`, which you get from the `href` of a search result or of a parent
page's child list. Search by URL: `?query=<terms>`. The in-page search box does
not navigate when driven; the query URL does. Wait four or five seconds after
navigating before reading the text, or the page is still building.

Traverse by parent page: every reference page names its parent, and every parent
page lists its children. That is a complete walk and much cheaper than expanding
the contents tree, which freezes the renderer if you click every node at once.
