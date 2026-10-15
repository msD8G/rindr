// HDRI editor window (docs/hdri-editor.md): canvas with the equirect image (2:1) and the pins as outlines with
// handles (drag = move, corner = size), sun handle for sun & sky; sidebar with background, sun & sky, pin list and
// the selected pin's settings; header with name, resolution, export, duplicate/delete, close.
// Always a free window (move by the header, resize at the corner – user's choice; docking at the bottom was
// dropped). Inputs from ui-controls.js: same look and behaviour as the panels (number fields draggable).
//
// Rendering in the worker (hdri-service.js): while dragging/sliding a low resolution for canvas + scene, on release
// the canvas preview (1024) and the full resolution for the scene. One undo step per finished change.
import { t } from '../i18n.js';
import { createPin, cloneHdri, RESOLUTIONS, direction } from './hdri-model.js';
import { LatestRender, makeEnvTexture } from './hdri-service.js';
import { gradientEditor } from './gradient-editor.js';
import { encodeHdr, encodeExr, saveFile } from './hdri-export.js';
import { draggable, fmt, INPUT, SELECT, RANGE, CHECKBOX, colorField } from '../ui-controls.js';

const D = Math.PI / 180;
const CW = 1024, CH = 512;            // canvas resolution (preview image, overlay coordinates)
const LIVE_WIDTH = 512;               // render width while dragging
const BUTTON = 'rounded px-2 py-0.5 text-white/80 hover:bg-white/15 disabled:opacity-40';
const STORE_KEY = 'rindr.hdriEditor.window';

const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

export class HdriEditor {
    /**
     * @param {HTMLElement} root
     * @param {{ service, onApply: (texture, info: { final: boolean }) => void, onSave: (doc) => void,
     *           onDuplicate: (doc) => void, onDelete: (doc) => void, onDrag?: (active: boolean) => void,
     *           record?: (step) => void, onClose?: () => void }} hooks
     */
    constructor(root, hooks) {
        this.root = root;
        this.hooks = hooks;
        this.doc = null;
        this.sel = null;          // selected pin id
        this._baseline = null;    // JSON of the last committed state (undo)
        this._drag = null;
        this._dragging = false;   // a live change is running (slider, handle)
        this.win = loadWindowState();   // position/size of the window

        root.hidden = true;
        root.innerHTML = `
            <div data-head class="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-2 py-1.5 select-none">
                <span class="px-1 font-medium text-white/60">${t('hdriEditor.title')}</span>
                <input data-name class="${INPUT.replace('w-full', 'w-40').replace('text-right tabular-nums', 'text-left')}" />
                <span class="ml-2 text-white/50">${t('hdriEditor.resolution')}</span>
                <select data-res class="${SELECT.replace('w-full', 'w-auto')}"></select>
                <span class="ml-2 text-white/50">${t('hdriEditor.export')}</span>
                <button data-export="hdr" class="${BUTTON}" title="${t('hdriEditor.exportHdrTitle')}">.hdr</button>
                <button data-export="exr" class="${BUTTON}" title="${t('hdriEditor.exportExrTitle')}">.exr</button>
                <span data-status class="ml-2 truncate text-white/40"></span>
                <span class="ml-auto"></span>
                <button data-duplicate class="${BUTTON}">${t('hdriEditor.duplicate')}</button>
                <button data-delete class="${BUTTON} hover:text-red-300">${t('hdriEditor.delete')}</button>
                <button data-close class="${BUTTON} flex items-center py-1" title="${t('hdriEditor.close')}">${ICON_CLOSE}</button>
            </div>
            <div class="flex min-h-0 flex-1">
                <div class="flex min-w-0 flex-1 flex-col">
                    <div data-area class="relative flex min-h-0 flex-1 items-center justify-center p-2">
                        <div data-stage class="relative overflow-hidden rounded bg-black/40 ring-1 ring-white/10">
                            <canvas data-canvas width="${CW}" height="${CH}" class="absolute inset-0 size-full"></canvas>
                            <svg data-overlay viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="none" class="absolute inset-0 size-full touch-none"></svg>
                        </div>
                    </div>
                    <div data-bg class="shrink-0 border-t border-white/10 px-3 py-2"></div>
                </div>
                <div data-side class="w-72 shrink-0 overflow-y-auto border-l border-white/10 px-3 py-2"></div>
            </div>`;
        this.$ = sel => root.querySelector(sel);
        this.canvas = this.$('[data-canvas]');
        this.ctx2d = this.canvas.getContext('2d');
        this.overlay = this.$('[data-overlay]');
        this.stage = this.$('[data-stage]');
        this.side = this.$('[data-side]');     // pins + settings of the selected pin
        this.bgPanel = this.$('[data-bg]');    // background under the canvas
        this.status = this.$('[data-status]');

        // renders: live (low resolution, canvas + scene), canvas preview after a change, full resolution for the scene
        this._live = new LatestRender(hooks.service, (r, job) => {
            if (job.doc.id === this.doc?.id) this._drawPixels(r);
            if (r.half) hooks.onApply(makeEnvTexture(r.half, r.width, r.height), { final: false, id: job.doc.id });
        });
        this._preview = new LatestRender(hooks.service, (r, job) => { if (job.doc.id === this.doc?.id) this._drawPixels(r); });
        this._final = new LatestRender(hooks.service, (r, job) => {
            hooks.onApply(makeEnvTexture(r.half, r.width, r.height), { final: true, id: job.doc.id });
            this._setStatus('');
        });

        this._setupHeader();
        this._setupCanvas();
        this._setupKeys();
        new ResizeObserver(() => this._fitStage()).observe(this.$('[data-area]'));
        this._applyWindow();
    }

