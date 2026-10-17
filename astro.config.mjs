// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Patches three-gpu-pathtracer's megakernel (fails loudly if the library changed – check on every update):
// - shadow catcher (src/scripts/shadow-catcher.js): matte branch → src/scripts/shadow-catcher.patch.wgsl, incl. ground
//   reflection / puddles (src/scripts/ground-reflection.js: GROUND_SURFACE_WGSL)
// - background dome (src/scripts/background-dome.js): every background/environment lookup of a ray goes
//   through domeDirection(ray.origin, ray.direction) – camera rays, reflections and refractions
const SHADOW_CATCHER_MODULE = fileURLToPath(new URL('./src/scripts/shadow-catcher.js', import.meta.url));
const DOME_MODULE = fileURLToPath(new URL('./src/scripts/background-dome.js', import.meta.url));
const GROUND_MODULE = fileURLToPath(new URL('./src/scripts/ground-reflection.js', import.meta.url));
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
      // ground reflection, model only (shadow-catcher.patch.wgsl): the reflection ray's next segment decides –
      // a miss ends the path (the ground was already counted), a hit takes the counted ground back
      const mirrorVars = /\n(\t+)for \( var bounce = 0u; bounce < maxBounces; bounce \+\+ \) \{/;
      const mirrorCheck = /let surfaceDist = select\( \$\{ LIGHT_FAR_DISTANCE \}, hitResult\.dist, didHit \);\n/;
      for (const re of [mirrorVars, mirrorCheck]) if ((code.match(new RegExp(re.source, 'g')) || []).length !== 1) this.error(`rindr-shadow-catcher: ${re} not found exactly once in PathTracerMegaKernel.js`);
      code = code.replace(mirrorVars, m => '\n\t\t\t\tvar scMirrorBg = vec3f( 0.0 );\n\t\t\t\tvar scMirrorPending = false;' + m);
      code = code.replace(mirrorCheck, m => m + `
					if ( scMirrorPending ) {

						scMirrorPending = false;
						if ( ! didHit ) {

							break;

						}
						resultColor -= vec4f( scMirrorBg, 0.0 );

					}
`);
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
          `import { DOME_DIRECTION as __DOME } from ${JSON.stringify(DOME_MODULE)};\n` +
          `import { GROUND_SURFACE_WGSL as __GROUND } from ${JSON.stringify(GROUND_MODULE)};\n` + code,
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
const MARBLE_MODULE = fileURLToPath(new URL('./src/scripts/materials/marble-pt.js', import.meta.url));
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

// Glass while orbiting (src/scripts/pt-motion.js): refractions up to PT_MOTION.glassBounces do not use up the bounce
// budget of the megakernel – with the 3 bounces of the motion mode glass was black (fails loudly if the library
// changed, check on every update).
const PT_MOTION_MODULE = fileURLToPath(new URL('./src/scripts/pt-motion.js', import.meta.url));
function glassBouncesPatch() {
  return {
    name: 'rindr-glass-bounces',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const loop = /\n(\t+)for \( var bounce = 0u; bounce < maxBounces; bounce \+\+ \) \{/;
      const next = /\n(\t+)ray\.origin = \$\{ offsetRayOriginFunc \}\( vertexData\.position\.xyz, scatterRec\.direction, hitResult\.normal \);/;
      for (const re of [loop, next]) if ((code.match(new RegExp(re.source, 'g')) || []).length !== 1) this.error(`rindr-glass-bounces: ${re} not found exactly once in PathTracerMegaKernel.js`);
      // the budget raises the loop's limit (instead of `bounce --`: a mirror reflection then restarted at bounce 0 and
      // the environment it hit was drawn as the directly seen background – chrome turned black)
      code = code.replace(loop, (m, tab) => `\n${tab}var glassBounce = 0u;\n${tab}for ( var bounce = 0u; bounce < maxBounces + glassBounce; bounce ++ ) {`);
      // end of the iteration (after Russian roulette): a refraction or a smooth mirror reflection (chrome: mirror in
      // mirror) within the budget does not count
      code = code.replace(next, (m, tab) => `\n${tab}if ( ( scatterRec.isTransmissive || ( surface.metalness > 0.9 && surface.roughness < 0.1 ) ) && glassBounce < \${ __PT_MOTION.glassBounces } ) {\n\n${tab}\tglassBounce ++;\n\n${tab}}\n` + m);
      return { code: `import { PT_MOTION as __PT_MOTION } from ${JSON.stringify(PT_MOTION_MODULE)};\n` + code, map: null };
    },
  };
}

// Glass shadows (src/scripts/glass-shadow.js): shadow rays through glass (next event estimation + shadow catcher), the
// colour fringe, and no caustic paths while that is on (fails loudly if the library changed – check on every update).
const GLASS_SHADOW_MODULE = fileURLToPath(new URL('./src/scripts/glass-shadow.js', import.meta.url));
const GLASS_SHADOW_PATCH = fileURLToPath(new URL('./src/scripts/glass-shadow.patch.wgsl', import.meta.url));
function glassShadowPatch() {
  return {
    name: 'rindr-glass-shadow',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      const snippet = ({ origin, dir, maxDist, normal, primary }) => readFileSync(GLASS_SHADOW_PATCH, 'utf8')
        .replace(/\$ORIGIN/g, origin).replace(/\$DIR/g, dir).replace(/\$MAXDIST/g, maxDist)
        .replace(/\$NORMAL/g, normal).replace(/\$PRIMARY/g, primary);
      const replaceOnce = (from, to) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-glass-shadow: ${from} not found exactly once in PathTracerMegaKernel.js (three-gpu-pathtracer changed?)`);
        code = code.replace(from, to);
      };
      // markers of other patches: shadow catcher (shadow-catcher.patch.wgsl, rindr-shadow-catcher) and the cloud
      // volumes' light samples (cloud-pt.js, rindr-cloud) – both inserted before this plugin
      const markers = /\n\t*\/\/@glass-shadow ([^\n]+)/g;
      if ((code.match(markers) || []).length !== 2) this.error('rindr-glass-shadow: expected 2 //@glass-shadow markers in PathTracerMegaKernel.js');
      code = code.replace(markers, (_, args) => {
        const [origin, dir, maxDist, normal, primary] = args.split('|').map(a => a.trim());
        return '\n' + snippet({ origin, dir, maxDist, normal, primary });
      });
      // next event estimation: transmitted light instead of a plain occlusion test; through glass the full weight
      // (the bsdf-sampled counterpart is a caustic path, not counted, see below)
      replaceOnce(/\n\t+var shadowHit: \$\{ raycastOutput \};\n\t+let occluded = \$\{ raycastFirstHitFn \}\( shadowRay, &shadowHit \);\n(\t+)if \( ! occluded \) \{/,
        (_, tab) => '\n' + snippet({ origin: 'vertexData.position.xyz', dir: 'lightRec.direction', maxDist: 'shadowRay.maxDist', normal: 'hitResult.normal', primary: 'bounce == 0u' })
          + `${tab}if ( any( gsShadow > vec3f( 0.0 ) ) ) {`);
      replaceOnce('${ isMISWeightLightFn }( lightRec.lightType ) );', () => '${ isMISWeightLightFn }( lightRec.lightType ) && ! gsGlass );');
      replaceOnce('let directLight = throughputColor * lightRec.emission * evalRec.color * misWeight / lightPdf;',
        () => 'let directLight = throughputColor * lightRec.emission * evalRec.color * misWeight * gsShadow / lightPdf;');
      // caustic paths: a refraction after a rough bounce (low pdf, not transmissive) – their light/environment hit is
      // dropped while glass shadows are transparent
      replaceOnce(/\n(\t+)var transparentBounce = 0u;/, (m, tab) => `${m}\n${tab}var gsRough = false;\n${tab}var gsCaustic = false;`);
      replaceOnce(/\n(\t+)minPdf = min\( minPdf, scatterRec\.pdf \);/, (m, tab) => `${m}\n\n${tab}if ( ! scatterRec.isTransmissive && scatterRec.pdf < 4.0 ) {\n\n${tab}\tgsRough = true;\n${tab}\tgsCaustic = false;\n\n${tab}} else if ( scatterRec.isTransmissive && gsRough ) {\n\n${tab}\tgsCaustic = true;\n\n${tab}}`);
      const drop = '( gsCaustic && ${ __GS.mode } == 1u )';
      replaceOnce('let contribution = ${ clampPathContributionFunc }( environment, bounce, clampDirect, clampIndirect );',
        () => `let contribution = select( \${ clampPathContributionFunc }( environment, bounce, clampDirect, clampIndirect ), vec3f( 0.0 ), ${drop} );`);
      replaceOnce('let lightHit = ${ clampPathContributionFunc }( lightRec.emission * throughputColor * misWeight, bounce, clampDirect, clampIndirect );',
        () => `let lightHit = select( \${ clampPathContributionFunc }( lightRec.emission * throughputColor * misWeight, bounce, clampDirect, clampIndirect ), vec3f( 0.0 ), ${drop} );`);
      return { code: `import { GLASS_SHADOW as __GS } from ${JSON.stringify(GLASS_SHADOW_MODULE)};\n` + code, map: null };
    },
  };
}

// Cloud volumes (src/scripts/clouds.js, cloud-pt.js – fails loudly if the library changed, check on every update):
// - megakernel: a hit on a cloud proxy (ptVolume 3) walks through the volume (CLOUD_WALK_WGSL), right after the
//   material is read; its light samples carry a //@glass-shadow marker (rindr-glass-shadow runs after this plugin)
// - BVHComputeData: meshes with a cloud material are left out like invisible ones – the proxy stands in for them
const CLOUD_PT_MODULE = fileURLToPath(new URL('./src/scripts/materials/cloud-pt.js', import.meta.url));
const CLOUD_WALK_PATCH = fileURLToPath(new URL('./src/scripts/materials/cloud-walk.patch.wgsl', import.meta.url));
function cloudPatch() {
  return {
    name: 'rindr-cloud',
    enforce: 'pre',
    transform(code, id) {
      const file = id.replace(/\\/g, '/').split('?')[0];
      const replaceOnce = (from, to, name) => {
        const n = typeof from === 'string' ? code.split(from).length - 1 : (code.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) this.error(`rindr-cloud: ${from} not found exactly once in ${name} (three-gpu-pathtracer / three-mesh-bvh changed?)`);
        code = code.replace(from, to);
      };
      if (file.endsWith('three-mesh-bvh/src/webgpu/BVHComputeData.js')) {
        replaceOnce('let visible = isObjectVisible( object );', () => 'let visible = isObjectVisible( object ) && ! object.material?.userData?.cloud;', 'BVHComputeData.js');
        return { code, map: null };
      }
      if (!file.endsWith('three-gpu-pathtracer/src/webgpu/compute/PathTracerMegaKernel.js')) return null;
      replaceOnce(/\n\t+materialInfo\.opacity \*= objectInfo\.color\.a;\n/, m => m + readFileSync(CLOUD_WALK_PATCH, 'utf8'), 'PathTracerMegaKernel.js');
      return { code: `import { CLOUD_PT as __CLOUD } from ${JSON.stringify(CLOUD_PT_MODULE)};\n` + code, map: null };
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

// App version ("About"): major.minor from package.json (raised by hand), patch = number of git commits – counts up
// with every commit, the same commit always gives the same version, nothing is written back. "-dev": built with
// uncommitted changes. Without git (source archive): package.json as it is. CI needs the full history
// (fetch-depth: 0 in .github/workflows/static.yml – a shallow clone counts 1).
function appVersion() {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const git = args => execSync(`git ${args}`, { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const commits = git('rev-list --count HEAD');
    const dirty = git('status --porcelain') !== '';
    return `${version.split('.').slice(0, 2).join('.')}.${commits}${dirty ? '-dev' : ''}`;
  } catch {
    return version;
  }
}

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
    plugins: [tailwindcss(), shadowCatcherPatch(), pathTracerPerfPatch(), ptStandInPatch(), glassBouncesPatch(), cloudPatch(), glassShadowPatch()],
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    optimizeDeps: {
      // These packages create workers via `new URL(..., import.meta.url)` –
      // pre-bundling would break the relative worker paths.
      exclude: ['three-mesh-bvh', 'three-gpu-pathtracer'],
    },
  },
});
