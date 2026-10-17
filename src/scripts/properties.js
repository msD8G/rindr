// Properties panel for the selected scene-graph entry.
//  - Model/assembly/part: translation + rotation (XYZ), gizmo mode, reset
//  - Light: position (XYZ), intensity, colour
//  - Environment: intensity, rotation, show background, ground shadow, ground reflection, bad weather (puddles),
//    flatten ground (+ capture height)
//  - Camera: focal length (FOV)
//  - Section plane: position + rotation, axis X/Y/Z, flip side, colour of the cut surface
import { viewAngle, setViewAngle, PERSPECTIVE_LIMIT, MAX_VIEW_ANGLE } from './fisheye.js';
import { Euler } from 'three/webgpu';
import { t, has } from './i18n.js';
import { draggable, fmt, INPUT, colorField } from './ui-controls.js';

let checkId = 0;   // ids for <label for>

// expanded effect sections in the camera panel (per browser, not in the scene)
const EXPANDED_KEY = 'rindr.expandedSections';
const expanded = new Set((() => { try { return JSON.parse(localStorage.getItem(EXPANDED_KEY)) || []; } catch { return []; } })());
const saveExpanded = () => { try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch { /* storage blocked */ } };
const BUTTON = 'rounded px-2 py-0.5 text-white/80 hover:bg-white/15';
const BUTTON_ACTIVE = 'rounded bg-sky-500/40 px-2 py-0.5 text-white';
const ICON_PENCIL = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/><path d="M9 4l3 3"/></svg>';

// transform mode / reset as icons (the German labels ran out of the panel); label as title + aria-label
const ICON_SVG = '<svg viewBox="0 0 16 16" class="size-4 fill-none stroke-current" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
const TRANSFORM_ICONS = {
    // four-way arrow
    translate: ICON_SVG + '<path d="M8 1.5v13M1.5 8h13"/><path d="M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"/></svg>',
    // circular arrow
    rotate: ICON_SVG + '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v2.5h-2.5"/></svg>',
    // small box growing to a large one
    scale: ICON_SVG + '<rect x="1.5" y="8.5" width="6" height="6" rx="0.5"/><path d="M1.5 5.5v-4h13v13h-4"/><path d="M7.5 8.5l4-4M8.5 4.5h3v3"/></svg>',
    // arrow back to the origin
    reset: ICON_SVG + '<path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.5v2.5h2.5"/><circle cx="8" cy="8" r="1"/></svg>',
};
const ICON_BUTTON = ' flex items-center justify-center px-1.5 py-1';

export class PropertiesPanel {
    /**
     * @param {HTMLElement} root
     * @param {object} ctx  { transformer, onLightChange, onEnvironmentChange, onCameraChange, scene, camera,
     *                        record(step) – record a change for undo (history.js) }
     */
    constructor(root, ctx) {
        this.root = root;
        this.ctx = ctx;
        this.entry = null;
        this.fields = {};
        ctx.transformer.addEventListener('change', () => this.refresh());
    }

    show(entry) {
        this.entry = entry;
        this.fields = {};
        if (!entry) {
            this.root.hidden = true;
            this.root.replaceChildren();
            return;
        }
        this.root.hidden = false;
        const parts = [this._header(entry)];
        // Gaussian splats: no transform (no gizmo either) and no explosion – one cloud without parts
        const splats = !!this.ctx.splats?.();
        if ((entry.kind === 'node' || entry.kind === 'model') && !splats) parts.push(...this._transformSection(true, true));
        if (entry.kind === 'model' && this.ctx.exploder && !splats) parts.push(this._explodeRow());
        if ((entry.kind === 'model' || entry.kind === 'node') && this.ctx.morphs?.list(entry).length) parts.push(...this._morphSection(entry));
        const bim = (entry.kind === 'node' || entry.kind === 'model') && this.ctx.bim?.(entry);
        if (bim) parts.push(this._bimSection(entry, bim));
        if (this.ctx.partQuality?.available(entry)) parts.push(this._qualityRow(entry));
        else if (entry.kind === 'light') parts.push(...this._lightSection(entry.object));
        else if (entry.kind === 'environment') parts.push(...this._environmentSection());
        else if (entry.kind === 'camera') parts.push(...this._cameraSection(), ...this._lookSection(), ...this._lensSection());
        else if (entry.kind === 'view') parts.push(...this._viewSection(entry.view));
        else if (entry.kind === 'missing') parts.push(...this._missingSection(entry));
        else if (entry.kind === 'views') {
            // several saved views (Shift+click): delete them together
            const del = el('button', BUTTON, t('properties.view.deleteAll', { count: entry.entries.length }));
            del.onclick = () => this.ctx.cameraViews.removeMany(entry.entries.map(e => e.view));
            parts.push(el('div', 'mb-1.5 text-white/60', t('properties.view.multiHint')), del);
        }
        else if (entry.kind === 'slicer') parts.push(...this._slicerSection());
        else if (entry.kind === 'surface') {
            parts.push(el('div', 'mb-1.5 text-white/60', t('properties.surface.hint')));
        }
        else if (entry.kind === 'selection') {
            const movable = !!this.ctx.transformer.object;
            const hidden = this.ctx.isHidden?.(entry);
            if (movable || hidden) parts.push(this._transformSection(true, true)[0]);   // only mode + reset (or the hint)
            const n = entry.object.meshes.length;
            const count = n !== entry.parts
                ? t('properties.selection.partsWithGroups', { count: entry.parts, groups: n })
                : t('properties.selection.parts', { count: entry.parts });
            parts.push(el('div', 'mb-1.5 text-white/60', t('properties.selection.hint', { parts: count })
                + (movable || hidden ? '' : ' ' + t('properties.selection.noTransform'))));
        }
        this.root.replaceChildren(...parts);
        this.refresh();
        this.refreshCamera();
    }

