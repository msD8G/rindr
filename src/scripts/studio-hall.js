// Built-in studio environment: a wide, low hall with rows of light strips on the ceiling, square pillars and
// a bright floor (modelled after the look of the user's studio022.hdr – own procedural rebuild, no image data).
// Rendered by ray casting from the eye; the walls, floor and ceiling are shaded with a small radiosity estimate
// (direct light of the strip field + one bounce off the floor), so they fall off naturally towards the walls.
// No three.js here: fills a plain array in three.js' equirect layout (u = atan2(z, x)/2π + 0.5, row 0 = bottom).
// Units: ceiling 1 above the eye.

const EYE = 0.316;                              // eye height above the floor
const ROOM = { x0: -11.5, x1: 11.5, z0: -10.3, z1: 2.5 };
// light strips: running along z, side by side in x; grouped in rows along z (start, end)
const STRIP = { pitch: 0.68, offset: 0.14, width: 0.3, x0: -10.5, x1: 10.5, radiance: 3.95 };
const STRIP_ROWS = [[-8.4, -6.34], [-5.72, -3.99], [-3.58, -2.1], [-1.58, -0.3], [0.11, 1.63]];
const PILLAR = { size: 0.05, x: [2.73, 3.43], z: [1.3, -0.1, -1.5, -2.9, -4.3, -5.7, -7.1, -8.5] };
// target radiances (calibration of the albedos): floor below the eye, ceiling between the strips, wall behind
const TARGET = { floor: 0.55, ceiling: 0.42, wall: 0.335 };
const WALL_ALBEDO = { z1: 1, z0: 0.6, x1: 0.75, x0: 1.9 };   // relative: dark far end, one bright side
const TINT = [1.01, 1, 1.03];                   // slightly cool, as fluorescent light
const GRID = 0.5;                               // spacing of the shading grids

// cross section of a strip (t = 0 centre … 1 edge) and the falloff along it (s = 0 … 1 over its length)
const across = t => { const q = Math.max(0, 1 - t * t); return q * q; };
const along = s => { const d = Math.min(s, 1 - s) / 0.35; return d >= 1 ? 1 : 0.66 + 0.34 * (1 - (1 - d) * (1 - d)); };

/** cumulative integral of f over [0, len] in n steps → (x) => ∫₀ˣ f */
function integral(f, len, n = 512) {
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + f((i + 0.5) / n * len) * len / n;
    return x => {
        const p = Math.min(Math.max(x / len, 0), 1) * n, i = Math.min(Math.floor(p), n - 1);
        return c[i] + (c[i + 1] - c[i]) * (p - i);
    };
}

// strip pattern across x: periodic, clipped to the strip field (edges in the gaps)
const acrossInt = integral(x => {
    const t = Math.abs(x - STRIP.pitch / 2) / (STRIP.width / 2);
    return t < 1 ? across(t) : 0;
}, STRIP.pitch);
const ACROSS_PERIOD = acrossInt(STRIP.pitch);
const fieldX0 = Math.floor((STRIP.x0 - STRIP.offset) / STRIP.pitch) * STRIP.pitch + STRIP.offset + STRIP.pitch / 2;
const fieldX1 = Math.ceil((STRIP.x1 - STRIP.offset) / STRIP.pitch) * STRIP.pitch + STRIP.offset - STRIP.pitch / 2;
function acrossCum(x) {   // ∫ from fieldX0 to x
    const u = Math.min(Math.max(x, fieldX0), fieldX1) - fieldX0, k = Math.floor(u / STRIP.pitch);
    return k * ACROSS_PERIOD + acrossInt(u - k * STRIP.pitch);
}
const alongInt = integral(along, 1);
// ∫ from −∞ to z over all strip rows – tabulated (piecewise smooth, so linear interpolation is exact enough)
const ALONG_N = 8192, ALONG_STEP = (ROOM.z1 - ROOM.z0) / ALONG_N, alongTable = new Float64Array(ALONG_N + 1);
for (let i = 0; i <= ALONG_N; i++) {
    const z = ROOM.z0 + i * ALONG_STEP;
    let sum = 0;
    for (const [a, b] of STRIP_ROWS) if (z > a) sum += (b - a) * alongInt(Math.min((z - a) / (b - a), 1));
    alongTable[i] = sum;
}
function alongCum(z) {
    const p = Math.min(Math.max((z - ROOM.z0) / ALONG_STEP, 0), ALONG_N), i = Math.min(Math.floor(p), ALONG_N - 1);
    return alongTable[i] + (alongTable[i + 1] - alongTable[i]) * (p - i);
}
/** strip radiance averaged over the box [x ± wx/2] × [z ± wz/2] (pre-filtered: no moiré towards the horizon) */
function stripRadiance(x, z, wx, wz) {
    wx = Math.max(wx, 1e-4); wz = Math.max(wz, 1e-4);
    const ax = (acrossCum(x + wx / 2) - acrossCum(x - wx / 2)) / wx;
    if (ax <= 0) return 0;
    return STRIP.radiance * ax * (alongCum(z + wz / 2) - alongCum(z - wz / 2)) / wz;
}

