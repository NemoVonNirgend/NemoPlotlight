import test from 'node:test';
import assert from 'node:assert/strict';
import { PlotlightClient, PRESET_MODES, LOREBOOK_MODES, PERSONA_MODES, searchUrl, readPage, publicUrl, portraitUrl, retryDelay, importAndVerify, fetchCardStats, validatePreset, validateLorebook, validatePersona, personaDefinition } from '../api.js';
const id = '11111111-1111-4111-8111-111111111111';
const item = { id, name: '../Test', downloads: { png: `/api/v1/content/cards/${id}?format=png`, json: `/api/v1/content/cards/${id}?format=json` } };
const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
const presetItem = { id, name: '../Preset', downloads: { legacy: `/api/v1/content/presets/${id}?format=legacy` } };
const preset = {
 name: 'Portable preset', temperature: 0.75, top_p: 0.95, extension_settings: { example: { value: ['preserve', 1] } },
 prompts: [
  { identifier: 'main', content: '{{char}} speaks.', role: 'system', system_prompt: true, extra: { keep: true } },
  { identifier: 'chatHistory', marker: true },
  { identifier: 'reply', content: '{{user}}', role: 'user' },
  { identifier: 'prefill', content: '', role: 'assistant' },
 ],
 prompt_order: [
  { character_id: '100000', order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] },
  { character_id: 100001, order: [{ identifier: 'reply', enabled: false }, { identifier: 'prefill', enabled: true }] },
 ],
};
const lorebookItem = { id, name: 'Library book', downloads: { st: `/api/v1/content/lorebooks/${id}?format=st` } };
const personaItem = { id, name: 'Library persona', downloads: { json: `/api/v1/content/personas/${id}?format=json` } };
const lorebook = { entries: { 0: { uid: 0, key: ['forest'], keysecondary: [], content: 'An ancient forest.', constant: false, disable: false, extensionField: { preserved: true } } }, name: 'Forest', custom: [1] };
const persona = { spec: 'rolecall_persona', spec_version: '1.0', data: { name: 'Forest visitor', description: 'A brief teaser.', content: 'The complete persona description.', sections: { appearance: 'Wears green.', personality: 'Quiet.' }, metadata: { source: 'plotlight-public-definition' } }, source: 'public-definition', imageUrl: 'https://plotlightstudios.com/visitor.png', linkedLorebookOmitted: true };

test('filters encode exact native slugs and preserve pagination', () => {
 const url = searchUrl({ q: 'A & B', mode: 'creators', sort: 'rating', tags: ['genre-urban-fantasy'], excludeTags: ['theme_horror'], minRating: 4.2, hasVn: true }, 24);
 assert.equal(url.searchParams.get('q'), 'A & B');
 assert.equal(url.searchParams.get('tags'), 'genre-urban-fantasy');
 assert.equal(url.searchParams.get('exclude_tags'), 'theme_horror');
 assert.equal(url.searchParams.get('offset'), '24');
 assert.equal(url.searchParams.get('has_vn'), 'true');
 assert.equal(url.searchParams.get('min_rating'), '4.2');
 assert.throws(() => searchUrl({ tags: ['a'], excludeTags: ['a'] }));
 assert.throws(() => searchUrl({ tags: Array.from({length:11}, (_, i) => `${i}`) }));
 assert.throws(() => searchUrl({ minRating: 'not a number' }));
});
test('empty pages can still have a next page; malformed pagination is rejected', () => {
 assert.equal(readPage({data: [], pagination: {next_offset: 24}}, 0).nextOffset, 24);
 assert.equal(readPage({data: [], pagination: {next_offset: null}}, 10000).nextOffset, null);
 assert.throws(() => readPage({data: [], pagination: {next_offset: 0}}, 0));
 assert.throws(() => readPage({data: [], pagination: {}}, 0));
});
test('remote URLs reject scripts, credentials and unexpected download hosts', () => {
 for (const url of ['javascript:alert(1)', 'https://evil.example/card', 'https://me:pass@plotlightstudios.com/x', 'http://plotlightstudios.com/x']) assert.throws(() => publicUrl(url));
 assert.equal(publicUrl('/api/v1/content').origin, 'https://plotlightstudios.com');
});

