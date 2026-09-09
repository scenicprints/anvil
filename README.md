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

**Construction** geometry is drawn dashed and closes nothing, so a helper line
can run straight through a profile without cutting it. A **centreline** is that
plus a claim: this is the line the part is about. It draws with a longer stride
and a colour of its own, the sketch mirror offers it before the numbered lines,
and a Revolve opened on a sketch that has exactly one starts already turning
about it rather than about the sketch Y axis. Two centrelines is a question, so
it asks. Only a line can be one; a circle has no single direction to be an axis
in.

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

A **three point circle** is given by three points on its rim rather than by its
middle, which is how a bore gets matched to three points measured off a real
part. The two that were clicked stay on it, so moving one moves the circle
rather than leaving a point stranded beside it.

**Blend Curve** joins the loose ends of two curves with a spline that does not
show the join. Tangent continuity is the easy half and is where most packages
stop; it is not enough, because two arcs joined only tangentially still show a
break in a reflection where the curvature jumps. The curvature continuous
version sets the curvature at each end as well, and the check that it worked is
made against the finished curve rather than against how it was built. It ends on
the two curves' own points, so dragging one of them takes the blend with it.
What it cannot hold on its own is the direction and the curvature: nothing in a
2D solver says "leaves this end at this curvature", and building a chain of
construction lines to fake one would be worse than saying so plainly.

**Collinear** puts two lines on one infinite line. Parallel is not the same
thing and is the reason this is its own constraint: two rails are parallel and
are not collinear.

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
| Fillet | Several edge sets, each constant, **variable**, **asymmetric**, by **chord length** or held to a line; any of them tangent or **curvature continuous** |
| Chamfer | Equal, two distances, or distance and angle, in sets |
| Shell | Inside, outside or both, with selected faces left open |
| Draft | Faces tapered about a neutral plane, one side or two; one click takes the whole run of flats that carry on smoothly from it |
| Split | Cut in two by a plane or a face, or trimmed to one side |
| Press Pull | Chosen faces offset along their own normals |
| Patterns | Rectangular, circular, **along a path**, and **of features** |
| Move | Translate, rotate about a picked pivot, point to point, or along a direction taken off the model, snapping to corners, edge middles and hole centres. Any of them can move a copy instead |
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
order. One profile visible on screen is taken without being asked for, the same
as Extrude. Then click the line to turn about: a sketch line, a straight model
edge, or one of the named axes from the list, which covers the sketch's own two,
the world's three, and any construction axis. A sketch carrying exactly one
**centreline** needs none of that: the revolve opens already turning about it.
Then

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
of model edges. One click on a model edge takes the whole run that carries on
smoothly from it, because a path round a part is rarely one edge: a rounded
outline is straight, arc, straight, arc. Turn that off when one segment is
genuinely all you want. Then

| | |
|---|---|
| Type | Single path, or **path and guide rail** |
| Profile scaling | With a rail: **Scale**, **Stretch**, or None |
| Distance | How far along the path to travel, as a fraction of it |
| Taper | The angle the section opens out by along the way |
| Twist | Degrees turned end to end |
| Orientation | **Perpendicular** stays square to the path, **Parallel** keeps the profile facing the way it started |
| Operation | The same set as Extrude |

**Loft** takes its sections in the order you click them, and the order can be
changed afterwards: each section past the first has a row that moves it
earlier. The same three sections in a different order are a different shape, and
before this the only fix for a mis-ordered loft was clicking them all again and
getting it right the second time. A section is a sketch
profile, a planar face, or a single sketch **point**, which is how a loft comes
to a tip. Then

| | |
|---|---|
| Start and End | **Connected**, **Tangent** with a weight so an end leaves square to its own plane, or **Direction** at a stated takeoff angle to that plane |
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
**Chamfer** open waiting to be pointed at and do nothing until they have been.
An empty edge list means nothing has been picked yet, not everything: pressing
Fillet used to round every convex edge on the part before a single edge had been
clicked, which on a shelled box is a whole shape changed, and a rebuild to undo,
in answer to opening a dialog. Documents written before this said "the whole
part" with an empty list, because it was the only way to say it, and they are
given the flag that means it on load so they still come back rounded. Fillet and
Chamfer hold several edge sets, each with its own size, so a part can be
blended at three radii in one feature; a chamfer set is equal, two distances, or
a distance and the angle it leans at. A fillet set is asked for in one of five
ways. **Constant** and **variable radius** are the plain ones. **Asymmetric**
takes a radius on each face, so the blend runs out further one way than the
other. **Chord length**
asks how wide the blend reads across and lets the radius fall out of the angle
each edge happens to sit at, so two edges at different angles come out the same
width rather than the same radius. **Hold line** asks for an edge the blend has
to run out on and takes the radius from the distance to it, which is how a
fillet is made to die exactly at a step rather than near it.

Any of them can be **curvature continuous**, which Fusion calls G2. A circular
arc meets a flat face with a jump in curvature, from nothing to one over the
radius, and on a shiny part that jump is a line you can see. G2 keeps the
tangent points where the circular fillet put them and runs the curvature out to
nothing at both ends instead, so there is no line to see. **Tangency weight** is
how hard that curve is pulled toward the corner.

**Shell** puts the wall inside, outside or
straddling the original surface, and one click on the mouth takes the whole run
of faces that carry on smoothly from it. **Draft** tapers one side of the neutral plane
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

**Move** works on whole bodies or on chosen **faces**. A face is swept into a
prism along the move and the prism is added to or taken from the body, and the
sweep leans the way the move goes, so a wall pushed up and over comes out
slanted rather than stepped. Faces move in a straight line only: turning one
about a point is a different construction and is refused in the dialog rather
than after you press OK, and so is a move square to the face's own normal,
which would slide it along inside its own plane and change nothing.

