# Fusion feature inventory

Every command Fusion has, the options it carries, and where Anvil stands against
it. Compiled by reading Autodesk's own Fusion help, one reference page at a time,
rather than from memory. This is a working index for parity: command names and
option names, in compressed form, with a status. It is not a copy of Autodesk's
documentation, and it is not a substitute for reading the reference page for a
command before building it — read that page when the work starts, because it
fixes the option set and the ordering.

**A warning about the Anvil column.** The Fusion half of this file was read page
by page. The Anvil half was written partly from memory, and that is where it is
wrong. A full scripted cross-check has now been run over all 353 status rows in this
file, and ten bad entries were found and fixed. What follows is the record of
them, because the same mistake will be easy to make again. Listed as gaps and were not: Align's flip and angle, Combine's Objects To Cut,
Form's Display Mode, Split Body's Extend, the environment map analysis, **Coil**,
**mesh texture extrude**, **Form's Edit By Curve**, and three of Sweep's five
listed gaps (**profile scaling, partial distance and orientation**, all of which
are in `sweepFields` under those exact names). Listed as present and is not:
Centerline.

**How the check works, so it can be re-run.** Build a bag of every term Anvil
exposes: `data-cmd` names and ribbon labels from `index.html`, and `case '...'`,
`key: '...'`, `label: '...'`, select option labels and exported function names
from every file in `src/renderer`. That is about 2,800 terms. Then for each row
claiming a gap, check whether any single term contains all the distinctive words
of the row's name; and for each row claiming Anvil has something, check whether
any word of it appears at all. The first direction found nine errors, the second
found one. Expect roughly two thirds of the flags to be substring noise, and
read each one rather than trusting it. **Grep the source before building anything from
this file.** Every row corrected so far says so.

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
| Tangent Chain | thin extrude only | has, v2.74.0. A thin extrude can build its wall from the open curves of a sketch rather than from a closed profile, and the chain decides whether the run carries through a corner or stops at it |
| Start | Profile Plane, Offset, Object | has |
| Direction | One Side, Two Sides, Symmetric | has |
| Measurement | Half Length, Whole Length (symmetric only) | has |
| Extent Type | Distance, To Object, All | has |
| Extend | To Selected Face, To Adjacent Faces, To Body, Through Body | has |
| Offset | from profile plane, or from the object reached | has |
| Flip | all extent only | has |
| Taper Angle | per side | has |
| Wall Thickness / Wall Location | Side 1, Side 2, Center | has |
| Operation | Join, Cut, Intersect, New Body, New Component | has. The cross-check found this row wrong: Extrude, Revolve, Sweep and Loft all offer New Component and register the component with the document |
| Objects To Cut | Auto-Select, # Bodies | has |

Fusion auto-selects the profile when only one is visible in the design. Anvil
does this as of v2.28.0. What is actually left here is **Tangent Chain** on
thin extrude.

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
| Type | Single Path, Path + Guide Rail, Path + Guide Surface, Solid Sweep | has, v2.66.0 |
| Profile / Body | profile or planar face; a solid for Solid Sweep | has, v2.66.0 |
| Path | | has |
| Guide Rail | scales and orients the profile along the path | has |
| Chain Selection | pick tangentially connected geometry as one | has, v2.41.0, on the path; on by a tick box |
| Distance | fraction of the path, 0 to 1 | has |
| Taper Angle, Twist Angle | | has |
| Extent | Perpendicular To Path, Full Extents | has, v2.53.0, on Path + Guide Rail where Fusion has it |
| Profile Scaling | Scale, Stretch, None | has |
| Orientation | Perpendicular, Parallel, Aligned | partial — the first two. Aligned belongs to Solid Sweep, where the body carries its own orientation from the start of the path, which is what this does |
| Operation / Objects To Cut | as Extrude | partial |
| Analysis tab | None, Zebra, Curvature Map, Isocurve | **missing** here (Anvil has zebra elsewhere) |

Extent was worth reading Fusion's own words for rather than guessing at, and
they are not what the name suggests: "Perpendicular To Path extends the swept
body to the point along the path that is perpendicular to the end of the guide
rail." It is not about how the ends are cut. It is about where a guided sweep
stops when the rail runs out before the path does, which is why Fusion puts it
under Path + Guide Rail and nowhere else, and why Anvil now does too.

### Loft — partial

| Option | Values | Anvil |
|---|---|---|
| Profiles | sketch, edge or face, in an order you can change | has, v2.38.0 |
| End condition (per profile) | Free, Direction, Tangent, Smooth, Sharp, Point Tangent | partial — connected, tangent, and Direction as of v2.41.0 |
| Guide Type | Rail, Centerline | has, v2.58.0 |
| Rails / Guide | any number of rails; one centerline | has (rails) |
| Chain Selection | adjacent edges taken as one profile | has, v2.58.0. One click takes the whole run that carries on from it, the same as a fillet |
| Closed | join the first and last profile into a loop | has |
| Takeoff Weight / Takeoff Angle | with the Direction end condition | has, v2.41.0 |
| Tangency Weight | with Tangent, Smooth or Point Tangent | has (start and end weight) |
| Tangent Edges | Merge, Keep | has, v2.65.0 |
| Operation / Objects To Cut | | partial |
| Analysis tab | None, Zebra, Curvature Map, Isocurve | **missing** here |

The Direction end condition takes a picked direction as well as an angle, and
that is not a flourish. Which way to lean has to be given rather than inferred:
two sections stacked on one axis have no preferred side, so a guess from where
they sit comes out as no lean at all for the commonest loft there is, and every
value of the angle would look like it did nothing. Failing a picked direction
the line to the neighbouring section is used, which is right for sections that
are offset from each other and honest about doing nothing when they are not.