test('only fixed Plotlight published thumbnails use the local image helper', () => {
 assert.equal(portraitUrl(`/api/published-media/${id}/thumb`), `/api/plugins/nemo-plotlight/image/${id}`);
 assert.equal(portraitUrl(`https://plotlightstudios.com/api/published-media/${id.toUpperCase()}/thumb`), `/api/plugins/nemo-plotlight/image/${id}`);
 for (const url of [`https://images.example/api/published-media/${id}/thumb`, `https://plotlightstudios.com/api/published-media/${id}/full`, `https://plotlightstudios.com/api/published-media/${id}/thumb?size=large`]) {
  assert.equal(portraitUrl(url), url);
 }
 for (const url of ['http://plotlightstudios.com/image.png', 'javascript:alert(1)', 'https://user:pass@plotlightstudios.com/image.png']) assert.throws(() => portraitUrl(url));
});

test('missing persona helper provides actionable installation guidance', async () => {
 const client = new PlotlightClient(async () => new Response('', { status: 404 }));
 await assert.rejects(client.downloadPersona(personaItem), /server helper.*restart SillyTavern/);
});

test('missing statistics helper is distinguished from a transient failure', async () => {
 await assert.rejects(fetchCardStats(id, { fetchImpl: async () => new Response('', { status: 404 }) }), /Install the Nemo Plotlight server helper/);
 await assert.rejects(fetchCardStats(id, { fetchImpl: async () => new Response('', { status: 503 }) }), /temporarily unavailable/);
});
test('search is anonymous and accepts an abort signal', async () => {
 let options;
 const client = new PlotlightClient(async (_, opts) => {options=opts; return Response.json({data:[],pagination:{next_offset:null}});});
 await client.search({});
 assert.equal(options.credentials, 'omit');
 assert.equal(options.redirect, 'error');
 assert.ok(options.signal instanceof AbortSignal);
});
test('429 cooldown honors Retry-After and keeps export separate', async () => {
 let now = 1000, calls = 0;
 const client = new PlotlightClient(async () => {calls++; return new Response('', {status:429,headers:{'Retry-After':'10'}});}, () => now);
 await assert.rejects(client.search({}), /10 seconds/);
 now += 1000;
 await assert.rejects(client.search({}), /9 seconds/);
 assert.equal(calls, 1);
 await assert.rejects(client.download(item), /10 seconds/);
 assert.equal(calls, 2);
 assert.equal(retryDelay('Thu, 01 Jan 1970 00:01:00 GMT', 30000), 30000);
});
test('download validates signature and refuses error bodies', async () => {
 const client = new PlotlightClient(async () => new Response(png));
 const file = await client.download(item);
 assert.equal(file.type, 'image/png');
 assert.equal(file.name, '.._Test.png');
 assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png);
 await assert.rejects(new PlotlightClient(async () => Response.json({error:'oops'})).download(item), /PNG card/);
 await assert.rejects(new PlotlightClient(async () => new Response('',{status:403})).download(item), /not exportable/);
 await assert.rejects(new PlotlightClient(async () => new Response(png,{headers:{'Content-Length':String(31*1024*1024)}})).download(item), /30 MB/);
});
test('V2/V3 JSON accepts portable cards but not arbitrary JSON', async () => {
 const card={spec:'chara_card_v2',data:{name:'Forest Mage',creator:'Creator',character_book:{entries:[]}}};
 const file=await new PlotlightClient(async () => Response.json(card)).download(item,'json');
 assert.deepEqual(JSON.parse(await file.text()),card);
 await assert.rejects(new PlotlightClient(async () => Response.json({error:'oops'})).download(item,'json'), /not a V2 or V3/);
});
test('swallowed ST errors do not become successful imports', async () => {
 let chars=[{avatar:'old.png'}];
 await assert.rejects(importAndVerify({}, {getCharacters:()=>chars,processFiles:async()=>{}}), /could not be confirmed/);
 const avatar=await importAndVerify({}, {getCharacters:()=>chars,processFiles:async()=>{chars=[...chars,{avatar:'new.png'}];}});
 assert.equal(avatar,'new.png');
 assert.deepEqual(chars[0],{avatar:'old.png'});
});