On bodies it translates, turns about a stated axis through a stated point, takes a
place on the model to another place, or goes one distance along a direction
picked off the model: an edge lies along its own line, a flat face gives the way
it faces. The pivot a rotate turns about is clicked rather than typed, snapping
to corners and hole centres the same way point to point does, and typing three
numbers is still there underneath. **Create a copy** on any of them leaves the
original standing and moves a second body instead. **Scale** grows about the part's
own middle rather than the world origin, so a part that is not centred does not
fly off as it grows; the origin and a stated point are the other two choices.
**Split** cuts with as many planes and faces as you click, applied in turn, so
the pieces from one cut are what the next cuts and a box crossed by three
planes comes out as eight parts. It can keep only the near side instead, which
is a trim rather than a split, and with several tools that means the near side
of every one of them. **Press Pull** takes as many
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

**Presets.** Every dialog with anything to save has a Preset row at the top:
save these settings under a name, mark one as the default, rename or delete
them. A part gets the same 0.6 chamfer on every edge it has, and typing 0.6
into a fresh dialog forty times is forty chances to type 0.8.

A preset carries settings and never geometry. What was picked belongs to the
part it was picked on, so the rows filled by clicking in the canvas are left
out, and a preset only fills rows the feature already has: one saved off a
fillet with three edge sets, applied to a fillet with one, fills that one and
stops rather than conjuring the other two into being.

Last used is recorded and offered in the list, and deliberately not applied on
its own. Only a preset you marked as the default opens a dialog. Extrude opens
at a distance of zero on purpose so nothing appears until a length is given,
and quietly restoring the last distance would undo that for someone who never
asked for a preset.

**Parameters.** Name a value once and use it anywhere a number is asked for.
Every numeric field takes an expression, including a sketch dimension, so
`wall * 2` or `len / 2 - clearance` are valid, and they stay expressions in the
saved file.

You do not have to go to the dialog to make one. Type `Width = 50` into any
dimension field and the parameter is made there and then, the field is left
reading `Width`, and it is starred as a favourite. Favourites sort to the top of
the table. A name already in use is read rather than redefined, because typing
`wall = 3` into a second field almost always means "use wall here", and an
expression that will not evaluate leaves the field as you typed it rather than
putting a broken row somewhere you are not looking.

The table exports and imports as CSV. It keeps expressions, not the numbers they
work out to, because a table carried from one part to another is meant to carry
the reasoning; the values go in a fourth column for whoever opens the file in a
spreadsheet, and nothing reads them back. On import a name already in the
document keeps its row and takes the new expression, so a revised table updates
the part rather than filling it with duplicates.

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

**Untrim** puts back what a trim took away. On an imported surface the hole was
usually cut by something that is no longer in the document, so there is no trim
in the timeline to suppress and the hole has to be filled rather than undone. On
a flat surface it will also square the outer edge off to the rectangle the
surface would have had if nothing had ever been cut from it; on a curved one
there is no rectangle to go back to, so it fills the holes and says it left the
outside where it was. **Merge** makes several surfaces into one and leaves it a
surface. Stitch asks whether the result closed and hands back a solid when it
did; merge does not ask, because sometimes what is wanted is one surface body to
offset or thicken as a piece and a solid halfway through that is the wrong
answer.

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

**Choosing things** is its own set of tools, because every command begins by
choosing something and clicking one face at a time is the reason a model with
four hundred of them gets abandoned rather than edited.

**Drag a box** over the model. Rightwards takes what is wholly inside it and
draws solid; leftwards takes anything it touches and draws dashed, which is the
convention every package shares. Only faces turned towards you are taken, so a
box does not quietly grab the back of the part as well.

**Select By Size** is the one that earns its place on an import: a downloaded
model has a dozen faces worth caring about and hundreds of chips, and
everything under two square millimetres selects the rest of them in one go.
**Seed And Boundary** takes a face and the rim around it and fills to the rim,
so a pocket comes whole however many faces it turns out to be made of.
**Tangent Run** takes the whole of one smooth surface, stopping where there is
a crease. **Select Similar** matches what was picked: pick one M3 bore and the
other three come with it. **Grow**, **Shrink** and **Invert** do the obvious.

**Save as a selection set** names what is chosen and puts it in the browser to
come back to. It stores references rather than positions, so a set saved before
an earlier dimension changed still finds the same places afterwards, which is
the whole point: picking thirty edges once is a chore, picking them again after
every edit is why people stop editing parts. Restore the set, press Fillet.
References that no longer resolve are counted and said out loud, because a set
that held thirty edges and now finds twenty six is exactly what you need to
know before pressing anything.

**Priority** is a setting rather than a mode: faces only, edges only, bodies
only, or anything. On a part where the edges are everywhere and the faces are
small, being able to say "edges only" for a while is the difference between
picking what you meant and picking eleven times. **Isolate** hides everything
but what is selected.

A **coordinate system** is the one Construct command that is not a single
formula. It is an origin and three directions, and what it is worth is that its
planes and axes can be used anywhere the world's own can: sketch on a fixture's
own XY, mirror about its YZ, measure along its Z. The second direction given is
squared up against the first rather than taken as it was pointed, because two
picked edges are almost never exactly at right angles and a frame that is not
square shears every sketch drawn on it. One entry produces seven things, and
every one of them is referenceable, or it is only a picture of a frame.

**Spun Profile** draws the outline a body sweeps out when it is spun about an
axis. A hex head spun about its shank is a cylinder as wide as the corners of
its flats, and that is the number that says whether a socket clears it. It has
to be measured against the material and not against the corners: a hexagon's
vertices all sit at one radius, so a profile read off the points alone reports a
hollow tube where there is a solid bar. Rays fired out from the axis give the
runs of radius that really hold material, and the inner edge is only drawn when
there is a bore at every station rather than at some of them.