The angle is measured from the section's own plane the way Fusion measures it,
so ninety degrees is straight out of the plane and reproduces the tangent case
exactly. That is pinned by a test, because if the two disagree then the angle
is being measured off the wrong thing and every value of it is wrong by the
same amount.

Tangent Edges took two goes and the first is worth writing down. Tagging the
bands as their own geometry does not work: the boolean step tags the whole tool
with the feature's own name to give its faces provenance, so anything tagged
before it is overwritten. Labels survive, but a label says "these triangles are
one face and nothing else joins them", so labelling purely by band merged each
band's sides and top into a single face. The label carries both in the end:
which face the angle put the triangle in, and which band it falls in.

Fusion also maps matching corners between closed sections with the same number
of corners, so the orientation is worked out rather than guessed. Worth knowing:
that is the thing that makes a loft between two rectangles not twist.

Chain selection made three separate versions of that mistake, all of which came
back as a closed solid of the wrong shape, which is the hard kind to see.

A section is written in its own plane's axes, and a plane fitted to a run of
edges gets whatever axes fall out of its normal. Those can sit at any angle to
the ones the section beside it uses, and the loft pairs the two by coordinate,
so a square written in a frame turned forty five degrees is a square turned
forty five degrees: the loft twists and pinches. It came out at 2500 where the
frustum is 5833, with both ends the right size and in the right place. The
world loop is kept now and the coordinates are worked out again in the
neighbour's frame.

Then the orientation. A sketch faces the way somebody drew it. A fitted plane
and a face's plane both face whichever way fell out of the geometry, and the
underside of a box faces down while the loft runs up. Sections that disagree
about which way is up build the loft inside out: exactly the right volume,
negative. Both kinds are turned to agree with the way the sections are stacked;
sketches are left alone.

And the centreline. With two sections there is nothing in between for a curve to
move, so it did nothing at all. Sections are put along the curve now, each one a
blend of the two ends sitting where the curve is, which is what makes a lofted
duct go round a bend. A rail is still the other thing entirely: it says where
the outline should reach, so the sections grow to meet it, and scaling a section
out to meet a curve through its own middle would collapse it.

### Rib — partial

| Option | Values | Anvil |
|---|---|---|
| Presets | last used, defaults, save, rename, delete, set as default | has, v2.40.0, on every dialog |
| Profile | an open sketch profile | has |
| Direction | Symmetric, One Direction | has, v2.30.0 |
| Thickness | | has |
| Extent Type | To Next, Depth | has, v2.51.0 |
| Depth | | has |
| Flip Direction | | has |
| Draft Angle + Draft Pull Direction + flip | | partial — angle and flip, v2.51.0. The pull direction is the sketch normal and is not separately settable. **Not in the shipped dialog** either, see below |
| Fillet Radius | a fillet at the foot of the rib | has, v2.67.0. The edges are found rather than picked: a face knows which feature made it, so an edge with the rib on one side and something else on the other, and concave, is the foot. Web has the same row |
| Direction of the wall | parallel to the sketch plane | has, v2.56.0, as a setting. **See the note below: Fusion's rib is not what this built first** |

**The shipped dialog is five rows and Anvil has all five.** Kevin sent a
screenshot of it: Profile, Thickness, Thickness Direction, Extent Type (To Next
or Distance), Flip Direction. The Start row this file used to list is not there
at all and has been deleted; it came from the reference page and does not
appear in the command. Draft angle and fillet radius are not in that dialog
either, so the rows for them are kept only as a note that the reference page
mentions them.

**The direction was wrong, and it took reading the tooltip to see it.** Fusion's
Rib "is extruded in a direction parallel to the sketch plane" and "to the
nearest faces on a solid body". The curve is drawn edge on, standing in the
plane of the rib: the thickness goes across the plane and the wall hangs from
the curve until it lands on the part. That is the triangular gusset between a
wall and a floor, which is what anybody means by a rib.

What Anvil built instead thickens the curve within the plane and extrudes along
the normal: a wall standing on a footprint drawn from above. That is a real and
useful thing, and it is what Fusion calls a Web, which is also what this file
said Anvil's Web was. Both commands were building the same shape in the same
direction; only their extent settings differed.

So Rib takes a direction as of v2.56.0 rather than being corrected outright.
Out of the plane stays the default, because changing it would move every rib
already built. Along the plane is Fusion's, and the note in the dialog says the
plane has to cut through the part rather than sit on a face of it, since the
wall straddles its own plane.

Presets were a Fusion-wide idea Anvil had nowhere, and shipped in v2.40.0 on
every dialog that has anything to save. Rib is where the reference documents
them, but they belong to the dialog machinery rather than to Rib.

Two rules are what make them safe rather than merely convenient, and both are
tested.

**A preset carries settings and never geometry.** What was picked belongs to
the part it was picked on. Rows filled by clicking in the canvas are left out,
along with the buttons, the notes, and the synthetic rows a dialog builds for
itself.

**A preset only fills rows the feature already has.** One saved off a fillet
with three edge sets, applied to a fillet with one, fills that one and stops.
Writing `sets.1` into a feature that has no second set would put a half made
object in the array and the rebuild would work from it.

One deliberate difference from Fusion: **last used is recorded and offered in
the list, but is never applied on its own.** Only a preset explicitly marked as
the default opens a dialog. Extrude opens at a distance of zero on purpose so
that nothing appears until a length is given, and quietly restoring the last
distance would undo that for everyone who never asked for a preset at all.

