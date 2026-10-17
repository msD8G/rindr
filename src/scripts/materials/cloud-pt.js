// Path tracer side of the cloud volumes (clouds.js): WGSL inserted into three-gpu-pathtracer's megakernel by the Vite
// plugin rindr-cloud (astro.config.mjs). Own module: only the lazily loaded path tracer imports it.
//  - a ray hitting a cloud proxy (ptVolume 3) walks through the volume: free flights by delta tracking (majorant =
//    the material's σ, density ≤ 1), at every scattering event next event estimation (one light or the environment,
//    transmittance through clouds and glass by the glass-shadow snippet, MIS with the phase function) and a new
//    direction from Henyey-Greenstein; leaving the box or reaching a surface inside continues the normal path.
//    Without any scattering the ray counts like a transparent pass (the background behind stays the background).
//  - shadow rays (glass-shadow.patch.wgsl) take the transmittance through the box (marched, jittered).
//  - density: the same lookups as the raster (field atlas + tiling noise, clouds.js) – must match densityAt there.
//  - the walk itself: cloud-walk.patch.wgsl (plain text, read by the Vite plugin), the shadow part in
//    glass-shadow.patch.wgsl
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { texture3D, sampler } from 'three/tsl';
import { CLOUD_TEXTURES, CLOUD_SIGMA, CLOUD_NOISE, CLOUD_REACH, EROSION } from './clouds.js';
import { FIELD_RES, FIELD_RANGE } from './cloud-field.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));

const atlasNode = texture3D(CLOUD_TEXTURES.atlas);
const noiseNode = texture3D(CLOUD_TEXTURES.noise);

const FIELD = wgslTagFn/* wgsl */`
    fn rindrCloudField( local: vec3f, slot: f32 ) -> f32 {

        let h = ${ f(0.5 / FIELD_RES) };
        let w = ( clamp( local.z + 0.5, h, 1.0 - h ) + slot ) / ${ f(CLOUD_TEXTURES.slots) };
        let fieldValue = textureSampleLevel( ${ atlasNode }, ${ sampler(atlasNode) }, vec3f( local.x + 0.5, local.y + 0.5, w ), 0.0 ).r;
        return ( fieldValue - 0.5 ) * ${ f(2 * FIELD_RANGE) };

    }
`;

const DENSITY = wgslTagFn/* wgsl */`
    fn rindrCloudDensity( local: vec3f, world: vec3f, slot: f32, scale: f32, puff: f32 ) -> f32 {

        let reach = puff * ${ f(CLOUD_REACH) };
        let coverage = clamp( ( reach - ${ FIELD }( local, slot ) ) / reach, 0.0, 1.0 );
        let q = world / scale;
        let billow = textureSampleLevel( ${ noiseNode }, ${ sampler(noiseNode) }, q * ( ${ f(CLOUD_NOISE.billow) } / puff ) + vec3f( 0.13, 0.71, 0.37 ), 0.0 ).r;
        let wisp = textureSampleLevel( ${ noiseNode }, ${ sampler(noiseNode) }, q * ( ${ f(CLOUD_NOISE.wisp) } / puff ), 0.0 ).g;
        let lo1 = min( ( 1.0 - billow ) * ${ f(EROSION.billow) }, 0.999 );
        let d = clamp( ( coverage - lo1 ) / ( 1.0 - lo1 ), 0.0, 1.0 );
        let lo2 = wisp * ${ f(EROSION.wisp) };
        return min( clamp( ( d - lo2 ) / ( 1.0 - lo2 ), 0.0, 1.0 ) / ${ f(EROSION.sharp) }, 1.0 );

    }
`;

// distance (world units) along which there is certainly no cloud – beyond the reach of the shape
const GAP = wgslTagFn/* wgsl */`
    fn rindrCloudGap( local: vec3f, slot: f32, scale: f32, puff: f32 ) -> f32 {

        return max( ${ FIELD }( local, slot ) - puff * ${ f(CLOUD_REACH) }, 0.0 ) * scale;

    }
`;

// distance along ld (not normalised: world units) until the unit box (−0.5…0.5) is left
const BOX_EXIT = wgslTagFn/* wgsl */`
    fn rindrCloudBoxExit( lo: vec3f, ld: vec3f ) -> f32 {

        let inv = 1.0 / ( ld + vec3f( 1e-9 ) );
        let t0 = ( vec3f( - 0.5 ) - lo ) * inv;
        let t1 = ( vec3f( 0.5 ) - lo ) * inv;
        return max( min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) ), 0.0 );

    }
`;

// PCG hash of the state → [0, 1)
const PCG = wgslTagFn/* wgsl */`
    fn rindrCloudPcg( state: u32 ) -> f32 {

        var w = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
        w = ( w >> 22u ) ^ w;
        return f32( w ) * ( 1.0 / 4294967296.0 );

    }
`;

// Henyey-Greenstein: direction around `dir` (cos to the propagation direction), and its pdf
const SAMPLE_HG = wgslTagFn/* wgsl */`
    fn rindrCloudSampleHG( dir: vec3f, g: f32, u: vec2f ) -> vec3f {

        var c = 1.0 - 2.0 * u.x;
        if ( abs( g ) > 1e-3 ) {

            let s = ( 1.0 - g * g ) / ( 1.0 - g + 2.0 * g * u.x );
            c = ( 1.0 + g * g - s * s ) / ( 2.0 * g );

        }
        let sn = sqrt( max( 1.0 - c * c, 0.0 ) );
        let phi = 6.283185307 * u.y;
        let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( dir.y ) > 0.9 );
        let tx = normalize( cross( helper, dir ) );
        let ty = cross( dir, tx );
        return normalize( tx * ( sn * cos( phi ) ) + ty * ( sn * sin( phi ) ) + dir * c );

    }
`;
const PDF_HG = wgslTagFn/* wgsl */`
    fn rindrCloudPdfHG( c: f32, g: f32 ) -> f32 {

        let d = 1.0 + g * g - 2.0 * g * c;
        return ( 1.0 - g * g ) / ( 12.566370614 * d * sqrt( max( d, 1e-6 ) ) );

    }
`;

export const CLOUD_PT = { density: DENSITY, gap: GAP, boxExit: BOX_EXIT, pcg: PCG, sampleHG: SAMPLE_HG, pdfHG: PDF_HG, sigma: CLOUD_SIGMA };