**Repair Body** puts a form cage back into a state the subdivision can work on.
The faults it finds do not show on screen: a point dragged onto another point, a
face left with two corners in the same place, the same face made twice. The cage
looks right and the smooth surface it stands for grows a crease out of nowhere,
or a hole where there is plainly a face. Filling holes is offered rather than
assumed, because a form that is open is a normal thing and closing one is a
change of shape rather than a repair. A cage with nothing wrong with it comes
back untouched and says so, rather than being quietly rebuilt: a rebuild
renumbers the points and takes every crease and selection with it.

## Stress

**Stress Analysis** is a real finite element solve. Hold some faces, push some
others, say how hard, and it works out what the part does.

It cuts the body into a grid of little cubes rather than meshing it with
tetrahedra. Meshing an arbitrary solid with tetrahedra that are all well shaped
is a research problem and one bad element poisons the answer everywhere; a grid
cannot tangle, cannot invert and cannot produce a sliver. The price is a
stair-stepped boundary, and the answer to that is a finer grid rather than a
cleverer mesher. Because every element is the same cube, the matrix saying how
one resists deformation is worked out once for the whole part, and the global
system is never assembled at all: conjugate gradients only ever needs the matrix
times a vector, and that is done one element at a time.

Three things about it are worth knowing before trusting a number out of it.

**It is sized by the thinnest direction, not the longest.** This is the decision
that decides whether the answer means anything. Cubes chosen to divide the long
side neatly will not divide the short one, so a 10 millimetre section comes out
12.5 because that is where the cell boundaries fell. Stiffness in bending goes
as the thickness cubed, so a section a quarter too fat is two and a half times
too stiff, and nothing else in the answer looks wrong. It also reports the
volume of its own cubes against the real volume of the part, which is the one
number that catches this when it happens anyway.

**The element can bend.** A plain trilinear cube cannot: asked to bend it shears
instead, and shearing takes far more force, so a beam made of them comes out
several times too stiff. Three extra shapes are added to each element and solved
away before it ever reaches the solver, which costs nothing at solve time and
takes a cantilever from two thirds of the right answer to within a fraction of a
percent at one element through the depth.

**Stress is read at the corners, not the middle.** Bending stress is highest at
the surface and zero in the middle of the section, so an element centre
systematically under-reads the peak: with one element through the depth it reads
zero for a beam that is at yield. Under-reading a stress is how a part gets
signed off and then breaks.

Everything is checked against beam theory in the tests: a cantilever's tip
deflection against PL cubed over 3EI and its bending stress against Mc over I,
both to within a few percent at every resolution, and a bar in tension against
PL over AE.

What it will not tell you: a printed part is weaker across the layers than along
them, sometimes by half, and no solver that treats the material as the same in
every direction can know that. Stress will also run high right at a face that is
fully held, which is real and is what a perfectly rigid clamp does; look away
from the fixture.

And one run at one resolution is not a number to design to. Two runs at
different resolutions are: when the answer stops moving, that is the answer. The
panel reports the resolution it used so that comparison can actually be made.

**Generative Design** answers the question nobody can answer by eye: given where
the part is held, where it is pushed, and how much material it may have, where
should that material go? Not "is this bracket strong enough", which is what
Stress answers, but "what should the bracket look like".

It is set up as a stress problem, because it is one, and adds an allowance. Then
it solves the part thirty or forty times over, each round taking material from
where it is idle and giving it to where it is working. Two details in that are
not obvious and both are necessary.

Material is a dial, not a switch: an element is somewhere between nothing and
solid, and its stiffness is its share cubed. Cubing is what makes half-solid
material a bad deal, costing half the budget for an eighth of the stiffness, so
the answer settles on shapes that are mostly solid or mostly empty rather than a
fog of half material everywhere.

And the reading has to be blurred before it is acted on. Acted on directly the
answer breaks into a checkerboard of alternating solid and empty cells, which is
not a shape, it is an artefact of the elements, and it looks stiffer to the
maths than it is. Averaging each element's reading with its neighbours removes
it, and sets the finest feature the answer is allowed to have, which is exactly
what somebody printing it wants to control.

The material at the fixtures and under the load is held solid, because taking
away the face that is bolted down solves a different problem.

What comes out is a new mesh body, blocky at the resolution it was worked out
at, and it is meant to be worked on rather than printed: smooth it, trace it, or
use it as the shape to model properly. The status line says how much of the
allowance it spent and how many times stiffer the result is than the same
material spread evenly, which is the number that says whether it did anything.

## Pictures and taking things apart

**Render** makes a still of the model that is better than the screen can draw in
real time. Not a path tracer and not pretending to be one. What makes the
difference is accumulation: the same view is drawn many times with the camera
moved by a fraction of a pixel and the lights moved a little each pass, and the
results averaged. Jittering the camera gives antialiasing far past what the
hardware does. Jittering the lights turns every hard shadow soft for nothing,
because a light sampled over an area is what a soft shadow is. The scatter is
repeatable, so the same settings give the same picture twice and two renders can
be compared.

The finish comes from what each body is made of, which is the point of having
said: steel renders as metal because it is metal, and a printed part does not.
The working view is deliberately matt, so that is put back afterwards. Nothing
of the tool is in the picture: no grid, no origin planes, no manipulator.

**Animate** takes an assembly apart on a timeline, which is the single most
useful drawing there is for telling somebody how a thing goes together. A
moving one is better still, because it shows the order as well as the
arrangement. Auto explode works it out from where the parts actually are, so it
stays right when one moves, and sends them one after another with the furthest
out going first, which is the order things come off.

Nothing about it rebuilds anything. A step is a transform laid over a body for
display, so scrubbing costs nothing and the model underneath never moves. That
matters more than it sounds: an animation that edited the assembly would leave
the parts wherever the playhead happened to stop.

