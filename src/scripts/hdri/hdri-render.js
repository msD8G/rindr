// Generator of the HDRI editor (docs/hdri-editor.md): description (hdri-model.js) → linear RGBA Float32 in three.js'
// equirect layout (u = atan2(z, x)/2π + 0.5 left → right, v = asin(y)/π + 0.5, row 0 = bottom like hdr-worker.js).
// No DOM/three – runs in the worker (hdri-worker.js) and in Node tests.
//
// Order: background (colour / gradient over the elevation / sun & sky), then the pins in list order
// ('add' adds light, 'normal' covers). Pins live in local angular coordinates around their centre (undistorted on
// the sphere, stretched towards the poles on the equirect canvas – like KeyShot).
import { hexToLinear, direction } from './hdri-model.js';

const DEG = Math.PI / 180;
const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

/**
 * @param {object} doc description (hdri-model.js)
 * @param {number} width equirect width (height = width / 2)
 * @returns {Float32Array} RGBA linear, row 0 = bottom
 */
export function renderHdri(doc, width) {
    const height = width >> 1;
    const out = new Float32Array(width * height * 4);
    // per column: azimuth (texel centre); per row: elevation
    const cosA = new Float32Array(width), sinA = new Float32Array(width);
    for (let x = 0; x < width; x++) { const a = ((x + 0.5) / width - 0.5) * 2 * Math.PI; cosA[x] = Math.cos(a); sinA[x] = Math.sin(a); }
    const cosE = new Float32Array(height), sinE = new Float32Array(height);
    for (let y = 0; y < height; y++) { const e = ((y + 0.5) / height - 0.5) * Math.PI; cosE[y] = Math.cos(e); sinE[y] = Math.sin(e); }

    renderBackground(doc.background, doc.sky, out, width, height, cosA, sinA, cosE, sinE);
    const pixelAngle = Math.PI / height;
    for (const pin of doc.pins || []) {
        if (pin.enabled === false) continue;
        renderPin(pin, out, width, height, cosA, sinA, cosE, sinE, pixelAngle);
    }
    for (let i = 3; i < out.length; i += 4) out[i] = 1;
    return out;
}

// --- background ---

function renderBackground(bg, sky, out, width, height, cosA, sinA, cosE, sinE) {
    const k = bg.brightness ?? 1;
    if (bg.mode === 'sky') { renderSky(sky, out, width, height, cosA, sinA, cosE, sinE); return; }
    if (bg.mode === 'gradient' && bg.gradient?.length) {
        const stops = [...bg.gradient].sort((a, b) => a.pos - b.pos).map(s => ({ pos: s.pos, c: hexToLinear(s.color) }));
        for (let y = 0; y < height; y++) {
            const el = Math.asin(sinE[y]) / DEG;
            const c = sampleStops(stops, el);
            for (let x = 0, i = y * width * 4; x < width; x++, i += 4) { out[i] = c[0] * k; out[i + 1] = c[1] * k; out[i + 2] = c[2] * k; }
        }
        return;
    }
    const c = hexToLinear(bg.color || '#000000');
    for (let i = 0; i < out.length; i += 4) { out[i] = c[0] * k; out[i + 1] = c[1] * k; out[i + 2] = c[2] * k; }
}

// stops: sorted [{ pos, c: [r, g, b] }] – linear interpolation in linear RGB, constant beyond the ends
function sampleStops(stops, pos, target = [0, 0, 0]) {
    if (pos <= stops[0].pos) { target[0] = stops[0].c[0]; target[1] = stops[0].c[1]; target[2] = stops[0].c[2]; return target; }
    for (let i = 1; i < stops.length; i++) {
        if (pos <= stops[i].pos) {
            const a = stops[i - 1], b = stops[i], t = (pos - a.pos) / Math.max(b.pos - a.pos, 1e-9);
            for (let c = 0; c < 3; c++) target[c] = a.c[c] + (b.c[c] - a.c[c]) * t;
            return target;
        }
    }
    const l = stops[stops.length - 1];
    target[0] = l.c[0]; target[1] = l.c[1]; target[2] = l.c[2];
    return target;
}

