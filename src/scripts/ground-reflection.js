// Ground reflection and bad weather (puddles) on the ground disc (ground.js) – path tracer (HQ) only (user's
// choice, Oct. 2026: the raster view stays without mirror image; a planar reflection there cost a second render
// of the scene per frame – see docs/environment.md).
//
// The shadow catcher branch (shadow-catcher.patch.wgsl) calls GROUND_SURFACE_WGSL: at a ground point seen from a
// direction → reflection share r, roughness (blur) and darkening d of the background below.
//   - dry: r = strength × (0.25 … 1 with Fresnel), roughness = blur
//   - bad weather: procedural puddles in world XZ (value-noise fbm, threshold = coverage, soft edge): in a puddle
//     a sharp, strong water mirror and dark ground; around them damp ground – darker, a weak blurred reflection
//   - all of it fades out towards the edge like the ground shadow (size/softness in the panel)
// Composition: background × shadow × (1 − r) × d + reflection × r; the path continues as reflection ray (glossy
// around the mirror direction) with weight r. HDRI background hidden: only the model is mirrored (KeyShot style).
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

// x = reflection strength (0 = off), y = blur 0…1, z = bad weather 0/1, w = puddle coverage 0…1
// params2: x = puddle size (world units), y/z = centre of the ground (world xz), w = 1: the environment is reflected
//   too (HDRI background visible), 0: only the model (like KeyShot's ground reflections – misses keep the background)
export const GROUND_SURFACE = {
    params: uniform(new THREE.Vector4(0, 0.2, 0, 0.4)),
    params2: uniform(new THREE.Vector4(1, 0, 0, 0)),
    // x/y = soft edge: effects fade out between these distances from the centre (as the ground shadow's edge)
    params3: uniform(new THREE.Vector4(1e9, 1e9, 0, 0)),
};

const WET = { roughness: 0.35, darken: 0.72, puddleDarken: 0.5, edge: 0.04 };
const OCTAVES = 4;

const HASH_WGSL = wgslTagFn/* wgsl */`
    fn rindrGroundHash( p: vec2f ) -> f32 {

        return fract( sin( dot( p, vec2f( 127.1, 311.7 ) ) ) * 43758.5453 );

    }
`;

const NOISE_WGSL = wgslTagFn/* wgsl */`
    fn rindrGroundNoise( p: vec2f ) -> f32 {

        let i = floor( p );
        let f = fract( p );
        let u = f * f * ( 3.0 - 2.0 * f );
        let a = ${ HASH_WGSL }( i );
        let b = ${ HASH_WGSL }( i + vec2f( 1.0, 0.0 ) );
        let c = ${ HASH_WGSL }( i + vec2f( 0.0, 1.0 ) );
        let d = ${ HASH_WGSL }( i + vec2f( 1.0, 1.0 ) );
        return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );

    }
`;

export const GROUND_SURFACE_WGSL = wgslTagFn/* wgsl */`
    fn rindrGroundSurface( pos: vec3f, view: vec3f ) -> vec4f {

        let P = ${ GROUND_SURFACE.params };
        let P2 = ${ GROUND_SURFACE.params2 };
        let P3 = ${ GROUND_SURFACE.params3 };
        let schlick = pow( 1.0 - saturate( view.y ), 5.0 );
        let e = saturate( ( length( pos.xz - vec2f( P2.y, P2.z ) ) - P3.x ) / max( P3.y - P3.x, 1e-6 ) );
        let fade = 1.0 - e * e * e * ( e * ( e * 6.0 - 15.0 ) + 10.0 );
        let rDry = P.x * mix( 0.25, 1.0, schlick );
        var p = ( pos.xz - vec2f( P2.y, P2.z ) ) / max( P2.x, 1e-4 );
        var sum = 0.0;
        var amp = 0.5;
        var norm = 0.0;
        for ( var o = 0; o < ${ OCTAVES }; o ++ ) {

            sum += ${ NOISE_WGSL }( p ) * amp;
            norm += amp;
            p = vec2f( p.x * 1.6 - p.y * 1.2, p.x * 1.2 + p.y * 1.6 ) + vec2f( 17.3, 9.1 );
            amp *= 0.5;

        }
        let n = sum / norm;
        let t = 1.0 - P.w;
        let puddle = smoothstep( t - ${ WET.edge }, t + ${ WET.edge }, n ) * P.z;
        let wet = P.z;
        let rWet = max( rDry, mix( 0.12, 0.6, schlick ) );
        let rPuddle = mix( 0.35, 0.95, schlick );
        let r = mix( rDry, mix( rWet, rPuddle, puddle ), wet ) * fade;
        let rough = mix( P.y, mix( max( P.y, ${ WET.roughness } ), 0.0, puddle ), wet );
        let d = mix( 1.0, mix( ${ WET.darken }, ${ WET.puddleDarken }, puddle ), wet * fade );
        return vec4f( r, rough, d, P2.w );   // w: reflect the environment too

    }
`;
