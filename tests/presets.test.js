import test from 'node:test';
import assert from 'node:assert/strict';
import { importPreset, getPresetNames } from '../presets.js';

function portablePreset(overrides = {}) {
    return {
        name: 'Portable preset', temperature: 0.72, top_p: 0.91, min_p: 0.03,
        prompts: [{ identifier: 'main', role: 'system', content: '{{char}} speaks.', extra: { preserve: true } }, { identifier: 'chatHistory', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: false }] }],
        extensions: { regex_scripts: [{ scriptName: 'Preserve me', findRegex: 'x', replaceString: 'y' }] },
        extension_settings: { unknown: { retained: ['nested', 1] } },
        ...overrides,
    };
}

function downloaded(data = portablePreset(), filename = 'download.json') {
    return { name: filename, text: async () => JSON.stringify(data) };
}

function settingsResponse(disk) {
    return Response.json({ openai_setting_names: [...disk.keys()], openai_settings: [...disk.values()].map(value => JSON.stringify(value)) });
}

function harness({ names = [], disk = [], hook, saveError, initialRead, readback, updateList = true, managerMissing = false, sanitize = name => name.replace(/[<>:"/\\|?*]/g, '') } = {}) {
    const knownNames = [...names];
    const saved = new Map(disk.map(([name, value]) => [name, structuredClone(value)]));
    const saves = [], reads = [], hooks = [], sanitized = [];
    const manager = {
        getAllPresets: () => [...knownNames],
        async savePreset(name, data) {
            saves.push({ name, data: structuredClone(data) });
            if (saveError) throw saveError;
            saved.set(name, structuredClone(data));
            if (updateList) knownNames.push(name);
        },
    };
    const tools = {
        getPresetManager: api => { assert.equal(api, 'openai'); return managerMissing ? null : manager; },
        settingsToUpdate: {
            temperature: ['#temperature', 'temp_openai', false, false],
            prompts: ['', 'prompts', false, false],
            prompt_order: ['', 'prompt_order', false, false],
            chat_completion_source: ['', 'chat_completion_source', false, true],
            custom_url: ['', 'custom_url', false, true],
            proxy_password: ['', 'proxy_password', false, true],
            custom_include_headers: ['', 'custom_include_headers', false, true],
            openai_model: ['', 'openai_model', false, true],
        },
        eventTypes: { OAI_PRESET_IMPORT_READY: 'import-ready' },
        eventSource: { async emit(type, payload) { hooks.push({ type, presetName: payload.presetName }); await hook?.(payload); } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-Test': 'headers' }),
        async sanitizeFilename(name) { sanitized.push(name); return sanitize(name); },
    };
    async function fetchImpl(url, options) {
        assert.equal(url, '/api/settings/get');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Test'], 'headers');
        assert.deepEqual(JSON.parse(options.body), { lazyPresets: false });
        reads.push([...saved.keys()]);
        if (saves.length && readback) return readback(saves.at(-1).name, saved);
        if (!saves.length && initialRead) return initialRead();
        return settingsResponse(saved);
    }
    return { tools, fetchImpl, saves, reads, hooks, sanitized, saved, knownNames };
}

test('native preset import preserves sampler, prompts, order and extension payloads', async () => {
    const fixture = harness();
    const preset = portablePreset();
    assert.equal(await importPreset(downloaded(preset), fixture), preset.name);
    assert.deepEqual(fixture.saves, [{ name: preset.name, data: preset }]);
    assert.deepEqual(fixture.saved.get(preset.name), preset);
    assert.deepEqual(fixture.hooks, [{ type: 'import-ready', presetName: preset.name }]);
    assert.deepEqual(fixture.reads, [[], [preset.name]]);
});

test('connection fields are removed after import hooks, including fields hooks reintroduce', async () => {
    const preset = portablePreset({ chat_completion_source: 'custom', custom_url: 'https://remote.invalid', proxy_password: 'remote-secret' });
    const fixture = harness({ hook: async ({ data }) => {
        data.custom_url = 'https://hook.invalid';
        data.custom_include_headers = 'Authorization: hook-secret';
        data.openai_model = 'remote-model';
        data.name = 'Hook should not rename this';
        data.extensions.hook = { preserved: true };
    } });
    const name = await importPreset(downloaded(preset), fixture);
    const imported = fixture.saved.get(name);
    for (const key of ['chat_completion_source', 'custom_url', 'proxy_password', 'custom_include_headers', 'openai_model']) assert.equal(Object.hasOwn(imported, key), false, key);
    assert.equal(imported.name, preset.name);
    assert.deepEqual(imported.prompts, preset.prompts);
    assert.deepEqual(imported.prompt_order, preset.prompt_order);
    assert.deepEqual(imported.extensions.hook, { preserved: true });
});

test('UI and disk collisions choose a fresh name without replacing existing presets', async () => {
    const original = portablePreset({ name: 'Disk original', temperature: 0.15 });
    const fixture = harness({ names: ['PORTABLE PRESET'], disk: [['Portable preset (Plotlight 2)', original]] });
    assert.equal(await importPreset(downloaded(), fixture), 'Portable preset (Plotlight 3)');
    assert.deepEqual(fixture.saved.get('Portable preset (Plotlight 2)'), original);
    assert.deepEqual(fixture.saves.map(({ name }) => name), ['Portable preset (Plotlight 3)']);
    assert.deepEqual(fixture.reads, [['Portable preset (Plotlight 2)'], ['Portable preset (Plotlight 2)', 'Portable preset (Plotlight 3)']]);
});

test('sanitized and Unicode-normalized names are checked for collisions', async () => {
    const fixture = harness({ names: ['Cafe\u0301'] });
    assert.equal(await importPreset(downloaded(portablePreset({ name: 'Caf\u00e9/' })), fixture), 'Caf\u00e9 (Plotlight 2)');
    assert.deepEqual(fixture.sanitized, ['Caf\u00e9/']);
});

test('fresh disk names detect case and Unicode collisions even when absent from the UI', async () => {
    const original = portablePreset({ temperature: 0.15 });
    const fixture = harness({ disk: [['CAFE\u0301', original], ['CAF\u00c9 (PLOTLIGHT 2)', original]] });
    assert.equal(await importPreset(downloaded(portablePreset({ name: 'Caf\u00e9' })), fixture), 'Caf\u00e9 (Plotlight 3)');
    assert.deepEqual(fixture.saved.get('CAFE\u0301'), original);
    assert.deepEqual(fixture.saved.get('CAF\u00c9 (PLOTLIGHT 2)'), original);
    assert.equal(fixture.reads.length, 2);
});

test('many UI and disk collisions still require only two disk snapshots', async () => {
    const names = ['Portable preset', ...Array.from({ length: 15 }, (_, i) => `Portable preset (Plotlight ${i + 2})`)];
    const fixture = harness({ names: names.slice(0, 8), disk: names.slice(8).map(name => [name, portablePreset()]) });
    assert.equal(await importPreset(downloaded(), fixture), 'Portable preset (Plotlight 17)');
    assert.equal(fixture.reads.length, 2);
    assert.equal(fixture.saves.length, 1);
});

test('filename supplies a name when the preset has none', async () => {
    const preset = portablePreset();
    delete preset.name;
    const fixture = harness();
    assert.equal(await importPreset(downloaded(preset, 'Download Name.JSON'), fixture), 'Download Name');
    assert.equal(fixture.saves[0].data.name, 'Download Name');
});

test('empty sanitized names get a usable fallback', async () => {
    const fixture = harness({ sanitize: () => '' });
    assert.equal(await importPreset(downloaded(), fixture), 'Plotlight preset');
});

test('object-property reserved names are made safe before native registration', async () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype', 'CONSTRUCTOR']) {
        const fixture = harness();
        const name = await importPreset(downloaded(portablePreset({ name: reserved })), fixture);
        assert.equal(name, `Plotlight ${reserved}`);
        assert.equal(fixture.saves[0].name, name);
    }
});

test('malformed preset structures and invalid JSON are rejected before native save', async () => {
    const invalid = [null, [], {}, portablePreset({ prompts: [{ identifier: 'main', role: 'system', content: 123 }] }), portablePreset({ prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: 'yes' }] }] })];
    for (const value of invalid) {
        const fixture = harness();
        await assert.rejects(importPreset(downloaded(value), fixture), /preset|prompt/);
        assert.equal(fixture.saves.length, 0);
        assert.equal(fixture.hooks.length, 0);
        assert.equal(fixture.reads.length, 0);
    }
    const fixture = harness();
    await assert.rejects(importPreset({ name: 'bad.json', text: async () => '{broken' }, fixture), /not valid JSON/);
    assert.equal(fixture.saves.length, 0);
});