## One document, several parts

**Configurations** is a table: a column per thing that varies, a row per
variant, and the model built from whichever row is current. A bracket that comes
in three lengths is one design, not three; drawing it three times means three
sets of everything to keep in step, and they will not stay in step.

A column can drive a parameter, whether a feature is suppressed, whether a body
is shown, a body's colour or material, the sheet metal rule in force, or a joint
position. Each of those names the one place the value already lives rather than
inventing a second one.

Two rules matter more than the rest. A blank cell means "as drawn", not zero:
a row can be silent about a column and leave that alone. And the document is
never written to, so switching back to the first row gives the first part again;
a table that edited the parameters in place could not go back. Suppression works
both ways, because a variant needs to be able to be the one that *has* the hole
as well as the one that has not.

It is shown as a real table, because the whole value of one is seeing the
variants side by side. A stack of dialogs would hide exactly the thing worth
looking at.

**Document Properties** hold a name, a part number, a description and a
revision. Not decoration: they are what a drawing, a purchase order and a shelf
all agree on, and a model without them is one somebody has to name again every
time it leaves.

**Named Versions** keep the whole document under a name so it can be put back.
Not a substitute for a version control system and not pretending to be one. What
it is for is the hour in which a part is being tried three ways: keep the one
that worked before starting the next. Each one holds the whole document, which
is honest about the cost, and the size is said out loud. Going back to an early
one does not throw away what was kept since.

**Notes** pin a remark to a face or an edge. A note about a face is useless once
you cannot tell which face; pinned, it points at what it is about and it moves
when the model does, because what is stored is a reference to the geometry and
not a position in space. When the geometry has gone the note stays where it was
and says so, because a note that disappears because a fillet was added is worse
than one in roughly the right place with a mark against it. Notes are not
geometry and are not in the timeline: rolling back past a remark would be a
strange thing for it to do.

## Inserting

**Insert Component** takes the bodies out of another Anvil document and puts
them in this one as a component. What comes across is the shape, not the
timeline, and that is on purpose: replaying somebody else's features inside this
document would mean two sets of parameters with the same names, two sets of
sketches, and a rebuild that fails here because of an edit made over there. The
bodies travel as triangles and go straight back to being solids, which is safe
because they were solids when they left. A manifold body is watertight by
construction, so what comes back through a mesh is the same shape and not an
approximation of it.

**Insert Derive** is the same thing with the path remembered. Linked and live
are different words: this is linked, and it updates when it is told to, which is
what **Refresh** is for. Told to rather than watched for, because a file watcher
would mean this document changing under your hands while you were working in it,
and a part that changes shape without being asked is worse than one that is a
day old.

The file being read is never made current, never locked and never saved to.
Getting that wrong would mean inserting a part quietly took over from the
assembly being built.

**Canvas** puts an image on a plane to trace over, which is how a drawing that
exists only as a photograph becomes a part. Calibrating is the whole of making
that work: an image has pixels and a part has millimetres, and the way across is
to say how long something in the picture really is. A canvas is never what a
click lands on, and it draws behind the model by default, because it is there to
be drawn over.

**Decal** lays an image on a face. The difficulty is not the picture, it is the
edge of it: a decal covers some triangles whole and cuts across others, and
leaving those means the image smears past where it should stop while dropping
them gives a ragged edge that follows the mesh rather than the artwork. So the
triangles are really cut. Each one is projected into the decal's own flat frame,
clipped against the rectangle there, and the pieces are lifted back onto the
surface by where they sit inside the original triangle. Only triangles facing
back at the image are taken, or a decal put on the front of a part comes out on
the back as well, mirrored. It reports how much of itself landed, because a
decal half off the edge of a part is a real thing to want to know about.

Both are listed in the browser under Images, where they can be switched off or
thrown away. A picture laid on the model that cannot be removed is not a tool.

**Hem** folds an edge back on itself. A raw sheet edge is sharp, it is weak, and
on a panel anyone will ever touch it has to go somewhere; folding it back
doubles the thickness there and buries the cut. Four kinds, and none of them
needs machinery of its own: a hem is one or two flanges chained off the edge,
and the panel and bend tree already knows how to fold, unfold and flatten those.
Single is folded flat back, teardrop curls round past halfway and brings the cut
edge home, rolled is one long turn, and double folds twice so the cut ends up
inside two thicknesses. Relief is cut where the hem leaves the panel and nowhere
else, because a relief notch in the middle of a hem cuts the fold in half.
Folded to nothing the metal cracks, so the inner radius never goes below a
thousandth and defaults to one thickness.

**Lofted Flange** is the one sheet metal feature that is not a fold. A
transition from a square duct to a round one has no bend line anywhere on it, so
it cannot go in the panel and bend tree and it has no flat pattern here. That is
said out loud rather than left to be discovered at the press brake: the part is
real and correct as a solid, and it is not something this can unfold.

A flat pattern that has been **exported as a DXF** remembers the shape it had
when it went out, and the tree says so the moment the model moves away from it.
Somebody cutting from that file has no other way to know, and the cost of
finding out late is a sheet of metal. The signature is rounded to a thousandth,
because a rebuild can move a point by a rounding error without the part being
any different, and warning about that is the fastest way to have the warning
ignored.

**Joint Origin** captures a place on the model that joints and constraints can
be pointed at afterwards. It is captured once and kept, deliberately not
recomputed: the whole use of one is that it goes on meaning the same place after
the face it came off has been replaced by a fillet.

