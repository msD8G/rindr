// Node editor for materials (window at the bottom edge).
//  - Move nodes by their header, pan the view by dragging the background
//  - Link: drag from an output (right) to an input (left); dragging an input detaches it
//  - Clicking a link deletes it; × deletes a node
//  - Unconnected inputs show their value directly in the node
import {
    NODE_TYPES, NODE_CATEGORIES, IMPORT_SLOTS, createGraph, createImportGraph, defaultParams,
    nodeLabel, portLabel, paramLabel, optionLabel,
} from './material-graph.js';
import { mapLabel } from './material-panel.js';
import { t } from './i18n.js';
import { colorField } from './ui-controls.js';


const PORT_COLORS = { float: 'bg-violet-300', color: 'bg-amber-300' };
const INPUT = 'w-14 flex-none rounded bg-white/10 px-1 py-0.5 text-right tabular-nums text-white outline-none focus:bg-white/20';

export class NodeEditor {
    /**
     * @param {HTMLElement} root
     * @param {import('./material-manager.js').MaterialManager} manager
     */
    constructor(root, manager) {
        this.root = root;
        this.manager = manager;
        this.materialId = null;
        this.graph = null;
        this.pan = { x: 0, y: 0 };
        this.drag = null;

        root.innerHTML = `
            <div class="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1.5">
                <span data-title class="font-medium"></span>
                <span class="text-white/40">·</span>
                <span data-add class="flex flex-wrap gap-1"></span>
                <button data-close class="ml-auto rounded px-2 py-0.5 text-white/70 hover:bg-white/15" title="${t('nodeEditor.closeTitle')}">${t('nodeEditor.close')}</button>
            </div>
            <div data-canvas class="relative min-h-0 flex-1 cursor-grab overflow-hidden"
                 style="background-image: radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px); background-size: 20px 20px;">
                <div data-world class="absolute top-0 left-0 size-0">
                    <svg data-wires class="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1"></svg>
                </div>
            </div>
        `;
        this.title = root.querySelector('[data-title]');
        this.canvas = root.querySelector('[data-canvas]');
        this.world = root.querySelector('[data-world]');
        this.wires = root.querySelector('[data-wires]');

        // node menu
        const add = root.querySelector('[data-add]');
        for (const cat of NODE_CATEGORIES) {
            for (const [type, def] of Object.entries(NODE_TYPES)) {
                if (def.category !== cat) continue;
                const b = document.createElement('button');
                b.className = 'rounded px-1.5 py-0.5 text-white/80 hover:bg-white/15';
                b.textContent = t('nodeEditor.addNode', { label: nodeLabel(type) });
                b.onclick = () => this.addNode(type);
                if (def.importOnly) b.dataset.importOnly = '';
                add.append(b);
            }
        }
        root.querySelector('[data-close]').onclick = () => this.close();
        this.canvas.addEventListener('pointerdown', e => this._onPointerDown(e));
        window.addEventListener('pointermove', e => this._onPointerMove(e));
        window.addEventListener('pointerup', e => this._onPointerUp(e));
        manager.addEventListener('change', () => {
            if (this.materialId && !manager.get(this.materialId)) this.close();
            else if (this.materialId) this.title.textContent = t('nodeEditor.title', { name: manager.get(this.materialId).def.name });
        });
        // undo/redo: take the graph over from the material again (view stays)
        manager.addEventListener('update', e => {
            if (!e.detail?.restored || e.detail.id !== this.materialId) return;
            const graph = manager.get(this.materialId).def.graph;
            this.drag = null;
            this.graph = graph ? structuredClone(graph) : createGraph();
            this.render();
        });
    }

    get isOpen() {
        return !this.root.hidden;
    }

    open(materialId) {
        const entry = this.manager.get(materialId);
        if (!entry) return;
        this.materialId = materialId;
        this.graph = entry.def.graph ? structuredClone(entry.def.graph)
            : Object.keys(this._importMaps()).length ? createImportGraph(this._importMaps()) : createGraph();
        // offer "import texture" only for materials with textures from the file
        const hasImport = Object.keys(this._importMaps()).length > 0;
        this.root.querySelectorAll('[data-import-only]').forEach(b => { b.hidden = !hasImport; });
        this.title.textContent = t('nodeEditor.title', { name: entry.def.name });
        this.root.hidden = false;
        // output on the right of the visible area
        const out = this.graph.nodes.find(n => n.type === 'output');
        const w = this.canvas.clientWidth || 900;
        this.pan = { x: out ? w - out.x - 240 : 0, y: 0 };
        this.render();
    }

