# Anvil

A local parametric CAD program built to work the way Fusion 360 does. Sketch,
constrain, model, assemble, edit any dimension later, export STL. No account, no
cloud, no subscription, no internet. Your models are plain files on your disk.

```bash
npm start
```

Work still to do is planned batch by batch in **[ROADMAP.md](ROADMAP.md)**, which
is where to start if you are picking this up rather than using it.

---

## The shape of it

**Parametric history.** Every operation lands on the timeline as a feature that
stores its inputs, not its output: which sketch, which edges, what distance.
Double click an entry to reopen its dialog; everything downstream recomputes.
Drag the rollback marker back to insert features in the middle. Ctrl+Z undoes.

History can also be turned off (**Select → History**), which freezes the current
shape and clears the timeline. After that, operations work on the geometry
directly. That is the right trade for a shape you inherited and the wrong one
for anything you still want to change by dimension, so it asks first.

**Sketching.** Create Sketch asks where by putting the three origin planes in
the viewport for you to click, and a planar face of a solid or a construction
plane answers just as well. A sketch on a face stays attached: change an earlier
dimension, the face moves, and the sketch moves with it.

Once a plane is chosen the view turns onto it, lines the plane's own axes up
with the screen, and hands you the line tool.

The constraint solver is the heart of it. Draw roughly, then constrain:
horizontal, vertical, parallel, perpendicular, tangent, equal, concentric,
coincident, midpoint, symmetric, fix, plus dimensions for length, distance,
radius, diameter and angle. Geometry that can still move draws **blue**;
geometry that is pinned down draws plain, worked out per entity from the null
space of the constraint Jacobian rather than guessed. Constraints are inferred
as you draw; hold **Ctrl** to suppress that. A dimension that would
over-constrain the sketch becomes a **driven reference** in parentheses instead
of breaking it.

Tools: line, rectangle (two point, centre, **three point**), circle (centre,
two point, **two tangent**, **three tangent**), arc (centre, three point, **tangent**),
polygon (**inscribed, circumscribed, edge**), slot (**five ways**), point,
spline (**fit point** and **control point**), **conic curve**, ellipse, text,
fillet, chamfer, trim, offset, break, extend, mirror, rectangular and circular
pattern, scale, **project (linked or as a copy)**, **intersect**, and **insert
SVG or DXF**. Every one of them takes
either two clicks or a press and a drag, whichever your hand reaches for.

Where Fusion groups a family of tools under one button, so does this: the
caret on Rectangle, Circle, Arc, Polygon, Slot and Spline opens the list.
**Sides** and **Rho** sit beside them, because they belong to the tool in your
hand rather than to anything in the model.

An **ellipse** is placed by its centre, the end of its long axis, and how far
out the short one reaches. All three are real sketch points, so it drags,
dimensions and solves like everything else; only the part of the third point
square to the long axis counts, so moving it resizes rather than shears.

A **conic curve** is drawn by its two ends and the vertex where their tangents
meet, and **rho** says how far out towards that vertex it bulges, measured from
the middle of the chord. Below a half is an ellipse, exactly a half is a
parabola, above it a hyperbola. That is the convention every other package
uses, so a number carried over from one means the same shape here.

A **control point spline** is pulled towards its points rather than passing
through them, which is the other of the two things "spline" means in CAD and
the one that behaves when a point is dragged hard. Its ends are pinned to the
first and last point so a region can still close on it.

A **circumscribed** polygon is measured to the middle of an edge rather than to
a corner, which is the one that matters when it has to clear a spanner or hold
a nut. The **five slots** differ only in which points you click: between the arc
centres, between the far ends, from the middle out, or following an arc given
three points or a centre and two ends.

**Break** cuts a line in two where something crosses it and keeps both halves,
which is trim's opposite and what you want before giving the halves different
constraints. **Extend** runs the near end of a line on until it meets the next
thing in its way, and does nothing when there is nothing in the way rather than
shooting off to an arbitrary length.

The sketch **patterns** copy the selection into a grid or turn it about a
centre, counting the original, and every copy is measured from the original
rather than from the copy before it so a rounding error cannot walk along the
row. **Scale** resizes the selection about a point and brings its anchors with
it; dimensions are deliberately left alone, because a driven dimension pulling
the geometry back says clearly which of the two is in charge.

**Sizes can be typed rather than aimed.** Once a shape has its first point,
boxes appear beside the cursor: width and height for a rectangle, length and
angle for a line, diameter for a circle. They read out the measurement under the
pointer until you type in one, which locks it. Tab moves between them and Enter
commits, so `40` Tab `20` Enter is a forty by twenty rectangle. Whatever you
typed becomes a driving dimension; whatever you left alone stays free. The boxes
take expressions, so `wall * 2` works and keeps tracking the parameter.

**Text** is real outlines, not a label. Click where it starts, then give it the
wording, any font on the machine, a height, an angle, bold and italic, and left,
centre or right. The outline is traced from the font at 220 pixels per em and
simplified to a third of a pixel, which is well inside the width of a 0.4 mm
nozzle, so it extrudes, cuts and fillets like any other profile. A letter's
counter comes out as a hole in it rather than as a profile of its own, so
extruding the whole sketch does not fill every O back in.

There is no font outline API in a browser and no font parser here, so the
shaping is done by the canvas: kerning, ligatures and accents all come out
right, and whatever fonts are installed are available. The outlines are worked
out once and kept on the entity, and the whole run is placed by a single point,
so text costs the solver two variables no matter how much of it there is.

A **tangent arc** starts at the end of an existing curve and leaves along it,
so two clicks fix it rather than three: its centre is square to that tangent and
the same distance from both ends, which pins the circle exactly. Started
anywhere else there is nothing to be tangent to, and it says so.

**Project** brings model edges into the sketch, and it can do it two ways.
Linked, the edges are stored as references and flattened again on every rebuild,
so they follow the model; change a dimension and the projection moves with it.
As a copy, they come in once as ordinary geometry that can then be trimmed and
dimensioned like anything drawn by hand. The difference matters both ways round:
a linked projection cannot be edited, and a copy will not update.

**Intersect** takes the outline where a body crosses the sketch plane, which is
a different thing from flattening an edge onto it. It is stored as a reference
to the body, so the section follows the model too. Both kinds close regions and
can be extruded like anything else drawn.

Geometry the model puts into a sketch is drawn in a muted gold rather than in
the sketch's own black and blue, because it is neither pinned by constraints nor
free to move: it is not yours to drag. A section lies inside the body that
produced it, so **View -> Transparent** is how to see one.

