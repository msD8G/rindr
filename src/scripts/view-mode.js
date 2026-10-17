// View mode (button group bottom centre, keys 1/2/3), tools next to it on the right
// (hide/show UI, fullscreen – addTool):
//  - analysis (first button, key 1 – again: next variant; the small arrow opens the choice): one material for the
//    whole model (scene.overrideMaterial, materials are kept) – basic (grey clay), uv (UV test pattern, uv-checker.js),
//    wire (clay with its edges as a wireframe)
//  - default: raster view with all materials and textures
//  - hq:      path tracing while still (raster preview while orbiting)

import { t } from './i18n.js';

// labelKey/titleKey: i18n keys, translated when the buttons are created

// analysis variants behind the first button
export const ANALYSIS_MODES = [
    {
        key: 'basic', labelKey: 'viewMode.basic.label', titleKey: 'viewMode.basic.title',
        ball: 'radial-gradient(circle at 32% 28%, #f0f0f0 0, #a3a3a3 30%, #6e6e6e 62%, #2b2b2b 100%)',
    },
    {
        key: 'uv', labelKey: 'viewMode.uv.label', titleKey: 'viewMode.uv.title',
        ball: 'linear-gradient(90deg, transparent 47%, #0006 47% 53%, transparent 53%) 0 0/50% 50%, linear-gradient(0deg, transparent 47%, #0006 47% 53%, transparent 53%) 0 0/50% 50%, linear-gradient(to bottom, #3fae5a, #3a6fd8), linear-gradient(to bottom, #e8c83a, #d84a3a) right/50% 100% no-repeat',
    },
    {
        key: 'wire', labelKey: 'viewMode.wire.label', titleKey: 'viewMode.wire.title',
        ball: 'linear-gradient(60deg, transparent 46%, #222 46% 54%, transparent 54%), linear-gradient(-60deg, transparent 46%, #222 46% 54%, transparent 54%), linear-gradient(0deg, transparent 46%, #222 46% 54%, transparent 54%), radial-gradient(circle at 32% 28%, #f0f0f0 0, #a3a3a3 45%, #6e6e6e 100%)',
    },
];

export const VIEW_MODES = [
    { ...ANALYSIS_MODES[0], analysis: true },
    {
        key: 'default', labelKey: 'viewMode.default.label', titleKey: 'viewMode.default.title',
        ball: 'radial-gradient(circle at 32% 28%, #ffffff 0, #e8643f 16%, #b93a1f 55%, #3d1007 100%)',
    },
    {
        key: 'hq', labelKey: 'viewMode.hq.label', titleKey: 'viewMode.hq.title',
        ball: 'radial-gradient(circle at 32% 24%, #ffffff 0 7%, transparent 20%), '
            + 'linear-gradient(180deg, #e6eef6 0%, #9fb4c9 42%, #1c2631 50%, #4d5b68 66%, #c4ced8 100%)',
    },
];

export class ViewModeBar {
    /**
     * @param {HTMLElement} root
     * @param {(mode: string) => void} onSelect
     */
    constructor(root, onSelect) {
        this.root = root;
        this.buttons = new Map();
        root.className = 'pointer-events-auto absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-black/60 p-1 text-xs text-white/80 backdrop-blur-sm';
        this.onSelect = onSelect;
        this.analysis = 'basic';   // variant shown on the first button (the last one chosen)
        for (const m of VIEW_MODES) {
            const b = document.createElement('button');
            b.title = t(m.titleKey);
            b.className = 'relative flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 outline-none transition-colors';
            const ball = document.createElement('span');
            ball.className = 'size-5 shrink-0 rounded-full shadow-[inset_0_-1px_2px_rgba(0,0,0,0.4)]';
            ball.style.background = m.ball;
            const label = document.createElement('span');
            label.textContent = t(m.labelKey);
            b.append(ball, label);
            b.onclick = () => onSelect(m.analysis ? this.analysis : m.key);
            if (m.analysis) {
                // small arrow: choice of the analysis variants above the bar
                const arrow = document.createElement('span');
                arrow.className = '-mr-1.5 flex size-4 items-center justify-center rounded-full text-white/60 hover:bg-white/15 hover:text-white';
                arrow.innerHTML = '<svg viewBox="0 0 16 16" class="size-3 fill-current"><path d="M4 10l4-4 4 4z"/></svg>';
                arrow.title = t('viewMode.analysisChoice');
                arrow.onclick = e => { e.stopPropagation(); this._toggleMenu(b); };
                b.append(arrow);
                b._ball = ball;
                b._label = label;
            }
            root.append(b);
            this.buttons.set(m.key, b);
        }
    }

