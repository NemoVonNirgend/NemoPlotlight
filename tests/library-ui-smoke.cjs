const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
    ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright'
    : 'playwright');

const installedRoot = path.resolve(__dirname, '..');
const root = process.env.NPL_EXTENSION_ROOT || installedRoot;
const prefix = '/scripts/extensions/third-party/NemoPlotlight/';
const executablePath = process.env.NPL_CHROMIUM_PATH || undefined;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=', 'base64');
const loreId = '33333333-3333-4333-8333-333333333333';
const personaId = '44444444-4444-4444-8444-444444444444';
const lorebook = {
    name: 'Preserved display title', extensions: { compendium: { custom: 'keep' } },
    entries: Object.fromEntries(Array.from({ length: 27 }, (_, uid) => [uid, {
        uid, key: [`Location ${uid}`], keysecondary: ['Fantasy'], comment: `Memo ${uid}`,
        content: `Original entry ${uid} for {{user}}.`, order: 100 - uid, position: uid % 2,
        constant: uid === 0, selective: false, disable: false, probability: 80,
        depth: 4, extensions: { custom: ['preserved', uid] },
    }])),
};
const fullPersona = {
    spec: 'rolecall_persona', spec_version: '1.0', source: 'public-definition',
    imageUrl: 'https://images.example/persona.png',
    data: {
        name: 'Mirror Persona', description: 'Brief listing summary', content: '',
        sections: {
            appearance: 'Complete appearance with a blue traveling cloak.',
            personality: 'Complete personality: thoughtful and curious.',
            quirks: 'Complete quirks: taps a rhythm while thinking.',
            history: 'Complete history: raised in an isolated mountain village.',
        },
    },
};
const worlds = new Map([['Dungeon Atlas', { entries: {}, original: true }]]);
const avatars = new Set(['existing-persona.png']);
let savedSettings = null;
const nativeRequests = [];
const anchorMap = {
    'preset-toolbar': 'export_oai_preset', 'world-toolbar': 'world_popup_export',
    'enhanced-world-toolbar': 'nemo-world-info-import-button', 'persona-toolbar': 'personas_backup',
};

function json(res, value, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
}
async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

const core = {
    '/scripts/extensions.js': 'export const extension_settings = window.extSettings = {};',
    '/scripts/power-user.js': 'export const power_user = window.powerUser;',
    '/scripts/utils.js': `export async function getSanitizedFilename(name) { return name.replace(/[<>:"/\\\\|?*]/g, '_'); } export const uuidv4 = () => crypto.randomUUID();`,
    '/script.js': `
        export const default_user_avatar = '/img/default-persona.png';
        export const getRequestHeaders = ({omitContentType = false} = {}) => omitContentType ? {} : {'Content-Type':'application/json'};
        export const getCachedSettingsPayload = () => window.bootCache;
        export function saveSettingsDebounced() { window.historySaveQueued = true; }
        export async function saveSettings() {
            const r = await fetch('/api/settings/save', {method:'POST',headers:getRequestHeaders(),body:JSON.stringify({power_user:window.powerUser,user_avatar:window.activeAvatar,extension_settings:window.extSettings})});
            if (!r.ok) throw Error('Settings save failed');
        }
        export async function processDroppedFiles() { window.characterImports++; throw Error('Unexpected character import'); }
        export const event_types = {OAI_PRESET_IMPORT_READY:'preset-import-ready'};
        export const eventSource = {emit:async()=>{}};
    `,
    '/scripts/world-info.js': `
        import {getCachedSettingsPayload,getRequestHeaders} from '/script.js';
        export let world_names = [];
        export async function updateWorldInfoList() {
            world_names = [...getCachedSettingsPayload().world_names];
            const select = document.querySelector('#world_editor_select');
            select.replaceChildren(new Option('Pick to Edit',''));
            world_names.forEach((name,index)=>select.append(new Option(name,String(index))));
            window.worldRefreshes++;
        }
        export async function importWorldInfo(file) {
            const form = new FormData(); form.append('avatar', file);
            const r = await fetch('/api/worldinfo/import',{method:'POST',body:form});
            if (!r.ok) return;
            const result = await r.json(); await updateWorldInfoList();
            document.querySelector('#world_editor_select').value = String(world_names.indexOf(result.name));
        }
    `,
    '/scripts/personas.js': `
        import {power_user} from '/scripts/power-user.js';
        export let user_avatar = window.activeAvatar;
        export async function initPersona(avatar,name,description,title,{silent=false}={}) {
            window.personaCreates.push({avatar,name,silent});
            power_user.personas[avatar] = name;
            power_user.persona_descriptions[avatar] = {description,title,position:0,depth:2,role:0,lorebook:''};
        }
        export async function getUserAvatars(render=true,openPageAt='') {
            const r = await fetch('/api/avatars/get',{method:'POST'}); const list = await r.json();
            if(render) {
                window.personaRefreshes.push(openPageAt);
                document.querySelector('#user_avatar_block').replaceChildren(...list.map(id=>{
                    const node=document.createElement('div');node.dataset.avatarId=id;node.textContent=power_user.personas[id]||id;return node;
                }));
            }
            return list;
        }
        export async function setUserAvatar(id) {user_avatar=id;window.activeAvatar=id;window.personaSelections++;}
    `,
};