    // Re-read values (e.g. after a gizmo drag); do not overwrite the focused field
    refresh() {
        const values = this.ctx.transformer.getValues();
        if (!values) return;
        const set = (name, v) => {
            const el = this.fields[name];
            if (el && document.activeElement !== el) el.value = fmt(v);
        };
        values.position?.forEach((v, i) => set('p' + i, v));
        values.rotation?.forEach((v, i) => set('r' + i, v));
        values.scale?.forEach((v, i) => set('s' + i, v));
    }

    // IFC (BIM): class, name, GlobalId …, material, property sets and quantities – loaded from the web-ifc worker
    // on selection; scrollable (Revit elements have a dozen sets)
    _bimSection(entry, bim) {
        const box = el('div', 'mt-1.5 max-h-[40dvh] overflow-auto border-t border-white/10 pt-1.5 select-text');
        box.append(el('div', 'text-white/40', t('bim.props.loading')));
        bim.load().then(({ sections }) => {
            if (this.entry !== entry) return;
            if (!sections.length) { box.replaceChildren(el('div', 'text-white/40', t('bim.props.none'))); return; }
            box.replaceChildren(...sections.map((sec, i) => {
                const details = document.createElement('details');
                details.className = 'mb-1';
                details.open = i === 0 || bim.openSections.has(sec.id || sec.title);
                details.ontoggle = () => { const k = sec.id || sec.title; if (details.open) bim.openSections.add(k); else bim.openSections.delete(k); };
                const title = sec.id ? t(`bim.props.sections.${sec.id}`) : sec.title;
                details.append(el('summary', 'cursor-pointer py-0.5 font-medium text-white/80', title));
                const grid = el('div', 'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 pl-3');
                for (const [key, value] of sec.rows) {
                    const label = sec.id === 'general' ? (has(`bim.props.${key}`) ? t(`bim.props.${key}`) : key) : key;
                    const shown = key === 'class' ? classText(value) : value;
                    if (label == null) grid.append(el('div', 'col-span-2 break-words', String(shown)));
                    else grid.append(el('div', 'truncate text-white/50', label), el('div', 'break-words', String(shown)));
                    if (label != null) grid.lastChild.previousSibling.title = label;
                }
                details.append(grid);
                return details;
            }));
        }).catch(err => {
            if (err?.name === 'AbortError' || this.entry !== entry) return;
            box.replaceChildren(el('div', 'text-red-300', t('bim.props.error', { message: err.message })));
        });
        return box;
    }

    _header(entry) {
        const h = el('div', 'mb-1.5 flex items-baseline justify-between gap-2');
        h.append(
            el('span', 'truncate font-medium', entry.name),
            el('span', 'shrink-0 truncate text-white/40', (entry.kind === 'surface' ? entry.parent?.name : KIND_LABEL[entry.kind] && t(KIND_LABEL[entry.kind])) || ''),   // surface group: owning solid
        );
        return h;
    }

    _transformSection(withRotation, withScale = false) {
        // hidden: not editable (no gizmo, no fields)
        if (this.ctx.isHidden?.(this.entry)) return [el('div', 'mb-1.5 text-white/50', t('properties.transform.hiddenHint'))];
        const tf = this.ctx.transformer;
        const modes = el('div', 'mb-1.5 flex gap-1');
        const iconButton = (className, icon, title, label) => {
            const b = el('button', className + ICON_BUTTON);
            b.innerHTML = icon;
            b.title = title;
            b.setAttribute('aria-label', label);
            return b;
        };
        const mk = mode => {
            const b = iconButton(tf.mode === mode ? BUTTON_ACTIVE : BUTTON, TRANSFORM_ICONS[mode],
                t(`properties.transform.modeTitle.${mode}`), t(`properties.transform.${mode}`));
            b.onclick = () => { tf.setMode(mode); this.show(this.entry); };
            return b;
        };
        modes.append(mk('translate'));
        if (withRotation) modes.append(mk('rotate'));
        if (withScale) modes.append(mk('scale'));
        const reset = iconButton(BUTTON + ' ml-auto', TRANSFORM_ICONS.reset, t('properties.transform.reset'), t('properties.transform.reset'));
        reset.onclick = () => tf.reset();
        if (withRotation) modes.append(reset);

        // drag: one undo step per drag (merge)
        const rows = [modes, this._vectorRow(t('properties.transform.position'), 'p', (v, drag) => tf.setValues({ position: v }, { merge: drag }))];
        if (withRotation) rows.push(this._vectorRow(t('properties.transform.rotation'), 'r', (v, drag) => tf.setValues({ rotation: v }, { merge: drag })));
        if (withScale) rows.push(this._vectorRow(t('properties.transform.scaling'), 's', (v, drag) => tf.setValues({ scale: v }, { merge: drag })));
        return rows;
    }

    // Exploded view: strength live (dragging = raster preview, release = restart path tracing)
    _explodeRow() {
        const ex = this.ctx.exploder;
        return this._rangeRow(t('properties.explode.label'), ex.target, 0, 2, 0.01, v => ex.set(v, { animate: false }), {
            onStart: () => this.ctx.onExplodeDrag?.(true),
            onEnd: () => this.ctx.onExplodeDrag?.(false),
        });
    }

    // Morph targets (blend shapes) of the model/part: one slider per name; dragging = live (GPU), release =
    // baked once (path tracer, picking) + one undo step
    _morphSection(entry) {
        const api = this.ctx.morphs;
        const rows = [el('div', 'mt-2 mb-0.5 text-white/50', t('properties.morphs.title'))];
        for (const { name, value } of api.list(entry)) {
            let before = value;
            const row = this._rangeRow(name, value, 0, 1, 0.01, v => api.set(entry, name, v), { onStart: () => { before = api.get(entry, name); } });
            const [range, num] = row.querySelectorAll('input');
            range.addEventListener('change', () => api.end(entry, name, before));
            num.addEventListener('focus', () => { before = api.get(entry, name); });
            num.addEventListener('change', () => api.end(entry, name, before));
            rows.push(row);
        }
        const reset = el('button', BUTTON + ' mt-1', t('properties.morphs.reset'));
        reset.onclick = () => { api.reset(entry); this.show(this.entry); };
        rows.push(reset);
        return rows;
    }