**Insert SVG** and **Insert DXF** trace a drawing into the open sketch. Both
files are read by hand rather than with a library, for the same reason the
expression parser is: opening one must never be able to execute anything.
Lines, circles and arcs keep their kind; beziers and splines arrive as
polylines, because a sketch has no bezier entity and drawing one no dimension
could describe would be worse than saying so. An SVG's `width` against its
`viewBox` is what sets the scale, so a drawing done at 96 dots per inch comes in
life size, and nested transforms are flattened on the way. A DXF already counts
Y upwards; an SVG does not, and is flipped once.

**Editing what is drawn.** Drag a box over empty space to select: rightwards
takes what is wholly inside, leftwards takes anything it touches. Drag the
selection to move it, or use **Move** to shift it by a stated distance, with a
tick box to leave a copy behind instead. Ctrl+C and Ctrl+V copy and paste,
Ctrl+D duplicates, Ctrl+A takes everything, and the arrow keys nudge a grid step
at a time. Constraints are carried by a copy only when both ends of them came
with it, so a pasted copy is never quietly tied to what it was copied from.

Moving geometry brings its anchors along. Without that, a fixed point simply
pulls the whole thing back and the move appears to do nothing.

**Snapping.** The cursor takes the origin, any point, the midpoint of a line, a
circle centre, and the nearest point on any curve, nearer targets first but
points ahead of curves. Lines align to horizontal and vertical within a couple
of degrees. **View -> Sketch** adds an optional grid snap with a step you set.

An angle is the one that cannot always be captured. There is no entity for the
sketch X axis to measure against, so a square angle becomes the horizontal or
vertical it means, an angle in a chain of lines is dimensioned against the
previous segment, and a lone slanted line is placed where you asked and says
that it was left undimensioned.

Click a closed region of a finished sketch to select it as a profile, then
extrude or revolve it. Clicking it inside the sketch works too, before Finish.

A sketch leaves the view looking straight down its own plane, which is right for
drawing and useless for building on: the depth goes exactly away from you and
nothing on screen changes. So a feature that adds depth turns the view to the
isometric as it opens, and only when it was face on to start with.

While a dialog is waiting to be pointed at, a small card follows the cursor
saying which command is asking, what it wants, and how much it has taken so far,
and every click in the viewport goes to it. It sits above the cursor so it never
covers the thing being pointed at. **Escape** lets go of the pointer; a second
Escape cancels the dialog.

A profile answers the pointer as well: the region under the cursor lights up
while a pick is armed, and a chosen one fills in and gets its boundary drawn.
The colour comes from whichever list owns the selection at that moment, the
dialog's or the document's, so a profile picked into a dialog looks picked.

**Solids.**

| | |
|---|---|
| Extrude | The full set, see below |
| Revolve | The full set, see below |
| Sweep | The full set, see below |
| Loft | The full set, see below |
| Rib | An open curve thickened into a wall |
| Web | Several crossing curves thickened into internal walls |
| Coil | A section swept along a helix, or a flat spiral |
| Emboss | A sketch raised out of a face, or sunk into it |
| Hole | Type, extent, drill point, counterbore, countersink, tapped |
| Thread | A real modelled ISO 60 degree thread, internal or external |
| Primitives | Box, cylinder, cone, sphere, **torus**, **pipe** |
| Fillet | Several edge sets, each constant, **variable**, by **chord length** or held to a line |
| Chamfer | Equal, two distances, or distance and angle, in sets |
| Shell | Inside, outside or both, with selected faces left open |
| Draft | Faces tapered about a neutral plane, one side or two |
| Split | Cut in two by a plane or a face, or trimmed to one side |
| Press Pull | Chosen faces offset along their own normals |
| Patterns | Rectangular, circular, **along a path**, and **of features** |
| Move | Translate, rotate about a point, or point to point |
| Scale | Uniform or per axis, about the part, the origin, or a point |
| Align | A face of one body put flat against another |
| Delete Face | A round hole filled back in |
| Silhouette Split | Parted at the outline seen from a direction |
| Split Face | A face divided in two, with the shape left alone |
| Mirror, Combine | Plane and bodies both picked in the canvas |

**Extrude** is built out to what Fusion asks for. Reach for it first and it
waits to be pointed at: click profiles and planar faces in the canvas, or pick
the sketch in the browser or the timeline to take all of it in one step. Then

| | |
|---|---|
| Type | Extrude, or **Thin Extrude** for a wall along the profile |
| Start | Profile plane, an **Offset**, or an **Object** to begin from |
| Direction | One side, Two sides, or Symmetric |
| Measurement | Symmetric measured as **whole length** or **half length** |
| Extent | Distance, **To Object**, or All |
| Extend | To selected face, to adjacent faces, to body, or through body, with an offset |
| Taper | Per side, along with a distance each |
| Wall | Thickness and whether it sits inside, outside, or centred on the profile |
| Operation | Join, Cut, Intersect, New body, **New component**, and which bodies to cut |

The distance starts at zero, so nothing appears until you say how far.

**Revolve** is built the same way, and asks for the same things in the same
order. Click the profiles, then click the line to turn about: a sketch line, a
straight model edge, or one of the named axes from the list, which covers the
sketch's own two, the world's three, and any construction axis. Then

| | |
|---|---|
| Direction | One side, Two sides, or Symmetric |
| Measurement | Symmetric measured as **whole angle** or **half angle** |
| Extent | Angle, **To Object**, or Full |
| Angle | Per side, so two sides take an angle each |
| Operation | The same set as Extrude, including which bodies to cut |

An axis that comes from outside the sketch has to lie in the sketch's plane; a
profile cannot sweep through its own axis, and it says so rather than building
something inside out. **To Object** turns until it reaches the angle the chosen
object sits at, measured about the axis, rather than until the swept profile
meets it. Those agree for the planes and faces anyone actually picks, and it is
predictable where they do not.

**Sweep** takes profiles and a path, both by pointing: click the profiles,
then click the curve to follow, which can be a chain of sketch curves or a chain
of model edges. Then

| | |
|---|---|
| Type | Single path, or **path and guide rail** |
| Profile scaling | With a rail: **Scale**, **Stretch**, or None |
| Distance | How far along the path to travel, as a fraction of it |
| Taper | The angle the section opens out by along the way |
| Twist | Degrees turned end to end |
| Orientation | **Perpendicular** stays square to the path, **Parallel** keeps the profile facing the way it started |
| Operation | The same set as Extrude |

**Loft** takes its sections in the order you click them. A section is a sketch
profile, a planar face, or a single sketch **point**, which is how a loft comes
to a tip. Then

