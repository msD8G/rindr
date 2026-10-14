// IFC (BIM) in a worker: web-ifc (WebAssembly) parses the file and builds the geometry (extrusions, booleans,
// breps …). The model stays open for property lookups (properties panel) until the worker is terminated.
//
// Messages: { id, type: 'open', buffer } → { nodes, geometries, meshes, styles, stats }
//           { id, type: 'props', expressID } → { sections: [{ title, rows: [[key, value]] }] }
// Geometry comes in metres with y up (web-ifc), placed geometries carry a column-major matrix.
import * as WebIFC from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

let api = null, modelID = -1, ready = null;
const init = () => (ready ??= (async () => {
    api = new WebIFC.IfcAPI();
    await api.Init(path => (path.endsWith('.wasm') ? wasmUrl : path), true);
    api.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_OFF);
})());

self.onmessage = async ({ data: msg }) => {
    try {
        await init();
        if (msg.type === 'open') {
            const result = open(msg.buffer);
            const transfer = result.geometries.flatMap(g => [g.positions.buffer, g.normals.buffer, g.index.buffer]);
            self.postMessage({ id: msg.id, result }, transfer);
        } else if (msg.type === 'props') {
            self.postMessage({ id: msg.id, result: await properties(msg.expressID) });
        }
    } catch (err) {
        self.postMessage({ id: msg.id, error: err?.message || String(err) });
    }
};

// IFC strings: \X\hh (ISO 8859-1), \X2\hhhh…\X0\ (UCS-2), \X4\…\X0\ (UCS-4), \S\c (upper half) – Revit
// writes umlauts like this ("Oberfl\X\E4che")
export function decodeIfc(s) {
    if (typeof s !== 'string' || !s.includes('\\')) return s;
    return s
        .replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/gi, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map(x => parseInt(x, 16))))
        .replace(/\\X4\\((?:[0-9A-F]{8})+)\\X0\\/gi, (_, h) => String.fromCodePoint(...h.match(/.{8}/g).map(x => parseInt(x, 16))))
        .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
}
const value = v => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const text = v => { const s = value(v); return s == null || s === '' ? null : decodeIfc(String(s)); };
// class in capitals (web-ifc: "IfcWallStandardCase") – the keys below and in the i18n files
const typeName = id => api.GetNameFromTypeCode(api.GetLineType(modelID, id)).toUpperCase();

function open(buffer) {
    if (modelID >= 0) api.CloseModel(modelID);
    const t0 = performance.now();
    // to the origin: georeferenced models lie kilometres away (float precision); CIRCLE_SEGMENTS: rounder columns/pipes
    modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 24 });
    const schema = api.GetModelSchema(modelID);

    // names for the colours: style of the representation item (Revit names them after the material) …
    const styleOf = new Map();
    const styled = api.GetLineIDsWithType(modelID, WebIFC.IFCSTYLEDITEM);
    for (let i = 0; i < styled.size(); i++) {
        const si = api.GetLine(modelID, styled.get(i));
        const item = value(si.Item);
        if (!item) continue;
        const name = styleName(si.Styles);
        if (name) styleOf.set(item, name);
    }
    // … otherwise the material of the element
    const materialOf = elementMaterials();

    // geometry, element by element
    const geometries = [], geometryIndex = new Map(), meshes = [], styles = [], styleIndex = new Map();
    const elements = new Map();   // expressID → [mesh indices]
    let triangles = 0;
    api.StreamAllMeshes(modelID, flat => {
        const element = flat.expressID;
        const list = [];
        const placed = flat.geometries;
        for (let i = 0; i < placed.size(); i++) {
            const pg = placed.get(i);
            let gi = geometryIndex.get(pg.geometryExpressID);
            if (gi === undefined) {
                const g = api.GetGeometry(modelID, pg.geometryExpressID);
                const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
                const index = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize()).slice();   // copy out of wasm memory
                g.delete();
                const n = v.length / 6;
                if (!n || !index.length) { geometryIndex.set(pg.geometryExpressID, -1); continue; }
                const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
                for (let k = 0; k < n; k++) {
                    positions[k * 3] = v[k * 6]; positions[k * 3 + 1] = v[k * 6 + 1]; positions[k * 3 + 2] = v[k * 6 + 2];
                    normals[k * 3] = v[k * 6 + 3]; normals[k * 3 + 1] = v[k * 6 + 4]; normals[k * 3 + 2] = v[k * 6 + 5];
                }
                gi = geometries.length;
                geometries.push({ positions, normals, index });
                geometryIndex.set(pg.geometryExpressID, gi);
            }
            if (gi < 0) continue;
            triangles += geometries[gi].index.length / 3;
            const c = pg.color;
            const color = [c.x, c.y, c.z, c.w];
            const name = styleOf.get(pg.geometryExpressID) || materialOf.get(element) || null;
            const key = `${name ?? ''}|${color.map(x => x.toFixed(3)).join(',')}`;
            let si = styleIndex.get(key);
            if (si === undefined) {
                si = styles.length;
                styles.push({ key, name, color });
                styleIndex.set(key, si);
            }
            list.push(meshes.length);
            meshes.push({ geometry: gi, matrix: Array.from(pg.flatTransformation), style: si, element, part: i });
        }
        if (list.length) elements.set(element, list);
    });

    const nodes = buildNodes(elements, meshes);
    // shift to the origin (metres, output frame): output = shift + N·p with N = z up → y up ((x, y, z) → (x, z, −y));
    // aligns several IFC files of one project and maps BCF viewpoints (IFC world coordinates)
    const coordination = api.GetCoordinationMatrix(modelID);
    const projects = api.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
    const projectLine = projects.size() ? api.GetLine(modelID, projects.get(0)) : null;
    return {
        nodes, geometries, meshes, styles,
        origin: [coordination[12], coordination[13], coordination[14]],
        project: projectLine ? { guid: text(projectLine.GlobalId), name: text(projectLine.LongName) || text(projectLine.Name) } : null,
        stats: { schema, elements: elements.size, triangles, ms: Math.round(performance.now() - t0) },
    };
}