    // textures of the imported file addressable by the graph (map key -> texture)
    _importMaps() {
        const maps = this.manager.get(this.materialId)?.def.render?.maps || {};
        return Object.fromEntries(Object.entries(maps).filter(([k]) => IMPORT_SLOTS[k]));
    }

    close() {
        this.root.hidden = true;
        this.materialId = null;
        this.graph = null;
    }

    addNode(type) {
        if (!this.graph) return;
        const id = type + '-' + Math.random().toString(36).slice(2, 8);
        // find a free spot in the grid (columns of 210 px, rows of 150 px)
        const taken = this.graph.nodes.map(n => [n.x, n.y]);
        let x = 0, y = 0;
        search: for (let i = 0; i < 40; i++) {
            x = -this.pan.x + 30 + (i % 4) * 210;
            y = -this.pan.y + 20 + Math.floor(i / 4) * 150;
            for (const [tx, ty] of taken) if (Math.abs(tx - x) < 200 && Math.abs(ty - y) < 140) continue search;
            break;
        }
        const params = defaultParams(type);
        if (type === 'importMap') params.map = Object.keys(this._importMaps())[0] ?? params.map;
        this.graph.nodes.push({ id, type, x, y, params });
        this.render();
        this.commit();
    }

    removeNode(id) {
        this.graph.nodes = this.graph.nodes.filter(n => n.id !== id);
        this.graph.links = this.graph.links.filter(l => l.from.node !== id && l.to.node !== id);
        this.render();
        this.commit();
    }

    // hand the graph to the material (triggers evaluation/baking)
    commit(mergeKey) {
        if (this.materialId) this.manager.setGraph(this.materialId, structuredClone(this.graph), mergeKey);
    }

    // --- Rendering ---

    render() {
        this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
        this.world.querySelectorAll('[data-node]').forEach(n => n.remove());
        const linked = new Set(this.graph.links.map(l => l.to.node + ':' + l.to.port));
        for (const n of this.graph.nodes) this.world.append(this._nodeEl(n, linked));
        this._renderWires();
    }

    _nodeEl(n, linked) {
        const type = NODE_TYPES[n.type];
        const el = div('absolute w-48 rounded-md bg-neutral-800 shadow-lg ring-1 ring-white/10');
        el.dataset.node = n.id;
        el.style.left = n.x + 'px';
        el.style.top = n.y + 'px';

        const head = div(`flex cursor-move items-center justify-between rounded-t-md px-2 py-1 font-medium ${type.color}`);
        head.dataset.handle = 'move';
        head.append(span('', nodeLabel(n.type)));
        if (n.type !== 'output') {
            const x = document.createElement('button');
            x.className = 'rounded px-1 text-white/70 hover:bg-black/30 hover:text-white';
            x.textContent = '×';
            x.title = t('nodeEditor.deleteNode');
            x.onclick = () => this.removeNode(n.id);
            head.append(x);
        }
        el.append(head);

        const body = div('flex flex-col gap-1 py-1.5');
        const params = { ...defaultParams(n.type), ...n.params };
        for (const o of type.outputs) {
            const row = div('relative flex items-center justify-end px-3');
            row.append(span('text-white/70', portLabel(n.type, 'outputs', o.key)), this._port(n.id, o.key, o.type, 'out'));
            body.append(row);
        }
        const inputKeys = new Set(type.inputs.map(i => i.key));
        for (const i of type.inputs) {
            const row = div('relative flex min-h-5 items-center gap-1 px-3');
            row.append(this._port(n.id, i.key, i.type, 'in'));
            const p = (type.params || []).find(p => p.key === i.key);
            const isLinked = linked.has(n.id + ':' + i.key);
            if (n.type === 'output' && !isLinked) {
                row.append(span('text-white/50', portLabel(n.type, 'inputs', i.key)));
            } else if (p && !isLinked) {
                row.append(this._param(n, p, params[p.key]));
            } else {
                row.append(span(isLinked ? 'text-white' : 'text-white/50', portLabel(n.type, 'inputs', i.key)));
            }
            body.append(row);
        }
        for (const p of type.params || []) {
            if (inputKeys.has(p.key)) continue;
            const row = div('flex items-center gap-1 px-3');
            row.append(this._param(n, p, params[p.key]));
            body.append(row);
        }
        el.append(body);
        return el;
    }

