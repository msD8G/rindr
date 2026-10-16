// Evaluation of MAX modifier stacks that a .max file stores only as parameters (max-parse.js): the base object
// (spline or mesh) plus each modifier's settings – MAX computes the result when it loads the scene, the file holds
// no mesh of it. Own implementations of what the modifiers do, close to MAX but not bit-identical:
//   - shapes (Line / Editable Spline: Bézier knots) → polylines
//   - Extrude: polylines along the shape's local Z, caps for closed outlines (holes by nesting)
//   - Shell: offset surface + reverse side + rim walls along open edges (sheet metal from a surface)
// Meshes here: { P: Float32Array (xyz), tri: Uint32Array (vertex indices), N: Float32Array (normal per corner) }.
// Pure functions – worker and Node.
import earcut from 'earcut';

// --- shapes ---

/**
 * Splines of a Bézier shape (chunk 0x2000 of Line / Editable Spline objects): [{ closed, knots: [{ type, line, p, in, out }] }]
 * Spline: 0x2900 knot count, 0x290a knots, 0x290d closed. Knot record (52 bytes): knot type (0 auto, 1 corner,
 * 2 Bézier, 3 Bézier corner), line type (0 curve, 1 line), float, point, in handle, out handle, int.
 * Text shapes: see readText.
 */
export function readShape(sc, c, text = null) {
    if (text) return readText(sc, c, text);
    const shape = sc.child(c, 0x2000);
    return shape ? readSplines(sc, sc.child(shape, 0x1010)) : null;
}

function readSplines(sc, list) {
    if (!list) return null;
    const dv = sc.dv;
    const splines = [];
    for (const sp of sc.children(list)) {
        if (sp.id !== 0x1010 || !sp.container) continue;
        const count = sc.child(sp, 0x2900), closed = sc.child(sp, 0x290d), data = sc.child(sp, 0x290a);
        if (!count || !data) continue;
        const n = sc.u32(count);
        if (!n || sc.size(data) !== n * 52) return null;   // other layout: not understood
        const knots = [];
        for (let i = 0, o = data.start; i < n; i++, o += 52) {
            const v = k => [dv.getFloat32(o + k, true), dv.getFloat32(o + k + 4, true), dv.getFloat32(o + k + 8, true)];
            knots.push({ type: dv.getInt32(o, true), line: dv.getInt32(o + 4, true), p: v(12), in: v(24), out: v(36) });
        }
        splines.push({ closed: !!(closed && sc.u32(closed)), knots });
    }
    return splines.length ? splines : null;
}

/**
 * Text shape: the glyph outlines are stored with the object (0x1030 per glyph: 0x1000 glyph id, 0x1010 advance,
 * 0x1020 Bézier splines in units of 1/1000 of the size), 0x1035 the text as glyph ids (u32 count, per character
 * u32 id + 1 byte). Placed on the baseline one after the other (advance + kerning), aligned by the outlines'
 * extent: 0 left, 1 centre, 2 right (centre checked against MAX' modifier box: ±0,1 units).
 */
function readText(sc, c, { size = 100, kerning = 0, align = 1 }) {
    const dv = sc.dv;
    const glyphs = new Map();
    for (const g of sc.children(c)) {
        if (g.id !== 0x1030) continue;
        const id = sc.child(g, 0x1000), adv = sc.child(g, 0x1010), shape = sc.child(g, 0x1020);
        if (id && adv) glyphs.set(sc.u32(id), { advance: sc.f32(adv), splines: readSplines(sc, shape) || [] });
    }
    const layout = sc.child(c, 0x1035);
    if (!layout || !glyphs.size) return null;
    const n = sc.u32(layout), k = size / 1000;
    const out = [];
    let pen = 0;
    for (let i = 0, o = layout.start + 4; i < n && o + 4 <= layout.end; i++, o += 5) {
        const g = glyphs.get(dv.getUint32(o, true));
        if (!g) continue;
        const move = q => [(q[0] + pen) * k, q[1] * k, q[2] * k];
        for (const sp of g.splines) out.push({ closed: sp.closed, knots: sp.knots.map(kn => ({ ...kn, p: move(kn.p), in: move(kn.in), out: move(kn.out) })) });
        pen += g.advance + kerning / k;
    }
    if (!out.length) return null;
    let min = Infinity, max = -Infinity;
    for (const sp of out) for (const kn of sp.knots) for (const q of [kn.p, kn.in, kn.out]) { min = Math.min(min, q[0]); max = Math.max(max, q[0]); }
    const shift = align === 0 ? -min : align === 2 ? -max : -(min + max) / 2;
    for (const sp of out) for (const kn of sp.knots) for (const q of [kn.p, kn.in, kn.out]) q[0] += shift;
    return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Points along a spline: [{ p, smooth }] – curved segments in `steps` pieces, straight ones (line type or handles on the chord) as one */
export function sampleSpline({ closed, knots }, steps = 6) {
    const n = knots.length;
    const out = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
        const a = knots[i], b = knots[(i + 1) % n];
        const P0 = a.p, P1 = a.out, P2 = b.in, P3 = b.p;
        out.push({ p: P0, smooth: a.type === 0 || a.type === 2 });
        const chord = sub(P3, P0), cl = len(chord);
        const off = q => len(cross(sub(q, P0), chord)) / (cl || 1);   // distance of a handle from the chord
        if (a.line === 1 || cl === 0 || (off(P1) < cl * 1e-4 && off(P2) < cl * 1e-4)) continue;
        for (let k = 1; k < steps; k++) {
            const t = k / steps, u = 1 - t;
            const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
            out.push({ p: [0, 1, 2].map(j => w[0] * P0[j] + w[1] * P1[j] + w[2] * P2[j] + w[3] * P3[j]), smooth: true });
        }
    }
    if (!closed) out.push({ p: knots[n - 1].p, smooth: false });
    // no doubled points (zero-length pieces)
    const pts = out.filter((q, i) => i === 0 || len(sub(q.p, out[i - 1].p)) > 1e-9);
    if (closed && pts.length > 1 && len(sub(pts[0].p, pts[pts.length - 1].p)) <= 1e-9) pts.pop();
    return pts;
}

