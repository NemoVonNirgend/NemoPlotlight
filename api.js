export const BASE_URL = 'https://plotlightstudios.com';
export const MODES = ['names', 'creators', 'tags', 'fandoms', 'genres'];
export const PRESET_MODES = ['names', 'creators', 'styles', 'models'];
export const LOREBOOK_MODES = ['names', 'creators', 'genres', 'types'];
export const PERSONA_MODES = ['names', 'creators'];
export const SORTS = ['recent', 'popular', 'rating'];
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export function publicUrl(value, { sameOrigin = true } = {}) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Missing content URL.');
    const url = new URL(value, BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || (sameOrigin && url.origin !== BASE_URL)) {
        throw new Error('Unsupported content URL.');
    }
    return url;
}

// Published thumbnails do not allow browser CORS. Proxy only this fixed route.
export function portraitUrl(value) {
    const url = publicUrl(value, { sameOrigin: false });
    const media = /^\/api\/published-media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/thumb$/i.exec(url.pathname);
    if (url.origin === BASE_URL && media && !url.search) {
        return `/api/plugins/nemo-plotlight/image/${media[1].toLowerCase()}`;
    }
    return url.href;
}

function tagList(tags) {
    const values = [...new Set(tags ?? [])];
    if (values.length > 10 || values.some(x => typeof x !== 'string' || !x.length || x.length > 50 || x.includes(','))) {
        throw new Error('Choose at most 10 tags per filter.');
    }
    return values;
}

function contentType(type) {
    if (!['cards', 'presets', 'lorebooks', 'personas'].includes(type)) throw new Error('Unsupported content type.');
    return type;
}

export function searchUrl(filters = {}, offset = 0, type = 'cards') {
    contentType(type);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid page offset.');
    const { q = '', mode = 'names', sort = 'recent', minRating = '', hasVn = false } = filters;
    const modes = { cards: MODES, presets: PRESET_MODES, lorebooks: LOREBOOK_MODES, personas: PERSONA_MODES }[type];
    if (typeof q !== 'string' || q.length > 200 || !modes.includes(mode) || !SORTS.includes(sort)) throw new Error('Invalid search filters.');
    const included = tagList(filters.tags), excluded = tagList(filters.excludeTags);
    if (included.some(x => excluded.includes(x))) throw new Error('A tag cannot be both required and excluded.');
    const url = new URL('/api/v1/content', BASE_URL);
    Object.entries({ type, mode, sort, limit: 24, offset }).forEach(([k, v]) => url.searchParams.set(k, v));
    if (q.trim()) url.searchParams.set('q', q.trim());
    if (included.length) url.searchParams.set('tags', included.join(','));
    if (excluded.length) url.searchParams.set('exclude_tags', excluded.join(','));
    if (type !== 'cards') {
        for (const [field, parameter] of [['minRoses', 'min_roses'], ['minFavorites', 'min_favorites']]) {
            if (field === 'minRoses' && type === 'personas') continue;
            const value = filters[field];
            if (value === undefined || value === '') continue;
            const count = Number(value);
            if (!Number.isInteger(count) || count < 0 || count > 1000000) throw new Error('Minimum counts must be whole numbers between 0 and 1000000.');
            url.searchParams.set(parameter, count);
        }
    } else if (minRating !== '') {
        const rating = Number(minRating);
        if (!Number.isFinite(rating) || rating < 0 || rating > 5) throw new Error('Minimum rating must be between 0 and 5.');
        url.searchParams.set('min_rating', rating);
    }
    if (type === 'cards' && hasVn) url.searchParams.set('has_vn', 'true');
    if (type === 'lorebooks' && filters.hasCompendium) url.searchParams.set('has_compendium', 'true');
    return url;
}

export function readPage(page, offset) {
    if (!page || !Array.isArray(page.data) || !page.pagination || !('next_offset' in page.pagination)) {
        throw new Error('Plotlight returned an invalid results page.');
    }
    const next = page.pagination.next_offset;
    if (next !== null && (!Number.isInteger(next) || next <= offset || next > 10000)) {
        throw new Error('Plotlight returned invalid pagination.');
    }
    return { items: page.data, nextOffset: next };
}

