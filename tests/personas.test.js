import test from 'node:test';
import assert from 'node:assert/strict';
import { importPersona, getPersonaAvatarIds } from '../personas.js';

const active = 'existing-avatar.png';
const firstKey = 'plotlight-persona-11111111-1111-4111-8111-111111111111.png';
const secondKey = 'plotlight-persona-22222222-2222-4222-8222-222222222222.png';
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const defaultAvatar = '/img/default-user.png';
const remotePortrait = 'https://images.example.org/persona.png';
const publishedPortrait = 'https://plotlightstudios.com/api/published-media/33333333-3333-4333-8333-333333333333/thumb';
const localPortrait = '/api/plugins/nemo-plotlight/image/33333333-3333-4333-8333-333333333333';

function rolecall(overrides = {}) {
    return { spec: 'rolecall_persona', spec_version: '1.0', data: {
        name: 'Imported Persona', description: 'Short catalog summary',
        content: 'Full roleplay definition with {{user}} and details.',
        sections: { appearance: 'Appearance details', personality: 'Personality details' },
        ...overrides,
    } };
}

function file(data = rolecall(), extra = {}) {
    return { name: 'persona.json', text: async () => JSON.stringify(data), ...extra };
}

function harness({ avatars = [active], remoteFails = false, portraitResponse, uploadStatus = 200, uploadPath, swallowedSave = false, saveThrows = false, readback, initThrows = false } = {}) {
    const requests = [], inits = [], refreshes = [], deletes = [];
    const powerUser = {
        personas: { [active]: 'Existing Persona' },
        persona_descriptions: { [active]: { description: 'Existing description', title: 'Existing title' } },
    };
    let persisted = { power_user: structuredClone(powerUser), user_avatar: active };
    let saveCalls = 0;
    const currentAvatar = active;
    const uploaded = new Set(avatars);
    const tools = {
        powerUser, defaultAvatar, userAvatar: () => currentAvatar,
        getRequestHeaders: ({ omitContentType } = {}) => omitContentType ? { 'X-Test': 'headers' } : { 'Content-Type': 'application/json', 'X-Test': 'headers' },
        async initPersona(avatar, name, description, title, options) {
            inits.push({ avatar, name, description, title, options });
            if (initThrows) throw new Error('init failed');
            powerUser.personas[avatar] = name;
            powerUser.persona_descriptions[avatar] = { description, title };
        },
        async saveSettings() {
            saveCalls++;
            if (saveThrows) throw new Error('settings save failed');
            if (!swallowedSave) persisted = { power_user: structuredClone(powerUser), user_avatar: currentAvatar };
        },
        async getUserAvatars(force, avatar) { refreshes.push({ force, avatar }); },
    };
    async function fetchImpl(url, options) {
        requests.push({ url, options });
        if (url === localPortrait) {
            assert.equal(options.credentials, 'same-origin');
            assert.equal(options.redirect, 'error');
            return new Response(image);
        }
        if (url === defaultAvatar) {
            assert.equal(options.credentials, 'same-origin');
            return new Response(image);
        }
        if (url === remotePortrait) {
            assert.equal(options.credentials, 'omit');
            assert.equal(options.redirect, 'error');
            assert.ok(options.signal instanceof AbortSignal);
            if (remoteFails) throw new TypeError('CORS rejected the image');
            return portraitResponse?.() ?? new Response(image);
        }
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Test'], 'headers');
        if (url === '/api/avatars/get') return Response.json(avatars);
        if (url === '/api/avatars/upload') {
            assert.ok(options.body instanceof FormData);
            assert.equal(options.headers['Content-Type'], undefined);
            const avatar = options.body.get('overwrite_name');
            if (uploadStatus >= 400) return new Response('', { status: uploadStatus });
            uploaded.add(avatar);
            return Response.json({ path: uploadPath ?? avatar });
        }
        if (url === '/api/settings/get') {
            assert.deepEqual(JSON.parse(options.body), { lazyPresets: true });
            return readback?.(structuredClone(persisted)) ?? Response.json({ settings: JSON.stringify(persisted) });
        }
        if (url === '/api/avatars/delete') {
            const { avatar } = JSON.parse(options.body);
            deletes.push(avatar);
            uploaded.delete(avatar);
            return Response.json({});
        }
        throw new Error(`Unexpected request: ${url}`);
    }
    return { tools, fetchImpl, makeAvatarKey: () => firstKey, powerUser, requests, inits, refreshes, deletes, uploaded, saveCalls: () => saveCalls };
}

