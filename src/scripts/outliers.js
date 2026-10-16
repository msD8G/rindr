// Stray objects in CAD files: helper geometry kilometres away from the model, a part blown up to kilometres by an
// export error … One such object made the bounding box huge: the camera framed kilometres of nothing, the model was
// centred on the stray object and ended up kilometres from the origin (32-bit floats: millimetre steps lost there),
// and its giant triangles covered everything in the path tracer's acceleration structure.
//
// Found per mesh box against the core of the model: per axis the 5 % / 95 % quantiles of the box minima/maxima –
// a few extreme boxes do not count, however large – give the core box (size S). An outlier is a box larger than
// `factor` · S or farther than `factor` · S from the core's centre. Large real parts (a body among many screws) lie
// within the core and stay; two machines far apart with many parts each make the core span both. Fewer than 20 boxes
// (core undecided): only one box far larger than all others (> 100 × the next, > 1000 × the median) counts.

/**
 * @param {{ min: {x,y,z}, max: {x,y,z} }[]} boxes world boxes (THREE.Box3)
 * @returns {{ outliers: Set<number>, core: { min: number[], max: number[] } | null, size: number }}
 *   outliers = indices into boxes, size = diagonal of the core
 */
export function findOutliers(boxes, { factor = 50, minCount = 3 } = {}) {
    const n = boxes.length;
    const outliers = new Set();
    if (n < minCount) return { outliers, core: null, size: 0 };
    const diag = boxes.map(b => Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z));
    const sorted = [...diag].sort((a, b) => a - b);
    const median = Math.max(sorted[n >> 1], 1e-9);

    // core box from quantiles (with fewer than 20 boxes the 5 % quantile is the extreme itself – then only the
    // size rule below applies)
    const lo = Math.floor(n * 0.05), hi = Math.max(Math.ceil(n * 0.95) - 1, lo);
    const core = { min: [], max: [] };
    for (const axis of ['x', 'y', 'z']) {
        const mins = boxes.map(b => b.min[axis]).sort((a, b) => a - b);
        const maxs = boxes.map(b => b.max[axis]).sort((a, b) => a - b);
        core.min.push(mins[lo]);
        core.max.push(Math.max(maxs[hi], mins[lo]));
    }
    const size = Math.max(Math.hypot(core.max[0] - core.min[0], core.max[1] - core.min[1], core.max[2] - core.min[2]), median);
    const cx = (core.min[0] + core.max[0]) / 2, cy = (core.min[1] + core.max[1]) / 2, cz = (core.min[2] + core.max[2]) / 2;
    const decided = n >= 20;
    const second = sorted[n - 2] ?? 0;   // second largest box
    boxes.forEach((b, i) => {
        // few boxes: only one box far larger than all others (> 100 × the next one, > 1000 × the median)
        if (!decided) {
            if (diag[i] === sorted[n - 1] && diag[i] > 100 * Math.max(second, 1e-9) && diag[i] > 1000 * median) outliers.add(i);
            return;
        }
        const d = Math.hypot((b.min.x + b.max.x) / 2 - cx, (b.min.y + b.max.y) / 2 - cy, (b.min.z + b.max.z) / 2 - cz);
        if (diag[i] > factor * size || d > factor * size) outliers.add(i);
    });
    // never everything (a model of only "outliers" is just a large model)
    if (outliers.size >= n) outliers.clear();
    return { outliers, core, size };
}

/** Length in mm for messages: "61,7 km", "3,2 m", "45 mm" */
export function formatLength(mm, locale) {
    const f = (v, d) => v.toLocaleString(locale, { maximumFractionDigits: d });
    if (mm >= 1e6) return `${f(mm / 1e6, 1)} km`;
    if (mm >= 1e3) return `${f(mm / 1e3, 1)} m`;
    return `${f(mm, 0)} mm`;
}