// --- shading: radiosity estimate on coarse grids ---

/** emitter patches { p, n, la (radiance × area) } */
function stripPatches() {
    const out = [], dz = 0.25;
    for (let x = fieldX0; x < fieldX1 - 1e-6; x += STRIP.pitch)
        for (let z = ROOM.z0; z < ROOM.z1; z += dz) {
            const l = stripRadiance(x + STRIP.pitch / 2, z + dz / 2, STRIP.pitch, dz);
            if (l > 0) out.push({ p: [x + STRIP.pitch / 2, 1, z + dz / 2], n: [0, -1, 0], la: l * STRIP.pitch * dz });
        }
    return out;
}

/** irradiance at p with normal n from patches (point-to-patch, cosines on both sides) */
function irradiance(p, n, patches) {
    let e = 0;
    for (const q of patches) {
        const vx = q.p[0] - p[0], vy = q.p[1] - p[1], vz = q.p[2] - p[2];
        const cr = n[0] * vx + n[1] * vy + n[2] * vz, ce = -(q.n[0] * vx + q.n[1] * vy + q.n[2] * vz);
        if (cr <= 0 || ce <= 0) continue;
        const d2 = vx * vx + vy * vy + vz * vz + 1e-3;
        e += q.la * cr * ce / (d2 * d2);
    }
    return e;
}

/** values on a grid over [a0, a1] × [b0, b1]; f(a, b) → value; returns bilinear lookup (a, b) → value */
function grid(a0, a1, b0, b1, na, nb, f) {
    const v = new Float32Array(na * nb);
    for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) v[j * na + i] = f(a0 + (a1 - a0) * i / (na - 1), b0 + (b1 - b0) * j / (nb - 1));
    return (a, b) => {
        const fa = Math.min(Math.max((a - a0) / (a1 - a0), 0), 1) * (na - 1), fb = Math.min(Math.max((b - b0) / (b1 - b0), 0), 1) * (nb - 1);
        const i = Math.min(Math.floor(fa), na - 2), j = Math.min(Math.floor(fb), nb - 2), u = fa - i, w = fb - j, k = j * na + i;
        return (v[k] * (1 - u) + v[k + 1] * u) * (1 - w) + (v[k + na] * (1 - u) + v[k + na + 1] * u) * w;
    };
}
const steps = (a, b) => Math.max(2, Math.round((b - a) / GRID) + 1);

