// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Patches three-gpu-pathtracer's megakernel (fails loudly if the library changed – check on every update):
// - shadow catcher (src/scripts/shadow-catcher.js): matte branch → src/scripts/shadow-catcher.patch.wgsl
// - background dome (src/scripts/background-dome.js): every background/environment lookup of a ray goes
//   through domeDirection(ray.origin, ray.direction) – camera rays, reflections and refractions
const SHADOW_CATCHER_MODULE = fileURLToPath(new URL('./src/scripts/shadow-catcher.js', import.meta.url));
const DOME_MODULE = fileURLToPath(new URL('./src/scripts/background-dome.js', import.meta.url));
const SHADOW_CATCHER_PATCH = fileURLToPath(new URL('./src/scripts/shadow-catcher.patch.wgsl', import.meta.url));
const FISHEYE_MODULE = fileURLToPath(new URL('./src/scripts/fisheye.js', import.meta.url));
// fisheye ray + depth of field with a spherical focus surface (distance along the ray) and the aperture
// perpendicular to the ray – the shim's flat focal plane divides by dot( direction, forward ) (0 at 90°)
const FISHEYE_DOF = `
			if ( \${ __FISHEYE }( ndc, \${ cameraWorldMatrix }, ray ) ) {

				let fisheyeFocus = ray.origin + ray.direction * \${ focusDistance };
				var fisheyeAperture = \${ sampleAperture }( \${ apertureBlades }, \${ rand3 }( \${ RNG_INDEX_APERTURE_SAMPLE } ) );
				fisheyeAperture = \${ rotateVector }( fisheyeAperture * \${ bokehSize } * 0.5 * 1e-3, \${ apertureRotation } )
					* vec2f( \${ anamorphicRatio }, 1.0 / \${ anamorphicRatio } );
				let fisheyeUp = normalize( ( \${ cameraWorldMatrix } * vec4f( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
				let fisheyeHelper = select( fisheyeUp, normalize( ( \${ cameraWorldMatrix } * vec4f( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), abs( dot( fisheyeUp, ray.direction ) ) > 0.99 );
				let fisheyeX = normalize( cross( ray.direction, fisheyeHelper ) );
				let fisheyeY = cross( fisheyeX, ray.direction );
				ray.origin += fisheyeX * fisheyeAperture.x + fisheyeY * fisheyeAperture.y;
				ray.direction = normalize( fisheyeFocus - ray.origin );
				return true;

			}`;
function shadowCatcherPatch() {
  const anchor = /if \( materialInfo\.matte != 0 && bounce == 0u \) \{\s*resultColor = vec4f\( 0\.0 \);\s*break;\s*\}/;
  return {
    name: 'rindr-shadow-catcher',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      // fisheye lens (src/scripts/fisheye.js): the base camera ray of the PhysicalCamera gets the fisheye direction
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/shims/PhysicalCameraShim.js')) {
        const base = '*ray = ${ ndcToCameraRay }( ndc, ${ invViewProjectionMatrix } );';
        if (code.split(base).length !== 2) this.error('rindr-fisheye: base ray not found exactly once in PhysicalCameraShim.js (three-gpu-pathtracer changed?)');
        code = code.replace(base, () => base + FISHEYE_DOF);
        return { code: `import { FISHEYE_RAY as __FISHEYE } from ${JSON.stringify(FISHEYE_MODULE)};\n` + code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      if (!anchor.test(code)) this.error('rindr-shadow-catcher: matte branch not found in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)');
      code = code.replace(anchor, () => readFileSync(SHADOW_CATCHER_PATCH, 'utf8'));
      // background dome: the three lookups by ray direction
      for (const [from, to] of [
        ['${ sampleBackground }( ray.direction, rng )', '${ sampleBackground }( ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) ), rng )'],
        ['${ sampleEnvColor }( ray.direction ).rgb * throughputColor * misWeight', '${ sampleEnvColor }( ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) ) ).rgb * throughputColor * misWeight'],
        ['let env = ${ sampleEnvColor }( ray.direction );', 'let env = ${ sampleEnvColor }( ${ __DOME }( ray.origin, ray.direction, ${ rand1 }( 130u ) ) );'],
      ]) {
        if (code.split(from).length !== 2) this.error(`rindr-shadow-catcher: "${from}" not found exactly once in PathTracerMegaKernel.js`);
        code = code.replace(from, () => to);
      }
      return {
        code: `import { SHADOW_CATCHER as __SC } from ${JSON.stringify(SHADOW_CATCHER_MODULE)};\n` +
          `import { DOME_DIRECTION as __DOME } from ${JSON.stringify(DOME_MODULE)};\n` + code,
        map: null,
      };
    },
  };
}