test('local card statistics use the fixed helper path and preserve unknown values', async () => {
 let request;
 const values = await fetchCardStats(id, {fetchImpl:async(url,options)=>{request={url,options};return Response.json({ratingAverage:4.2,ratingCount:12,rosesTotal:null});}});
 assert.equal(request.url, `/api/plugins/nemo-plotlight/stats/${id}`);
 assert.equal(request.options.credentials, 'same-origin');
 assert.equal(request.options.redirect, 'error');
 assert.equal(values.rosesTotal,null);
 assert.equal(values.ratingAverage,4.2);
 await assert.rejects(fetchCardStats('../private', {fetchImpl:()=>{throw new Error('must not fetch');}}), /Invalid card ID/);
 await assert.rejects(fetchCardStats(id, {fetchImpl:async()=>new Response('',{status:503})}), /temporarily unavailable/);
});

test('preset filters use their own search modes and omit character-only parameters', () => {
 assert.deepEqual(PRESET_MODES, ['names', 'creators', 'styles', 'models']);
 const url = searchUrl({ mode: 'models', q: 'Example model', sort: 'popular', tags: ['style-slow'], excludeTags: ['model-other'], minRoses: 2, minFavorites: '12', minRating: 4, hasVn: true }, 48, 'presets');
 assert.equal(url.searchParams.get('type'), 'presets');
 assert.equal(url.searchParams.get('offset'), '48');
 assert.equal(url.searchParams.get('tags'), 'style-slow');
 assert.equal(url.searchParams.get('exclude_tags'), 'model-other');
 assert.equal(url.searchParams.get('sort'), 'popular');
 assert.equal(url.searchParams.get('min_roses'), '2');
 assert.equal(url.searchParams.get('min_favorites'), '12');
 assert.equal(url.searchParams.has('min_rating'), false);
 assert.equal(url.searchParams.has('has_vn'), false);
 assert.equal(searchUrl({ minFavorites: 0 }, 0, 'presets').searchParams.get('min_favorites'), '0');
 assert.equal(searchUrl({ minRoses: 1000000 }, 0, 'presets').searchParams.get('min_roses'), '1000000');
 for (const value of [-1, 1.5, 1000001, 'bad', Infinity]) {
  assert.throws(() => searchUrl({ minRoses: value }, 0, 'presets'), /Minimum counts/);
  assert.throws(() => searchUrl({ minFavorites: value }, 0, 'presets'), /Minimum counts/);
 }
 assert.throws(() => searchUrl({ mode: 'genres' }, 0, 'presets'), /Invalid search/);
 assert.throws(() => searchUrl({ mode: 'styles' }), /Invalid search/);
 assert.throws(() => searchUrl({}, 0, 'other'), /Unsupported content type/);
 assert.equal(searchUrl({ minRoses: 3, minFavorites: 5 }).searchParams.has('min_roses'), false);
});

test('search and tags select presets while preserving card defaults', async () => {
 const requests = [];
 const client = new PlotlightClient(async url => { requests.push(url); return Response.json({ data: [], pagination: { next_offset: null } }); });
 await client.search({ mode: 'styles' }, 0, undefined, 'presets');
 await client.tags(0, undefined, 'presets');
 await client.search({});
 await client.tags();
 assert.deepEqual(requests.map(url => url.searchParams.get('type')), ['presets', 'presets', 'cards', 'cards']);
 assert.equal(requests[1].pathname, '/api/v1/content/tags');
 await assert.rejects(client.tags(0, undefined, 'other'), /Unsupported content type/);
});

test('preset export keeps its bytes, portable prompts, settings and extension fields', async () => {
 const text = JSON.stringify(preset, null, 2) + '\n';
 let options;
 const file = await new PlotlightClient(async (_, opts) => { options = opts; return new Response(text); }).downloadPreset(presetItem);
 assert.equal(file.type, 'application/json');
 assert.equal(file.name, '.._Preset.json');
 assert.equal(await file.text(), text);
 assert.deepEqual(JSON.parse(await file.text()), preset);
 assert.equal(validatePreset(preset), preset);
 assert.equal(options.credentials, 'omit');
 assert.equal(options.redirect, 'error');
 assert.ok(options.signal instanceof AbortSignal);
});