export function retryDelay(value, now = Date.now()) {
    if (!value) return 30000;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) ? Math.max(1000, delay) : 30000;
}

// Validate only the portable ST structure; retain sampler settings and extension fields verbatim.
export function validatePreset(data) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    const identifier = value => typeof value === 'string' && value.trim().length > 0;
    if (!object(data) || !Array.isArray(data.prompts) || !Array.isArray(data.prompt_order)) {
        throw new Error('The download is not a SillyTavern chat completion preset.');
    }
    for (const prompt of data.prompts) {
        if (!object(prompt) || !identifier(prompt.identifier)
            || (prompt.marker !== undefined && typeof prompt.marker !== 'boolean')
            || (prompt.content !== undefined ? typeof prompt.content !== 'string' : prompt.marker !== true)
            || (prompt.role !== undefined ? !['system', 'user', 'assistant'].includes(prompt.role) : prompt.marker !== true)) {
            throw new Error('The preset contains an invalid prompt.');
        }
    }
    for (const group of data.prompt_order) {
        if (!object(group) || !Array.isArray(group.order)
            || !(identifier(group.character_id) || Number.isSafeInteger(group.character_id))
            || group.order.some(entry => !object(entry) || !identifier(entry.identifier) || typeof entry.enabled !== 'boolean')) {
            throw new Error('The preset contains an invalid prompt order.');
        }
    }
    return data;
}

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function validateLorebook(data) {
    if (!plainObject(data) || !plainObject(data.entries)) {
        throw new Error('The download is not a SillyTavern lorebook.');
    }
    for (const entry of Object.values(data.entries)) {
        if (!plainObject(entry) || typeof entry.content !== 'string' || !Array.isArray(entry.key)
            || entry.key.some(key => typeof key !== 'string')
            || (entry.keysecondary !== undefined && (!Array.isArray(entry.keysecondary) || entry.keysecondary.some(key => typeof key !== 'string')))
            || (entry.uid !== undefined && (!Number.isSafeInteger(entry.uid) || entry.uid < 0))
            || (entry.comment !== undefined && typeof entry.comment !== 'string')
            || ['constant', 'selective', 'disable'].some(field => entry[field] !== undefined && typeof entry[field] !== 'boolean')) {
            throw new Error('The lorebook contains an invalid entry.');
        }
    }
    return data;
}

const PERSONA_SECTIONS = ['appearance', 'body', 'personality', 'quirks', 'history'];

export function validatePersona(data) {
    const rolecall = data?.spec === 'rolecall_persona';
    const portable = ['chara_card_v2', 'chara_card_v3'].includes(data?.spec);
    const definition = rolecall || portable ? data?.data : data;
    if (!plainObject(data) || !plainObject(definition) || typeof definition.name !== 'string' || !definition.name.trim()
        || (data.spec !== undefined && !rolecall && !portable)
        || (rolecall && data.spec_version !== '1.0')
        || (!rolecall && typeof definition.description !== 'string')
        || ['description', 'content', 'personality', 'scenario'].some(field => definition[field] !== undefined && typeof definition[field] !== 'string')
        || (definition.sections !== undefined && (!plainObject(definition.sections)
            || PERSONA_SECTIONS.some(field => definition.sections[field] !== undefined && typeof definition.sections[field] !== 'string')))) {
        throw new Error('The download is not a supported persona definition.');
    }
    const sections = rolecall ? PERSONA_SECTIONS.map(field => definition.sections?.[field]) : [definition.description, definition.personality, definition.scenario];
    if (!(rolecall && definition.content?.trim()) && !sections.some(value => typeof value === 'string' && value.trim())) {
        throw new Error('The persona has no full definition to import.');
    }
    return data;
}

export function personaDefinition(data) {
    validatePersona(data);
    const rolecall = data.spec === 'rolecall_persona';
    const definition = data.spec ? data.data : data;
    let description;
    if (rolecall && definition.content?.trim()) {
        description = definition.content;
    } else {
        const seen = new Set();
        const fields = rolecall ? PERSONA_SECTIONS : ['description', 'personality', 'scenario'];
        description = fields.flatMap(field => {
            const value = rolecall ? definition.sections?.[field] : definition[field];
            if (!value?.trim() || seen.has(value.trim())) return [];
            seen.add(value.trim());
            return [`${field[0].toUpperCase() + field.slice(1)}:\n${value}`];
        }).join('\n\n');
    }
    const result = { name: definition.name, description, title: rolecall ? (definition.description || '') : '' };
    const imageUrl = data.imageUrl ?? definition.imageUrl;
    if (typeof imageUrl === 'string' && imageUrl.trim()) result.imageUrl = publicUrl(imageUrl, { sameOrigin: false }).href;
    return result;
}