// --- mesh builder ---

class MeshBuilder {
    constructor() { this.P = []; this.tri = []; this.N = []; }
    vertex(p) { this.P.push(p[0], p[1], p[2]); return this.P.length / 3 - 1; }
    triangle(a, b, c, na, nb, nc) { this.tri.push(a, b, c); this.N.push(...na, ...nb, ...nc); }
    done() { return { P: new Float32Array(this.P), tri: new Uint32Array(this.tri), N: new Float32Array(this.N) }; }
}

// --- Extrude ---

const signedArea = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i].p, q = pts[(i + 1) % pts.length].p; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const inside = (pt, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i].p, b = poly[j].p;
        if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
};

/**
 * Extrude splines along local Z by `amount` in `segments` pieces; closed outlines get caps (start/end), nested
 * outlines become holes. Side normals: smooth at smooth knots and inside curves, split at corner knots.
 */
export function extrude(splines, { amount = 0, segments = 1, capStart = true, capEnd = true, steps = 6 }) {
    const mb = new MeshBuilder();
    const segs = Math.max(1, segments | 0);
    const outlines = splines.map(s => ({ closed: s.closed, pts: sampleSpline(s, steps) })).filter(o => o.pts.length >= 2);
    // closed outlines: outer ones counter-clockwise, holes (inside an odd number of others) clockwise – normals outward
    for (const o of outlines) {
        if (!o.closed || o.pts.length < 3) continue;
        o.depth = outlines.filter(x => x !== o && x.closed && x.pts.length >= 3 && inside(o.pts[0].p, x.pts)).length;
        const ccw = signedArea(o.pts) > 0;
        if (ccw !== (o.depth % 2 === 0)) o.pts.reverse();
    }
    const dz = amount / segs, up = amount >= 0;
    for (const { closed, pts } of outlines) {
        const n = pts.length, edges = closed ? n : n - 1;
        // normal of each edge (in the plane): edge direction × Z
        const en = [];
        for (let i = 0; i < edges; i++) {
            const d = sub(pts[(i + 1) % n].p, pts[i].p);
            en.push(norm(up ? [d[1], -d[0], 0] : [-d[1], d[0], 0]));
        }
        const at = (i, e) => {   // normal at point i on edge e
            const prev = closed ? (i - 1 + edges) % edges : i - 1;
            const other = e === i ? prev : (i < edges ? i : -1);
            if (!pts[i].smooth || other < 0 || other >= edges) return en[e];
            return norm([en[e][0] + en[other][0], en[e][1] + en[other][1], 0]);
        };
        const grid = [];
        for (let l = 0; l <= segs; l++) grid.push(pts.map(q => mb.vertex([q.p[0], q.p[1], q.p[2] + dz * l])));
        for (let l = 0; l < segs; l++) for (let i = 0; i < edges; i++) {
            const j = (i + 1) % n;
            const a = grid[l][i], b = grid[l][j], c = grid[l + 1][j], d = grid[l + 1][i];
            const ni = at(i, i), nj = at(j, i);
            if (up) { mb.triangle(a, b, c, ni, nj, nj); mb.triangle(a, c, d, ni, nj, ni); }
            else { mb.triangle(a, c, b, ni, nj, nj); mb.triangle(a, d, c, ni, ni, nj); }
        }
    }
    // caps: each outer outline (even depth) with the holes directly inside it
    const closedOnes = outlines.filter(o => o.closed && o.pts.length >= 3);
    for (const outer of closedOnes) {
        if (outer.depth % 2) continue;
        const holes = closedOnes.filter(h => h.depth === outer.depth + 1 && inside(h.pts[0].p, outer.pts));
        const rings = [outer, ...holes];
        const flat = [], holeStarts = [];
        for (const r of rings) { if (r !== outer) holeStarts.push(flat.length / 2); for (const q of r.pts) flat.push(q.p[0], q.p[1]); }
        const idx = earcut(flat, holeStarts, 2);
        const pts = rings.flatMap(r => r.pts.map(q => q.p));
        for (const [cap, z, nz] of [[capStart, 0, up ? -1 : 1], [capEnd, amount, up ? 1 : -1]]) {
            if (!cap) continue;
            const vs = pts.map(p => mb.vertex([p[0], p[1], p[2] + z]));
            const nrm = [0, 0, nz];
            for (let t = 0; t < idx.length; t += 3) {
                let [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
                const fz = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]))[2];
                if ((fz > 0) !== (nz > 0)) [b, c] = [c, b];
                mb.triangle(vs[a], vs[b], vs[c], nrm, nrm, nrm);
            }
        }
    }
    return mb.done();
}

