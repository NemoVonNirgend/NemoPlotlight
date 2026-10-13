import { personaDefinition, portraitUrl, boundedBlob } from './api.js';

export function getPersonaAvatarIds() {
    const settings = globalThis.SillyTavern?.getContext?.()?.powerUserSettings;
    return Object.keys(settings?.personas ?? {});
}

async function nativeTools() {
    const [personas, script, power, utils] = await Promise.all([
        import('../../../personas.js'), import('../../../../script.js'), import('../../../power-user.js'), import('../../../utils.js'),
    ]);
    return {
        initPersona: personas.initPersona,
        getUserAvatars: personas.getUserAvatars,
        setUserAvatar: personas.setUserAvatar,
        userAvatar: () => personas.user_avatar,
        powerUser: power.power_user,
        saveSettings: script.saveSettings,
        getRequestHeaders: script.getRequestHeaders,
        defaultAvatar: script.default_user_avatar,
        uuidv4: utils.uuidv4,
    };
}

function imageType(bytes) {
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    if (String.fromCharCode(...bytes.slice(0, 3)) === 'GIF') return 'image/gif';
    throw new Error('The persona portrait is not a supported image.');
}

export async function importPersona(file, {
    imageUrl, tools, fetchImpl = globalThis.fetch.bind(globalThis),
    makeAvatarKey,
} = {}) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error('The persona download is not valid JSON.'); }
    const definition = personaDefinition(data);
    const native = tools ?? await nativeTools();
    const currentAvatar = native.userAvatar();
    const requestHeaders = () => native.getRequestHeaders();
    async function post(path, body) {
        const response = await fetchImpl(path, { method: 'POST', headers: requestHeaders(), body: JSON.stringify(body) });
        if (!response.ok) throw new Error('Could not verify the persona in SillyTavern.');
        return response.json();
    }
    const avatars = await post('/api/avatars/get', {});
    if (!Array.isArray(avatars) || avatars.some(value => typeof value !== 'string')) throw new Error('SillyTavern returned an invalid avatar list.');
    const existing = new Set([...avatars, ...Object.keys(native.powerUser.personas ?? {})]);
    let avatar;
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = makeAvatarKey ? makeAvatarKey() : `plotlight-persona-${native.uuidv4 ? native.uuidv4() : crypto.randomUUID()}.png`;
        if (!/^plotlight-persona-[0-9a-f-]{36}\.png$/i.test(candidate)) throw new Error('Invalid generated persona avatar name.');
        if (!existing.has(candidate)) { avatar = candidate; break; }
    }
    if (!avatar) throw new Error('Could not choose an unused persona avatar name.');

    async function portrait(url, remote) {
        const response = await fetchImpl(url, {
            credentials: remote ? 'omit' : 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error('Persona portrait is unavailable.');
        const blob = await boundedBlob(response, 'Persona avatar');
        const type = imageType(new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
        return new File([blob], 'avatar.png', { type });
    }
    let image, usedDefaultAvatar = false;
    const sourceImage = file.nplImageUrl || definition.imageUrl || imageUrl;
    if (sourceImage) {
        try {
            const source = portraitUrl(sourceImage);
            image = await portrait(source, !source.startsWith('/api/plugins/nemo-plotlight/image/'));
        }
        catch { usedDefaultAvatar = true; }
    }
    if (!image) { image = await portrait(native.defaultAvatar, false); usedDefaultAvatar = true; }
    const form = new FormData();
    form.append('avatar', image); form.append('overwrite_name', avatar);
    const uploaded = await fetchImpl('/api/avatars/upload', {
        method: 'POST', headers: native.getRequestHeaders({ omitContentType: true }), body: form,
    });
    if (!uploaded.ok || (await uploaded.json()).path !== avatar) throw new Error('Persona avatar upload could not be confirmed.');
    try {
        // Import into the library; the active persona and chat locks stay as they are.
        await native.initPersona(avatar, definition.name, definition.description, definition.title, { silent: true });
        await native.saveSettings();
        const response = await post('/api/settings/get', { lazyPresets: true });
        const saved = typeof response.settings === 'string' ? JSON.parse(response.settings) : response.settings;
        const descriptor = saved?.power_user?.persona_descriptions?.[avatar];
        if (saved?.power_user?.personas?.[avatar] !== definition.name || descriptor?.description !== definition.description
            || descriptor?.title !== definition.title || saved.user_avatar !== currentAvatar || native.userAvatar() !== currentAvatar) {
            throw new Error('Persona import could not be confirmed. Check Persona Management before retrying.');
        }
        await native.getUserAvatars(true, avatar);
        if (native.userAvatar() !== currentAvatar) throw new Error('The active persona changed during import. The import was rolled back.');
    } catch (error) {
        delete native.powerUser.personas[avatar];
        delete native.powerUser.persona_descriptions[avatar];
        if (native.userAvatar() !== currentAvatar && native.setUserAvatar) {
            try { await native.setUserAvatar(currentAvatar, { navigateToCurrent: false }); } catch { /* Preserve other data if the native UI cannot be refreshed. */ }
        }
        try { await native.saveSettings(); } catch { /* A failed connection may require cleanup in Persona Management. */ }
        try { await post('/api/avatars/delete', { avatar }); } catch { /* Remove only this newly uploaded avatar if the server can be reached. */ }
        throw error;
    }
    return { avatar, usedDefaultAvatar, source: file.nplSource || 'export', linkedLorebookOmitted: Boolean(file.nplLinkedLorebookOmitted) };
}
