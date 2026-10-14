// View mode (button group bottom centre, keys 1/2/3), tools next to it on the right
// (hide/show UI, fullscreen – addTool):
//  - basic:   whole model in one grey material (scene.overrideMaterial, materials are kept)
//  - default: raster view with all materials and textures
//  - hq:      path tracing while still (raster preview while orbiting)

import { t } from './i18n.js';

// labelKey/titleKey: i18n keys, translated when the buttons are created

export const VIEW_MODES = [
    {
        key: 'basic', labelKey: 'viewMode.basic.label', titleKey: 'viewMode.basic.title',
        ball: 'radial-gradient(circle at 32% 28%, #f0f0f0 0, #a3a3a3 30%, #6e6e6e 62%, #2b2b2b 100%)',
    },
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
        for (const m of VIEW_MODES) {
            const b = document.createElement('button');
            b.title = t(m.titleKey);
            b.className = 'flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 outline-none transition-colors';
            const ball = document.createElement('span');
            ball.className = 'size-5 shrink-0 rounded-full shadow-[inset_0_-1px_2px_rgba(0,0,0,0.4)]';
            ball.style.background = m.ball;
            b.append(ball, t(m.labelKey));
            b.onclick = () => onSelect(m.key);
            root.append(b);
            this.buttons.set(m.key, b);
        }
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

    /** Show the active mode; disabled: unavailable modes (e.g. HQ without WebGPU) */
    set(mode, { disabled = [] } = {}) {
        for (const [key, b] of this.buttons) {
            const active = key === mode;
            b.disabled = disabled.includes(key);
            b.classList.toggle('bg-white/20', active);
            b.classList.toggle('text-white', active);
            b.classList.toggle('hover:bg-white/10', !active && !b.disabled);
            b.classList.toggle('opacity-40', b.disabled);
        }
    }
}