Presets are filed by dialog rather than by feature type, so a Box preset does
not turn up in a Cylinder dialog. They live in the renderer's own storage for
now, which for a desktop application is a file in the user data folder. When
profiles arrive they move onto the profile, and `presetStore` is the one place
that has to change.
### Web — near complete

Same option set as Rib, but perpendicular to the sketch plane rather than
parallel. Anvil has profile, thickness, direction, extent type (To Next or
Depth), depth, flip, draft angle and extend curves, and **Fillet Radius** since
v2.67.0, which is the rib's own foot blend on the same finding-by-provenance.
Presets arrived app-wide in v2.40.0.

Note the pairing: Rib is parallel to the sketch plane, Web is perpendicular.
Anvil's Web has To Next and its Rib does not, which is the wrong way round from
the point of view of matching.

### Emboss — near complete

| Option | Values | Anvil |
|---|---|---|
| Sketch Profiles / Faces | | has |
| Tangent Chain | | n/a — Emboss takes a profile or a face, and a run of curves has no area to emboss. The option belongs to the thin extrude, where it is built |
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
| Type | Fillet, Rule Fillet, Full Round Fillet | has. Rule fillet v2.48.0, full round v2.50.0 as its own command |
| Selection sets | several, each with its own radius and settings | has |
| Radius Type | Constant, Chord Length, Variable, Asymmetric | has, v2.37.0, plus a hold-line type Fusion does not have |
| Continuity | Tangent (G1), Curvature (G2) | has, v2.37.0 |
| Tangent Chain | select tangentially connected edges as one | has, v2.35.0, per set and on by default |
| Tangency Weight | | has, v2.37.0. How hard the G2 curve is pulled toward the corner |
| Radius Points | radius and position along one edge (variable only) | has |
| Corner Type | Rolling Ball, Setback | has, v2.65.0. Same construction, larger ball: the sphere is the corner, so a bigger one sits further back along every edge |
| Rule | All Edges, Between Faces/Features (rule fillet) | has. All Edges v2.48.0, between faces v2.64.0. One list of faces rather than Fusion's two boxes: an edge between two faces is between them whichever box each was put in |
| Round/Fillets | Rounds and Fillets, Rounds Only, Fillets Only (rule fillet) | has, v2.48.0 |
| Center Faces / Side 1 / Side 2 | full round fillet | partial — the centre face is picked, the two sides are found from it |

Full Round Fillet is its own command rather than a type on the fillet dialog,
because it takes a face and not edges and has no radius to type. The radius is
whatever makes the round meet both sides, which is half the distance between
them; any other value leaves a flat in the middle or overshoots.

It falls out of the ordinary fillet exactly. Round both edges of the centre
face at half the gap and the two arcs share an axis: each sits half the gap in
from its own side and half the gap below the top, which is the same line. So
the two sweeps are one cylinder and their union is the full round, with nothing
left of the face between. The test checks that nothing flat is left on top,
because that is the whole difference between this and filleting the two edges
at some smaller radius.

Fusion asks for the centre face and both sides. The sides are the faces across
the centre face's two longest edges, so they are found rather than asked for,
and where they are not a parallel pair the answer is a refusal naming the
reason rather than a guess.

Asymmetric and G2 both shipped in v2.37.0 and both live in the same place, the
two dimensional corner profile every fillet is swept from. Asymmetric is a
rational quadratic through the two tangent points with the corner as its
control point, at a weight of sin(theta / 2), which is the value that
reproduces the circular arc exactly when the two radii match: so switching a
set to asymmetric and giving it the same radius twice changes nothing about the
part, and the test pins that. G2 is a quintic whose first three control points
lie on the line from one tangent point to the corner and whose last three lie
on the line from the corner to the other. Three collinear control points at an
end is exactly the condition for zero curvature there, and the faces it lands
on are flat, so both sides read zero and there is no step to catch the light.
Tangency weight is how hard that curve is pulled toward the corner.

The rolling ball dropped at corners where several fillets meet is switched off
for both. It is a ball: one radius, tangent to all three faces. An asymmetric
blend is not a ball at all and a curvature continuous one has no single radius
to give it, so a ball there would stand proud of the sweeps it is meant to
join.

Rule Fillet with the rule "All Edges" is Fusion's named way to round a whole
part. That was exactly what Anvil used to do silently when nothing was picked,
and then what it hid behind an `all` flag on the set that nothing in the dialog
could reach. It is a type in the dropdown as of v2.48.0, alongside the filter
Fusion calls Round/Fillets.

That filter is worth knowing the language of: in Fusion a **round** is a convex
edge and a **fillet** is a concave one. So "rounds only" softens the outside
corners and leaves the inside ones sharp, which on a printed part is usually
what is meant, and "fillets only" does the opposite and adds material rather
than taking it away. The test pins that difference by sign: on an L, rounds
only comes out smaller than the plain part and fillets only comes out bigger.

### Move/Copy — partial

| Option | Values | Anvil |
|---|---|---|
| Move Object | Components, Bodies, Faces, **Sketch Objects** | partial — bodies and faces, v2.42.0 |
| Move Type | **Free Move**, Translate, Rotate, Point to Point, Point to Position | partial — four of five. Free Move is explicitly not captured parametrically in Fusion either |
| Direction | Component XYZ, Design XYZ, Pick Direction (along an edge or axis) | has, v2.36.0. An edge, a flat face or an origin plane, plus one distance, and a row to flip it |
| Set Pivot | centre of rotation within the selection | has, v2.36.0. Clicked in the canvas, snapping to corners and hole centres the same way point to point does; typing three numbers is still there |
| X/Y/Z Distance, X/Y/Z Angle | | has |
| Create Copy | move a copy instead of the original | has, v2.36.0 |