function buildShading() {
    const lights = stripPatches();
    const { x0, x1, z0, z1 } = ROOM;
    // floor: direct light of the strips
    const floorE = grid(x0, x1, z0, z1, steps(x0, x1), steps(z0, z1), (x, z) => irradiance([x, -EYE, z], [0, 1, 0], lights));
    const kFloor = TARGET.floor / floorE(0, 0);
    const floor = (x, z) => kFloor * floorE(x, z);
    // bounce light: the lit floor as emitter
    const floorPatches = [];
    for (let x = x0 + GRID / 2; x < x1; x += GRID) for (let z = z0 + GRID / 2; z < z1; z += GRID)
        floorPatches.push({ p: [x, -EYE, z], n: [0, 1, 0], la: floor(x, z) * GRID * GRID });
    const both = lights.concat(floorPatches);
    const ceilE = grid(x0, x1, z0, z1, steps(x0, x1), steps(z0, z1), (x, z) => irradiance([x, 1, z], [0, -1, 0], floorPatches));
    const kCeil = TARGET.ceiling / ceilE(0, -3);
    const ceiling = (x, z) => kCeil * ceilE(x, z);
    // walls (u along the wall, height y): direct + floor bounce; one albedo for walls and pillars
    const ny = steps(-EYE, 1);
    const wall = (len0, len1, at) => grid(len0, len1, -EYE, 1, steps(len0, len1), ny, at);
    const e = 1e-3;
    const walls = {
        z1: wall(x0, x1, (u, y) => irradiance([u, y, z1 - e], [0, 0, -1], both)),
        z0: wall(x0, x1, (u, y) => irradiance([u, y, z0 + e], [0, 0, 1], both)),
        x1: wall(z0, z1, (u, y) => irradiance([x1 - e, y, u], [-1, 0, 0], both)),
        x0: wall(z0, z1, (u, y) => irradiance([x0 + e, y, u], [1, 0, 0], both)),
    };
    const kWall = TARGET.wall / walls.z1(0, 0);
    // pillars: per pillar and face a column of values over the height (centre of the face)
    const h = PILLAR.size / 2, faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const pillars = [];
    for (const x of PILLAR.x) for (const sx of [-1, 1]) for (const z of PILLAR.z) {
        const c = [sx * x, z];
        const shade = faces.map(([fx, fz]) => grid(0, 1, -EYE, 1, 2, ny, (_, y) =>
            kWall * irradiance([c[0] + fx * (h + e), y, c[1] + fz * (h + e)], [fx, 0, fz], both)));
        pillars.push({ x0: c[0] - h, x1: c[0] + h, z0: c[1] - h, z1: c[1] + h, shade });
    }
    return { floor, ceiling, walls: (key, u, y) => kWall * WALL_ALBEDO[key] * walls[key](u, y), pillars };
}

/**
 * Render the hall into `data` (RGBA, width × height, row 0 = bottom), converting each value with `conv`
 * (e.g. to half float).
 */