function assertOriginalUntouched(fixture) {
    assert.equal(fixture.powerUser.personas[active], 'Existing Persona');
    assert.deepEqual(fixture.powerUser.persona_descriptions[active], { description: 'Existing description', title: 'Existing title' });
    assert.equal(fixture.tools.userAvatar(), active);
    assert.equal(fixture.uploaded.has(active), true);
}

test('published persona thumbnails use the fixed same-origin helper', async () => {
    const fixture = harness();
    const result = await importPersona(file(), { ...fixture, imageUrl: publishedPortrait });
    assert.equal(result.usedDefaultAvatar, false);
    assert.equal(fixture.requests.some(request => request.url === localPortrait), true);
    assert.equal(fixture.requests.some(request => request.url === publishedPortrait), false);
    assertOriginalUntouched(fixture);
});

test('RoleCall full content takes precedence over catalog summary and sections', async () => {
    const fixture = harness();
    const source = rolecall();
    const result = await importPersona(file(source, { nplSource: 'public-detail', nplLinkedLorebookOmitted: true }), fixture);
    assert.deepEqual(result, { avatar: firstKey, usedDefaultAvatar: true, source: 'public-detail', linkedLorebookOmitted: true });
    assert.deepEqual(fixture.inits[0], { avatar: firstKey, name: source.data.name, description: source.data.content, title: source.data.description, options: { silent: true } });
    assert.deepEqual(fixture.refreshes, [{ force: true, avatar: firstKey }]);
    assertOriginalUntouched(fixture);
});

test('public sections create the complete persona description and preserve summary as title', async () => {
    const fixture = harness();
    await importPersona(file(rolecall({ content: '', sections: { appearance: 'Silver hair', body: 'Tall', personality: 'Patient', quirks: 'Counts stars', history: 'Former navigator' } })), fixture);
    assert.equal(fixture.inits[0].description, 'Appearance:\nSilver hair\n\nBody:\nTall\n\nPersonality:\nPatient\n\nQuirks:\nCounts stars\n\nHistory:\nFormer navigator');
    assert.equal(fixture.inits[0].title, 'Short catalog summary');
    assertOriginalUntouched(fixture);
});

test('a RoleCall catalog summary alone is rejected instead of imported as full definition', async () => {
    const fixture = harness();
    await assert.rejects(importPersona(file(rolecall({ content: '', sections: {} })), fixture), /no full definition/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.inits.length, 0);
});

test('V2 and plain persona definitions retain description, personality and scenario', async () => {
    for (const source of [{ name: 'Plain', description: 'The definition', personality: 'Curious', scenario: 'At home' }, { spec: 'chara_card_v2', data: { name: 'V2', description: 'The definition', personality: 'Curious', scenario: 'At home' } }]) {
        const fixture = harness();
        await importPersona(file(source), fixture);
        assert.equal(fixture.inits[0].description, 'Description:\nThe definition\n\nPersonality:\nCurious\n\nScenario:\nAt home');
        assert.equal(fixture.inits[0].title, '');
        assertOriginalUntouched(fixture);
    }
});

