// HDRI background as one continuous surface around the capture point ("flatten ground"): a flat floor that
// turns into a sphere over a rounded edge – like three.js GroundedSkybox, with the corner rounded:
//   - projection point C (`center`) = capture point of the HDRI, `floor` above the ground centre
//   - a ray is intersected with the ground plane (distance tp) and with the sphere of radius R around C
//     (ts); the hit is at t = smooth-min(tp, ts, k) – exactly the plane near the model, exactly the sphere
//     far out, a fillet of size k (`blend` × R) in between. The HDRI is looked up in the direction
//     C → hit point; moving/zooming the camera changes the background (parallax).
//   - Being one surface, the image stays continuous: lines of the HDRI (trees, house edges) bend at the
//     transition but never break or double. (Before: floor and sphere were two projections crossfaded –
//     two different HDRI directions on top of each other → doubled/offset vertical lines in the zone.)
//   - shift ("HDRI height"): the HDRI is pushed up/down – latitudes are remapped so that the horizon
//     shows latitude −shift, nadir and zenith stay (applies to the whole surface)
// Every background/environment lookup goes through it:
//   - raster: scene.backgroundNode (TSL), seen from the camera
//   - path tracer: DOME_DIRECTION (WGSL, inserted into the megakernel by the Vite plugin in
//     astro.config.mjs) with the real ray origin – camera rays, reflections (bounce > 0, the floor shows up
//     in the paint) and refractions. The light itself (next event estimation) still comes from the
//     unchanged HDRI.
// Disabled (no HDRI background or "flatten ground" off) the direction is returned unchanged.
import * as THREE from 'three/webgpu';
import { Fn, If, float, texture, uniform, vec2, vec3, vec4, normalWorldGeometry, equirectUV, backgroundRotation } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

// shared by the raster node and the path tracer kernel
const U = {
    enabled: uniform(0),
    origin: uniform(new THREE.Vector3()),   // raster: camera − projection point (world axes)
    center: uniform(new THREE.Vector3()),   // projection point C (world) – path tracer: any ray origin
    radius: uniform(10),                    // sphere radius R
    floor: uniform(1),                      // C above the ground plane (floor at y = −floor relative to C)
    blend: uniform(1),                      // fillet between floor and sphere (ray distance units)
    shift: uniform(0),                      // HDRI latitude at the horizon (rad, ≤ 0 = pushed up)
};

// latitude remap: φ = 0 (horizon) → shift, ±90° stay
const SHIFT_WGSL = wgslTagFn/* wgsl */`
    fn hdriShift( d: vec3f, shift: f32 ) -> vec3f {

        let halfPi = 1.5707963;
        let phi = asin( clamp( d.y, - 1.0, 1.0 ) );
        let lat = select( shift + phi * ( halfPi - shift ) / halfPi, shift + phi * ( halfPi + shift ) / halfPi, phi < 0.0 );
        let h = length( d.xz );
        let az = select( vec2f( 1.0, 0.0 ), d.xz / h, h > 1e-6 );
        return vec3f( az.x * cos( lat ), sin( lat ), az.y * cos( lat ) );

    }
`;

/**
 * WGSL: HDRI direction for a ray (origin, direction). Unchanged when disabled. (xi: unused – the surface is
 * deterministic; kept so the kernel call sites stay unchanged.)
 */
export const DOME_DIRECTION = wgslTagFn/* wgsl */`
    fn domeDirection( origin: vec3f, direction: vec3f, xi: f32 ) -> vec3f {

        if ( ${ U.enabled } < 0.5 ) {

            return direction;

        }

        // origin outside the sphere (camera zoomed far out): keep it just inside
        var p = origin - ${ U.center };
        let R = ${ U.radius };
        if ( length( p ) > R * 0.98 ) {

            p = normalize( p ) * R * 0.98;

        }

        // sphere (origin inside → always hit)
        let b = dot( p, direction );
        let c = dot( p, p ) - R * R;
        let ts = - b + sqrt( max( b * b - c, 0.0 ) );

        // ground plane (not hit: far away → smooth-min gives the sphere)
        let h = ${ U.floor };
        var tp = 1e9;
        if ( direction.y < 0.0 && p.y > - h ) {

            tp = ( - h - p.y ) / direction.y;

        }

        // polynomial smooth-min: exactly min() where the two differ by more than k
        let k = ${ U.blend };
        let m = max( k - abs( tp - ts ), 0.0 ) / k;
        let t = max( min( tp, ts ) - m * m * k * 0.25, 1e-4 );
        let d = normalize( p + direction * t );
        return ${ SHIFT_WGSL }( d, ${ U.shift } );

    }
`;