// --- sun & sky: atmosphere of three.js' Sky (Preetham / Hoffman), linear, + own sun disc and ground ---

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734, STEEPNESS = 1.5, EE = 1000;
const MIE_G = 0.8, MIE_COEFF = 0.005, RAYLEIGH = 1;

function skyModel(sunDir, turbidity) {
    const sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(Math.min(Math.max(sunDir[1], -1), 1))) / STEEPNESS)));
    const betaR = TOTAL_RAYLEIGH.map(v => v * RAYLEIGH);
    const mie = 0.434 * (0.2 * turbidity * 10e-18);
    const betaM = MIE_CONST.map(v => v * mie * MIE_COEFF);
    const horizonMix = Math.min(Math.max((1 - sunDir[1]) ** 5, 0), 1);
    const fex = (dy, target) => {
        const za = Math.acos(Math.max(0, dy));
        const inv = 1 / (Math.cos(za) + 0.15 * Math.pow(93.885 - za / DEG, -1.253));
        for (let c = 0; c < 3; c++) target[c] = Math.exp(-(betaR[c] * 8.4e3 * inv + betaM[c] * 1.25e3 * inv));
        return target;
    };
    const F = [0, 0, 0];
    // radiance (before normalisation) towards a direction
    const radiance = (dx, dy, dz, target) => {
        fex(dy, F);
        const cosT = dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2];
        const rc = cosT * 0.5 + 0.5;
        const rPhase = 0.05968310365946075 * (1 + rc * rc);
        const g2 = MIE_G * MIE_G;
        const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * MIE_G * cosT + g2, 1.5));
        for (let c = 0; c < 3; c++) {
            const ratio = (betaR[c] * rPhase + betaM[c] * mPhase) / (betaR[c] + betaM[c]);
            let lin = Math.pow(sunE * ratio * (1 - F[c]), 1.5);
            lin *= 1 + (Math.pow(sunE * ratio * F[c], 0.5) - 1) * horizonMix;
            target[c] = (lin + 0.1 * F[c]) * 0.04 + (c === 1 ? 0.0003 : c === 2 ? 0.00075 : 0);
        }
        return target;
    };
    return { radiance, sunE, fex };
}

