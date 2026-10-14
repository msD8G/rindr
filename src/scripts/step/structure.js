// Resolution of the product structure: assemblies, transformations, solids, colours.
// Runs once per file (in the first worker) and creates a "plan" according to which the
// faces are distributed to all workers.

import { Ref, partArgs } from './parser.js';
import { GeometryBuilder } from './geometry.js';

// Types whose ids are collected while indexing
export const INDEX_TYPES = [
    'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM',
    'SHAPE_DEFINITION_REPRESENTATION', 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION',
    'SHAPE_REPRESENTATION_RELATIONSHIP', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
    'SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
    'FACETED_BREP_SHAPE_REPRESENTATION', 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION',
    'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL',
    'COMPLEX',
];

// Factor angle unit -> radians (STEP files from CATIA and others use degrees).
// What counts is the unit assigned by the geometry context (GLOBAL_UNIT_ASSIGNED_CONTEXT) –
// not the first one in the file: CATIA e.g. first defines radians (#3) as base and on top of it degrees (#5)
// as CONVERSION_BASED_UNIT; with radians, CONICAL_SURFACE(…, 30.) became a cone with a 30 rad
// half angle (tan = −6.4) → completely wrong surface, ~100 000 triangles per cone.
export function angleFactor(step, typeIds) {
    const factorOf = e => {
        const conv = e.parts.CONVERSION_BASED_UNIT;
        if (!conv) return 1;
        const m = step.get(conv[1]);
        const val = m && m.args && m.args[0];
        const num = typeof val === 'number' ? val : (val && val.args ? val.args[0] : null);
        if (typeof num === 'number' && num > 0) return num;
        return /DEG/i.test(conv[0] || '') ? Math.PI / 180 : 1;
    };
    const complex = (typeIds.COMPLEX || []).map(id => step.get(id)).filter(e => e && e.parts);
    // 1. angle unit assigned by the context
    for (const e of complex) {
        const assigned = e.parts.GLOBAL_UNIT_ASSIGNED_CONTEXT;
        if (!assigned || !Array.isArray(assigned[0])) continue;
        for (const ref of assigned[0]) {
            const u = step.get(ref);
            if (u && u.parts && u.parts.PLANE_ANGLE_UNIT) return factorOf(u);
        }
    }
    // 2. fallback: converted unit (degrees) before plain SI radians, otherwise the first one
    const angles = complex.filter(e => e.parts.PLANE_ANGLE_UNIT);
    const conv = angles.find(e => e.parts.CONVERSION_BASED_UNIT);
    return conv ? factorOf(conv) : angles.length ? factorOf(angles[0]) : 1;
}

const SOLID_TYPES = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'CLOSED_SHELL', 'OPEN_SHELL']);

const PREDEFINED_COLOURS = {
    red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0],
    magenta: [1, 0, 1], cyan: [0, 1, 1], black: [0, 0, 0], white: [1, 1, 1],
};

