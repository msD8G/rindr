// Shadows of glass in the path tracer (Settings → Path tracing → glass shadows) – uniforms read by the megakernel
// (Vite plugin rindr-glass-shadow in astro.config.mjs, WGSL: glass-shadow.patch.wgsl).
//
//   mode 0 – opaque: the library's behaviour. Shadow rays stop at glass (black shadow); light reaches the shadow only
//            through random caustic paths (diffuse → glass → light), noisy and mostly clamped away.
//   mode 1 – transparent: shadow rays pass transmissive surfaces (up to 16 faces). Per face: Fresnel transmission
//            as seen from outside (the ray is not bent – evaluating an exit face from inside with the straight
//            direction gave total internal reflection for every oblique light, glass under an HDRI stayed black
//            until Oct. 2026), times cos(bend angle)^6 – light an oblique face would turn away lands elsewhere:
//            structure and dark rims instead of a plain grey filter; tinted by the colour on entry, absorbed over
//            the distance inside (attenuation colour/distance). No focusing, no noise. Caustic paths (a rough
//            bounce, then a refraction, then a light/the environment) are not counted then – the light through
//            glass would come twice; next event estimation through glass takes the full weight. Lights and the
//            environment (HDRI) alike, also on the shadow catcher (ground).
//   colour fringe (mode 1, camera ray hits only): the path's wavelength (its "hero wavelength", uniform over the
//            spectrum) gets its own IOR (relative spread `fringe`, blue highest); its bend at the first glass face,
//            twice like a prism, tilts a second shadow ray → result = sharp shadow + (what this wavelength sees −
//            sharp) × its colour weight, the colour part (weight − 1) × 3 – edges and rims fan out into spectra
//            (blue outside, red inside), wider the farther behind the glass, fading with exp(−distance / falloff).
//            Smooth glass only (fades out with roughness 0.1 … 0.4 – frosted glass, wax/jelly stand-ins).
//            Plain areas stay noise-free (difference 0). Physically a flat pane would cancel out (in and out
//            parallel) – this is the look, not the physics. Before (Oct. 2026): a random cone ray, blue/red mixed
//            from it → soft and orange.
import { uniform } from 'three/tsl';

export const GLASS_SHADOW = {
    mode: uniform(1, 'uint'),
    fringe: uniform(0),     // relative IOR spread red ↔ blue of the fringe ray, 0 = no fringe
    falloff: uniform(1),    // distance (world units) over which the fringe fades to 1/e
};
