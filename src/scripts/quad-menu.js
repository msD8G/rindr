// Quad menu (like MAX): a right click without movement opens panels around the mouse pointer.
// Panels sit in the quadrants top right ('tr'), bottom right ('br'), top left ('tl'),
// bottom left ('bl') – each with one corner at the click point. Mirrored at the screen edge.
// Close: click outside, Esc, choosing an entry, mouse wheel.
// Labels and titles arrive already translated (caller uses t()).

// Same style as the other panels (Scene Graph, materials): dark translucent with blur, no border
const PANEL = 'pointer-events-auto absolute min-w-44 rounded-lg bg-black/60 p-1 text-xs text-white/90 backdrop-blur-sm';
const TITLE = 'px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-white/40 uppercase';
const ITEM = 'flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left outline-none hover:bg-white/10 focus-visible:bg-white/10';

export class QuadMenu {
    constructor(container = document.body) {
        this.root = document.createElement('div');
        this.root.className = 'pointer-events-none fixed inset-0 z-30';
        this.root.hidden = true;
        container.append(this.root);
        this._onDown = e => { if (!this.root.contains(e.target) || e.target === this.root) this.close(); };
        this._onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } };
        this._onWheel = () => this.close();
    }

    get isOpen() {
        return !this.root.hidden;
    }

    /**
     * @param {number} x  screen coordinates of the click
     * @param {number} y
     * @param {{ title: string, quadrant: 'tr'|'br'|'tl'|'bl', items: { label: string, shortcut?: string, active?: boolean, disabled?: boolean, onClick: () => void }[] }[]} panels
     */
    open(x, y, panels) {
        this.close();
        const frag = document.createDocumentFragment();
        const placed = [];
        for (const p of panels) {
            const panel = document.createElement('div');
            panel.className = PANEL;
            const title = document.createElement('div');
            title.className = TITLE;
            title.textContent = p.title;
            panel.append(title);
            for (const it of p.items) {
                const b = document.createElement('button');
                b.className = ITEM + (it.disabled ? ' cursor-default opacity-35 hover:bg-transparent' : '') + (it.active ? ' bg-sky-500/30' : '');
                b.disabled = !!it.disabled;
                const label = document.createElement('span');
                label.textContent = it.label;
                b.append(label);
                if (it.shortcut) {
                    const k = document.createElement('span');
                    k.className = 'text-white/35';
                    k.textContent = it.shortcut;
                    b.append(k);
                }
                b.onclick = () => { this.close(); it.onClick(); };
                panel.append(b);
            }
            frag.append(panel);
            placed.push([panel, p.quadrant]);
        }
        this.root.replaceChildren(frag);
        this.root.hidden = false;
        // size is only known after insertion: place panels at the click point, mirror at the edge
        const W = window.innerWidth, H = window.innerHeight, gap = 2;
        for (const [panel, q] of placed) {
            const { width: w, height: h } = panel.getBoundingClientRect();
            let right = q.endsWith('r'), top = q.startsWith('t');
            if (right && x + w > W) right = false; else if (!right && x - w < 0) right = true;
            if (top && y - h < 0) top = false; else if (!top && y + h > H) top = true;
            panel.style.left = `${right ? x + gap : x - w - gap}px`;
            panel.style.top = `${top ? y - h - gap : y + gap}px`;
        }
        document.addEventListener('pointerdown', this._onDown, true);
        window.addEventListener('keydown', this._onKey, true);
        window.addEventListener('wheel', this._onWheel, { passive: true, capture: true });
    }

    close() {
        if (this.root.hidden) return;
        this.root.hidden = true;
        this.root.replaceChildren();
        document.removeEventListener('pointerdown', this._onDown, true);
        window.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('wheel', this._onWheel, { capture: true });
    }
}