| | |
|---|---|
| Start and End | **Connected**, or **Tangent** with a weight, so an end leaves square to its own plane |
| Guide rails | Sketch curves the intermediate sections are pulled out to meet |
| Closed loop | Joins the last section back to the first |
| Operation | The same set as Extrude |

Three things fall short of Fusion here. A sweep has no **guide surface**, and a
loft has no **centerline** or **direction** continuity, because all three need
surface geometry Anvil does not carry. And a loft's rails scale each section to
reach them rather than constraining the surface to pass through them exactly,
which agrees where the rails are smooth and is an approximation where they are
not.

The rest of the Modify group asks the way Fusion asks. **Fillet** and
**Chamfer** hold several edge sets, each with its own size, so a part can be
blended at three radii in one feature; a chamfer set is equal, two distances, or
a distance and the angle it leans at. A fillet set is asked for in one of four
ways. **Constant** and **variable radius** are the plain ones. **Chord length**
asks how wide the blend reads across and lets the radius fall out of the angle
each edge happens to sit at, so two edges at different angles come out the same
width rather than the same radius. **Hold line** asks for an edge the blend has
to run out on and takes the radius from the distance to it, which is how a
fillet is made to die exactly at a step rather than near it. **Shell** puts the wall inside, outside or
straddling the original surface. **Draft** tapers one side of the neutral plane
or both, which is the shape a moulded part has about its parting line.

**Hole** has a type, an extent of distance, to an object, or all, a drill point
angle, a counterbore or countersink, and can be **tapped**, which cuts a real
thread into the bore rather than drawing one on.

The **patterns** take a distance either as the spacing between copies or as the
whole distance the row covers, can be laid out symmetrically about the original
rather than running off one way, and individual instances can be skipped.
**Combine** takes any number of tool bodies and can put the result in a
component of its own.

**Coil** asks the way Fusion asks: revolutions and height, revolutions and
pitch, height and pitch, or a flat spiral, with a taper angle, a circular,
square or triangular section, and whether that section sits inside, on, or
outside the diameter. The section is measured across the circle it is inscribed
in, so a square of four is 2.83 across its flats.

**Emboss** puts a sketch onto a face, raised or sunk, and works on a flat face
or a cylindrical one. On a cylinder the shape is bent round it: the outline is
resampled first so a straight run does not fold into a chord and sink under the
surface. The sketch keeps its own position and its own axes and only slides
along the normal to reach the face, so what you drew where you drew it is where
it lands. That means the sketch has to be parallel to the face, and it says so
rather than putting the shape somewhere arbitrary.

**Web** is Rib for a set of crossing curves: each open run becomes a wall, and
the walls are joined to each other before they touch the part, so a crossing is
one piece of material rather than a seam. It can run the curves on past their
own ends to reach the walls of a shell, which is the difference between a
stiffener and a stiffener with a gap down each side.

**Delete Face** fills a round bore back in, with a plug grown to contain the
bore's own facets. Fusion's version heals any face by extending its neighbours,
which needs surfaces this kernel does not carry, so anything but a bore is
refused rather than guessed at. A body that comes back with a gap in it is worse
than a command that says no.

**Split Face** divides a face without changing the shape: the body is cut in
two and put straight back together, which leaves the seam behind as a real edge
and turns one face into two, each selectable and draftable on its own. It is
only worth having now that a face can keep its name across a rebuild. Before
that the two halves were indistinguishable the moment anything upstream moved,
so a draft applied to one was as likely to land on the other.

**Silhouette Split** parts a body at its outline seen from a direction, which is
the parting line of a moulded part. The silhouette has to be flat to split a
solid at, which is Fusion's own rule, and it is fitted and checked rather than
assumed.

**Move** translates, turns about a stated axis through a stated point, or
takes a place on the model to another place. **Scale** grows about the part's
own middle rather than the world origin, so a part that is not centred does not
fly off as it grows; the origin and a stated point are the other two choices.
**Split** cuts with a plane or with the plane a face lies in, and can keep only
the near side, which is a trim rather than a split. **Press Pull** takes as many
faces as you click.

Two things in Extrude fall short of Fusion and say so rather than pretending. **To
adjacent faces** stops at the plane of the face you picked, the same as to
selected face; neighbours that are not coplanar with it are not followed. And
**thin extrude** works from closed profiles; an open curve thickened into a wall
is what Rib is for.

A **feature pattern** repeats what a feature did rather than copying the
finished body: pattern a hole and you get one plate with four holes, not four
plates.

**Measure.** `I`, or the button. In the model it reports the length of an edge,
the radius and diameter of a circular one, or the area of a face, and a second
pick gives the distance between them. In a sketch it measures between two
points, or reports a line, a circle or the area of a profile. It adds nothing to
the model.

**Construction geometry.** Offset planes, planes at an angle, midplanes, planes
through three points, tangent planes, **tangent at a stated point**, and
**along a path**; axes through two points, along an edge, up a cylinder, where
two planes meet, normal to a plane or a face; points where an axis meets a
plane, at a circle centre, **where three planes meet**, and **along a path**.
These are the stable things to build on, and they appear on the timeline like
everything else.

Along a path means along a sketch curve or a model edge, at a fraction of its
length measured by arc length, so half way is half the distance walked rather
than the middle entry in a list of points.

**Inspect.** Ten ways of looking at a part, none of which changes it.

| | |
|---|---|
| Section Analysis | The view cut open on a plane, with an offset and a flip |
| Centre Of Mass | What it weighs and where it balances, for a chosen material |
| Interference | Every pair of bodies that shares space, and by how much |
| Draft Analysis | Faces coloured by how they lie against a pull direction |
| Curvature Comb | Spikes along an edge, showing how its curvature runs |
| Curvature Map | Faces coloured cool where flat and warm where tightly curved |
| Minimum Radius | Inside corners tighter than a stated tool, in red |
| Zebra | Stripes, for reading whether one face runs smoothly into the next |
| Environment Map | A polished finish, for reading reflections |
| Accessibility | What can be reached from a direction, and what is in shadow |

**Section Analysis** really cuts rather than clipping. Hiding the triangles in
front of a plane shows what is behind them, which is the inside of the surface,
so a solid reads as hollow and a wall has no thickness. This takes the boolean
against a half space instead and draws that, which costs a moment and shows a
capped face. The model is untouched: measure, save or export with a section up
and the answers are the same as with it down.

**Centre Of Mass** needs a density, so it asks for a material. The printing
plastics are listed first because that is what this is for, with the common
metals after them for when a printed part stands in for one. Two bodies of
different materials balance towards the heavier, not towards the bigger. The
number is for the same shape solid, and it says so: a printed part is infill and
air and will weigh less.

