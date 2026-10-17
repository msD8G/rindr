// Path tracer version of the glowing marble (marble.js – same function, same constants): inserted into the
// megakernel by the Vite plugin in astro.config.mjs (rindr-pt-stand-in). Own module: only the lazily loaded path
// tracer imports it (three-mesh-bvh/webgpu stays out of the start bundle).
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { MARBLE, ROT } from './marble.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));

const MARBLE_DENSITY_WGSL = wgslTagFn/* wgsl */`
    fn rindrMarbleDensity( p0: vec3f ) -> f32 {

        let rot = mat3x3f(
            ${ f(ROT[0][0]) }, ${ f(ROT[1][0]) }, ${ f(ROT[2][0]) },
            ${ f(ROT[0][1]) }, ${ f(ROT[1][1]) }, ${ f(ROT[2][1]) },
            ${ f(ROT[0][2]) }, ${ f(ROT[1][2]) }, ${ f(ROT[2][2]) } );
        let p = rot * p0;
        var q = abs( fract( p / ${ f(MARBLE.period) } ) * 2.0 - 1.0 ) * 2.0 - 1.0;
        var prev = 0.0;
        var acc = 0.0;
        for ( var i = 0; i < ${ MARBLE.iterations }; i ++ ) {

            q = abs( q ) / max( dot( q, q ), 1e-4 ) - vec3f( ${ MARBLE.fold.map(f).join(', ') } );
            let l = length( q );
            acc += exp( - ${ f(MARBLE.sharpness) } * abs( l - prev ) );
            prev = l;

        }
        return acc * ${ f(2 / MARBLE.iterations) };

    }
`;

export const MARBLE_WGSL = wgslTagFn/* wgsl */`
    fn rindrMarble( origin: vec3f, dir: vec3f, color: vec3f, scale: f32, intensity: f32, jitter: f32 ) -> vec3f {

        let o = origin / max( scale, 1e-6 );
        var col = vec3f( 0.0 );
        var t = ${ f(MARBLE.step) } * ( jitter - 1.0 );
        var c = 0.0;
        for ( var i = 0; i < ${ MARBLE.steps }; i ++ ) {

            t += ${ f(MARBLE.step) } * exp( - 2.0 * c );
            if ( t > ${ f(MARBLE.depth) } ) {

                break;

            }
            c = ${ MARBLE_DENSITY_WGSL }( o + dir * max( t, 0.0 ) );
            col = col * ${ f(MARBLE.decay) } + ( color * c + vec3f( 0.35 * c * c * c ) ) * ${ f(MARBLE.gain) };

        }
        return col * intensity;

    }
`;
