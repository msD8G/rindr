// Description of a custom, procedurally generated HDRI (HDRI editor, docs/hdri-editor.md). Plain JSON – stored in
// the scene state, rendered by hdri-render.js (worker). No DOM/three here (also used in the worker).

export const HDRI_VERSION = 1;
export const RESOLUTIONS = [1024, 2048, 4096];   // width; height = width / 2

let seq = 0;
const newId = prefix => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const PIN_TYPES = ['circle', 'rect', 'gradient'];

/** New pin of a type (circle, rect, gradient = rectangle with a gradient fill) – no image pins (user's choice) */
export function createPin(type, overrides = {}) {
    const pin = {
        id: newId('p'), name: '', enabled: true,
        shape: type === 'circle' ? 'circle' : 'rect',
        fill: type === 'gradient' ? 'gradient' : 'color',
        azimuth: 0, elevation: 30, width: type === 'circle' ? 30 : 40, height: type === 'circle' ? 30 : 25,
        rotation: 0, cornerRadius: type === 'rect' ? 0.3 : 0, falloff: type === 'circle' ? 0.25 : 0.1,
        color: '#ffffff', brightness: 4, blend: 'add',
        gradient: { type: 'linear', stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#000000' }] },
        ...overrides,
    };
    return pin;
}

// Softboxes of the former built-in studio (environment.js until Oct. 2026, now the hall of studio-hall.js) –
// directions there were in the coordinates of
// ProceduralEquirectTexture's callback, which are swapped (x ↔ z) relative to three.js' equirect mapping
const STUDIO_BOXES = [
    { name: 'Key', dir: [0.5, 0.8, 0.6], radius: 0.35, intensity: 9, color: [1.0, 0.97, 0.92] },
    { name: 'Fill', dir: [-0.8, 0.35, 0.3], radius: 0.45, intensity: 3, color: [0.9, 0.95, 1.0] },
    { name: 'Rim', dir: [-0.2, 0.5, -0.9], radius: 0.3, intensity: 6, color: [1.0, 1.0, 1.0] },
    { name: 'Top', dir: [0, 1, 0], radius: 0.6, intensity: 2, color: [1.0, 1.0, 1.0] },
];

const toHex = c => '#' + c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');

/** Template "Studio": rebuild of the former built-in procedural studio (gradient + 4 softboxes) */
export function studioPreset(name = 'Studio') {
    const pins = STUDIO_BOXES.map(b => {
        const [sx, sy, sz] = b.dir, len = Math.hypot(sx, sy, sz);
        const x = sz / len, y = sy / len, z = sx / len;   // swap into three.js' equirect frame
        const deg = 2 * b.radius * 180 / Math.PI;
        return createPin('circle', {
            name: b.name, azimuth: Math.atan2(z, x) * 180 / Math.PI, elevation: Math.asin(y) * 180 / Math.PI,
            width: deg, height: deg, falloff: 0.25, color: toHex(b.color), brightness: b.intensity,
        });
    });
    return {
        version: HDRI_VERSION, id: newId('h'), name,
        resolution: 2048,
        background: {
            mode: 'gradient', color: '#292929', brightness: 1,
            // the studio's base: 0.04 + 0.12·(1 + y) below, 0.16 + 0.22·y above (y = sin of the elevation)
            gradient: [-90, -60, -30, 0, 30, 60, 90].map(el => {
                const y = Math.sin(el * Math.PI / 180);
                const v = y < 0 ? 0.04 + 0.12 * (1 + y) : 0.16 + 0.22 * y;
                return { pos: el, color: toHex([v, v, v].map(linearToSrgb)) };
            }),
        },
        sky: {
            azimuth: 30, elevation: 35, sunSize: 2, sunIntensity: 1, skyIntensity: 1, turbidity: 3,
            groundColor: '#5a5650', groundIntensity: 1,
        },
        pins,
    };
}

/** Empty description (dark grey background, no pins) */
export function emptyPreset(name) {
    const d = studioPreset(name);
    d.background.mode = 'color';
    d.pins = [];
    return d;
}

/** Deep copy with fresh ids (duplicate) */
export function cloneHdri(doc, { keepIds = false } = {}) {
    const c = JSON.parse(JSON.stringify(doc));
    if (!keepIds) {
        c.id = newId('h');
        for (const p of c.pins) p.id = newId('p');
    }
    return c;
}

/** Fill in missing fields of a loaded description (older/foreign scene files) */
export function normalizeHdri(doc) {
    const base = studioPreset(doc?.name || 'HDRI');
    const d = { ...base, ...doc, background: { ...base.background, ...doc?.background }, sky: { ...base.sky, ...doc?.sky } };
    d.pins = (Array.isArray(doc?.pins) ? doc.pins : base.pins).map(p => {
        const def = createPin(p.fill === 'gradient' ? 'gradient' : p.shape === 'circle' ? 'circle' : 'rect');
        const pin = { ...def, ...p, gradient: { ...def.gradient, ...p.gradient } };
        // image pins existed briefly (Oct. 2026) – now a plain colour pin
        if (pin.fill !== 'color' && pin.fill !== 'gradient') pin.fill = 'color';
        delete pin.image;
        delete pin.adjust;
        return pin;
    });
    d.version = HDRI_VERSION;
    if (!RESOLUTIONS.includes(d.resolution)) d.resolution = 2048;
    return d;
}

export function linearToSrgb(v) {
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
export function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
/** '#rrggbb' → linear RGB */
export function hexToLinear(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => srgbToLinear(v / 255));
}

/** unit direction from azimuth/elevation in degrees (three.js equirect frame) */
export function direction(azimuth, elevation) {
    const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
    return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}