**Interference** reports the volume every overlapping pair shares and where.
Bodies that merely touch are not an interference, because a boolean of two
solids meeting on a face gives a sliver of no volume.

**Draft Analysis** colours green where a face draws out of a mould, red where it
is undercut, and grey where it is too near vertical to draw at all. For a
printed part the same reading is about overhangs: grey and red are what the
printer has to bridge or hold up.

**Curvature** is worked out per vertex: Gaussian from the angle deficit round
each vertex, mean from the cotangent Laplacian, and the two principal
curvatures fall out of those. That is what **Curvature Map** shades and what
**Minimum Radius** compares against a tool: an inside corner tighter than the
cutter or the nozzle is one that will not come out as drawn, so it goes red.

**Zebra** stripes follow the angle between the surface and a light direction. A
stripe that kinks is a crease; a stripe that only bends is the curvature
changing. That is the whole reason to look at stripes rather than at the
surface, which hides both.

**Accessibility** casts a ray out of every point on the body along a direction
and asks whether the body itself gets in the way. Green can be reached, red is
in shadow. For a mill that is whether the cutter can touch it; for a printer it
is what has to be bridged or supported.

**Curvature Comb** draws a spike off each point of an edge, as long as the
curvature there, with their outer ends joined. Reading curvature off a curve by
eye is close to impossible and reading a comb is easy, because a kink in the
comb is a kink the curve itself hides.

Clear Analysis puts all of it away.

**Assemblies.** Components own their bodies, and a feature only ever touches
bodies inside its own component, so cutting one part cannot reach into the part
beside it.

All seven of Fusion's joints are here: **rigid**, **revolute**, **slider**,
**cylindrical**, **pin-slot**, **planar** and **ball**. A pin-slot turns about
one axis and slides along another, a planar joint turns about a normal and
slides in the plane, and a ball takes pitch, yaw and roll, so the ones needing a
second direction ask for it by pointing at an edge or a face.

Each joint is captured where the parts already sit, so at rest it moves nothing.
An **as-built joint** says that is all it will ever be. Travel can be **limited**
per degree of freedom, a joint can be marked **driven** so the solver leaves it
alone, and with **contact** ticked, driving it stops at the last position where
nothing overlaps rather than passing a lid through its own hinge. That is a
walk, not a simulation, and the dialog says so.

A **rigid group** locks several components together without a joint for each. A
**motion link** makes one joint drive another through a ratio, which is a gear
train or a belt; the follower stops being something you can set, because its
value now comes from the driver.

**Closed loops are solved.** A chain of joints that comes back on itself cannot
be walked out from the ground, because the last joint has to agree with
everything the others already decided. The joints round the loop that were not
driven by hand are the unknowns, what each closing joint fails to line up is the
error, and Gauss-Newton with Levenberg damping settles it. The damping is what
matters: a four bar passing through the position where it lines up straight
makes the Jacobian go thin, and undamped it throws itself across the room. A
linkage asked for a position it cannot reach says so rather than half solving.

**Parameters.** Name a value once and use it anywhere a number is asked for.
Every numeric field takes an expression, including a sketch dimension, so
`wall * 2` or `len / 2 - clearance` are valid, and they stay expressions in the
saved file.

**Units.** A number can carry one, anywhere a number is taken: `2in`, `1.5 in`,
`2"`, `1'`, `3cm`, `0.5m`, `10 thou`. They are multipliers into what the
document counts in, which is millimetres, so `25.4mm + 1in` is 50.8 and a unit
mixes with the rest of the arithmetic. Angles take `deg`, `rad` and `turn` the
same way. The text is kept, so a distance entered as `2in` reopens as `2in`
rather than as the millimetres it came to.

Nothing checks that a length unit went into a length field, because the
evaluator only ever deals in bare numbers. `2in` in an angle box is 50.8
degrees, which is what it says.

**View -> Sketch -> Units** sets what lengths are *written* in. The model is
always millimetres, which is what the kernel works in and what a slicer expects
out of an STL; the setting changes how a length is shown and how a bare number
with no unit on it is read. A dimension driven by an expression is marked `fx`,
so a link to a parameter is visible without opening it.

**Surfaces.** A surface is a sheet with an edge, which a solid kernel cannot
hold at all: manifold makes every body watertight by construction, which is the
property a slicer needs and the reason it was chosen. So surfaces live beside
solids rather than inside the kernel, as triangle meshes with a boundary, and
the rule that keeps that safe is that a sheet never reaches the kernel until it
has been stitched into something closed or given a thickness. Whether it really
closed is checked once, in one place, before anything is handed over.

They have their own tab. **Extrude**, **Revolve**, **Sweep** and **Loft** build
one off curves rather than off closed profiles, so a single open line is a
perfectly good input where for a solid it would be nothing. **Patch** fills a
boundary, **Ruled** lays a band off a curve or runs a surface between two, and
**Offset** holds one clear of another. **Trim** cuts a surface where another
crosses it and keeps the piece you point at; **Extend** carries one past its own
edge; **Stitch** welds a set into a solid when they close and tells you how many
edges are still open when they do not; **Unstitch** breaks a body back into one
surface per face; **Reverse** turns one inside out, which is what decides which
way it thickens; and **Thicken** makes it a solid.

An offset mitres. A vertex where two faces meet has a normal halfway between
them, and stepping along that by the distance wanted lands short of both, so the
point is solved for directly instead: the one that is the offset distance clear
of every face meeting there. It is the difference between a wall that is 2 thick
everywhere and one that thins to 1.4 at every corner.

Surfaces draw in their own warm ochre and from both sides, and they are listed
apart from solids in the browser, because almost nothing you can do to one can
be done to the other. Nothing with a volume in it, mass, section or
interference, will touch a surface.

With surfaces there, the Solid tab gains **Boundary Fill**, which divides bodies
by surfaces and planes and keeps the cells you name, and **Replace Face**, which
swaps a face for a surface. **Delete Face** now heals any face rather than only
a round bore: the rest of the body is taken as a surface with a hole in it, the
hole is patched, and it is stitched back. **Split Face** cuts with a surface as
well as a plane.

**Three dimensional sketches.** A sketch's points carry a third coordinate and
its curves are not required to lie in its plane. It is reference geometry rather
than solved geometry, deliberately: every residual in the solver is written in
two variables per point, and running it on points that carry a third would
quietly flatten them, so a 3D sketch is left exactly where it was put. A curve
that leaves the plane bounds no area, so it closes no profile and cannot be
extruded, but it can be swept along, measured against and projected.