    _port(node, port, type, dir) {
        const dot = div(`absolute size-2.5 rounded-full ring-2 ring-neutral-800 ${PORT_COLORS[type]} ${dir === 'out' ? '-right-1.5' : '-left-1.5'} cursor-crosshair hover:scale-125`);
        dot.dataset.port = port;
        dot.dataset.dir = dir;
        dot.dataset.portNode = node;
        dot.dataset.type = type;
        dot.title = type === 'color' ? t('nodeEditor.portTypes.color') : t('nodeEditor.portTypes.float');
        return dot;
    }

    _param(n, p, value) {
        const wrap = div('flex min-w-0 flex-1 items-center gap-1');
        const label = span('w-16 shrink-0 truncate text-white/60', paramLabel(n.type, p.key));
        const set = v => { n.params = { ...n.params, [p.key]: v }; this.commit(n.id + ':' + p.key); };
        if (p.kind === 'color') {
            wrap.append(label, colorField(value, { onInput: set, className: 'flex-1' }));
        } else if (p.kind === 'select') {
            const s = document.createElement('select');
            s.className = 'min-w-0 flex-1 rounded bg-white/10 px-1 py-0.5 text-white outline-none';
            for (const k of p.options) s.append(new Option(optionLabel(n.type, p.key, k), k, false, k === value));
            s.onchange = () => set(s.value);
            wrap.append(label, s);
        } else if (p.kind === 'importMap') {
            // choose a texture from the file; the same texture for several maps (glTF metallicRoughness) only once
            const maps = this._importMaps();
            const s = document.createElement('select');
            s.className = 'min-w-0 flex-1 rounded bg-white/10 px-1 py-0.5 text-white outline-none';
            const seen = new Map();
            for (const [k, tex] of Object.entries(maps)) {
                if (seen.has(tex)) { seen.get(tex).text += ' / ' + mapLabel(k); continue; }
                const o = new Option(mapLabel(k), k, false, k === value);
                seen.set(tex, o);
                s.append(o);
            }
            if (!maps[value]) s.append(new Option(t('nodeEditor.missingTexture'), value, false, true));
            // the chosen key can be a second map of the same texture
            for (const [tex, o] of seen) if (maps[value] === tex) o.selected = true;
            s.onchange = () => { set(s.value); this.render(); };
            s.title = t('nodeEditor.importTextureTitle');
            wrap.append(s);
            const thumb = textureThumb(maps[value]);
            if (thumb) wrap.append(thumb);
        } else if (p.kind === 'image') {
            const b = document.createElement('button');
            b.className = 'min-w-0 flex-1 truncate rounded bg-white/10 px-1 py-0.5 text-left text-white/80 hover:bg-white/20';
            b.textContent = value ? t('nodeEditor.replaceImage') : t('nodeEditor.chooseImage');
            const f = document.createElement('input');
            f.type = 'file';
            f.accept = 'image/*';
            f.hidden = true;
            b.onclick = () => f.click();
            f.onchange = async () => {
                if (!f.files[0]) return;
                set(await imageToDataUrl(f.files[0]));
                this.render();
            };
            wrap.append(label, b, f);
            if (value) {
                const thumb = document.createElement('img');
                thumb.src = value;
                thumb.className = 'size-5 shrink-0 rounded object-cover';
                wrap.append(thumb);
            }
        } else {
            const r = document.createElement('input');
            r.type = 'range';
            Object.assign(r, { min: p.min, max: p.max, step: p.step, value });
            r.className = 'min-w-0 flex-1 accent-sky-400';
            const num = document.createElement('input');
            num.type = 'number';
            Object.assign(num, { min: p.min, max: p.max, step: p.step, value });
            num.className = INPUT;
            r.oninput = () => { num.value = r.value; set(Number(r.value)); };
            num.onchange = () => { r.value = num.value; set(Number(num.value)); };
            wrap.append(label, r, num);
        }
        return wrap;
    }