test('native avatar upload uses image bytes and never invokes character import', async () => {
    const fixture = harness();
    const result = await importPersona(file(), { ...fixture, imageUrl: remotePortrait });
    assert.equal(result.usedDefaultAvatar, false);
    const upload = fixture.requests.find(({ url }) => url === '/api/avatars/upload');
    const avatarFile = upload.options.body.get('avatar');
    assert.equal(avatarFile.type, 'image/png');
    assert.deepEqual(new Uint8Array(await avatarFile.arrayBuffer()), image);
    assert.equal(upload.options.body.get('overwrite_name'), firstKey);
    assert.equal(fixture.requests.some(({ url }) => url.includes('/characters/')), false);
    assert.equal(fixture.requests.some(({ url }) => url === defaultAvatar), false);
    assertOriginalUntouched(fixture);
});

test('unavailable, invalid and oversized remote portraits fall back to the trusted ST default', async () => {
    const configurations = [
        { remoteFails: true },
        { portraitResponse: () => new Response('', { status: 404 }) },
        { portraitResponse: () => new Response('not an image') },
        { portraitResponse: () => new Response(image, { headers: { 'Content-Length': String(31 * 1024 * 1024) } }) },
    ];
    for (const configuration of configurations) {
        const fixture = harness(configuration);
        const result = await importPersona(file(), { ...fixture, imageUrl: remotePortrait });
        assert.equal(result.usedDefaultAvatar, true);
        assert.ok(fixture.requests.some(({ url }) => url === defaultAvatar));
        assertOriginalUntouched(fixture);
    }
});

test('avatar upload failure or an unexpected path rejects before persona settings change', async () => {
    for (const configuration of [{ uploadStatus: 500 }, { uploadPath: 'other-avatar.png' }]) {
        const fixture = harness(configuration);
        await assert.rejects(importPersona(file(), fixture), /upload could not be confirmed/);
        assert.equal(fixture.inits.length, 0);
        assert.equal(fixture.saveCalls(), 0);
        assert.equal(Object.hasOwn(fixture.powerUser.personas, firstKey), false);
        assertOriginalUntouched(fixture);
    }
});

test('fresh avatar-list UUID collisions choose another key without overwriting originals', async () => {
    const fixture = harness({ avatars: [active, firstKey] });
    fixture.powerUser.personas[firstKey] = 'Collision original';
    fixture.powerUser.persona_descriptions[firstKey] = { description: 'Keep this', title: 'Original' };
    const candidates = [firstKey, secondKey];
    const result = await importPersona(file(), { ...fixture, makeAvatarKey: () => candidates.shift() });
    assert.equal(result.avatar, secondKey);
    assert.equal(fixture.powerUser.personas[firstKey], 'Collision original');
    assert.deepEqual(fixture.powerUser.persona_descriptions[firstKey], { description: 'Keep this', title: 'Original' });
    assertOriginalUntouched(fixture);
});

test('exhausted UUID collisions and unsafe generated keys reject before upload', async () => {
    for (const fixture of [harness({ avatars: [active, firstKey] }), { ...harness(), makeAvatarKey: () => '../existing-avatar.png' }]) {
        await assert.rejects(importPersona(file(), fixture), /unused persona avatar name|Invalid generated/);
        assert.equal(fixture.requests.some(({ url }) => url === '/api/avatars/upload'), false);
        assertOriginalUntouched(fixture);
    }
});

test('native UUID helper supports persona imports without secure-origin crypto.randomUUID', async () => {
    const fixture = harness();
    fixture.tools.uuidv4 = () => '11111111-1111-4111-8111-111111111111';
    delete fixture.makeAvatarKey;
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
        assert.equal((await importPersona(file(), fixture)).avatar, firstKey);
        assertOriginalUntouched(fixture);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'crypto', previous);
        else delete globalThis.crypto;
    }
});