    get isOpen() { return !this.root.hidden; }
    get docId() { return this.doc?.id ?? null; }

    /** Edit `doc` (a copy is kept – changes go out via onSave) */
    open(doc) {
        this.doc = cloneHdri(doc, { keepIds: true });
        this._baseline = JSON.stringify(this.doc);
        this.sel = this.doc.pins[0]?.id ?? null;
        this.root.hidden = false;
        this._applyWindow();
        this._refreshAll();
        this._preview.request(this.doc, CW, { preview: true, half: false });
    }

    close() {
        if (this.root.hidden) return;
        this.root.hidden = true;
        this.hooks.onClose?.();
    }

    /** Replace the edited description from outside (undo/redo) */
    setDoc(doc) {
        if (!this.doc || doc.id !== this.doc.id) return;
        this.doc = cloneHdri(doc, { keepIds: true });
        this._baseline = JSON.stringify(this.doc);
        if (!this.doc.pins.some(p => p.id === this.sel)) this.sel = this.doc.pins[0]?.id ?? null;
        this._refreshAll();
        this._preview.request(this.doc, CW, { preview: true, half: false });
    }

    // --- changes ---

    // live: while dragging (low resolution); commit: finished change (preview, full resolution, save, undo step)
    _change(kind = 'commit') {
        this._drawOverlay();
        if (kind === 'live') {
            if (!this._dragging) { this._dragging = true; this.hooks.onDrag?.(true); }
            this._live.request(this.doc, LIVE_WIDTH, { preview: true, half: true });
            return;
        }
        if (this._dragging) { this._dragging = false; this.hooks.onDrag?.(false); }
        this._preview.request(this.doc, CW, { preview: true, half: false });
        this._setStatus(t('hdriEditor.rendering'));
        this._final.request(this.doc, this.doc.resolution || 2048, { half: true });
        const after = JSON.stringify(this.doc), before = this._baseline;
        this._baseline = after;
        this.hooks.onSave(cloneHdri(this.doc, { keepIds: true }));
        if (before && before !== after) {
            const apply = json => { const d = JSON.parse(json); this.hooks.onSave(d); this.setDoc(d); this._final.request(d, d.resolution || 2048, { half: true }); };
            this.hooks.record?.({ label: t('hdriEditor.undo'), undo: () => apply(before), redo: () => apply(after) });
        }
    }

    _setStatus(text) { this.status.textContent = text; }

    _refreshAll() {
        this.$('[data-name]').value = this.doc.name;
        const res = this.$('[data-res]');
        res.replaceChildren(...RESOLUTIONS.map(w => new Option(`${w} × ${w / 2}`, String(w))));
        res.value = String(this.doc.resolution || 2048);
        this._renderBackground();
        this._renderSide();
        this._drawOverlay();
    }

    // --- header, window ---

