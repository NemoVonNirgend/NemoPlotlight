import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsService, init } from './index.mjs';

const ID = 'a7ba9838-a1c2-4796-a7b0-1fb88feff932';
const otherId = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const response = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
});
const detail = (id = ID, stats = {}) => response({ success: true, character: {
    id, ratingAverage: 4.5, ratingCount: 2, favoriteCount: 11, rosesCount: 999, ...stats,
} });
const tick = () => new Promise(resolve => setImmediate(resolve));
const personaDetail = (id = ID, extra = {}) => response({ success: true, persona: {
    id, name: 'Persona', description: 'UI summary', content: '', details: { appearance: 'Appearance definition' }, ...extra,
} });

test('uses only the two fixed anonymous endpoints and returns social roses, not legacy roses', async () => {
    const calls = [];
    const service = createStatsService({ fetch: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1 ? detail() : response({ total: 97, you: { roses: 500 } });
    } });
    assert.deepEqual(await service.getStats(ID), {
        id: ID, ratingAverage: 4.5, ratingCount: 2, favoriteCount: 11, rosesTotal: 97, partial: false,
    });
    assert.deepEqual(calls.map(call => call.url), [
        `https://plotlightstudios.com/api/discovery/characters/${ID}`,
        `https://plotlightstudios.com/api/social/stars?type=character&id=${ID}`,
    ]);
    for (const { options } of calls) {
        assert.equal(options.method, 'GET');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.deepEqual(options.headers, { Accept: 'application/json' });
        assert.ok(options.signal instanceof AbortSignal);
    }
});

test('rejects invalid UUIDs without network calls', async () => {
    let calls = 0;
    const service = createStatsService({ fetch: async () => { calls++; } });
    for (const id of [null, '', '../admin', `${ID}?url=https://localhost`, 'https://localhost', 12]) {
        await assert.rejects(service.getStats(id), error => error.status === 400);
    }
    assert.equal(calls, 0);
});

test('requires successful detail and the exact public character UUID before fetching social data', async () => {
    for (const body of [
        { success: false, character: { id: ID } },
        { success: true, character: { id: otherId(1) } },
        { success: true, character: { id: ID.toUpperCase() } },
        { success: true },
    ]) {
        let calls = 0;
        const service = createStatsService({ fetch: async () => { calls++; return response(body); } });
        await assert.rejects(service.getStats(ID), error => error.status === 502);
        assert.equal(calls, 1);
    }
});

test('retains real zeros and uses null for invalid or missing values', async () => {
    for (const stats of [
        { ratingAverage: '5', ratingCount: -1, favoriteCount: 2.2 },
        { ratingAverage: 5.01, ratingCount: '2', favoriteCount: Number.MAX_SAFE_INTEGER + 1 },
        { ratingAverage: null, ratingCount: undefined, favoriteCount: NaN },
    ]) {
        const service = createStatsService({ fetch: async url => url.includes('/discovery/') ? detail(ID, stats) : response({ total: '10' }) });
        const result = await service.getStats(ID);
        assert.equal(result.ratingAverage, null);
        assert.equal(result.ratingCount, null);
        assert.equal(result.favoriteCount, null);
        assert.equal(result.rosesTotal, null);
    }
    const service = createStatsService({ fetch: async url => url.includes('/discovery/')
        ? detail(ID, { ratingAverage: 0, ratingCount: 0, favoriteCount: 0 }) : response({ total: 0 }) });
    assert.deepEqual(await service.getStats(ID), {
        id: ID, ratingAverage: 0, ratingCount: 0, favoriteCount: 0, rosesTotal: 0, partial: false,
    });
});

test('deduplicates concurrent requests and expires successful metadata after five minutes', async () => {
    let now = 1000;
    let calls = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const service = createStatsService({ now: () => now, fetch: async url => {
        calls++;
        await barrier;
        return url.includes('/discovery/') ? detail() : response({ total: 97 });
    } });
    const first = service.getStats(ID);
    const second = service.getStats(ID.toUpperCase());
    assert.strictEqual(first, second);
    release();
    const result = await first;
    result.ratingAverage = 1;
    assert.equal((await service.getStats(ID)).ratingAverage, 4.5);
    assert.equal(calls, 2);
    now += 5 * 60_000;
    await service.getStats(ID);
    assert.equal(calls, 4);
});