test('swallowed settings saves fail verification and roll back only the newly imported persona', async () => {
    const fixture = harness({ swallowedSave: true });
    await assert.rejects(importPersona(file(), fixture), /could not be confirmed/);
    assert.equal(Object.hasOwn(fixture.powerUser.personas, firstKey), false);
    assert.equal(Object.hasOwn(fixture.powerUser.persona_descriptions, firstKey), false);
    assert.deepEqual(fixture.deletes, [firstKey]);
    assert.equal(fixture.uploaded.has(firstKey), false);
    assert.equal(fixture.saveCalls(), 2);
    assert.equal(fixture.refreshes.length, 0);
    assertOriginalUntouched(fixture);
});

test('changed saved name, description, title or active avatar reject and roll back the import', async () => {
    for (const change of [saved => { saved.power_user.personas[firstKey] = 'Changed'; }, saved => { saved.power_user.persona_descriptions[firstKey].description = 'Truncated'; }, saved => { saved.power_user.persona_descriptions[firstKey].title = 'Changed'; }, saved => { saved.user_avatar = firstKey; }]) {
        const fixture = harness({ readback: saved => { change(saved); return Response.json({ settings: JSON.stringify(saved) }); } });
        await assert.rejects(importPersona(file(), fixture), /could not be confirmed/);
        assert.deepEqual(fixture.deletes, [firstKey]);
        assert.equal(Object.hasOwn(fixture.powerUser.personas, firstKey), false);
        assertOriginalUntouched(fixture);
    }
});

test('failed and malformed fresh settings readbacks roll back the imported persona', async () => {
    for (const readback of [() => new Response('', { status: 500 }), () => Response.json({ settings: '{invalid' }), () => Response.json({ settings: {} })]) {
        const fixture = harness({ readback });
        await assert.rejects(importPersona(file(), fixture));
        assert.deepEqual(fixture.deletes, [firstKey]);
        assert.equal(Object.hasOwn(fixture.powerUser.personas, firstKey), false);
        assertOriginalUntouched(fixture);
    }
});

test('native initialization failure deletes only the new avatar and preserves existing personas', async () => {
    const fixture = harness({ initThrows: true });
    await assert.rejects(importPersona(file(), fixture), /init failed/);
    assert.deepEqual(fixture.deletes, [firstKey]);
    assertOriginalUntouched(fixture);
});

test('native save exceptions still delete only the new avatar when cleanup settings cannot persist', async () => {
    const fixture = harness({ saveThrows: true });
    await assert.rejects(importPersona(file(), fixture), /settings save failed/);
    assert.equal(Object.hasOwn(fixture.powerUser.personas, firstKey), false);
    assert.equal(Object.hasOwn(fixture.powerUser.persona_descriptions, firstKey), false);
    assert.equal(fixture.saveCalls(), 2);
    assert.deepEqual(fixture.deletes, [firstKey]);
    assert.equal(fixture.uploaded.has(firstKey), false);
    assertOriginalUntouched(fixture);
});

test('malformed JSON or persona definitions are rejected before native network calls', async () => {
    for (const source of [null, {}, rolecall({ name: '', content: 'Full' })]) {
        const fixture = harness();
        await assert.rejects(importPersona(file(source), fixture), /persona definition/);
        assert.equal(fixture.requests.length, 0);
    }
    const fixture = harness();
    await assert.rejects(importPersona({ text: async () => '{invalid' }, fixture), /not valid JSON/);
    assert.equal(fixture.requests.length, 0);
});

test('persona-avatar helper reads native context and tolerates unavailable persona settings', () => {
    const previous = globalThis.SillyTavern;
    try {
        globalThis.SillyTavern = { getContext: () => ({ powerUserSettings: { personas: { [active]: 'Existing' } } }) };
        assert.deepEqual(getPersonaAvatarIds(), [active]);
        globalThis.SillyTavern = { getContext: () => ({}) };
        assert.deepEqual(getPersonaAvatarIds(), []);
        delete globalThis.SillyTavern;
        assert.deepEqual(getPersonaAvatarIds(), []);
    } finally {
        if (previous === undefined) delete globalThis.SillyTavern;
        else globalThis.SillyTavern = previous;
    }
});