**Constrain Components** is the other way of assembling, and it is worth having
alongside joints rather than instead of them. A joint says how two parts may
move relative to each other for ever after; a constraint says where a part goes
now. Most of the time that is all anybody wants, and being made to define a
joint origin first is why people give up and type coordinates. **Mate** puts two
faces together facing into each other, **Flush** puts them in one plane facing
the same way, and **Concentric** puts two round faces on one axis and says
nothing about how far along, which is what makes it a shaft in a bore rather
than a shaft pushed home. Constraints are applied after the joints, in order,
and the last one wins, which is what somebody dragging parts together expects.
Whatever is jointed to the part being moved comes with it.

## Plastic parts

Four features that all stand on a face, because that is what they have in
common and it is the awkward part. Each of them is a handful of numbers a person
already knows, and working the outline out from those numbers by hand every time
is where the mistakes come from.

**Boss** is a post with a hole down it. The bore is measured from the top down,
because that is where the screw goes in and how deep it can reach is the number
that matters; a bore as deep as the boss goes right through into whatever the
boss is standing on. The fillet at the foot is not decoration. A boss without
one snaps off at the base, which is where the whole load is, and on a printed
part that is also where the layer lines run straight across the stress. Ribs
are optional gussets against the wall, and the roadmap note about them is worth
repeating here: a rib is drawn flat and then tipped up by a quarter turn about
X. Swapping two axes to tip it instead adds exactly the same volume and lays
every rib on its side, which is a bug no volume check will catch.

**Rest** is a small pad two parts meet on. Three small pads touch properly. One
big face never does, because nothing is flat enough, so it rocks on whichever
two high spots it happens to have. The draft is what lets it come out of a mould
and, on a printed part, what stops the first layer curling off the edge. Sunken
is the same shape taken out of the face rather than a different shape.

**Snap Fit** is a cantilever hook, and two angles decide whether it works. The
lead-in is the shallow face the hook rides over on the way in, and a shallow one
is the difference between a part that clicks together with a thumb and one that
needs a mallet. The retention face is the other side: square is the strongest
and is what most printed snaps use, and leaning it past square makes a hook that
has to be prised rather than pulled. The same command cuts the catch, as the
same shape grown by the clearance and running into the material rather than out
of it, so the face to pick for a catch is the one the hook comes through.

**Lip** is a band round the rim of a mating face, and the groove is the same
band made wider by the clearance on both walls. Two halves of a printed
enclosure that meet on a flat face will not stay lined up; this is what lines
them up. The band follows the face's own outer edge rather than a shape drawn by
hand, so it fits a rounded rectangle and an odd outline equally well and cannot
drift out of step with the wall it belongs to. Run it twice with the same
numbers, once on each half.

**Stitch** and **Patch** are the two halves of Repair, on their own, and both
are worth having apart from it. A mesh out of a scanner or a bad exporter writes
every triangle with its own three corners, so two triangles that look joined
share no vertex and every edge in the file reads as open; Stitch is what makes
it one surface. The tolerance is the whole of that decision, too small and
nothing joins, too large and detail the size of the tolerance is thrown away, so
the count of what joined and what is still open both come back and it can be
raised and tried again. Patch fills holes, and asks how big a hole is worth
filling: a scan of a bracket has a hundred pinholes worth closing and one big
opening where the part was cut off, and closing that one turns the part into a
bag. Holes are measured round the rim rather than in edges, so the same hole
reads the same in a fine mesh and a coarse one.

**Direct Edit** moves part of a mesh with no history and nothing recognised
first, which is what an imported mesh actually needs: a boss a millimetre out of
place, moved, without converting anything. The falloff is what keeps it usable.
Without one the region moves and its edges tear; with one the surface around it
follows and stays continuous.

**Material** and **Colour** are separate commands because they are separate
things. Material is what a body is made of and is where its mass comes from;
colour is what it looks like. A steel bracket shown in red to mark it as the one
being worked on is still steel, and changing its colour must not change what it
weighs. Both live on the document rather than in the timeline: rolling back past
a material should not turn a steel bracket into a plastic one.

**Compute All** throws the rebuild cache away and builds the whole timeline
again. It is not the everyday command it is in Fusion, because Anvil rebuilds as
it goes. It is here for the one case that matters: the cache holds what the last
rebuild made, and if it is ever wrong then everything downstream is wrong in a
way that looks exactly like a modelling mistake. This is how "have I confused
it" gets answered in a second instead of argued about.

**Design Advice** measures everything about a part that is likely to give
trouble downstream. Fusion's version mostly points at moulding; this one points
at the two things a part here actually meets, a printer and sometimes a cutter.
Wall thickness is measured by sending a ray into the material and seeing how far
it goes, which reads a rib, a boss wall and the web between two pockets the same
way and needs nothing to be recognised first. The same ray turned round finds
gaps too narrow to print: it escapes into the air out of an outside face, and
lands on the far side of a bore or a slot out of an inside one. That matters
because below about four millimetres a round hole comes out of the kernel as a
handful of flats rather than a cylinder, and those are exactly the holes worth
warning about. Overhang and plate contact are counted per triangle rather than
per face, because a sphere is one face whose average normal is nothing at all
and it is exactly the sphere that is all overhang. Every threshold is asked for
rather than assumed: there is no such thing as a thin wall in the abstract, and
a 0.4 nozzle and a 0.8 disagree about most of a part. Nothing it says is a
verdict. A thin wall is a finding, not an error, and plenty of parts are meant
to have one.

**3D Print** writes the model out and hands it to whatever the machine opens it
with, which is a slicer on any machine that has one. It writes 3MF by default,
and the reason is not size. An STL says nothing about what unit its numbers are
in, so every slicer guesses, and a part arriving at a twenty-fifth of its size is
the commonest thing that goes wrong between a model and a printer. A 3MF says
millimetres, keeps the bodies apart, and keeps their names. The zip it is built
on stores rather than deflates: there is nothing here worth bundling a
compressor for, and stored entries are part of the format.