test('preset downloads only use a legacy export at an allowed preset URL', async () => {
 let calls = 0;
 const client = new PlotlightClient(async () => { calls++; return Response.json(preset); });
 for (const legacy of [
  `https://evil.example/api/v1/content/presets/${id}`,
  `http://plotlightstudios.com/api/v1/content/presets/${id}`,
  `https://me:pass@plotlightstudios.com/api/v1/content/presets/${id}`,
  `/api/v1/content/cards/${id}`, `/api/v1/content/presets/${'a'.repeat(36)}`,
  `/api/v1/content/presets/${id}/private`, `/api/v1/content/presets/${id}/download/extra`,
 ]) await assert.rejects(client.downloadPreset({ downloads: { legacy } }));
 await assert.rejects(client.downloadPreset({ downloads: { json: presetItem.downloads.legacy } }), /Missing content URL/);
 assert.equal(calls, 0);
 await client.downloadPreset({ downloads: { legacy: `/api/v1/content/presets/${id}/download` } });
 assert.equal(calls, 1);
});

test('preset downloads reject non-JSON, card JSON and oversized response bodies', async () => {
 await assert.rejects(new PlotlightClient(async () => new Response('not json')).downloadPreset(presetItem), /valid preset JSON/);
 await assert.rejects(new PlotlightClient(async () => new Response(png)).downloadPreset(presetItem), /valid preset JSON/);
 await assert.rejects(new PlotlightClient(async () => Response.json({ spec: 'chara_card_v2', data: { name: 'Card' } })).downloadPreset(presetItem), /chat completion preset/);
 await assert.rejects(new PlotlightClient(async () => new Response('{}', { headers: { 'Content-Length': String(31 * 1024 * 1024) } })).downloadPreset(presetItem), /30 MB/);
 let cancelled = false;
 const stream = new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(30 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
  cancel() { cancelled = true; },
 });
 await assert.rejects(new PlotlightClient(async () => new Response(stream)).downloadPreset(presetItem), /30 MB/);
 assert.equal(cancelled, true);
});

test('preset schema rejects unsafe prompt and order types while accepting native markers', () => {
 for (const data of [null, [], 'preset', {}, { prompts: [], prompt_order: {} }]) assert.throws(() => validatePreset(data), /chat completion preset/);
 for (const prompt of [null, [], { identifier: 1 }, { identifier: '', content: '', role: 'system' },
  { identifier: 'main', content: 4, role: 'system' }, { identifier: 'main', content: '', role: 'tool' },
  { identifier: 'main', content: '' }, { identifier: 'main', role: 'system' },
  { identifier: 'chatHistory', marker: 'true' }, { identifier: 'chatHistory', marker: true, content: {} },
 ]) assert.throws(() => validatePreset({ prompts: [prompt], prompt_order: [] }), /invalid prompt/);
 for (const group of [null, [], { character_id: {}, order: [] }, { character_id: 100000, order: {} },
  { character_id: 100000, order: [{ identifier: 2, enabled: true }] },
  { character_id: 100000, order: [{ identifier: 'main', enabled: 'true' }] },
  { character_id: 100000, order: [null] },
 ]) assert.throws(() => validatePreset({ prompts: [], prompt_order: [group] }), /invalid prompt order/);
 const markers = { prompts: [{ identifier: 'chatHistory', marker: true }], prompt_order: [] };
 assert.equal(validatePreset(markers), markers);
 const duplicate = structuredClone(preset);
 duplicate.prompts.push(structuredClone(duplicate.prompts[0]));
 assert.equal(validatePreset(duplicate), duplicate);
});

test('preset export rate limits share the character export cooldown', async () => {
 let calls = 0;
 const client = new PlotlightClient(async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '7' } }); });
 await assert.rejects(client.downloadPreset(presetItem), /7 seconds/);
 await assert.rejects(client.download(item), /7 seconds/);
 assert.equal(calls, 1);
});