Free Move is explicitly not captured parametrically in Fusion, which is worth
knowing before matching it.

Moving faces is a straight move only, and says so in the dialog rather than
after OK. The face is swept into a prism along the move and the prism is added
to or taken from the body, which is the same construction Press Pull uses; the
difference is that the sweep leans the way the move goes rather than standing
square to the face, so a wall pushed up and over comes out slanted instead of
stepped. Turning a face about a point is a different construction and is
refused, and so is copying one, because a copy of a face is not a body.

A move square to the face's own normal is refused too. Sliding a face along
inside its own plane changes nothing about the solid, so it is not a small
move, it is no move at all, and saying so beats building nothing and looking
broken.

### Chamfer — partial

| Option | Values | Anvil |
|---|---|---|
| Selection sets | several, each with its own type, distance and angle | has |
| Type | Equal Distance, Two Distance, Distance And Angle | has |
| Edges/Faces/Features | | partial — edges only |
| Distance, Angle | | has |
| Tangent Chain | | has, v2.35.0 |
| Corner Type | Chamfer, Miter, Blend | has, v2.56.0. Fusion's wording for Blend is "blends beveled edges into adjacent edges", so it is the chamfered corner with a sphere put back into it: round where the facet is flat, passing exactly through the same three tangent points so the bevels run into it without a step |

### Draft — partial

| Option | Values | Anvil |
|---|---|---|
| Type | Fixed Plane, Parting Line | has, v2.65.0 |
| Flip Pull Direction | | has, v2.29.0 |
| Pull Direction | a plane or face | has (neutral plane) |
| Parting Tool | plane, face, edge or sketch curve | partial — a plane, a face or a run of model edges. A sketch curve that is not on the part is *pending* |
| Faces | | has. A curved face is refused now rather than taken and then silently skipped |
| Tangent Chain | | has, v2.36.0. The run is cut back to the flats, because a curved face has no line to lean about and taking one would put a face in the list that could never move |
| Angle | one, or Angle 1 and Angle 2 for two-sided | has |
| Draft Sides | One Side, Two Side, Symmetric | has, v2.29.0. Two Side takes an angle each now; what used to be called two sides was the symmetric case and old documents read back as that |
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
| Operation | Split Faces Only, Split Shelled Body, Split Solid Body | has, v2.60.0. Anvil's single body behaviour covers both body cases, and Split Faces Only is its own setting |

### Scale — *pending* (Anvil: factor or per-axis, about the middle, the origin, or a point)

### Tangent Chain — a setting, not a command — has, v2.35.0

Checked by default in Fillet and Chamfer, and present in Sweep, Draft, Loft and
Thin Extrude. When on, picking an edge takes every edge tangentially connected
to it, and a rolled-back edit that adds edges updates the later feature's
selection to match.

Fillet and Chamfer carry it per set now, on by default. Picking one edge takes
every edge that carries on smoothly from it, and picking one that is already in
takes its whole run back out, so the gesture still undoes itself.

Draft has it too, as of v2.36.0, and that one is the face walk rather than the
edge walk: a moulded wall is one wall by eye and several faces in the topology
once its corners have been rounded. The run is cut back to the flats, because a
draft leans a face about the line where it meets the neutral plane and a curved
face has no such line. Taking one would have put a face in the list that could
never move. For the same reason a curved face is now refused outright rather
than taken and then silently skipped.

Shell has it as of v2.37.0, and that one keeps the curves in the run: the mouth
of a shelled part is usually one surface the topology holds as several, a
rounded rim being the ordinary case, and opening a rounded face is a perfectly
ordinary thing to want.

Still to do: Sweep, Loft and thin Extrude have the same setting in Fusion and
do not have it here.

`select.js` has two runs and they answer different questions. `tangentRun` walks
across *faces* that meet smoothly, which is what the Select command uses.
`tangentEdgeRun` walks along *edges* that continue each other, which is what a
fillet wants: two edges continue if they share an end and leave it in nearly
opposite directions, so a corner where four edges meet does not drag the whole
cage in.

Still to do: Sweep, Draft, Loft and thin Extrude have the same setting in Fusion
and do not have it here.

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
| Splitting Tool(s) | **several tools at once** | has, v2.39.0 |
| Extend Splitting Tool(s) | on by default; uncheck when the tool already crosses the body | n/a — Anvil splits with an unbounded half-space, so the tool always crosses the body |

Anvil also offers a Result of two bodies or keeping only the near side, which
Fusion does not have here. With several tools that becomes the near side of
every one of them, so two planes leave the corner they share.

The tools are applied in turn and the pieces from one cut are what the next
cuts, which is the point of doing it in one feature: a box crossed by three
planes comes out as eight parts, not four. A tool that misses a piece carries
that piece through untouched rather than dropping it, because another tool may
still cut it, and the feature only complains when nothing cut anything.

### Align — partial

| Option | Values | Anvil |
|---|---|---|
| Object | Bodies, Components | partial — bodies |
| From / To geometry | point, line, plane, circle, or coordinate system | has, v2.64.0, less a coordinate system. A flat face, a round face, a circular edge, a straight edge or a plane: what align needs of any of them is a place and a direction, and those all have both |
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
| Split Type | Split with Surface, Along Vector, **Closest Point** | has, all three. Surface and Along Vector v2.62.0, Closest Point v2.67.0: every point of the tool goes to the nearest point of the face, so the pattern wraps rather than being cast, and each triangle is swept along its own normal because on a curved face they no longer share one |
| Extend Splitting Tool | | n/a — the half-space is unbounded, so the tool always crosses the face |