    // Tessellation quality of the part (STEP); empty = as parent or global
    _qualityRow(entry) {
        const pq = this.ctx.partQuality;
        const select = el('select', INPUT.replace('text-right', 'text-left') + ' cursor-pointer');
        select.title = t('properties.quality.title');
        select.append(new Option(t('properties.quality.inherited', { quality: t(`tessellation.quality.${pq.inherited(entry)}`) }), ''));
        for (const q of pq.presets) select.append(new Option(t(`tessellation.quality.${q}`), q));
        select.value = pq.get(entry);
        select.onchange = () => pq.set(entry, select.value);
        return this._row(t('properties.quality.label'), select);
    }

    _lightSection(light) {
        const rows = [];
        if (!light.isAmbientLight) rows.push(...this._transformSection(false));
        rows.push(this._rangeRow(t('properties.light.intensity'), light.intensity, 0, 10, 0.05, this._tracked(t('properties.light.undo.intensity'), 'light-intensity:' + light.uuid,
            () => light.intensity, v => { light.intensity = v; this.ctx.onLightChange(); }), this._dragHooks()));
        const setColor = this._tracked(t('properties.light.undo.color'), 'light-color:' + light.uuid,
            () => '#' + light.color.getHexString(), v => { light.color.set(v); this.ctx.onLightChange(); });
        const color = colorField('#' + light.color.getHexString(), { onInput: setColor });
        rows.push(this._row(t('properties.light.color'), color));
        return rows;
    }

    // preview of the current HDRI over the panel width (canvas, drawn by environment.drawPreview with intensity,
    // light boost and rotation – the viewer redraws it on every environment change, also live while the HDRI
    // editor renders); own HDRIs: pencil at the top right opens the HDRI editor
    _hdriPreview(env) {
        const wrap = el('div', 'relative mb-1.5');
        const canvas = el('canvas', 'block aspect-[2/1] w-full rounded bg-black/40 ring-1 ring-white/10');
        canvas.title = t('properties.environment.previewTitle');
        wrap.append(canvas);
        this.fields.hdriPreview = canvas;
        // copyright holder from the HDRI file's metadata (EXR owner/copyright/comments, HDR header) – only if present,
        // updated with the preview (refreshEnvironmentPreview)
        const badge = el('div', 'absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/85 backdrop-blur-sm');
        badge.hidden = true;
        wrap.append(badge);
        this.fields.hdriCredit = badge;
        const editor = this.ctx.hdriEditor;
        const ownId = editor && env.hdri?.startsWith(editor.prefix) ? env.hdri.slice(editor.prefix.length) : null;
        if (ownId) {
            const edit = el('button', `absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded backdrop-blur-sm ${editor.isOpen(ownId) ? 'bg-sky-500/70 text-white' : 'bg-black/55 text-white/85 hover:bg-black/75 hover:text-white'}`);
            edit.innerHTML = ICON_PENCIL;
            edit.title = t('properties.environment.editHdriTitle');
            edit.onclick = () => editor.edit(ownId);
            wrap.append(edit);
        }
        requestAnimationFrame(() => this.refreshEnvironmentPreview());   // after layout (canvas size)
        return wrap;
    }

    /** environment changed (texture, intensity, light boost, rotation): redraw the preview if it is shown */
    refreshEnvironmentPreview() {
        const canvas = this.fields?.hdriPreview;
        if (!canvas?.isConnected) return;
        this.ctx.environment.drawPreview?.(canvas);
        const badge = this.fields.hdriCredit, credit = this.ctx.environment.texture?.userData?.credit;
        if (badge) {
            badge.hidden = !credit;
            badge.textContent = credit ? `© ${credit}` : '';
            badge.title = credit ? t('properties.environment.creditTitle', { credit }) : '';
        }
    }

