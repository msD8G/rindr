// Normals from the geometry alone: smooth across corners at the same position, edges sharper than the crease angle
// (30° like Blender) stay hard. Each face counts with its corner angle (Thürmer/Wüthrich), so the result does not
// depend on the triangulation – unweighted averaging (three's toCreasedNormals) let fans of long thin triangles on
// flat CAD faces pull the normals askew. 60° also smoothed flat faces into neighbouring chamfers (shading gradient).
// Used for meshes without normals (FBX/glTF/STL, mesh-importer.js) and for MAX meshes (max/max-parse.js).
// Pure function – main thread and workers.

export const CREASE_ANGLE = 30;

/**
 * @param {ArrayLike<number>} positions xyz per vertex
 * @param {ArrayLike<number>} index three vertex indices per triangle
 * @returns {Float32Array} unit normal per corner (index.length × 3)
 */
export function creaseCornerNormals(positions, index, angle = CREASE_ANGLE) {
    const creaseDot = Math.cos(angle * Math.PI / 180);
    const nf = index.length / 3, nv = positions.length / 3;
    // 1. face normals (unit) and corner angles
    const fn = new Float64Array(nf * 3), corner = new Float64Array(index.length);
    const len = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
    const cornerAngle = (ux, uy, uz, wx, wy, wz) => {
        const d = len(ux, uy, uz) * len(wx, wy, wz);
        return d > 0 ? Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy + uz * wz) / d))) : 0;
    };
    for (let f = 0; f < nf; f++) {
        const a = index[f * 3] * 3, b = index[f * 3 + 1] * 3, c = index[f * 3 + 2] * 3;
        const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
        const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
        const bcx = positions[c] - positions[b], bcy = positions[c + 1] - positions[b + 1], bcz = positions[c + 2] - positions[b + 2];
        const x = aby * acz - abz * acy, y = abz * acx - abx * acz, z = abx * acy - aby * acx;
        const l = len(x, y, z);
        if (l > 0) { fn[f * 3] = x / l; fn[f * 3 + 1] = y / l; fn[f * 3 + 2] = z / l; }   // degenerate: zero, no weight
        corner[f * 3] = cornerAngle(abx, aby, abz, acx, acy, acz);
        corner[f * 3 + 1] = cornerAngle(-abx, -aby, -abz, bcx, bcy, bcz);
        corner[f * 3 + 2] = Math.max(0, Math.PI - corner[f * 3] - corner[f * 3 + 1]);
    }
    // 2. weld vertices at the same position (grid relative to the model size, unit independent)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < positions.length; i++) { const v = positions[i]; if (v < min) min = v; if (v > max) max = v; }
    const inv = 1 / Math.max((max - min) * 1e-7, 1e-12);
    const weld = new Int32Array(nv), q = new Int32Array(nv * 3);
    let size = 1;
    while (size < nv * 2) size <<= 1;
    const table = new Int32Array(size);   // open addressing, slot = welded id + 1, 0 = empty
    let count = 0;
    for (let v = 0; v < nv; v++) {
        const x = Math.round((positions[v * 3] - min) * inv), y = Math.round((positions[v * 3 + 1] - min) * inv), z = Math.round((positions[v * 3 + 2] - min) * inv);
        let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
        for (;;) {
            const e = table[slot];
            if (e === 0) { q[count * 3] = x; q[count * 3 + 1] = y; q[count * 3 + 2] = z; table[slot] = ++count; weld[v] = count - 1; break; }
            if (q[(e - 1) * 3] === x && q[(e - 1) * 3 + 1] === y && q[(e - 1) * 3 + 2] === z) { weld[v] = e - 1; break; }
            slot = (slot + 1) & (size - 1);
        }
    }
    // 3. corners around each welded position (CSR)
    const start = new Int32Array(count + 1);
    for (let i = 0; i < index.length; i++) start[weld[index[i]] + 1]++;
    for (let k = 0; k < count; k++) start[k + 1] += start[k];
    const cursor = start.slice(0, count), around = new Int32Array(index.length);
    for (let i = 0; i < index.length; i++) around[cursor[weld[index[i]]]++] = i;
    // 4. per corner: angle-weighted sum of the faces around it within the crease angle
    const out = new Float32Array(index.length * 3);
    for (let i = 0; i < index.length; i++) {
        const f3 = i - i % 3;
        const nx = fn[f3], ny = fn[f3 + 1], nz = fn[f3 + 2];
        let sx = 0, sy = 0, sz = 0;
        const id = weld[index[i]];
        for (let k = start[id]; k < start[id + 1]; k++) {
            const c = around[k], o = c - c % 3;
            if (nx * fn[o] + ny * fn[o + 1] + nz * fn[o + 2] > creaseDot) {
                const w = corner[c];
                sx += fn[o] * w; sy += fn[o + 1] * w; sz += fn[o + 2] * w;
            }
        }
        const l = len(sx, sy, sz);
        if (l > 0) { sx /= l; sy /= l; sz /= l; } else { sx = nx; sy = ny; sz = nz; }
        out[i * 3] = sx; out[i * 3 + 1] = sy; out[i * 3 + 2] = sz;
    }
    return out;
}