    _portPos(node, port, dir) {
        const el = this.world.querySelector(`[data-port-node="${node}"][data-port="${port}"][data-dir="${dir}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect(), w = this.world.getBoundingClientRect();
        return { x: r.left + r.width / 2 - w.left, y: r.top + r.height / 2 - w.top };
    }

    _renderWires(temp) {
        const paths = [];
        for (const [i, l] of this.graph.links.entries()) {
            const a = this._portPos(l.from.node, l.from.port, 'out');
            const b = this._portPos(l.to.node, l.to.port, 'in');
            if (a && b) paths.push(`<path data-link="${i}" d="${curve(a, b)}" class="pointer-events-auto cursor-pointer stroke-white/60 hover:stroke-red-400" stroke-width="2.5" fill="none"/>`);
        }
        if (temp) paths.push(`<path d="${curve(temp.a, temp.b)}" class="stroke-sky-300" stroke-width="2" stroke-dasharray="5 4" fill="none"/>`);
        this.wires.innerHTML = paths.join('');
    }

    // --- Interaktion ---

    _local(e) {
        const w = this.world.getBoundingClientRect();
        return { x: e.clientX - w.left, y: e.clientY - w.top };
    }

    _onPointerDown(e) {
        if (e.button !== 0 || !this.graph) return;
        const link = e.target.closest('[data-link]');
        if (link) {
            this.graph.links.splice(Number(link.dataset.link), 1);
            this.render();
            this.commit();
            return;
        }
        const port = e.target.closest('[data-port]');
        if (port) {
            e.preventDefault();
            const { portNode: node, port: key, dir } = port.dataset;
            if (dir === 'out') {
                this.drag = { kind: 'link', from: { node, port: key } };
            } else {
                // pick up the existing link at the input
                const i = this.graph.links.findIndex(l => l.to.node === node && l.to.port === key);
                if (i < 0) return;
                const [l] = this.graph.links.splice(i, 1);
                this.drag = { kind: 'link', from: l.from, detached: true };
                this.render();
            }
            return;
        }
        const handle = e.target.closest('[data-handle="move"]');
        if (handle && !e.target.closest('button')) {
            const id = handle.closest('[data-node]').dataset.node;
            const n = this.graph.nodes.find(n => n.id === id);
            this.drag = { kind: 'node', node: n, start: { x: e.clientX, y: e.clientY }, origin: { x: n.x, y: n.y } };
            return;
        }
        if (e.target === this.canvas || e.target === this.world) {
            this.drag = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origin: { ...this.pan } };
            this.canvas.classList.replace('cursor-grab', 'cursor-grabbing');
        }
    }

    _onPointerMove(e) {
        const d = this.drag;
        if (!d) return;
        if (d.kind === 'pan') {
            this.pan = { x: d.origin.x + e.clientX - d.start.x, y: d.origin.y + e.clientY - d.start.y };
            this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px)`;
        } else if (d.kind === 'node') {
            d.node.x = d.origin.x + e.clientX - d.start.x;
            d.node.y = d.origin.y + e.clientY - d.start.y;
            const el = this.world.querySelector(`[data-node="${d.node.id}"]`);
            el.style.left = d.node.x + 'px';
            el.style.top = d.node.y + 'px';
            this._renderWires();
        } else if (d.kind === 'link') {
            const a = this._portPos(d.from.node, d.from.port, 'out');
            if (a) this._renderWires({ a, b: this._local(e) });
        }
    }

    _onPointerUp(e) {
        const d = this.drag;
        this.drag = null;
        if (!d) return;
        this.canvas.classList.replace('cursor-grabbing', 'cursor-grab');
        if (d.kind === 'node') { this.commit(); return; }
        if (d.kind !== 'link') return;
        const port = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-port][data-dir="in"]');
        if (port && port.dataset.portNode !== d.from.node) {
            const to = { node: port.dataset.portNode, port: port.dataset.port };
            this.graph.links = this.graph.links.filter(l => !(l.to.node === to.node && l.to.port === to.port));
            this.graph.links.push({ from: d.from, to });
            this.render();
            this.commit();
        } else {
            this._renderWires();
            if (d.detached) this.commit();
        }
    }
}

function curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

function div(className) {
    const e = document.createElement('div');
    e.className = className;
    return e;
}

function span(className, text) {
    const e = document.createElement('span');
    e.className = className;
    e.textContent = text;
    return e;
}

// Thumbnail of a texture (ImageBitmap/image/canvas; compressed textures without preview)
const thumbs = new WeakMap();
function textureThumb(tex) {
    const img = tex?.image;
    if (!img || !(img.width > 0) || img.data) return null;
    let url = thumbs.get(tex);
    if (!url) {
        try {
            const c = document.createElement('canvas');
            c.width = c.height = 48;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 48, 48);
            url = c.toDataURL();
        } catch {
            return null;
        }
        thumbs.set(tex, url);
    }
    const e = document.createElement('img');
    e.src = url;
    e.className = 'size-8 shrink-0 rounded object-cover ring-1 ring-white/20';
    return e;
}

// Image downscaled (max. 1024 px) as data URL – keeps the material JSON small
async function imageToDataUrl(file) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
}