Four sketch commands need it. **Include 3D Geometry** brings a model edge in as
it is rather than squashed onto the plane, which is the whole difference from
Project. **Intersection Curve** gives the curve where two bodies meet, read off
the solid they share rather than worked out geometrically: its surface is partly
one body and partly the other, and the edges between those parts are the answer.
**Project To Surface** drops sketch curves onto a surface, breaking a curve into
the pieces that landed rather than jumping the gap. **Isoparametric Curve**
reads the lines of constant u or v off a surface built here.

**Sheet metal.** A part that is a folded flat sheet, and the flat it came from.
The flat pattern is a second parallel model rather than a view of the first: a
bend knows its own unfolded length from the K factor, so the same feature list
builds either the folded part or the flat one depending only on whether each
bend is folded. Everything else follows from that.

A part is a tree of flat **panels** joined by **bends**. A panel is a contour in
its own frame with the material one thickness deep; a bend stores the line it
folds about in its parent's frame, and the child's frame is that parent's frame
rotated about the bend axis. Lay the child in the same plane instead, pushed out
by the bend allowance, and you have the flat. Nothing else changes between them,
which is why Unfold and Flat Pattern are the same arithmetic.

A document keeps a **library of rules**: thickness, bend radius, K factor, the
rip and miter gap, and the shape and size of bend and corner relief. Every field
is an expression like any other, so a thickness can be driven by a parameter and
every part made to it follows. One rule is active and most features are made to
it, so changing that changes every bend at once, which is what it is for; a
feature can name a rule of its own instead, so a bracket in aluminium and the
mount it bolts to in steel are one document rather than two. A part remembers
the rule it was built to, so a later feature cuts at the thickness that part
actually has.

**Base Flange** starts a part from a closed profile. **Flange** grows one off an
edge; its bend position says what lines up with the edge you picked, and the
four choices mean exactly this here: **Inside**, the flange's inner face;
**Outside**, its outer face; **Adjacent**, the start of the bend; **Tangent**,
the point the arc is tangent at. **Contour Flange** takes the part's cross
section as one open run of lines and makes the whole thing at once, every leg a
panel and every corner a bend. **Fold** splits a flat face along a sketched line
and turns one half; centred on that line the part loses no stock overall,
because each half gives up half the allowance and the arc puts it back.

**Unfold** and **Refold** flatten bends to work across them and put them back:
a working state, not a result. **Flat Pattern** is the result, and it is a body
of its own with its own place in the browser, because that is what a drawing and
a **DXF** are made from. The DXF is written as R12 with the cut geometry and the
bend lines on separate layers, since one is a path and the other is a mark for
the brake. **Rip** tears a shape that closes on itself so it can lie flat,
**Corner Relief** cuts the notch where bends meet. Two bends meet where their
lines cross, which is a corner of the panel and easy to see flat. Three do not:
the third belongs to a flange that has already been folded away, so what ties it
to the corner is the tree rather than the geometry, a tab running across the end
of one flange at the distance along it where the corner falls. That is the
corner of a closed tray, the one with three thicknesses of material converging
on it, and it gets a notch cut big enough to clear all three.

**Miter** closes the corner between two flanges. Two flanges off adjoining edges
do not overlap: each stands outside its own edge, so what they leave between
them is a notch the width of the material. The miter runs both into it and then
cuts them on the plane that bisects the pair. The cut is square through the
thickness rather than bevelled, because the blank is cut flat on a laser and
that is the only shape it can have, which means the gap has to be measured from
the material furthest through the thickness and not from the face the contour
sits on. Get that wrong and the two flanges clear at one face and bite into each
other at the other. Because the panels themselves are cut rather than the solid,
the miter shows on the flat pattern too, which is where it has to show: a blank
that folds up with its corners fighting is a blank that was cut wrong.

**Convert To Sheet Metal** reads an ordinary solid as folded sheet: the flat faces and the bends
between them are recovered from the geometry, and a body that is not the rule's
thickness is refused rather than quietly converted into something a brake cannot
make.

**Meshes.** The kernel here is already a mesh kernel, so a mesh is not the
foreign object it is in a boundary representation package. The distinction that
actually matters is not mesh against solid, it is **watertight against not**: a
closed mesh can be cut, joined and printed, and an open one cannot. So an
inserted mesh is held apart from the solids until you ask for it to cross over,
which keeps a two million triangle scan out of the kernel until that is what you
want, and Convert Mesh is where it crosses.

**Insert Mesh** reads STL, binary or ASCII, OBJ, and 3MF. The 3MF is unzipped
with the browser's own inflate rather than a bundled one, since a 3MF is a zip of
XML and `DecompressionStream` is already here. **Tessellate** goes the other way,
taking the triangles off a solid or a surface without disturbing it.

**Repair** is the one that earns its keep: weld coincident vertices, drop the
triangles with no area and the duplicates a bad exporter leaves, take the
surplus off any edge with three or more triangles on it, close the holes, and
agree on which way is out. In that order, because each step depends on the one
before. **Reduce** is Garland and Heckbert's quadric error metric, which spends
the triangles on the curvature and leaves the flats alone: a quarter of the
triangles on a sphere costs under three per cent of its volume. **Remesh** makes
them one size, by splitting what is long, collapsing what is short, flipping
toward six neighbours a vertex, sliding each vertex across its own surface, and
then putting it back onto the surface it started on, which is what stops the
smoothing rounding the shape off.

**Smooth** uses Taubin's alternating step rather than plain Laplacian, so it
takes the roughness out without taking the size out with it; shrinking is a
setting rather than a side effect. **Plane Cut** trims, splits into two bodies,
or splits the faces only, and caps what it opened. **Erase And Fill** removes
faces and closes over where they were, which is how a lump of scan noise goes.
**Separate** and **Merge** take a body apart and put it back. **Texture Extrude**
pushes the surface in and out by the brightness of an image, so the texture is
really there in the geometry and survives being sliced.

**Generate Face Groups** decides at what angle two triangles stop being the same
face. Without it a scan is a million faces of one triangle each and nothing on
it can be pointed at. The angle is a good first guess and a poor last word,
though: on a scan there is no angle that keeps a moulded corner whole and still
separates the two flats beside it. So a group can be set by hand as well.
**Create Face Group** keeps each face picked exactly as it stands whatever angle
is asked for later, **Combine Face Groups** makes one face of them all, and
**Delete Face Groups** hands them back to the angle. Generating again is the way
back to letting the angle decide everything. **Create Mesh Section Sketch** gives the curve where a
plane crosses a mesh, which is what you trace over when the only thing you have
is a scan.

