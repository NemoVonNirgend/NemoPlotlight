import { validateLorebook } from './api.js';

export function getLorebookNames() {
    return [...(document.querySelector('#world_editor_select')?.options ?? [])]
        .filter(option => option.value !== '')
        .map(option => option.text);
}

async function nativeTools() {
    const [worldInfo, script, utils] = await Promise.all([
        import('../../../world-info.js'), import('../../../../script.js'), import('../../../utils.js'),
    ]);
    return {
        importWorldInfo: worldInfo.importWorldInfo,
        updateWorldInfoList: worldInfo.updateWorldInfoList,
        getCachedSettingsPayload: script.getCachedSettingsPayload,
        getRequestHeaders: script.getRequestHeaders,
        sanitizeFilename: utils.getSanitizedFilename,
    };
}

function comparable(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

export async function importLorebook(file, { tools, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error('The lorebook download is not valid JSON.'); }
    validateLorebook(data);
    const native = tools ?? await nativeTools();
    const expectedEntries = comparable(data.entries);

    async function request(path, body) {
        const response = await fetchImpl(path, {
            method: 'POST', headers: native.getRequestHeaders(), body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('Could not verify the lorebook on disk. Check the lorebook list before retrying.');
        return response.json();
    }

    async function readNames() {
        const list = await request('/api/worldinfo/list', {});
        if (!Array.isArray(list) || list.some(item => typeof item?.file_id !== 'string' || !item.file_id.trim())) {
            throw new Error('SillyTavern returned an invalid lorebook list.');
        }
        return list.map(item => item.file_id);
    }

    function syncCachedNames(names) {
        // Native refresh otherwise reuses its boot payload for up to a minute.
        const cached = native.getCachedSettingsPayload?.();
        if (cached) cached.world_names = names;
    }

    const diskNames = await readNames();
    const normalize = name => name.normalize('NFC').toLowerCase();
    const existing = new Set([...diskNames, ...(typeof document === 'undefined' ? [] : getLorebookNames())].map(normalize));
    let base = await native.sanitizeFilename(Array.from(file.name.replace(/\.(json|lorebook)$/i, '')).slice(0, 100).join(''));
    base = base || 'Plotlight lorebook';
    let name = base, suffix = 2;
    while (existing.has(normalize(name))) {
        name = `${base} (Plotlight ${suffix++})`;
        if (suffix > 1000) throw new Error('Could not choose an unused lorebook name.');
    }

    // Preserve the original bytes and all native/extension options.
    const renamedFile = new File([file], `${name}.json`, { type: 'application/json' });
    syncCachedNames(diskNames);
    await native.importWorldInfo(renamedFile);
    const savedNames = await readNames();
    syncCachedNames(savedNames);
    if (!savedNames.includes(name)) throw new Error('Lorebook import could not be confirmed in the lorebook list.');
    await native.updateWorldInfoList();
    const saved = await request('/api/worldinfo/get', { name });
    validateLorebook(saved);
    if (comparable(saved.entries) !== expectedEntries) {
        throw new Error('Lorebook import could not be confirmed. The saved entries differ from the download.');
    }
    return name;
}
