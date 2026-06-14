/**
 * Minimal shim for the ThreeJS post-processing addon used by the Now universe
 * (UnrealBloom). three ships addon JS but the `.js`-suffixed example path does
 * not resolve a declaration under moduleResolution=bundler — we only need the
 * three knobs we set, so a tiny ambient class keeps the build typed.
 */
declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js' {
  export class UnrealBloomPass {
    constructor(resolution?: unknown, strength?: number, radius?: number, threshold?: number);
    strength: number;
    radius: number;
    threshold: number;
  }
}
