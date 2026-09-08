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

Crawl progress is tracked at the bottom. Sections marked *pending* have not been
read yet.

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
| **Project Axis** | project the axis onto the profile's sketch plane, or leave it where it is | **missing** |
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
| Objects To Cut | Auto-Select, # Bodies | **missing** |
| New Component | | has |
| Keep Tools | | has |

### Silhouette Split — partial

| Option | Values | Anvil |
|---|---|---|
| View Direction | the direction the silhouette is taken from | has |
| Target Body | | has |
| Operation | Split Faces Only, Split Shelled Body, Split Solid Body | **missing** — Anvil always splits the solid |

### Scale — *pending* (Anvil: factor or per-axis, about the middle, the origin, or a point)

### Tangent Chain — a setting, not a command — **missing throughout**

Checked by default in Fillet and Chamfer, and present in Sweep, Draft, Loft and
Thin Extrude. When on, picking an edge takes every edge tangentially connected
to it, and a rolled-back edit that adds edges updates the later feature's
selection to match. Anvil has no equivalent anywhere, and on any rounded part it
is the difference between one click and thirty.

### Press Pull — partial, and worth reading closely

Press Pull is not a feature of its own. It is a router: what you click decides
which dialog opens.

| Clicked | Fusion opens | Anvil |
|---|---|---|
| Sketch profile | Extrude | has |
| **Edge** | **Fillet** | **missing** |
| Face | Offset Face | has |

Anvil's arrow-on-the-selection gesture is the same idea and already routes a
profile to an extrude and a face to a press pull. **Clicking an edge does
nothing.** Routing an edge to a fillet with the same drag-or-type manipulator is
a small piece of work in a part of the app that is already built, and it is the
third of the three things Press Pull is for.

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
| Flip | invert 180 degrees | needs checking |
| Angle | rotate 90 degrees per click | **missing** |

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
| Inside Thickness / Outside Thickness | two values when the direction is Both | partial — one thickness |
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

## Sections still to crawl

Design: Sketch · Design: Solid (remainder) · Design: Surface · Design: Mesh ·
Design: Form · Design: Sheet Metal · Design: Assemblies (joints, components,
contact sets, motion) · Designs (documents, timeline, parameters, appearance) ·
Configurations · Generative Design · Render · Animation · Simulation ·
Manufacture · Electronics · Drawings · Hubs, projects, folders and members ·
Advanced capabilities · Tokens · Autodesk Assistant · Fusion MCPs ·
Get Started (interface, workspaces, basic tasks)

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
