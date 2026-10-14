// BCF window (right side, over the materials panel while open): list of topics with snapshot, status, assignee;
// detail view to edit a topic (title, status, type, priority, assignee, due date, labels, description),
// viewpoints (click = apply: camera, visibility, selection; "+ current view" adds one), comments (with optional
// current view). New topic from the current view, open/export .bcfzip. Author for new entries: settings → BIM.
import { t, getLocale } from '../i18n.js';
import { uuid } from './bcf-format.js';

const ICON_CLOSE = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 16 16" class="size-3.5 fill-none stroke-current" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
const BUTTON = 'rounded px-2 py-0.5 text-white/80 outline-none transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40 disabled:pointer-events-none';
const INPUT = 'w-full min-w-0 rounded bg-white/10 px-1.5 py-0.5 text-white outline-none focus:bg-white/20';
const STATUS_DEFAULTS = ['Open', 'In Progress', 'Resolved', 'Closed', 'ReOpened'];
const TYPE_DEFAULTS = ['Issue', 'Clash', 'Request', 'Comment', 'Fault', 'Inquiry', 'Remark', 'Undefined'];
const PRIORITY_DEFAULTS = ['Low', 'Normal', 'High', 'Critical'];
const CLOSED = /^(closed|resolved|done|erledigt|geschlossen)$/i;

/**
 * @param {{ apply(viewpoint, topic): void, capture(): Promise<object>, open(): void, save(doc): Promise<void>,
 *           author(): string, openSettings(): void, onShow?(open: boolean): void }} handlers
 *   apply: show a viewpoint, capture: viewpoint of the current view (camera, selection, hidden, snapshot),
 *   author: name for new topics/comments (settings → BIM), openSettings: open that page
 */