test('cache is capped at 500 characters', async () => {
    let calls = 0;
    const service = createStatsService({ fetch: async url => {
        calls++;
        return url.includes('/discovery/') ? detail(url.split('/').at(-1)) : response({ total: 0 });
    } });
    for (let i = 0; i < 501; i++) await service.getStats(otherId(i));
    const initial = calls;
    await service.getStats(otherId(500));
    assert.equal(calls, initial);
    await service.getStats(otherId(0));
    assert.equal(calls, initial + 2);
});

test('preserves detail when social fails and retries transient partial results', async () => {
    let calls = 0;
    const service = createStatsService({ fetch: async url => {
        calls++;
        if (url.includes('/discovery/')) return detail();
        if (calls === 2) throw new Error('connection failed');
        return response({ total: 97 });
    } });
    const partial = await service.getStats(ID);
    assert.equal(partial.ratingAverage, 4.5);
    assert.equal(partial.favoriteCount, 11);
    assert.equal(partial.rosesTotal, null);
    assert.equal(partial.partial, true);
    assert.equal((await service.getStats(ID)).rosesTotal, 97);
    assert.equal(calls, 4);
});

test('does not cache social metadata with a missing or invalid total', async () => {
    for (const body of [{}, { total: -1 }, { total: 0.5 }, { total: '97' }]) {
        let calls = 0;
        const service = createStatsService({ fetch: async url => {
            calls++;
            if (url.includes('/discovery/')) return detail();
            return calls === 2 ? response(body) : response({ total: 97 });
        } });
        const result = await service.getStats(ID);
        assert.equal(result.partial, true);
        assert.equal(result.rosesTotal, null);
        assert.equal((await service.getStats(ID)).rosesTotal, 97);
        assert.equal(calls, 4);
    }
});

test('reports detail failures and retries instead of caching them', async () => {
    let calls = 0;
    const service = createStatsService({ fetch: async url => {
        calls++;
        if (calls === 1) return response({}, 503);
        return url.includes('/discovery/') ? detail() : response({ total: 97 });
    } });
    await assert.rejects(service.getStats(ID), error => error.status === 503);
    assert.equal((await service.getStats(ID)).rosesTotal, 97);
    assert.equal(calls, 3);
});

test('upstream 429 establishes shared cooldown and permits retry after Retry-After', async () => {
    let now = 1000;
    let calls = 0;
    const service = createStatsService({ now: () => now, fetch: async url => {
        calls++;
        if (calls === 1) return response({}, 429, { 'Retry-After': '8' });
        return url.includes('/discovery/') ? detail(url.split('/').at(-1)) : response({ total: 1 });
    } });
    await assert.rejects(service.getStats(ID), error => error.status === 429 && error.retryAfter === 8);
    now += 2000;
    await assert.rejects(service.getStats(otherId(1)), error => error.status === 429 && error.retryAfter === 6);
    assert.equal(calls, 1);
    now += 6000;
    assert.equal((await service.getStats(ID)).rosesTotal, 1);
    assert.equal(calls, 3);
});

test('social rate limit retains detail and supports HTTP-date retry headers', async () => {
    let now = Date.parse('2026-10-11T00:00:00Z');
    let calls = 0;
    const service = createStatsService({ now: () => now, fetch: async url => {
        calls++;
        if (url.includes('/discovery/')) return detail();
        if (calls === 2) return response({}, 429, { 'Retry-After': new Date(now + 10_000).toUTCString() });
        return response({ total: 97 });
    } });
    const partial = await service.getStats(ID);
    assert.equal(partial.partial, true);
    assert.equal(partial.retryAfter, 10);
    assert.equal(partial.ratingAverage, 4.5);
    await assert.rejects(service.getStats(ID), error => error.status === 429);
    assert.equal(calls, 2);
    now += 10_000;
    assert.equal((await service.getStats(ID)).rosesTotal, 97);
});

test('runs at most two card jobs globally, including queued distinct IDs', async () => {
    let active = 0;
    let maximum = 0;
    const releases = [];
    const service = createStatsService({ fetch: async url => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => releases.push(resolve));
        active--;
        return url.includes('/discovery/') ? detail(url.split('/').at(-1)) : response({ total: 0 });
    } });
    const jobs = Array.from({ length: 5 }, (_, i) => service.getStats(otherId(i)));
    await tick();
    assert.equal(active, 2);
    let complete = false;
    const all = Promise.all(jobs).then(() => { complete = true; });
    while (!complete) {
        releases.splice(0).forEach(release => release());
        await tick();
    }
    await all;
    assert.equal(maximum, 2);
    assert.equal(active, 0);
});