// --- Shell ---

/**
 * Give a surface thickness: the surface moved `outer` along its normals and `inner` against them (reverse side,
 * flipped), walls along open edges between the two. Offsets follow the averaged normals at each position (welded),
 * the surfaces keep their shading normals.
 */
export function shell(mesh, { inner = 0, outer = 0 }) {
    const { P, tri, N } = mesh;
    const nv = P.length / 3, nt = tri.length / 3;
    // weld positions (offsets must agree where faces meet)
    const key = new Map(), weld = new Uint32Array(nv);
    let nw = 0;
    for (let v = 0; v < nv; v++) {
        const k = `${Math.round(P[v * 3] * 1e5)},${Math.round(P[v * 3 + 1] * 1e5)},${Math.round(P[v * 3 + 2] * 1e5)}`;
        let w = key.get(k);
        if (w === undefined) key.set(k, w = nw++);
        weld[v] = w;
    }
    // offset direction per welded position: angle-weighted face normals
    const dir = new Float64Array(nw * 3);
    const fn = [];
    for (let t = 0; t < nt; t++) {
        const ids = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
        const p = ids.map(v => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
        const f = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
        fn.push(f);
        for (let k = 0; k < 3; k++) {
            const e1 = norm(sub(p[(k + 1) % 3], p[k])), e2 = norm(sub(p[(k + 2) % 3], p[k]));
            const ang = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2])));
            const w = weld[ids[k]];
            dir[w * 3] += f[0] * ang; dir[w * 3 + 1] += f[1] * ang; dir[w * 3 + 2] += f[2] * ang;
        }
    }
    const offset = (v, d) => {
        const w = weld[v];
        const n = norm([dir[w * 3], dir[w * 3 + 1], dir[w * 3 + 2]]);
        return [P[v * 3] + n[0] * d, P[v * 3 + 1] + n[1] * d, P[v * 3 + 2] + n[2] * d];
    };
    const mb = new MeshBuilder();
    const outerV = new Int32Array(nw).fill(-1), innerV = new Int32Array(nw).fill(-1);
    const vOuter = v => (outerV[weld[v]] >= 0 ? outerV[weld[v]] : (outerV[weld[v]] = mb.vertex(offset(v, outer))));
    const vInner = v => (innerV[weld[v]] >= 0 ? innerV[weld[v]] : (innerV[weld[v]] = mb.vertex(offset(v, -inner))));
    const cn = (t, k) => (N ? [N[(t * 3 + k) * 3], N[(t * 3 + k) * 3 + 1], N[(t * 3 + k) * 3 + 2]] : fn[t]);
    const neg = a => [-a[0], -a[1], -a[2]];
    // edges used once = open rim
    const edgeUse = new Map();
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
        const a = weld[tri[t * 3 + k]], b = weld[tri[t * 3 + (k + 1) % 3]];
        const e = a < b ? `${a},${b}` : `${b},${a}`;
        edgeUse.set(e, (edgeUse.get(e) || 0) + 1);
    }
    for (let t = 0; t < nt; t++) {
        const [a, b, c] = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
        mb.triangle(vOuter(a), vOuter(b), vOuter(c), cn(t, 0), cn(t, 1), cn(t, 2));
        mb.triangle(vInner(a), vInner(c), vInner(b), neg(cn(t, 0)), neg(cn(t, 2)), neg(cn(t, 1)));
    }
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
        const va = tri[t * 3 + k], vb = tri[t * 3 + (k + 1) % 3];
        const a = weld[va], b = weld[vb];
        if (edgeUse.get(a < b ? `${a},${b}` : `${b},${a}`) !== 1) continue;
        // wall between the outer edge a→b and the inner one, facing away from the face
        const oa = vOuter(va), ob = vOuter(vb), ia = vInner(va), ib = vInner(vb);
        const pOa = offset(va, outer), pOb = offset(vb, outer), pIa = offset(va, -inner);
        const wn = norm(cross(sub(pOa, pOb), sub(pIa, pOb)));
        mb.triangle(ob, oa, ia, wn, wn, wn);
        mb.triangle(ob, ia, ib, wn, wn, wn);
    }
    return mb.done();
}

// --- polygon meshes: { P: number[] (xyz), faces: [{ v: number[], sg, mat }] } ---
// Primitives are rebuilt from their parameters with MAX' vertex order where known (Sphere: top pole, rings from the
// top, bottom pole – Edit Poly records vertex moves by index), modifiers then work on the polygons (TurboSmooth needs
// quads, not triangles).

// make a closed, convex-ish body's faces point away from `centre`
function orientOutward(mesh, centre) {
    const { P } = mesh;
    for (const f of mesh.faces) {
        const v = f.v;
        let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < v.length; k++) {
            const a = v[k] * 3, b = v[(k + 1) % v.length] * 3;
            nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);   // Newell normal
            ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
            nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
            cx += P[a]; cy += P[a + 1]; cz += P[a + 2];
        }
        const n = v.length;
        if (nx * (cx / n - centre[0]) + ny * (cy / n - centre[1]) + nz * (cz / n - centre[2]) < 0) v.reverse();
    }
    return mesh;
}

