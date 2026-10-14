// BCF (BIM Collaboration Format, buildingSMART): issues ("topics") about IFC models, exchanged as .bcfzip –
// per topic a folder with markup.bcf (title, status, comments …), viewpoints (.bcfv: camera, selected/hidden/
// coloured components by IFC GlobalId, clipping planes) and snapshots (PNG).
// Read: BCF 2.0, 2.1 and 3.0 (lenient – element names per version). Written: BCF 2.1 (read by Revit, ArchiCAD,
// Solibri, BIMcollab, Navisworks …), unknown parts of the source are not kept.
// Coordinates stay as in the file: IFC world coordinates in metres, z up (the viewer maps them).
// RINDR keeps its scene (materials, lights, camera, models …) as an extra file in the zip root (SCENE_FILE) –
// other BCF tools only read bcf.version, project.bcfp and the topic folders and ignore it.
import { readZip } from '../splat/splat-formats.js';
import { crc32 } from '../png-encode.js';

export const SCENE_FILE = 'rindr.scene.json';

// --- reading ---

/** @returns {Promise<{ version: string, project: { id, name } | null, topics: object[] }>} */
export async function readBcf(buffer) {
    const zip = readZip(buffer, { paths: true });
    const files = new Map([...zip.keys()].map(name => [name.replace(/\\/g, '/'), name]));
    const read = async name => (files.has(name) ? zip.get(files.get(name))() : null);
    const text = async name => { const d = await read(name); return d ? new TextDecoder().decode(d) : null; };
    const xml = async name => { const s = await text(name); return s ? new DOMParser().parseFromString(s, 'application/xml') : null; };

    const versionDoc = await xml('bcf.version');
    const version = versionDoc?.documentElement?.getAttribute('VersionId') || '2.0';
    const projectDoc = await xml('project.bcfp');
    const projectEl = projectDoc && find(projectDoc, 'Project');
    const project = projectEl ? { id: projectEl.getAttribute('ProjectId') || '', name: childText(projectEl, 'Name') || '' } : null;

    const topics = [];
    for (const path of files.keys()) {
        const m = path.match(/^([^/]+)\/markup\.bcf$/i);
        if (!m) continue;
        const folder = m[1];
        const doc = await xml(path);
        const topicEl = doc && find(doc, 'Topic');
        if (!topicEl) continue;
        const topic = parseTopic(doc, topicEl);
        topic.guid ||= folder;
        // viewpoints: 2.x <Viewpoints Guid><Viewpoint>file</Viewpoint><Snapshot>…; 3.0 <Viewpoints><ViewPoint Guid>…
        const vpEls = [...doc.getElementsByTagName('Viewpoints'), ...doc.getElementsByTagName('ViewPoint')].filter(e => e.getAttribute('Guid'));
        for (const el of vpEls) {
            const guid = el.getAttribute('Guid');
            const file = childText(el, 'Viewpoint');
            const snapshotFile = childText(el, 'Snapshot');
            const vDoc = file ? await xml(`${folder}/${file}`) : null;
            const snap = snapshotFile ? await read(`${folder}/${snapshotFile}`) : null;
            topic.viewpoints.push({
                guid, index: num(childText(el, 'Index')),
                ...(vDoc ? parseViewpoint(vDoc) : emptyViewpoint()),
                snapshot: snap ? new Blob([snap], { type: /\.jpe?g$/i.test(snapshotFile) ? 'image/jpeg' : 'image/png' }) : null,
            });
        }
        // BCF 2.0: one viewpoint per topic without entry in the markup ("viewpoint.bcfv" + "snapshot.png")
        if (!topic.viewpoints.length && files.has(`${folder}/viewpoint.bcfv`)) {
            const vDoc = await xml(`${folder}/viewpoint.bcfv`);
            const snap = await read(`${folder}/snapshot.png`);
            topic.viewpoints.push({ guid: uuid(), index: null, ...parseViewpoint(vDoc), snapshot: snap ? new Blob([snap], { type: 'image/png' }) : null });
        }
        topic.viewpoints.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        topics.push(topic);
    }
    topics.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || (a.creationDate || '').localeCompare(b.creationDate || ''));
    return { version, project, topics, scene: await text(SCENE_FILE) };
}

