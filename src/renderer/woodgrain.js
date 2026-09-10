/**
 * Wood grain, worked out in the shader rather than wrapped round the outside.
 *
 * A part in Anvil has no texture coordinates and should not need any. A solid
 * modelled from features has no natural way to be unwrapped, and every attempt
 * to give it one puts a seam somewhere and stretches the pattern at the corners.
 *
 * Wood does not want to be wrapped anyway. A wooden part is cut out of a block
 * that already had rings in it, so the grain belongs to the space the part
 * occupies and not to its surface: cut a groove across an oak plank and the
 * rings show in the walls of the groove, in the right places, because they were
 * already there. So the pattern here is a function of where a point is in the
 * world, which is what makes a face cut through it look cut rather than painted.
 *
 * The whole of it is procedural. An image of oak would be a file to ship, to
 * keep in the installer, and to be somebody's photograph.
 */

import * as THREE from './three.js';

/**
 * Which way the grain runs.
 *
 * Along the longest side, because that is how a board is cut: nobody saws a
 * plank across the tree. It is a guess and it is the right guess nearly always,
 * and it is a setting when it is not.
 */
export function grainAxis(size) {
  const [x, y, z] = size;
  if (x >= y && x >= z) return [1, 0, 0];
  if (y >= x && y >= z) return [0, 1, 0];
  return [0, 0, 1];
}

/**
 * How far apart the rings are, for a part of this size.
 *
 * A year of growth is a millimetre or two on oak, so the spacing is real rather
 * than relative: a small part shows a few rings and a big one shows many, which
 * is what happens when both are cut from the same tree. Scaling the rings to the
 * part instead is the thing that makes a render look like wallpaper.
 */
export function ringSpacing(mmPerRing = 3.4) {
  return 1 / Math.max(0.2, mmPerRing);
}

/**
 * Where the centre of the tree is, relative to the part.
 *
 * This is the number that decides whether a part looks like a board or like a
 * sheet of plywood, and getting it wrong the first time is what made that
 * obvious. Put the pith off to the side and the wide face cuts the rings
 * square, which gives the even parallel stripes of quarter-sawn timber; the
 * whole board then reads as a contour map.
 *
 * A flat-sawn board is cut with the pith below its wide face, so that face
 * slices the rings at a shallow angle and they open out into the long arches
 * everybody recognises as wood. So the pith goes under the thin direction, a
 * couple of widths away: close enough for the arches to curve, far enough that
 * the middle of the board is not a bullseye.
 */
export function pithOffset(centre, size, axis) {
  // The two directions across the grain, and which of them is the thickness.
  const dirs = [
    [[1, 0, 0], size[0]],
    [[0, 1, 0], size[1]],
    [[0, 0, 1], size[2]]
  ].filter(([d]) => !(d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]));
  dirs.sort((a, b) => a[1] - b[1]);
  const [thin] = dirs[0];
  const wide = dirs[dirs.length - 1][1];

  // Under the wide face, and a little to one side so the arches are not
  // perfectly symmetrical about the middle. Real boards are cut off centre.
  const down = wide * 1.6 + 15;
  const sideways = wide * 0.35;
  const across = dirs[dirs.length - 1][0];
  return [
    centre[0] - thin[0] * down + across[0] * sideways,
    centre[1] - thin[1] * down + across[1] * sideways,
    centre[2] - thin[2] * down + across[2] * sideways
  ];
}

/** The two colours of a wood, light early growth and dark late growth. */
export const WOODS = {
  // Oak is browner and much greyer than it looks in the mind's eye. The first
  // pair of colours here were a warm yellow that came out as pine, which is
  // the mistake everybody makes drawing wood from memory.
  oak: { light: 0xa8865c, dark: 0x5d4227, roughLight: 0.7, roughDark: 0.86 }
};

/*
 * The pattern itself.
 *
 * Rings around the pith, distorted by a little noise so they wander the way real
 * ones do, and a much finer noise along the grain for the open pores that make
 * oak read as oak rather than as a contour map.
 *
 * The roughness moves with the colour, and that is not decoration: late growth
 * is denser and takes a polish differently from early growth, so a real board
 * has a faint stripe in its reflection as well as in its colour. Without it the
 * grain reads as something printed on a plastic part.
 */