// --- 4x4 matrices (column-major) ---
function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
}
// Inverse of a rigid transformation (rotation + translation)
function invRigid(m) {
    const o = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
    o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
    o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
    o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
    return o;
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function buildPlan(step, typeIds) {
    const geo = new GeometryBuilder(step);
    const angleUnit = angleFactor(step, typeIds);
    const ids = t => typeIds[t] || [];
    const refId = r => (r instanceof Ref ? r.id : null);

    // --- Colours ---
    const colorOf = new Map(); // item-ID -> [r,g,b]
    const colourValue = ref => {
        const c = step.get(ref);
        if (!c) return null;
        if (c.type === 'COLOUR_RGB') return [c.args[1], c.args[2], c.args[3]];
        if (c.type === 'DRAUGHTING_PRE_DEFINED_COLOUR') return PREDEFINED_COLOURS[c.args[0]] || null;
        return null;
    };
    const styleColour = (ref, depth = 0) => {
        if (depth > 8 || !ref) return null;
        const s = step.get(ref);
        if (!s) return null;
        switch (s.type) {
            case 'PRESENTATION_STYLE_ASSIGNMENT': case 'PRESENTATION_STYLE_BY_CONTEXT':
                for (const x of s.args[0]) { const c = styleColour(x, depth + 1); if (c) return c; }
                return null;
            case 'SURFACE_STYLE_USAGE': return styleColour(s.args[1], depth + 1);
            case 'SURFACE_SIDE_STYLE':
                for (const x of s.args[1]) { const c = styleColour(x, depth + 1); if (c) return c; }
                return null;
            case 'SURFACE_STYLE_FILL_AREA': return styleColour(s.args[0], depth + 1);
            case 'FILL_AREA_STYLE':
                for (const x of s.args[1]) { const c = styleColour(x, depth + 1); if (c) return c; }
                return null;
            case 'FILL_AREA_STYLE_COLOUR': return colourValue(s.args[1]);
            case 'SURFACE_STYLE_RENDERING': case 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES':
                return colourValue(s.args[1]);
        }
        return null;
    };
    for (const t of ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM']) {
        for (const id of ids(t)) {
            const e = step.get(id);
            const item = refId(e.args[2]);
            if (item === null) continue;
            let col = null;
            for (const st of e.args[1]) { col = styleColour(st); if (col) break; }
            if (col && (t === 'OVER_RIDING_STYLED_ITEM' || !colorOf.has(item))) colorOf.set(item, col);
        }
    }

    // --- Group representations (SRR = same level, union-find) ---
    const parent = new Map();
    const find = x => {
        while (parent.has(x) && parent.get(x) !== x) {
            const p = parent.get(x);
            parent.set(x, parent.get(p) ?? p);
            x = p;
        }
        return x;
    };
    const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
        if (!parent.has(ra)) parent.set(ra, ra);
    };
    const reps = new Set();
    const addRep = id => { if (id !== null && !parent.has(id)) parent.set(id, id); reps.add(id); };

    for (const t of ['SHAPE_REPRESENTATION', 'ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
        'FACETED_BREP_SHAPE_REPRESENTATION', 'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION']) {
        for (const id of ids(t)) addRep(id);
    }
    for (const id of ids('SHAPE_REPRESENTATION_RELATIONSHIP')) {
        const e = step.get(id);
        const a = refId(e.args[2]), b = refId(e.args[3]);
        if (a !== null && b !== null) { addRep(a); addRep(b); union(a, b); }
    }

    // --- Product definitions -> representations, names ---
    const pdReps = new Map();   // PD-ID -> [rep]
    const pdName = new Map();
    const productName = pd => {
        const e = step.get(pd);
        if (!e || !e.args) return '';
        const form = step.get(e.args[2]);
        const prod = form && form.args ? step.get(form.args[2]) : null;
        if (prod && prod.type === 'PRODUCT') return prod.args[1] || prod.args[0] || '';
        return e.args[0] || '';
    };
    for (const id of ids('SHAPE_DEFINITION_REPRESENTATION')) {
        const e = step.get(id);
        const pds = step.get(e.args[0]);
        const rep = refId(e.args[1]);
        if (!pds || rep === null) continue;
        // Only shape definitions of products. Creo and others attach additional representations
        // of the same solid to SHAPE_ASPECTs (validation properties) – those are not parts.
        if (pds.type !== 'PRODUCT_DEFINITION_SHAPE') continue;
        const def = refId(pds.args[2]);
        if (def === null) continue;
        const d = step.get(def);
        if (!d || !d.type.startsWith('PRODUCT_DEFINITION')) continue;
        addRep(rep);
        if (!pdReps.has(def)) pdReps.set(def, []);
        pdReps.get(def).push(rep);
        if (!pdName.has(def)) pdName.set(def, productName(def));
    }
    const groupName = new Map();
    for (const [pd, rs] of pdReps) for (const r of rs) {
        const g = find(r);
        if (!groupName.has(g)) groupName.set(g, pdName.get(pd));
    }

    // --- Assembly edges (CDSR) ---
    const children = new Map(); // group -> [{child, matrix, name}]
    const hasParent = new Set();
    const placementMatrix = ref => {
        const e = step.get(ref);
        if (!e) return IDENTITY;
        return geo.placement(ref).matrix();
    };
    const transformOf = (opRef, childIsRep1) => {
        const op = step.get(opRef);
        if (!op) return IDENTITY;
        if (op.type === 'ITEM_DEFINED_TRANSFORMATION') {
            const m1 = placementMatrix(op.args[2]), m2 = placementMatrix(op.args[3]);
            return childIsRep1 ? mul(m2, invRigid(m1)) : mul(m1, invRigid(m2));
        }
        if (op.type === 'CARTESIAN_TRANSFORMATION_OPERATOR_3D') {
            const m = placementMatrix(opRef);
            return childIsRep1 ? m : invRigid(m);
        }
        return IDENTITY;
    };
    for (const id of ids('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
        const e = step.get(id);
        const rel = step.get(e.args[0]);
        const rr = partArgs(rel, 'REPRESENTATION_RELATIONSHIP');
        if (!rr) continue;
        const rep1 = refId(rr[2]), rep2 = refId(rr[3]);
        if (rep1 === null || rep2 === null) continue;
        addRep(rep1); addRep(rep2);
        let childIsRep1 = true, name = '';
        const pds = step.get(e.args[1]);
        const nauo = pds ? step.get(pds.args[2]) : null;
        if (nauo && nauo.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
            const childPd = refId(nauo.args[4]);
            const cr = pdReps.get(childPd) || [];
            if (cr.some(r => find(r) === find(rep2))) childIsRep1 = false;
            name = nauo.args[1] || nauo.args[0] || '';
            if (!groupName.has(find(childIsRep1 ? rep1 : rep2))) groupName.set(find(childIsRep1 ? rep1 : rep2), productName(childPd));
        }
        const rrt = partArgs(rel, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
        const m = rrt ? transformOf(rrt[0], childIsRep1) : IDENTITY;
        const pg = find(childIsRep1 ? rep2 : rep1), cg = find(childIsRep1 ? rep1 : rep2);
        if (pg === cg) continue;
        if (!children.has(pg)) children.set(pg, []);
        children.get(pg).push({ child: cg, matrix: m, name });
        hasParent.add(cg);
    }

    // --- Items per group ---
    const groupItems = new Map();
    for (const r of reps) {
        const e = step.get(r);
        const items = e && e.args && Array.isArray(e.args[1]) ? e.args[1] : (partArgs(e, 'REPRESENTATION') || [])[1] || [];
        const g = find(r);
        if (!groupItems.has(g)) groupItems.set(g, []);
        for (const it of items) if (it instanceof Ref) groupItems.get(g).push(it.id);
    }

    // --- Solids ---
    const solids = [];
    const solidIndex = new Map();
    // Faces of a shell. Reversed faces are returned as negative ids: voids
    // (ORIENTED_CLOSED_SHELL with orientation=.F. in BREP_WITH_VOIDS) and ORIENTED_FACE with .F.
    const faceRef = (ref, flip) => {
        let e = step.get(ref);
        let id = refId(ref);
        // ORIENTED_FACE('', *, face_element, orientation)
        while (e && e.type === 'ORIENTED_FACE') {
            if (e.args[3] === false) flip = !flip;
            id = refId(e.args[2]);
            e = step.get(e.args[2]);
        }
        if (id === null) return null;
        return flip ? -id : id;
    };
    const shellFaces = (shellRef, flip = false) => {
        const s = step.get(shellRef);
        if (!s) return [];
        if (s.type === 'CLOSED_SHELL' || s.type === 'OPEN_SHELL') return s.args[1].map(r => faceRef(r, flip));
        // ORIENTED_*_SHELL('', *, shell_element, orientation)
        if (s.type === 'ORIENTED_CLOSED_SHELL' || s.type === 'ORIENTED_OPEN_SHELL') {
            return shellFaces(s.args[2], s.args[3] === false ? !flip : flip);
        }
        return [];
    };
    const solidFaces = e => {
        switch (e.type) {
            case 'MANIFOLD_SOLID_BREP': case 'FACETED_BREP': return shellFaces(e.args[1]);
            case 'BREP_WITH_VOIDS': return [...shellFaces(e.args[1]), ...e.args[2].flatMap(v => shellFaces(v))];
            case 'SHELL_BASED_SURFACE_MODEL': return e.args[1].flatMap(v => shellFaces(v));
            case 'CLOSED_SHELL': case 'OPEN_SHELL': return shellFaces(e.id);
        }
        return [];
    };
    const getSolid = id => {
        if (solidIndex.has(id)) return solidIndex.get(id);
        const e = step.get(id);
        const faces = solidFaces(e).filter(f => f !== null);
        // colours: face > shell > solid
        let shellColor = null;
        if (e.type === 'MANIFOLD_SOLID_BREP' || e.type === 'FACETED_BREP') shellColor = colorOf.get(refId(e.args[1])) || null;
        const solidColor = colorOf.get(id) || shellColor;
        const faceColors = faces.map(f => colorOf.get(Math.abs(f)) || null);
        const idx = solids.length;
        // surface: sheet body without a defined inside (orientFaces turns its skins outward)
        const surface = e.type === 'SHELL_BASED_SURFACE_MODEL' || e.type === 'OPEN_SHELL';
        solids.push({ id, name: e.args[0] || '', faces, faceColors, color: solidColor, size: solidSize(step, geo, faces), surface });
        solidIndex.set(id, idx);
        return idx;
    };

    // --- Instances + object tree by traversal ---
    // nodes: [{ name, parent }] – assemblies/parts (parent = index, -1 = root).
    // Every instance references its node via "node". If a node contains several solids,
    // each solid gets its own child node (individually toggleable).
    const instances = [];
    const nodes = [];
    // autoName: default name that the main thread translates (workers have no i18n), e.g. ['solid', 2] or ['model']
    const addNode = (name, parent, autoName) => { nodes.push(name || !autoName ? { name: name || '', parent } : { name: '', parent, autoName }); return nodes.length - 1; };
    const visitContent = (g, matrix, depth, node, gname, solidsOut) => {
        if (depth > 32) return;
        for (const it of groupItems.get(g) || []) {
            const e = step.get(it);
            if (!e) continue;
            if (SOLID_TYPES.has(e.type)) {
                solidsOut.push({ solid: getSolid(it), matrix });
            } else if (e.type === 'MAPPED_ITEM') {
                const map = step.get(e.args[1]);
                if (!map || map.type !== 'REPRESENTATION_MAP') continue;
                const origin = placementMatrix(map.args[0]);
                const target = placementMatrix(e.args[2]);
                const sub = find(refId(map.args[1]));
                visitContent(sub, mul(matrix, mul(target, invRigid(origin))), depth + 1, node, gname, solidsOut);
            }
        }
        for (const c of children.get(g) || []) {
            visitGroup(c.child, mul(matrix, c.matrix), groupName.get(c.child) || c.name || gname, depth + 1, node);
        }
    };
    const visitGroup = (g, matrix, label, depth, parent) => {
        if (depth > 32) return;
        const node = addNode(label, parent);
        const own = [];
        visitContent(g, matrix, depth, node, label, own);
        own.forEach(({ solid, matrix: m }, i) => {
            const sname = solids[solid].name;
            const n = own.length > 1 ? addNode(sname, node, ['solid', i + 1]) : node;
            instances.push({ solid, matrix: m, name: sname || label, color: solids[solid].color, node: n });
        });
    };
    // Roots: groups without parents that belong to a product definition. Representations
    // without a product (e.g. at SHAPE_ASPECTs) would otherwise appear as unplaced copies.
    // Only if the file has no product structure at all are all groups taken.
    const productGroups = new Set();
    for (const rs of pdReps.values()) for (const r of rs) productGroups.add(find(r));
    const groups = new Set([...reps].map(find));
    const roots = [...groups].filter(g => !hasParent.has(g) && (productGroups.size === 0 || productGroups.has(g)));
    for (const g of roots) visitGroup(g, IDENTITY, groupName.get(g) || '', 0, -1);

    // Fallback: solids not assigned to any representation
    if (instances.length === 0) {
        const root = addNode('', -1, ['model']);
        for (const t of ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL']) {
            for (const id of ids(t)) {
                const si = getSolid(id);
                const n = addNode(solids[si].name, root, ['solid', si + 1]);
                instances.push({ solid: si, matrix: IDENTITY, name: solids[si].name, color: solids[si].color, node: n });
            }
        }
    }

    return { solids, instances, nodes, angleUnit };
}

// Rough size of a solid (diagonal of the vertex bounding box) for the relative tolerance
function solidSize(step, geo, faces) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const seen = new Set();
    for (const fid of faces) {
        const f = step.get(Math.abs(fid));
        if (!f || !f.args) continue;
        for (const bRef of f.args[1] || []) {
            const b = step.get(bRef);
            const loop = b && step.get(b.args[1]);
            if (!loop) continue;
            if (loop.type === 'POLY_LOOP') {
                for (const r of loop.args[1]) ext(geo.point(r));
                continue;
            }
            if (loop.type !== 'EDGE_LOOP') continue;
            for (const oeRef of loop.args[1]) {
                const oe = step.get(oeRef);
                const ec = oe && step.get(oe.args[3]);
                if (!ec || ec.type !== 'EDGE_CURVE') continue;
                for (const v of [ec.args[1], ec.args[2]]) {
                    if (seen.has(v.id)) continue;
                    seen.add(v.id);
                    ext(geo.point(v));
                }
                // Circles: vertices alone underestimate the size (e.g. full circle with 1 vertex).
                // Only consider the arc actually used – CATIA e.g. writes tori with a
                // 200 m radius ("homeo Torus") whose edges are tiny arcs of huge circles;
                // the full circle made the solid 1 km large (-> far too coarse tessellation).
                const c = step.get(ec.args[3]);
                if (c && c.type === 'CIRCLE') {
                    if (ec.args[1].id === ec.args[2].id) {
                        const p = geo.placement(c.args[1]).o, r = c.args[2];
                        ext([p[0] - r, p[1] - r, p[2] - r]); ext([p[0] + r, p[1] + r, p[2] + r]);
                    } else {
                        const curve = geo.curve(ec.args[3]);
                        let t0 = curve.closest(geo.point(ec.args[1])), t1 = curve.closest(geo.point(ec.args[2]));
                        if (ec.args[4] === false) [t0, t1] = [t1, t0];   // edge runs against the curve direction
                        if (t1 < t0) t1 += 2 * Math.PI;
                        for (let k = 1; k < 8; k++) ext(curve.eval(t0 + (t1 - t0) * k / 8));
                    }
                }
            }
        }
    }
    function ext(p) {
        for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
    }
    if (!isFinite(mn[0])) return 1;
    return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
}