    _setupHeader() {
        const name = this.$('[data-name]');
        name.onchange = () => { this.doc.name = name.value.trim() || this.doc.name; this._change(); };
        name.onkeydown = e => { if (e.key === 'Enter') name.blur(); };
        this.$('[data-res]').onchange = e => { this.doc.resolution = Number(e.target.value); this._change(); };
        for (const b of this.root.querySelectorAll('[data-export]')) b.onclick = () => this._export(b.dataset.export);
        this.$('[data-duplicate]').onclick = () => this.hooks.onDuplicate(cloneHdri(this.doc, { keepIds: true }));
        this.$('[data-delete]').onclick = () => this.hooks.onDelete(this.doc);
        this.$('[data-close]').onclick = () => this.close();
        // move by the header
        const head = this.$('[data-head]');
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('input, select, button')) return;
            const r = this.root.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
            head.setPointerCapture(e.pointerId);
            const move = ev => {
                this.win.left = Math.min(Math.max(r.left + ev.clientX - sx, 0), window.innerWidth - 80);
                this.win.top = Math.min(Math.max(r.top + ev.clientY - sy, 0), window.innerHeight - 40);
                this.root.style.left = `${this.win.left}px`; this.root.style.top = `${this.win.top}px`;
            };
            const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); this._saveWindow(); };
            head.addEventListener('pointermove', move);
            head.addEventListener('pointerup', up);
        });
        // size from the CSS resize corner
        new ResizeObserver(() => {
            if (this.root.hidden) return;
            const r = this.root.getBoundingClientRect();
            if (r.width && r.height) { this.win.width = r.width; this.win.height = r.height; this._saveWindowSoon(); }
        }).observe(this.root);
    }

    // free window: last position/size (kept inside the browser window), centred the first time
    _applyWindow() {
        const r = this.root;
        r.className = 'fixed z-30 flex flex-col overflow-hidden rounded-lg bg-black/60 text-xs text-white/90 shadow-2xl ring-1 ring-white/10 backdrop-blur-sm';
        r.dataset.ui = 'float';   // hides with "hide UI"
        const w = Math.min(this.win.width || 1040, window.innerWidth - 20), h = Math.min(this.win.height || 620, window.innerHeight - 20);
        const left = this.win.left ?? Math.max(10, (window.innerWidth - w) / 2), top = this.win.top ?? Math.max(10, (window.innerHeight - h) / 2);
        r.style.cssText = `left:${Math.min(left, window.innerWidth - 80)}px;top:${Math.min(top, window.innerHeight - 40)}px;width:${w}px;height:${h}px;resize:both;min-width:520px;min-height:300px;`;
        this._fitStage();
    }

    _saveWindow() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(this.win)); } catch { /* storage blocked */ }
    }
    _saveWindowSoon() { clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => this._saveWindow(), 300); }

    // canvas 2:1, as large as the area allows
    _fitStage() {
        const area = this.$('[data-area]').getBoundingClientRect();
        const w = Math.max(0, Math.min(area.width - 16, (area.height - 16) * 2));
        this.stage.style.width = `${w}px`;
        this.stage.style.height = `${w / 2}px`;
    }

    async _export(kind) {
        const doc = this.doc, width = doc.resolution || 2048;
        this._setStatus(t('hdriEditor.exporting'));
        try {
            const r = await this.hooks.service.render(doc, width, { half: kind === 'exr', float: kind === 'hdr' });
            const bytes = kind === 'hdr' ? encodeHdr(r.float, r.width, r.height) : await encodeExr(r.half, r.width, r.height);
            const base = (doc.name || 'hdri').replace(/[\\/:*?"<>|]+/g, '_');
            const saved = await saveFile(bytes, `${base}.${kind}`, kind === 'hdr' ? 'image/vnd.radiance' : 'image/x-exr', kind === 'hdr' ? 'Radiance HDR' : 'OpenEXR');
            this._setStatus(saved ? t('hdriEditor.exported', { name: `${base}.${kind}` }) : '');
        } catch (e) {
            console.error('[HDRI] export failed:', e);
            this._setStatus(t('hdriEditor.exportError', { message: e.message }));
        }
    }

    // --- canvas ---

    _drawPixels(r) {
        if (!r.pixels) return;
        const img = new ImageData(r.pixels, r.width, r.height);
        if (r.width === CW) { this.ctx2d.putImageData(img, 0, 0); return; }
        // smaller live render: scaled up
        const tmp = this._tmpCanvas ??= document.createElement('canvas');
        tmp.width = r.width; tmp.height = r.height;
        tmp.getContext('2d').putImageData(img, 0, 0);
        this.ctx2d.imageSmoothingEnabled = true;
        this.ctx2d.drawImage(tmp, 0, 0, CW, CH);
    }

    _drawOverlay() {
        const svg = this.overlay, doc = this.doc;
        if (!doc) return;
        let html = '';
        doc.pins.forEach(pin => {
            if (pin.enabled === false && pin.id !== this.sel) return;
            const f = frame(pin), selected = pin.id === this.sel;
            const stroke = selected ? '#38bdf8' : 'rgba(255,255,255,0.55)';
            html += `<path d="${outlinePath(pin, f)}" fill="none" stroke="${stroke}" stroke-width="${selected ? 2 : 1.2}" ${pin.enabled === false ? 'stroke-dasharray="4 4"' : ''} vector-effect="non-scaling-stroke"/>`;
            const [cx, cy] = toCanvas(f.n);
            html += `<circle data-pin="${pin.id}" data-handle="move" cx="${cx}" cy="${cy}" r="${selected ? 6 : 4.5}" fill="${selected ? '#38bdf8' : 'rgba(255,255,255,0.8)'}" stroke="rgba(0,0,0,0.6)" class="cursor-move"/>`;
            if (selected) {
                const [hx, hy] = toCanvas(sizeHandleDir(pin, f));
                html += `<rect data-pin="${pin.id}" data-handle="size" x="${hx - 5}" y="${hy - 5}" width="10" height="10" rx="2" fill="#0ea5e9" stroke="white" stroke-width="1.2" class="cursor-nwse-resize"/>`;
            }
        });
        if (doc.background.mode === 'sky') {
            const [sx, sy] = toCanvas(direction(doc.sky.azimuth, doc.sky.elevation));
            const rays = Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return `M${sx + Math.cos(a) * 11} ${sy + Math.sin(a) * 11}L${sx + Math.cos(a) * 16} ${sy + Math.sin(a) * 16}`; }).join('');
            html += `<g data-handle="sun" class="cursor-move"><title>${t('hdriEditor.sunHint')}</title><circle cx="${sx}" cy="${sy}" r="18" fill="transparent"/><circle cx="${sx}" cy="${sy}" r="7.5" fill="#fbbf24" stroke="rgba(0,0,0,0.6)"/><path d="${rays}" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/></g>`;
        }
        svg.innerHTML = html;
    }

    _setupCanvas() {
        const svg = this.overlay;
        const toLocal = e => {
            const r = svg.getBoundingClientRect();
            return [(e.clientX - r.left) / r.width * CW, (e.clientY - r.top) / r.height * CH];
        };
        svg.addEventListener('pointerdown', e => {
            if (e.button !== 0 || !this.doc) return;
            const [x, y] = toLocal(e);
            const target = e.target.closest('[data-handle]');
            let drag = null;
            if (target?.dataset.handle === 'sun') drag = { kind: 'sun' };
            else if (target?.dataset.handle) {
                this._select(target.dataset.pin);
                drag = { kind: target.dataset.handle, pin: this._pin() };
            } else {
                // topmost pin under the pointer, else deselect
                const [az, el] = toAzEl(x, y);
                const hit = [...this.doc.pins].reverse().find(p => p.enabled !== false && pinContains(p, direction(az, el)));
                this._select(hit?.id ?? null);
                if (hit) drag = { kind: 'move', pin: hit };
            }
            if (!drag) return;
            const [az0, el0] = toAzEl(x, y);
            drag.start = { az: az0, el: el0, pinAz: drag.pin?.azimuth, pinEl: drag.pin?.elevation };
            drag.moved = false;
            this._drag = drag;
            svg.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        svg.addEventListener('pointermove', e => {
            const drag = this._drag;
            if (!drag) return;
            const [x, y] = toLocal(e), [az, el] = toAzEl(x, y);
            drag.moved = true;
            if (drag.kind === 'sun') {
                this.doc.sky.azimuth = round(az, 1);
                this.doc.sky.elevation = round(Math.min(Math.max(el, -5), 90), 1);
            } else if (drag.kind === 'move') {
                drag.pin.azimuth = round(wrap180(drag.start.pinAz + (az - drag.start.az) + (Math.abs(az - drag.start.az) > 180 ? -Math.sign(az - drag.start.az) * 360 : 0)), 1);
                drag.pin.elevation = round(Math.min(Math.max(drag.start.pinEl + el - drag.start.el, -89), 89), 1);
            } else if (drag.kind === 'size') {
                resizeTo(drag.pin, direction(az, el));
            }
            this._syncSideValues();
            this._change('live');
        });
        const end = () => {
            const drag = this._drag;
            if (!drag) return;
            this._drag = null;
            if (drag.moved) this._change('commit');
        };
        svg.addEventListener('pointerup', end);
        svg.addEventListener('pointercancel', end);
    }

    // Delete/Backspace removes the selected pin – only while the editor is the active area (last pointer down
    // inside it), otherwise the key keeps its meaning in the viewer (delete the selected parts)
    _setupKeys() {
        this._active = false;
        window.addEventListener('pointerdown', e => { this._active = !this.root.hidden && this.root.contains(e.target); }, true);
        window.addEventListener('keydown', e => {
            if (!this._active || this.root.hidden || !this.sel || !this.doc) return;
            if (e.key !== 'Delete' && e.key !== 'Del' && e.key !== 'Backspace') return;
            if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
            e.preventDefault();
            e.stopPropagation();
            this._deletePin(this.sel);
        }, true);
    }

    _deletePin(id) {
        const idx = this.doc.pins.findIndex(p => p.id === id);
        if (idx < 0) return;
        this.doc.pins.splice(idx, 1);
        if (this.sel === id) this.sel = this.doc.pins[Math.min(idx, this.doc.pins.length - 1)]?.id ?? null;
        this._renderSide();
        this._change();
    }

    _pin(id = this.sel) { return this.doc?.pins.find(p => p.id === id) ?? null; }

    _select(id) {
        if (this.sel === id) return;
        this.sel = id;
        this._renderSide();
        this._drawOverlay();
    }

    // --- sidebar ---

    // values that dragging on the canvas changes, without rebuilding the sidebar
    _syncSideValues() {
        for (const input of this.root.querySelectorAll('[data-bind]')) {
            if (document.activeElement === input) continue;
            const v = readPath(this.doc, input.dataset.bind, this.sel);
            if (v === undefined) continue;
            if (input.type === 'range' || input.type === 'number') input.value = input.type === 'number' ? fmt(v) : v;
        }
    }

    // background under the canvas, side by side: type | gradient (colour / sun & sky settings) | brightness
    _renderBackground() {
        const panel = this.bgPanel, doc = this.doc;
        panel.replaceChildren();
        if (!doc) return;
        const bg = doc.background;
        const wrap = el('div', 'flex items-start gap-4');
        const typeCol = el('div', 'w-36 shrink-0');
        typeCol.append(heading(t('hdriEditor.background')),
            select(['color', 'gradient', 'sky'].map(m => [m, t(`hdriEditor.modes.${m}`)]), bg.mode, v => { bg.mode = v; this._renderBackground(); this._change(); }));
        wrap.append(typeCol);
        if (bg.mode === 'sky') {
            // sun & sky: settings in two columns (three were too narrow for the sliders)
            const grid = el('div', 'grid min-w-0 flex-1 grid-cols-2 gap-x-4');
            grid.append(
                this._slider(t('hdriEditor.sunAzimuth'), 'sky.azimuth', -180, 180, 0.5),
                this._slider(t('hdriEditor.sunElevation'), 'sky.elevation', -5, 90, 0.5),
                this._slider(t('hdriEditor.sunSize'), 'sky.sunSize', 0.1, 30, 0.1),
                this._slider(t('hdriEditor.sunIntensity'), 'sky.sunIntensity', 0, 5, 0.01),
                this._slider(t('hdriEditor.skyIntensity'), 'sky.skyIntensity', 0, 5, 0.01),
                this._slider(t('hdriEditor.turbidity'), 'sky.turbidity', 1, 10, 0.1),
                row(t('hdriEditor.groundColor'), colorInput(doc.sky.groundColor, v => { doc.sky.groundColor = v; this._change('live'); }, () => this._change())),
                this._slider(t('hdriEditor.groundIntensity'), 'sky.groundIntensity', 0, 5, 0.01),
            );
            wrap.append(grid);
        } else {
            const main = el('div', 'min-w-0 flex-1 pt-5');
            if (bg.mode === 'gradient') {
                // position = elevation in degrees: left = straight down, right = straight up
                main.append(gradientEditor({ stops: bg.gradient, min: -90, max: 90, step: 1,
                    startLabel: t('hdriEditor.gradientBottom'), endLabel: t('hdriEditor.gradientTop'), onChange: kind => this._change(kind) }));
            } else {
                main.append(row(t('hdriEditor.color'), colorInput(bg.color, v => { bg.color = v; this._change('live'); }, () => this._change())));
            }
            const bright = el('div', 'w-64 shrink-0 pt-5');
            bright.append(this._slider(t('hdriEditor.brightness'), 'background.brightness', 0, 5, 0.01));
            wrap.append(main, bright);
        }
        panel.append(wrap);
        this._fitStage();
    }

    // right side: pin list, a divider, settings of the selected pin
    _renderSide() {
        const side = this.side, doc = this.doc;
        side.replaceChildren();
        if (!doc) return;

        // pins
        side.append(heading(t('hdriEditor.pins')));
        const add = el('div', 'mb-1.5 flex flex-wrap gap-1');
        for (const type of ['circle', 'rect', 'gradient']) {
            const b = el('button', BUTTON + ' bg-white/5', t(`hdriEditor.add.${type}`));
            b.onclick = () => this._addPin(type);
            add.append(b);
        }
        side.append(add);
        const list = el('div', 'mb-2 flex flex-col');
        doc.pins.forEach((pin, idx) => {
            const r = el('div', `flex items-center gap-1.5 rounded px-1 py-0.5 ${pin.id === this.sel ? 'bg-sky-500/30' : 'hover:bg-white/10'}`);
            const cb = el('input', CHECKBOX);
            cb.type = 'checkbox'; cb.checked = pin.enabled !== false; cb.title = t('hdriEditor.pinVisible');
            cb.onchange = () => { pin.enabled = cb.checked; this._change(); };
            const label = el('span', 'min-w-0 flex-1 cursor-pointer truncate', pin.name || `${t(`hdriEditor.types.${pinType(pin)}`)} ${idx + 1}`);
            label.onclick = () => this._select(pin.id);
            const dup = iconButton('⧉', t('hdriEditor.pinDuplicate'), () => {
                const copy = { ...JSON.parse(JSON.stringify(pin)), id: createPin('circle').id, azimuth: wrap180(pin.azimuth + 10) };
                doc.pins.splice(idx + 1, 0, copy);
                this.sel = copy.id; this._renderSide(); this._change();
            });
            const del = iconButton('×', t('hdriEditor.pinDelete'), () => this._deletePin(pin.id));
            r.append(cb, label, dup, del);
            list.append(r);
        });
        if (!doc.pins.length) list.append(hint(t('hdriEditor.noPins')));
        side.append(list);

        const pin = this._pin();
        if (!pin) return;
        side.append(el('div', 'my-2 border-t border-white/15'));   // divider between the list and the pin settings
        this._pinSection(pin);
    }

    _pinSection(pin) {
        const side = this.side;
        side.append(heading(t('hdriEditor.pin')));
        const name = el('input', INPUT.replace('text-right tabular-nums', 'text-left'));
        name.value = pin.name; name.placeholder = t(`hdriEditor.types.${pinType(pin)}`);
        name.onchange = () => { pin.name = name.value.trim(); this._renderSide(); this._change(); };
        side.append(row(t('hdriEditor.name'), name));
        side.append(row(t('hdriEditor.shape'), select([['circle', t('hdriEditor.shapes.circle')], ['rect', t('hdriEditor.shapes.rect')]], pin.shape, v => { pin.shape = v; this._renderSide(); this._change(); })));
        side.append(row(t('hdriEditor.fill'), select(['color', 'gradient'].map(f => [f, t(`hdriEditor.fills.${f}`)]), pin.fill, v => { pin.fill = v; this._renderSide(); this._change(); })));
        side.append(this._slider(t('hdriEditor.azimuth'), 'pin.azimuth', -180, 180, 0.5));
        side.append(this._slider(t('hdriEditor.elevation'), 'pin.elevation', -89, 89, 0.5));
        side.append(this._slider(t('hdriEditor.width'), 'pin.width', 0.5, 180, 0.5));
        side.append(this._slider(t('hdriEditor.height'), 'pin.height', 0.5, 180, 0.5));
        side.append(this._slider(t('hdriEditor.rotation'), 'pin.rotation', -180, 180, 1));
        if (pin.shape === 'rect') side.append(this._slider(t('hdriEditor.cornerRadius'), 'pin.cornerRadius', 0, 1, 0.01));
        side.append(this._slider(t('hdriEditor.falloff'), 'pin.falloff', 0, 2, 0.01));
        side.append(this._slider(t('hdriEditor.brightness'), 'pin.brightness', 0, 50, 0.05));
        side.append(row(t('hdriEditor.blend'), select([['add', t('hdriEditor.blends.add')], ['normal', t('hdriEditor.blends.normal')]], pin.blend, v => { pin.blend = v; this._change(); })));
        if (pin.fill === 'color') {
            side.append(row(t('hdriEditor.color'), colorInput(pin.color, v => { pin.color = v; this._change('live'); }, () => this._change())));
        }
        if (pin.fill === 'gradient') {
            side.append(row(t('hdriEditor.gradientType'), select([['linear', t('hdriEditor.gradientTypes.linear')], ['radial', t('hdriEditor.gradientTypes.radial')]], pin.gradient.type, v => { pin.gradient.type = v; this._change(); })));
            side.append(gradientEditor({ stops: pin.gradient.stops, min: 0, max: 1, step: 0.01, onChange: kind => this._change(kind) }));
        }
    }

    // slider + number for a value path ('background.brightness', 'sky.sunSize', 'pin.width' = selected pin, …)
    _slider(label, path, min, max, step) {
        const value = readPath(this.doc, path, this.sel) ?? 0;
        const range = el('input', RANGE);
        range.type = 'range';
        Object.assign(range, { min, max, step, value });
        range.dataset.bind = path;
        const num = el('input', INPUT.replace('w-full', 'w-14') + ' flex-none');
        num.type = 'number';
        Object.assign(num, { min, max, step, value: fmt(value) });
        num.dataset.bind = path;
        // width and height independent – also for circle pins (ellipses)
        const set = (v, kind) => {
            writePath(this.doc, path, this.sel, v);
            this._change(kind);
        };
        range.oninput = () => { num.value = fmt(Number(range.value)); set(Number(range.value), 'live'); };
        range.onchange = () => set(Number(range.value), 'commit');
        num.onchange = () => { const v = Number(num.value); if (Number.isFinite(v)) { range.value = v; set(v, 'commit'); } };
        // drag the number sideways like the panels (300 px = whole range, Shift faster, Alt finer)
        draggable(num, {
            perPixel: () => (max - min) / 300, min, max, step,
            onDrag: v => { range.value = v; set(v, 'live'); },
            onEnd: () => set(Number(num.value), 'commit'),
        });
        return row(label, range, num);
    }

    _addPin(type) {
        const pin = createPin(type, { azimuth: round(wrap180((this.doc.pins.length * 47) % 360 - 120), 1) });
        this.doc.pins.push(pin);
        this.sel = pin.id;
        this._renderSide();
        this._change();
    }
}

// --- geometry (same frame as hdri-render.js) ---

function frame(pin) {
    const n = direction(pin.azimuth, pin.elevation);
    const a = pin.azimuth * D, e = pin.elevation * D;
    const east = [-Math.sin(a), 0, Math.cos(a)];
    const north = [-Math.sin(e) * Math.cos(a), Math.cos(e), -Math.sin(e) * Math.sin(a)];
    const r = (pin.rotation || 0) * D, cr = Math.cos(r), sr = Math.sin(r);
    return {
        n,
        ex: [0, 1, 2].map(k => cr * east[k] + sr * north[k]),
        ey: [0, 1, 2].map(k => -sr * east[k] + cr * north[k]),
        hw: Math.max(pin.width, 0.05) / 2 * D, hh: Math.max(pin.height, 0.05) / 2 * D,
    };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// local point (angles lx, ly) → direction
function localDir(f, lx, ly) {
    return norm([0, 1, 2].map(k => f.n[k] + Math.tan(lx) * f.ex[k] + Math.tan(ly) * f.ey[k]));
}
// circle: point at angle `ang` towards φ
function circleDir(f, phi, ang) {
    return [0, 1, 2].map(k => Math.cos(ang) * f.n[k] + Math.sin(ang) * (Math.cos(phi) * f.ex[k] + Math.sin(phi) * f.ey[k]));
}

function outlineDirs(pin, f) {
    const pts = [];
    if (pin.shape === 'circle') {
        for (let i = 0; i <= 72; i++) {
            const phi = i / 72 * 2 * Math.PI;
            pts.push(circleDir(f, phi, 1 / Math.hypot(Math.cos(phi) / f.hw, Math.sin(phi) / f.hh)));
        }
        return pts;
    }
    const rc = Math.min(Math.max(pin.cornerRadius || 0, 0), 1) * Math.min(f.hw, f.hh);
    const ax = f.hw - rc, ay = f.hh - rc;
    // corners (arcs) counter-clockwise, edges sampled in between
    const corners = [[ax, ay, 0], [-ax, ay, Math.PI / 2], [-ax, -ay, Math.PI], [ax, -ay, 1.5 * Math.PI]];
    let prev = null;
    const edge = (p, q) => { for (let i = 1; i < 12; i++) { const s = i / 12; pts.push(localDir(f, p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s)); } };
    const first = [];
    for (const [cx, cy, a0] of corners) {
        const arc = [];
        const n = rc > 0 ? 8 : 1;
        for (let i = 0; i < n; i++) { const a = a0 + (rc > 0 ? i / (n - 1) : 0) * Math.PI / 2; arc.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc]); }
        if (prev) edge(prev, arc[0]); else first.push(arc[0]);
        for (const p of arc) pts.push(localDir(f, p[0], p[1]));
        prev = arc[arc.length - 1];
    }
    edge(prev, first[0]);
    pts.push(localDir(f, first[0][0], first[0][1]));
    return pts;
}