**Forms.** A form is a **control cage**, a coarse polygon mesh, and the smooth
surface that cage stands for. You shape the cage, which has a handful of faces
you can actually grab, and the surface follows. Catmull-Clark is what turns one
into the other, and it is the whole of the geometry: everything else either
builds a cage, changes its topology, or reads the surface off it.

The cage lives in the document beside the sketches, and for the same reason: it
is drawn rather than derived, so nothing in the timeline could rebuild it. One
timeline entry per form, the way Fusion does it, because a hundred pushes and
pulls on a cage are one act of shaping rather than a hundred features.

**Box**, **Plane**, **Cylinder**, **Sphere**, **Torus** and **Quadball** start
one. The quadball is the one to reach for when the answer is round: it is six
grids pushed onto a sphere rather than rings and poles, so every vertex has four
neighbours and the surface has no pinch in it. Each round primitive is fitted to
its own limit surface, because subdivision does not pass through its own cage: a
ball whose cage points all sit exactly 20 out has a surface nearer 17, and
nobody asking for a radius of 20 means the cage.

**Insert Edge** runs a new loop the whole way round a ring of quads, which is
how the shape of a form is actually built. **Insert Point**, **Subdivide**,
**Bridge**, **Fill Hole**, **Delete**, **Weld** and **Unweld**, **Flatten** and
**Make Uniform** do the rest of the topology. **Crease** holds an edge sharp,
and it is a dial rather than a switch: sharpness counts down a level with each
subdivision, so two holds an edge for two levels and the third rounds it off.
Creased hard all round, Catmull-Clark reproduces the cage exactly, which is how
a form can be a box of precisely 20 as easily as a blob.

**Mirror** cuts the cage on a plane, throws the far side away and replaces it
with a reflection of the near one, so the two halves are the same thing rather
than two things that happen to match, and it remembers that. **Circular** does
the same about an axis. **Display** shows the cage, the surface, or the cage
over the surface, which is the one to work in.

**Edit Form** is where the shaping happens. Click the cage to pick a vertex, an
edge or a face, and a manipulator appears on what you picked: arrows to drag
along, squares to drag in, rings to turn about, cubes to scale by. **Transform
mode** narrows it to one of those when the others are in the way. **Coordinate
space** decides which way its axes run: the model's own, the screen's, the
surface's, or each point's own normal, which is how a whole face is pushed out
of a rounded body without shearing it. **Selection filter** says what a click
can land on.

**Soft modification** is what makes a drag a swell in the surface rather than a
dent with a hard rim: the points around the ones picked take a share of the move
that falls off with distance, or with how many faces out they are, smoothly,
linearly or with a bulge. **Grow**, **Shrink**, **Loop**, **Ring** and **Invert**
work a selection up to the right size without forty clicks. A loop runs along the
shape and a ring runs round it, which is the difference between picking the line
up a tube and picking the band round it.

**Pull** lifts the picked faces off, walls in the hole they leave, and hands the
lifted faces back as the selection, so the drag that follows draws them out into
a limb. Faces picked together come out as one piece rather than as a row of
stubs.

A form that has been made symmetric moves both halves at once, as the drag
happens rather than as a repair afterwards. A whole drag is one undo, not one
per frame.

**Finish Form** turns it into a solid, and refuses a form that is not closed
rather than handing the kernel something that looks right and is not watertight.
**Thicken** is for the ones that are meant to be open.

---

## The window

The window is drawn the way Braun drew an instrument in Dieter Rams' years
there. A warm off-white ground, hairline rules rather than boxes, no shadow, no
gloss, nothing rounded, Helvetica, and one accent colour, Braun's vermilion,
spent only on the thing that is active right now: the tool in your hand, the row
you have selected, the single action a dialog is asking for. Everything else is
grey so the model is the only thing in the window with a voice.

The viewport is a light drafting ground rather than a dark one, which is the
honest reading of the period and also lets sketch geometry go back to the
ordinary CAD convention: geometry that is pinned down draws near black, and
anything still free to move draws blue.

| Area | What |
|---|---|
| Ribbon | Solid (Create, Modify, Construct, Assemble, Select), Sketch, View |
| | Buttons marked with a caret open a small list: Primitive, Pattern |
| Browser | Parameters, origin, sketches, components, joints, construction, bodies |
| Viewport | The model, with a view cube top right |
| Timeline | Feature history and the rollback marker |
| Status bar | Body count, triangle count, rebuild time |

### Navigation

Fusion's defaults, so the muscle memory carries over.

| Input | Action |
|---|---|
| Middle drag | Pan |
| Shift + middle drag | Orbit |
| Wheel | Zoom |
| Right click | Context menu for whatever is selected |
| Click the view cube | Snap to that face |
| Drag the view cube | Orbit, including while a sketch is open |
| **Iso** under the cube | Back to the isometric |

The cube belongs to the viewport rather than to the page, so dragging it to
orbit works while a sketch has hold of every other click in the window. The view
opens on the standard isometric, which is also where **Iso** returns to.

All of it is switchable under **View → Navigation**, including zoom direction
and zoom-to-cursor.

### Keys

| Key | Action |
|---|---|
| `S` | Create sketch, then click the plane or face to draw on |
| `E` `R` `H` | Extrude, Revolve, Hole |
| `F` `Q` | Fillet, Press Pull |
| `M` `C` `P` | Move, Combine, Parameters |
| `L` `C` `R` `A` `D` | Line, circle, rectangle, arc, dimension (sketching) |
| `T` `O` `X` `P` | Trim, offset, construction, project (sketching) |
| `I` | Measure |
| `Ctrl+C` `Ctrl+V` `Ctrl+D` | Copy, paste, duplicate (sketching) |
| `Ctrl+A` | Select everything in the sketch |
| Arrow keys | Nudge the selection, `Shift` for ten steps |
| `Ctrl` (held) | Suppress inferred constraints while drawing |
| `Esc` | End a chain, leave the tool, clear the selection |
| `Enter` | Accept the current dialog or selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo, redo |
| `Ctrl+S` / `Ctrl+O` / `Ctrl+N` | Save, open, new |

Double click a timeline feature to edit it, right click one to roll back to it.
Right click a dimension to delete it, double click one to change its value.

---

Closing asks about unsaved work from the main process, with a real Save, Don't
save and Cancel. It is deliberately not a `beforeunload` guard: Electron gives
that no dialog, so preventing it cancels the close and says nothing. Whatever
goes wrong in the prompt, the window still closes.

## Files