    _environmentSection() {
        const { scene, environment: env } = this.ctx;
        const rows = [
            this._hdriPreview(env),
            this._hdriRow(env),
            this._rangeRow(t('properties.environment.intensity'), env.intensity, 0, 3, 0.05, this._tracked(t('properties.environment.undo.intensity'), 'env-intensity',
                () => env.intensity, v => { env.intensity = v; this.ctx.onEnvironmentChange({ params: true }); }),
                this._dragHooks()),
            // light energy on the model without brightening the visible HDRI
            this._rangeRow(t('properties.environment.lightBoost'), env.lightBoost, 0, 5, 0.05, this._tracked(t('properties.environment.undo.lightBoost'), 'env-light-boost',
                () => env.lightBoost, v => { env.lightBoost = v; this.ctx.onEnvironmentChange({ params: true }); }),
                this._dragHooks()),
            this._rangeRow(t('properties.environment.rotation'), THREE_deg(scene.environmentRotation.y), -180, 180, 1, this._tracked(t('properties.environment.undo.rotation'), 'env-rotation',
                () => scene.environmentRotation.y * 180 / Math.PI, v => {
                    scene.environmentRotation.y = v * Math.PI / 180;
                    this.ctx.onEnvironmentChange({ params: true });
                }), this._dragHooks()),
            this._checkRow(t('properties.environment.background'), t('properties.environment.backgroundTitle'), env.background, v => {
                this._tracked(t('properties.environment.undo.background'), null, () => env.background, bg => { env.background = bg; this.ctx.onEnvironmentChange(); })(v);
                this.show(this.entry);
            }),
        ];
        // ground shadow, flattened ground, reflection, bad weather: each a collapsible section with its sliders
        // (sliders of a section that is off stay reachable, dimmed). Size + softness = soft edge of the ground disc –
        // also for reflection and puddles. Reflection and bad weather only in HQ (path tracer).
        const range = (key, label, undo, mergeKey, min, max, step, options = { params: true }) =>
            this._rangeRow(t(label), env[key], min, max, step, this._tracked(t(undo), mergeKey,
                () => env[key], v => { env[key] = v; this.ctx.onEnvironmentChange(options); }), this._dragHooks());
        const section = (id, key, options, build) => rows.push(...this._section(id, t(`properties.environment.${key}`), t(`properties.environment.${key}Title`), env[key], v => {
            this._tracked(t(`properties.environment.undo.${key}`), null, () => env[key], x => { env[key] = x; this.ctx.onEnvironmentChange(options); })(v);
            this.show(this.entry);
        }, build));
        section('env-ground', 'ground', undefined, () => [
            range('groundRadius', 'properties.environment.size', 'properties.environment.undo.size', 'env-ground-size', 0.001, 10, 0.001, { geometry: true, params: true }),
            range('groundSoftness', 'properties.environment.softness', 'properties.environment.undo.softness', 'env-ground-softness', 0, 1, 0.01, { geometry: true, params: true }),
            // colour bleeding (HQ): light of the model onto the ground
            range('groundBounce', 'properties.environment.bounce', 'properties.environment.undo.bounce', 'env-ground-bounce', 0, 3, 0.01),
        ]);
        // flattened ground: HDRI height, floor height (distortion), sphere size (= where the floor ends), transition
        section('env-dome', 'dome', { params: true }, () => [
            range('domeShift', 'properties.environment.height', 'properties.environment.undo.height', 'env-dome-shift', -0.5, 0.9, 0.01),
            range('groundHeight', 'properties.environment.floorHeight', 'properties.environment.undo.floorHeight', 'env-floor-height', 0.05, 5, 0.01),
            range('domeRadius', 'properties.environment.sphere', 'properties.environment.undo.sphere', 'env-dome-size', 1, 50, 0.5),
            range('domeBlend', 'properties.environment.blend', 'properties.environment.undo.blend', 'env-dome-blend', 0, 1, 0.01),
        ]);
        section('env-reflection', 'reflection', { params: true }, () => [
            range('reflectionStrength', 'properties.environment.reflectionStrength', 'properties.environment.undo.reflectionStrength', 'env-refl-strength', 0, 1, 0.01),
            range('reflectionBlur', 'properties.environment.reflectionBlur', 'properties.environment.undo.reflectionBlur', 'env-refl-blur', 0, 1, 0.01),
        ]);
        section('env-wet', 'wet', { params: true }, () => [
            range('puddles', 'properties.environment.puddles', 'properties.environment.undo.puddles', 'env-puddles', 0, 1, 0.01),
            range('puddleSize', 'properties.environment.puddleSize', 'properties.environment.undo.puddleSize', 'env-puddle-size', 0.05, 3, 0.01),
        ]);
        return rows;
    }

    // Volumetric light shafts (volume-shafts.js, all view modes): strength/reach/focus; source = brightest point
    _shaftsSection() {
        const { lens } = this.ctx;
        if (!lens) return [];
        const sh = lens.shafts;
        const set = (label, key, mergeKey) => this._tracked(label, mergeKey, () => sh[key], v => { sh[key] = v; lens.apply(); });
        return this._section('shafts', t('properties.lens.shafts'), t('properties.lens.shaftsTitle'), sh.enabled, v => {
            set(t('properties.lens.undo.shafts'), 'enabled')(v);
            this.show(this.entry);
        }, () => {
            const length = this._rangeRow(t('properties.lens.length'), sh.length, 0, 1, 0.01, set(t('properties.lens.undo.shaftsLength'), 'length', 'shafts-length'));
            length.title = t('properties.lens.shaftsLengthTitle');
            const focus = this._rangeRow(t('properties.lens.shaftsFocus'), sh.focus, 0, 0.95, 0.01, set(t('properties.lens.undo.shaftsFocus'), 'focus', 'shafts-focus'));
            focus.title = t('properties.lens.shaftsFocusTitle');
            return [
                this._rangeRow(t('properties.lens.strength'), sh.strength, 0, 3, 0.01, set(t('properties.lens.undo.shaftsStrength'), 'strength', 'shafts-strength')),
                length,
                focus,
            ];
        });
    }

    // HDRI choice: procedural studio, a file from public/hdr or an own HDRI of the HDRI editor (+ new / edit)
    _hdriRow(env) {
        const select = el('select', INPUT.replace('text-right', 'text-left') + ' cursor-pointer');
        select.title = t('properties.environment.hdriTitle');
        select.append(new Option(t('properties.environment.studio'), ''));
        for (const file of env.hdris) select.append(new Option(file.replace(/\.(hdr|exr)$/i, ''), file));
        const editor = this.ctx.hdriEditor;
        const own = editor?.list() ?? [];
        if (own.length) {
            const group = el('optgroup');
            group.label = t('properties.environment.ownHdris');
            for (const doc of own) group.append(new Option(doc.name, editor.prefix + doc.id));
            select.append(group);
        }
        // last entry: new own HDRI in the HDRI editor (studio template)
        const NEW = '\u0000new';
        if (editor) {
            const opt = new Option(t('properties.environment.newHdri'), NEW);
            opt.title = t('properties.environment.newHdriTitle');
            select.append(opt);
        }
        select.value = env.hdri;
        select.onchange = async () => {
            if (select.value === NEW) { select.value = env.hdri; editor.create(); return; }
            const previous = env.hdri, next = select.value;
            const load = name => env.select(name).catch(e => this.ctx.onHdriError?.(name, e));
            this.ctx.record?.({ label: t('properties.environment.undo.hdri'), undo: () => load(previous), redo: () => load(next) });
            await load(next);   // loading/decoding progress: status monitor bottom left (environment.select)
        };
        const wrap = el('div');
        wrap.append(this._row(t('properties.environment.hdri'), select));
        return wrap;
    }