function sphereMesh({ radius: r, segments, smooth }) {
    const n = Math.max(4, segments | 0), rings = Math.max(2, n >> 1);
    const P = [0, 0, r];
    for (let k = 1; k < rings; k++) {
        const phi = Math.PI * k / rings;
        for (let j = 0; j < n; j++) { const th = 2 * Math.PI * j / n; P.push(r * Math.sin(phi) * Math.cos(th), r * Math.sin(phi) * Math.sin(th), r * Math.cos(phi)); }
    }
    const bottom = P.push(0, 0, -r) / 3 - 1;
    const sg = smooth ? 1 : 0, faces = [];
    const ring = (k, j) => 1 + (k - 1) * n + ((j % n) + n) % n;
    for (let j = 0; j < n; j++) faces.push({ v: [0, ring(1, j), ring(1, j + 1)], sg });
    for (let k = 1; k < rings - 1; k++) for (let j = 0; j < n; j++) faces.push({ v: [ring(k, j), ring(k + 1, j), ring(k + 1, j + 1), ring(k, j + 1)], sg });
    for (let j = 0; j < n; j++) faces.push({ v: [ring(rings - 1, j), bottom, ring(rings - 1, j + 1)], sg });
    return orientOutward({ P, faces }, [0, 0, 0]);
}

function geosphereMesh({ radius: r, segments, type, smooth }) {
    const f = Math.max(1, segments | 0);
    let V, F;
    if (type === 0) {   // tetrahedron
        V = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
        F = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
    } else if (type === 1) {   // octahedron
        V = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
        F = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]];
    } else {   // icosahedron with a vertex at the top
        V = [[0, 0, 1]];
        for (let k = 0; k < 5; k++) { const a = 2 * Math.PI * k / 5; V.push([Math.cos(a) * 2 / Math.sqrt(5), Math.sin(a) * 2 / Math.sqrt(5), 1 / Math.sqrt(5)]); }
        for (let k = 0; k < 5; k++) { const a = 2 * Math.PI * k / 5 + Math.PI / 5; V.push([Math.cos(a) * 2 / Math.sqrt(5), Math.sin(a) * 2 / Math.sqrt(5), -1 / Math.sqrt(5)]); }
        V.push([0, 0, -1]);
        F = [];
        for (let k = 0; k < 5; k++) {
            const u = 1 + k, u1 = 1 + (k + 1) % 5, l = 6 + k, l1 = 6 + (k + 1) % 5;
            F.push([0, u, u1], [u, l, u1], [u1, l, l1], [l, 11, l1]);
        }
    }
    const P = [], faces = [], keys = new Map(), sg = smooth ? 1 : 0;
    const vert = q => {
        const l = Math.hypot(q[0], q[1], q[2]) || 1;
        const p = [q[0] / l * r, q[1] / l * r, q[2] / l * r];
        const key = p.map(x => Math.round(x * 1e4)).join(',');
        let i = keys.get(key);
        if (i === undefined) { i = P.push(...p) / 3 - 1; keys.set(key, i); }
        return i;
    };
    for (const [a, b, c] of F) {
        const A = V[a], B = V[b], C = V[c];
        const at = (i, j) => vert([0, 1, 2].map(k => A[k] + (B[k] - A[k]) * i / f + (C[k] - A[k]) * j / f));
        for (let i = 0; i < f; i++) for (let j = 0; i + j < f; j++) {
            faces.push({ v: [at(i, j), at(i + 1, j), at(i, j + 1)], sg });
            if (i + j + 1 < f) faces.push({ v: [at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], sg });
        }
    }
    return orientOutward({ P, faces }, [0, 0, 0]);
}

// cylinder / cone: radius r1 at the bottom (z = 0), r2 at the top (z = height); caps as polygons (n-gons)
function coneMesh({ r1, r2, height: h, heightSegments, capSegments, sides, smooth }) {
    const n = Math.max(3, sides | 0), hs = Math.max(1, heightSegments | 0), cs = Math.max(1, capSegments | 0);
    const P = [], faces = [], sg = smooth ? 1 : 0;
    const ringAt = (radius, z) => {
        if (Math.abs(radius) < 1e-9) return new Array(n).fill(P.push(0, 0, z) / 3 - 1);
        const start = P.length / 3;
        for (let j = 0; j < n; j++) { const a = 2 * Math.PI * j / n; P.push(radius * Math.cos(a), radius * Math.sin(a), z); }
        return Array.from({ length: n }, (_, j) => start + j);
    };
    const side = [];
    for (let k = 0; k <= hs; k++) side.push(ringAt(r1 + (r2 - r1) * k / hs, h * k / hs));
    for (let k = 0; k < hs; k++) for (let j = 0; j < n; j++) {
        const v = [side[k][j], side[k][(j + 1) % n], side[k + 1][(j + 1) % n], side[k + 1][j]].filter((x, i, a) => a.indexOf(x) === i);
        if (v.length >= 3) faces.push({ v, sg });
    }
    const cap = (rim, radius, z, group) => {
        if (Math.abs(radius) < 1e-9) return;
        let outer = rim;
        for (let i = cs - 1; i >= 1; i--) {
            const inner = ringAt(radius * i / cs, z);
            for (let j = 0; j < n; j++) faces.push({ v: [outer[j], outer[(j + 1) % n], inner[(j + 1) % n], inner[j]], sg: group });
            outer = inner;
        }
        faces.push({ v: [...outer], sg: group });
    };
    cap(side[0], r1, 0, 2);
    cap(side[hs], r2, h, 4);
    return orientOutward({ P, faces }, [0, 0, h / 2]);
}