const NOISE = `
  float anvilHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float anvilNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(anvilHash(i + vec3(0, 0, 0)), anvilHash(i + vec3(1, 0, 0)), f.x),
          mix(anvilHash(i + vec3(0, 1, 0)), anvilHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(anvilHash(i + vec3(0, 0, 1)), anvilHash(i + vec3(1, 0, 1)), f.x),
          mix(anvilHash(i + vec3(0, 1, 1)), anvilHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float anvilFbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += anvilNoise(p) * amp;
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }
  float anvilGrain(vec3 world, vec3 pith, vec3 axis, float spacing) {
    // A frame across the grain, so the two directions square to it can be told
    // apart. The first version reached for the whole across vector as if it
    // were two numbers, which is not a thing, and the pores came out as blotches
    // rather than as streaks.
    vec3 up = abs(axis.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    vec3 u = normalize(cross(up, axis));
    vec3 v = cross(axis, u);

    vec3 rel = world - pith;
    float along = dot(rel, axis);
    float ax = dot(rel, u);
    float ay = dot(rel, v);
    // Distance from the centre of the tree, measured square to the grain: that
    // is what a growth ring is.
    float r = length(vec2(ax, ay));

    // The rings wander, and they wander slowly along the length rather than
    // wobbling from millimetre to millimetre.
    r += anvilFbm(world * 0.05 + axis * along * 0.008) * 7.0 - 3.5;

    /*
     * And they bunch and spread. A tree does not put on the same growth every
     * year, and evenly spaced rings are the single thing that most makes a
     * drawn grain look drawn: it reads as corrugation rather than as timber.
     */
    r *= 0.85 + anvilFbm(vec3(r * 0.02, along * 0.01, 0.0)) * 0.4;

    float rings = fract(r * spacing);
    // A dark band of late growth and a wider pale one of early growth. Wide
    // enough to be a band: a thin hard line reads as ink on paper, which is
    // what the first attempt at this looked like.
    float band = smoothstep(0.48, 0.72, rings) * smoothstep(1.0, 0.86, rings);

    // The pores: fine streaks that run along the grain and not across it. Oak
    // is a ring-porous wood, and this is most of what tells it from maple.
    float pores = anvilFbm(vec3(along * 1.2, ax * 6.0, ay * 6.0));
    band = clamp(band + smoothstep(0.62, 0.95, pores) * 0.22, 0.0, 1.0);

    // And a slow drift across the whole board, so the pale between the rings is
    // not one flat colour. Every real board has one side lighter than the other.
    band = clamp(band + (anvilFbm(world * 0.012) - 0.5) * 0.28, 0.0, 1.0);
    return band;
  }
`;

/**
 * Give a material a grain, and hand back the way to take it off again.
 *
 * Done by patching the material three is going to compile rather than by
 * writing a material from scratch, so everything else about it still works:
 * the environment reflects in it, the shadow falls on it, the clear coat sits
 * over it. A wood shader of my own would be a wood shader that has to be taught
 * all of that again.
 */
export function applyWoodGrain(material, spec, bounds) {
  const wood = WOODS[spec?.wood] || WOODS.oak;
  const size = [
    Math.max(1e-6, bounds.max[0] - bounds.min[0]),
    Math.max(1e-6, bounds.max[1] - bounds.min[1]),
    Math.max(1e-6, bounds.max[2] - bounds.min[2])
  ];
  const centre = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
  const axis = spec?.axis || grainAxis(size);
  const pith = pithOffset(centre, size, axis);

  const uniforms = {
    grainLight: { value: new THREE.Color(wood.light) },
    grainDark: { value: new THREE.Color(wood.dark) },
    grainRoughLight: { value: wood.roughLight },
    grainRoughDark: { value: wood.roughDark },
    grainAxis: { value: new THREE.Vector3(...axis) },
    grainPith: { value: new THREE.Vector3(...pith) },
    grainSpacing: { value: ringSpacing(spec?.mmPerRing) }
  };

  const was = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    was?.(shader);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrainWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGrainWorld;
         uniform vec3 grainLight;
         uniform vec3 grainDark;
         uniform float grainRoughLight;
         uniform float grainRoughDark;
         uniform vec3 grainAxis;
         uniform vec3 grainPith;
         uniform float grainSpacing;
         ${NOISE}`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float anvilBand = anvilGrain(vGrainWorld, grainPith, normalize(grainAxis), grainSpacing);
         diffuseColor.rgb = mix(grainLight, grainDark, anvilBand);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = mix(grainRoughLight, grainRoughDark, anvilBand);`
      );
  };
  // A material that has already been compiled keeps its old program until it is
  // told, and the whole change lives in the program.
  material.customProgramCacheKey = () => 'anvil-woodgrain';
  material.needsUpdate = true;

  return () => {
    material.onBeforeCompile = was || (() => {});
    material.customProgramCacheKey = () => '';
    material.needsUpdate = true;
  };
}