function parseTopic(doc, el) {
    // labels: 2.x repeated <Labels>, 3.0 <Labels><Label>
    const labels = [...el.getElementsByTagName('Label'), ...[...el.getElementsByTagName('Labels')].filter(l => !l.getElementsByTagName('Label').length)]
        .map(l => l.textContent.trim()).filter(Boolean);
    const header = [...doc.getElementsByTagName('File')].map(f => ({
        ifcProject: f.getAttribute('IfcProject') || '', ifcSpatial: f.getAttribute('IfcSpatialStructureElement') || '',
        filename: childText(f, 'Filename') || '', date: childText(f, 'Date') || '', reference: childText(f, 'Reference') || '',
    }));
    // comments: 2.x directly in <Markup>, 3.0 in <Topic><Comments>; the text is the inner <Comment>
    const comments = [...doc.getElementsByTagName('Comment')].filter(c => c.getAttribute('Guid')).map(c => ({
        guid: c.getAttribute('Guid'),
        date: childText(c, 'Date') || '',
        author: childText(c, 'Author') || '',
        text: childText(c, 'Comment') || '',
        viewpoint: c.getElementsByTagName('Viewpoint')[0]?.getAttribute('Guid') || null,
        modifiedDate: childText(c, 'ModifiedDate') || '',
        modifiedAuthor: childText(c, 'ModifiedAuthor') || '',
    })).sort((a, b) => a.date.localeCompare(b.date));
    return {
        guid: el.getAttribute('Guid') || '',
        type: el.getAttribute('TopicType') || '',
        status: el.getAttribute('TopicStatus') || '',
        title: childText(el, 'Title') || '',
        priority: childText(el, 'Priority') || '',
        index: num(childText(el, 'Index')),
        labels,
        creationDate: childText(el, 'CreationDate') || '',
        creationAuthor: childText(el, 'CreationAuthor') || '',
        modifiedDate: childText(el, 'ModifiedDate') || '',
        modifiedAuthor: childText(el, 'ModifiedAuthor') || '',
        dueDate: childText(el, 'DueDate') || '',
        assignedTo: childText(el, 'AssignedTo') || '',
        stage: childText(el, 'Stage') || '',
        description: childText(el, 'Description') || '',
        header,
        comments,
        viewpoints: [],
    };
}

const emptyViewpoint = () => ({ camera: null, selection: [], visibility: { defaultVisible: true, exceptions: [] }, coloring: [], clipping: [] });

function parseViewpoint(doc) {
    const vp = emptyViewpoint();
    const root = doc.documentElement;
    const comps = el => [...el.getElementsByTagName('Component')].map(c => c.getAttribute('IfcGuid')).filter(Boolean);
    const components = find(root, 'Components');
    if (components) {
        const selection = find(components, 'Selection');
        const visibility = find(components, 'Visibility');
        if (selection || visibility) {   // 2.1 / 3.0
            if (selection) vp.selection = comps(selection);
            if (visibility) {
                vp.visibility.defaultVisible = visibility.getAttribute('DefaultVisibility') !== 'false';
                const exceptions = find(visibility, 'Exceptions');
                vp.visibility.exceptions = exceptions ? comps(exceptions) : [];
            }
            for (const color of components.getElementsByTagName('Color')) vp.coloring.push({ color: color.getAttribute('Color') || '', guids: comps(color) });
        } else {   // 2.0: flat list with Selected / Visible / Color attributes
            for (const c of components.getElementsByTagName('Component')) {
                const guid = c.getAttribute('IfcGuid');
                if (!guid) continue;
                if (c.getAttribute('Selected') === 'true') vp.selection.push(guid);
                if (c.getAttribute('Visible') === 'false') vp.visibility.exceptions.push(guid);
                const color = c.getAttribute('Color');
                if (color) vp.coloring.push({ color, guids: [guid] });
            }
        }
    }
    const vec = (el, name) => { const v = find(el, name); return v ? ['X', 'Y', 'Z'].map(k => num(childText(v, k)) ?? 0) : null; };
    const persp = find(root, 'PerspectiveCamera'), ortho = find(root, 'OrthogonalCamera');
    const cam = persp || ortho;
    if (cam) {
        vp.camera = {
            type: persp ? 'perspective' : 'orthogonal',
            position: vec(cam, 'CameraViewPoint'), direction: vec(cam, 'CameraDirection'), up: vec(cam, 'CameraUpVector'),
            fov: persp ? num(childText(cam, 'FieldOfView')) ?? 60 : null,
            scale: ortho ? num(childText(cam, 'ViewToWorldScale')) ?? 10 : null,
        };
        if (!vp.camera.position || !vp.camera.direction) vp.camera = null;
    }
    for (const plane of root.getElementsByTagName('ClippingPlane')) {
        const location = vec(plane, 'Location'), direction = vec(plane, 'Direction');
        if (location && direction) vp.clipping.push({ location, direction });
    }
    return vp;
}