function torusMesh({ r1, r2, rotation = 0, twist = 0, segments, sides, smooth }) {
    const n = Math.max(3, segments | 0), m = Math.max(3, sides | 0);
    const P = [], faces = [], sg = smooth ? 1 : 0;
    for (let i = 0; i < n; i++) {
        const th = 2 * Math.PI * i / n;
        for (let j = 0; j < m; j++) {
            const ph = 2 * Math.PI * j / m + rotation + twist * i / n;
            const rr = r1 + r2 * Math.cos(ph);
            P.push(rr * Math.cos(th), rr * Math.sin(th), r2 * Math.sin(ph));
        }
    }
    const at = (i, j) => (i % n) * m + (j % m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        // outward: away from the tube's centre line
        const th = 2 * Math.PI * (i + 0.5) / n, c = [r1 * Math.cos(th), r1 * Math.sin(th), 0];
        const tmp = { P, faces: [{ v }] };
        orientOutward(tmp, c);
        faces.push({ v: tmp.faces[0].v, sg });
    }
    return { P, faces };
}

function pyramidMesh({ width: w, depth: d, height: h }) {
    const P = [-w / 2, -d / 2, 0, w / 2, -d / 2, 0, w / 2, d / 2, 0, -w / 2, d / 2, 0, 0, 0, h];
    const faces = [{ v: [0, 3, 2, 1], sg: 0 }, { v: [0, 1, 4], sg: 0 }, { v: [1, 2, 4], sg: 0 }, { v: [2, 3, 4], sg: 0 }, { v: [3, 0, 4], sg: 0 }];
    return orientOutward({ P, faces }, [0, 0, h / 4]);
}

function boxMesh({ length: l, width: w, height: h }) {
    const P = [];
    for (const z of [0, h]) for (const y of [-l / 2, l / 2]) for (const x of [-w / 2, w / 2]) P.push(x, y, z);
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]].map(v => ({ v, sg: 0 }));
    return orientOutward({ P, faces }, [0, 0, h / 2]);
}

/** Primitive by kind ('sphere', 'geosphere', 'cylinder', 'cone', 'torus', 'pyramid', 'box') → polygon mesh */
export function primitive(kind, p) {
    switch (kind) {
        case 'sphere': return sphereMesh(p);
        case 'geosphere': return geosphereMesh(p);
        case 'cylinder': return coneMesh({ ...p, r1: p.radius, r2: p.radius });
        case 'cone': return coneMesh(p);
        case 'torus': return torusMesh(p);
        case 'pyramid': return pyramidMesh(p);
        case 'box': return boxMesh(p);
        default: return null;
    }
}

// --- conversions ---

/** Polygon mesh → raw triangles (fans) with smoothing groups and material IDs (for the welding in max-parse.js) */
export function polyToRaw({ P, faces }) {
    let nt = 0;
    for (const f of faces) nt += f.v.length - 2;
    const tri = new Uint32Array(nt * 3), sg = new Uint32Array(nt), mat = new Uint16Array(nt);
    let t = 0;
    for (const f of faces) for (let k = 1; k + 1 < f.v.length; k++, t++) {
        tri[t * 3] = f.v[0]; tri[t * 3 + 1] = f.v[k]; tri[t * 3 + 2] = f.v[k + 1];
        sg[t] = f.sg >>> 0; mat[t] = f.mat || 0;
    }
    return { P: Float32Array.from(P), tri, sg, mat, tuv: null, uvs: null };
}

// --- deformers (points only; `space` maps object space into the modifier's gizmo space and back) ---

const IDENTITY = { to: p => p, from: p => p };

/**
 * Gizmo space of a modifier: context TM (0x2510, object → modifier), then centre and gizmo transform (position,
 * Euler rotation, scale) – p_gizmo = R⁻¹ · S⁻¹ · (ctx(p) − centre − gizmo position)
 */
