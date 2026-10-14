// Open-source projects and assets RINDR is built on – single source for the "About" page (about.js) and the
// "Built with" section of README.md (scripts/sync-readme.mjs, runs before every build). Purpose texts:
// about.libs.<id> in the language files. Pure data: also imported by Node.
// runtime: shipped to the browser (npm packages and libraries bundled by three.js / in public/)
export const RUNTIME = [
    { id: 'three', name: 'three.js', license: 'MIT', url: 'https://threejs.org' },
    { id: 'pathtracer', name: 'three-gpu-pathtracer', license: 'MIT', url: 'https://github.com/gkjohnson/three-gpu-pathtracer' },
    { id: 'bvh', name: 'three-mesh-bvh', license: 'MIT', url: 'https://github.com/gkjohnson/three-mesh-bvh' },
    { id: 'oidn', name: 'Intel Open Image Denoise', license: 'Apache-2.0', url: 'https://github.com/RenderKit/oidn' },
    { id: 'oidnWeb', name: 'oidn-web', license: 'MIT', url: 'https://github.com/pissang/oidn-web' },
    { id: 'upscaler', name: '@pmndrs/upscaler', license: 'MIT', url: 'https://github.com/pmndrs/upscaler' },
    { id: 'earcut', name: 'earcut', license: 'ISC', url: 'https://github.com/mapbox/earcut' },
    { id: 'cdt2d', name: 'cdt2d', license: 'MIT', url: 'https://github.com/mikolalysenko/cdt2d' },
    { id: 'polygonClipping', name: 'polygon-clipping', license: 'MIT', url: 'https://github.com/mfogel/polygon-clipping' },
    { id: 'robustPredicates', name: 'robust-predicates', license: 'Unlicense', url: 'https://github.com/mourner/robust-predicates' },
    { id: 'robustGeometry', name: 'robust-orientation, robust-in-sphere, binary-search-bounds', license: 'MIT', url: 'https://github.com/mikolalysenko' },
    { id: 'splaytree', name: 'splaytree', license: 'MIT', url: 'https://github.com/w8r/splay-tree' },
    { id: 'float16', name: '@petamoriken/float16', license: 'MIT', url: 'https://github.com/petamoriken/float16' },
    { id: 'draco', name: 'Draco', license: 'Apache-2.0', url: 'https://github.com/google/draco' },
    { id: 'basis', name: 'Basis Universal', license: 'Apache-2.0', url: 'https://github.com/BinomialLLC/basis_universal' },
    { id: 'ktxParse', name: 'ktx-parse, zstddec', license: 'MIT', url: 'https://github.com/donmccurdy/KTX-Parse' },
    { id: 'meshopt', name: 'meshoptimizer', license: 'MIT', url: 'https://github.com/zeux/meshoptimizer' },
    { id: 'fflate', name: 'fflate', license: 'MIT', url: 'https://github.com/101arrowz/fflate' },
    { id: 'webIfc', name: 'web-ifc', license: 'MPL-2.0', url: 'https://github.com/ThatOpen/engine_web-ifc' },
];
// assets: HDRI environment maps (public/hdr)
export const ASSETS = [
    { id: 'openHdri', name: 'Open HDRI', license: 'CC0', url: 'https://openhdri.org/' },
];
// build tools
export const BUILD = [
    { id: 'astro', name: 'Astro', license: 'MIT', url: 'https://astro.build' },
    { id: 'vite', name: 'Vite', license: 'MIT', url: 'https://vite.dev' },
    { id: 'tailwind', name: 'Tailwind CSS', license: 'MIT', url: 'https://tailwindcss.com' },
];
