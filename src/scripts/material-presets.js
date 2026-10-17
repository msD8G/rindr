// Material library (pool): physical presets.
// Parameters correspond to MeshPhysicalMaterial and are fully evaluated by the path tracer.
// Colors as hex (sRGB). Display names come from the language file (materials.presets.<libraryId>),
// category labels from materials.categories.<category>.
import { t } from './i18n.js';

export const PRESET_CATEGORIES = ['metal', 'plastic', 'paint', 'glass', 'subsurface', 'marble', 'style', 'special', 'other'];

/** Display name of a preset (also the default name of a material created from it) */
export const presetName = libraryId => t(`materials.presets.${libraryId}`);
/** Display label of a preset category */
export const presetCategoryLabel = category => t(`materials.categories.${category}`);

export const MATERIAL_PRESETS = [
    // --- metal ---
    { libraryId: 'metal-chrome', category: 'metal', params: { color: '#f2f4f6', metalness: 1, roughness: 0.04 } },
    { libraryId: 'metal-alu-polished', category: 'metal', params: { color: '#e6e8ea', metalness: 1, roughness: 0.12 } },
    { libraryId: 'metal-alu-brushed', category: 'metal', params: { color: '#d4d7da', metalness: 1, roughness: 0.38 } },
    { libraryId: 'metal-alu-anodized-black', category: 'metal', params: { color: '#2a2b2e', metalness: 1, roughness: 0.32 } },
    { libraryId: 'metal-steel', category: 'metal', params: { color: '#c6c8c9', metalness: 1, roughness: 0.22 } },
    { libraryId: 'metal-steel-dark', category: 'metal', params: { color: '#6f7174', metalness: 1, roughness: 0.42 } },
    { libraryId: 'metal-cast-iron', category: 'metal', params: { color: '#4a4b4d', metalness: 0.9, roughness: 0.75 } },
    { libraryId: 'metal-gold', category: 'metal', params: { color: '#ffcf73', metalness: 1, roughness: 0.15 } },
    { libraryId: 'metal-copper', category: 'metal', params: { color: '#f2a477', metalness: 1, roughness: 0.2 } },
    { libraryId: 'metal-brass', category: 'metal', params: { color: '#e3c27a', metalness: 1, roughness: 0.25 } },
    { libraryId: 'metal-titanium', category: 'metal', params: { color: '#bdb6ab', metalness: 1, roughness: 0.3 } },

    // --- plastic ---
    { libraryId: 'plastic-white-gloss', category: 'plastic', params: { color: '#f2f2f0', metalness: 0, roughness: 0.15 } },
    { libraryId: 'plastic-black-gloss', category: 'plastic', params: { color: '#111214', metalness: 0, roughness: 0.12 } },
    { libraryId: 'plastic-black-matte', category: 'plastic', params: { color: '#1a1b1d', metalness: 0, roughness: 0.65 } },
    { libraryId: 'plastic-grey-matte', category: 'plastic', params: { color: '#7d8083', metalness: 0, roughness: 0.6 } },
    { libraryId: 'plastic-red', category: 'plastic', params: { color: '#c4161c', metalness: 0, roughness: 0.3 } },
    { libraryId: 'plastic-blue', category: 'plastic', params: { color: '#1f5fbf', metalness: 0, roughness: 0.3 } },
    { libraryId: 'plastic-yellow', category: 'plastic', params: { color: '#f2c200', metalness: 0, roughness: 0.3 } },
    { libraryId: 'rubber-black', category: 'plastic', params: { color: '#141414', metalness: 0, roughness: 0.9, sheen: 0.3, sheenRoughness: 0.8, sheenColor: '#3a3a3a' } },

    // --- paint ---
    { libraryId: 'paint-car-red', category: 'paint', params: { color: '#9c0b12', metalness: 0.2, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03 } },
    { libraryId: 'paint-car-blue-metallic', category: 'paint', params: { color: '#173a7a', metalness: 0.6, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03 } },
    { libraryId: 'paint-car-silver', category: 'paint', params: { color: '#a9adb1', metalness: 0.7, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.04 } },
    { libraryId: 'paint-powder-black', category: 'paint', params: { color: '#1b1c1e', metalness: 0, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 } },
    { libraryId: 'paint-powder-white', category: 'paint', params: { color: '#ecebe6', metalness: 0, roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.4 } },

    // --- glass ---
    { libraryId: 'glass-clear', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0, transmission: 1, ior: 1.5, thickness: 2 } },
    { libraryId: 'glass-frosted', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0.35, transmission: 1, ior: 1.5, thickness: 2 } },
    { libraryId: 'glass-tinted', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0, transmission: 1, ior: 1.5, thickness: 4, attenuationColor: '#5a6b5e', attenuationDistance: 8 } },
    { libraryId: 'plastic-clear', category: 'glass', params: { color: '#ffffff', metalness: 0, roughness: 0.05, transmission: 1, ior: 1.49, thickness: 2 } },

    // --- subsurface scattering (random walk in the path tracer; radius in mm) ---
    { libraryId: 'sss-jelly', category: 'subsurface', params: { color: '#ffffff', metalness: 0, roughness: 0.06, ior: 1.35, thickness: 1, subsurface: 1, subsurfaceColor: '#e8203a', subsurfaceRadius: 8 } },
    // slime: wet gloss (clearcoat), very translucent, a faint own glow
    { libraryId: 'sss-slime', category: 'subsurface', params: { color: '#ffffff', metalness: 0, roughness: 0.02, ior: 1.33, thickness: 1, clearcoat: 1, clearcoatRoughness: 0.01, subsurface: 1, subsurfaceColor: '#3fd60a', subsurfaceRadius: 20, emissive: '#2a9a00', emissiveIntensity: 0.3 } },
    { libraryId: 'sss-wax', category: 'subsurface', params: { color: '#f4ead6', metalness: 0, roughness: 0.4, ior: 1.45, thickness: 1, subsurface: 1, subsurfaceColor: '#f1dfbf', subsurfaceRadius: 1.5 } },

    // --- glowing marble: dark polished stone, light veins inside (marble.js; scale in mm) ---
    { libraryId: 'marble-glow-green', category: 'marble', params: { color: '#060807', metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.02, marble: 1, marbleColor: '#33ff73', marbleScale: 10 } },
    { libraryId: 'marble-glow-blue', category: 'marble', params: { color: '#05060a', metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.02, marble: 1, marbleColor: '#4080ff', marbleScale: 10 } },
    { libraryId: 'marble-glow-amber', category: 'marble', params: { color: '#0a0604', metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.02, marble: 1, marbleColor: '#ff8c26', marbleScale: 10 } },

    // --- style: toon shading (raster) + contour lines (all view modes); matte in the path tracer ---
    { libraryId: 'toon-orange', category: 'style', params: { color: '#ff7a1a', metalness: 0, roughness: 1, specularIntensity: 0, toon: 1, contour: 1, contourColor: '#000000', contourWidth: 2 } },
    // outline: plain surface + contour, no light steps (user's choice)
    { libraryId: 'outline-white', category: 'style', params: { color: '#ffffff', metalness: 0, roughness: 1, specularIntensity: 0, flat: 1, contour: 1, contourColor: '#000000', contourWidth: 2 } },
    { libraryId: 'outline-black', category: 'style', params: { color: '#141414', metalness: 0, roughness: 1, specularIntensity: 0, flat: 1, contour: 1, contourColor: '#ffffff', contourWidth: 2 } },

    // --- other ---
    // special: the object as a fluffy cloud (clouds.js – volume, puffs out over the shape)
    { libraryId: 'cloud-white', category: 'special', params: { color: '#ffffff', metalness: 0, roughness: 1, cloud: 1, cloudColor: '#ffffff', cloudPuff: 0.05 } },

    { libraryId: 'ceramic-white', category: 'other', params: { color: '#f4f3ef', metalness: 0, roughness: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.08 } },
    { libraryId: 'emissive-white', category: 'other', params: { color: '#ffffff', metalness: 0, roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 5 } },
    { libraryId: 'emissive-neon-green', category: 'other', params: { color: '#39ff14', metalness: 0, roughness: 0.5, emissive: '#39ff14', emissiveIntensity: 5 } },
];