test('lorebook and persona filters use their own modes and supported parameters', () => {
 assert.deepEqual(LOREBOOK_MODES, ['names', 'creators', 'genres', 'types']);
 assert.deepEqual(PERSONA_MODES, ['names', 'creators']);
 const filters = { mode: 'genres', minRoses: 3, minFavorites: 5, hasCompendium: true, minRating: 4, hasVn: true, tags: ['genre-fantasy'] };
 const book = searchUrl(filters, 24, 'lorebooks');
 assert.equal(book.searchParams.get('min_roses'), '3');
 assert.equal(book.searchParams.get('min_favorites'), '5');
 assert.equal(book.searchParams.get('has_compendium'), 'true');
 assert.equal(book.searchParams.get('tags'), 'genre-fantasy');
 for (const parameter of ['min_rating', 'has_vn']) assert.equal(book.searchParams.has(parameter), false);
 const person = searchUrl({ ...filters, mode: 'creators' }, 0, 'personas');
 assert.equal(person.searchParams.get('min_favorites'), '5');
 for (const parameter of ['min_roses', 'min_rating', 'has_vn', 'has_compendium']) assert.equal(person.searchParams.has(parameter), false);
 assert.throws(() => searchUrl({ mode: 'types' }, 0, 'personas'), /Invalid search/);
 assert.throws(() => searchUrl({ mode: 'styles' }, 0, 'lorebooks'), /Invalid search/);
 for (const type of ['lorebooks', 'personas']) assert.throws(() => searchUrl({ minFavorites: 0.5 }, 0, type), /Minimum counts/);
 assert.equal(searchUrl({ hasCompendium: true }).searchParams.has('has_compendium'), false);
});

test('search and tag catalogs support lorebooks and personas', async () => {
 const requests = [];
 const client = new PlotlightClient(async url => { requests.push(url); return Response.json({ data: [], pagination: { next_offset: null } }); });
 for (const type of ['lorebooks', 'personas']) {
  await client.search({}, 0, undefined, type);
  await client.tags(0, undefined, type);
 }
 assert.deepEqual(requests.map(url => url.searchParams.get('type')), ['lorebooks', 'lorebooks', 'personas', 'personas']);
 assert.equal(requests[1].pathname, '/api/v1/content/tags');
});

test('lorebook export preserves native entry settings and original JSON bytes', async () => {
 const text = JSON.stringify(lorebook, null, 2) + '\n';
 const file = await new PlotlightClient(async () => new Response(text)).downloadLorebook(lorebookItem);
 assert.equal(file.name, 'Library book.json');
 assert.equal(file.type, 'application/json');
 assert.equal(await file.text(), text);
 assert.equal(validateLorebook(lorebook), lorebook);
 for (const data of [null, [], {}, { entries: [] }, { entries: { 0: null } },
  { entries: { 0: { content: {}, key: [] } } }, { entries: { 0: { content: '', key: [1] } } },
  { entries: { 0: { content: '', key: [], keysecondary: 'bad' } } },
  { entries: { 0: { content: '', key: [], uid: -1 } } }, { entries: { 0: { content: '', key: [], disable: 'yes' } } },
 ]) assert.throws(() => validateLorebook(data), /lorebook/);
});

test('library exports reject foreign URLs, malformed UUIDs, missing native formats and arbitrary JSON', async () => {
 let calls = 0;
 const client = new PlotlightClient(async () => { calls++; return Response.json(lorebook); });
 for (const [method, type, format] of [['downloadLorebook', 'lorebooks', 'st'], ['downloadPersona', 'personas', 'json']]) {
  for (const path of [`https://evil.example/api/v1/content/${type}/${id}`, `/api/v1/content/cards/${id}`, `/api/v1/content/${type}/${'a'.repeat(36)}`, `/api/v1/content/${type}/${id}/extra`]) {
   await assert.rejects(client[method]({ downloads: { [format]: path } }));
  }
  await assert.rejects(client[method]({ downloads: {} }), /Missing content URL/);
 }
 assert.equal(calls, 0);
 await assert.rejects(new PlotlightClient(async () => Response.json({ error: 'no' })).downloadLorebook(lorebookItem), /not a SillyTavern lorebook/);
 await assert.rejects(new PlotlightClient(async () => new Response('invalid')).downloadPersona(personaItem), /valid persona JSON/);
});

test('library exports share bounded bodies and export cooldowns', async () => {
 for (const [method, value] of [['downloadLorebook', lorebookItem], ['downloadPersona', personaItem]]) {
  await assert.rejects(new PlotlightClient(async () => new Response('{}', { headers: { 'Content-Length': String(31 * 1024 * 1024) } }))[method](value), /30 MB/);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(30 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(new PlotlightClient(async () => new Response(stream))[method](value), /30 MB/);
  assert.equal(cancelled, true);
 }
 let calls = 0;
 const client = new PlotlightClient(async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '8' } }); });
 await assert.rejects(client.downloadLorebook(lorebookItem), error => error.status === 429);
 await assert.rejects(client.downloadPersona(personaItem), /8 seconds/);
 await assert.rejects(client.downloadPreset(presetItem), /8 seconds/);
 assert.equal(calls, 1);
});