// first descendant with this local name (namespaces vary between exporters)
function find(node, name) {
    const list = node.getElementsByTagName(name);
    return list.length ? list[0] : null;
}
// text of a direct child
function childText(el, name) {
    for (const c of el.children) if (c.localName === name) return c.textContent.trim();
    return null;
}
const num = s => (s == null || s === '' || !Number.isFinite(Number(s)) ? null : Number(s));

export function uuid() {
    return crypto.randomUUID ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
}

// --- writing (BCF 2.1) ---

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name, value) => (value === null || value === undefined || value === '' ? '' : `<${name}>${esc(value)}</${name}>`);
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** @returns {Promise<Blob>} the .bcfzip; scene: RINDR scene state (JSON text) stored as SCENE_FILE */
export async function writeBcf({ project, topics }, { scene = null } = {}) {
    const entries = [];
    const add = (name, data) => entries.push({ name, data: typeof data === 'string' ? new TextEncoder().encode(data) : data });
    if (scene) add(SCENE_FILE, scene);
    add('bcf.version', `${XML}<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>`);
    if (project) add('project.bcfp', `${XML}<ProjectExtension><Project ProjectId="${esc(project.id || uuid())}">${tag('Name', project.name)}</Project><ExtensionSchema></ExtensionSchema></ProjectExtension>`);
    for (const topic of topics) {
        const dir = topic.guid;
        const viewpoints = [];
        for (const [i, vp] of topic.viewpoints.entries()) {
            const file = i === 0 ? 'viewpoint.bcfv' : `viewpoint-${vp.guid}.bcfv`;
            const snapshot = vp.snapshot ? (i === 0 ? 'snapshot.png' : `snapshot-${vp.guid}.png`) : null;
            add(`${dir}/${file}`, viewpointXml(vp));
            if (snapshot) add(`${dir}/${snapshot}`, new Uint8Array(await vp.snapshot.arrayBuffer()));
            viewpoints.push(`<Viewpoints Guid="${esc(vp.guid)}">${tag('Viewpoint', file)}${tag('Snapshot', snapshot)}${tag('Index', i)}</Viewpoints>`);
        }
        add(`${dir}/markup.bcf`, markupXml(topic, viewpoints));
    }
    return new Blob([zipStore(entries)], { type: 'application/zip' });
}

