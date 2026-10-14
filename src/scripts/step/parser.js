// STEP (ISO 10303-21) Parser.
//
// Two stages, so several workers can use the same file:
//  1. buildIndex(): a single linear scan over the bytes, returns for every
//     entity id the byte offset of its body (after the '='). Optionally the
//     ids of selected types are collected (e.g. STYLED_ITEM).
//  2. StepFile.get(id): parses an entity only on demand (lazy) and caches it.
//
// Bytes and index can be SharedArrayBuffer-based – then all workers share
// the same memory without a copy.
//
// Value representation after parsing:
//   #123        -> Ref(123)            (instance of Ref)
//   1.5 / 12    -> number
//   'text'      -> string
//   .T. / .F.   -> true / false
//   .ENUM.      -> Enum('ENUM')
//   $ / *       -> null
//   (a, b)      -> Array
//   NAME(...)   -> { type: 'NAME', args } (typed parameter, e.g. LENGTH_MEASURE(1.))

const C_HASH = 35, C_EQ = 61, C_SEMI = 59, C_QUOTE = 39, C_LPAR = 40, C_RPAR = 41,
    C_COMMA = 44, C_DOT = 46, C_DOLLAR = 36, C_STAR = 42, C_SLASH = 47, C_MINUS = 45, C_PLUS = 43;

export class Ref {
    constructor(id) { this.id = id; }
}
export class Enum {
    constructor(name) { this.name = name; }
}

function isSpace(c) { return c === 32 || c === 10 || c === 13 || c === 9; }
function isLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function isDigit(c) { return c >= 48 && c <= 57; }

const POW10 = [];
for (let i = 0; i <= 22; i++) POW10.push(Math.pow(10, i));

// Finds the start of the DATA section ("DATA;")
function findData(bytes) {
    const n = bytes.length;
    for (let i = 0; i < n - 5; i++) {
        if (bytes[i] === 68 && bytes[i + 1] === 65 && bytes[i + 2] === 84 && bytes[i + 3] === 65) {
            let j = i + 4;
            while (j < n && isSpace(bytes[j])) j++;
            if (bytes[j] === C_SEMI && (i === 0 || !isLetter(bytes[i - 1]))) return j + 1;
        }
        // skip strings in the header
        if (bytes[i] === C_QUOTE) {
            i++;
            while (i < n && bytes[i] !== C_QUOTE) i++;
        }
    }
    return 0;
}

/**
 * Builds the offset index. Returns { offsets: Int32Array|Float64Array, maxId, typeIds: {TYPE: number[]} }.
 * offsets[id] = byte position of the entity body, -1 if not present. Files of 2 GB and more need
 * 64-bit positions (Float64Array, exact up to 2^53), otherwise Int32Array suffices (half the memory).
 * @param {Uint8Array} bytes
 * @param {string[]} collectTypes type names whose ids should be collected
 * @param {boolean} shared create the index in a SharedArrayBuffer
 */
export function buildIndex(bytes, collectTypes = [], shared = false) {
    const n = bytes.length;
    let pos = findData(bytes);
    const collect = new Set(collectTypes);
    const typeIds = {};
    for (const t of collectTypes) typeIds[t] = [];

    // collect ids and offsets in growing buffers first
    const Offsets = n > 0x7fffffff ? Float64Array : Int32Array;
    let ids = new Int32Array(1 << 16), offs = new Offsets(1 << 16), count = 0, maxId = 0;

    while (pos < n) {
        const c = bytes[pos];
        if (c === C_HASH) {
            pos++;
            let id = 0;
            while (pos < n && isDigit(bytes[pos])) id = id * 10 + (bytes[pos++] - 48);
            while (pos < n && isSpace(bytes[pos])) pos++;
            if (bytes[pos] !== C_EQ) continue;
            pos++;
            while (pos < n && isSpace(bytes[pos])) pos++;
            if (count === ids.length) {
                const ni = new Int32Array(count * 2); ni.set(ids); ids = ni;
                const no = new Offsets(count * 2); no.set(offs); offs = no;
            }
            ids[count] = id; offs[count] = pos; count++;
            if (id > maxId) maxId = id;

            if (collect.has('COMPLEX') && bytes[pos] === C_LPAR) typeIds.COMPLEX.push(id);
            else if (collect.size && isLetter(bytes[pos])) {
                let s = '';
                let p = pos;
                while (p < n && (isLetter(bytes[p]) || isDigit(bytes[p]))) s += String.fromCharCode(bytes[p++]);
                s = s.toUpperCase();
                if (collect.has(s)) typeIds[s].push(id);
            }

            // jump to the terminating ';' (respecting strings)
            while (pos < n) {
                const d = bytes[pos];
                if (d === C_QUOTE) {
                    pos++;
                    while (pos < n) {
                        if (bytes[pos] === C_QUOTE) {
                            if (bytes[pos + 1] === C_QUOTE) { pos += 2; continue; }
                            break;
                        }
                        pos++;
                    }
                    pos++;
                } else if (d === C_SEMI) { pos++; break; }
                else pos++;
            }
        } else if (c === C_SLASH && bytes[pos + 1] === C_STAR) {
            pos += 2;
            while (pos < n - 1 && !(bytes[pos] === C_STAR && bytes[pos + 1] === C_SLASH)) pos++;
            pos += 2;
        } else if (c === 69 && bytes[pos + 1] === 78 && bytes[pos + 2] === 68 && bytes[pos + 3] === 83) {
            break; // ENDSEC
        } else {
            pos++;
        }
    }

    // shared with cross-origin isolation: postMessage to the workers then does not copy
    const size = (maxId + 1) * Offsets.BYTES_PER_ELEMENT;
    const buf = shared && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(size) : new ArrayBuffer(size);
    const offsets = new Offsets(buf);
    offsets.fill(-1);
    for (let i = 0; i < count; i++) offsets[ids[i]] = offs[i];
    return { offsets, maxId, count, typeIds };
}

