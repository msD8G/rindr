// Orientation repair for triangle soups without structure (STL): which side of a surface is outside?
//
// STL stores every triangle with its own winding. Exporters get single-sided panels wrong (body panels of a
// car modelled as open sheets: the bonnet faces into the car) – with FrontSide rendering such a panel shows
// its back (dark / looks inverted). Like orientFaces for STEP, but without faces/solids:
//   1. weld vertices (exact position), edges with the triangles using them
//   2. pieces = triangles connected over edges with exactly two, oppositely wound triangles (consistent)
//   3. closed piece (every edge shared consistently): outward = positive volume
//      open piece: ray test – from sample points rays along the normal and against it; the side whose rays
//      escape the whole model more often is outside. Both blocked (interior parts) → unchanged.
//   4. a triangle with a twin of opposite winding (deliberately two-sided) is never flipped
// Runs in the STEP worker (job 'orient'); positions are modified in place.
import { BufferGeometry, BufferAttribute, Ray, Vector3, DoubleSide } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const pow2Above = x => { let c = 1024; while (c < x) c *= 2; return c; };

/**
 * @param {Float32Array} positions non-indexed, 9 floats per triangle – flipped triangles get corners 1 and 2 swapped
 * @returns {{ triangles, pieces, flippedPieces, flippedTriangles, closedFlipped, openFlipped, rays, ms }}
 */
