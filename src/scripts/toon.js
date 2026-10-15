// Cel shading for the library materials (material-manager.js): every material is a RindrMaterial – a
// MeshPhysicalNodeMaterial (the path tracer reads its physical parameters as before). With `toon` the lit colour
// is snapped to three flat tones of the base colour (shadow / mid / light) – whatever the lights and the
// environment do, at most three colours (the user's cel look; three.js' toon lighting model alone left smooth
// environment shading). `flat` = one colour, unlit (outline materials: surface + contour) – carried as emission on
// a black base, so the path tracer shows it flat as well. Toon is raster only – toon presets are matte in the path
// tracer; outline and important edges come from contour.js in every view mode.
// Subsurface scattering (`subsurface`, setSubsurface) – fast approximation as the user chose (Barré-Brisebois,
// GDC 2011, "Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look"):
//   raster: light wrapping past the terminator, light from behind shining through (light direction bent by the
//     normal, power, scale – the translucency term of three.js' MeshSSSNodeMaterial; no thickness map, constant)
//     and a little environment light bleeding through, all tinted with the scatter colour
//   path tracer: stand-in fields (subsurface-pt.js) – a translucent share as rough (diffuse-like) transmission,
//     the gloss as clearcoat and the scatter colour absorbed over the distance travelled inside: the exact
//     thickness of the method, thin parts glow, thick ones stay dense. A real random walk (Oct. 2026) took 2–5× the
//     render time of plastic and came out too dark – dropped.
import * as THREE from 'three/webgpu';
import { diffuseColor, materialEmissive, luminance, select, float, vec4, uniform, normalView, positionViewDirection } from 'three/tsl';

// brightness of the lit colour relative to the base colour → tone (thresholds, tones as share of the base colour)
const TOON_STEPS = { shadow: 0.55, mid: 1.1 };
const TOON_TONES = { shadow: 0.45, mid: 0.75, light: 1.0 };

// raster approximation of subsurface scattering (see above); strength × scatter colour from the material uniforms
const SSS_WRAP = 0.6;            // light reaches this far past the terminator (N·L down to −0.6)
const SSS_DISTORTION = 0.3;      // translucency: light direction bent towards the normal
const SSS_POWER = 3;             // … focus of the light seen through the object
const SSS_SCALE = 1.5;
const SSS_AMBIENT = 0.25;        // share of the environment light bleeding through

class SubsurfaceLightingModel extends THREE.PhysicalLightingModel {
    constructor(material, ...flags) {
        super(...flags);
        this.sssColor = material._sssColor.mul(material._sssWeight);
    }

    direct({ lightDirection, lightColor, reflectedLight }, builder) {
        const nl = normalView.dot(lightDirection);
        const wrap = nl.add(SSS_WRAP).div(1 + SSS_WRAP).saturate().sub(nl.saturate());
        const half = lightDirection.add(normalView.mul(SSS_DISTORTION)).normalize();
        const through = positionViewDirection.dot(half.negate()).saturate().pow(SSS_POWER).mul(SSS_SCALE);
        reflectedLight.directDiffuse.addAssign(this.sssColor.mul(lightColor).mul(wrap.add(through)).mul(1 / Math.PI));
        super.direct({ lightDirection, lightColor, reflectedLight }, builder);
    }

    indirectDiffuse(builder) {
        super.indirectDiffuse(builder);
        const { irradiance, reflectedLight } = builder.context;
        reflectedLight.indirectDiffuse.addAssign(irradiance.mul(this.sssColor).mul(SSS_AMBIENT / Math.PI));
    }
}

// path tracer stand-in: share of the subsurface weight that passes into the object, roughness of that
// transmission (diffuse-like)
const PT_TRANSLUCENT = 0.6;
const PT_ROUGHNESS = 0.85;

export class RindrMaterial extends THREE.MeshPhysicalNodeMaterial {
    constructor(params) {
        super(params);
        this.toon = false;   // part of the material cache key (RenderObject.getMaterialCacheKey)
        this.flat = false;   // plain colour, no lighting (outline materials: surface + contour); colour = emissive
        this.subsurface = false;   // cache key; strength/colour as uniforms (`_` = not in the key – no rebuild on edits)
        this._sssColor = uniform(new THREE.Color(1, 1, 1));
        this._sssWeight = uniform(0);
    }

    /**
     * Subsurface scattering: weight 0..1 (strength), colour (sRGB hex, the colour of the scattered light),
     * radius = scene units (mm for CAD models) after which light inside keeps that colour (thin parts glow, thick
     * ones stay dense). Mixes `color` towards the scatter colour and sets the path tracer stand-in – call after
     * colour, roughness and clearcoat are set.
     */
    setSubsurface(weight, color, radius) {
        this.subsurface = weight > 0;
        this._sssWeight.value = weight;
        this._sssColor.value.set(color);
        if (!this.subsurface) { delete this.userData.subsurfacePT; return; }
        const sss = this._sssColor.value;
        this.color.lerp(sss, weight);   // the visible colour of the scattering (raster and path tracer)
        const gloss = this.roughness < PT_ROUGHNESS;
        this.userData.subsurfacePT = {
            transmission: Math.max(this.transmission, weight * PT_TRANSLUCENT),
            roughness: Math.max(this.roughness, PT_ROUGHNESS),
            // the material's own gloss as a clear layer over the rough translucent body
            clearcoat: gloss ? Math.max(this.clearcoat, 1) : this.clearcoat,
            clearcoatRoughness: gloss ? this.roughness : this.clearcoatRoughness,
            thickness: Math.max(this.thickness, 1),   // volume, not a thin wall
            attenuationColor: { r: sss.r, g: sss.g, b: sss.b },
            attenuationDistance: Math.max(radius, 1e-3),
        };
    }

    setupLightingModel(builder) {
        if (!this.subsurface) return super.setupLightingModel(builder);
        return new SubsurfaceLightingModel(this, this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy,
            this.useTransmission, this.useDispersion, this.useRetroreflection);
    }

    setupOutput(builder, outputNode) {
        if (this.flat) {
            outputNode = vec4(materialEmissive.rgb, outputNode.a);   // material-manager.js: colour → emission
        } else if (this.toon) {
            const base = diffuseColor.rgb;
            const ratio = luminance(outputNode.rgb).div(luminance(base).max(1e-4));
            const tone = select(ratio.lessThan(TOON_STEPS.shadow), float(TOON_TONES.shadow),
                select(ratio.lessThan(TOON_STEPS.mid), float(TOON_TONES.mid), float(TOON_TONES.light)));
            outputNode = vec4(base.mul(tone), outputNode.a);
        }
        return super.setupOutput(builder, outputNode);
    }

    copy(source) {
        super.copy(source);
        this.toon = source.toon;
        this.flat = source.flat;
        this.subsurface = source.subsurface;
        this._sssWeight.value = source._sssWeight.value;
        this._sssColor.value.copy(source._sssColor.value);
        return this;
    }
}