// --- Entity-Parser ---

export class StepFile {
    /**
     * @param {Uint8Array} bytes
     * @param {Int32Array} offsets
     */
    constructor(bytes, offsets) {
        this.bytes = bytes;
        this.offsets = offsets;
        this.cache = new Map();
        // Upper limit of the entity cache: for large files (millions of entities) it would otherwise
        // hold the whole file as JS objects (>1 GB per worker). When it is full, it is cleared;
        // callers keep the entities they need as direct references anyway.
        this.cacheLimit = 250000;
        this.pos = 0;
    }

    has(id) {
        return id >= 0 && id < this.offsets.length && this.offsets[id] >= 0;
    }

    /** Returns { id, type, args } or for complex entities { id, type: 'COMPLEX', parts: {NAME: args} } */
    get(id) {
        if (id instanceof Ref) id = id.id;
        let e = this.cache.get(id);
        if (e !== undefined) return e;
        if (!this.has(id)) return null;
        this.pos = this.offsets[id];
        e = this.parseEntity();
        e.id = id;
        if (this.cache.size >= this.cacheLimit) this.cache.clear();
        this.cache.set(id, e);
        return e;
    }

    skipWs() {
        const b = this.bytes;
        let p = this.pos;
        for (;;) {
            const c = b[p];
            if (c === 32 || c === 10 || c === 13 || c === 9) p++;
            else if (c === C_SLASH && b[p + 1] === C_STAR) {
                p += 2;
                while (p < b.length - 1 && !(b[p] === C_STAR && b[p + 1] === C_SLASH)) p++;
                p += 2;
            } else break;
        }
        this.pos = p;
    }

    readKeyword() {
        const b = this.bytes;
        let p = this.pos, s = '';
        while (isLetter(b[p]) || isDigit(b[p]) || b[p] === C_MINUS) s += String.fromCharCode(b[p++]);
        this.pos = p;
        return s.toUpperCase();
    }

    parseEntity() {
        this.skipWs();
        if (this.bytes[this.pos] === C_LPAR) {
            // complex entity: (A(...) B(...) ...)
            this.pos++;
            const parts = {};
            for (;;) {
                this.skipWs();
                if (this.bytes[this.pos] === C_RPAR) { this.pos++; break; }
                const name = this.readKeyword();
                if (!name) throw new Error('STEP: invalid complex entity at byte ' + this.pos);
                this.skipWs();
                parts[name] = this.parseList();
            }
            return { type: 'COMPLEX', parts, args: null };
        }
        const type = this.readKeyword();
        this.skipWs();
        const args = this.parseList();
        return { type, args };
    }

    parseList() {
        const b = this.bytes;
        if (b[this.pos] !== C_LPAR) throw new Error('STEP: "(" expected at byte ' + this.pos);
        this.pos++;
        const out = [];
        this.skipWs();
        if (b[this.pos] === C_RPAR) { this.pos++; return out; }
        for (;;) {
            this.skipWs();
            out.push(this.parseValue());
            this.skipWs();
            const c = b[this.pos];
            if (c === C_COMMA) { this.pos++; continue; }
            if (c === C_RPAR) { this.pos++; return out; }
            throw new Error('STEP: "," or ")" expected at byte ' + this.pos);
        }
    }