**Recognise** reads a body back as features, whatever it arrived as. This is
where the mesh kernel stops being a compromise and starts being an advantage.
A boundary representation package treats an imported mesh as a foreign object it
has to convert before it can do anything real, and a converted one is still a
shape with no features in it. Here the question is not whether a mesh can be
converted, it is what the thing actually is, and that can be measured.

A **hole** is a cylindrical face whose surface faces its own axis. A **boss** is
the same face with the surface facing away, which is the only difference between
a bore and a peg and is the whole of how they are told apart. A **fillet** is a
cylindrical face that runs into both its neighbours without a crease, which is
what being a blend means. Nothing here guesses at what a shape probably is.

What comes back is grouped by size, because a part has four M3 clearance holes
rather than four unrelated faces, and changing all the 3.2s at once is the thing
you actually want. Each row selects what it names, so a bore can then be filled,
offset or measured like any other face. It works the same on a body that was
built here and on one that arrived as triangles with no history at all: export a
drilled plate to STL, read it back, and it is still four holes in two sizes.

Where blends run into each other there is no flat between them, so they are one
continuous surface and are reported as one. Claiming twelve fillets on a fully
rounded box would mean inventing boundaries the geometry does not have.

**Insert Model** reads STEP as well as mesh formats, and STEP is the one that
changes what an import is worth. An STL is triangles somebody else chose, so an
imported model can only ever be a shape. A STEP file carries the surfaces
themselves: this face is a plane, that one is a cylinder of radius five about
that axis. A part that arrives that way was never facetted, so it can be cut
to whatever tolerance you ask for rather than to whatever the exporter picked.

The reading is in two halves that know nothing about each other. `stepfile.js`
is the Part 21 grammar and nothing else: a tokeniser and an entity graph, with
strings, enumerations, references, complex instances and the escape sequences
that carry characters the file's own encoding cannot. `stepread.js` is the
geometry, and it works the same way for every surface: take the face's boundary,
map it into the surface's own two parameters, triangulate it there as an
ordinary polygon with holes, and lift it back out. Doing it in parameter space
is what lets one piece of code fill a face whether it is flat, cylindrical,
conical, spherical or toroidal. Only the mapping differs.

**What it does not read yet is B-splines**, which are the other half of a real
STEP file. A face on one is counted and named rather than skipped in silence,
and the import says so: a part quietly missing a face is a part you must not
print.

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
**Shell** hollows a mesh out with an even wall, by the same erosion the solid
Shell uses, because that is what gives an even wall through curves and a
downloaded part is nothing but curves. It refuses an open mesh: there is no
inside to take away from a surface. Where the solid Shell is told which faces
to leave open, this takes a plane instead, since a mesh has no faces to name.
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

**From Curves** builds a form on geometry that has already been worked out
rather than starting from nothing. **Extrude** carries a sketch chain along the
plane's normal, **Revolve** turns it about an axis, **Sweep** carries it along a
path, **Loft** runs between two sketches, and **Pipe** puts a tube of a given
radius along a path. **Face** makes the smallest form there is, a single quad or
triangle from three or four picked corners.

A cage is not the surface it stands for. The surface lies inside the cage, so a
form built on a drawn curve runs near that curve and not exactly through it.
Every package that does this behaves the same way, and it is the whole
difference between a form and a loft: a loft goes through the sections it was
given, and there is a Loft for when that is what is wanted.

A profile is only ever cut down to the number of control points asked for, never
filled in, because a square asked for eight points would come back with a point
in the middle of each side and a cage that rounds off corners the sketch drew
square. A path is resampled either way, because the number of rings along a
sweep was asked for and has to be what comes out. A loft resamples every section
to the same count, since two sections drawn at different times are almost never
divided the same way.

The pipe's ring is carried from one station to the next rather than rebuilt at
each. Rebuilt, it turns over wherever the path passes through vertical and the
tube pinches into an hourglass.

The **Shape** menu is the sculpting half of the tab, and every one of these
works on what is picked rather than on a dialog full of numbers, because the way
a form is worked is pick, do, look.

**Smooth** relaxes points towards the middle of what they are joined to. It is
the one operation that undoes a mess without deciding what the shape should have
been. Every pass is worked out from the positions before that pass, not as it
goes, or the answer depends on which point happens to be numbered first.
**Straighten** puts points on the line that fits them best, and **Cylindrify**
puts them on a cylinder at the radius they already averaged, so a ring that
wobbles about a bore lands on the bore rather than on some new size. Given no
axis, both take the direction the points vary in most, which is right along a
shaft and wrong around one, so the axis can be said.

**Slide Edge** runs a loop along the surface instead of through the air, which
is how a loop in the wrong place gets moved without denting anything. Which of
the two ways out of the loop counts as forward is decided once and carried all
the way round: decided per point, half the loop slides one way and half the
other and it shears instead of sliding.

**Bevel Edge** puts an edge either side of the one picked. A bevel on a control
cage is not a cut face, it is more edges: one edge smooths away and two close
together hold a shape. **Erase And Fill** is the opposite, taking an edge out
and letting the two faces either side become one, which is how a cage that was
subdivided too far comes back without losing its shape. An edge on the rim has
nothing on the other side, so it is left alone rather than quietly deleting a
face.

**Merge Edge** joins two open edges point for point. Both runs have to have the
same number of points: this is a merge, not a fit, and joining runs divided
differently would put a crease along the seam that nobody asked for. **Match**
brings an open edge onto the nearest place on a curve, which is what makes a
form meet the edge of a solid. **Edit Form By Curve** is the same machinery the
other way round: a row of points laid out evenly along a curve from one end to
the other, moving them a long way on purpose, with the rows behind following if
asked.