// name of the first surface style (IFC2x3: via IfcPresentationStyleAssignment); Revit's placeholder
// "<Unnamed>" counts as none (→ material of the element)
const named = s => (s && !/^<.*>$/.test(s) ? s : null);
function styleName(styles) {
    for (const s of styles || []) {
        const line = api.GetLine(modelID, value(s));
        if (!line) continue;
        if (named(text(line.Name))) return named(text(line.Name));
        for (const inner of line.Styles || []) {
            const st = api.GetLine(modelID, value(inner));
            if (named(text(st?.Name))) return named(text(st.Name));
        }
    }
    return null;
}

// element → name of its (first) material (IfcRelAssociatesMaterial: material, layer set, list, constituents …)
function elementMaterials() {
    const map = new Map();
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELASSOCIATESMATERIAL);
    const cache = new Map();
    for (let i = 0; i < rels.size(); i++) {
        const rel = api.GetLine(modelID, rels.get(i));
        const ref = value(rel.RelatingMaterial);
        if (!cache.has(ref)) cache.set(ref, materialName(ref, 0));
        const name = cache.get(ref);
        if (name) for (const o of rel.RelatedObjects || []) map.set(value(o), name);
    }
    return map;
}
function materialName(id, depth) {
    if (!id || depth > 4) return null;
    const line = api.GetLine(modelID, id);
    if (!line) return null;
    const first = list => (list?.length ? materialName(value(list[0]), depth + 1) : null);
    switch (typeName(id)) {
        case 'IFCMATERIAL': return text(line.Name);
        case 'IFCMATERIALLAYERSETUSAGE': return materialName(value(line.ForLayerSet), depth + 1);
        case 'IFCMATERIALLAYERSET': return first(line.MaterialLayers) || text(line.LayerSetName);
        case 'IFCMATERIALLAYER': return materialName(value(line.Material), depth + 1);
        case 'IFCMATERIALLIST': return first(line.Materials);
        case 'IFCMATERIALCONSTITUENTSET': return text(line.Name) || first(line.MaterialConstituents);
        case 'IFCMATERIALCONSTITUENT': return materialName(value(line.Material), depth + 1);
        case 'IFCMATERIALPROFILESETUSAGE': return materialName(value(line.ForProfileSet), depth + 1);
        case 'IFCMATERIALPROFILESET': return text(line.Name) || first(line.MaterialProfiles);
        case 'IFCMATERIALPROFILE': return materialName(value(line.Material), depth + 1);
        default: return null;
    }
}