// average luminance of the upper hemisphere (cos-weighted) – normalisation of the sky brightness
function hemisphereLuminance(model) {
    let sum = 0, wsum = 0;
    const c = [0, 0, 0];
    for (let j = 0; j < 24; j++) {
        const e = (j + 0.5) / 24 * Math.PI / 2, ce = Math.cos(e), se = Math.sin(e);
        for (let i = 0; i < 48; i++) {
            const a = (i + 0.5) / 48 * 2 * Math.PI;
            model.radiance(ce * Math.cos(a), se, ce * Math.sin(a), c);
            const w = se * ce;   // cos-weighted, solid angle ∝ cos(elevation)
            sum += (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * w;
            wsum += w;
        }
    }
    return sum / wsum;
}
let referenceLuminance = 0;   // noon, turbidity 2
const SKY_LEVEL = 0.8;        // hemisphere average at skyIntensity 1 (≈ studio brightness)
const SUN_IRRADIANCE = 3 * Math.PI * SKY_LEVEL;   // sun ≈ 3 × sky irradiance at sunIntensity 1

function renderSky(sky, out, width, height, cosA, sinA, cosE, sinE) {
    const sunDir = direction(sky.azimuth ?? 0, sky.elevation ?? 30);
    const model = skyModel(sunDir, Math.max(sky.turbidity ?? 3, 1));
    if (!referenceLuminance) referenceLuminance = hemisphereLuminance(skyModel(direction(0, 60), 2));
    const scale = (sky.skyIntensity ?? 1) * SKY_LEVEL / referenceLuminance;
    // ground below the horizon: diffuse surface (colour = albedo) lit by sky and sun – E / π · albedo
    const sunUp = Math.max(sunDir[1], 0) * (model.sunE / EE) * Math.max(sky.sunIntensity ?? 1, 0);
    const irradiance = Math.PI * SKY_LEVEL * (sky.skyIntensity ?? 1) + SUN_IRRADIANCE * sunUp;
    const ground = hexToLinear(sky.groundColor || '#5a5650').map(v => v * (sky.groundIntensity ?? 1) * irradiance / Math.PI);
    // the sky is smooth: evaluated on a coarse grid (¼), interpolated bilinearly
    const gw = Math.max(8, width >> 2), gh = Math.max(4, height >> 2);
    const grid = new Float32Array((gw + 1) * (gh + 1) * 3), c = [0, 0, 0];
    for (let j = 0; j <= gh; j++) {
        const e = (j / gh - 0.5) * Math.PI, ce = Math.cos(e), se = Math.sin(e);
        for (let i = 0; i <= gw; i++) {
            const a = (i / gw - 0.5) * 2 * Math.PI;
            model.radiance(ce * Math.cos(a), Math.max(se, 0), ce * Math.sin(a), c);
            const o = (j * (gw + 1) + i) * 3;
            grid[o] = c[0] * scale; grid[o + 1] = c[1] * scale; grid[o + 2] = c[2] * scale;
        }
    }
    for (let y = 0; y < height; y++) {
        const fy = (y + 0.5) / height * gh, j0 = Math.min(Math.floor(fy), gh - 1), ty = fy - j0;
        // ground below the horizon, soft over ~1.5°
        const g = smoothstep(-0.026, 0.004, sinE[y]);
        for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
            const fx = (x + 0.5) / width * gw, i0 = Math.min(Math.floor(fx), gw - 1), tx = fx - i0;
            const o00 = (j0 * (gw + 1) + i0) * 3, o01 = o00 + 3, o10 = o00 + (gw + 1) * 3, o11 = o10 + 3;
            for (let k = 0; k < 3; k++) {
                const s = (grid[o00 + k] * (1 - tx) + grid[o01 + k] * tx) * (1 - ty) + (grid[o10 + k] * (1 - tx) + grid[o11 + k] * tx) * ty;
                out[i + k] = ground[k] + (s - ground[k]) * g;
            }
        }
    }
    // sun disc: radius sunSize/2 (at least ~1.5 texels, so it never falls between the texels); radiance chosen so
    // the irradiance stays the same for every size (larger = softer shadows, equally bright)
    if (sunDir[1] < -0.05 || !(sky.sunIntensity > 0)) return;
    const pixel = Math.PI / height;
    const r = Math.max((sky.sunSize ?? 2) / 2 * DEG, 1.5 * pixel);
    const solid = 2 * Math.PI * (1 - Math.cos(r));
    const col = model.fex(Math.max(sunDir[1], 0), [0, 0, 0]);
    const lum = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
    const L = sky.sunIntensity * SUN_IRRADIANCE / solid * (model.sunE / EE) / Math.max(lum, 1e-4);
    const cosR = Math.cos(r * 1.02);
    forCap((sky.azimuth ?? 0) * DEG, (sky.elevation ?? 30) * DEG, r * 1.05 + pixel, width, height, (x, y, i) => {
        const d = cosE[y] * cosA[x] * sunDir[0] + sinE[y] * sunDir[1] + cosE[y] * sinA[x] * sunDir[2];
        if (d < cosR) return;
        const ang = Math.acos(Math.min(d, 1));
        const m = 1 - smoothstep(r - Math.max(pixel, r * 0.1), r, ang);
        if (m <= 0) return;
        out[i] += col[0] * L * m; out[i + 1] += col[1] * L * m; out[i + 2] += col[2] * L * m;
    });
}

// --- pins ---