function markupXml(t, viewpoints) {
    const header = t.header?.length
        ? `<Header>${t.header.map(f => `<File${f.ifcProject ? ` IfcProject="${esc(f.ifcProject)}"` : ''}${f.ifcSpatial ? ` IfcSpatialStructureElement="${esc(f.ifcSpatial)}"` : ''} isExternal="true">${tag('Filename', f.filename)}${tag('Date', f.date)}${tag('Reference', f.reference)}</File>`).join('')}</Header>`
        : '';
    const topic = `<Topic Guid="${esc(t.guid)}"${t.type ? ` TopicType="${esc(t.type)}"` : ''}${t.status ? ` TopicStatus="${esc(t.status)}"` : ''}>`
        + tag('Title', t.title || '-') + tag('Priority', t.priority) + tag('Index', t.index)
        + t.labels.map(l => tag('Labels', l)).join('')
        + tag('CreationDate', t.creationDate) + tag('CreationAuthor', t.creationAuthor || '-')
        + tag('ModifiedDate', t.modifiedDate) + tag('ModifiedAuthor', t.modifiedAuthor)
        + tag('DueDate', t.dueDate) + tag('AssignedTo', t.assignedTo) + tag('Stage', t.stage) + tag('Description', t.description)
        + '</Topic>';
    const comments = t.comments.map(c => `<Comment Guid="${esc(c.guid)}">${tag('Date', c.date)}${tag('Author', c.author || '-')}${tag('Comment', c.text)}`
        + (c.viewpoint ? `<Viewpoint Guid="${esc(c.viewpoint)}"/>` : '') + tag('ModifiedDate', c.modifiedDate) + tag('ModifiedAuthor', c.modifiedAuthor) + '</Comment>').join('');
    return `${XML}<Markup>${header}${topic}${comments}${viewpoints.join('')}</Markup>`;
}

function viewpointXml(vp) {
    const comp = g => `<Component IfcGuid="${esc(g)}"/>`;
    const v = vp.visibility || { defaultVisible: true, exceptions: [] };
    let components = '<Components>';
    if (vp.selection?.length) components += `<Selection>${vp.selection.map(comp).join('')}</Selection>`;
    components += `<Visibility DefaultVisibility="${v.defaultVisible ? 'true' : 'false'}">${v.exceptions.length ? `<Exceptions>${v.exceptions.map(comp).join('')}</Exceptions>` : ''}</Visibility>`;
    if (vp.coloring?.length) components += `<Coloring>${vp.coloring.map(c => `<Color Color="${esc(c.color)}">${c.guids.map(comp).join('')}</Color>`).join('')}</Coloring>`;
    components += '</Components>';
    const xyz = (name, p) => `<${name}><X>${p[0]}</X><Y>${p[1]}</Y><Z>${p[2]}</Z></${name}>`;
    const c = vp.camera;
    const camera = !c ? '' : c.type === 'orthogonal'
        ? `<OrthogonalCamera>${xyz('CameraViewPoint', c.position)}${xyz('CameraDirection', c.direction)}${xyz('CameraUpVector', c.up || [0, 0, 1])}<ViewToWorldScale>${c.scale}</ViewToWorldScale></OrthogonalCamera>`
        : `<PerspectiveCamera>${xyz('CameraViewPoint', c.position)}${xyz('CameraDirection', c.direction)}${xyz('CameraUpVector', c.up || [0, 0, 1])}<FieldOfView>${c.fov}</FieldOfView></PerspectiveCamera>`;
    const clipping = vp.clipping?.length ? `<ClippingPlanes>${vp.clipping.map(p => `<ClippingPlane>${xyz('Location', p.location)}${xyz('Direction', p.direction)}</ClippingPlane>`).join('')}</ClippingPlanes>` : '';
    return `${XML}<VisualizationInfo Guid="${esc(vp.guid)}">${components}${camera}${clipping}</VisualizationInfo>`;
}

// zip without compression (PNGs are compressed already, the XML is small); UTF-8 names
function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBytes = enc.encode(name);
        const crc = crc32(data);
        const local = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);   // UTF-8 names
        lv.setUint16(8, 0, true);        // stored
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        const cd = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        cd.set(nameBytes, 46);
        parts.push(local, data);
        central.push(cd);
        offset += local.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cdSize + 22);
    let p = 0;
    for (const part of [...parts, ...central, end]) { out.set(part, p); p += part.length; }
    return out;
}
