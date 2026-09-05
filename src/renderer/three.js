/**
 * Single point of contact with three.js.
 *
 * Importing the library through one shim keeps every renderer module on the
 * exact same instance and means the path to the build is written once. An
 * inline import map would be the other way to do this, but the app runs under
 * a strict Content Security Policy that refuses inline scripts.
 */

export * from '../../node_modules/three/build/three.module.js';