function libraryDownloadUrl(item, type, format) {
    const url = publicUrl(item.downloads?.[format]);
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    if (!new RegExp(`^/api/v1/content/${type}/${uuid}(?:/download)?$`, 'i').test(url.pathname)) {
        throw new Error(`Invalid ${type === 'lorebooks' ? 'lorebook' : 'persona'} download URL.`);
    }
    return url;
}

async function libraryFile(blob, item, label, validate) {
    let data;
    try { data = JSON.parse(await blob.text()); } catch { throw new Error(`Plotlight did not return valid ${label.toLowerCase()} JSON.`); }
    validate(data);
    return new File([blob], `${fileName(item, `Plotlight ${label.toLowerCase()}`)}.json`, { type: 'application/json' });
}

export async function boundedBlob(response, label) {
    if (Number(response.headers.get('Content-Length')) > MAX_FILE_BYTES) throw new Error(`${label} exceeds the 30 MB import limit.`);
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_FILE_BYTES) {
                await reader.cancel();
                throw new Error(`${label} exceeds the 30 MB import limit.`);
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    return new Blob(chunks);
}

function fileName(item, fallback) {
    return String(item.name || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
}

export class PlotlightClient {
    constructor(fetchImpl = globalThis.fetch.bind(globalThis), now = () => Date.now()) {
        this.fetch = fetchImpl;
        this.now = now;
        this.cooldowns = new Map();
    }

    async request(url, { signal, group = 'search', consume = r => r.json(), local = false } = {}) {
        const remaining = (this.cooldowns.get(group) ?? 0) - this.now();
        if (remaining > 0) throw new Error(`Plotlight is rate limited. Try again in ${Math.ceil(remaining / 1000)} seconds.`);
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(() => controller.abort(new Error('Plotlight request timed out. Please retry.')), 45000);
        try {
            if (local && !/^\/api\/plugins\/nemo-plotlight\/persona\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(url))) {
                throw new Error('Invalid public persona helper URL.');
            }
            const response = await this.fetch(local ? String(url) : publicUrl(String(url)), {
                credentials: local ? 'same-origin' : 'omit', signal: controller.signal, redirect: 'error',
            });
            if (!response.ok) {
                if (response.status === 429) {
                    const delay = retryDelay(response.headers.get('Retry-After'), this.now());
                    this.cooldowns.set(group, this.now() + delay);
                    throw Object.assign(new Error(`Plotlight is rate limited. Try again in ${Math.ceil(delay / 1000)} seconds.`), { status: response.status });
                }
                const messages = {
                    400: 'Plotlight rejected these filters or this download format.',
                    401: 'This content is not available through the public API.',
                    403: 'This content is not exportable to guests.',
                    404: 'This content or download is no longer available.',
                };
                throw Object.assign(new Error(messages[response.status] ?? `Plotlight request failed (${response.status}). Please retry.`), { status: response.status });
            }
            return await consume(response);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    async search(filters, offset = 0, signal, type = 'cards') {
        return readPage(await this.request(searchUrl(filters, offset, type), { signal }), offset);
    }

    async tags(offset = 0, signal, type = 'cards') {
        contentType(type);
        const url = new URL('/api/v1/content/tags', BASE_URL);
        Object.entries({ type, limit: 100, offset }).forEach(([k, v]) => url.searchParams.set(k, v));
        return readPage(await this.request(url, { signal }), offset);
    }

    async download(item, format = 'png', signal) {
        if (!['png', 'png3', 'json', 'json3'].includes(format)) throw new Error('Unsupported card format.');
        const url = publicUrl(item.downloads?.[format]);
        if (!/^\/api\/v1\/content\/(cards|characters)\/[0-9a-f-]{36}(?:\/download)?$/i.test(url.pathname)) {
            throw new Error('Invalid card download URL.');
        }
        const blob = await this.request(url, { signal, group: 'export', consume: response => boundedBlob(response, 'Card') });
        const png = format.startsWith('png');
        if (png) {
            const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
            if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => signature[i] === v)) {
                throw new Error('Plotlight did not return a PNG card.');
            }
        } else {
            let data;
            try { data = JSON.parse(await blob.text()); } catch { throw new Error('Plotlight did not return valid card JSON.'); }
            if (!['chara_card_v2', 'chara_card_v3'].includes(data?.spec) || typeof data?.data?.name !== 'string') {
                throw new Error('The download is not a V2 or V3 character card.');
            }
        }
        const name = fileName(item, 'Plotlight card');
        return new File([blob], `${name}.${png ? 'png' : 'json'}`, { type: png ? 'image/png' : 'application/json' });
    }

    async downloadPreset(item, signal) {
        const url = publicUrl(item.downloads?.legacy);
        if (!/^\/api\/v1\/content\/presets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/download)?$/i.test(url.pathname)) {
            throw new Error('Invalid preset download URL.');
        }
        const blob = await this.request(url, { signal, group: 'export', consume: response => boundedBlob(response, 'Preset') });
        let data;
        try { data = JSON.parse(await blob.text()); } catch { throw new Error('Plotlight did not return valid preset JSON.'); }
        validatePreset(data);
        return new File([blob], `${fileName(item, 'Plotlight preset')}.json`, { type: 'application/json' });
    }

    async downloadLorebook(item, signal) {
        const url = libraryDownloadUrl(item, 'lorebooks', 'st');
        const blob = await this.request(url, { signal, group: 'export', consume: response => boundedBlob(response, 'Lorebook') });
        return libraryFile(blob, item, 'Lorebook', validateLorebook);
    }

    async downloadPersona(item, signal) {
        const url = libraryDownloadUrl(item, 'personas', 'json');
        let blob, fallback = false;
        try {
            blob = await this.request(url, { signal, group: 'export', consume: response => boundedBlob(response, 'Persona') });
        } catch (error) {
            if (error.status !== 404) throw error;
            const id = url.pathname.split('/')[5];
            try {
                blob = await this.request(`/api/plugins/nemo-plotlight/persona/${id}`, {
                    signal, group: 'export', local: true, consume: response => boundedBlob(response, 'Persona'),
                });
            } catch (helperError) {
                if (helperError.status === 404) {
                    throw new Error('This persona needs the Nemo Plotlight server helper. Install it, enable server plugins, and restart SillyTavern.');
                }
                throw helperError;
            }
            fallback = true;
        }
        const file = await libraryFile(blob, item, 'Persona', validatePersona);
        if (fallback) {
            const data = JSON.parse(await file.text());
            if (data.spec !== 'rolecall_persona' || data.source !== 'public-definition') {
                throw new Error('The public persona helper returned an invalid definition.');
            }
            file.nplSource = 'public-definition';
            file.nplLinkedLorebookOmitted = data.linkedLorebookOmitted === true;
            const imageUrl = personaDefinition(data).imageUrl;
            if (imageUrl) file.nplImageUrl = imageUrl;
        }
        return file;
    }
}

// ST's native importer catches some errors. Check for a new avatar before recording success.
export async function importAndVerify(file, { getCharacters, processFiles }) {
    const before = new Set(getCharacters().map(c => c.avatar));
    await processFiles([file]);
    const added = getCharacters().filter(c => !before.has(c.avatar));
    if (added.length !== 1) throw new Error('Import could not be confirmed. Check the character list and SillyTavern notifications before retrying.');
    return added[0].avatar;
}

// Public discovery statistics need ST's local helper because those routes do not allow browser CORS.
export async function fetchCardStats(id, { signal, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error('Invalid card ID.');
    }
    const response = await fetchImpl(`/api/plugins/nemo-plotlight/stats/${id}`, {
        signal, credentials: 'same-origin', redirect: 'error',
    });
    if (response.status === 404) throw new Error('Install the Nemo Plotlight server helper to show ratings and roses.');
    if (!response.ok) throw new Error('Card statistics are temporarily unavailable.');
    return response.json();
}