// --- Raster: the same surface ---
const shiftTsl = Fn(([d]) => {
    const halfPi = Math.PI / 2, shift = U.shift;
    const phi = d.y.clamp(-1, 1).asin();
    const lat = phi.lessThan(0).select(shift.add(phi.mul(shift.add(halfPi)).div(halfPi)), shift.add(phi.mul(float(halfPi).sub(shift)).div(halfPi)));
    const h = d.xz.length();
    const az = h.greaterThan(1e-6).select(d.xz.div(h), vec2(1, 0));
    return vec3(az.x.mul(lat.cos()), lat.sin(), az.y.mul(lat.cos()));
});

export class BackgroundDome {
    constructor() {
        this.enabled = false;
        this.center = new THREE.Vector3();   // projection point C (world)
        this.radius = 10;
        this._map = texture(new THREE.Texture());
        const dir = normalWorldGeometry.normalize();
        const lookup = d => this._map.sample(equirectUV(backgroundRotation.mul(vec4(shiftTsl(d), 0)).xyz));
        // (If/toVar only work inside a Fn)
        this.node = Fn(() => {
            const R = U.radius, h = U.floor, k = U.blend;
            // camera relative to C, kept inside the sphere (update() clamps it)
            const p = U.origin;
            const b = p.dot(dir), c = p.dot(p).sub(R.mul(R));
            const ts = b.negate().add(b.mul(b).sub(c).max(0).sqrt());
            const tp = float(1e9).toVar();
            If(dir.y.lessThan(0).and(p.y.greaterThan(h.negate())), () => {
                tp.assign(h.negate().sub(p.y).div(dir.y));
            });
            const m = k.sub(tp.sub(ts).abs()).max(0).div(k);
            const t = tp.min(ts).sub(m.mul(m).mul(k).mul(0.25)).max(1e-4);
            const d = p.add(dir.mul(t)).normalize();
            return U.enabled.greaterThan(0.5).select(lookup(d), lookup(dir));
        })();
    }

    /**
     * Configure. Raster: the scene gets the background node only when active.
     * @param {THREE.Scene} scene
     * @param {{enabled: boolean, texture?: THREE.Texture, center?: THREE.Vector3, radius?: number, floor?: number,
     *   blend?: number, shift?: number}} o
     *   center = projection point C, radius = sphere radius, floor = C above the ground plane,
     *   blend 0…1 = rounding of the edge between floor and sphere (share of the radius),
     *   shift −0.95…0.95: HDRI pushed up by shift · 90° (horizon shows latitude −shift · 90°)
     */
    set(scene, { enabled, texture: map, center, radius = 10, floor = 1, blend = 0.3, shift = 0 }) {
        this.enabled = enabled;
        if (enabled) {
            if (this._map.value !== map) this._map.value = map;
            this.center.copy(center);
            this.radius = Math.max(radius, floor * 1.05, 1e-6);
        }
        U.enabled.value = enabled ? 1 : 0;
        U.center.value.copy(this.center);
        U.radius.value = this.radius;
        U.floor.value = Math.max(floor, 1e-6);
        U.blend.value = Math.max(blend, 0.001) * this.radius;
        U.shift.value = -Math.min(Math.max(shift, -0.95), 0.95) * Math.PI / 2;
        scene.backgroundNode = enabled ? this.node : null;
    }

    /** Camera position relative to the projection point (raster) – call before rendering */
    update(camera) {
        if (!this.enabled) return;
        const p = U.origin.value.copy(camera.position).sub(this.center);
        if (p.length() > this.radius * 0.98) p.setLength(this.radius * 0.98);
    }
}