// Patches three-gpu-pathtracer against main-thread stalls when switching to HQ (fails loudly if the library
// changed – check on every update):
// - environment importance sampling: EquirectHdrInfoNode.updateFrom takes the table computed in a worker
//   (src/scripts/env-cdf.js) instead of computing it on the main thread
// - TextureCache.setFromScene hashed the uuid of a fresh clone → never equal → every updateEnvironment()
//   rebuilt environment and background (useMegakernel: table computed twice)
// - OIDNDenoiser: one MRT node for the albedo/normal pass (see below)
// - EquirectHdrInfoUniform: `Source` → `TextureSource` (renamed in three r186, the old name warns in the console)
const ENV_CDF_MODULE = fileURLToPath(new URL('./src/scripts/env-cdf.js', import.meta.url));
function pathTracerPerfPatch() {
  return {
    name: 'rindr-pathtracer-perf',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const replaceOnce = (from, to, name) => {
        if (code.split(from).length !== 2) this.error(`rindr-pathtracer-perf: "${from.trim()}" not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, () => to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/EquirectHdrInfoNode.js')) {
        replaceOnce('super.updateFrom( envMap );', 'if ( ! __applyEnvCdf( this, envMap ) ) super.updateFrom( envMap );', 'EquirectHdrInfoNode.js');
        return { code: `import { applyEnvCdf as __applyEnvCdf } from ${JSON.stringify(ENV_CDF_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/uniforms/EquirectHdrInfoUniform.js')) {
        replaceOnce(' HalfFloatType, Source, ', ' HalfFloatType, TextureSource, ', 'EquirectHdrInfoUniform.js');
        replaceOnce('new Source(', 'new TextureSource(', 'EquirectHdrInfoUniform.js');
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/denoise/OIDNDenoiser.js')) {
        // one MRT node for the albedo/normal pass: three.js keys render contexts by mrt.id – a new node per
        // pass rebuilt every material variant on each denoise (~0.8 s main thread + synchronous pipelines);
        // stable, the shaders can also be compiled in advance (PathTracingView._prepareDenoiser)
        replaceOnce('renderer.setMRT( mrt( {', 'renderer.setMRT( this._auxMRT ??= mrt( {', 'OIDNDenoiser.js');
        return { code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/WebGPUPathTracer.js')) {
        replaceOnce(`value = value.clone();
			hash = value.uuid + '_' + value.version;`, `hash = value.uuid + '_' + value.version;
			value = value.clone();`, 'WebGPUPathTracer.js');
        return { code, map: null };
      }
      return null;
    },
  };
}

// Material stand-ins in three-gpu-pathtracer (src/scripts/pt-stand-in.js, RindrMaterial in toon.js – fails loudly if
// the library changed, check on every update): the material packing reads userData.ptStandIn over each material.
// - subsurface look: translucent share as rough transmission, gloss as clearcoat, colour absorbed over the
//   distance travelled inside. A random walk in the megakernel looked good but took 2–5× the render time of plain
//   plastic (Oct. 2026) – the user chose this fast approximation instead.
// - glowing marble (marble.js): flag in the unused fogVolume field (ptVolume 2), colour/scale/intensity in the
//   sheen/iridescence fields (off for these materials); the megakernel adds the glow seen through a front face
//   (MARBLE_WGSL in marble-pt.js, same function as the raster view) as emission. Wavefront kernels: no glow.
const PT_STAND_IN_MODULE = fileURLToPath(new URL('./src/scripts/pt-stand-in.js', import.meta.url));
const MARBLE_MODULE = fileURLToPath(new URL('./src/scripts/marble-pt.js', import.meta.url));
const MARBLE_EMISSION = `
						// RINDR glowing marble (marble.js): the veins inside, seen through the front face
						if ( materialInfo.fogVolume == 2 && hitResult.side > 0.0 ) {

							let mbOrigin = ( objectInfo.inverseMatrixWorld * vec4f( vertexData.position.xyz, 1.0 ) ).xyz;
							let mbDir = normalize( ( objectInfo.inverseMatrixWorld * vec4f( ray.direction, 0.0 ) ).xyz );
							let mbCos = saturate( abs( dot( hitResult.normal, ray.direction ) ) );
							let mbFresnel = 0.04 + 0.96 * pow( 1.0 - mbCos, 5.0 );
							let mbGlow = \${ __MARBLE }( mbOrigin, mbDir, materialInfo.sheenColor, materialInfo.sheenRoughness, materialInfo.iridescenceThicknessMinimum, \${ rand1 }( 150u ) );
							resultColor += vec4f( \${ clampPathContributionFunc }( throughputColor * mbGlow * ( 1.0 - mbFresnel ), bounce, clampDirect, clampIndirect ), 0.0 );

						}

`;
function ptStandInPatch() {
  return {
    name: 'rindr-pt-stand-in',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const name = file.split('/').pop();
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-pt-stand-in: ${from} not found exactly once in ${name} (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/nodes/PathtracerBVHComputeData.js')) {
        replaceOnce('const m = materials[ i ];', () => 'const m = __ptStandIn( materials[ i ] );');
        replaceOnce(/(intArray\[ index \+\+ \] = Number\( m\.transparent \);\n\t+intArray\[ index \+\+ \] = )0;/, (_, head) => `${head}getField( m, 'ptVolume', 0 );`);
        return { code: `import { ptStandIn as __ptStandIn } from ${JSON.stringify(PT_STAND_IN_MODULE)};\n` + code, map: null };
      }
      if (file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) {
        replaceOnce(/\n(\t+)\/\/ emission, clamped at the depth of the segment that found it/, m => '\n' + MARBLE_EMISSION + m.slice(1));
        return { code: `import { MARBLE_WGSL as __MARBLE } from ${JSON.stringify(MARBLE_MODULE)};\n` + code, map: null };
      }
      return null;
    },
  };
}

// Cross-origin isolation: required for SharedArrayBuffer so three-mesh-bvh can build the BVH
// in parallel on several workers (= CPU cores). In production public/.htaccess sets the
// same headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// .env is not loaded into process.env for the config itself (prefix '' = all keys, read here only)
const fileEnv = loadEnv(process.env.NODE_ENV === 'production' ? 'production' : 'development', process.cwd(), '');

export default defineConfig({
  // Sub directory on the server: BASE_PATH=/rindr/ npm run build (default: domain root).
  // All runtime paths use import.meta.env.BASE_URL or are relative.
  base: process.env.BASE_PATH || '/',
  // Public origin for absolute og:image / og:url links: SITE_URL in .env or the shell
  // (without it the social-preview tags use relative paths, which most crawlers ignore).
  site: process.env.SITE_URL || fileEnv.SITE_URL || undefined,
  server: {
    host: true,
    port: 4321,
    headers: isolationHeaders,
  },
  vite: {
    plugins: [tailwindcss(), shadowCatcherPatch(), pathTracerPerfPatch(), ptStandInPatch()],
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    optimizeDeps: {
      // These packages create workers via `new URL(..., import.meta.url)` –
      // pre-bundling would break the relative worker paths.
      exclude: ['three-mesh-bvh', 'three-gpu-pathtracer'],
    },
  },
});