// --- tree: project → site → building → storey → (class group) → element ---
// Containers without geometry below are dropped (spaces without furniture, grids); project/site with a single
// child are skipped; inside a container the elements are grouped by class (walls, doors …), storeys sorted by
// elevation. Elements with geometry missing from the spatial tree end up at the top.
const CLASS_GROUPS = { IFCWALLSTANDARDCASE: 'IFCWALL', IFCWALLELEMENTEDCASE: 'IFCWALL', IFCSLABSTANDARDCASE: 'IFCSLAB', IFCSLABELEMENTEDCASE: 'IFCSLAB',
    IFCBEAMSTANDARDCASE: 'IFCBEAM', IFCCOLUMNSTANDARDCASE: 'IFCCOLUMN', IFCDOORSTANDARDCASE: 'IFCDOOR', IFCWINDOWSTANDARDCASE: 'IFCWINDOW',
    IFCMEMBERSTANDARDCASE: 'IFCMEMBER', IFCPLATESTANDARDCASE: 'IFCPLATE', IFCOPENINGSTANDARDCASE: 'IFCOPENINGELEMENT' };
const SPATIAL = new Set(['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCROAD', 'IFCRAILWAY', 'IFCMARINEFACILITY']);

function buildNodes(elements, meshes) {
    const structure = spatialTree();
    const used = new Set();
    // has geometry in its subtree?
    const solid = n => (n.has ??= elements.has(n.id) || n.children.some(solid));
    const nodes = [];
    const add = (name, parent, ifc) => {
        if (ifc.id) ifc.guid = text(api.GetLine(modelID, ifc.id)?.GlobalId);   // BCF refers to elements by GlobalId
        nodes.push({ name, parent, ifc });
        return nodes.length - 1;
    };
    const attach = (id, node) => { for (const mi of elements.get(id) || []) meshes[mi].node = node; used.add(id); };
    const visit = (n, parent) => {
        if (!solid(n)) return;
        const type = typeName(n.id);
        const spatial = SPATIAL.has(type);
        // skip project/site with only one child and no own geometry
        const kids = n.children.filter(solid);
        if ((type === 'IFCPROJECT' || type === 'IFCSITE') && kids.length === 1 && !elements.has(n.id)) return visit(kids[0], parent);
        const node = add(nodeName(n.id, type), parent, { id: n.id, type, spatial });
        attach(n.id, node);
        if (!spatial) { for (const c of kids) visit(c, node); return; }
        // containers: sub-containers first (storeys by elevation), then elements grouped by class
        const containers = kids.filter(c => SPATIAL.has(typeName(c.id)));
        containers.sort((a, b) => (elevation(a.id) - elevation(b.id)) || 0);
        for (const c of containers) visit(c, node);
        const byClass = new Map();
        for (const c of kids) {
            if (containers.includes(c)) continue;
            const t = typeName(c.id), cls = CLASS_GROUPS[t] || t;
            if (!byClass.has(cls)) byClass.set(cls, []);
            byClass.get(cls).push(c);
        }
        for (const [cls, list] of [...byClass].sort((a, b) => a[0].localeCompare(b[0]))) {
            const group = add(null, node, { type: cls, group: true, count: list.length });
            list.sort((a, b) => nodeName(a.id).localeCompare(nodeName(b.id), undefined, { numeric: true }));
            for (const c of list) visit(c, group);
        }
    };
    visit(structure, -1);
    // elements outside the spatial structure
    const rest = [...elements.keys()].filter(id => !used.has(id));
    if (rest.length) {
        const group = add(null, -1, { type: 'UNASSIGNED', group: true, count: rest.length });
        for (const id of rest) attach(id, add(nodeName(id), group, { id, type: typeName(id), spatial: false }));
    }
    return nodes;
}

// spatial structure (IfcRelAggregates + IfcRelContainedInSpatialStructure) as { id, children }
function spatialTree() {
    const children = new Map();
    const link = (parent, child) => { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(child); };
    for (const [type, from, to] of [[WebIFC.IFCRELAGGREGATES, 'RelatingObject', 'RelatedObjects'], [WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE, 'RelatingStructure', 'RelatedElements']]) {
        const rels = api.GetLineIDsWithType(modelID, type);
        for (let i = 0; i < rels.size(); i++) {
            const rel = api.GetLine(modelID, rels.get(i));
            for (const c of rel[to] || []) link(value(rel[from]), value(c));
        }
    }
    const projects = api.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
    const seen = new Set();
    const make = id => {
        seen.add(id);
        return { id, children: (children.get(id) || []).filter(c => !seen.has(c)).map(make) };
    };
    return make(projects.size() ? projects.get(0) : 0);
}

