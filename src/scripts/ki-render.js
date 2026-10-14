// AI rendering: finished HQ image + material description to the image AI (Google Gemini, called directly
// from the browser with the user's own API key from the settings – ki-gemini.js; no server).
//
// Flow: AI button → current view (Default/Basic immediately, HQ: wait for the finished, denoised image)
// → capture the image without
// gizmo/highlight → dialog with an automatically generated prompt (material names + properties
// + parts, editable) → send → before/after comparison (slider), download, history.
// Identical requests come from the browser's own store (IndexedDB, "Regenerate" forces a new call).
// The prompt comes from the language file (ki.prompt.*), so it is written in the UI language.
// Errors carry a machine-readable code → ki.errors.<CODE>, otherwise the English message.

import { confirmDialog, messageDialog, dialogOpen } from './dialog.js';
import { t, has, getLocale } from './i18n.js';
import { kiSettings, render, history, removeRender } from './ki-gemini.js';

const TIMEOUT_MS = 240000;
const BTN = 'rounded bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20 disabled:opacity-40';
const BTN_PRIMARY = 'rounded bg-sky-500/80 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40';

const el = (tag, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

/**
 * Prompt from the materials of the visible parts. Unnamed CAD colours ("STEP #RRGGBB") are described as
 * a colour – the AI then derives the material from the part names.
 * @param {{ name: string, color: string, description: string, parts: string[], partCount: number, cad: boolean }[]} materials
 */
export function buildPrompt(title, materials, { environment = '' } = {}) {
    const lines = [];
    lines.push(title ? t('ki.prompt.introTitled', { title }) : t('ki.prompt.intro'));
    if (environment) lines.push(environment);
    lines.push('');
    lines.push(t('ki.prompt.materialsHeading'));
    for (const m of materials) {
        const label = m.cad ? t('ki.prompt.cadMaterial', { color: m.color }) : t('ki.prompt.namedMaterial', { name: m.name, color: m.color });
        const params = { label, description: m.description, parts: m.parts.join(', '), total: m.partCount };
        const key = !m.parts.length ? 'materialLine' : m.partCount > m.parts.length ? 'materialLineMoreParts' : 'materialLineParts';
        lines.push(t(`ki.prompt.${key}`, params));
    }
    lines.push('');
    lines.push(t('ki.prompt.closing'));
    return lines.join('\n');
}

/** Short description of a material from its parameters (MeshPhysicalMaterial values) */
export function describeMaterial(p = {}) {
    const out = [];
    const r = p.roughness ?? 0.5;
    if ((p.transmission ?? 0) > 0.5) out.push(p.ior ? t('ki.material.glassIor', { ior: (+p.ior).toFixed(2) }) : t('ki.material.glass'));
    else if ((p.metalness ?? 0) > 0.5) out.push(t('ki.material.metal'));
    else out.push(t('ki.material.dielectric'));
    out.push(t(`ki.material.${r < 0.12 ? 'polished' : r < 0.35 ? 'glossy' : r < 0.6 ? 'satin' : 'matte'}`));
    if ((p.clearcoat ?? 0) > 0.3) out.push(t('ki.material.clearcoat'));
    if ((p.sheen ?? 0) > 0.3) out.push(t('ki.material.sheen'));
    if (p.emissive && p.emissive !== '#000000') out.push(t('ki.material.emissive', { color: p.emissive }));
    return out.join(', ');
}

/** Error text: translated by code (ki.errors.<CODE>, KiError), else the English message */
function errorText(err) {
    if (err?.name === 'TimeoutError') return t('ki.errors.TIMEOUT', { seconds: TIMEOUT_MS / 1000 });
    return err?.code && has(`ki.errors.${err.code}`) ? t(`ki.errors.${err.code}`, err.params || {}) : err?.message || String(err);
}

const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

export class KiRender {
    /**
     * @param {object} ctx
     *   waitForImage(onProgress): Promise – in HQ wait for the finished image, otherwise immediately
     *   capture(): Promise<string> – data: URL of the current image (without gizmo/highlight)
     *   getTitle(): string, getMaterials(): Material[] (see buildPrompt), getEnvironment(): string
     *   openSettings(): settings menu on the AI page (API key)
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.size = kiSettings.size;
        // no dark overlay over the whole viewer: only the panel is visible (style like the settings menu);
        // the area around it lets clicks through, a click next to the panel closes it
        this.root = el('div', 'pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-5 text-xs text-white/90');
        this.root.hidden = true;
        document.body.append(this.root);
        document.addEventListener('pointerdown', e => {
            const panel = this.root.firstElementChild;
            if (dialogOpen()) return;   // question dialog on top (e.g. delete)
            if (this.isOpen && !this.busy && panel && !panel.contains(e.target)) this.close();
        }, true);
        window.addEventListener('keydown', e => { if (e.key === 'Escape' && !this.root.hidden && !this.busy && !dialogOpen()) { e.stopPropagation(); this.close(); } }, true);
    }

    get isOpen() {
        return !this.root.hidden;
    }

    close() {
        this.root.hidden = true;
        this.root.replaceChildren();
    }

    _panel(cls = 'w-full max-w-3xl') {
        const p = el('div', `${cls} pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-lg bg-black/60 shadow-2xl backdrop-blur-sm`);
        this.root.replaceChildren(p);
        this.root.hidden = false;
        return p;
    }

    _header(panel, title, extra = []) {
        const h = el('div', 'flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2.5');
        h.append(el('span', 'font-medium', title), el('span', 'flex-1'), ...extra);
        const x = el('button', 'text-white/50 hover:text-white');
        x.innerHTML = ICON_CLOSE;
        x.title = t('ki.close');
        x.onclick = () => this.close();
        h.append(x);
        panel.append(h);
    }

    /** AI button: (in HQ wait for the finished image,) capture, show the dialog */
    async start() {
        if (this.busy) return;
        if (!kiSettings.apiKey) return this.showNoKey();
        this.size = kiSettings.size;
        const panel = this._panel('w-full max-w-md');
        this._header(panel, t('ki.title'));
        const body = el('div', 'p-4');
        const label = el('div', 'mb-2 text-white/70', t('ki.preparing'));
        const bar = el('div', 'h-1 overflow-hidden rounded bg-white/15');
        const fill = el('div', 'h-full w-0 rounded bg-sky-400 transition-[width] duration-200');
        bar.append(fill);
        body.append(label, bar);
        panel.append(body);
        this.busy = true;
        try {
            await this.ctx.waitForImage((text, p) => { label.textContent = text; fill.style.width = `${Math.round(p * 100)}%`; });
            this.image = await this.ctx.capture();
        } catch (err) {
            this.busy = false;
            label.textContent = t('ki.aborted', { message: err.message });
            return;
        }
        this.busy = false;
        this.materials = this.ctx.getMaterials();
        this.prompt = buildPrompt(this.ctx.getTitle(), this.materials, { environment: this.ctx.getEnvironment() });
        this.showDialog();
    }

    /** No API key yet: hint + button to the settings */
    showNoKey() {
        const panel = this._panel('w-full max-w-md');
        this._header(panel, t('ki.title'));
        const body = el('div', 'flex flex-col gap-3 p-4');
        const open = el('button', BTN_PRIMARY + ' self-start', t('ki.openSettings'));
        open.onclick = () => { this.close(); this.ctx.openSettings(); };
        body.append(el('div', 'text-white/70', t('ki.noKey')), open);
        panel.append(body);
    }

    showDialog(error = '') {
        const panel = this._panel();
        const hist = el('button', BTN, t('ki.history'));
        hist.onclick = () => this.showHistory();
        this._header(panel, t('ki.title'), [hist]);
        const body = el('div', 'grid min-h-0 gap-4 overflow-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]');
        const preview = el('div', 'flex flex-col gap-2');
        const img = el('img', 'w-full rounded ring-1 ring-white/10');
        img.src = this.image;
        preview.append(img, el('div', 'text-white/50', t('ki.previewHint')));

        const form = el('div', 'flex min-w-0 flex-col gap-2');
        const head = el('div', 'flex items-center justify-between');
        head.append(el('span', 'text-white/70', t('ki.promptLabel')));
        const reset = el('button', 'text-white/50 hover:text-white', t('ki.reset'));
        reset.onclick = () => { this.prompt = buildPrompt(this.ctx.getTitle(), this.materials, { environment: this.ctx.getEnvironment() }); area.value = this.prompt; };
        head.append(reset);
        const area = el('textarea', 'min-h-64 w-full flex-1 resize-y rounded bg-white/5 p-2 font-mono text-[11px] leading-relaxed text-white/90 ring-1 ring-white/10 outline-none focus:ring-sky-400/60');
        area.value = this.prompt;
        area.spellcheck = false;
        area.oninput = () => { this.prompt = area.value; };

        const row = el('div', 'flex flex-wrap items-center gap-2');
        const size = el('select', 'rounded bg-white/10 px-1.5 py-1 outline-none');
        for (const s of ['1K', '2K', '4K']) size.append(new Option(t('ki.resolution', { size: s }), s));
        size.value = this.size;
        size.onchange = () => { this.size = kiSettings.size = size.value; };
        const send = el('button', BTN_PRIMARY + ' ml-auto', t('ki.send'));
        send.onclick = () => this.send();
        row.append(size, send);
        form.append(head, area, row);
        if (error) form.append(el('div', 'rounded bg-red-500/15 px-2 py-1.5 text-red-200', error));
        body.append(preview, form);
        panel.append(body);
        area.focus();
    }

    async send({ force = false } = {}) {
        const panel = this._panel('w-full max-w-md');
        this._header(panel, t('ki.title'));
        const body = el('div', 'flex items-center gap-3 p-4');
        const spin = el('div', 'size-4 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-sky-400');
        const t0 = performance.now();
        const label = el('div', 'text-white/70', t('ki.rendering'));
        const timer = setInterval(() => { label.textContent = t('ki.renderingTimer', { seconds: Math.round((performance.now() - t0) / 1000) }); }, 500);
        body.append(spin, label);
        panel.append(body);
        this.busy = true;
        try {
            // image: data: URL of the capture or (from the history) the stored input image's object URL
            const entry = await render({
                image: this.image, prompt: this.prompt, title: this.ctx.getTitle(), size: this.size, force,
                materials: this.materials.map(({ name, color, description, parts }) => ({ name, color, description, parts })),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            this.showResult(entry);
        } catch (err) {
            this.showDialog(t('ki.error', { message: errorText(err) }));
        } finally {
            clearInterval(timer);
            this.busy = false;
        }
    }

    /** Before/after with a slider */
    showResult(entry) {
        this.entry = entry;
        const panel = this._panel('h-full w-full max-w-[min(100%,1600px)]');
        const info = el('span', 'text-white/50', t(entry.cached ? 'ki.resultInfoCached' : 'ki.resultInfo', { model: entry.model, size: entry.size, seconds: (entry.duration_ms / 1000).toFixed(1) }));
        const again = el('button', BTN, t('ki.regenerate'));
        again.title = t('ki.regenerateTitle');
        again.onclick = () => this.send({ force: true });
        const edit = el('button', BTN, t('ki.editPrompt'));
        edit.onclick = () => {
            if (!this.image) { this.image = entry.input_url; this.prompt = entry.prompt; this.materials = []; }
            this.showDialog();
        };
        const dl = el('a', BTN_PRIMARY, t('ki.download'));
        dl.href = entry.output_url;
        dl.download = `${entry.title || 'rindr'}-ki-${entry.id.slice(0, 6)}.${entry.output?.type === 'image/jpeg' ? 'jpg' : 'png'}`;
        const hist = el('button', BTN, t('ki.history'));
        hist.onclick = () => this.showHistory();
        const del = el('button', BTN + ' hover:bg-red-500/40', t('ki.delete'));
        del.title = t('ki.deleteTitle');
        del.onclick = async () => { if (await this.remove(entry.id)) { this.entry = null; this.showHistory(); } };
        this._header(panel, t('ki.resultTitle'), [info, hist, edit, again, del, dl]);

        const stage = el('div', 'relative min-h-0 flex-1 cursor-ew-resize touch-none select-none overflow-hidden bg-black');
        const after = el('img', 'absolute inset-0 h-full w-full object-contain');
        after.src = entry.output_url;
        const before = el('img', 'absolute inset-0 h-full w-full object-contain');
        before.src = entry.input_url;
        const line = el('div', 'pointer-events-none absolute inset-y-0 w-0.5 bg-white/80 shadow');
        const knob = el('div', 'pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 text-center text-[11px] leading-7 text-black shadow', '⇔');
        const tagL = el('div', 'pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-white/80', t('ki.tagViewer'));
        const tagR = el('div', 'pointer-events-none absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-white/80', t('ki.tagAi'));
        // images not draggable via drag & drop (otherwise the browser drags the image instead of the slider –
        // and the drop on the window ended up in the file import: "format not supported")
        for (const img of [after, before]) { img.draggable = false; img.classList.add('pointer-events-none'); }
        stage.append(after, before, line, knob, tagL, tagR);
        const setPos = f => {
            f = Math.min(Math.max(f, 0), 1);
            before.style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
            line.style.left = knob.style.left = `${f * 100}%`;
        };
        setPos(0.5);
        const move = e => { const r = stage.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width); };
        stage.addEventListener('pointerdown', e => { e.preventDefault(); stage.setPointerCapture(e.pointerId); move(e); });
        stage.addEventListener('pointermove', e => { if (stage.hasPointerCapture(e.pointerId)) move(e); });
        stage.addEventListener('dragstart', e => e.preventDefault());
        panel.append(stage);
        if (entry.model_text) panel.append(el('div', 'shrink-0 border-t border-white/10 px-4 py-2 text-white/50', t('ki.modelText', { text: entry.model_text })));
    }

    /** Delete a stored AI result (after confirmation); true on success */
    async remove(id) {
        if (!await confirmDialog({ title: t('ki.deleteDialogTitle'), message: t('ki.confirmDelete'), confirmLabel: t('ki.delete'), danger: true })) return false;
        try {
            await removeRender(id);
            return true;
        } catch (err) {
            messageDialog({ title: t('ki.deleteDialogTitle'), message: t('ki.deleteFailed', { message: errorText(err) }) });
            return false;
        }
    }

    async showHistory() {
        const panel = this._panel();
        const back = el('button', BTN, t('ki.back'));
        back.hidden = !this.image && !this.entry;
        back.onclick = () => (this.entry ? this.showResult(this.entry) : this.showDialog());
        this._header(panel, t('ki.historyTitle'), [back]);
        const grid = el('div', 'grid min-h-0 grid-cols-2 gap-3 overflow-auto p-4 sm:grid-cols-3', '');
        panel.append(grid);
        try {
            const items = await history(60);
            if (!items.length) grid.append(el('div', 'col-span-full text-white/50', t('ki.empty')));
            for (const it of items) {
                const card = el('button', 'group relative flex flex-col gap-1 rounded p-1 text-left hover:bg-white/10');
                const img = el('img', 'aspect-video w-full rounded bg-black object-cover ring-1 ring-white/10');
                img.loading = 'lazy';
                img.src = it.output_url;
                card.append(img, el('div', 'truncate text-white/80', it.title || it.id), el('div', 'text-white/40', new Date(it.created).toLocaleString(getLocale())));
                card.onclick = () => this.showResult({ ...it, cached: true });
                const del = el('span', 'absolute top-2 right-2 hidden size-6 items-center justify-center rounded-full bg-black/70 text-white/80 group-hover:flex hover:bg-red-500/80 hover:text-white', '✕');
                del.title = t('ki.delete');
                del.onclick = async e => {
                    e.stopPropagation();
                    if (!(await this.remove(it.id))) return;
                    if (this.entry?.id === it.id) this.entry = null;
                    card.remove();
                    if (!grid.querySelector('button')) grid.append(el('div', 'col-span-full text-white/50', t('ki.empty')));
                };
                card.append(del);
                grid.append(card);
            }
        } catch (err) {
            grid.append(el('div', 'col-span-full text-red-200', t('ki.historyFailed', { message: errorText(err) })));
        }
    }
}
