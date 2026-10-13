const ORIGIN = 'https://plotlightstudios.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL = 5 * 60_000;
const MAX_PENDING = 128;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function imageType(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return null;
}

export const info = {
    id: 'nemo-plotlight',
    name: 'Nemo Plotlight metadata',
    description: 'Anonymous public character metadata and portable persona definitions for the Plotlight navigator.',
};

export class StatsError extends Error {
    constructor(status, message, retryAfter) {
        super(message);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rating = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;

function portablePersona(detail, id) {
    const persona = detail?.persona;
    if (detail?.success !== true || !persona || persona.id !== id || typeof persona.name !== 'string' || !persona.name.trim()) {
        throw new StatsError(502, 'Plotlight returned invalid public persona metadata.');
    }
    const content = typeof persona.content === 'string' ? persona.content : '';
    const sections = {};
    for (const key of ['appearance', 'body', 'personality', 'quirks', 'history']) {
        const value = persona.details?.[key];
        if (typeof value === 'string' && value.trim()) sections[key] = value;
    }
    if (!content.trim() && !Object.keys(sections).length) {
        throw new StatsError(422, 'This published persona has no portable definition available.');
    }
    let imageUrl = null;
    try {
        const image = new URL(persona.imageUrl);
        if (image.protocol === 'https:' && !image.username && !image.password) imageUrl = image.href;
    } catch { /* Missing or invalid image URLs are optional. */ }
    const creator = persona.creator;
    return {
        spec: 'rolecall_persona',
        spec_version: '1.0',
        data: {
            name: persona.name,
            description: typeof persona.description === 'string' ? persona.description : '',
            content,
            sections,
            metadata: {
                creator: typeof creator?.name === 'string' ? creator.name : typeof creator?.username === 'string' ? creator.username : '',
                source: 'plotlight-public-definition',
            },
        },
        imageUrl,
        source: 'public-definition',
        linkedLorebookOmitted: Boolean(persona.details?.lorebookId),
    };
}

export function createStatsService({ fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12_000 } = {}) {
    const cache = new Map();
    const pending = new Map();
    const queue = [];
    let active = 0;
    let cooldownUntil = 0;

    function checkCooldown() {
        if (now() < cooldownUntil) {
            throw new StatsError(429, 'Plotlight is temporarily rate limited.', Math.ceil((cooldownUntil - now()) / 1000));
        }
    }

    function rateLimit(response) {
        const header = response.headers.get('retry-after');
        const seconds = header && /^\d+(?:\.\d+)?$/.test(header.trim())
            ? Number(header) : (Date.parse(header) - now()) / 1000;
        const delay = Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : 30;
        cooldownUntil = Math.max(cooldownUntil, now() + delay * 1000);
        throw new StatsError(429, 'Plotlight is temporarily rate limited.', Math.ceil((cooldownUntil - now()) / 1000));
    }

    async function request(path, signal) {
        checkCooldown();
        const response = await fetchImpl(`${ORIGIN}${path}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            credentials: 'omit',
            redirect: 'error',
            signal,
        });
        if (response.status === 429) rateLimit(response);
        if (!response.ok) throw new StatsError(response.status >= 500 ? 503 : 502, 'Plotlight metadata is unavailable.');
        return response.json();
    }

    async function loadImage(id, signal) {
        checkCooldown();
        const response = await fetchImpl(`${ORIGIN}/api/published-media/${id}/thumb`, {
            method: 'GET',
            headers: { Accept: IMAGE_TYPES.join(', ') },
            credentials: 'omit',
            redirect: 'error',
            signal,
        });
        if (response.status === 429) rateLimit(response);
        if (!response.ok) throw new StatsError(response.status >= 500 ? 503 : 502, 'Plotlight image is unavailable.');
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_TYPES.includes(contentType)) throw new StatsError(502, 'Plotlight returned an unsupported image type.');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) {
            throw new StatsError(502, 'Plotlight image exceeds the size limit or has an invalid size.');
        }
        if (!response.body?.getReader) throw new StatsError(502, 'Plotlight returned an empty image.');
        const reader = response.body.getReader();
        // A fixed buffer also bounds memory when upstream yields many tiny chunks.
        const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES);
        let size = 0;
        let finished = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (signal.aborted) throw new StatsError(503, 'Plotlight image request timed out.');
                if (done) {
                    finished = true;
                    break;
                }
                if (size + value.byteLength > MAX_IMAGE_BYTES) throw new StatsError(502, 'Plotlight image exceeds the size limit.');
                buffer.set(value, size);
                size += value.byteLength;
            }
        } finally {
            if (!finished) void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        const bytes = Buffer.from(buffer.subarray(0, size));
        if (imageType(bytes) !== contentType) throw new StatsError(502, 'Plotlight returned invalid image data.');
        return { bytes, contentType };
    }

    async function load(id, signal, onDetail) {
        checkCooldown();
        const detail = await request(`/api/discovery/characters/${id}`, signal);
        const character = detail.character;
        // The anonymous discovery endpoint returns published characters only.
        if (detail.success !== true || !character || character.id !== id) {
            throw new StatsError(502, 'Plotlight returned invalid public character metadata.');
        }
        const metadata = {
            id,
            ratingAverage: rating(character.ratingAverage),
            ratingCount: count(character.ratingCount),
            favoriteCount: count(character.favoriteCount),
            rosesTotal: null,
            partial: false,
        };
        onDetail(metadata);
        try {
            const social = await request(`/api/social/stars?type=character&id=${id}`, signal);
            metadata.rosesTotal = count(social.total);
            metadata.partial = metadata.rosesTotal === null;
        } catch (error) {
            metadata.partial = true;
            if (error instanceof StatsError && error.retryAfter) metadata.retryAfter = error.retryAfter;
        }
        return metadata;
    }

    async function run(kind, id) {
        const controller = new AbortController();
        let timer;
        let detailMetadata;
        try {
            return await Promise.race([
                kind === 'stats'
                    ? load(id, controller.signal, metadata => { detailMetadata = metadata; })
                    : kind === 'image' ? loadImage(id, controller.signal)
                    : request(`/api/discovery/personas/${id}`, controller.signal).then(detail => portablePersona(detail, id)),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new StatsError(503, `Plotlight ${kind === 'image' ? 'image' : 'metadata'} request timed out.`));
                    }, timeoutMs);
                }),
            ]);
        } catch (error) {
            controller.abort();
            if (detailMetadata) return { ...detailMetadata, partial: true };
            if (error instanceof StatsError) throw error;
            throw new StatsError(502, `Plotlight ${kind === 'image' ? 'image' : 'metadata'} could not be fetched.`);
        } finally {
            clearTimeout(timer);
        }
    }

    function drain() {
        while (active < 2 && queue.length) {
            const { kind, id, key, resolve, reject } = queue.shift();
            active++;
            run(kind, id).then(metadata => {
                if (kind !== 'image' && !metadata.partial) {
                    cache.delete(key);
                    cache.set(key, { metadata, expires: now() + CACHE_TTL });
                    while (cache.size > 500) cache.delete(cache.keys().next().value);
                }
                pending.delete(key);
                resolve(kind === 'image' ? metadata : structuredClone(metadata));
            }, error => {
                pending.delete(key);
                reject(error);
            }).finally(() => {
                active--;
                drain();
            });
        }
    }

    function get(kind, value) {
        if (typeof value !== 'string' || !UUID.test(value)) return Promise.reject(new StatsError(400, 'A valid UUID is required.'));
        const id = value.toLowerCase();
        const key = `${kind}:${id}`;
        const cached = cache.get(key);
        if (cached?.expires > now()) return Promise.resolve(structuredClone(cached.metadata));
        cache.delete(key);
        if (pending.has(key)) return pending.get(key);
        if (pending.size >= MAX_PENDING) return Promise.reject(new StatsError(503, 'Plotlight metadata queue is full. Try again shortly.'));
        const promise = new Promise((resolve, reject) => queue.push({ kind, id, key, resolve, reject }));
        pending.set(key, promise);
        drain();
        return promise;
    }

    return { getStats: id => get('stats', id), getPersona: id => get('persona', id), getImage: id => get('image', id) };
}

export async function init(router) {
    const service = createStatsService();
    function route(getter) {
        return async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try {
                const metadata = await getter(req.params.id);
                if (metadata.retryAfter) res.set('Retry-After', String(metadata.retryAfter));
                res.json(metadata);
            } catch (error) {
                if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
                res.status(error.status || 502).json({ error: error.message });
            }
        };
    }
    router.get('/stats/:id', route(service.getStats));
    router.get('/persona/:id', route(service.getPersona));
    router.get('/image/:id', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        try {
            const { bytes, contentType } = await service.getImage(req.params.id);
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'private, max-age=300');
            res.send(bytes);
        } catch (error) {
            if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
            res.status(error.status || 502).json({ error: error.message });
        }
    });
}