export function renderStudioHall(width, height, data = new Float32Array(width * height * 4), conv = v => v) {
    const S = buildShading();
    const { x0, x1, z0, z1 } = ROOM;
    const one = conv(1);
    // a vertical ray (azimuth a): horizontal distance r to the first wall or pillar, its shading over the height
    // and an id of the surface hit – walls and pillars are vertical, so this does not depend on the elevation
    const trace = a => {
        const ca = Math.cos(a), sa = Math.sin(a);
        const rx = ca > 0 ? x1 / ca : ca < 0 ? x0 / ca : Infinity, rz = sa > 0 ? z1 / sa : sa < 0 ? z0 / sa : Infinity;
        let r = Math.min(rx, rz), shade, id;
        if (rx < rz) { const key = ca > 0 ? 'x1' : 'x0', u = sa * r; shade = y => S.walls(key, u, y); id = key; }
        else { const key = sa > 0 ? 'z1' : 'z0', u = ca * r; shade = y => S.walls(key, u, y); id = key; }
        S.pillars.forEach((p, i) => {   // 2D slab test
            const ax0 = p.x0 / ca, ax1 = p.x1 / ca, az0 = p.z0 / sa, az1 = p.z1 / sa;
            const nx = Math.min(ax0, ax1), nz = Math.min(az0, az1), tn = Math.max(nx, nz);
            if (tn > 0 && tn < r && tn < Math.min(Math.max(ax0, ax1), Math.max(az0, az1))) {
                r = tn;
                const f = nx > nz ? (ca > 0 ? 1 : 0) : (sa > 0 ? 3 : 2), face = p.shade[f];   // faces +x, −x, +z, −z (normal opposes the ray)
                shade = y => face(0, y); id = i * 4 + f;
            }
        });
        return { ca, sa, r, shade, id };
    };
    // a horizontal ring of rays (elevation el): distances at which it reaches the ceiling or the floor
    const ring = el => {
        const ce = Math.cos(el), dy = Math.sin(el), slope = dy / ce;
        return { ce, dy, slope, rc: dy > 0 ? 1 / slope : Infinity, rf: dy < 0 ? -EYE / slope : Infinity };
    };
    /** radiance of the ray of column ray c and ring e, footprint scale k (1 = whole pixel) */
    const delta = Math.PI / height;   // angular pixel size
    const radiance = (c, e, k) => {
        if (e.rc < c.r) {
            const px = c.ca * e.rc, pz = c.sa * e.rc, fa = Math.abs(c.ca), fb = Math.abs(c.sa);
            // pixel footprint on the ceiling: radial (grazing) and tangential
            const rad = k * delta / Math.max(e.dy * e.dy, 1e-6), tan = k * delta * e.ce / Math.max(e.dy, 1e-3);
            return S.ceiling(px, pz) + stripRadiance(px, pz, fa * rad + fb * tan, fb * rad + fa * tan);
        }
        if (e.rf < c.r) return S.floor(c.ca * e.rf, c.sa * e.rf);
        return c.shade(e.slope * c.r);
    };
    // surface class: 0 ceiling, 1 floor, 2 wall/pillar
    const surface = (e, r) => e.rc < r ? 0 : e.rf < r ? 1 : 2;
    // anti-aliasing: pixels on an edge (another wall/pillar/face within the pixel, or the border of ceiling/floor)
    // are supersampled N × N; everything else is smooth (strips are pre-filtered) and takes one ray
    const N = 4;
    const centre = [], subs = [], edgeCol = new Uint8Array(width), rMin = new Float64Array(width), rMax = new Float64Array(width);
    for (let col = 0; col < width; col++) {
        const angle = x => ((col + x) / width - 0.5) * 2 * Math.PI;
        centre.push(trace(angle(0.5)));
        const sub = [];
        for (let k = 0; k < N; k++) sub.push(trace(angle((k + 0.5) / N)));
        subs.push(sub);
        edgeCol[col] = sub.some(c => c.id !== sub[0].id) ? 1 : 0;
        rMin[col] = Math.min(...sub.map(c => c.r)); rMax[col] = Math.max(...sub.map(c => c.r));
    }
    const elev = y => (y / height - 0.5) * Math.PI;
    for (let row = 0; row < height; row++) {
        const e = ring(elev(row + 0.5)), e0 = ring(elev(row)), e1 = ring(elev(row + 1));
        let sub = null;
        for (let col = 0; col < width; col++) {
            let v;
            const s = surface(e0, rMin[col]);
            if (!edgeCol[col] && s === surface(e1, rMin[col]) && s === surface(e0, rMax[col]) && s === surface(e1, rMax[col]))
                v = radiance(centre[col], e, 1);
            else {
                sub ??= Array.from({ length: N }, (_, j) => ring(elev(row + (j + 0.5) / N)));
                v = 0;
                for (const ej of sub) for (const c of subs[col]) v += radiance(c, ej, 1 / N);
                v /= N * N;
            }
            const o = (row * width + col) * 4;
            data[o] = conv(v * TINT[0]); data[o + 1] = conv(v * TINT[1]); data[o + 2] = conv(v * TINT[2]); data[o + 3] = one;
        }
    }
    return data;
}