test('import hooks cannot introduce malformed prompts before save', async () => {
    const fixture = harness({ hook: ({ data }) => { data.prompts[0].content = null; } });
    await assert.rejects(importPreset(downloaded(), fixture), /invalid prompt/);
    assert.equal(fixture.saves.length, 0);
});

test('native save failures reject the import without reporting success', async () => {
    const fixture = harness({ saveError: new Error('disk full') });
    await assert.rejects(importPreset(downloaded(), fixture), /disk full/);
    assert.equal(fixture.saved.size, 0);
    assert.equal(fixture.reads.length, 1);
});

test('swallowed native saves that do not register the preset are rejected', async () => {
    const fixture = harness({ updateList: false });
    await assert.rejects(importPreset(downloaded(), fixture), /confirmed in the preset list/);
    assert.equal(fixture.saves.length, 1);
});

test('failed and malformed disk lists reject before save and during readback', async () => {
    const malformed = [
        {}, null, { openai_setting_names: [], openai_settings: {} },
        { openai_setting_names: {}, openai_settings: [] },
        { openai_setting_names: ['Existing'], openai_settings: [] },
        { openai_setting_names: [123], openai_settings: ['{}'] },
        { openai_setting_names: [' '], openai_settings: ['{}'] },
        { openai_setting_names: ['Existing', 'Existing'], openai_settings: ['{}', '{}'] },
        ...[{}, '{broken', 'null', '[]', '123'].map(preset => ({ openai_setting_names: ['Existing'], openai_settings: [preset] })),
    ];
    const responses = [() => new Response('', { status: 500 }), () => new Response('', { status: 404 }),
        () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), ...malformed.map(value => () => Response.json(value))];
    for (const response of responses) {
        const before = harness({ initialRead: response });
        await assert.rejects(importPreset(downloaded(), before));
        assert.equal(before.saves.length, 0);
        assert.equal(before.hooks.length, 0);
        const after = harness({ readback: response });
        await assert.rejects(importPreset(downloaded(), after));
        assert.equal(after.saves.length, 1);
    }
});