One limit worth knowing, said in the dialog rather than found out: a sheet
swept along a direction lying in its own plane has no volume to project with,
so a tool standing edge on to the direction is refused. A tool has to face the
way it is being projected, at least somewhat.

Two sides of the seam are marked as their own geometry before they go back
together, which they were not before: without that the topology welds them into
one face again and nothing has been split at all. Split Face by a plane already
did this; by a surface it did not, so that path was quietly doing nothing.

Fusion notes the point of it: a split face isolates an area so Draft or Press
Pull can act on part of a face. Worth remembering, since it makes Draft's
parting-line work.

### Shell — partial

| Option | Values | Anvil |
|---|---|---|
| Type | Sharp Offset, Rounded Offset | has, v2.52.0 |
| Object | Faces to remove, or a whole Body with no opening | has |
| Direction | Inside, Outside, Both | has |
| Inside Thickness / Outside Thickness | two values when the direction is Both | has, v2.29.0 |
| Tangent Chain | | has, v2.37.0. Curved faces are kept in the run here, unlike Draft: opening a rounded face is ordinary |

### Boundary Fill — partial

Planes, surfaces and bodies are the tools; the enclosed volumes where they cross
are the cells; you choose which cells to keep.

| Option | Values | Anvil |
|---|---|---|
| Select Tools | planes, surfaces, bodies | has |
| Select Cells | | has |
| Operation | Join, Cut, Intersect, New Body, New Component | has, v2.45.0 |
| Objects To Cut | Auto-Select, # Bodies | has, v2.45.0 |

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
| Coil | has |

### Coil — partial

Listed here as missing and is not: `startCoil` is on the Solid tab. Its option
set against Fusion's is *pending* an option-by-option read.

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

Anvil also has a modelled thread, which is a harder version of the same sweep.

Coil's New Component was half built and was found while checking the row above:
the operation was offered, the rebuild put the body in a component named after
the feature, and nothing ever added a matching entry to the document. The coil
came out of the browser tree and could not be jointed to anything. Fixed in
v2.36.0.

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
| Linetype (convert geometry to another line type) | has, v2.36.0. Normal, construction and centreline, converting what is selected and switching the mode for new geometry when nothing is |
| Construction | has |
| Centerline | has, v2.36.0. This row was the one the cross-check found marked "has" when nothing in the source mentioned one; it is built now |
| Look At (turn the camera square to the sketch plane) | has, v2.31.0. Also works on a selected flat face |
| Sketch Grid on/off | has |
| Snap on/off | has |
| Slice (cut through bodies at the sketch plane while sketching) | has, v2.34.0. The cut is not capped: you see into the shell rather than at a solid cross-section, which wants stencil work |
| Show Profile | has |
| Show Points / Dimensions / Constraints | partial |
| Show Construction Geometries | has, v2.33.0 |
| Show Projected Geometries | has, v2.33.0 |
| 3D Sketch on/off | has |

**Slice was the one worth having** and shipped in v2.34.0. Which half is thrown
away follows the camera, so it is always the half in front of you, and it clears
itself when the sketch closes.

One honest limit: a clipped solid is an open shell, because the cut leaves a
hole rather than a capped face. Both sides are drawn while the slice is on, so
you see the inside of the far shell where the cap would be, which reads as a cut
part rather than a vanished one. A real cap wants stencil work.

### Drawing gestures — has, v2.57.0

Not a row on any Fusion reference page, and the thing that makes its sketcher
feel quick. Two of them, both from a screenshot of Fusion mid-sketch.

**Typing a size instead of aiming one.** Boxes beside the cursor while a shape
is half made, and a value typed into one locks it so the axis snap stops pulling
the point off what was just typed. Anvil had this on lines, rectangles and
circles; arcs and polygons have it now too, saying radius or across-corners
rather than length, which is the number anybody actually has for those.

**An arc swept out of the end of a line.** Press on the end of the chain you are
drawing and drag, and you get a tangent arc, and then you are back on lines from
where it finished. Anvil had a Tangent Arc tool: stop, switch, click the end,
click the finish, switch back. Four actions where this is one drag, and the
chain broken in the middle of it. A press that does not move is still an
ordinary next point, so the gesture costs nothing when it was not meant.

### Sketch lifecycle — *pending*

Create a sketch · start on a plane or face · construction and centerline
geometry · finish · edit · **copy a sketch** · **redefine a sketch plane** ·
**export as DXF**. Anvil has create, start on a plane or face, construction,
centreline, finish and edit. Copy, redefine the plane, and DXF export are
*pending* confirmation.

Centreline was the one row the cross-check found listed as present and absent in
the source, and it shipped in v2.36.0. It is a construction line that also says
what the part is about: longer dashes and a colour of its own, construction
geometry underneath so it never closes a profile, offered first by the sketch
mirror, and taken as the axis by a Revolve opened on a sketch that has exactly
one. Two centrelines is a question and it asks rather than guessing.

Revolve gained the other half of that in the same version: one profile visible
on screen is now taken without being asked for, which is the rule Extrude
already followed and which Fusion states for both.

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

### Modify — complete

| Fusion | Anvil |
|---|---|
| Fillet or chamfer surface edges | has, v2.68.0 |
| Trim | has |
| Untrim | has |
| Extend | has |
| Stitch | has |
| Unstitch | has |
| Reverse normal | has |