export function orientTriangles(positions) {
    const t0 = performance.now();
    const n = Math.floor(positions.length / 9);
    const bits = new Uint32Array(positions.buffer, positions.byteOffset, n * 9);

    // 1. weld: vertex id per corner
    const corner = new Int32Array(n * 3);
    let vMask = pow2Above(n * 2) - 1, vSlots = new Int32Array(vMask + 1).fill(-1);
    const first = new Int32Array(n * 3);   // vertex id -> corner holding its coordinates
    let vCount = 0;
    const vHash = c => {
        let h = Math.imul(bits[c * 3] ^ 0x811C9DC5, 0x01000193);
        h = Math.imul(h ^ bits[c * 3 + 1], 0x01000193);
        h = Math.imul(h ^ bits[c * 3 + 2], 0x01000193);
        return (h ^ (h >>> 15)) & vMask;
    };
    for (let c = 0; c < n * 3; c++) {
        let h = vHash(c), id = vSlots[h];
        for (; id >= 0; h = (h + 1) & vMask, id = vSlots[h]) {
            const f = first[id];
            if (bits[f * 3] === bits[c * 3] && bits[f * 3 + 1] === bits[c * 3 + 1] && bits[f * 3 + 2] === bits[c * 3 + 2]) break;
        }
        if (id < 0) {
            id = vCount++;
            first[id] = c;
            vSlots[h] = id;
            if (vCount > (vMask + 1) * 0.5) {
                vMask = vMask * 2 + 1;
                vSlots = new Int32Array(vMask + 1).fill(-1);
                for (let v = 0; v < vCount; v++) {
                    let s = vHash(first[v]);
                    while (vSlots[s] >= 0) s = (s + 1) & vMask;
                    vSlots[s] = v;
                }
            }
        }
        corner[c] = id;
    }
    vSlots = null;

    // 2. edges: uses (count, first two triangles + direction); triangle edge -> edge id
    let eMask = pow2Above(n * 3) - 1;
    const eSlots = new Int32Array(eMask + 1).fill(-1);
    const ends = new Int32Array(n * 6), count = new Int32Array(n * 3), use = new Int32Array(n * 6);
    let eCount = 0;
    const eHash = (a, b) => { const h = Math.imul(a ^ Math.imul(b, 0x85EBCA77), 0x9E3779B1); return (h ^ (h >>> 15)) & eMask; };
    const triEdge = new Int32Array(n * 3).fill(-1);
    for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
            const a = corner[t * 3 + k], b = corner[t * 3 + (k + 1) % 3];
            if (a === b) continue;
            const lo = a < b ? a : b, hi = a < b ? b : a;
            let h = eHash(lo, hi), e = eSlots[h];
            for (; e >= 0; h = (h + 1) & eMask, e = eSlots[h]) if (ends[e * 2] === lo && ends[e * 2 + 1] === hi) break;
            if (e < 0) { e = eCount++; ends[e * 2] = lo; ends[e * 2 + 1] = hi; eSlots[h] = e; }
            const c = count[e]++;
            if (c < 2) use[e * 2 + c] = a < b ? t + 1 : -(t + 1);   // signed: direction along lo→hi
            triEdge[t * 3 + k] = e;
        }
    }

    // 3. twins with opposite winding (two-sided surfaces): same vertex set, other cyclic order
    const twoSided = new Uint8Array(n);
    {
        const tMask = pow2Above(n * 2) - 1, tSlots = new Int32Array(tMask + 1).fill(-1);
        for (let t = 0; t < n; t++) {
            const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
            if (a === b || b === c || a === c) continue;
            const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
            let h = (Math.imul(lo ^ Math.imul(mid, 0x85EBCA77) ^ Math.imul(hi, 0xC2B2AE3D), 0x9E3779B1) >>> 0) & tMask;
            for (let o = tSlots[h]; o >= 0; h = (h + 1) & tMask, o = tSlots[h]) {
                const p = corner[o * 3], q = corner[o * 3 + 1], r = corner[o * 3 + 2];
                if (Math.min(p, q, r) !== lo || Math.max(p, q, r) !== hi || p + q + r - lo - hi !== mid) continue;
                // same cyclic order as (a, b, c)?
                const same = (p === a && q === b) || (p === b && q === c) || (p === c && q === a);
                if (!same) twoSided[t] = twoSided[o] = 1;
            }
            tSlots[h] = t;
        }
    }

    // 4. pieces: union over consistently shared edges (exactly two triangles, opposite directions)
    const parent = new Int32Array(n);
    for (let t = 0; t < n; t++) parent[t] = t;
    const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    const open = new Uint8Array(n);   // touches an edge that is not shared consistently by two
    for (let e = 0; e < eCount; e++) {
        const u = use[e * 2], v = use[e * 2 + 1];
        if (count[e] === 2 && (u > 0) !== (v > 0)) {
            const a = find(Math.abs(u) - 1), b = find(Math.abs(v) - 1);
            if (a !== b) parent[a] = b;
        }
    }
    for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
            const e = triEdge[t * 3 + k];
            if (e < 0) continue;
            if (count[e] !== 2 || (use[e * 2] > 0) === (use[e * 2 + 1] > 0)) { open[t] = 1; break; }
        }
    }
    // piece id per triangle, triangles grouped per piece (counting sort)
    const pieceOf = new Int32Array(n), rootId = new Int32Array(n).fill(-1);
    let pieces = 0;
    for (let t = 0; t < n; t++) {
        const r = find(t);
        if (rootId[r] < 0) rootId[r] = pieces++;
        pieceOf[t] = rootId[r];
    }
    const start = new Int32Array(pieces + 1);
    for (let t = 0; t < n; t++) start[pieceOf[t] + 1]++;
    for (let p = 0; p < pieces; p++) start[p + 1] += start[p];
    const order = new Int32Array(n), fill = start.slice(0, pieces);
    for (let t = 0; t < n; t++) order[fill[pieceOf[t]]++] = t;

    // per triangle: area; per piece: area, signed volume, closed, two-sided
    const area = new Float64Array(n);
    const pArea = new Float64Array(pieces), pVol = new Float64Array(pieces);
    const pOpen = new Uint8Array(pieces), pTwo = new Uint8Array(pieces);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let t = 0; t < n; t++) {
        const o = t * 9, P = positions;
        const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        area[t] = Math.hypot(nx, ny, nz) / 2;
        const p = pieceOf[t];
        pArea[p] += area[t];
        pVol[p] += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
        if (open[t]) pOpen[p] = 1;
        if (twoSided[t]) pTwo[p] = 1;
        minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx);
        minY = Math.min(minY, ay, by, cy); maxY = Math.max(maxY, ay, by, cy);
        minZ = Math.min(minZ, az, bz, cz); maxZ = Math.max(maxZ, az, bz, cz);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;

    // 5. decide per piece
    let bvh = null, rays = 0;
    const eps = diag * 1e-5, minHit = eps * 2;
    const ray = new Ray(), hitPoint = new Vector3(), origin = new Vector3();
    const A = new Vector3(), B = new Vector3(), C = new Vector3(), N = new Vector3(), P = new Vector3();
    // any hit beyond minHit (shapecast stops at the first one – cheaper than the closest hit)
    const blocked = () => {
        rays++;
        return bvh.shapecast({
            intersectsBounds: box => ray.intersectsBox(box),
            intersectsTriangle: tri => {
                const hit = ray.intersectTriangle(tri.a, tri.b, tri.c, false, hitPoint);
                return hit !== null && hit.distanceTo(origin) > minHit;
            },
        });
    };
    let seed = 0x2545F491;
    const random = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const flip = new Uint8Array(pieces);
    let closedFlipped = 0, openFlipped = 0;
    for (let p = 0; p < pieces; p++) {
        if (pTwo[p] || pArea[p] <= 0) continue;
        if (!pOpen[p]) {
            // closed body inside out: clearly negative volume (flat pieces have ~0 – no decision)
            if (pVol[p] < -1e-3 * pArea[p] ** 1.5) { flip[p] = 1; closedFlipped++; }
            continue;
        }
        if (!bvh) {
            const g = new BufferGeometry();
            g.setAttribute('position', new BufferAttribute(positions, 3));
            bvh = new MeshBVH(g, { indirect: true });   // indirect: positions stay in place
        }
        const s = start[p], e = start[p + 1], tris = e - s;
        const k = Math.min(16, Math.max(2, Math.ceil(tris / 50)));
        let outVotes = 0, inVotes = 0;
        for (let i = 0; i < k; i++) {
            // sample triangle by area
            let r = random() * pArea[p], t = order[s];
            for (let j = s; j < e; j++) { t = order[j]; r -= area[t]; if (r <= 0) break; }
            A.fromArray(positions, t * 9); B.fromArray(positions, t * 9 + 3); C.fromArray(positions, t * 9 + 6);
            N.subVectors(B, A).cross(P.subVectors(C, A));
            if (N.lengthSq() === 0) continue;
            N.normalize();
            let u = random(), v = random();
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            P.copy(A).multiplyScalar(1 - u - v).addScaledVector(B, u).addScaledVector(C, v);
            origin.copy(P).addScaledVector(N, eps);
            ray.set(origin, N);
            if (!blocked()) { outVotes++; continue; }
            origin.copy(P).addScaledVector(N, -eps);
            ray.set(origin, N.negate());
            if (!blocked()) inVotes++;
        }
        if (inVotes > outVotes && inVotes >= Math.max(1, k / 4)) { flip[p] = 1; openFlipped++; }
    }

    // 6. flip: swap corners 1 and 2
    let flippedTriangles = 0;
    for (let t = 0; t < n; t++) {
        if (!flip[pieceOf[t]]) continue;
        flippedTriangles++;
        const o = t * 9;
        for (let j = 0; j < 3; j++) { const x = positions[o + 3 + j]; positions[o + 3 + j] = positions[o + 6 + j]; positions[o + 6 + j] = x; }
    }
    return {
        triangles: n, pieces, flippedPieces: closedFlipped + openFlipped, flippedTriangles, closedFlipped, openFlipped, rays,
        ms: Math.round(performance.now() - t0),
    };
}