test('a valid disk list missing the newly saved preset cannot confirm the import', async () => {
    const fixture = harness({ readback: () => settingsResponse(new Map()) });
    await assert.rejects(importPreset(downloaded(), fixture), /could not be confirmed/);
    assert.equal(fixture.saves.length, 1);
});

test('changed prompts, changed ordering, and persisted connection fields reject verification', async () => {
    for (const change of [data => { data.prompts[0].content = 'Changed on disk'; }, data => { data.prompt_order[0].order.reverse(); }, data => { data.proxy_password = ''; }]) {
        const fixture = harness({ readback: (name, disk) => {
            const altered = structuredClone(disk.get(name));
            change(altered);
            return settingsResponse(new Map([[name, altered]]));
        } });
        await assert.rejects(importPreset(downloaded(), fixture), /could not be confirmed/);
    }
});

test('an unavailable native preset manager rejects before reading or saving', async () => {
    const fixture = harness({ managerMissing: true });
    let parsed = false;
    await assert.rejects(importPreset({ name: 'test.json', text: async () => { parsed = true; return '{}'; } }, fixture), /not ready/);
    assert.equal(parsed, false);
    assert.equal(fixture.saves.length, 0);
});

test('preset-name helper handles both existing options and an absent dropdown', () => {
    const previous = globalThis.document;
    try {
        globalThis.document = { querySelector: selector => { assert.equal(selector, '#settings_preset_openai'); return { options: [{ text: 'Default' }, { text: 'My preset' }] }; } };
        assert.deepEqual(getPresetNames(), ['Default', 'My preset']);
        globalThis.document = { querySelector: () => null };
        assert.deepEqual(getPresetNames(), []);
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
});