`.anvil` files are readable JSON: parameters, sketches, construction geometry,
components, joints, and the feature list. Nothing about the resulting solid is
stored, because a rebuild replays the timeline from scratch every time. That is
what makes changing an early dimension propagate. The exception is a document
with history turned off, which stores the frozen meshes instead.

Dimensions are stored as the text you typed. A distance saved as `wall * 2`
reloads as `wall * 2` and still tracks the parameter.

---

## How it is put together

```
src/main/main.js       Electron main: window, file dialogs, custom URL scheme
src/preload.js         The only bridge between the page and the disk
src/renderer/
  app.js               Commands, dialogs, timeline, browser, selection, undo
  viewport.js          Three.js scene, navigation, view cube, picking
  sketchview.js        The 2D sketch editor
  solver.js            Constraint solver and freedom analysis
  profile.js           Tessellation, curve quality, closed-region finding
  topology.js          Faces and edges recovered from the kernel's triangles
  edgefeature.js       Fillet, chamfer, face prisms, persistent references
  meshbuild.js         Loft, sweep, helix and variable blend construction
  sheet.js             Surfaces: open meshes, and everything done to them
  sheetmetal.js        Panels, bends, the flat pattern and its DXF
  meshtools.js         Repair, reduce, remesh, smooth, cut and section
  form.js              Control cages, Catmull-Clark, and the tools on them
  construction.js      Planes, axes and points that exist to be referenced
  assembly.js          Components and joint kinematics
  features.js          Document model, planes, and the parametric rebuild
  kernel.js            Wrapper over the manifold solid modelling kernel
  meshutil.js          Display normals, feature edges, STL and OBJ output
  textoutline.js       Font outlines traced back out of a rendered canvas
  vectorimport.js      SVG and DXF read by hand into sketch geometry
  analysis.js          Mass properties, interference, draft, and materials
  expr.js              Expression parser for parameters and dimensions
```