const server = http.createServer(async (req, res) => {
    try {
        const route = new URL(req.url, 'http://localhost').pathname;
        if (route === '/') {
            res.setHeader('Content-Type', 'text/html');
            return res.end(`<!doctype html><html><body style="background:#222;color:#eee">
                ${Object.entries(anchorMap).map(([id, anchor]) => `<div id="${id}"><button id="${anchor}">${anchor}</button></div>`).join('')}
                <div id="rm_buttons_container"></div>
                <select id="settings_preset_openai"><option>Default preset</option></select>
                <select id="world_editor_select"><option value="">Pick to Edit</option><option value="0">Dungeon Atlas</option></select>
                <div id="user_avatar_block"><div data-avatar-id="existing-persona.png">Existing persona</div></div>
                <script>
                    window.chars=[];window.characterImports=0;window.worldRefreshes=0;window.personaSelections=0;
                    window.personaCreates=[];window.personaRefreshes=[];window.activeAvatar='existing-persona.png';
                    window.globalLorebooks=['Existing global world'];window.characterLorebook='Existing character world';
                    window.bootCache={world_names:['Stale boot world']};
                    window.powerUser={personas:{'existing-persona.png':'Existing persona'},persona_descriptions:{'existing-persona.png':{description:'Keep existing description',title:'Existing title'}}};
                    window.SillyTavern={getContext:()=>({characters:window.chars,powerUserSettings:window.powerUser})};
                </script>
                <link rel="stylesheet" href="${prefix}style.css"><script type="module" src="${prefix}index.js"></script>
                </body></html>`);
        }
        if (route === '/img/default-persona.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png);
        }
        if (route.startsWith('/api/')) {
            const raw = await body(req);
            const request = raw.length && !req.headers['content-type']?.startsWith('multipart/') ? JSON.parse(raw) : {};
            nativeRequests.push({ route, request });
            if (route === '/api/worldinfo/list') return json(res, [...worlds.keys()].map(file_id => ({ file_id, name: file_id, extensions: {} })));
            if (route === '/api/worldinfo/get') return json(res, worlds.get(request.name) || { entries: {} });
            if (route === '/api/worldinfo/import' || route === '/api/avatars/upload') {
                const form = await new Request(`http://localhost${route}`, { method: 'POST', headers: req.headers, body: raw }).formData();
                const file = form.get('avatar');
                if (route === '/api/worldinfo/import') {
                    const name = file.name.replace(/\.json$/, '');
                    assert(!worlds.has(name), 'Native lorebook import overwrote an existing file');
                    worlds.set(name, JSON.parse(await file.text())); return json(res, { name });
                }
                const name = form.get('overwrite_name');
                assert(!avatars.has(name), 'Persona import overwrote an existing avatar');
                assert.equal(file.type, 'image/png');
                assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
                avatars.add(name); return json(res, { path: name });
            }
            if (route === '/api/avatars/get') return json(res, [...avatars]);
            if (route === '/api/avatars/delete') { avatars.delete(request.avatar); return json(res, { result: 'ok' }); }
            if (route === '/api/settings/save') { savedSettings = request; return json(res, { ok: true }); }
            if (route === '/api/settings/get') return json(res, { settings: JSON.stringify(savedSettings) });
            if (route === `/api/plugins/nemo-plotlight/persona/${personaId}`) return json(res, fullPersona);
            if (route.startsWith('/api/plugins/nemo-plotlight/stats/')) return json(res, { ratingAverage: 4, ratingCount: 2, rosesTotal: 7 });
            return json(res, { error: 'Unexpected native API request' }, 404);
        }
        res.setHeader('Content-Type', route.endsWith('.css') ? 'text/css' : 'text/javascript');
        if (core[route]) return res.end(core[route]);
        const file = route.startsWith(prefix) ? path.join(root, route.slice(prefix.length)) : '';
        if (file && fs.existsSync(file)) return res.end(fs.readFileSync(file));
        res.statusCode = 404; res.end();
    } catch (error) { json(res, { error: error.message }, 500); }
});

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = process.env.NPL_CDP_ENDPOINT ? await chromium.connectOverCDP(process.env.NPL_CDP_ENDPOINT)
        : await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
        const errors = [], searches = [], tagRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('https://images.example/**', route => route.abort('accessdenied'));
        await page.route('https://plotlightstudios.com/**', async route => {
            const url = new URL(route.request().url());
            const headers = { 'access-control-allow-origin': '*' };
            if (url.pathname.includes(loreId)) return route.fulfill({ json: lorebook, headers });
            if (url.pathname.includes(personaId)) return route.fulfill({ status: 404, json: { error: 'Resource not found' }, headers });
            const type = url.searchParams.get('type');
            const tag = { name: type === 'lorebooks' ? 'Fantasy' : 'Original', slug: `${type}-tag`, category: 'genre' };
            if (url.pathname.endsWith('/tags')) {
                tagRequests.push(type); return route.fulfill({ json: { data: [tag], pagination: { next_offset: null } }, headers });
            }
            searches.push({ type, params: Object.fromEntries(url.searchParams) });
            const item = type === 'lorebooks' ? {
                id: loreId, name: 'Dungeon Atlas', description: 'Public lorebook summary', creator: { name: 'World Creator' }, tags: [tag],
                downloads: { st: `/api/v1/content/lorebooks/${loreId}/download?format=st` }, detail_url: `/discovery/lorebooks/${loreId}`,
            } : type === 'personas' ? {
                id: personaId, name: 'Mirror Persona', description: 'Brief listing summary', creator: { name: 'Persona Creator' }, tags: [tag],
                image_url: 'https://images.example/persona.png',
                downloads: { json: `/api/v1/content/personas/${personaId}/download?format=json` }, detail_url: `/discovery/personas/${personaId}`,
            } : { id: `dummy-${type}`, name: `Sample ${type}`, creator: { name: 'Creator' } };
            return route.fulfill({ json: { data: [item], pagination: { next_offset: null } }, headers });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const buttons = ['nemo_plotlight_browse', 'nemo_plotlight_presets', 'nemo_plotlight_lorebooks', 'nemo_plotlight_lorebooks_enhanced', 'nemo_plotlight_personas'];
        for (const id of buttons) assert.equal(await page.locator(`#${id}`).count(), 1, id);
        for (const [anchor, id] of [
            ['world_popup_export', 'nemo_plotlight_lorebooks'], ['nemo-world-info-import-button', 'nemo_plotlight_lorebooks_enhanced'], ['personas_backup', 'nemo_plotlight_personas'],
        ]) assert.equal(await page.locator(`#${anchor}`).evaluate(node => node.nextElementSibling.id), id);

        await page.locator('#nemo_plotlight_lorebooks').click();
        await page.getByRole('heading', { name: 'Dungeon Atlas', exact: true }).waitFor();
        const tabs = page.locator('.npl-content-tabs');
        assert.equal(await tabs.getByRole('button').count(), 4);
        for (const [label, title] of [['Personas', 'Browse personas'], ['Presets', 'Browse presets'], ['Characters', 'Browse characters'], ['Lorebooks', 'Browse lorebooks']]) {
            await page.locator('.npl-content-tabs').getByRole('button', { name: label, exact: true }).click();
            await page.getByRole('heading', { name: title, exact: true }).waitFor();
            assert.equal(await page.locator('dialog').count(), 1);
            assert.equal(await page.locator('.npl-content-tabs button[aria-pressed="true"]').textContent(), label);
        }
        await page.getByRole('heading', { name: 'Dungeon Atlas', exact: true }).waitFor();
        assert.equal(await page.getByRole('slider', { name: 'Minimum rating', exact: true }).count(), 0);
        assert.equal(await page.locator('.npl-card-stats').count(), 0);
        await page.locator('.npl-search select').selectOption('genres');
        await page.getByLabel('Search', { exact: true }).fill('Dungeon');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        async function changeFilter(label, value, key) {
            const response = page.waitForResponse(r => r.url().startsWith('https://plotlightstudios.com/api/v1/content?') && new URL(r.url()).searchParams.get(key) === value);
            await page.getByLabel(label, { exact: true }).fill(value);
            await page.getByLabel(label, { exact: true }).press('Tab'); await response;
        }
        await changeFilter('Minimum roses', '4', 'min_roses');
        await changeFilter('Minimum favorites', '2', 'min_favorites');
        const compendiumResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('has_compendium') === 'true');
        await page.getByLabel('Compendium data only', { exact: true }).check(); await compendiumResponse;
        await page.getByText('Include / exclude tags', { exact: true }).click();
        const tagResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('tags') === 'lorebooks-tag');
        await page.getByRole('button', { name: 'Include', exact: true }).click(); await tagResponse;
        assert.deepEqual(searches.at(-1).params, { type: 'lorebooks', mode: 'genres', sort: 'recent', limit: '24', offset: '0', q: 'Dungeon', tags: 'lorebooks-tag', min_roses: '4', min_favorites: '2', has_compendium: 'true' });
        assert(tagRequests.includes('lorebooks'));
        await page.getByRole('button', { name: 'Import lorebook', exact: true }).click();
        await page.getByText('Imported into World Info.', { exact: true }).waitFor();
        const worldName = 'Dungeon Atlas (Plotlight 2)';
        assert.deepEqual(worlds.get(worldName), lorebook);
        assert.equal(worlds.get('Dungeon Atlas').original, true);
        assert(await page.locator('#world_editor_select option').allTextContents().then(names => names.includes(worldName)));
        assert.deepEqual(await page.evaluate(() => [window.globalLorebooks, window.characterLorebook]), [['Existing global world'], 'Existing character world']);
        assert.equal(await page.evaluate(id => window.extSettings.NemoPlotlight.lorebookImports[id].name, loreId), worldName);
        assert.equal(await page.getByRole('button', { name: 'Imported', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('#nemo_plotlight_lorebooks_enhanced').click();
        await page.getByRole('button', { name: 'Imported', exact: true }).waitFor();
        assert.equal(worlds.size, 2);
        await page.getByRole('button', { name: 'Close', exact: true }).click();

        await page.locator('#nemo_plotlight_personas').click();
        await page.getByRole('heading', { name: 'Mirror Persona', exact: true }).waitFor();
        assert.deepEqual(await page.locator('.npl-search select option').allTextContents(), ['Names', 'Creators']);
        for (const label of ['Minimum rating', 'Minimum roses', 'Compendium data only', 'Visual-novel data only']) assert.equal(await page.getByLabel(label, { exact: true }).count(), 0);
        await page.locator('.npl-search select').selectOption('creators');
        await page.getByLabel('Search', { exact: true }).fill('Persona Creator');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await changeFilter('Minimum favorites', '3', 'min_favorites');
        assert.deepEqual(searches.at(-1).params, { type: 'personas', mode: 'creators', sort: 'recent', limit: '24', offset: '0', q: 'Persona Creator', min_favorites: '3' });
        await page.getByRole('button', { name: 'Import persona', exact: true }).click();
        await page.getByText('Imported public definition into Persona Management. Using the default avatar.', { exact: true }).waitFor();
        const history = await page.evaluate(id => window.extSettings.NemoPlotlight.personaImports[id], personaId);
        assert.equal(history.source, 'public-definition'); assert.equal(history.usedDefaultAvatar, true);
        assert.equal(savedSettings.power_user.personas[history.avatar], 'Mirror Persona');
        const descriptor = savedSettings.power_user.persona_descriptions[history.avatar];
        for (const section of Object.values(fullPersona.data.sections)) assert(descriptor.description.includes(section));
        assert(!descriptor.description.includes('Brief listing summary'));
        assert.equal(descriptor.title, 'Brief listing summary');
        assert.equal(savedSettings.user_avatar, 'existing-persona.png');
        assert.equal(await page.evaluate(() => window.activeAvatar), 'existing-persona.png');
        assert.equal(await page.evaluate(() => window.personaSelections), 0);
        assert.deepEqual(await page.evaluate(() => window.personaCreates.map(({ silent }) => silent)), [true]);
        assert.equal(await page.evaluate(() => window.characterImports), 0);
        assert.equal(nativeRequests.filter(({ route }) => route === '/api/characters/import').length, 0);
        assert.equal(await page.locator(`#user_avatar_block [data-avatar-id="${history.avatar}"]`).count(), 1);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('#nemo_plotlight_personas').click();
        await page.getByRole('button', { name: 'Imported', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Imported', exact: true }).isDisabled(), true);
        assert.equal(avatars.size, 2);

        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            for (const label of ['Personas', 'Lorebooks']) {
                await page.locator('.npl-content-tabs').getByRole('button', { name: label, exact: true }).click();
                await page.getByRole('heading', { name: `Browse ${label.toLowerCase()}`, exact: true }).waitFor();
                assert(await page.locator('dialog').evaluate(node => node.scrollWidth <= node.clientWidth), `${label} overflows at ${width}px`);
            }
        }
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(map => {
            for (const [id, anchorId] of Object.entries(map)) {
                const anchor = document.createElement('button'); anchor.id = anchorId; anchor.textContent = anchorId;
                document.getElementById(id).replaceChildren(anchor);
            }
            document.getElementById('rm_buttons_container').replaceChildren();
        }, anchorMap);
        for (const id of buttons) { await page.locator(`#${id}`).waitFor(); assert.equal(await page.locator(`#${id}`).count(), 1, id); }
        await page.evaluate(() => { const trigger = document.createElement('div'); document.body.append(trigger); trigger.remove(); });
        for (const id of buttons) assert.equal(await page.locator(`#${id}`).count(), 1, `duplicate ${id}`);
        assert.deepEqual(errors, []);
        console.log('PASS: four tabs, one dialog, all entrypoints/remounts, typed lorebook/persona filters, lorebook collision/raw options/native refresh/no assignments, full persona fallback/default portrait/persistence/unchanged active persona/no character import, duplicate history and 390/320px overflow.');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