    _slicerSection() {
        const { slicer, transformer: tf } = this.ctx;
        const axes = el('div', 'mb-1.5 flex gap-1');
        // cut perpendicular to the axis (rotation of the plane, whose normal = local Z axis)
        for (const [label, rot] of [['X', [0, 90, 0]], ['Y', [-90, 0, 0]], ['Z', [0, 0, 0]]]) {
            const b = el('button', BUTTON, label);
            b.title = t('properties.slicer.axisTitle', { axis: label });
            b.onclick = () => tf.setValues({ rotation: rot });
            axes.append(b);
        }
        const flip = el('button', BUTTON + ' ml-auto', t('properties.slicer.flip'));
        const doFlip = () => { slicer.flip(); this.ctx.onSlicerChange(); };
        flip.onclick = () => { doFlip(); this.ctx.record?.({ label: t('properties.slicer.undo.flip'), undo: doFlip, redo: doFlip }); };
        axes.append(flip);

        const setCapColor = this._tracked(t('properties.slicer.undo.capColor'), 'slicer-color',
            () => '#' + slicer.capMaterial.color.getHexString(), v => slicer.capMaterial.color.set(v));
        const color = colorField('#' + slicer.capMaterial.color.getHexString(), { onInput: setCapColor });

        const rows = [this._row(t('properties.slicer.axis'), axes), ...this._transformSection(true), this._row(t('properties.slicer.capColor'), color)];
        if (!slicer.enabled) rows.push(el('div', 'mt-1 text-white/40', t('properties.slicer.inactiveHint')));
        else rows.push(el('div', 'mt-1 text-white/40', t('properties.slicer.activeHint')));
        return rows;
    }