**The kernel** is [manifold](https://github.com/elalish/manifold), a mesh
boolean engine whose output is watertight by construction. That is the property
a slicer actually cares about.

**Faces and edges** are recovered from the triangle mesh after every rebuild.
Coplanar triangles weld into flat faces, smoothly joined ones into curved faces,
and a flat region that makes up a real share of a surface is split back out,
which is what keeps the top of a filleted box selectable when the fillet is
tangent to it. Curved faces are fitted for cylinders, so a bore can be measured
and given an axis. Tangent boundaries stay selectable but are not drawn.

A coarse ring of facets is read as one curved face rather than as a ring of flat
ones. The test that promotes a flat patch to its own face is a share of the
surface it sits in, which every facet of a small bore passes, so a 3 mm hole
used to come back as forty flat faces and no cylinder at all: it could not be
measured, threaded, or filled. What tells the two apart is uniformity, since a
flat region that deserves its own face towers over the facets around it.

**Fillets** are built, not solved: the corner between two faces is cut away
along the path a ball of the given radius would roll, swept for a straight edge
and revolved for a circular one, with a ball dropped where edges meet. It agrees
with a morphological opening to within a twentieth of a percent, which the test
suite checks. A variable radius lofts the profile along the edge instead.

**Lofts and sweeps** are stitched directly as meshes, since no boolean of
primitives expresses them. Sections are resampled by arc length so corresponding
points sit at corresponding places, and each section is rotated to line up with
the last, which is what stops a loft between two squares coming out twisted.

**Surfaces never reach the kernel.** manifold will accept a mesh with holes in
it and hand back something that looks plausible and is not a solid, and by the
time that shows up it is in a printed part. So a sheet is checked for closure in
one place, `stitchSheets`, and only a closed one is passed on. A closed mesh is
also wound consistently first: surfaces made separately have no reason to agree
on which side is out, and one whose triangles disagree is not a solid however
well it closed.

A surface cuts a solid by being stretched past it and given the thickness of the
whole model, which turns it into a lump the size of a half space with that
surface as its face, after which an ordinary boolean does the rest. That is what
Boundary Fill, Replace Face and Split Face by a surface all stand on.

**A cage face is one face because the cage says so.** Anvil works faces out of
a triangle mesh by following smooth joins and then splitting off the flat
patches, which is right for a solid and wrong for a cage: a curved quad's two
triangles differ by enough to be split, and a flat cage merges into one face
with nothing to point at. So a cage mesh tags each triangle with the cage face
it came from and asks the topology to go by that instead. Solids are untouched,
because there the angle is the whole point.

**A mesh never reaches the kernel unmeasured.** manifold will take a mesh with
holes in it and produce something that looks plausible and is not a solid, so
Convert Mesh checks first and says what is wrong when it refuses: how many edges
are open, and how many have three or more triangles on them. A hole can be
filled; an edge with three triangles on it is a fold, and no amount of filling
makes it a solid.

**A bend is one number.** The bend allowance, the neutral axis arc length, is
the whole of what the flat pattern turns on: it is how much flat stock a bend
eats. Folded and flat are the same walk over the same tree, differing only in
what a bend does to its child, so there is no second model to keep in step and
nothing that can drift.

Folded and flat do not have the same volume, and should not. The neutral axis
model conserves length along one surface inside the material, not volume, so the
arc of a bend holds a little more material than the flat strip it replaces. That
is the same arithmetic every brake in the world is set by.

**Curve quality** is set in one place and shared by the sketch tessellator and
the kernel. If they disagree, every boolean between a sketch curve and a
primitive leaves a band of sliver triangles.

**Expressions** are parsed by hand rather than passed to `eval`, so opening a
model file can never execute anything.

---

## Tests

```bash
npm test
```

338 tests in a hidden window, checking measured quantities: volumes against
independently derived references (the frustum formula, Pappus's theorem, a
morphological opening), bounding boxes, genus, triangle counts, solved
coordinates, joint kinematics, and STL watertightness. A regression in the maths
fails the run rather than only a thrown exception.

Four tools drive the real interface and save a screenshot:

```bash
npx electron . --anvil-shot shots/advanced.png --anvil-script tools/demo-advanced.js
```

`demo-advanced.js` builds a lofted body with a swept handle and a threaded stem,
adds a construction plane, puts a lid on a hinge and swings it, then clicks
every new ribbon button and checks its dialog opens. `demo-workflow.js` runs the
core loop with synthetic pointer events, `demo-sketch.js` exercises the drawing
tools, `demo-bracket.js` builds a part from the document model,
`demo-text.js` raises traced text on a plate and cuts an ellipse and a bolt
circle through it, `demo-solid2.js` builds a webbed tray with an embossed label,
a coil and a filled bore and opens every dialog added with them, and
`demo-sketch3.js` draws every slot and polygon variant, a conic and a control
point spline, and traces an SVG in, checking each one's area against the
formula for it, and `demo-identity.js` puts a fillet on one of four identical bosses and edits the
spacing, checking it stays where it was put, then splits a face and checks the
shape did not change. `demo-assembly.js` builds a four bar out of four components, closes it, turns
the crank and checks the coupler really moves, then exercises every joint type,
a rigid group and a motion link. `demo-inspect.js` shells a box, weighs it, checks it against a peg driven
through its wall, colours its draft and cuts it open, `demo-project.js` draws a
tangent arc, projects a face both linked and as a
copy, and sections a body, checking that the linked ones move when the model
does, and `demo-picking.js` checks the things a volume cannot see:
that clicking a profile twice lets it go, that a picked profile looks picked,
and that the callout says what the dialog wants.

### Rebuilding

The timeline is replayed from nothing on every rebuild. That is what makes it
honest: there is one path to any state and no way for the model to drift from
the features that describe it. It is also why editing the last feature of a long
part would otherwise cost the same as editing the first.

The cache keeps the honesty and skips only work that would have produced exactly
what it already has. Every feature gets a key covering itself and everything
outside it that it reads, which is mostly the sketch it names: an extrude
carries a sketch id and nothing else, so moving a line in that sketch changes
what the extrude builds without changing a character of the extrude. The keys
are compared in order and the run starts again at the first one that differs,
which is the same answer a full replay gives, arrived at without repeating the
part in front of it.

Two things make that work rather than merely sound plausible. A manifold is
immutable once built, so a cached solid is safe to hand to the next rebuild:
every feature after it produces a new object and leaves that one exactly as it
is. And the provenance ids that make a face reference survive a dimension change
have to come back with the geometry, or every face of the untouched part goes
anonymous the moment a later feature is edited. What it costs is one rebuild's
worth of intermediates staying alive. What it buys is not building them again.

The cache is not per document. What it knows is keyed on what the features say
rather than on which object holds them, so opening another document simply fails
to match and frees what it was holding. That is also what makes undo quick,
since undo hands back a document parsed afresh.

---

## What is not here

**Not modelling at all**, and each its own application rather than a missing
button: CAM and toolpaths, drawings, and simulation. Rendering is flat shading
with feature edges, not a photoreal renderer.

Of Fusion's Sketch tab, nothing is missing. Of its Inspect panel, Fastener
Stack, Display Component Colors and Find Similar Components are not modelling
analyses at all.

**Modelling gaps that remain:** Fusion's compute options for patterns that hit
different geometry. Silhouette Split works only where the parting line is flat.

**Where the form tools stop.** A circular symmetry is remembered but a drag is
not mirrored round it: only mirror symmetry follows a drag live. Range selection
and Select Next are not there; Grow, Shrink, Loop, Ring, Invert and Select All
are. Edit Form cannot pull a face out by holding a key while dragging, the way
Fusion does; Pull is its own button, which does the same thing in two steps.

**Where the mesh tools stop.** Mesh Align is
the Solid tab's Align, which already works on any body. Texture Extrude lays the
image along a plane rather than around the body, so it reaches the faces that
plane can see. Move, Scale, Combine, Shell and Delete are the ones already on
the Solid tab, and they work on a mesh body as they do on anything else.

**Where the sheet metal tools stop.** Convert To Sheet Metal recovers the flat
faces and the bends of an existing solid, but a converted body has no panel tree
until it is given one, so it cannot be laid out flat straight away. Miter is a
feature you run rather than something a flange does on its own, so a corner is
closed when you say so.

**Where the rebuild cache stops.** A change to a parameter, to a base body, to
the sheet metal rules, to the component list or to a body's name invalidates the
whole run, because there is no telling which feature was reading it. That is the
conservative answer and it is the correct one; the finer-grained version would
have to know which feature reads which parameter, and a wrong guess there is a
model that quietly disagrees with its own timeline.

**Where the surface tools stop.** Trim cuts a surface with another surface, and
a surface cuts a solid by being stretched past it and given the thickness of the
whole model, so a surface that folds back on itself over that distance cannot
divide a body and says so. An isoparametric curve needs a surface with a u and a
v, which means one built here rather than a face lifted off a solid. Patch fills
a flat boundary exactly and a boundary that is not flat with the simplest
surface that meets it, not a curvature-continuous one.

Text is traced from a raster rather than read out of the font file, so an
outline is a polyline of the traced curve rather than the font's own beziers.
At 220 pixels per em, simplified to a third of a pixel, the error is a fraction
of an extrusion width; it is the right trade for a printed part and the wrong
one for typography. A joint's contact stops where the parts meet along the one
degree of freedom being driven, which is a walk rather than a simulation: it
will not find a collision that only happens partway through some other joint's
travel. A linked projection keeps the kind of a line and of a circle facing the sketch;
anything else comes in as a polyline.

**Names, not descriptions.** A feature that says "fillet this edge" has to find
that edge again on every rebuild, and a mesh kernel hands back a fresh mesh each
time with nothing to hold on to.

It does carry provenance, though, and that is what is used. Each feature's
geometry is marked as its own before it goes into any boolean, so every triangle
of the result still says which feature it came from and which flat face of that
feature it was part of. A reference stores that name, and an edge stores the
names of the two faces it lies between, which is what an edge is. Matching is
then a lookup rather than a guess.

The face ids the kernel hands out come from a counter that climbs through the
whole run, so the same face of the same shape gets a different number on the
next rebuild. They are renumbered against each feature's own mesh, in order of
first appearance, which is the same order every time that shape is built.

A curved face is a ring of coplanar facets with an id each, so no single one
names it. Such a face records its feature and says the rest is not knowable, and
position tells it from its siblings. Position is still the fallback everywhere,
so a file saved before any of this opens and behaves exactly as it did, and a
reference that genuinely cannot be found is still reported on the feature rather
than silently applied to the wrong edge.

What it is worth, measured on a plate carrying four identical bosses with a
fillet on the third, while the spacing between them is edited. The same check
both sides:

| | Before | After |
|---|---|---|
| Face references lost | 6 of 8 | 0 of 8 |
| Fillets landing on the wrong boss | 6 of 9 | 0 of 9 |

As in Fusion, referencing sketch geometry and construction planes is still
steadier than referencing model faces.

A modelled thread is real geometry and costs real triangles. That is the point
for a printed part, but it is why Fusion leaves threads cosmetic by default.

---

## Building the installer

```bash
npm run dist
```

Produces `dist/Anvil-Setup-<version>.exe`.