test('bounds unique pending jobs while allowing cached results and in-flight duplicates', async () => {
    let calls = 0;
    let blocked = false;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const service = createStatsService({ fetch: async url => {
        calls++;
        if (blocked) await barrier;
        return url.includes('/discovery/') ? detail(url.split('/').at(-1)) : response({ total: 0 });
    } });
    const cachedId = otherId(999);
    await service.getStats(cachedId);
    await tick();
    blocked = true;
    const jobs = Array.from({ length: 128 }, (_, i) => service.getStats(otherId(i)));
    const acceptedCalls = calls;
    assert.equal(acceptedCalls, 4);
    assert.strictEqual(service.getStats(otherId(0)), jobs[0]);
    assert.equal((await service.getStats(cachedId)).rosesTotal, 0);
    await assert.rejects(service.getStats(otherId(128)), error => error.status === 503);
    assert.equal(calls, acceptedCalls);
    release();
    await Promise.all(jobs);
    assert.equal(calls, 2 + 128 * 2);
    await service.getStats(otherId(128));
    assert.equal(calls, 2 + 129 * 2);
});

test('times out and aborts hung requests, retaining detail if only social hangs', async () => {
    for (const hangSocial of [false, true]) {
        let aborted = false;
        const service = createStatsService({ timeoutMs: 10, fetch: async (url, { signal }) => {
            if (hangSocial && url.includes('/discovery/')) return detail();
            return new Promise((_, reject) => signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
            }, { once: true }));
        } });
        if (hangSocial) {
            const result = await service.getStats(ID);
            assert.equal(result.partial, true);
            assert.equal(result.ratingAverage, 4.5);
            assert.equal(result.rosesTotal, null);
        } else {
            await assert.rejects(service.getStats(ID), error => error.status === 503);
        }
        assert.equal(aborted, true);
    }
});

