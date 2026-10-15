// Path tracer stand-in of a subsurface material (astro.config.mjs, rindr-subsurface: three-gpu-pathtracer packs
// its material data from this). userData.subsurfacePT (RindrMaterial.setSubsurface, toon.js) overrides fields
// over the material itself (prototype) – maps, flags and everything else stay the material's own.
export function subsurfaceStandIn(material) {
    const pt = material?.userData?.subsurfacePT;
    return pt ? Object.assign(Object.create(material), pt) : material;
}