**Freeze** pins points so nothing moves them, which is how one end of a form
gets shaped without disturbing the end that is already right. It is the last
word rather than a suggestion: a drag, a smooth and a match all leave a frozen
point exactly where it was. **Interpolate** makes the surface pass exactly
through a point rather than near it. Fusion calls that an interpolated point;
here it is a corner weight, which is the same thing said in the language the
subdivision already speaks, so there is no second mechanism to keep in step with
the first.

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

The window is dark, the way a modelling application is dark: the chrome recedes
so the model is the only lit thing in it. The discipline is still Dieter Rams'
at Braun, and one accent, Braun's vermilion, is still spent only on what is
active right now.

It took three passes to get there and the first two were wrong in the same way.
Drawn light and flat, it read as a toolkit from 1995, because a Braun panel was
never one grey laid on another: it had material contrast, air, and crisp type.
Repainting could not fix that, because the shape was the problem.

**The toolbar is one row.** Each group shows its most used commands as bare
icons with the group's name beneath them, and that name opens the rest. Thirty
labelled buttons in two rows was the shape of the thing that looked dated, and
it cost a hundred pixels of viewport. What is reached for constantly is one
click, everything is two, and **Ctrl K** searches every command in the
application by name, which is what makes folding them away affordable.

**The browser floats.** A document with four things in it does not need a panel
the height of the window.

**The chrome is lighter than the room it looks into.** Getting that the wrong
way round is what makes a dark theme read as a black bar stuck to the top of a
grey window, and it is the mistake the first dark cut made.

**The view cube points at twenty six views, not six.** Press the middle of a
face for that face, out towards a border for the edge the two faces share, out
towards a corner for the corner. What is shaded is whatever the pointer is
over, so it says what a press would land on. It briefly shaded the corner
nearest the camera instead, which is useless: that corner is whichever one
faces you, so it never appears to move however you turn.

**It asks for the system's own text face.** This asked for Helvetica, which on
Windows means Arial, and Arial at eleven pixels dates an application faster than
any other single choice.

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

525 tests in a hidden window, checking measured quantities: volumes against
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
does, `demo-blend.js` draws a three point circle, makes two lines collinear and
blends two arcs, then reads the curvature on both sides of the join;
`demo-advice.js` builds a part with a wall too thin and a bore too narrow, runs
Design Advice through the Analyse menu, and untrims and merges the faces of a
drilled plate. `demo-generative.js` sets up the case every topology optimisation paper opens
with, a design space held at one end and pushed at the far bottom corner, and
checks it spent its allowance and came out several times stiffer than the same
material spread evenly. `demo-stress.js` builds a bar, holds one end, pushes the other, and compares
the deflection and the stress against the beam formulae, then runs it again
finer to show the answer has settled. `demo-render.js` renders a plate, checks the picture is the size asked for and
holds a model rather than an empty frame, that a transparent background really
is clear, that the helpers went away and came back, and that the same settings
give the same picture twice. `demo-animate.js` explodes three components and
checks the bodies moved on screen while the model underneath did not.
`demo-configure.js` builds a configuration table, switches between two variants
and measures the volume each time, sets the document properties, keeps a named
version and puts it back after changing the model, and pins a note to a face and
turns the view to check it followed. `demo-batch20b.js` inserts a part from another document's bodies, lays a canvas
on a plane and a decal on a face, and measures the decal on the part against the
size it was asked for. `demo-batch20a.js` folds a hem on a sheet metal plate, takes a flat pattern,
fakes a DXF export and checks the tree notices when the model moves past it, and
captures a joint origin. `demo-plastic.js` makes a plate and puts a ribbed boss, a sunken rest, a snap
fit and a lip on it, measuring the volume before and after each, which is the
one thing a picture of a boss cannot tell you. `demo-mesh17.js` tessellates a
solid and runs Stitch, Patch and Direct Edit over
it, then sets a material and a colour and checks the colour did not change the
mass. `demo-formcreate.js` puts a square and a path into a document and builds a form
off each of the From Curves commands. `demo-sculpt.js` works a box cage through
the Shape menu, smoothing, bevelling,
freezing and then failing to move what it froze, erasing an edge and
interpolating a point. `demo-ucs.js` builds a coordinate system and checks its planes
turn up in the dropdowns under its own name, takes a spun profile off a hex bar,
and breaks a form cage on purpose to watch Repair find both faults and then find
nothing the second time. `demo-select.js` drills a plate with five bores and works through every rule:
similar picks the four that match, grow and shrink go out and back, by size
takes the small ones, and a box dragged each way takes what it should.
`demo-step.js` writes a STEP file entity by entity, reads it back, and checks
the solid it makes measures exactly what the file described. `demo-recognise.js` drills a plate, reads it back as four holes in two sizes,
clicks a size to select it, then exports the same body to STL and reads it again
with no history at all to check it says the same thing. `demo-pull.js` clicks a face, drags the arrow that appears, checks the body grew
while the drag was happening, types an exact size over what was dragged to, and
does the same to a sketch profile. It also clicks seven places across one face
and measures how long the arrow is on screen at each, and it escapes out of a
pull and looks at what is left behind, because those are the three ways this
interaction has actually broken: a hidden edge on the far side of the part
winning over the face in front of it, so nothing could be picked in the middle
of a face; the arrow coming up as a zero-length dot pointing at the camera after
a sketch was finished; and the value box outliving the feature it belonged to
and floating beside the pointer for the rest of the session. An earlier version
of this demo pressed things with `element.click()`, which dispatches no pointer
events at all, and passed every run while all three were broken. Anything that
tests a gesture has to make the gesture. `demo-extrude.js` covers the same
feature reached the other way, from the ribbon on an empty document: press the
button, point at the profile, drag the arrow that appears, click the profile
again to let go of it and once more to take it back, type the exact size over
what was dragged to, and check the solid measures 40 by 24 by 12 with no callout
left hanging by the pointer afterwards. `demo-move.js` points a point to point
move at a corner from five pixels outside the body, reads the label beside the
cursor to check it says Corner rather than something vaguer, aims the other end
at the middle of an edge, and checks the part moved by exactly the difference
between the two. `demo-menus.js` drives the ribbon dropdowns with a real press, down then up then
click, rather than the bare `click()` every other demo uses, because that is a
path no mouse can take and it hid a menu that shut itself before the press could
land. And `demo-picking.js` checks the things a volume cannot see:
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

