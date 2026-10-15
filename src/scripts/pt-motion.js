// Settings of the path tracer kernel while orbiting (pathtracer.js motion mode) – uniforms read by the megakernel
// (Vite plugin rindr-glass-bounces in astro.config.mjs).
//   glassBounces: refractions that do not count as bounces. While orbiting only 3 bounces are traced; glass needs
//   one per surface (in, out, the next pane …) – the paths ended inside and every glass turned black until the
//   mouse was released. Set to (bounces when standing still − bounces while orbiting) in motion, 0 otherwise, so
//   glass looks as when standing still while diffuse light stays cheap.
import { uniform } from 'three/tsl';

export const PT_MOTION = {
    glassBounces: uniform(0, 'uint'),
};