    // saved camera view: name, fly there, overwrite with the current camera, delete
    _viewSection(view) {
        const api = this.ctx.cameraViews;
        const name = el('input', INPUT.replace('text-right', 'text-left'));
        name.type = 'text';
        name.value = view.name;
        name.addEventListener('change', () => api.rename(view, name.value.trim() || view.name));
        name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });
        const button = (label, title, onClick) => {
            const b = el('button', BUTTON, label);
            b.title = title;
            b.onclick = onClick;
            return b;
        };
        const buttons = el('div', 'mt-1 flex flex-wrap gap-1');
        buttons.append(
            button(t('properties.view.fly'), t('properties.view.flyTitle'), () => api.fly(view)),
            button(t('properties.view.overwrite'), t('properties.view.overwriteTitle'), () => api.overwrite(view)),
            button(t('properties.view.delete'), t('properties.view.deleteTitle'), () => api.remove(view)),
        );
        return [this._row(t('properties.view.name'), name), buttons, el('div', 'mt-1.5 text-white/40', t('properties.view.hint'))];
    }

    // model whose file (or .bin) is missing: relink in the asset window or remove it from the scene
    _missingSection(entry) {
        const api = this.ctx.missingModels;
        const relink = el('button', BUTTON, t('properties.missing.relink'));
        relink.onclick = () => api.relink(entry);
        const remove = el('button', BUTTON, t('properties.missing.remove'));
        remove.onclick = () => api.remove(entry);
        const buttons = el('div', 'mt-1 flex flex-wrap gap-1');
        buttons.append(relink, remove);
        return [el('div', 'text-white/50', t('properties.missing.hint')), buttons];
    }

    _cameraSection() {
        const { camera, dof } = this.ctx;
        // position + rotation (orbit camera: moving keeps the view direction, rotation X = tilt, Y = pan;
        // roll Z is shown only – the orbit controls keep the camera level)
        const position = this._vectorRow(t('properties.camera.position'), 'cp', v => this.ctx.setCameraPose({ position: v }));
        const rotation = this._vectorRow(t('properties.camera.rotation'), 'cr', v => this.ctx.setCameraPose({ rotation: v }));
        this.fields.cr2.title = t('properties.camera.rollHint');
        // save the current view (appears below "Camera" in the Scene Graph)
        const save = el('button', BUTTON + ' mb-1', t('properties.view.save'));
        save.title = t('properties.view.saveTitle');
        save.onclick = () => this.ctx.cameraViews.save();
        // view angle: above PERSPECTIVE_LIMIT the picture continues as a fisheye (fisheye.js)
        const fov = this._rangeRow(t('properties.camera.fov'), viewAngle(camera), 10, MAX_VIEW_ANGLE, 1, this._tracked(t('properties.camera.undo.fov'), 'camera-fov', () => viewAngle(camera), v => {
            setViewAngle(camera, v);
            this.ctx.onCameraChange();
        }), this._dragHooks());
        fov.title = t('properties.camera.fovTitle', { limit: PERSPECTIVE_LIMIT });
        const rows = [
            save,
            position, rotation,
            fov,
        ];
        if (!dof) return rows;
        const splats = !!this.ctx.splats?.();   // Gaussian splats: blurred in the raster view, no bokeh shape
        // depth of field: focus plane (distance along the view direction), aperture, shape of the opening
        const set = (label, key, mergeKey) => this._tracked(label, mergeKey, () => dof[key], v => { dof[key] = v; this.ctx.onDofChange(); });
        rows.push(...this._section('dof', t('properties.dof.label'), t(splats ? 'properties.dof.titleSplats' : 'properties.dof.title'), dof.enabled, v => {
            if (v && !dof.focusSet) this.ctx.focusOnTarget({ record: false });
            set(t('properties.dof.undo.enabled'), 'enabled')(v);
            this.show(this.entry);
        }, () => {
            const sub = [];
            // focus: pause path tracing while dragging so the plane is visible in the preview
            const focus = this._rangeRow(t('properties.dof.focusDistance'), dof.focusDistance, 0, this.ctx.focusRange(), 'any', set(t('properties.dof.undo.focusDistance'), 'focusDistance', 'dof-focus'), {
                onStart: () => this.ctx.onFocusEdit(true),
                onEnd: () => this.ctx.onFocusEdit(false),
            });
            [this.fields.focusRange, this.fields.focusNum] = focus.querySelectorAll('input');
            if (dof.autoFocus) this.fields.focusRange.disabled = this.fields.focusNum.disabled = true;
            sub.push(focus);

            const pick = el('button', BUTTON, t('properties.dof.pick'));
            pick.title = t('properties.dof.pickTitle');
            pick.onclick = () => this.ctx.onPickFocus();
            const target = el('button', BUTTON, t('properties.dof.target'));
            target.title = t('properties.dof.targetTitle');
            target.onclick = () => { this.ctx.focusOnTarget(); this.show(this.entry); };
            pick.disabled = target.disabled = dof.autoFocus;
            if (dof.autoFocus) pick.className = target.className = BUTTON + ' opacity-40';
            sub.push(this._row(t('properties.dof.focus'), pick, target));
            sub.push(this._checkRow(t('properties.dof.autoFocus'), t('properties.dof.autoFocusTitle'), dof.autoFocus, v => {
                set(t('properties.dof.undo.autoFocus'), 'autoFocus')(v);
                if (v) this.ctx.focusOnTarget({ record: false });
                this.show(this.entry);
            }));

            sub.push(this._rangeRow(t('properties.dof.fStop'), dof.fStop, 0.5, 22, 0.1, set(t('properties.dof.undo.fStop'), 'fStop', 'dof-fstop')));
            const blades = el('select', INPUT.replace('text-right', 'text-left') + ' cursor-pointer');
            for (const n of [0, 5, 6, 7, 8, 9]) blades.append(new Option(n ? t('properties.dof.bladesCount', { count: n }) : t('properties.dof.round'), n));
            blades.value = dof.blades;
            blades.title = t('properties.dof.bladesTitle');
            const setBlades = set(t('properties.dof.undo.blades'), 'blades');
            blades.onchange = () => setBlades(Number(blades.value));
            if (!splats) sub.push(this._row(t('properties.dof.bokeh'), blades));
            sub.push(this._checkRow(t('properties.dof.plane'), t('properties.dof.planeTitle'), dof.showPlane, v => { dof.showPlane = v; this.ctx.onDofChange(); }));
            sub.push(el('div', 'mt-1 text-white/40', t(splats ? 'properties.dof.hintSplats' : 'properties.dof.hint')));
            return sub;
        }));
        return rows;
    }

    // Image look: exposure + tone mapping (renderer), white balance/contrast/saturation (lens.look) – all view
    // modes, no path tracing restart; a section without checkbox (always applies)
    _lookSection() {
        const { look, lens } = this.ctx;
        if (!look || !lens) return [];
        const l = lens.look;
        const set = (label, key, mergeKey) => this._tracked(label, mergeKey, () => l[key], v => { l[key] = v; lens.apply(); });
        return this._section('look', t('properties.look.title'), null, true, null, () => {
            const exposure = this._rangeRow(t('properties.look.exposure'), look.exposure, -4, 4, 0.05,
                this._tracked(t('properties.look.undo.exposure'), 'look-exposure', () => look.exposure, v => { look.exposure = v; }));
            exposure.title = t('properties.look.exposureTitle');
            const curve = el('select', INPUT.replace('text-right', 'text-left') + ' cursor-pointer');
            for (const k of look.toneMappings) curve.append(new Option(t(`properties.look.toneMappings.${k}`), k));
            curve.value = look.toneMapping;
            curve.title = t('properties.look.toneMappingTitle');
            const setCurve = this._tracked(t('properties.look.undo.toneMapping'), null, () => look.toneMapping, v => { look.toneMapping = v; curve.value = v; });
            curve.onchange = () => setCurve(curve.value);
            const temperature = this._rangeRow(t('properties.look.temperature'), l.temperature, 2000, 12000, 50, set(t('properties.look.undo.temperature'), 'temperature', 'look-temperature'));
            temperature.title = t('properties.look.temperatureTitle');
            const tint = this._rangeRow(t('properties.look.tint'), l.tint, -1, 1, 0.01, set(t('properties.look.undo.tint'), 'tint', 'look-tint'));
            tint.title = t('properties.look.tintTitle');
            const reset = el('button', BUTTON + ' mt-0.5', t('properties.look.reset'));
            reset.onclick = () => {
                const before = { look: { ...l }, exposure: look.exposure, curve: look.toneMapping };
                const neutral = { look: { temperature: 6500, tint: 0, contrast: 1, saturation: 1 }, exposure: 0, curve: 'aces' };
                const apply = s => { Object.assign(l, s.look); look.exposure = s.exposure; look.toneMapping = s.curve; lens.apply(); this.show(this.entry); };
                apply(neutral);
                this.ctx.record?.({ label: t('properties.look.undo.reset'), undo: () => apply(before), redo: () => apply(neutral) });
            };
            return [
                exposure,
                this._row(t('properties.look.toneMapping'), curve),
                temperature, tint,
                this._rangeRow(t('properties.look.contrast'), l.contrast, 0.5, 2, 0.01, set(t('properties.look.undo.contrast'), 'contrast', 'look-contrast')),
                this._rangeRow(t('properties.look.saturation'), l.saturation, 0, 2, 0.01, set(t('properties.look.undo.saturation'), 'saturation', 'look-saturation')),
                this._row('', reset),
            ];
        });
    }

    // Bloom + chromatic aberration (post-processing, works in raster view and path tracing)
    _lensSection() {
        const { lens } = this.ctx;
        if (!lens) return [];
        const rows = [el('div', 'mt-2 border-t border-white/10 pt-2 text-white/60', t('properties.lens.title'))];
        const set = (group, label, key, mergeKey) => this._tracked(label, mergeKey, () => lens[group][key], v => { lens[group][key] = v; lens.apply(); });
        const effect = (group, build) => {
            rows.push(...this._section(group, t(`properties.lens.${group}`), t(`properties.lens.${group}Title`), lens[group].enabled, v => {
                set(group, t(`properties.lens.undo.${group}`), 'enabled')(v);
                this.show(this.entry);
            }, build));
        };
        effect('bloom', () => {
            const th = this._rangeRow(t('properties.lens.threshold'), lens.bloom.threshold, 0, 5, 0.01, set('bloom', t('properties.lens.undo.bloomThreshold'), 'threshold', 'bloom-threshold'));
            th.title = t('properties.lens.bloomThresholdTitle');
            return [
                this._rangeRow(t('properties.lens.strength'), lens.bloom.strength, 0, 3, 0.01, set('bloom', t('properties.lens.undo.bloomStrength'), 'strength', 'bloom-strength')),
                this._rangeRow(t('properties.lens.radius'), lens.bloom.radius, 0, 1, 0.01, set('bloom', t('properties.lens.undo.bloomRadius'), 'radius', 'bloom-radius')),
                th,
            ];
        });
        effect('glare', () => {
            const rays = el('select', INPUT.replace('text-right', 'text-left') + ' cursor-pointer');
            for (const n of [2, 4, 6, 8]) rays.append(new Option(t('properties.lens.raysCount', { count: n }), n));
            rays.value = lens.glare.rays;
            const setRays = set('glare', t('properties.lens.undo.glareRays'), 'rays');
            rays.onchange = () => setRays(Number(rays.value));
            const th = this._rangeRow(t('properties.lens.threshold'), lens.glare.threshold, 0, 10, 0.01, set('glare', t('properties.lens.undo.glareThreshold'), 'threshold', 'glare-threshold'));
            th.title = t('properties.lens.glareThresholdTitle');
            return [
                this._rangeRow(t('properties.lens.strength'), lens.glare.strength, 0, 5, 0.01, set('glare', t('properties.lens.undo.glareStrength'), 'strength', 'glare-strength')),
                this._rangeRow(t('properties.lens.length'), lens.glare.length, 0, 2, 0.01, set('glare', t('properties.lens.undo.glareLength'), 'length', 'glare-length')),
                this._rangeRow(t('properties.lens.glareSharpness'), lens.glare.sharpness, 0, 1, 0.01, set('glare', t('properties.lens.undo.glareSharpness'), 'sharpness', 'glare-sharpness')),
                this._rangeRow(t('properties.lens.glareChromatic'), lens.glare.chromatic, 0, 1, 0.01, set('glare', t('properties.lens.undo.glareChromatic'), 'chromatic', 'glare-chromatic')),
                this._row(t('properties.lens.rays'), rays),
                this._rangeRow(t('properties.lens.rotation'), lens.glare.rotation, 0, 180, 1, set('glare', t('properties.lens.undo.glareRotation'), 'rotation', 'glare-rotation')),
                th,
            ];
        });
        rows.push(...this._shaftsSection());
        // lens flare: ghosts + halo + glow from the same light as the shafts (brightest spot of the HDRI)
        effect('flare', () => {
            const f = (label, key, min, max, step, undo) => this._rangeRow(t(label), lens.flare[key], min, max, step, set('flare', t(undo), key, 'flare-' + key));
            return [
                f('properties.lens.strength', 'strength', 0, 3, 0.01, 'properties.lens.undo.flareStrength'),
                f('properties.lens.flareSpacing', 'spacing', 0.05, 0.8, 0.01, 'properties.lens.undo.flareSpacing'),
                f('properties.lens.flareHalo', 'halo', 0, 1, 0.01, 'properties.lens.undo.flareHalo'),
                f('properties.lens.flareChromatic', 'chromatic', 0, 1, 0.01, 'properties.lens.undo.flareChromatic'),
                f('properties.lens.flareSoftness', 'softness', 0, 1, 0.01, 'properties.lens.undo.flareSoftness'),
            ];
        });
        effect('chromatic', () => [
            this._rangeRow(t('properties.lens.strength'), lens.chromatic.strength, 0, 3, 0.01, set('chromatic', t('properties.lens.undo.chromaticStrength'), 'strength', 'chromatic-strength')),
        ]);
        return rows;
    }

    // Effect section with a separator line. Header: arrow + name (left) fold the settings in/out like the
    // scene graph, checkbox + description switch the effect; switching it on also unfolds it.
    // Unfolded state per browser (localStorage)
    _section(id, label, title, enabled, onChange, build) {
        const box = el('div', 'mt-1.5 border-t border-white/10 pt-1.5');
        const name = el('button', '-ml-1 flex min-w-0 cursor-pointer items-center gap-0.5 text-left text-white/60 hover:text-white');
        name.innerHTML = '<svg viewBox="0 0 16 16" class="size-3 shrink-0 fill-current transition-transform"><path d="M6 4l4 4-4 4z"/></svg>';
        name.append(el('span', 'min-w-0', label));
        if (title == null) box.append(this._row(name));   // no checkbox: always applies
        else {
            const check = el('input', 'size-3.5 shrink-0 cursor-pointer accent-sky-400');
            check.type = 'checkbox';
            check.id = `prop-check-${++checkId}`;
            check.checked = enabled;
            check.title = title;
            check.onchange = () => {
                if (check.checked) { expanded.add(id); saveExpanded(); }
                onChange(check.checked);
            };
            const text = el('label', 'min-w-0 cursor-pointer truncate text-white/50', title);
            text.htmlFor = check.id;
            box.append(this._row(name, check, text));
        }
        const body = el('div', enabled ? '' : 'opacity-50');
        body.append(...build());
        const sync = () => {
            body.hidden = !expanded.has(id);
            name.firstElementChild.style.transform = body.hidden ? '' : 'rotate(90deg)';
            name.title = t(body.hidden ? 'properties.section.expand' : 'properties.section.collapse');
        };
        name.onclick = () => {
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
            saveExpanded();
            sync();
        };
        sync();
        box.append(body);
        return [box];
    }

    /** Update the focus field (autofocus, focus by click) without rebuilding the panel */
    /** Camera position/rotation into the fields (while orbiting; not the focused field) */
    refreshCamera() {
        const { camera } = this.ctx;
        if (!this.fields.cp0) return;
        const e = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        const set = (name, v) => {
            const field = this.fields[name];
            if (field && document.activeElement !== field) field.value = fmt(v);
        };
        camera.position.toArray().forEach((v, i) => set('cp' + i, v));
        // tilt/pan from the orientation, roll from its own value (this runs inside the orbit update, before the
        // roll is applied again)
        [e.x, e.y].forEach((v, i) => set('cr' + i, v * 180 / Math.PI));
        set('cr2', camera.userData.roll || 0);
    }

    refreshFocus() {
        const { dof } = this.ctx;
        const { focusRange, focusNum } = this.fields;
        if (!dof || !focusRange) return;
        focusRange.max = Math.max(Number(focusRange.max), dof.focusDistance);
        if (document.activeElement !== focusRange) focusRange.value = dof.focusDistance;
        if (document.activeElement !== focusNum) focusNum.value = fmt(dof.focusDistance);
    }

    // --- Building blocks ---

    // Setter with undo: get() returns the current value, set(v) sets it including the update.
    // Same mergeKey -> continuous changes (dragging a slider) result in one step.
    _tracked(label, mergeKey, get, set) {
        return v => {
            const before = get();
            set(v);
            const after = get();
            if (before === after) return;
            this.ctx.record?.({ label, mergeKey: mergeKey || undefined, undo: () => set(before), redo: () => set(after) });
        };
    }

    _row(label, ...controls) {
        const row = el('div', 'mb-1 grid grid-cols-[4.5rem_1fr] items-center gap-1.5');
        const box = el('div', 'flex min-w-0 items-center gap-1');
        box.append(...controls);
        row.append(typeof label === 'string' ? el('span', 'text-white/60', label) : label, box);
        return row;
    }

    // name and description are <label>s of the checkbox – clicking the text toggles it too
    _checkRow(label, title, checked, onChange) {
        const box = el('input', 'size-3.5 shrink-0 cursor-pointer accent-sky-400');
        box.type = 'checkbox';
        box.id = `prop-check-${++checkId}`;
        box.checked = checked;
        box.title = title;
        box.onchange = () => onChange(box.checked);
        const name = el('label', 'cursor-pointer text-white/60', label);
        const text = el('label', 'min-w-0 cursor-pointer truncate text-white/50', title);
        name.htmlFor = text.htmlFor = box.id;
        return this._row(name, box, text);
    }

    // X/Y/Z fields; dragging a field sideways changes it live (onChange(values, true)), see draggable()
    _vectorRow(label, key, onChange) {
        const angle = key === 'r' || key === 'cr', scale = key === 's';
        // per pixel: 0.5°, 1 % of the scale, positions 1/500 of the scene size (at least 0.1 mm)
        const perPixel = angle ? () => 0.5 : scale ? v => Math.max(Math.abs(v), 0.1) * 0.01 : () => Math.max((this.ctx.sceneSize?.() || 1000) / 500, 0.1);
        const values = () => inputs.map(x => Number(x.value) || 0);
        const inputs = ['X', 'Y', 'Z'].map((axis, i) => {
            const input = el('input', INPUT);
            input.type = 'number';
            input.step = angle ? '1' : scale ? '0.1' : 'any';
            input.title = axis;
            this.fields[key + i] = input;
            input.addEventListener('change', () => onChange(values(), false));
            draggable(input, {
                perPixel, min: scale ? 1e-3 : -Infinity,
                onDrag: () => onChange(values(), true),
                onStart: () => this.ctx.onFieldDrag?.(key, true),
                onEnd: () => { onChange(values(), true); this.ctx.onFieldDrag?.(key, false); },
            });
            return input;
        });
        return this._row(label, ...inputs);
    }

    // dragging a slider = reduced path tracing (like orbiting the camera), release = full quality
    _dragHooks() {
        return { onStart: () => this.ctx.onSliderDrag?.(true), onEnd: () => this.ctx.onSliderDrag?.(false) };
    }

    // hooks: { onStart, onEnd } – slider is dragged / released
    _rangeRow(label, value, min, max, step, onChange, hooks = {}) {
        const range = el('input', 'min-w-0 flex-1 accent-sky-400');
        range.type = 'range';
        Object.assign(range, { min, max, step, value });
        const num = el('input', INPUT.replace('w-full', 'w-14') + ' flex-none');
        num.type = 'number';
        Object.assign(num, { min, max, step, value: fmt(value) });
        range.oninput = () => { num.value = fmt(Number(range.value)); onChange(Number(range.value)); };
        num.onchange = () => { range.value = num.value; onChange(Number(num.value)); };
        // drag the number sideways like the slider (300 px = whole range), snapped to its step
        const span = Number(max) - Number(min);
        draggable(num, {
            perPixel: () => (Number.isFinite(span) && span > 0 ? span / 300 : 1),
            min: Number(min), max: Number(max), step: Number(step) || 0,
            onDrag: v => { range.value = v; onChange(v); },
            onStart: () => hooks.onStart?.(),
            onEnd: () => hooks.onEnd?.(),
        });
        if (hooks.onStart) {
            range.addEventListener('pointerdown', () => {
                hooks.onStart();
                window.addEventListener('pointerup', () => hooks.onEnd?.(), { once: true });
            });
        }
        return this._row(label, range, num);
    }
}

// i18n keys, translated at render time
const KIND_LABEL = Object.fromEntries(['selection', 'model', 'node', 'surface', 'light', 'environment', 'camera', 'folder', 'slicer', 'view', 'views'].map(k => [k, `properties.kind.${k}`]));

// IFC class: readable label + the class itself ("Wand · IFCWALLSTANDARDCASE")
const classText = type => (has(`bim.classes.${type.toUpperCase()}`) ? `${t(`bim.classes.${type.toUpperCase()}`)} · ${type}` : type);

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function THREE_deg(rad) {
    return Math.round(rad * 180 / Math.PI);
}