const nameCache = new Map();
function nodeName(id, type = typeName(id)) {
    if (nameCache.has(id)) return nameCache.get(id);
    const line = api.GetLine(modelID, id);
    let name = text(line?.Name);
    // Revit appends the element id ("Basiswand:AW1 25.0:12618181") – shown in the properties anyway
    if (name && !SPATIAL.has(type)) name = name.replace(/:\d{4,}$/, '');
    if (type === 'IFCSPACE' && text(line?.LongName)) name = [name, text(line.LongName)].filter(Boolean).join(' ');
    nameCache.set(id, name || null);
    return name || null;
}
const elevation = id => Number(value(api.GetLine(modelID, id)?.Elevation)) || 0;

// --- properties of one element (properties panel) ---
async function properties(id) {
    const line = api.GetLine(modelID, id);
    if (!line) return { sections: [] };
    const general = [['class', api.GetNameFromTypeCode(line.type)]];
    for (const key of ['Name', 'LongName', 'GlobalId', 'Description', 'ObjectType', 'Tag', 'PredefinedType', 'Elevation']) {
        const v = text(line[key]);
        if (v != null) general.push([key, v]);
    }
    const sections = [{ id: 'general', rows: general }];
    const materials = [];
    try {
        for (const m of await api.properties.getMaterialsProperties(modelID, id, true, true)) collectMaterials(m, materials);
    } catch { /* no materials */ }
    if (materials.length) sections.push({ id: 'material', rows: [...new Set(materials)].map(m => [null, m]) });
    let sets = [];
    try { sets = await api.properties.getPropertySets(modelID, id, true, true); } catch { /* none */ }
    for (const set of sets) {
        const rows = [];
        for (const p of set.HasProperties || set.Quantities || []) {
            const v = propertyValue(p);
            if (v != null) rows.push([text(p.Name) || '?', v]);
        }
        if (rows.length) sections.push({ title: text(set.Name) || '?', quantities: !!set.Quantities, rows });
    }
    return { sections };
}
function collectMaterials(m, out, depth = 0) {
    if (!m || depth > 5) return;
    if (Array.isArray(m)) { for (const x of m) collectMaterials(x, out, depth + 1); return; }
    if (typeof m !== 'object') return;
    const t = m.type != null ? api.GetNameFromTypeCode(m.type).toUpperCase() : '';
    if (t === 'IFCMATERIAL' && text(m.Name)) {
        out.push(text(m.Name));
        return;
    }
    if (t === 'IFCMATERIALLAYER' && m.Material) {
        const thickness = Number(value(m.LayerThickness));
        const before = out.length;
        collectMaterials(m.Material, out, depth + 1);
        if (out.length > before && thickness) out[out.length - 1] += ` (${+thickness.toFixed(4)})`;
        return;
    }
    for (const [k, v] of Object.entries(m)) if (k !== 'type' && v && typeof v === 'object') collectMaterials(v, out, depth + 1);
}
// single value, enumeration, list, bounded, quantities (length, area, volume, count, weight, time)
function propertyValue(p) {
    const fmt = v => {
        if (v == null) return null;
        if (typeof v === 'object' && 'value' in v) {
            if (v.name === 'IFCBOOLEAN' || v.name === 'IFCLOGICAL') return v.value === 'T' || v.value === true ? '✓' : v.value === 'F' || v.value === false ? '✗' : '?';
            return fmt(v.value);
        }
        if (typeof v === 'number') return +v.toPrecision(6);
        return decodeIfc(String(v));
    };
    if (p.NominalValue !== undefined) return fmt(p.NominalValue);
    if (p.EnumerationValues) return p.EnumerationValues.map(fmt).join(', ');
    if (p.ListValues) return p.ListValues.map(fmt).join(', ');
    if (p.UpperBoundValue || p.LowerBoundValue) return [fmt(p.LowerBoundValue), fmt(p.UpperBoundValue)].filter(x => x != null).join(' – ');
    for (const [key, unit] of [['LengthValue', 'm'], ['AreaValue', 'm²'], ['VolumeValue', 'm³'], ['CountValue', ''], ['WeightValue', 'kg'], ['TimeValue', 's']]) {
        if (p[key] !== undefined && p[key] !== null) return `${fmt(p[key])}${unit ? ' ' + unit : ''}`;
    }
    return null;
}