Filleting and chamfering surface edges arrived in v2.68.0 and it is the same
command as on a solid, with a different builder behind it. A sheet has no inside
for a boolean to work on, so the blend is built as surface geometry: both faces
are trimmed back to where it meets them and a strip is stitched into the gap.
The options that only mean something on a solid, which is variable radius, hold
lines, chord length, asymmetry and the chamfer corner types, are not offered on
a surface rather than being quietly ignored.

---

## Design > Mesh

| Fusion | Anvil |
|---|---|
| Direct Edit | has |
| Remesh | has |
| Reduce | has |
| Plane Cut (trim or split with a plane) | has |
| Shell | has, v2.43.0 |
| Combine | has (merge) |
| Smooth | has |
| Reverse normal | has |
| Erase and Fill | has |
| Align to a plane | has, v2.44.0 |
| Extrude texture | has |
| Separate | has |
| Scale | has, v2.32.0. Uniform or per axis, about the body's middle or the origin |
| Convert to solid | has |
| Mesh Selection Palette | has, v2.65.0. A mesh has no faces of its own, only triangles grouped by the angle between them, so how much a click takes is that angle and the palette is a name for choosing it |

Anvil also has patch, repair, stitch and section, which are its own. The gap
left is the selection palette that governs how clicking picks mesh faces.

Align to a plane turned out to need no fitting step at all. The face groups a
mesh already carries are the fit: a group is a run of triangles that meet
smoothly, so its normal is the plane through them. Pick the region, pick the
plane, and the part turns face down onto it and then slides along the plane's
normal until it actually reaches it. Turning alone leaves the part hanging
wherever it was, which looks aligned from one angle and is not.

Mesh Shell uses the same erosion the solid Shell does, because the answer is
the same answer: a ball rolled around the inside is what gives an even wall
through curves, and a downloaded or scanned part is nothing but curves. It
refuses an open mesh, for the same reason Convert to Solid does. Where the
solid Shell is told which faces to leave open, this is given a plane instead: a
mesh has no faces to name, and everything of the wall on the far side of the
plane is taken away, which is the mouth.

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
| **Sheet metal rules**: create, edit, override per feature, configure | has, v2.47.0 |

### Flange (base, edge, contour) — partial

The three flange types are one command in Fusion, with a selection box where
every row carries its own settings.

| Option | Values | Anvil |
|---|---|---|
| Type | Base, Edge, Contour | has, as three commands |
| Selection box, per-row settings | several flanges in one feature | has, v2.74.0. Each row of edges carries its own angle, height, width and bend; the material rule stays shared, because a part is not made of two materials |
| Edges / Profiles | | has |
| Flange Width Type (edge) | Full Edge, Symmetric, Two Sides, Two Offsets | has, v2.55.0. The offsets are given as distances rather than picked against reference faces |
| Extent Type (edge) | Distance, To Object with an offset | has, v2.61.0 |
| Angle (edge) | | has |
| Height Datum (edge) | Inner Faces, Outer Faces, Tangent To Bend | has, v2.59.0 |
| Bend Position (edge) | Inside, Outside, Adjacent, Tangent | has |
| Flip (edge) | | *pending* |
| Miter Corners (edge) | | has, as its own command |
| Orientation (base, contour) | Side 1, Side 2, Center | has, v2.46.0, on base |
| Operation (base, contour) | New Body, New Component | has, v2.46.0, on base |
| Direction (contour) | One Side, Two Sides, Symmetric | has, v2.59.0 |
| Sheet Metal Rule | pick the rule when the first body is made | partial |
| Override Rules | per-flange overrides of bend radius, bend relief, and 2- and 3-bend corner relief | has, v2.47.0 |

To Object is worked out by asking rather than by arithmetic. The panel is added
to a throwaway copy of the part at a height of one, the frames are resolved, and
the child's own frame says where the flange starts and which way it runs; the
height then falls out of where that ray meets the plane. Deriving it from the
bend geometry instead would mean keeping a second copy of that arithmetic in
step with the first, and the first is already the only thing that knows how a
bend is laid out.

The height datum is worth a word because it is the one that gets a bracket
made wrong. A flange panel begins where the bend arc ends, so a height handed
to the panel tree is measured from the bend tangent, which is Fusion's Tangent
To Bend. Nobody dimensions a bracket to a tangent point: they measure to the
outside. The arc's end sits a radius above the inner face and a radius plus a
thickness above the outer one, so those two datums take that much off the
panel. Tangent stays the default, so nothing already built moves.

The overrides were the substantial gap and they shipped in v2.47.0. They are
the reason the rules system exists: a rule sets what a part is made to, and any
one feature departs from it without changing the rule and every other feature
with it. Every sheet metal dialog that names a rule now offers the departures
beside it: bend radius, bend relief shape, width and depth, and corner relief
shape and size.

A row left blank takes the rule value, which is not the same as merging an
empty string: doing that would set the rule's own value to nothing and fall
back to the built-in default rather than to the rule. The empty ones are
dropped before the merge, and the test pins it.

Thickness is deliberately not on the list. A part is one thickness throughout,
and a feature that could change it would produce something no brake can bend
and no flat pattern can describe.

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
| Edit By Curve (drive edges with a curve) | has, as `formByCurve` |
| Tangent handles | has, v2.69.0. Shown at one picked point only, since with several there is no one tangent to take hold of. Dragging one slides that neighbour along the line it already lies on, so the direction stays and the pull changes |
| Snap vertices to objects | has, v2.69.0, on the same corners and hole centres point to point uses. Never onto the form's own surface, which would chase itself |
| Display Mode (box, control frame, smooth) | has. All three, per form, on the undo stack |
| Control points and surface points as separate things to grab | has, v2.69.0, as the Drag row. Grabbing the surface says where the surface is to go and solves back for the control point that puts it there |

