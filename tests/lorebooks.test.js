import test from 'node:test';
import assert from 'node:assert/strict';
import { getLorebookNames, importLorebook } from '../lorebooks.js';

function lorebook() {
    return {
        name: 'Display title', scan_depth: 7, extensions: { custom: { untouched: true } },
        entries: {
            0: { uid: 0, key: ['CafÃ©'], keysecondary: ['Other'], content: 'Original {{user}} lore.', comment: 'Memo', constant: true, selective: false, order: 42, position: 1, probability: 70, useProbability: true, disable: false, extensions: { preserve: ['nested', 1] } },
            8: { uid: 8, key: [], content: 'Second entry', custom_setting: { unknown: 'retained' } },
        },
    };
}

function downloaded(data = lorebook(), name = 'World.json') {
    return new File([JSON.stringify(data, null, 4) + '\n'], name, { type: 'application/json' });
}

function harness({ disk = [], save = true, listResponse, readResponse, savedChange, importError, sanitize = name => name.replace(/[<>:"/\\|?*]/g, '') } = {}) {
    const stored = new Map(disk.map(([name, data]) => [name, structuredClone(data)]));
    const cached = { world_names: ['Stale boot world'] };
    const imported = [], reads = [], sanitized = [], refreshes = [], assignments = { global: ['Existing world'], character: 'Existing character world' };
    let listReads = 0;
    const tools = {
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-Test': 'headers' }),
        getCachedSettingsPayload: () => cached,
        async sanitizeFilename(name) { sanitized.push(name); return sanitize(name); },
        async importWorldInfo(file) {
            const value = { file, text: await file.text(), beforeNames: [...cached.world_names] };
            imported.push(value);
            if (importError) throw importError;
            if (!save) return;
            const data = JSON.parse(value.text);
            savedChange?.(data);
            stored.set(file.name.replace(/\.json$/, ''), data);
            // Simulate the native refresh consulting the cached boot settings.
            refreshes.push([...cached.world_names]);
        },
        async updateWorldInfoList() { refreshes.push([...cached.world_names]); },
        assignLorebookToChat() { throw new Error('Import must not assign lorebooks'); },
        charUpdatePrimaryWorld() { throw new Error('Import must not assign character lorebooks'); },
    };
    async function fetchImpl(path, options) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Test'], 'headers');
        reads.push({ path, body: JSON.parse(options.body) });
        if (path === '/api/worldinfo/list') {
            listReads++;
            if (listResponse) return listResponse(listReads, stored);
            return Response.json([...stored.keys()].map(file_id => ({ file_id, name: 'Potentially different display title', extensions: {} })));
        }
        assert.equal(path, '/api/worldinfo/get');
        const { name } = JSON.parse(options.body);
        if (readResponse) return readResponse(name, stored);
        return Response.json(stored.get(name));
    }
    return { tools, fetchImpl, stored, cached, imported, reads, sanitized, refreshes, assignments };
}

test('native lorebook import preserves raw bytes, entries, native options and extensions without assigning it', async () => {
    const file = downloaded(), fixture = harness();
    assert.equal(await importLorebook(file, fixture), 'World');
    assert.equal(fixture.imported[0].text, await file.text());
    assert.equal(fixture.imported[0].file.name, 'World.json');
    assert.deepEqual(fixture.stored.get('World'), lorebook());
    assert.deepEqual(fixture.assignments, { global: ['Existing world'], character: 'Existing character world' });
    assert.deepEqual(fixture.reads, [
        { path: '/api/worldinfo/list', body: {} },
        { path: '/api/worldinfo/list', body: {} },
        { path: '/api/worldinfo/get', body: { name: 'World' } },
    ]);
});

test('disk collisions use fresh file IDs and leave originals intact', async () => {
    const original = lorebook();
    original.entries[0].content = 'Existing original';
    const fixture = harness({ disk: [['WORLD', original], ['World (Plotlight 2)', original]] });
    assert.equal(await importLorebook(downloaded(), fixture), 'World (Plotlight 3)');
    assert.deepEqual(fixture.stored.get('WORLD'), original);
    assert.deepEqual(fixture.stored.get('World (Plotlight 2)'), original);
    assert.equal(fixture.imported.length, 1);
});

test('UI collisions and Unicode normalization are checked after sanitization', async () => {
    const previous = globalThis.document;
    try {
        globalThis.document = { querySelector: () => ({ options: [{ value: '', text: 'Pick to Edit' }, { value: '0', text: 'Cafe\u0301' }] }) };
        const fixture = harness();
        assert.equal(await importLorebook(downloaded(lorebook(), 'Caf\u00e9?.JSON'), fixture), 'Caf\u00e9 (Plotlight 2)');
        assert.deepEqual(fixture.sanitized, ['Caf\u00e9?']);
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
});

test('empty sanitized filenames use a safe fallback', async () => {
    const fixture = harness({ sanitize: () => '' });
    assert.equal(await importLorebook(downloaded(), fixture), 'Plotlight lorebook');
});

test('boot cache names are refreshed before import and again before final native refresh', async () => {
    const fixture = harness({ disk: [['Fresh disk world', lorebook()]] });
    await importLorebook(downloaded(), fixture);
    assert.deepEqual(fixture.imported[0].beforeNames, ['Fresh disk world']);
    assert.deepEqual(fixture.refreshes, [['Fresh disk world'], ['Fresh disk world', 'World']]);
    assert.deepEqual(fixture.cached.world_names, ['Fresh disk world', 'World']);
});

test('absent boot cache does not prevent normal import', async () => {
    const fixture = harness();
    fixture.tools.getCachedSettingsPayload = () => null;
    assert.equal(await importLorebook(downloaded(), fixture), 'World');
});

test('invalid JSON and malformed lorebooks reject before native import or list requests', async () => {
    for (const file of [new File(['{broken'], 'bad.json'), downloaded({}), downloaded({ entries: { 0: { key: [], content: 123 } } })]) {
        const fixture = harness();
        await assert.rejects(importLorebook(file, fixture));
        assert.equal(fixture.imported.length, 0);
        assert.equal(fixture.reads.length, 0);
    }
});

test('failed and malformed disk lists cannot lead to import or successful verification', async () => {
    for (const response of [new Response('', { status: 500 }), Response.json({ entries: [] }), Response.json([{ name: 'Missing file ID' }])]) {
        const fixture = harness({ listResponse: () => response });
        await assert.rejects(importLorebook(downloaded(), fixture));
        assert.equal(fixture.imported.length, 0);
    }
    const fixture = harness({ listResponse: count => count === 1 ? Response.json([]) : Response.json({ bad: true }) });
    await assert.rejects(importLorebook(downloaded(), fixture), /invalid lorebook list/);
    assert.equal(fixture.imported.length, 1);
});

test('swallowed native import failures never report success', async () => {
    const fixture = harness({ save: false });
    await assert.rejects(importLorebook(downloaded(), fixture), /could not be confirmed in the lorebook list/);
    assert.equal(fixture.reads.length, 2);
});

test('thrown native failures propagate', async () => {
    const fixture = harness({ importError: new Error('Disk full') });
    await assert.rejects(importLorebook(downloaded(), fixture), /Disk full/);
    assert.equal(fixture.stored.size, 0);
});

test('missing, failed and malformed saved lorebooks cannot pass verification', async () => {
    for (const response of [new Response('', { status: 404 }), new Response('', { status: 500 }), Response.json({ entries: {} }), Response.json({}), new Response('{broken')]) {
        const fixture = harness({ readResponse: () => response });
        await assert.rejects(importLorebook(downloaded(), fixture));
        assert.equal(fixture.imported.length, 1);
    }
});

test('changed or additional entries cannot pass verification', async () => {
    for (const change of [data => { data.entries[0].content = 'Changed'; }, data => { data.entries[0].disable = true; }, data => { data.entries[9] = { uid: 9, key: [], content: 'Unexpected' }; }]) {
        const fixture = harness({ savedChange: change });
        await assert.rejects(importLorebook(downloaded(), fixture), /saved entries differ/);
    }
});

test('equivalent object key ordering passes verification', async () => {
    const fixture = harness({ readResponse: (name, stored) => {
        const data = structuredClone(stored.get(name));
        data.entries[0] = Object.fromEntries(Object.entries(data.entries[0]).reverse());
        return Response.json(data);
    } });
    assert.equal(await importLorebook(downloaded(), fixture), 'World');
});

test('lorebook names exclude the editor placeholder and tolerate an absent dropdown', () => {
    const previous = globalThis.document;
    try {
        globalThis.document = { querySelector: selector => {
            assert.equal(selector, '#world_editor_select');
            return { options: [{ value: '', text: 'Pick to Edit' }, { value: '0', text: 'My world' }] };
        } };
        assert.deepEqual(getLorebookNames(), ['My world']);
        globalThis.document = { querySelector: () => null };
        assert.deepEqual(getLorebookNames(), []);
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
});