export function createBcfPanel({ apply, capture, open, save, author, openSettings, onShow = () => {} }) {
    let doc = null;          // { version, project, topics, name }
    let current = null;      // topic in the detail view
    let dirty = false;
    const urls = new Map();  // snapshot Blob → object URL

    const root = document.createElement('div');
    root.className = 'pointer-events-auto fixed top-5 right-5 bottom-20 z-30 flex w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-lg bg-black/70 text-xs text-white/90 shadow-2xl backdrop-blur-sm';
    root.hidden = true;
    root.dataset.ui = 'right';
    document.body.append(root);

    const el = (tag, className = '', text) => { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; };
    const button = (label, onClick, extra = '') => { const b = el('button', BUTTON + ' ' + extra, label); b.onclick = onClick; return b; };
    const snapUrl = blob => { if (!blob) return null; if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob)); return urls.get(blob); };
    const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const formatDate = s => { const d = s && new Date(s); return d && !isNaN(d) ? d.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : s || ''; };
    // without an author in the settings: "Anonym" (written into the file as such)
    const writer = () => author() || t('bcf.anonymous');
    const touch = topic => { topic.modifiedDate = now(); topic.modifiedAuthor = writer(); dirty = true; };
    const values = (key, defaults) => [...new Set([...defaults, ...(doc?.topics || []).map(x => x[key]).filter(Boolean)])];

    function render() {
        const head = el('div', 'flex shrink-0 items-center gap-1 border-b border-white/10 px-3 py-2');
        if (current) {
            const back = button('', () => { current = null; render(); }, 'flex items-center');
            back.innerHTML = ICON_BACK;
            back.title = t('bcf.back');
            head.append(back, el('span', 'flex-1 truncate font-medium', current.title || t('bcf.untitled')));
        } else {
            head.append(el('span', 'flex-1 truncate font-medium', doc?.name || t('bcf.title')));
            if (doc) head.append(el('span', 'text-white/50', String(doc.topics.length)));
        }
        const close = button('', () => hide(), 'flex items-center text-white/50');
        close.innerHTML = ICON_CLOSE;
        close.title = t('setup.close');
        head.append(close);

        const body = el('div', 'min-h-0 flex-1 overflow-auto');
        if (current) body.append(...detail(current));
        else body.append(...list());

        const foot = el('div', 'flex shrink-0 flex-wrap items-center gap-1 border-t border-white/10 px-3 py-2');
        // author from the settings (BIM); without one a link there
        const who = author()
            ? el('span', 'truncate text-white/50', t('bcf.authorAs', { author: author() }))
            : button(t('bcf.setAuthor'), () => openSettings(), '!px-0 text-amber-300');
        who.title = t('bcf.authorTitle');
        foot.append(who, el('span', 'flex-1'));
        foot.append(button(t('bcf.new'), async () => {
            const topic = newTopic();
            topic.viewpoints.push(await capture());
            doc ??= emptyDoc();
            doc.topics.push(topic);
            current = topic;
            dirty = true;
            render();
            root.querySelector('[data-title]')?.focus();
        }));
        foot.append(button(t('bcf.open'), () => open()));
        const exp = button(t('bcf.export'), async () => {
            try { await save(doc); } catch (err) { if (err?.name !== 'AbortError') console.error(err); }   // AbortError: dialog cancelled
        }, dirty ? '!text-amber-300' : '');
        exp.disabled = !doc?.topics.length;
        exp.title = dirty ? t('bcf.unsaved') : '';
        foot.append(exp);
        root.replaceChildren(head, body, foot);
    }

    function list() {
        if (!doc?.topics.length) return [el('div', 'p-3 text-white/50', t('bcf.empty'))];
        return doc.topics.map(topic => {
            const row = el('button', 'flex w-full gap-2 border-b border-white/5 px-3 py-2 text-left hover:bg-white/10');
            const thumb = el('div', 'h-12 w-20 shrink-0 overflow-hidden rounded bg-white/5');
            const url = snapUrl(topic.viewpoints[0]?.snapshot);
            if (url) { const img = el('img', 'size-full object-cover'); img.src = url; img.alt = ''; thumb.append(img); }
            const info = el('div', 'min-w-0 flex-1');
            info.append(el('div', 'truncate font-medium' + (CLOSED.test(topic.status) ? ' text-white/50 line-through' : ''), (topic.index != null ? `#${topic.index} ` : '') + (topic.title || t('bcf.untitled'))));
            info.append(el('div', 'truncate text-white/50', [topic.status, topic.priority, topic.assignedTo].filter(Boolean).join(' · ')));
            const meta = el('div', 'flex flex-wrap gap-1 pt-0.5');
            for (const l of topic.labels.slice(0, 4)) meta.append(el('span', 'rounded bg-white/10 px-1 text-[10px] text-white/70', l));
            if (topic.comments.length) meta.append(el('span', 'text-[10px] text-white/40', t('bcf.commentCount', { count: topic.comments.length })));
            info.append(meta);
            row.append(thumb, info);
            row.onclick = () => {
                current = topic;
                render();
                if (topic.viewpoints[0]) apply(topic.viewpoints[0], topic);
            };
            return row;
        });
    }

    function detail(topic) {
        const out = [];
        const box = el('div', 'flex flex-col gap-1.5 p-3');
        const field = (label, input) => { const r = el('label', 'grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2'); r.append(el('span', 'text-white/50', label), input); return r; };
        const text = (key, { list, type = 'text' } = {}) => {
            const i = el('input', INPUT);
            i.type = type;
            i.value = type === 'date' ? (topic[key] || '').slice(0, 10) : topic[key] ?? '';
            if (list) {
                const id = 'bcf-list-' + key;
                let dl = document.getElementById(id);
                if (!dl) { dl = el('datalist'); dl.id = id; document.body.append(dl); }
                dl.replaceChildren(...list.map(v => Object.assign(el('option'), { value: v })));
                i.setAttribute('list', id);
            }
            i.onchange = () => { topic[key] = type === 'date' && i.value ? `${i.value}T00:00:00Z` : i.value.trim(); touch(topic); if (key === 'title') render(); };
            return i;
        };
        const title = text('title');
        title.dataset.title = '';
        box.append(field(t('bcf.fields.title'), title));
        box.append(field(t('bcf.fields.status'), text('status', { list: values('status', STATUS_DEFAULTS) })));
        box.append(field(t('bcf.fields.type'), text('type', { list: values('type', TYPE_DEFAULTS) })));
        box.append(field(t('bcf.fields.priority'), text('priority', { list: values('priority', PRIORITY_DEFAULTS) })));
        box.append(field(t('bcf.fields.assignedTo'), text('assignedTo', { list: values('assignedTo', []) })));
        box.append(field(t('bcf.fields.dueDate'), text('dueDate', { type: 'date' })));
        const labels = el('input', INPUT);
        labels.value = topic.labels.join(', ');
        labels.onchange = () => { topic.labels = labels.value.split(',').map(s => s.trim()).filter(Boolean); touch(topic); };
        box.append(field(t('bcf.fields.labels'), labels));
        const desc = el('textarea', INPUT + ' min-h-14 resize-y');
        desc.value = topic.description;
        desc.onchange = () => { topic.description = desc.value; touch(topic); };
        box.append(field(t('bcf.fields.description'), desc));
        box.append(el('div', 'text-white/40', t('bcf.created', { author: topic.creationAuthor || t('bcf.anonymous'), date: formatDate(topic.creationDate) })));
        out.push(box);

        // viewpoints
        const vps = el('div', 'border-t border-white/10 p-3');
        vps.append(el('div', 'mb-1.5 font-medium text-white/80', t('bcf.viewpoints')));
        const strip = el('div', 'flex flex-wrap gap-1.5');
        topic.viewpoints.forEach((vp, i) => {
            const b = el('button', 'relative h-14 w-24 overflow-hidden rounded bg-white/5 ring-sky-400 hover:ring-2');
            const url = snapUrl(vp.snapshot);
            if (url) { const img = el('img', 'size-full object-cover'); img.src = url; img.alt = ''; b.append(img); }
            else b.append(el('span', 'text-white/50', t('bcf.viewpointN', { n: i + 1 })));
            b.title = t('bcf.applyViewpoint');
            b.onclick = () => apply(vp, topic);
            const del = el('span', 'absolute top-0.5 right-0.5 hidden rounded bg-black/70 px-1 text-white/80 hover:text-red-300', '✕');
            del.title = t('bcf.deleteViewpoint');
            del.onclick = e => {
                e.stopPropagation();
                topic.viewpoints.splice(i, 1);
                for (const c of topic.comments) if (c.viewpoint === vp.guid) c.viewpoint = null;
                touch(topic);
                render();
            };
            b.onmouseenter = () => { del.hidden = false; del.classList.remove('hidden'); };
            b.onmouseleave = () => del.classList.add('hidden');
            b.append(del);
            strip.append(b);
        });
        const addVp = el('button', 'flex h-14 w-24 items-center justify-center rounded border border-dashed border-white/20 text-white/60 hover:bg-white/10', t('bcf.addViewpoint'));
        addVp.onclick = async () => { topic.viewpoints.push(await capture()); touch(topic); render(); };
        strip.append(addVp);
        vps.append(strip);
        out.push(vps);

        // comments
        const cbox = el('div', 'border-t border-white/10 p-3');
        cbox.append(el('div', 'mb-1.5 font-medium text-white/80', t('bcf.comments')));
        for (const c of topic.comments) {
            const item = el('div', 'mb-2');
            const meta = el('div', 'flex items-center gap-1 text-white/50');
            meta.append(el('span', 'truncate', `${c.author || t('bcf.anonymous')} · ${formatDate(c.date)}`));
            const vp = c.viewpoint && topic.viewpoints.find(v => v.guid === c.viewpoint);
            if (vp) { const b = button(t('bcf.showView'), () => apply(vp, topic), '!px-1 text-sky-300'); meta.append(b); }
            item.append(meta, el('div', 'whitespace-pre-wrap break-words', c.text));
            cbox.append(item);
        }
        const input = el('textarea', INPUT + ' min-h-12 resize-y');
        input.placeholder = t('bcf.commentPlaceholder');
        const withView = el('input');
        withView.type = 'checkbox';
        withView.className = 'accent-sky-400';
        const withLabel = el('label', 'flex items-center gap-1 text-white/60');
        withLabel.append(withView, t('bcf.withView'));
        const addComment = button(t('bcf.addComment'), async () => {
            const textValue = input.value.trim();
            if (!textValue) return;
            let viewpoint = null;
            if (withView.checked) { const vp = await capture(); topic.viewpoints.push(vp); viewpoint = vp.guid; }
            topic.comments.push({ guid: uuid(), date: now(), author: writer(), text: textValue, viewpoint, modifiedDate: '', modifiedAuthor: '' });
            touch(topic);
            render();
        });
        const row = el('div', 'mt-1 flex items-center gap-2');
        row.append(withLabel, el('span', 'flex-1'), addComment);
        cbox.append(input, row);
        out.push(cbox);

        const danger = el('div', 'border-t border-white/10 p-3 text-right');
        danger.append(button(t('bcf.deleteTopic'), () => {
            doc.topics.splice(doc.topics.indexOf(topic), 1);
            current = null;
            dirty = true;
            render();
        }, 'text-red-300'));
        out.push(danger);
        return out;
    }

    function newTopic() {
        const index = Math.max(0, ...(doc?.topics || []).map(x => x.index ?? 0)) + 1;
        return {
            guid: uuid(), type: 'Issue', status: 'Open', title: '', priority: 'Normal', index, labels: [],
            creationDate: now(), creationAuthor: writer(), modifiedDate: '', modifiedAuthor: '', dueDate: '',
            assignedTo: '', stage: '', description: '', header: [], comments: [], viewpoints: [],
        };
    }
    const emptyDoc = () => ({ version: '2.1', project: null, topics: [], name: null });

    function show() { root.hidden = false; render(); onShow(true); }
    window.addEventListener('rindr:bcf-author', () => { if (!root.hidden) render(); });   // changed in the settings
    function hide() { root.hidden = true; onShow(false); }
    return {
        show, hide,
        toggle: () => (root.hidden ? show() : hide()),
        get isOpen() { return !root.hidden; },
        get dirty() { return dirty && !!doc?.topics.length; },
        get doc() { return doc; },
        /** loaded .bcfzip (replaces the current topics) */
        setDocument(d) {
            for (const url of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
            doc = d;
            current = null;
            dirty = false;
            show();
        },
        markSaved(name) { if (doc) doc.name = name; dirty = false; render(); },
        /** scene replaced: issues closed, window hidden */
        clear() {
            for (const url of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
            doc = null;
            current = null;
            dirty = false;
            hide();
        },
    };
}