Anvil also has `makeUniform`, which Fusion does not list.

All three of these arrived together in v2.69.0, because they are one want: a
cage edited by dragging what you can see rather than by typing into a dialog.

Grabbing the surface needed the Catmull-Clark limit mask, and the version of
that formula that gets quoted, over edge midpoints and face centroids, is an
approximation that only improves as the mesh is refined. On a cube cage it puts
the corner half as far out again as the surface really is. The exact mask is
over the vertex, its neighbours and the far corner of each quad across from it,
at n squared, 4 and 1 over n(n+5), which on a regular vertex is the bicubic
B-spline mask 16, 4, 1 over 36.

Display Mode was listed here as missing and is not: `cmdFormDisplay` carries box,
control frame and smooth, per form and on the undo stack. Checked against the
source rather than against my own earlier note.

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
| Assembly Constraints (the older constraint system alongside joints) | has. This row was wrong: mate, flush, offset and concentric are built and have six tests of their own |
| Duplicate With Joints | has, v2.63.0 |
| Edit joints | has |

Anvil's known limit stands: joints are open chains only, and a closed loop is
reported rather than solved.

### Components and external references — near complete

| Fusion | Anvil |
|---|---|
| New Component | has |
| Ground to parent | has, v2.74.0. Components are still a flat list, so what "inside" means is named directly: this one is held to that one. Which turned out to be the whole of it, since a part held rigidly to another is a rigid joint and the solver already walked those |
| Edit In Place (edit an external component inside the assembly) | has, v2.70.0, with one difference stated below |
| Update components in an assembly | has, as Update what is derived. Told to rather than watched for: a part that changes shape without being asked is worse than one that is a day old |
| Derived design features (reference geometry from another design) | has, v2.70.0. Bodies, sketches and parameters, each picked by name |
| Break the link to an external component | has, v2.70.0. The geometry stays and stops being anyone else's |
| Switch the design's workflow / enable modeling | n/a — Anvil has no separate assembly workflow to switch out of |

**What made this possible was a name rather than a path.** A design referring to
another design on disk needs to say which one, and an absolute path says it on
exactly one machine: the same two files under different roots on a laptop and a
desktop have different paths and the same relationship. So there is a library
folder, chosen once per machine, and a link is recorded as the path within it.
The absolute path is kept as a fallback, tried second, for links to files outside
the library or made before there was one.

**Derive picks by name, not by id.** A body is called `<feature>:<n>` where n
counts every body in the document at the moment it was made, so inserting
anything ahead of it renumbers the lot. The name is what the other document calls
the thing, it survives the timeline being edited, and it is the word the person
choosing is looking at.

**Edit In Place differs from Fusion in one way and it is worth stating.** Fusion
shows the other design inside the assembly and you edit it in context. Anvil has
one window, so it takes you there and brings you back: this document is saved,
the other opens, and a Return button puts you back with the derive updated. The
difference is that the surrounding part is not on screen while you work, which
matters for fitting something around it and not at all for the rest.

---

## Designs, documents and data

Fusion's document handling assumes a cloud hub. Anvil's is a `.anvil` file on
disk. Recording it all anyway, because most of it has a local meaning.

| Fusion | Anvil |
|---|---|
| Create and save designs | has |
| Open designs | has |
| Edit a design | has |
| Rename designs | has, v2.70.0, in the Library menu. The lock moves with the file |
| Profiles, and a picture for each | has, v2.72.0. Not an account: a name, a library folder and a face. The face is there because two profiles are two libraries, and picking the wrong one saves an evening's work into the wrong body of work. Click a face to change it, in the picker or in the header |
| Move designs | n/a — folders on disk |
| Copy designs | has, v2.70.0, as Save a copy: it writes the copy and leaves you working in this one, which is the opposite ending to Save As |
| Move to Trash / delete | n/a |
| Update designs (pull newer versions of referenced components) | has, v2.70.0, as Update what is derived |
| **Open older versions** | partial — Anvil keeps versions in the document |
| **View design history and related data** | partial — versions exist, no history view |
| Export designs | has (STL, STEP, 3MF, DXF) |
| Insert designs into another | has: Insert Component takes a copy, Insert Derive keeps the link |
| Add the active design to an assembly | **missing** |
| Import a new version of an existing design | has, as Update what is derived, which re-reads the file and re-applies what was taken from it |
| Recover designs | has, v2.73.0. Unsaved work is written aside every twenty seconds, and offered back at startup only when the previous session did not exit cleanly. It arrives unsaved, because the file on disk is still what was last chosen and this is the argument for changing it |
| Convert a design's type (parametric or direct) | has (direct modelling mode) |
| Upload designs / web client / component tab | n/a — cloud |
| Supported file formats | in: STEP, STL, OBJ, 3MF, PLY, OFF, glTF, GLB, COLLADA, SVG, DXF, and **Fusion's own .f3d** since v2.75.0. Out: STL, STEP, 3MF, OBJ, DXF |

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
| Point Light | **missing**, and less needed than it was: v2.76.0 lights a render from an environment, which is what a studio actually is. A named lamp you can place is still not here |
| Spot Light | **missing** |
| Photometric Light | **missing** |
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