export function gizmoSpace(ctx, centre = [0, 0, 0], gizmo = null) {
    const m = ctx || [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];   // rows: x, y, z, translation (row vectors)
    const fwd = p => [p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9], p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10], p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11]];
    // inverse of the 3×3 part
    const a = m, det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    if (Math.abs(det) < 1e-20) return IDENTITY;
    const inv = [(a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
        (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
        (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det];
    const back = q => { const p = [q[0] - m[9], q[1] - m[10], q[2] - m[11]]; return [p[0] * inv[0] + p[1] * inv[3] + p[2] * inv[6], p[0] * inv[1] + p[1] * inv[4] + p[2] * inv[7], p[0] * inv[2] + p[1] * inv[5] + p[2] * inv[8]]; };
    const off = [centre[0] + (gizmo?.position?.[0] || 0), centre[1] + (gizmo?.position?.[1] || 0), centre[2] + (gizmo?.position?.[2] || 0)];
    const R = gizmo?.rotation ? rotationMatrix(gizmo.rotation) : null, S = gizmo?.scale || [1, 1, 1];
    return {
        to: p => {
            let q = fwd(p);
            q = [q[0] - off[0], q[1] - off[1], q[2] - off[2]];
            if (R) q = [R[0] * q[0] + R[3] * q[1] + R[6] * q[2], R[1] * q[0] + R[4] * q[1] + R[7] * q[2], R[2] * q[0] + R[5] * q[1] + R[8] * q[2]];   // Rᵀ = R⁻¹
            return [q[0] / (S[0] || 1), q[1] / (S[1] || 1), q[2] / (S[2] || 1)];
        },
        from: q => {
            let p = [q[0] * S[0], q[1] * S[1], q[2] * S[2]];
            if (R) p = [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
            return back([p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
        },
    };
}

// rotation matrix (row-major 3×3, column vectors) of a rotation { euler: [x, y, z], order } (MAX XYZ = about X first) or { quat }
function rotationMatrix(r) {
    if (r.quat) {
        const [x, y, z, w] = r.quat;
        return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    }
    const axes = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'][r.order || 0] || 'XYZ';
    const single = (axis, a) => {
        const c = Math.cos(a), s = Math.sin(a);
        if (axis === 'X') return [1, 0, 0, 0, c, -s, 0, s, c];
        if (axis === 'Y') return [c, 0, s, 0, 1, 0, -s, 0, c];
        return [c, -s, 0, s, c, 0, 0, 0, 1];
    };
    const mul = (A, B) => { const o = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return o; };
    let M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (const axis of axes) M = mul(single(axis, r.euler['XYZ'.indexOf(axis)]), M);   // first axis applied first
    return M;
}

const mapPoints = (P, space, fn) => {
    for (let i = 0; i < P.length; i += 3) {
        const q = fn(space.to([P[i], P[i + 1], P[i + 2]]));
        const p = space.from(q);
        P[i] = p[0]; P[i + 1] = p[1]; P[i + 2] = p[2];
    }
};

/**
 * Bend by `angle` (degrees) around the gizmo's `axis` (0 X, 1 Y, 2 Z), bend plane turned by `direction` (degrees);
 * the bent length is the context box along the axis (as MAX), bent around the gizmo centre.
 */
export function bend(P, { angle, direction = 0, axis = 2, box, space }) {
    const theta = angle * Math.PI / 180;
    if (Math.abs(theta) < 1e-9 || !box) return;
    const w = axis === 0 ? 0 : axis === 1 ? 1 : 2;   // bend axis
    const u = (w + 1) % 3, v = (w + 2) % 3;           // bend plane u–w, v unchanged
    const L = Math.abs(box[3 + w] - box[w]) || 1;
    const k = theta / L, r = 1 / k, d = direction * Math.PI / 180, cd = Math.cos(d), sd = Math.sin(d);
    mapPoints(P, space, q => {
        // turn the bend plane by the direction
        let x = q[u] * cd + q[v] * sd, y = -q[u] * sd + q[v] * cd;
        const z = q[w], a = k * z;
        const nx = r - (r - x) * Math.cos(a), nz = (r - x) * Math.sin(a);
        x = nx;
        const o = [0, 0, 0];
        o[u] = x * cd - y * sd; o[v] = x * sd + y * cd; o[w] = nz;
        return o;
    });
}

/** FFD lattice (n × n × n, cubic Bernstein for 4): control points = base + offsets (normalised to the context box) */
export function ffd(P, { dim, base, offsets, box, space }) {
    if (!box || !offsets?.some(x => Math.abs(x) > 1e-9)) return;   // untouched lattice: no change
    const n = dim, deg = n - 1;
    const binom = [1, deg, deg * (deg - 1) / 2, 1].slice(0, n);
    const B = t => Array.from({ length: n }, (_, i) => binom[Math.min(i, deg - i)] * t ** i * (1 - t) ** (deg - i));
    const size = [box[3] - box[0] || 1, box[4] - box[1] || 1, box[5] - box[2] || 1];
    mapPoints(P, space, q => {
        const s = [(q[0] - box[0]) / size[0], (q[1] - box[1]) / size[1], (q[2] - box[2]) / size[2]];
        const bx = B(s[0]), by = B(s[1]), bz = B(s[2]);
        const o = [0, 0, 0];
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
            const w = bx[i] * by[j] * bz[k], c = (i * n * n + j * n + k) * 3;
            for (let a = 0; a < 3; a++) o[a] += w * (base[c + a] + offsets[c + a]);
        }
        return [box[0] + o[0] * size[0], box[1] + o[1] * size[1], box[2] + o[2] * size[2]];
    });
}

// gradient noise (own Perlin-style implementation, seeded) – MAX' Noise uses its own function, so the pattern differs
function noiseField(seed) {
    const perm = new Uint8Array(512);
    let s = (seed * 2654435761) >>> 0 || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const grad = (h, x, y, z) => { const g = h & 15, u = g < 8 ? x : y, v = g < 4 ? y : g === 12 || g === 14 ? x : z; return ((g & 1) ? -u : u) + ((g & 2) ? -v : v); };
    const lerp = (a, b, t) => a + t * (b - a);
    return (x, y, z) => {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
        x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
        const u = fade(x), v = fade(y), w = fade(z);
        const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z, B2 = perm[X + 1] + Y, BA = perm[B2] + Z, BB = perm[B2 + 1] + Z;
        return lerp(lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
            lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v), w);
    };
}

/** Noise: displacement per axis of strength × gradient noise at point / scale (approximation of MAX' Noise) */
export function noise(P, { seed = 0, scale = 100, strength = [0, 0, 0], fractal = false, roughness = 0, iterations = 6, space }) {
    if (!strength.some(s => Math.abs(s) > 1e-9)) return;
    const field = noiseField(seed + 1);
    const sc = Math.abs(scale) > 1e-9 ? scale : 1;
    const value = (x, y, z) => {
        if (!fractal) return field(x, y, z);
        let sum = 0, amp = 1, freq = 1, norm = 0;
        for (let i = 0; i < Math.max(1, Math.round(iterations)); i++) { sum += amp * field(x * freq, y * freq, z * freq); norm += amp; amp *= Math.max(0.05, roughness || 0.5); freq *= 2; }
        return sum / norm;
    };
    mapPoints(P, space, q => {
        const x = q[0] / sc, y = q[1] / sc, z = q[2] / sc;
        return [q[0] + strength[0] * value(x + 17.3, y, z), q[1] + strength[1] * value(x, y + 31.7, z), q[2] + strength[2] * value(x, y, z + 53.1)];
    });
}

/** Edit Poly vertex moves: per recorded step one delta per vertex (only when the vertex count matches) */
export function moveVertices(P, steps) {
    const n = P.length / 3;
    for (const d of steps) {
        if (d.length !== n * 3) return false;
        for (let i = 0; i < P.length; i++) P[i] += d[i];
    }
    return true;
}

// --- TurboSmooth (Catmull–Clark) ---

/** Catmull–Clark subdivision, `iterations` times; open borders stay borders (curve rule) */
export function turboSmooth(mesh, iterations = 1) {
    let { P, faces } = mesh;
    for (let it = 0; it < Math.max(0, Math.min(iterations | 0, 4)); it++) {
        const nv = P.length / 3;
        const NP = [];
        const add = p => NP.push(p[0], p[1], p[2]) / 3 - 1;
        const pt = i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
        // face points
        const fp = faces.map(f => { const c = [0, 0, 0]; for (const v of f.v) { const p = pt(v); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return c.map(x => x / f.v.length); });
        // edges
        const edges = new Map();
        const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
        faces.forEach((f, fi) => f.v.forEach((a, k) => {
            const b = f.v[(k + 1) % f.v.length], key = ek(a, b);
            let e = edges.get(key);
            if (!e) edges.set(key, e = { a, b, faces: [] });
            e.faces.push(fi);
        }));
        // vertex neighbourhoods
        const vFaces = Array.from({ length: nv }, () => []), vEdges = Array.from({ length: nv }, () => []);
        faces.forEach((f, fi) => f.v.forEach(v => vFaces[v].push(fi)));
        for (const e of edges.values()) { vEdges[e.a].push(e); vEdges[e.b].push(e); }
        // new vertex positions (indices 0..nv-1 keep their numbers)
        for (let v = 0; v < nv; v++) {
            const p = pt(v), border = vEdges[v].filter(e => e.faces.length === 1);
            let q;
            if (border.length >= 2) {
                const o1 = pt(border[0].a === v ? border[0].b : border[0].a), o2 = pt(border[1].a === v ? border[1].b : border[1].a);
                q = [0, 1, 2].map(k => (o1[k] + o2[k] + 6 * p[k]) / 8);
            } else if (vFaces[v].length) {
                const n = vFaces[v].length;
                const F = [0, 0, 0], R = [0, 0, 0];
                for (const fi of vFaces[v]) for (let k = 0; k < 3; k++) F[k] += fp[fi][k] / n;
                const ne = vEdges[v].length || 1;
                for (const e of vEdges[v]) { const a = pt(e.a), b = pt(e.b); for (let k = 0; k < 3; k++) R[k] += (a[k] + b[k]) / 2 / ne; }
                q = [0, 1, 2].map(k => (F[k] + 2 * R[k] + (n - 3) * p[k]) / n);
            } else q = p;
            add(q);
        }
        const fIndex = fp.map(p => add(p));
        for (const e of edges.values()) {
            const a = pt(e.a), b = pt(e.b);
            e.index = add(e.faces.length === 2
                ? [0, 1, 2].map(k => (a[k] + b[k] + fp[e.faces[0]][k] + fp[e.faces[1]][k]) / 4)
                : [0, 1, 2].map(k => (a[k] + b[k]) / 2));
        }
        const next = [];
        faces.forEach((f, fi) => {
            const n = f.v.length;
            for (let k = 0; k < n; k++) {
                const v = f.v[k], prev = f.v[(k - 1 + n) % n], nxt = f.v[(k + 1) % n];
                next.push({ v: [v, edges.get(ek(v, nxt)).index, fIndex[fi], edges.get(ek(prev, v)).index], sg: 1, mat: f.mat || 0 });
            }
        });
        P = NP; faces = next;
    }
    return { P, faces };
}

/** Cap Holes: every open border loop becomes a face (polygon meshes) or is triangulated in its plane (triangle meshes) */
export function capHoles(state) {
    const isPoly = !!state.faces;
    const P = state.P;
    const faceList = isPoly ? state.faces.map(f => f.v) : Array.from({ length: state.tri.length / 3 }, (_, t) => [state.tri[t * 3], state.tri[t * 3 + 1], state.tri[t * 3 + 2]]);
    // directed border edges: used in one direction only
    const used = new Set();
    for (const v of faceList) for (let k = 0; k < v.length; k++) used.add(`${v[k]},${v[(k + 1) % v.length]}`);
    const next = new Map();
    for (const v of faceList) for (let k = 0; k < v.length; k++) {
        const a = v[k], b = v[(k + 1) % v.length];
        if (!used.has(`${b},${a}`)) next.set(b, a);   // the cap runs the other way round
    }
    const loops = [];
    const seen = new Set();
    for (const startV of next.keys()) {
        if (seen.has(startV)) continue;
        const loop = [];
        for (let v = startV; v !== undefined && !seen.has(v); v = next.get(v)) { seen.add(v); loop.push(v); }
        if (loop.length >= 3 && next.get(loop[loop.length - 1]) === startV) loops.push(loop);
    }
    if (!loops.length) return state;
    if (isPoly) return { P, faces: [...state.faces, ...loops.map(v => ({ v, sg: 0 }))] };
    // triangle mesh: earcut in the loop's plane (Newell normal), flat normals
    const tri = Array.from(state.tri), N = Array.from(state.N || []);
    for (const loop of loops) {
        let n = [0, 0, 0];
        for (let k = 0; k < loop.length; k++) {
            const a = loop[k] * 3, b = loop[(k + 1) % loop.length] * 3;
            n[0] += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]); n[1] += (P[a + 2] - P[b + 2]) * (P[a] + P[b]); n[2] += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
        }
        n = norm(n);
        const u = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), w = cross(n, u);
        const flat = [];
        for (const v of loop) flat.push(P[v * 3] * u[0] + P[v * 3 + 1] * u[1] + P[v * 3 + 2] * u[2], P[v * 3] * w[0] + P[v * 3 + 1] * w[1] + P[v * 3 + 2] * w[2]);
        const idx = earcut(flat);
        for (let t = 0; t < idx.length; t += 3) {
            let [a, b, c] = [loop[idx[t]], loop[idx[t + 1]], loop[idx[t + 2]]];
            const fnrm = cross([P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]]);
            if (fnrm[0] * n[0] + fnrm[1] * n[1] + fnrm[2] * n[2] < 0) [b, c] = [c, b];
            tri.push(a, b, c);
            N.push(...n, ...n, ...n);
        }
    }
    return { P, tri: Uint32Array.from(tri), N: Float32Array.from(N) };
}


