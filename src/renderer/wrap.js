/**
 * An image wrapped over a whole body, with no unwrapping and no seams.
 *
 * Fusion does not have this, and the reason is worth stating because it is the
 * reason not to copy how Fusion does it. A decal there is a planar projection:
 * you point it at a face, it lands on that face, and it stops where the face
 * stops. Point it at a rounded corner and it stretches; point it at a part and
 * it covers the side you were looking at. Anvil has that too and it is the right
 * tool for putting a logo in one place.
 *
 * What it is not is a finish. A knurl, a carbon weave, a hammered texture, a
 * hex pattern, brushed grain: those belong to the whole part, they have to
 * carry round every corner, and there is no face to point at. Doing that the
 * usual way means unwrapping the model, and a solid built from features has no
 * natural unwrapping: every one of them puts a seam somewhere and stretches the
 * pattern where the surface curves.
 *
 * So the image is projected three times, once down each axis, and the three are
 * blended by which way the surface happens to face. A face pointing up takes the
 * top projection, a face pointing sideways takes a side one, and a rounded
 * corner takes a mixture, which is what makes the pattern carry round it without
 * a join. It costs three texture reads and needs nothing of the geometry at all,
 * which means it works exactly as well on an imported mesh as on a modelled
 * solid.
 *
 * What it cannot do is hold a shape that must not repeat or distort. Wrapping a
 * photograph of a face round a sphere with this would show it three times. That
 * is what the decal is for, and this says so rather than pretending.
 */

import * as THREE from './three.js';

/** How the image is laid on: tinting what is there, or replacing it. */
export const WRAP_MODES = [
  ['tint', 'Tint what is underneath'],
  ['replace', 'Replace the colour']
];

/**
 * A texture from an image already in the document.
 *
 * Repeating by default, because a pattern that stops has an edge, and an edge
 * is the thing this whole approach exists to avoid.
 */
export function wrapTexture(url, opts = {}, onReady) {
  /*
   * The callback is not optional decoration.
   *
   * An image loads after the material has already been compiled and drawn, and
   * a viewport that only draws when something changes has no reason to draw
   * again. So the texture sits there loaded, never uploaded, and every surface
   * reads the placeholder: the part comes out one flat colour and looks for all
   * the world like a shader that does not work.
   */
  const tex = new THREE.TextureLoader().load(url, () => onReady?.());
  tex.wrapS = opts.tile === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapT = tex.wrapS;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Anisotropy matters here more than usual: a pattern seen at a glancing angle
  // across a long face is the ordinary case, not the exception.
  tex.anisotropy = 8;
  return tex;
}

/**
 * Put a wrapped image on a material, and hand back the way to take it off.
 *
 * Patched into the material three is going to compile rather than written from
 * scratch, the same as the wood grain, so everything else about the material
 * still works: the environment reflects in it, the shadow falls on it, the
 * clear coat sits over it.
 */
export function applyWrap(material, spec, texture) {
  const size = Math.max(0.1, Number(spec?.size) || 40);
  /*
   * The image goes in three's own map slot rather than in a sampler of my own.
   *
   * A custom sampler added in onBeforeCompile does not get bound: the float
   * uniforms beside it arrive perfectly well and the texture reads black, which
   * makes the part come out one flat colour and looks exactly like a shader
   * that does not work. The map slot is a path three already knows how to feed,
   * so what is left to do here is only to decide the coordinates.
   *
   * It wants texture coordinates on the geometry, which a solid does not have.
   * That does not matter: the ones it works out are thrown away and never read.
   */
  material.map = texture;

  const uniforms = {
    // How many millimetres one tile covers. Real units rather than a fraction
    // of the part, so the same knurl is the same knurl on a knob and on a
    // handle, which is the whole point of a finish.
    wrapScale: { value: 1 / size },
    wrapAngle: { value: ((Number(spec?.angle) || 0) * Math.PI) / 180 },
    wrapStrength: { value: Math.max(0, Math.min(1, spec?.strength ?? 1)) },
    // How quickly one projection gives way to the next round a corner. Low is a
    // long soft blend, high is a crisp changeover.
    wrapSharpness: { value: Math.max(1, Number(spec?.sharpness) || 4) },
    wrapReplace: { value: spec?.mode === 'replace' ? 1 : 0 },
    wrapOffset: { value: new THREE.Vector2(Number(spec?.x) || 0, Number(spec?.y) || 0) }
  };

  const was = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    was?.(shader);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWrapWorld;\nvarying vec3 vWrapNormal;'
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWrapWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vWrapNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWrapWorld;
         varying vec3 vWrapNormal;`
      )
      .replace(
        // After three has declared the sampler, not before: the helper below
        // reads `map`, and at <common> that name does not exist yet.
        '#include <map_pars_fragment>',
        `#include <map_pars_fragment>
         uniform float wrapScale;
         uniform float wrapAngle;
         uniform float wrapStrength;
         uniform float wrapSharpness;
         uniform float wrapReplace;
         uniform vec2 wrapOffset;

         vec2 anvilSpin(vec2 uv, float a) {
           float c = cos(a);
           float s = sin(a);
           return vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);
         }

         vec4 anvilWrap(vec3 world, vec3 n) {
           vec3 p = world * wrapScale;
           vec2 off = wrapOffset * wrapScale;
           // Three projections, each one reading the two coordinates that are
           // not the axis it looks down.
           vec4 xs = texture2D(map, anvilSpin(p.yz, wrapAngle) + off);
           vec4 ys = texture2D(map, anvilSpin(p.zx, wrapAngle) + off);
           vec4 zs = texture2D(map, anvilSpin(p.xy, wrapAngle) + off);

           // Blended by which way the surface faces, so a face square to one
           // axis takes that projection outright and a corner takes a mixture.
           vec3 w = pow(abs(n), vec3(wrapSharpness));
           w /= max(w.x + w.y + w.z, 1e-5);
           return xs * w.x + ys * w.y + zs * w.z;
         }`
      )
      .replace(
        '#include <map_fragment>',
        `vec4 anvilPaint = anvilWrap(vWrapWorld, normalize(vWrapNormal));
         // Where the image has holes in it, what is underneath shows through.
         // A logo on a plate is a logo on a plate, not a square of white.
         float anvilCover = anvilPaint.a * wrapStrength;
         vec3 anvilOver = mix(diffuseColor.rgb * anvilPaint.rgb, anvilPaint.rgb, wrapReplace);
         diffuseColor.rgb = mix(diffuseColor.rgb, anvilOver, anvilCover);`
      );
  };
  // A material that has already been compiled keeps its old program until it is
  // told, and the whole change lives in the program.
  material.customProgramCacheKey = () => `anvil-wrap-${size}-${spec?.mode || 'tint'}`;
  material.needsUpdate = true;

  return () => {
    material.map = null;
    material.onBeforeCompile = was || (() => {});
    material.customProgramCacheKey = () => '';
    material.needsUpdate = true;
  };
}