test('persona uses a fixed anonymous public endpoint and forwards only portable definition fields', async () => {
    const calls = [];
    const service = createStatsService({ fetch: async (url, options) => {
        calls.push({ url, options });
        return personaDetail(ID, {
            content: 'Full freeform definition',
            imageUrl: 'https://example.com/image.png',
            details: {
                title: 'Display title', appearance: 'Appearance', body: 'Body', personality: 'Personality',
                quirks: 'Quirks', history: 'History', traits: ['unportable'], lorebookId: otherId(7),
                privateSecret: 'Do not forward',
            },
            creator: { name: 'Creator', username: 'username', email: 'private@example.com' },
            systemPrompt: 'Do not forward',
        });
    } });
    assert.deepEqual(await service.getPersona(ID), {
        spec: 'rolecall_persona', spec_version: '1.0',
        data: {
            name: 'Persona', description: 'UI summary', content: 'Full freeform definition',
            sections: { appearance: 'Appearance', body: 'Body', personality: 'Personality', quirks: 'Quirks', history: 'History' },
            metadata: { creator: 'Creator', source: 'plotlight-public-definition' },
        },
        imageUrl: 'https://example.com/image.png', source: 'public-definition', linkedLorebookOmitted: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://plotlightstudios.com/api/discovery/personas/${ID}`);
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.redirect, 'error');
    assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
    assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('persona validates UUID, successful public envelope, exact ID, and name', async () => {
    let calls = 0;
    const service = createStatsService({ fetch: async () => { calls++; return personaDetail(); } });
    for (const id of ['', '../personas/admin', `${ID}?url=https://localhost`, null]) {
        await assert.rejects(service.getPersona(id), error => error.status === 400);
    }
    assert.equal(calls, 0);
    for (const body of [
        { success: false, persona: { id: ID } },
        { success: true, persona: { id: otherId(1), name: 'Name', content: 'Definition' } },
        { success: true, persona: { id: ID.toUpperCase(), name: 'Name', content: 'Definition' } },
        { success: true, persona: { id: ID, name: ' ', content: 'Definition' } },
        { success: true },
    ]) {
        const invalid = createStatsService({ fetch: async () => response(body) });
        await assert.rejects(invalid.getPersona(ID), error => error.status === 502);
    }
});

test('persona preserves freeform content separately from the brief summary and filters section types', async () => {
    const service = createStatsService({ fetch: async () => personaDetail(ID, {
        content: 'Full definition',
        details: { body: { runtime: true }, appearance: ' ', history: 42 },
        creator: { username: 'Public username' },
    }) });
    const result = await service.getPersona(ID);
    assert.equal(result.data.content, 'Full definition');
    assert.equal(result.data.description, 'UI summary');
    assert.deepEqual(result.data.sections, {});
    assert.equal(result.data.metadata.creator, 'Public username');
    assert.equal(result.imageUrl, null);
    assert.equal(result.linkedLorebookOmitted, false);
});

test('persona rejects summary-only definitions and retries rather than caching failure', async () => {
    for (const extra of [
        { content: '', details: {} },
        { content: ' ', details: { appearance: ' ', body: ['Not a string'], traits: 'Not a supported section' } },
        { content: { runtime: true }, details: {} },
    ]) {
        let calls = 0;
        const service = createStatsService({ fetch: async () => {
            calls++;
            return calls === 1 ? personaDetail(ID, extra) : personaDetail();
        } });
        await assert.rejects(service.getPersona(ID), error => error.status === 422);
        assert.equal((await service.getPersona(ID)).data.sections.appearance, 'Appearance definition');
        assert.equal(calls, 2);
    }
});

test('persona accepts only credential-free HTTPS image URLs', async () => {
    for (const imageUrl of ['http://example.com/a.png', 'javascript:alert(1)', '/relative.png', 'https://user:secret@example.com/a.png', null]) {
        const service = createStatsService({ fetch: async () => personaDetail(ID, { imageUrl }) });
        assert.equal((await service.getPersona(ID)).imageUrl, null);
    }
});

test('persona deduplicates, caches for five minutes, isolates returned objects and stats IDs', async () => {
    let now = 1000;
    let calls = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const service = createStatsService({ now: () => now, fetch: async url => {
        calls++;
        await barrier;
        if (url.includes('/personas/')) return personaDetail();
        return url.includes('/characters/') ? detail() : response({ total: 97 });
    } });
    const first = service.getPersona(ID);
    assert.strictEqual(first, service.getPersona(ID.toUpperCase()));
    release();
    const result = await first;
    result.data.sections.appearance = 'Changed';
    assert.equal((await service.getPersona(ID)).data.sections.appearance, 'Appearance definition');
    assert.equal(calls, 1);
    assert.equal((await service.getStats(ID)).ratingAverage, 4.5);
    assert.equal(calls, 3);
    now += 5 * 60_000;
    await service.getPersona(ID);
    assert.equal(calls, 4);
});

test('persona transient failures retry and share rate-limit cooldown with stats', async () => {
    let now = 1000;
    let calls = 0;
    const service = createStatsService({ now: () => now, fetch: async () => {
        calls++;
        if (calls === 1) return response({}, 503);
        if (calls === 2) return response({}, 429, { 'Retry-After': '5' });
        return personaDetail();
    } });
    await assert.rejects(service.getPersona(ID), error => error.status === 503);
    await assert.rejects(service.getPersona(ID), error => error.status === 429 && error.retryAfter === 5);
    await assert.rejects(service.getStats(ID), error => error.status === 429 && error.retryAfter === 5);
    assert.equal(calls, 2);
    now += 5000;
    assert.equal((await service.getPersona(ID)).data.name, 'Persona');
    assert.equal(calls, 3);
});

test('persona and stats share two active jobs and the 128 pending job capacity', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const service = createStatsService({ fetch: async url => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        await barrier;
        active--;
        if (url.includes('/personas/')) return personaDetail(url.split('/').at(-1));
        return url.includes('/characters/') ? detail(url.split('/').at(-1)) : response({ total: 0 });
    } });
    const persona = service.getPersona(ID);
    const stats = service.getStats(ID);
    const jobs = [persona, stats, ...Array.from({ length: 126 }, (_, i) => service.getPersona(otherId(i)))];
    assert.strictEqual(service.getPersona(ID), persona);
    await assert.rejects(service.getPersona(otherId(126)), error => error.status === 503);
    assert.equal(calls, 2);
    release();
    await Promise.all(jobs);
    assert.equal(maximum, 2);
    assert.equal(calls, 129);
});

test('persona aborts requests at the shared timeout', async () => {
    let aborted = false;
    const service = createStatsService({ timeoutMs: 10, fetch: async (_, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) });
    await assert.rejects(service.getPersona(ID), error => error.status === 503);
    assert.equal(aborted, true);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const imageResponse = (bytes = PNG, headers = {}) => new Response(bytes, { headers: { 'Content-Type': 'image/png', ...headers } });

test('images use only a fixed anonymous HTTPS thumbnail URL and are not cached in server memory', async () => {
    const calls = [];
    const service = createStatsService({ fetch: async (url, options) => {
        calls.push({ url, options });
        return imageResponse();
    } });
    const image = await service.getImage(ID.toUpperCase());
    assert.ok(Buffer.isBuffer(image.bytes));
    assert.deepEqual(image.bytes, PNG);
    assert.equal(image.contentType, 'image/png');
    await service.getImage(ID);
    assert.equal(calls.length, 2);
    for (const { url, options } of calls) {
        assert.equal(url, `https://plotlightstudios.com/api/published-media/${ID}/thumb`);
        assert.equal(options.method, 'GET');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.deepEqual(options.headers, { Accept: 'image/png, image/jpeg, image/webp, image/gif' });
        assert.ok(options.signal instanceof AbortSignal);
    }
});

test('images reject non-UUID input before requesting upstream', async () => {
    let calls = 0;
    const service = createStatsService({ fetch: async () => { calls++; return imageResponse(); } });
    for (const id of [null, '', '../admin', `${ID}/thumb`, `${ID}?url=https://localhost`, 'https://localhost', 12]) {
        await assert.rejects(service.getImage(id), error => error.status === 400);
    }
    assert.equal(calls, 0);
});

test('images reject redirects, upstream failures and network failures and retry them', async () => {
    for (const failure of [
        new Response(null, { status: 302, headers: { Location: 'https://localhost/' } }),
        new Response(null, { status: 404 }),
        new Response(null, { status: 503 }),
        new Error('redirect or connection failure'),
    ]) {
        let calls = 0;
        const service = createStatsService({ fetch: async () => {
            calls++;
            if (calls > 1) return imageResponse();
            if (failure instanceof Error) throw failure;
            return failure;
        } });
        await assert.rejects(service.getImage(ID), error => error.status === (failure.status === 503 ? 503 : 502));
        assert.deepEqual((await service.getImage(ID)).bytes, PNG);
        assert.equal(calls, 2);
    }
});

test('images require matching raster MIME types and file signatures', async () => {
    const valid = [
        [PNG, 'image/png'],
        [Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
        [Buffer.from('GIF87a'), 'image/gif'],
        [Buffer.from('GIF89a'), 'image/gif'],
        [Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary'), 'image/webp'],
    ];
    for (const [bytes, contentType] of valid) {
        const service = createStatsService({ fetch: async () => imageResponse(bytes, { 'Content-Type': `${contentType}; charset=binary` }) });
        assert.equal((await service.getImage(ID)).contentType, contentType);
    }
    for (const [bytes, contentType] of [
        [PNG, 'image/svg+xml'], [PNG, 'text/html'], [PNG, 'application/octet-stream'],
        [PNG, 'image/jpeg'], [Buffer.from('<svg/>'), 'image/png'],
        [Buffer.from('<html>login</html>'), 'image/jpeg'], [Buffer.alloc(0), 'image/png'],
    ]) {
        const service = createStatsService({ fetch: async () => imageResponse(bytes, { 'Content-Type': contentType }) });
        await assert.rejects(service.getImage(ID), error => error.status === 502);
    }
});

test('images bound declared and actual body size, including absent or false Content-Length', async () => {
    const limit = 5 * 1024 * 1024;
    for (const length of [String(limit + 1), '-1', 'invalid', 'Infinity']) {
        let reads = 0;
        let aborted = false;
        const service = createStatsService({ fetch: async (_, { signal }) => {
            signal.addEventListener('abort', () => { aborted = true; });
            return {
                ...response(null, 200, { 'Content-Type': 'image/png', 'Content-Length': length }),
                body: { getReader() { reads++; throw new Error('Must reject before reading'); } },
            };
        } });
        await assert.rejects(service.getImage(ID), error => error.status === 502);
        assert.equal(reads, 0);
        assert.equal(aborted, true);
    }
    for (const headers of [{}, { 'Content-Length': '1' }]) {
        let canceled = false;
        let chunk = 0;
        const service = createStatsService({ fetch: async () => new Response(new ReadableStream({
            pull(controller) {
                chunk++;
                controller.enqueue(chunk === 1 ? PNG : new Uint8Array(limit));
            },
            cancel() { canceled = true; },
        }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'image/png', ...headers } }) });
        await assert.rejects(service.getImage(ID), error => error.status === 502);
        assert.equal(canceled, true);
        assert.equal(chunk, 2);
    }
    const atLimit = Buffer.alloc(limit);
    PNG.copy(atLimit);
    const service = createStatsService({ fetch: async () => imageResponse(atLimit) });
    assert.equal((await service.getImage(ID)).bytes.length, limit);
});

test('images share upstream rate-limit cooldown with metadata requests', async () => {
    let now = 1000;
    let calls = 0;
    const service = createStatsService({ now: () => now, fetch: async () => {
        calls++;
        return calls === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '5' } }) : imageResponse();
    } });
    await assert.rejects(service.getImage(ID), error => error.status === 429 && error.retryAfter === 5);
    await assert.rejects(service.getStats(ID), error => error.status === 429 && error.retryAfter === 5);
    await assert.rejects(service.getPersona(ID), error => error.status === 429 && error.retryAfter === 5);
    assert.equal(calls, 1);
    now += 5000;
    assert.deepEqual((await service.getImage(ID)).bytes, PNG);
    assert.equal(calls, 2);
});

test('images share concurrency and bounded pending capacity with stats and personas', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const service = createStatsService({ fetch: async url => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        await barrier;
        active--;
        if (url.includes('/published-media/')) return imageResponse();
        if (url.includes('/personas/')) return personaDetail();
        return url.includes('/characters/') ? detail() : response({ total: 0 });
    } });
    const image = service.getImage(ID);
    const persona = service.getPersona(ID);
    const stats = service.getStats(ID);
    const jobs = [image, persona, stats, ...Array.from({ length: 125 }, (_, i) => service.getImage(otherId(i)))];
    assert.strictEqual(service.getImage(ID.toUpperCase()), image);
    await assert.rejects(service.getImage(otherId(125)), error => error.status === 503);
    assert.equal(calls, 2);
    release();
    await Promise.all(jobs);
    assert.equal(maximum, 2);
    assert.equal(calls, 129);
});

