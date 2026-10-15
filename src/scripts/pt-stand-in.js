// Path tracer stand-in of a material (astro.config.mjs, rindr-pt-stand-in: three-gpu-pathtracer packs its material
// data from this). userData.ptStandIn (RindrMaterial in toon.js: subsurface look, glowing marble) overrides fields
// over the material itself (prototype) – maps, flags and everything else stay the material's own.
// `ptVolume` lands in the struct's unused fogVolume field: 2 = glowing marble (megakernel, marble.js).
export function ptStandIn(material) {
    const pt = material?.userData?.ptStandIn;
    return pt ? Object.assign(Object.create(material), pt) : material;
}
