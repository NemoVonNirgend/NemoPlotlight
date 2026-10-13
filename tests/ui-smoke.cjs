const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright' : 'playwright');
const fs = require('fs');
const http = require('http');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..') + '/';
const prefix = '/scripts/extensions/third-party/NemoPlotlight/';
let statsState = 'rated';
let presetSaveFailure = true;
const presetFiles = new Map([['Forest Preset', {prompts:[],prompt_order:[],original:true}]]);
const server = http.createServer((req,res) => {
 if(req.url==='/') return res.end(`<html><body style="background:#222;color:#eee"><div id="preset-toolbar"><button id="import_oai_preset">Import preset file</button><button id="export_oai_preset">Export preset file</button></div><select id="settings_preset_openai"><option value="0">Forest Preset</option></select><div id="rm_characters_block"><div id="rm_button_bar"><div id="rm_buttons_container"></div></div></div><script>window.chars=[];window.failImport=false;window.connection={custom_url:'https://keep.example',openai_model:'keep-model'};window.SillyTavern={getContext:()=>({characters:window.chars})};</script><link rel="stylesheet" href="${prefix}style.css"><script type="module" src="${prefix}index.js"></script></body></html>`);
 if(req.url==='/api/settings/get'||req.url==='/api/presets/save') {
  let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
   res.setHeader('Content-Type','application/json');const request=JSON.parse(body);
   if(req.url==='/api/presets/save') {
    if(presetSaveFailure){res.statusCode=503;return res.end('{}');}
    presetFiles.set(request.name,request.preset);return res.end(JSON.stringify({name:request.name}));
   }
   return res.end(JSON.stringify({openai_setting_names:[...presetFiles.keys()],openai_settings:[...presetFiles.values()].map(value=>JSON.stringify(value))}));
  });return;
 }
 if(req.url.startsWith('/api/plugins/nemo-plotlight/stats/')) {
  res.setHeader('Content-Type','application/json');
  if(statsState==='unavailable'){res.statusCode=503;return res.end(JSON.stringify({error:'Temporarily unavailable'}));}
  return res.end(JSON.stringify({ratingAverage:statsState==='unrated'?0:4.2,ratingCount:statsState==='unrated'?0:12,rosesTotal:statsState==='unrated'?0:97}));
 }
 res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
 if(req.url==='/script.js') return res.end("export async function processDroppedFiles(files) {window.received=files[0].name;if(!window.failImport)window.chars.push({avatar:\"imported.png\"});} export function saveSettingsDebounced(){window.saved=true;} export const event_types={OAI_PRESET_IMPORT_READY:'preset-import-ready'};export const eventSource={emit:async(type,payload)=>{window.presetHook=type;payload.data.custom_url='https://hook.example';}};export const getRequestHeaders=()=>({'Content-Type':'application/json'});");
 if(req.url==='/scripts/extensions.js') return res.end("export const extension_settings = window.extSettings={};");
 if(req.url==='/scripts/openai.js') return res.end("export const settingsToUpdate={custom_url:[null,null,null,true],openai_model:[null,null,null,true],reverse_proxy:[null,null,null,true],temperature:[null,null,null,false]};");
 if(req.url==='/scripts/utils.js') return res.end("export async function getSanitizedFilename(name){return name;}");
 if(req.url==='/scripts/preset-manager.js') return res.end(`export function getPresetManager(){return {getAllPresets:()=>[...document.querySelector('#settings_preset_openai').options].map(o=>o.text),savePreset:async(name,preset)=>{const r=await fetch('/api/presets/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,preset,apiId:'openai'})});if(!r.ok)throw Error('Preset could not be saved');const o=new Option(name,String(document.querySelector('#settings_preset_openai').options.length),true,true);document.querySelector('#settings_preset_openai').append(o);for(const k of ['custom_url','openai_model'])if(k in preset)window.connection[k]=preset[k];}};}`);
 const file = req.url.startsWith(prefix) ? root + req.url.slice(prefix.length) : '';
 if(file && fs.existsSync(file)) return res.end(fs.readFileSync(file));
 res.statusCode=404;res.end();
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.NPL_CHROMIUM_PATH || undefined,args:['--no-sandbox']});
 try {
 const page=await browser.newPage({viewport:{width:1280,height:950}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const id='11111111-1111-4111-8111-111111111111';
 const presetId='22222222-2222-4222-8222-222222222222';
 const presetData={name:'Forest Preset',temperature:0.7,prompts:[{identifier:'story',role:'system',content:'Preserve my prompt.'}],prompt_order:[{character_id:100001,order:[{identifier:'story',enabled:true}]}],extensions:{example:{value:'kept'}},custom_url:'https://remove.example',openai_model:'remove-model'};
 const preset={id:presetId,type:'presets',name:'Forest Preset',creator:{name:'Preset Creator'},description:'A cinematic preset.',tags:[{name:'Cinematic',slug:'style-cinematic',category:'style'}],detail_url:`/discovery/presets/${presetId}`,downloads:{legacy:`/api/v1/content/presets/${presetId}/download?format=legacy`}};
 const card={id,name:'Forest Mage',creator:{name:'A Creator'},description:'<img src=x onerror="window.pwned=true"> A forest guardian.',tags:[{name:'Fantasy',slug:'genre-fantasy',category:'genre'}],downloads:{png:`/api/v1/content/cards/${id}?format=png`},detail_url:`/discovery/characters/${id}`};
 let searches=[];
 await page.route('https://plotlightstudios.com/**',async route=>{
  const u=new URL(route.request().url());
  const headers={'access-control-allow-origin':'*'};
  if(u.pathname.includes(presetId))return route.fulfill({json:presetData,headers});
  if(u.searchParams.get('type')==='presets'){searches.push(u.search);return route.fulfill({json:{data:u.pathname.includes('/tags')?preset.tags:[preset],pagination:{next_offset:null}},headers});}
  if(u.pathname.includes('/tags')) return route.fulfill({json:{data:[{name:'Fantasy',slug:'genre-fantasy',category:'genre'}],pagination:{next_offset:null}},headers});
  if(u.pathname.includes(id)) return route.fulfill({body:Buffer.from([137,80,78,71,13,10,26,10,0]),contentType:'image/png',headers});
  searches.push(u.search);
  const offset=Number(u.searchParams.get('offset'));
  return route.fulfill({json:{data:offset===24?[]:[card],pagination:{next_offset:offset===0?24:offset===24?48:null}},headers});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Browse Plotlight cards'}).click();
 await page.getByRole('heading',{name:'Forest Mage'}).waitFor();
 await page.getByRole('img',{name:'Average rating 4.2 out of 5 from 12 ratings; 97 roses (Plotlight community stars)',exact:true}).waitFor();
 assert.equal(await page.locator('.npl-rating-average').textContent(),'4.2');
 assert.equal(await page.locator('.npl-roses').textContent(),'97');
 assert(Math.abs(await page.locator('.npl-star').nth(4).evaluate(n=>parseFloat(n.style.getPropertyValue('--npl-star-fill')))-20)<0.001);
 const ratingSlider=page.getByRole('slider',{name:'Minimum rating',exact:true});
 assert.equal(await ratingSlider.getAttribute('min'),'0');assert.equal(await ratingSlider.getAttribute('max'),'5');
 assert(!searches.at(-1).includes('min_rating'));
 let ratingRequest=page.waitForResponse(r=>r.url().includes('/api/v1/content?')&&new URL(r.url()).searchParams.get('min_rating')==='5');
 await ratingSlider.focus();await ratingSlider.press('End');await ratingRequest;
 assert.equal(await page.locator('.npl-rating-value').textContent(),'5.0 / 5 or higher');
 ratingRequest=page.waitForResponse(r=>r.url().includes('/api/v1/content?')&&!new URL(r.url()).searchParams.has('min_rating'));
 await ratingSlider.press('Home');await ratingRequest;
 assert.equal(await page.locator('.npl-rating-value').textContent(),'Any rating');
 await page.locator('.npl-card').hover();
 assert.equal(await page.locator('.npl-star').nth(0).evaluate(n=>getComputedStyle(n).animationName),'npl-star-dance');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.npl-star').nth(0).evaluate(n=>getComputedStyle(n).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});

 await page.getByText('Description & tags').click();
 assert.equal(await page.evaluate(()=>window.pwned),undefined);
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByText('No visible cards on this page. Try Next.').waitFor();
 assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'Previous',exact:true}).click();
 await page.getByRole('heading',{name:'Forest Mage'}).waitFor();
 await page.getByText('Include / exclude tags').click();
 await page.getByRole('button',{name:'Include',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.npl-status').textContent.includes('1 cards'));
 assert(searches.at(-1).includes('tags=genre-fantasy'));
 await page.evaluate(()=>window.failImport=true);
 await page.getByRole('button',{name:'Import card',exact:true}).click();
 await page.getByText(/Import could not be confirmed/).waitFor();
 assert.equal(await page.evaluate(()=>window.saved),undefined);
 await page.evaluate(()=>window.failImport=false);
 await page.getByRole('button',{name:'Retry import',exact:true}).click();
 await page.getByText('Imported into your character list.').waitFor();
 assert.equal(await page.evaluate(()=>window.saved),true);
 assert.equal(await page.getByRole('button',{name:'Imported',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'Browse Plotlight cards'}).click();
 await page.getByRole('button',{name:'Imported',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Imported',exact:true}).isDisabled(),true);
 await page.setViewportSize({width:390,height:844});

 assert.equal(await page.evaluate(()=>document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth),true);
 await page.setViewportSize({width:1280,height:950});

 statsState='unrated';
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Browse Plotlight cards'}).click();
 await page.getByRole('img',{name:'Not yet rated; 0 roses (Plotlight community stars)',exact:true}).waitFor();
 assert.equal(await page.locator('.npl-rating-average').textContent(),'—');assert.equal(await page.locator('.npl-roses').textContent(),'0');
 statsState='unavailable';
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Browse Plotlight cards'}).click();
 await page.getByRole('img',{name:'Rating and roses temporarily unavailable',exact:true}).waitFor();
 assert.equal(await page.locator('.npl-rating-average').textContent(),'—');assert.equal(await page.locator('.npl-roses').textContent(),'—');
 await page.getByRole('button',{name:'Close',exact:true}).click();
 assert.equal(await page.locator('#export_oai_preset').evaluate(n=>n.nextElementSibling.id),'nemo_plotlight_presets');
 assert.equal(await page.locator('#nemo_plotlight_presets').count(),1);
 await page.getByRole('button',{name:'Browse Plotlight presets',exact:true}).click();
 await page.getByRole('heading',{name:'Browse presets',exact:true}).waitFor();
 await page.getByRole('heading',{name:'Forest Preset',exact:true}).waitFor();
 assert.equal(await page.getByRole('slider',{name:'Minimum rating',exact:true}).count(),0);
 assert.equal(await page.locator('.npl-card-stats').count(),0);
 assert(new URLSearchParams(searches.at(-1)).get('type')==='presets');
 assert(!new URLSearchParams(searches.at(-1)).has('min_rating'));
 await page.locator('.npl-search select').selectOption('models');
 let presetFilterRequest=page.waitForResponse(r=>new URL(r.url()).searchParams.get('min_roses')==='4');
 await page.getByLabel('Minimum roses',{exact:true}).fill('4');await page.getByLabel('Minimum roses',{exact:true}).press('Tab');await presetFilterRequest;
 await page.getByText('Include / exclude tags',{exact:true}).click();const presetTagRequest=page.waitForResponse(r=>new URL(r.url()).searchParams.get('tags')==='style-cinematic');await page.getByRole('button',{name:'Include',exact:true}).click();await presetTagRequest;
 await page.getByRole('button',{name:'Import preset',exact:true}).click();await page.getByText('Preset could not be saved',{exact:true}).waitFor();
 assert.equal(await page.evaluate(id=>window.extSettings.NemoPlotlight.presetImports[id],presetId),undefined);
 presetSaveFailure=false;
 await page.getByRole('button',{name:'Retry import',exact:true}).click();await page.getByText('Imported into Chat Completion presets.',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Imported',exact:true}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>document.querySelector('#settings_preset_openai').selectedOptions[0].text),'Forest Preset (Plotlight 2)');
 assert.deepEqual(await page.evaluate(()=>window.connection),{custom_url:'https://keep.example',openai_model:'keep-model'});
 assert.equal(await page.evaluate(()=>window.presetHook),'preset-import-ready');
 assert(presetFiles.get('Forest Preset').original);
 assert.deepEqual(presetFiles.get('Forest Preset (Plotlight 2)').prompts,presetData.prompts);
 assert.deepEqual(presetFiles.get('Forest Preset (Plotlight 2)').prompt_order,presetData.prompt_order);
 assert.deepEqual(presetFiles.get('Forest Preset (Plotlight 2)').extensions,presetData.extensions);
 assert.equal(presetFiles.get('Forest Preset (Plotlight 2)').custom_url,undefined);
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Browse Plotlight presets',exact:true}).click();
 await page.getByRole('button',{name:'Imported',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Imported',exact:true}).isDisabled(),true);
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth));
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.evaluate(()=>{const container=document.querySelector('#preset-toolbar');container.replaceChildren();const exportButton=document.createElement('button');exportButton.id='export_oai_preset';exportButton.textContent='Export preset file';container.append(exportButton);});
 await page.getByRole('button',{name:'Browse Plotlight presets',exact:true}).waitFor();assert.equal(await page.locator('#nemo_plotlight_presets').count(),1);
 assert.deepEqual(errors,[]);
 console.log('PASS: UI search, tag filters, empty-page pagination, text safety, failed/successful import, duplicate protection, reopening, mobile overflow, rating slider, fractional stars, roses, unavailable/unrated states reduced motion, preset search/filter/import, native hooks, collision protection, connection preservation, duplicate history and toolbar remount.');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
