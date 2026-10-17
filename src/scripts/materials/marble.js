// Glowing marble (material param `marble`, toon.js): light veins deep inside the object – own implementation,
// inspired by volumetric fractal shaders on Shadertoy (no code taken over, see docs/materials.md). From the
// surface point the view ray is marched into the object (object space, so the pattern sticks to the part); at
// each step a Kaliset fractal (p → |p| / p² − fold, a classic formula) gives a density – high where successive
// iterates keep their length (thin filaments) – and the glow accumulates with a slow decay (deeper veins
// fainter). Steps get finer where the density is high. A mirrored tiling (oblique, so its mirror planes do not
// show as kaleidoscope) keeps coordinates of large CAD assemblies in the fractal's range.
//
// Two versions of the same function, kept in sync by hand: TSL for the raster view (marbleGlow, here) and WGSL
// for the path tracer (marble-pt.js – own module, so the start bundle does not pull in three-mesh-bvh/webgpu;
// inserted into the megakernel by the Vite plugin in astro.config.mjs). The path tracer gets the material
// values through the stand-in fields (pt-stand-in.js).
import { Matrix3 } from 'three/webgpu';
import { Fn, Loop, If, Break, float, vec3, abs, fract, dot, length, exp, max, uniform } from 'three/tsl';

export const MARBLE = {
    fold: [0.48, 0.52, 0.55],
    iterations: 11,
    sharpness: 25,      // filament width (exp(−k · |Δlength|))
    period: 10,         // tiling in pattern units
    steps: 48,
    step: 0.035,        // base step (pattern units), finer in dense parts
    depth: 2.2,         // how deep the ray looks into the object (pattern units)
    decay: 0.985,       // per step: deeper glow fainter
    gain: 0.04,
};

// oblique rotation (axis 1,2,3, 0.83 rad): the mirror planes of the tiling run across the pattern
export const ROT = (() => {
    const n = Math.hypot(1, 2, 3), [x, y, z] = [1 / n, 2 / n, 3 / n], t = 0.83, c = Math.cos(t), s = Math.sin(t);
    return [
        [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
        [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
        [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ];
})();

// --- raster (TSL) ---
const rot = uniform(new Matrix3().set(...ROT.flat()));   // set() takes rows
const density = Fn(([p0]) => {
    const p = rot.mul(p0);
    const q = abs(fract(p.div(MARBLE.period)).mul(2).sub(1)).mul(2).sub(1).toVar();
    const prev = float(0).toVar(), acc = float(0).toVar();
    Loop(MARBLE.iterations, () => {
        q.assign(abs(q).div(max(dot(q, q), 1e-4)).sub(vec3(...MARBLE.fold)));
        const l = length(q);
        acc.addAssign(exp(abs(l.sub(prev)).mul(-MARBLE.sharpness)));
        prev.assign(l);
    });
    return acc.mul(2 / MARBLE.iterations);
});

/**
 * Glow seen at a surface point: origin/dir in object space (scene units), colour (linear), scale = scene units
 * per pattern unit, intensity – linear RGB, before Fresnel.
 */
export const marbleGlow = Fn(([origin, dir, color, scale, intensity]) => {
    const o = origin.div(scale);
    const col = vec3(0).toVar(), t = float(0).toVar(), c = float(0).toVar();
    Loop(MARBLE.steps, () => {
        t.addAssign(exp(c.mul(-2)).mul(MARBLE.step));
        If(t.greaterThan(MARBLE.depth), () => { Break(); });
        c.assign(density(o.add(dir.mul(t))));
        col.assign(col.mul(MARBLE.decay).add(color.mul(c).add(c.mul(c).mul(c).mul(0.35)).mul(MARBLE.gain)));
    });
    return col.mul(intensity);
});