    parseValue() {
        const b = this.bytes;
        const c = b[this.pos];
        if (c === C_HASH) {
            let p = this.pos + 1, id = 0;
            while (isDigit(b[p])) id = id * 10 + (b[p++] - 48);
            this.pos = p;
            return new Ref(id);
        }
        if (isDigit(c) || c === C_MINUS || c === C_PLUS || c === C_DOT && isDigit(b[this.pos + 1])) return this.parseNumber();
        if (c === C_QUOTE) return this.parseString();
        if (c === C_LPAR) return this.parseList();
        if (c === C_DOLLAR || c === C_STAR) { this.pos++; return null; }
        if (c === C_DOT) {
            let p = this.pos + 1, s = '';
            while (b[p] !== C_DOT && p < b.length) s += String.fromCharCode(b[p++]);
            this.pos = p + 1;
            s = s.toUpperCase();
            if (s === 'T') return true;
            if (s === 'F') return false;
            if (s === 'U') return null;
            return new Enum(s);
        }
        if (c === 34) { // "..." binary
            let p = this.pos + 1;
            while (b[p] !== 34) p++;
            this.pos = p + 1;
            return null;
        }
        if (isLetter(c)) {
            const type = this.readKeyword();
            this.skipWs();
            return { type, args: this.parseList() };
        }
        throw new Error('STEP: unexpected character "' + String.fromCharCode(c) + '" at byte ' + this.pos);
    }

    parseNumber() {
        const b = this.bytes;
        let p = this.pos, neg = false;
        if (b[p] === C_MINUS) { neg = true; p++; } else if (b[p] === C_PLUS) p++;
        let mant = 0, digits = 0, exp = 0;
        while (isDigit(b[p])) {
            if (digits < 17) { mant = mant * 10 + (b[p] - 48); digits++; } else exp++;
            p++;
        }
        if (b[p] === C_DOT) {
            p++;
            while (isDigit(b[p])) {
                if (digits < 17) { mant = mant * 10 + (b[p] - 48); digits++; exp--; }
                p++;
            }
        }
        if (b[p] === 69 || b[p] === 101) { // E/e
            p++;
            let eneg = false, e = 0;
            if (b[p] === C_MINUS) { eneg = true; p++; } else if (b[p] === C_PLUS) p++;
            while (isDigit(b[p])) e = e * 10 + (b[p++] - 48);
            exp += eneg ? -e : e;
        }
        this.pos = p;
        let v;
        if (exp === 0) v = mant;
        else if (exp < 0 && exp >= -22) v = mant / POW10[-exp];
        else if (exp > 0 && exp <= 22) v = mant * POW10[exp];
        else v = mant * Math.pow(10, exp);
        return neg ? -v : v;
    }

    parseString() {
        const b = this.bytes;
        const start = this.pos + 1;
        let p = start, s = '', high = false;
        for (;;) {
            const c = b[p];
            if (c === undefined) break;
            if (c === C_QUOTE) {
                if (b[p + 1] === C_QUOTE) { s += "'"; p += 2; continue; }
                p++;
                break;
            }
            if (c >= 0x80) high = true;
            s += String.fromCharCode(c);
            p++;
        }
        this.pos = p;
        // The standard wants ASCII with \X2\ escapes, but many exporters (FreeCAD, …) write raw UTF-8:
        // read as one char per byte it became 'NorÃ©e'. Valid UTF-8 → decode it, otherwise Latin-1.
        // (slice: TextDecoder rejects views on a SharedArrayBuffer)
        if (high) {
            try { s = UTF8.decode(b.slice(start, b[p - 1] === C_QUOTE ? p - 1 : p)).replace(/''/g, "'"); } catch { /* not UTF-8: keep Latin-1 */ }
        }
        return s.indexOf('\\') >= 0 ? decodeStepString(s) : s;
    }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Decodes STEP escapes: \X2\00E4\X0\ (UCS-2), \X\E4 (ISO-8859-1), \S\x, \\
export function decodeStepString(s) {
    return s
        .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
            let out = '';
            for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
            return out;
        })
        .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
            let out = '';
            for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.substr(i, 8), 16));
            return out;
        })
        .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\S\\(.)/g, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 128))
        .replace(/\\\\/g, '\\');
}

// Helper functions for complex entities
export function partArgs(e, name) {
    if (!e) return null;
    if (e.type === name) return e.args;
    if (e.type === 'COMPLEX') return e.parts[name] || null;
    return null;
}

export function hasPart(e, name) {
    return e && (e.type === name || (e.type === 'COMPLEX' && name in e.parts));
}