The Data Panel actions that do have a local meaning are built. Open by name from
the library, rename a design and save a copy arrived in v2.70.0; projects,
folders, recents and **search across every document in the library** arrived in
v2.71.0. The rest of the panel is the cloud layer, which is the part Anvil
deliberately is not.

Search runs over an index at the library root rather than over the files, and the
index is a cache that is never the truth. It also never causes a file to be read:
on a synced folder the documents can be placeholders that have never been
downloaded, and opening each one to learn its title would pull a whole library
down because somebody opened a list. An entry carries the file name until the
document is opened for its own sake, and a document that has never been opened is
still findable on what is known of it.
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
| Surface continuity | has, v2.74.0. Reports G0, G1 or G2 across a picked edge, measured against the tessellation rather than absolutely: a body here is triangles, so a curved face already steps a facet at a time, and a tangent join would otherwise read as a crease |
| Isocurve analysis | has, v2.74.0. Real u and v on a surface built from curves, and contours in the face's own frame anywhere else, which is a stand-in and says so |
| Environment map reflections | has. `environmentMap` runs a chrome face analysis |
| Validate | has, v2.74.0. Not a proof that a body is right: the kernel settles most of that. It reports what builds cleanly and goes wrong later, sliver faces first |
| Colour code components and features | has, v2.74.0. A reading rather than a change: nothing is written to the document and Clear Analysis puts the real colours back |
| Fastener stack analysis | **missing** (Design Extension) |

Anvil also has a wall-thickness reading and a design-advice pass, which Fusion
does not carry here.

And two appearance features Fusion does not have. **Wood grain** is cut through
the solid rather than wrapped round it, so a groove machined across a board shows
the rings in its walls. **Wrap an image** projects a texture down all three axes
and blends by surface normal, so a pattern carries round every corner of a whole
body with no seam and no unwrapping; Fusion's decals are planar projections onto
one face.

## Fusion-wide: Parameters — partial

| Fusion | Anvil |
|---|---|
| User parameters with name, expression, value and comment | has |
| Model parameters listed per component and feature | partial |
| Unit type per parameter | has |
| Text parameters, joined with `+` | has, v2.49.0 |
| Name a parameter inline by typing `Width=50` into any field, which creates it and adds it to favourites | has, v2.37.0 |
| Favourites | has, v2.37.0. A star per row, and favourites sort to the top of the table |
| Automatic Compute off while editing several parameters | has, v2.29.0 |
| Import and export parameters | has, v2.37.0, as CSV |

Typing `Width=50` into a field was the one to steal and it shipped in v2.37.0.
The field is left reading the name rather than a copy of the number, or the
parameter would be one nothing uses. Two refusals go with it, both of them
cases where doing the obvious thing would be worse than nothing: a name already
in use is read rather than redefined, because somebody typing `wall = 3` into a
second field almost always means "use wall here" and redefining it would move
every other feature that reads it; and an expression that does not evaluate
leaves the field as typed rather than putting a broken row on a table nobody is
looking at.

Text parameters shipped in v2.49.0 with a consumer, which is the only reason
they are worth having: sketch text can be driven by one. A text parameter with
nowhere to go would be a row in a table and nothing else.

The awkward part is that text is stored as traced outlines, because that is
what a profile can be cut from, and the outlines are made when the text is
typed. Changing the parameter afterwards has to make them again, or the part
goes on saying what it used to while the table says otherwise. So the rebuild
re-traces any text whose words came out different, and only then, because a
raster per entity is not free and the answer is usually the same one.

Two things that had to be got right. Text parameters are kept out of the
numeric scope: left in, each one is handed to the arithmetic parser, fails, and
files an error against a parameter that is perfectly correct. And they are part
of the rebuild cache key, because being out of the numeric scope means a change
to one moves nothing the cache watches, and the whole run would replay with the
old words still traced into it. That one was found by the demo, not by
reasoning.

The grammar is deliberately small: quoted literals, parameter names, and plus
signs. A label on a part is `"Bracket " + mark`. A number brought into text
reads the way the value reads rather than the way a float prints, so `wall`
comes out "2.4" and not "2.4000000000000004".

The CSV keeps expressions, not values. A table carried from one part to another
is meant to carry the reasoning. The value is written as a fourth column that
nothing reads back, for the benefit of whoever opens the file in a spreadsheet.
On import a name already in the document keeps its row and takes the new
expression, so a revised table updates the part instead of filling it with
duplicates that shadow each other.

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
| Select by name | has, v2.49.0. A plain substring against body names, not a pattern language |
| Selection sets (name a selection and come back to it) | has, v2.38.0 |

Anvil adds select similar and select tangent run, which Fusion carries as the
Tangent Chain setting instead.

Selection sets shipped in v2.38.0. **One correction to what this file used to
say about them**: it claimed a set was what makes a thirty edge fillet survive
being edited, with later features referring to the set by name. Fusion's
selection sets do not do that. They are saved selections, not parametric
references, and a feature holds its own copy of what it was given. The version
built here is the honest one.

What it does do is keep the picking. The set stores references, not indices: an
index is a position in this rebuild's topology and means nothing after the next
one. So a set saved before an earlier dimension changed still finds the same
places afterwards, and the demo proves it against a rebuild that doubles the
edge count and moves every edge in the set. Restore the set, press Fillet, and
the thirty edge fillet is two clicks rather than thirty.

References that no longer resolve are counted and said out loud. A set that
held thirty edges and now finds twenty six is the one thing you need to know
before pressing Fillet, and coming back quietly short would hide exactly that.

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