**Pull it, rather than asking for a command.** Click a planar face and an arrow
stands on it, with a distance box beside the arrow. Type the number, or drag the
arrow and watch the body follow as it happens with the number keeping up. Either
one on its own is enough: typing needs no drag first, and dragging fills the box
in. Enter accepts, Escape throws the whole thing away. A sketch profile does the
same and extrudes instead: one gesture, two features, because a face and a
profile want different things done to them but the same thing said.

The box used to exist only during a drag, so the only way to give a size was to
drag out a wrong one and type over it. The number is usually already known and
typing it is quicker, and there was nothing on screen that said the arrow could
be typed at, because there was nothing on screen to type in. It arrives focused,
too, or it is a box you have to find and click before it will take anything,
which from the keyboard is the same as not being there. Focus is only taken from
the viewport: a field somebody is already typing in keeps it.

**A click on the arrow is a click, not a drag of nothing.** Pressing it and
letting go without moving used to start the feature at zero, so clicking a face
a second time, or clicking anywhere near the arrow the first click had put up,
dropped you into Press Pull. From the outside that is the app deciding on its
own to extrude, and it is what made a face impossible to simply select and then
sketch on. A press that never moved now falls through to ordinary selection.

**Extrude takes the only profile on screen without being asked.** Fusion's own
Extrude reference says it does: "When you invoke the Extrude tool, and there is
only one profile visible in your design, it is automatically selected." That is
the difference between drawing a rectangle and having a solid, and drawing a
rectangle and being asked which of the one things on screen you meant. With more
than one visible it opens waiting to be pointed at, as before.

**A new extrude joins only where it stands on something.** The operation
defaults to Join when the sketch is drawn on a face of a body, which is what
adding a boss to a part looks like, and to New Body everywhere else. It used to
join whenever any body existed at all, so two rectangles drawn a hundred
millimetres apart on the same ground plane came out as one body with two lumps
in it.

It pulls both ways. A face offset carries its sign and cuts in when it is
negative; an extrude has no sign at all, being a length one way and a flag that
turns it round, and getting that wrong is how the first version could only ever
be dragged outward.

Straight after finishing a sketch you are looking square at the plane, so the
arrow points at your eye: no length on screen to drag along, and what it builds
grows towards you invisibly. Grabbing it turns the view first, the same few
degrees the Extrude dialog has always turned for the same reason, before the
drag rather than during it so nothing moves under the pointer. Where an axis is
still nearly end on, a drag upward grows it at the rate a pixel is worth where
the thing being pulled sits.

What is being dragged is the real feature, not a preview of one. The arrow
writes into the distance the dialog holds and the model rebuilds each frame, so
what is on screen while pulling is what will be there when you let go. That is
worth the rebuild it costs, and since v2.5.0 it mostly costs nothing: the
timeline in front of the feature is cached.

**The dialog gets the same arrow**, because reaching for the ribbon's Extrude is
the other way into the same feature and it used to be a dead end. It opens with
a distance of zero, deliberately, so nothing appears before a length is given,
and it opens asking to be pointed at, so no selection has to be made before
reaching for the command. Point at a profile and, until v2.24.0, that was as far
as it went: the callout said "1 chosen", the dialog held a zero, and there was
nothing on screen to change it with. The arrow was suppressed while a dialog was
open, and the value box only exists during a drag, so there was no drag to have
one. Typing into the dialog's own distance field worked, and nothing said that
was the only thing left that would.

Now the arrow stands on the profile the moment it is picked and drives the
feature the dialog is already editing. A press on it that never moves is treated
as a click on what is underneath rather than a drag of nothing, which is what
lets the same profile be clicked again to let go of it: the arrow the first
click puts up is standing exactly where the second click has to land.

**The callout steps aside for the arrow and its box.** It follows the pointer,
and the pointer is exactly where the arrow has just stood up, so it covered the
arrow completely. It passes clicks through, so the arrow could be grabbed the
whole time, which is worse rather than better: a panel reading "click the
profiles to use", sitting on top of the one thing on screen that would have said
what to do next. It now takes the first of eight positions round the cursor that
clears both of them, and it is told to move the moment the arrow appears rather
than at the next mouse move. Both, because avoiding only the arrow put it
exactly where the box had just gone, which swapped one thing covered for
another.

**An unfinished dialog is not a problem.** Extrude opens with a distance of zero
and nothing pointed at, deliberately, so pressing the button used to put "Extrude
has nothing to work from" in the browser under Problems, with a red mark beside
it, and "1 problem" in the corner, before anything had been done wrong. A new
feature's complaints stay in its own dialog footer, which is where they belong,
until OK is pressed. Editing an *existing* feature into a state that will not
build is a real problem and still reads as one.

**Reaching for a tool starts the sketch.** Clicking Rectangle on the Sketch tab
with nothing open asks which plane to put it on and then opens the sketch with
the rectangle already in hand. It used to say "start a sketch first" and do
nothing, which left every button on the tab dead with no route from the tab you
were looking at to the state it needed.

**Snapping** catches the origin first of all, then sketch points, midpoints and
centres, then anything projected in from the model, then the nearest point on
any curve, all within ten pixels of the cursor. The origin is deliberately the
strongest of them, because it is the anchor most sketches want to start from.
Grid snap is a separate switch and only applies where nothing else was caught.

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