test('persona definition favors full content over teaser and falls back to labeled public sections', () => {
 assert.equal(validatePersona(persona), persona);
 assert.deepEqual(personaDefinition(persona), { name: 'Forest visitor', description: 'The complete persona description.', title: 'A brief teaser.', imageUrl: 'https://plotlightstudios.com/visitor.png' });
 const sections = structuredClone(persona);
 sections.data.content = ' ';
 const result = personaDefinition(sections);
 assert.equal(result.description, 'Appearance:\nWears green.\n\nPersonality:\nQuiet.');
 assert.equal(result.description.includes('A brief teaser.'), false);
 const summaryOnly = structuredClone(persona);
 delete summaryOnly.data.content;
 delete summaryOnly.data.sections;
 assert.throws(() => validatePersona(summaryOnly), /no full definition/);
 for (const spec of ['chara_card_v2', 'chara_card_v3', undefined]) {
  const definition = { name: 'Traveler', description: 'A traveler.', personality: 'A traveler.', scenario: 'In a forest.', custom: { untouched: true } };
  const exported = spec ? { spec, data: definition } : definition;
  assert.equal(validatePersona(exported), exported);
  assert.equal(personaDefinition(exported).description, 'Description:\nA traveler.\n\nScenario:\nIn a forest.');
 }
 for (const data of [null, {}, { name: 'Traveler', description: 3 }, { spec: 'other', data: { name: 'Traveler', description: 'yes' } }, { ...persona, data: { ...persona.data, sections: { body: {} } } }]) assert.throws(() => validatePersona(data), /persona/);
});

test('native persona exports retain original bytes and bypass the public helper', async () => {
 const text = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Traveler', description: 'A traveler.' } }, null, 2) + '\n';
 let calls = 0;
 const file = await new PlotlightClient(async () => { calls++; return new Response(text); }).downloadPersona(personaItem);
 assert.equal(await file.text(), text);
 assert.equal(file.nplSource, undefined);
 assert.equal(calls, 1);
});

test('only HTTP 404 persona exports use a fixed local public-definition helper', async () => {
 const calls = [];
 const signal = new AbortController().signal;
 const client = new PlotlightClient(async (url, options) => { calls.push({ url: String(url), options }); return calls.length === 1 ? new Response('', { status: 404 }) : Response.json(persona); });
 const file = await client.downloadPersona(personaItem, signal);
 assert.equal(file.nplSource, 'public-definition');
 assert.equal(file.nplLinkedLorebookOmitted, true);
 assert.equal(file.nplImageUrl, persona.imageUrl);
 assert.deepEqual(JSON.parse(await file.text()), persona);
 assert.equal(calls[1].url, `/api/plugins/nemo-plotlight/persona/${id}`);
 assert.equal(calls[1].options.credentials, 'same-origin');
 assert.equal(calls[1].options.redirect, 'error');
 assert.ok(calls[1].options.signal instanceof AbortSignal);
 for (const status of [401, 403, 429, 500]) {
  let count = 0;
  await assert.rejects(new PlotlightClient(async () => { count++; return new Response('', { status }); }).downloadPersona(personaItem), error => error.status === status);
  assert.equal(count, 1);
 }
 let count = 0;
 await assert.rejects(new PlotlightClient(async () => { count++; throw new TypeError('Network failure'); }).downloadPersona(personaItem), /Network failure/);
 assert.equal(count, 1);
});

test('public persona helper failures do not become successful downloads', async () => {
 for (const response of [new Response('', { status: 403 }), Response.json({ ...persona, source: 'private' }), Response.json({ error: 'missing' }), new Response('{}', { headers: { 'Content-Length': String(31 * 1024 * 1024) } })]) {
  let calls = 0;
  await assert.rejects(new PlotlightClient(async () => ++calls === 1 ? new Response('', { status: 404 }) : response).downloadPersona(personaItem));
  assert.equal(calls, 2);
 }
});