function renderPin(pin, out, width, height, cosA, sinA, cosE, sinE, pixelAngle) {
    const n = direction(pin.azimuth, pin.elevation);
    const a = pin.azimuth * DEG, e = pin.elevation * DEG;
    const east = [-Math.sin(a), 0, Math.cos(a)];
    const north = [-Math.sin(e) * Math.cos(a), Math.cos(e), -Math.sin(e) * Math.sin(a)];
    const r = (pin.rotation || 0) * DEG, cr = Math.cos(r), sr = Math.sin(r);
    const ex = [0, 1, 2].map(k => cr * east[k] + sr * north[k]);
    const ey = [0, 1, 2].map(k => -sr * east[k] + cr * north[k]);
    const hw = Math.max(pin.width, 0.05) / 2 * DEG, hh = Math.max(pin.height, 0.05) / 2 * DEG, hmin = Math.min(hw, hh);
    const circle = pin.shape === 'circle';
    const reach = (circle ? Math.max(hw, hh) : Math.hypot(hw, hh)) + 2 * pixelAngle;
    if (reach >= Math.PI) return;
    const cosReach = Math.cos(Math.min(reach, Math.PI / 2 - 1e-3));
    const soft = Math.max(pin.falloff || 0, 0);
    const aa = pixelAngle;
    const rc = circle ? 0 : Math.min(Math.max(pin.cornerRadius || 0, 0), 1) * hmin;
    const k = pin.brightness ?? 1;
    const normal = pin.blend === 'normal';
    const color = hexToLinear(pin.color || '#ffffff');
    const fillMode = pin.fill || 'color';
    const stops = fillMode === 'gradient'
        ? [...(pin.gradient?.stops || [])].sort((p, q) => p.pos - q.pos).map(s => ({ pos: s.pos, c: hexToLinear(s.color) }))
        : null;
    const radial = pin.gradient?.type === 'radial';
    if (fillMode === 'gradient' && !stops?.length) return;
    const c = [0, 0, 0];
    forCap(pin.azimuth * DEG, pin.elevation * DEG, reach, width, height, (x, y, i) => {
        const ce = cosE[y];
        const px = ce * cosA[x], py = sinE[y], pz = ce * sinA[x];
        const d = px * n[0] + py * n[1] + pz * n[2];
        if (d < cosReach) return;
        const u = px * ex[0] + py * ex[1] + pz * ex[2], w = px * ey[0] + py * ey[1] + pz * ey[2];
        const lx = Math.atan2(u, d), ly = Math.atan2(w, d);
        let mask, rn;
        {
            if (circle) {
                // true angular distance to the centre (exact circles), ellipse radius along this direction
                const ang = Math.acos(Math.min(d, 1)), l = Math.hypot(u, w) || 1;
                rn = ang * Math.hypot(u / l / hw, w / l / hh);
                const f = Math.max(soft, aa / hmin);
                mask = 1 - smoothstep(1 - f, 1, rn);
            } else {
                const qx = Math.abs(lx) - hw + rc, qy = Math.abs(ly) - hh + rc;
                const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc;
                const f = Math.max(soft * hmin, aa);
                mask = 1 - smoothstep(-f, 0, sd);
                rn = Math.hypot(lx / hw, ly / hh);
            }
        }
        if (mask <= 0) return;
        if (stops) {
            sampleStops(stops, radial ? Math.min(rn, 1) : Math.min(Math.max((lx / hw + 1) / 2, 0), 1), c);
        } else {
            c[0] = color[0]; c[1] = color[1]; c[2] = color[2];
        }
        if (normal) {
            for (let ch = 0; ch < 3; ch++) out[i + ch] += (c[ch] * k - out[i + ch]) * mask;
        } else {
            for (let ch = 0; ch < 3; ch++) out[i + ch] += c[ch] * k * mask;
        }
    });
}

// Visit the texels of a spherical cap (centre azimuth/elevation, angular radius) – rows of its elevation range,
// columns of its azimuth range (wrapping around; all columns if the cap reaches a pole). fn(x, y, index)
function forCap(az, el, reach, width, height, fn) {
    const e0 = el - reach, e1 = el + reach;
    const y0 = Math.max(0, Math.floor((e0 / Math.PI + 0.5) * height) - 1), y1 = Math.min(height - 1, Math.ceil((e1 / Math.PI + 0.5) * height) + 1);
    let x0 = 0, x1 = width - 1;
    if (e1 < Math.PI / 2 && e0 > -Math.PI / 2) {
        const s = Math.sin(reach) / Math.cos(Math.max(Math.abs(e0), Math.abs(e1)));
        if (s < 1) {
            const dA = Math.asin(s), c = (az / (2 * Math.PI) + 0.5) * width, half = dA / (2 * Math.PI) * width;
            x0 = Math.floor(c - half) - 1;
            x1 = Math.ceil(c + half) + 1;
        }
    }
    if (x1 - x0 >= width) { x0 = 0; x1 = width - 1; }
    for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let k = x0; k <= x1; k++) {
            const x = ((k % width) + width) % width;
            fn(x, y, (row + x) * 4);
        }
    }
}