    // choice of the analysis variants (above the first button, panel style)
    _toggleMenu(anchor) {
        if (this._menu) { this._closeMenu(); return; }
        const menu = document.createElement('div');
        menu.className = 'absolute bottom-full left-0 mb-2 flex flex-col gap-0.5 rounded-lg bg-black/60 p-1 text-xs text-white/85 shadow-xl backdrop-blur-sm';
        for (const m of ANALYSIS_MODES) {
            const item = document.createElement('button');
            item.className = 'flex items-center gap-2 rounded-md py-1 pr-3 pl-1 text-left whitespace-nowrap outline-none hover:bg-white/15'
                + (m.key === this.analysis ? ' text-white' : '');
            item.title = t(m.titleKey);
            const ball = document.createElement('span');
            ball.className = 'size-5 shrink-0 rounded-full shadow-[inset_0_-1px_2px_rgba(0,0,0,0.4)]';
            ball.style.background = m.ball;
            item.append(ball, t(m.labelKey));
            item.onclick = e => { e.stopPropagation(); this._closeMenu(); this.onSelect(m.key); };
            menu.append(item);
        }
        anchor.append(menu);
        this._menu = menu;
        // close on a click elsewhere or Esc
        this._outside = e => { if (!menu.contains(e.target)) this._closeMenu(); };
        this._esc = e => { if (e.key === 'Escape') this._closeMenu(); };
        setTimeout(() => { document.addEventListener('pointerdown', this._outside); document.addEventListener('keydown', this._esc); });
    }

    _closeMenu() {
        this._menu?.remove();
        this._menu = null;
        document.removeEventListener('pointerdown', this._outside);
        document.removeEventListener('keydown', this._esc);
    }

    _separator() {
        const sep = document.createElement('span');
        sep.className = 'mx-0.5 my-1 w-px self-stretch bg-white/15';
        return sep;
    }

    /** Action button styled like the view modes, right after them (e.g. AI next to HQ), with a separator before it */
    addAction({ label, title, ball, icon, onClick }) {
        const b = document.createElement('button');
        b.title = title;
        b.className = 'flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 outline-none transition-colors hover:bg-white/10';
        const dot = document.createElement('span');
        if (icon) {   // symbol (SVG) instead of a ball
            dot.className = 'flex size-5 shrink-0 items-center justify-center';
            dot.innerHTML = icon;
        } else {
            dot.className = 'size-5 shrink-0 rounded-full shadow-[inset_0_-1px_2px_rgba(0,0,0,0.4)]';
            dot.style.background = ball;
        }
        b.append(dot, label);
        b.onclick = () => { b.blur(); onClick(); };
        const last = [...this.buttons.values()].pop();
        this._actionSeparator ??= this._separator();
        last.after(this._actionSeparator, b);
        return b;
    }

    /**
     * Append an icon button: on the right, or on the left with start: true; group bundles buttons behind a separator.
     * @returns {(active: boolean, title?: string, enabled?: boolean) => void} set state (highlighted, tooltip, enabled); .button = the button
     */
    addTool({ icon, label, title, onClick, start = false, group = start ? 'start' : 'end' }) {
        // Groups with a separator: start = left of the view modes (groups created later go further
        // left), otherwise right (in creation order). Buttons of one group stay together.
        this._groups ??= new Map();
        let box = this._groups.get(group);
        if (!box) {
            box = document.createElement('span');
            box.className = 'flex items-center gap-1';
            const sep = this._separator();
            if (start) this.root.prepend(box, sep);
            else this.root.append(sep, box);
            box.separator = sep;
            this._groups.set(group, box);
        }
        const b = document.createElement('button');
        // label: icon + text (e.g. "Explosion"), otherwise a round icon button
        b.className = (label ? 'flex h-7 items-center gap-1.5 rounded-full pr-3 pl-2' : 'flex size-7 items-center justify-center rounded-full')
            + ' outline-none transition-colors hover:bg-white/10 hover:text-white';
        b.title = title;
        b.innerHTML = icon;
        if (label) b.append(label);
        b.onclick = () => { b.blur(); onClick(); };
        box.append(b);
        const set = (active, tip, enabled = true) => {
            b.classList.toggle('text-sky-300', active);
            b.disabled = !enabled;
            b.classList.toggle('opacity-30', !enabled);
            b.classList.toggle('pointer-events-none', !enabled);
            if (tip) b.title = tip;
        };
        set.button = b;   // e.g. to swap the icon
        return set;
    }

    /** Hide the view mode buttons (and the separator to the actions) and/or tool groups with their separator */
    setHidden({ modes = false, groups = [] } = {}) {
        for (const b of this.buttons.values()) b.hidden = modes;
        if (this._actionSeparator) this._actionSeparator.hidden = modes;
        for (const [key, box] of this._groups ?? []) box.hidden = box.separator.hidden = groups.includes(key);
    }

    /**
     * Show the active mode; disabled: modes not possible right now (e.g. HQ with Gaussian splats); unavailable: dimmed
     * but still clickable, the click explains why (e.g. HQ without WebGPU)
     */
    set(mode, { disabled = [], unavailable = [] } = {}) {
        // an analysis variant: the first button shows it (ball, label, tooltip) and keeps it for its next click
        const variant = ANALYSIS_MODES.find(m => m.key === mode);
        if (variant) {
            this.analysis = mode;
            const b = this.buttons.get('basic');
            b._ball.style.background = variant.ball;
            b._label.textContent = t(variant.labelKey);
            b.title = t(variant.titleKey);
        }
        for (const [key, b] of this.buttons) {
            const active = key === mode || (key === 'basic' && !!variant);
            b.disabled = disabled.includes(key);
            const dim = b.disabled || unavailable.includes(key);
            b.setAttribute('aria-disabled', String(dim));
            b.classList.toggle('bg-white/20', active);
            b.classList.toggle('text-white', active);
            b.classList.toggle('hover:bg-white/10', !active && !dim);
            b.classList.toggle('opacity-40', dim);
        }
    }
}
