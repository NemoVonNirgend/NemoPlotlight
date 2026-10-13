import { validatePreset } from './api.js';

export function getPresetNames() {
    return [...(document.querySelector('#settings_preset_openai')?.options ?? [])].map(option => option.text);
}

async function nativeTools() {
    const [manager, openai, script, utils] = await Promise.all([
        import('../../../preset-manager.js'), import('../../../openai.js'),
        import('../../../../script.js'), import('../../../utils.js'),
    ]);
    return {
        getPresetManager: manager.getPresetManager,
        settingsToUpdate: openai.settingsToUpdate,
        eventSource: script.eventSource,
        eventTypes: script.event_types,
        getRequestHeaders: script.getRequestHeaders,
        sanitizeFilename: utils.getSanitizedFilename,
    };
}

export async function importPreset(file, { tools, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    const native = tools ?? await nativeTools();
    const manager = native.getPresetManager('openai');
    if (!manager) throw new Error('Chat Completion presets are not ready. Reload SillyTavern and try again.');
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error('The preset download is not valid JSON.'); }
    validatePreset(data);

    async function readSavedPresets() {
        const response = await fetchImpl('/api/settings/get', {
            method: 'POST', headers: native.getRequestHeaders(), body: JSON.stringify({ lazyPresets: false }),
        });
        if (!response.ok) throw new Error('Could not verify the saved preset. Check the preset list before retrying.');
        const result = await response.json();
        const names = result?.openai_setting_names, presets = result?.openai_settings;
        if (!Array.isArray(names) || !Array.isArray(presets) || names.length !== presets.length) {
            throw new Error('SillyTavern returned invalid preset data.');
        }
        const saved = new Map();
        for (let i = 0; i < names.length; i++) {
            if (typeof names[i] !== 'string' || !names[i].trim() || saved.has(names[i]) || typeof presets[i] !== 'string') {
                throw new Error('SillyTavern returned invalid preset data.');
            }
            let preset;
            try { preset = JSON.parse(presets[i]); }
            catch { throw new Error('SillyTavern returned invalid preset data.'); }
            if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
                throw new Error('SillyTavern returned invalid preset data.');
            }
            saved.set(names[i], preset);
        }
        return saved;
    }

    const sourceName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : file.name.replace(/\.json$/i, '');
    let base = await native.sanitizeFilename(Array.from(sourceName).slice(0, 100).join(''));
    base = base || 'Plotlight preset';
    if (['__proto__', 'constructor', 'prototype'].includes(base.toLowerCase())) base = `Plotlight ${base}`;
    const disk = await readSavedPresets();
    const existing = new Set([...manager.getAllPresets(), ...disk.keys()].map(name => name.normalize('NFC').toLowerCase()));
    let name = base, suffix = 2;
    while (existing.has(name.normalize('NFC').toLowerCase())) {
        name = `${base} (Plotlight ${suffix++})`;
        if (suffix > 1000) throw new Error('Could not choose an unused preset name.');
    }
    data.name = name;
    await native.eventSource.emit(native.eventTypes.OAI_PRESET_IMPORT_READY, { data, presetName: name });
    // Native selection can bind provider/model/endpoint fields; retain the user's existing connection.
    const connectionKeys = Object.entries(native.settingsToUpdate).filter(([, value]) => value[3]).map(([key]) => key);
    for (const key of connectionKeys) delete data[key];
    data.name = name;
    validatePreset(data);
    const expectedPrompts = JSON.stringify(data.prompts), expectedOrder = JSON.stringify(data.prompt_order);
    await manager.savePreset(name, data);
    if (!manager.getAllPresets().includes(name)) throw new Error('Preset import could not be confirmed in the preset list.');
    const saved = (await readSavedPresets()).get(name);
    if (!saved || JSON.stringify(saved.prompts) !== expectedPrompts || JSON.stringify(saved.prompt_order) !== expectedOrder
        || connectionKeys.some(key => Object.hasOwn(saved, key))) {
        throw new Error('Preset import could not be confirmed. Check the saved prompts and connection settings before retrying.');
    }
    return name;
}