function toCanvas(dir) {
    const u = Math.atan2(dir[2], dir[0]) / (2 * Math.PI) + 0.5;
    const v = Math.asin(Math.min(Math.max(dir[1], -1), 1)) / Math.PI + 0.5;
    return [u * CW, (1 - v) * CH];
}
function toAzEl(x, y) { return [(x / CW - 0.5) * 360, (0.5 - y / CH) * 180]; }

// SVG path; a jump across the seam (|Δx| > half the width) starts a new sub-path
function outlinePath(pin, f) {
    let d = '', last = null;
    for (const dir of outlineDirs(pin, f)) {
        const [x, y] = toCanvas(dir);
        d += (last === null || Math.abs(x - last) > CW / 2 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
        last = x;
    }
    return d;
}

// size handle: rectangle at its corner; circle/ellipse at the boundary point (hw, hh) / √2 – dragging it sets both
// semi-axes independently and the handle stays under the pointer
function sizeHandleDir(pin, f) {
    if (pin.shape === 'circle') return circleDir(f, Math.atan2(f.hh, f.hw), Math.hypot(f.hw, f.hh) * Math.SQRT1_2);
    return localDir(f, f.hw, f.hh);
}

function localOf(f, dir) {
    const d = dot(dir, f.n), u = dot(dir, f.ex), w = dot(dir, f.ey);
    return { d, u, w, lx: Math.atan2(u, d), ly: Math.atan2(w, d) };
}

function pinContains(pin, dir) {
    const f = frame(pin), l = localOf(f, dir);
    if (l.d <= 0) return false;
    if (pin.shape === 'circle') {
        const ang = Math.acos(Math.min(l.d, 1)), len = Math.hypot(l.u, l.w) || 1;
        return ang * Math.hypot(l.u / len / f.hw, l.w / len / f.hh) <= 1;
    }
    return Math.abs(l.lx) <= f.hw && Math.abs(l.ly) <= f.hh;
}

// size handle dragged to `dir`
function resizeTo(pin, dir) {
    const f = frame(pin), l = localOf(f, dir);
    if (l.d <= 0.05) return;
    if (pin.shape === 'circle') {
        // pointer in local polar coordinates (angle from the centre along its direction) = (hw, hh) / √2
        const ang = Math.acos(Math.min(l.d, 1)), len = Math.hypot(l.u, l.w) || 1;
        const px = Math.abs(ang * l.u / len), py = Math.abs(ang * l.w / len);
        pin.width = round(Math.min(Math.max(2 * Math.SQRT2 * px / D, 0.5), 180), 1);
        pin.height = round(Math.min(Math.max(2 * Math.SQRT2 * py / D, 0.5), 180), 1);
        return;
    }
    pin.width = round(Math.min(Math.max(2 * Math.abs(l.lx) / D, 0.5), 178), 1);
    pin.height = round(Math.min(Math.max(2 * Math.abs(l.ly) / D, 0.5), 178), 1);
}

// --- helpers ---

const pinType = pin => (pin.fill === 'gradient' ? 'gradient' : pin.shape === 'circle' ? 'circle' : 'rect');
const round = (v, d) => { const m = 10 ** d; return Math.round(v * m) / m; };
const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;

function readPath(doc, path, selId) {
    const parts = path.split('.');
    let o = parts[0] === 'pin' ? doc.pins.find(p => p.id === selId) : doc[parts[0]];
    for (const p of parts.slice(1)) o = o?.[p];
    return o;
}
function writePath(doc, path, selId, value) {
    const parts = path.split('.');
    let o = parts[0] === 'pin' ? doc.pins.find(p => p.id === selId) : doc[parts[0]];
    for (const p of parts.slice(1, -1)) o = o?.[p];
    if (o) o[parts[parts.length - 1]] = value;
}

function loadWindowState() {
    try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (s && typeof s === 'object') return s;
    } catch { /* storage blocked */ }
    return {};
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}
function heading(text) { return el('div', 'mt-2 mb-1 font-medium text-white/80 first:mt-0', text); }
function hint(text) { return el('div', 'mb-1.5 text-white/40', text); }
function row(label, ...controls) {
    const r = el('div', 'mb-1 grid grid-cols-[5.5rem_1fr] items-center gap-1.5');
    const box = el('div', 'flex min-w-0 items-center gap-1');
    box.append(...controls);
    r.append(el('span', 'truncate text-white/60', label), box);
    return r;
}
function select(options, value, onChange) {
    const s = el('select', SELECT);
    for (const [v, label] of options) s.append(new Option(label, v));
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
}
function colorInput(value, onInput, onCommit) {
    return colorField(value, { onInput, onChange: () => onCommit() });
}
function iconButton(label, title, onClick) {
    const b = el('button', 'size-5 shrink-0 rounded text-white/60 hover:bg-white/15 hover:text-white disabled:opacity-30', label);
    b.title = title;
    b.onclick = onClick;
    return b;
}