test('image timeout covers both fetch and a stalled streaming body', async () => {
    for (const stallBody of [false, true]) {
        let aborted = false;
        const service = createStatsService({ timeoutMs: 10, fetch: async (_, { signal }) => {
            if (!stallBody) return new Promise((_, reject) => signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
            }, { once: true }));
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(PNG);
                    signal.addEventListener('abort', () => {
                        aborted = true;
                        controller.error(new Error('aborted'));
                    }, { once: true });
                },
            }), { headers: { 'Content-Type': 'image/png' } });
        } });
        await assert.rejects(service.getImage(ID), error => error.status === 503);
        assert.equal(aborted, true);
    }
});

test('image route sends raster bytes with private caching and nosniff and JSON failures without caching', async () => {
    const originalFetch = globalThis.fetch;
    const routes = new Map();
    globalThis.fetch = async () => imageResponse();
    try {
        await init({ get(path, handler) { routes.set(path, handler); } });
        assert.deepEqual([...routes.keys()], ['/stats/:id', '/persona/:id', '/image/:id']);
        const makeResponse = () => ({
            headers: {}, statusCode: 200,
            set(name, value) { this.headers[name] = value; return this; },
            status(code) { this.statusCode = code; return this; },
            send(body) { this.body = body; return this; },
            json(body) { this.body = body; return this; },
        });
        const ok = makeResponse();
        await routes.get('/image/:id')({ params: { id: ID } }, ok);
        assert.deepEqual(ok.body, PNG);
        assert.ok(Buffer.isBuffer(ok.body));
        assert.equal(ok.headers['Content-Type'], 'image/png');
        assert.equal(ok.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(ok.headers['Cache-Control'], 'private, max-age=300');
        const invalid = makeResponse();
        await routes.get('/image/:id')({ params: { id: '../admin' } }, invalid);
        assert.equal(invalid.statusCode, 400);
        assert.equal(typeof invalid.body.error, 'string');
        assert.equal(invalid.headers['Cache-Control'], 'no-store');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