// --- renderable splines ("Enable in Renderer": thickness) ---

/**
 * Tube along each spline: radial (`thickness` = diameter, `sides`, `angle` of the first side) or rectangular
 * (`rect`: { length, width, angle }); frames by parallel transport, open ends capped. Returns a polygon mesh
 * (sides smooth along the path, flat across the corners of a rectangle).
 */
export function sweepSplines(splines, { thickness = 1, sides = 12, angle = 0, rect = null, steps = 6 }) {
    const P = [], faces = [];
    for (const spline of splines) {
        const pts = sampleSpline(spline, steps).map(q => q.p);
        const closed = spline.closed && pts.length > 2, n = pts.length;
        if (n < 2) continue;
        // tangents and parallel-transported frames
        const T = pts.map((_, i) => norm(sub(pts[closed ? (i + 1) % n : Math.min(i + 1, n - 1)], pts[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)])));
        let N0 = cross(T[0], [0, 0, 1]);
        if (len(N0) < 1e-6) N0 = cross(T[0], [1, 0, 0]);
        const N = [norm(N0)];
        for (let i = 1; i < n; i++) { const d = T[i][0] * N[i - 1][0] + T[i][1] * N[i - 1][1] + T[i][2] * N[i - 1][2]; N.push(norm([N[i - 1][0] - T[i][0] * d, N[i - 1][1] - T[i][1] * d, N[i - 1][2] - T[i][2] * d])); }
        // cross section in the (N, B) plane
        const section = rect
            ? [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const x = a * rect.width / 2, y = b * rect.length / 2, c = Math.cos(rect.angle || 0), s2 = Math.sin(rect.angle || 0); return [x * c - y * s2, x * s2 + y * c]; })
            : Array.from({ length: Math.max(3, sides | 0) }, (_, k) => { const a = angle + 2 * Math.PI * k / Math.max(3, sides | 0); return [Math.cos(a) * thickness / 2, Math.sin(a) * thickness / 2]; });
        const m = section.length, base = P.length / 3;
        for (let i = 0; i < n; i++) {
            const B = cross(T[i], N[i]);
            for (const [x, y] of section) P.push(pts[i][0] + N[i][0] * x + B[0] * y, pts[i][1] + N[i][1] * x + B[1] * y, pts[i][2] + N[i][2] * x + B[2] * y);
        }
        const at = (i, k) => base + (i % n) * m + (k % m);
        const segs = closed ? n : n - 1;
        for (let i = 0; i < segs; i++) for (let k = 0; k < m; k++) {
            const tmp = { P, faces: [{ v: [at(i, k), at(i, k + 1), at(i + 1, k + 1), at(i + 1, k)] }] };
            orientOutward(tmp, [(pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2, (pts[i][2] + pts[(i + 1) % n][2]) / 2]);
            faces.push({ v: tmp.faces[0].v, sg: rect ? 1 << k : 1 });
        }
        if (!closed) {   // caps facing along the path
            for (const [i, dir] of [[0, -1], [n - 1, 1]]) {
                const v = Array.from({ length: m }, (_, k) => at(i, k));
                const a = v[0] * 3, b = v[1] * 3, c = v[2] * 3;
                const f = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
                if ((f[0] * T[i][0] + f[1] * T[i][1] + f[2] * T[i][2]) * dir < 0) v.reverse();
                faces.push({ v, sg: 0 });
            }
        }
    }
    return { P, faces };
}
