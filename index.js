import { processDroppedFiles, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { PlotlightClient, MODES, SORTS, publicUrl, portraitUrl, importAndVerify, fetchCardStats, PRESET_MODES, LOREBOOK_MODES, PERSONA_MODES } from './api.js';
import { getPresetNames, importPreset } from './presets.js';
import { getLorebookNames, importLorebook } from './lorebooks.js';
import { getPersonaAvatarIds, importPersona } from './personas.js';

const client = new PlotlightClient();
const settings = extension_settings.NemoPlotlight ??= { imports: {} };
settings.imports ??= {};
settings.presetImports ??= {};
settings.lorebookImports ??= {};
settings.personaImports ??= {};
const context = () => SillyTavern.getContext();
const libraries = {
    cards: { label: 'Characters', noun: 'cards', singular: 'card', modes: MODES, history: 'imports',
        placeholder: 'Find a character, creator, or theme…', intro: 'Discover your next character. Bring their portrait and story into SillyTavern.',
        formats: [['png', 'PNG · V2 (recommended)'], ['png3', 'PNG · V3'], ['json', 'JSON · V2 (no portrait)'], ['json3', 'JSON · V3 (no portrait)']] },
    presets: { label: 'Presets', noun: 'presets', singular: 'preset', modes: PRESET_MODES, history: 'presetImports', download: 'downloadPreset',
        placeholder: 'Find a preset, creator, style, or model…', intro: 'Discover your next prompt preset. Import it into Chat Completion presets.', formats: [['legacy', 'SillyTavern preset JSON']] },
    lorebooks: { label: 'Lorebooks', noun: 'lorebooks', singular: 'lorebook', modes: LOREBOOK_MODES, history: 'lorebookImports', download: 'downloadLorebook',
        placeholder: 'Find a lorebook, creator, genre, or type…', intro: 'Discover lorebooks and import their entries into World Info.', formats: [['st', 'SillyTavern lorebook JSON']] },
    personas: { label: 'Personas', noun: 'personas', singular: 'persona', modes: PERSONA_MODES, history: 'personaImports', download: 'downloadPersona',
        placeholder: 'Find a persona or creator…', intro: 'Import public persona definitions, then choose them from Persona Management.', formats: [['json', 'Persona definition']] },
};

let activeDialog;
let importBusy = false;

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function button(text, handler) {
    const node = el('button', text, 'menu_button');
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}
function select(values) {
    const node = el('select', null, 'text_pole');
    for (const [value, label] of values) {
        const option = el('option', label);
        option.value = value;
        node.append(option);
    }
    return node;
}
function field(label, input) {
    const node = el('label', null, 'npl-field');
    node.append(el('span', label), input);
    return node;
}
function input(type = 'text') {
    const node = el('input', null, 'text_pole');
    node.type = type;
    return node;
}
function sourceLink(item) {
    try {
        const node = el('a', 'View on Plotlight ↗', 'npl-source');
        node.href = publicUrl(item.detail_url).href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
        return node;
    } catch { return el('span'); }
}
function knownImport(item, type = 'cards') {
    const record = settings[libraries[type].history][item.id];
    if (!record) return null;
    if (type === 'presets') return getPresetNames().includes(record.name) ? record : null;
    if (type === 'lorebooks') return getLorebookNames().includes(record.name) ? record : null;
    if (type === 'personas') return getPersonaAvatarIds().includes(record.avatar) ? record : null;
    return context().characters.some(c => c.avatar === record.avatar) ? record : null;
}

function openBrowser(type = 'cards') {
    const library = libraries[type];
    if (!library) return;
    const isCards = type === 'cards', isPresets = type === 'presets', isLorebooks = type === 'lorebooks';
    const noun = library.noun;
    if (activeDialog) return activeDialog.focus();
    const dialog = el('dialog', null, 'npl-dialog');
    activeDialog = dialog;
    dialog.setAttribute('aria-labelledby', 'npl-title');
    const header = el('header', null, 'npl-header');
    const title = el('h2', 'Nemo Plotlight');
    title.id = 'npl-title';
    const close = button('Close', () => dialog.close());
    const brand = el('div', null, 'npl-brand');
    const mark = el('span', 'PL', 'npl-brand-mark');
    mark.setAttribute('aria-hidden', 'true');
    const heading = el('div', null, 'npl-heading');
    heading.append(title, el('span', 'DISCOVERY', 'npl-eyebrow'));
    brand.append(mark, heading);
    const headerActions = el('div', null, 'npl-header-actions');
    headerActions.append(el('span', library.label, 'npl-category'), close);
    header.append(brand, headerActions);
    const intro = el('p', library.intro, 'npl-muted npl-intro');
    const form = el('form', null, 'npl-search');
    const query = input();
    query.placeholder = library.placeholder;
    query.maxLength = 200;
    const mode = select(library.modes.map(v => [v, v[0].toUpperCase() + v.slice(1)]));
    const sort = select((isCards || isPresets ? SORTS : ['recent', 'popular']).map(v => [v, v[0].toUpperCase() + v.slice(1)]));
    const format = select(library.formats);
    format.disabled = !isCards;
    const rating = input('range');
    rating.id = 'npl-min-rating';
    rating.setAttribute('aria-label', 'Minimum rating');
    rating.min = '0'; rating.max = '5'; rating.step = '0.1'; rating.value = '0';
    const ratingField = field('Minimum rating', rating);
    ratingField.classList.add('npl-rating-field');
    const ratingValue = el('output', 'Any rating', 'npl-rating-value');
    ratingValue.htmlFor = rating.id;
    rating.setAttribute('aria-valuetext', 'Any rating');
    ratingField.append(ratingValue);
    rating.addEventListener('input', () => {
        const value = Number(rating.value);
        const label = value === 0 ? 'Any rating' : `${value.toFixed(1)} / 5 or higher`;
        ratingValue.textContent = label;
        rating.setAttribute('aria-valuetext', label);
    });
    const vn = input('checkbox');
    const submit = button('Search', () => {});
    submit.type = 'submit';
    submit.classList.add('npl-primary');
    form.append(field('Search', query), field('Search by', mode), submit);
    const filters = el('div', null, 'npl-filters');
    const vnField = field('Visual-novel data only', vn);
    vnField.classList.add('npl-checkbox-field');
    const minRoses = input('number'), minFavorites = input('number');
    for (const node of [minRoses, minFavorites]) {
        node.min = '0'; node.max = '1000000'; node.step = '1'; node.placeholder = 'Any';
    }
    const compendium = input('checkbox');
    const compendiumField = field('Compendium data only', compendium);
    compendiumField.classList.add('npl-checkbox-field');
    filters.append(field('Sort by', sort));
    if (isCards) filters.append(ratingField, vnField);
    else {
        if (isPresets || isLorebooks) filters.append(field('Minimum roses', minRoses));
        filters.append(field('Minimum favorites', minFavorites));
        if (isLorebooks) filters.append(compendiumField);
    }
    filters.append(field('Import format', format));

    const tagsPanel = el('details', null, 'npl-tag-panel');
    tagsPanel.append(el('summary', 'Include / exclude tags'));
    const selectedTags = new Map();
    const selected = el('div', null, 'npl-selected-tags');
    const tagSearch = input();
    tagSearch.placeholder = 'Filter loaded tag names or categories…';
    tagSearch.setAttribute('aria-label', 'Filter loaded tags');
    const tagList = el('div', null, 'npl-tag-list');
    const tagStatus = el('p', '', 'npl-muted');
    const catalog = new Map();
    let tagOffset = 0, tagsLoading = false, tagController;
    const moreTags = button('Load tags', loadTags);
    tagsPanel.append(el('p', 'Require every included tag; reject any excluded tag. Up to 10 of each. Tag labels follow public guest visibility.'), selected, tagSearch, tagList, tagStatus, moreTags);

    const status = el('p', '', 'npl-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const grid = el('div', null, 'npl-grid');
    const footer = el('footer', null, 'npl-footer');
    const previous = button('Previous', () => searchPage(offsetHistory.at(-1), 'back'));
    const next = button('Next', () => searchPage(nextOffset, 'forward'));
    const pageLabel = el('span');
    footer.append(previous, pageLabel, next);
    const layout = el('div', null, 'npl-layout');
    const sidebar = el('details', null, 'npl-sidebar');
    sidebar.setAttribute('aria-label', `${library.label} filters`);
    const filterBreakpoint = window.matchMedia('(min-width: 601px)');
    const syncFilterLayout = () => { sidebar.open = filterBreakpoint.matches; };
    syncFilterLayout();
    filterBreakpoint.addEventListener('change', syncFilterLayout);
    sidebar.append(el('summary', 'Filters', 'npl-sidebar-title'), filters, tagsPanel);
    const results = el('section', null, 'npl-results');
    results.setAttribute('aria-label', `${library.label} discovery`);
    const resultsHeading = el('div', null, 'npl-results-heading');
    resultsHeading.append(el('h3', `Browse ${type === 'cards' ? 'characters' : noun}`), el('span', 'PUBLIC CATALOG', 'npl-eyebrow'));
    results.append(form, intro, resultsHeading, status, grid, footer);
    layout.append(sidebar, results);
    const tabs = el('nav', null, 'npl-content-tabs');
    tabs.setAttribute('aria-label', 'Plotlight libraries');
    for (const [nextType, config] of Object.entries(libraries)) {
        const tab = button(config.label, () => {
            if (importBusy || type === nextType) return;
            dialog.addEventListener('close', () => openBrowser(nextType), { once: true });
            dialog.close();
        });
        tab.setAttribute('aria-pressed', String(type === nextType));
        tabs.append(tab);
    }
    dialog.append(header, tabs, layout);
    document.body.append(dialog);
    let statsController = new AbortController();
    const statsTasks = new WeakMap();
    const statsObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            statsObserver.unobserve(entry.target);
            void statsTasks.get(entry.target)?.();
        }
    }, { rootMargin: '80px' });
    function clearStats() {
        statsController.abort();
        statsController = new AbortController();
        statsObserver.disconnect();
    }

    let controller, revision = 0, debounce;
    let currentOffset = 0, nextOffset = null, offsetHistory = [], loading = false;
    let currentFilters = {};

    function readFilters() {
        return {
            q: query.value, mode: mode.value, sort: sort.value,
            ...(isCards ? { minRating: Number(rating.value) === 0 ? '' : rating.value, hasVn: vn.checked } : {
                minFavorites: minFavorites.value,
                ...(isPresets || isLorebooks ? { minRoses: minRoses.value } : {}),
                ...(isLorebooks ? { hasCompendium: compendium.checked } : {}),
            }),
            tags: [...selectedTags].filter(([, v]) => v.state === 'include').map(([slug]) => slug),
            excludeTags: [...selectedTags].filter(([, v]) => v.state === 'exclude').map(([slug]) => slug),
        };
    }
    function navigation() {
        previous.disabled = loading || !offsetHistory.length;
        next.disabled = loading || nextOffset === null;
        pageLabel.textContent = `Page ${offsetHistory.length + 1}`;
        grid.setAttribute('aria-busy', String(loading));
    }
    function resetSearch() {
        clearTimeout(debounce);
        if (!form.reportValidity() || !(isCards ? rating.reportValidity() : minFavorites.reportValidity() && (!(isPresets || isLorebooks) || minRoses.reportValidity()))) return;
        currentFilters = readFilters();
        offsetHistory = [];
        nextOffset = null;
        currentOffset = 0;
        clearStats();
        grid.replaceChildren();
        void searchPage(0, 'reset');
    }
    function scheduleSearch() {
        // Invalidate the previous request as soon as the query changes.
        controller?.abort();
        revision++;
        loading = true;
        nextOffset = null;
        clearStats();
        grid.replaceChildren();
        navigation();
        clearTimeout(debounce);
        debounce = setTimeout(resetSearch, 450);
    }
    async function searchPage(offset, direction) {
        if (offset == null) return;
        clearTimeout(debounce);
        controller?.abort();
        controller = new AbortController();
        const request = ++revision;
        loading = true;
        navigation();
        status.textContent = 'Searching Plotlight…';
        try {
            const page = await client.search(currentFilters, offset, controller.signal, type);
            if (request !== revision || !dialog.open) return;
            if (direction === 'forward') offsetHistory.push(currentOffset);
            if (direction === 'back') offsetHistory.pop();
            currentOffset = offset;
            nextOffset = page.nextOffset;
            clearStats();
            grid.replaceChildren();
            const seen = new Set();
            for (const item of page.items) {
                if (!item?.id || seen.has(item.id)) continue;
                seen.add(item.id);
                grid.append(renderCard(item));
            }
            status.textContent = seen.size ? `${seen.size} ${noun} on this page.` : (nextOffset !== null ? `No visible ${noun} on this page. Try Next.` : `No ${noun} match these filters.`);
        } catch (error) {
            if (request === revision && !controller.signal.aborted) status.textContent = error.message || 'Could not connect to Plotlight. Please retry.';
        } finally {
            if (request === revision) { loading = false; navigation(); }
        }
    }
    function renderSelected() {
        selected.replaceChildren();
        for (const [slug, value] of selectedTags) {
            const chip = button(`${value.state === 'include' ? '+' : '−'} ${value.tag.name} ×`, () => {
                selectedTags.delete(slug); renderSelected(); renderTags(); resetSearch();
            });
            chip.dataset.state = value.state;
            chip.setAttribute('aria-label', `Remove ${value.state} tag ${value.tag.name}`);
            selected.append(chip);
        }
    }
    function chooseTag(tag, state) {
        const existing = selectedTags.get(tag.slug);
        if (existing?.state === state) selectedTags.delete(tag.slug);
        else {
            const count = [...selectedTags.values()].filter(v => v.state === state).length;
            if (count >= 10) { tagStatus.textContent = 'You can select up to 10 tags per filter.'; return; }
            selectedTags.set(tag.slug, { tag, state });
        }
        renderSelected(); renderTags(); resetSearch();
    }
    function renderTags() {
        tagList.replaceChildren();
        const term = tagSearch.value.trim().toLowerCase();
        for (const tag of catalog.values()) {
            if (!`${tag.name} ${tag.category}`.toLowerCase().includes(term)) continue;
            const row = el('div', null, 'npl-tag-row');
            const include = button('Include', () => chooseTag(tag, 'include'));
            const exclude = button('Exclude', () => chooseTag(tag, 'exclude'));
            include.setAttribute('aria-pressed', String(selectedTags.get(tag.slug)?.state === 'include'));
            exclude.setAttribute('aria-pressed', String(selectedTags.get(tag.slug)?.state === 'exclude'));
            row.append(el('span', `${tag.name} · ${tag.category || 'tag'}`), include, exclude);
            tagList.append(row);
        }
    }
    async function loadTags() {
        if (tagsLoading || tagOffset === null) return;
        tagsLoading = true; moreTags.disabled = true;
        tagController = new AbortController();
        tagStatus.textContent = 'Loading tags…';
        try {
            const page = await client.tags(tagOffset, tagController.signal, type);
            for (const tag of page.items) if (typeof tag?.slug === 'string') catalog.set(tag.slug, tag);
            tagOffset = page.nextOffset;
            renderTags();
            tagStatus.textContent = `${catalog.size} tag labels loaded${tagOffset !== null ? ' — load more to see additional tags.' : '.'}`;
            moreTags.textContent = tagOffset === null ? 'All tags loaded' : 'Load more tags';
        } catch (error) { if (!tagController.signal.aborted) tagStatus.textContent = error.message; }
        finally { tagsLoading = false; moreTags.disabled = tagOffset === null; }
    }
    function renderCard(item) {
        const card = el('article', null, `npl-card${isCards ? '' : ` npl-${library.singular}-card`}`);
        const portrait = el('div', isCards ? 'No preview' : isPresets ? 'Prompt preset' : library.label, `npl-portrait${isCards ? '' : ' npl-library-placeholder'}`);
        if (item.image_url) {
            try {
                const img = el('img');
                // The helper handles fixed Plotlight thumbnails; other hosts remain anonymous.
                img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
                img.src = portraitUrl(item.image_url);
                img.alt = String(item.name || 'Card portrait'); img.loading = 'lazy';
                img.addEventListener('error', () => {
                    const message = img.src.includes('/api/plugins/nemo-plotlight/image/')
                        ? 'Preview unavailable. Check the Nemo Plotlight server helper installation.' : 'Preview unavailable';
                    portrait.replaceChildren(el('span', message));
                }, { once: true });
                portrait.replaceChildren(img);
            } catch { /* Keep placeholder for invalid URLs. */ }
        }
        const body = el('div', null, 'npl-card-body');
        const name = el('h3', item.name || 'Untitled card');
        name.title = name.textContent;
        body.append(name, el('p', `By ${item.creator?.name || item.creator?.username || 'Unknown creator'}`, 'npl-muted npl-creator'));
        if (isCards) {
            const stats = el('div', null, 'npl-card-stats');
            stats.setAttribute('role', 'img');
            stats.setAttribute('aria-label', 'Loading card rating and roses');
            stats.setAttribute('aria-busy', 'true');
            const stars = el('span', null, 'npl-stars');
            stars.setAttribute('aria-hidden', 'true');
            for (let i = 0; i < 5; i++) {
                const star = el('span', '★', 'npl-star');
                star.style.setProperty('--npl-star-index', String(i));
                star.append(el('span', '★', 'npl-star-fill'));
                stars.append(star);
            }
            const average = el('span', '—', 'npl-rating-average');
            const roses = el('span', null, 'npl-roses');
            const rose = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            rose.setAttribute('viewBox', '0 0 24 24');
            rose.setAttribute('aria-hidden', 'true');
            const rosePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            rosePath.setAttribute('d', 'M12 13c-5 0-7-4-6-7 2-1 4 0 6 2 2-2 4-3 6-2 1 3-1 7-6 7Zm0-5c-3-1-4-4-2-6 2-1 4 0 5 2M12 13v9m0-4c-4 0-6-2-6-4 3 0 5 1 6 4m0-1c4 0 6-2 6-4-3 0-5 1-6 4');
            rose.append(rosePath);
            const roseCount = el('span', '—');
            roses.append(rose, roseCount);
            stats.append(stars, average, roses);
            body.append(stats);
            statsTasks.set(card, async () => {
                const signal = statsController.signal;
                try {
                    const values = await fetchCardStats(item.id, { signal });
                    if (signal.aborted) return;
                    const count = Number.isSafeInteger(values.ratingCount) && values.ratingCount >= 0 ? values.ratingCount : null;
                    const value = count !== 0 && Number.isFinite(values.ratingAverage) && values.ratingAverage >= 0 && values.ratingAverage <= 5 ? values.ratingAverage : null;
                    const total = Number.isSafeInteger(values.rosesTotal) && values.rosesTotal >= 0 ? values.rosesTotal : null;
                    average.textContent = value === null ? '—' : value.toFixed(1);
                    roseCount.textContent = total === null ? '—' : total.toLocaleString();
                    stars.dataset.perfect = String(value === 5);
                    [...stars.children].forEach((star, i) => star.style.setProperty('--npl-star-fill', `${Math.max(0, Math.min(1, (value ?? 0) - i)) * 100}%`));
                    const ratingLabel = count === 0 ? 'Not yet rated' : value === null ? 'Rating unavailable' : `Average rating ${value.toFixed(1)} out of 5${count === null ? '' : ` from ${count} rating${count === 1 ? '' : 's'}`}`;
                    const roseLabel = total === null ? 'Roses unavailable' : `${total.toLocaleString()} roses (Plotlight community stars)`;
                    stats.setAttribute('aria-label', `${ratingLabel}; ${roseLabel}`);
                    stars.title = average.title = ratingLabel;
                    roses.title = roseLabel;
                } catch (error) {
                    if (signal.aborted) return;
                    stats.setAttribute('aria-label', 'Rating and roses temporarily unavailable');
                    stats.title = error.message || 'Card statistics are temporarily unavailable.';
                } finally {
                    if (!signal.aborted) stats.setAttribute('aria-busy', 'false');
                }
            });
            statsObserver.observe(card);
        }
        if (Array.isArray(item.tags)) {
            const tags = el('div', null, 'npl-card-tags');
            for (const tag of item.tags.slice(0, 3)) {
                const label = tag?.name || tag?.slug;
                if (label) tags.append(el('span', label, 'npl-card-tag'));
            }
            if (tags.childElementCount) body.append(tags);
        }
        const preview = el('details', null, 'npl-card-details');
        preview.append(el('summary', 'Description & tags'), el('p', item.description || 'No description provided.', 'npl-description'));
        if (Array.isArray(item.tags)) preview.append(el('p', item.tags.map(t => t?.name || t?.slug || '').filter(Boolean).join(' · '), 'npl-muted'));
        body.append(preview, sourceLink(item));
        const actionStatus = el('p', '', 'npl-action-status');
        actionStatus.setAttribute('role', 'status');
        const importButton = button(knownImport(item, type) ? 'Imported' : `Import ${library.singular}`, async () => {
            if (importBusy) return;
            if (knownImport(item, type)) { actionStatus.textContent = `This ${library.singular} is already in your library.`; return; }
            importBusy = true;
            close.disabled = true;
            tabs.querySelectorAll('button').forEach(node => { node.disabled = true; });
            dialog.querySelectorAll('.npl-import').forEach(b => { b.disabled = true; });
            importButton.textContent = 'Importing…';
            actionStatus.textContent = `Downloading ${library.singular}…`;
            try {
                const file = isCards ? await client.download(item, format.value) : await client[library.download](item);
                actionStatus.textContent = 'Importing into SillyTavern…';
                if (isPresets) {
                    const name = await importPreset(file);
                    settings.presetImports[item.id] = { name, importedAt: new Date().toISOString(), updatedAt: item.updated_at ?? null };
                } else if (isLorebooks) {
                    const name = await importLorebook(file);
                    settings.lorebookImports[item.id] = { name, importedAt: new Date().toISOString(), updatedAt: item.updated_at ?? null };
                } else if (!isCards) {
                    const result = await importPersona(file, { imageUrl: item.image_url });
                    settings.personaImports[item.id] = { ...result, importedAt: new Date().toISOString(), updatedAt: item.updated_at ?? null };
                } else {
                    const avatar = await importAndVerify(file, {
                        getCharacters: () => context().characters,
                        processFiles: processDroppedFiles,
                    });
                    settings.imports[item.id] = { avatar, importedAt: new Date().toISOString(), updatedAt: item.updated_at ?? null };
                }
                saveSettingsDebounced();
                if (isPresets) actionStatus.textContent = 'Imported into Chat Completion presets.';
                else if (isLorebooks) actionStatus.textContent = 'Imported into World Info.';
                else if (isCards) actionStatus.textContent = 'Imported into your character list.';
                else {
                    const record = settings.personaImports[item.id];
                    actionStatus.textContent = record.source === 'public-definition' ? 'Imported public definition into Persona Management.' : 'Imported into Persona Management.';
                    if (record.usedDefaultAvatar) actionStatus.textContent += ' Using the default avatar.';
                    if (record.linkedLorebookOmitted) actionStatus.textContent += ' Linked lorebooks can be imported separately.';
                }
            } catch (error) {
                actionStatus.textContent = error.message || 'Import failed. Please retry.';
            } finally {
                importBusy = false;
                close.disabled = false;
                tabs.querySelectorAll('button').forEach(node => { node.disabled = false; });
                dialog.querySelectorAll('.npl-import').forEach(b => { b.disabled = b.dataset.imported === 'true'; });
                importButton.textContent = knownImport(item, type) ? 'Imported' : 'Retry import';
                importButton.disabled = Boolean(knownImport(item, type));
                importButton.dataset.imported = String(Boolean(knownImport(item, type)));
            }
        });
        importButton.classList.add('npl-import');
        importButton.dataset.imported = String(Boolean(knownImport(item, type)));
        importButton.disabled = importBusy || Boolean(knownImport(item, type));
        body.append(importButton, actionStatus);
        card.append(portrait, body);
        return card;
    }
    tagsPanel.addEventListener('toggle', () => { if (tagsPanel.open && !catalog.size) void loadTags(); });
    tagSearch.addEventListener('input', renderTags);
    form.addEventListener('submit', event => { event.preventDefault(); resetSearch(); });
    query.addEventListener('input', scheduleSearch);
    [mode, sort, rating, vn, minRoses, minFavorites, compendium].forEach(node => node.addEventListener('change', resetSearch));
    dialog.addEventListener('cancel', event => { if (importBusy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
        clearTimeout(debounce); revision++;
        controller?.abort(); tagController?.abort();
        statsController.abort(); statsObserver.disconnect();
        filterBreakpoint.removeEventListener('change', syncFilterLayout);
        activeDialog = null; dialog.remove();
    }, { once: true });
    dialog.showModal();
    query.focus();
    resetSearch();
}

function mount() {
    const container = document.querySelector('#rm_buttons_container');
    if (container && !document.getElementById('nemo_plotlight_browse')) {
        const browse = button('', () => openBrowser());
        browse.id = 'nemo_plotlight_browse';
        browse.title = 'Browse Plotlight cards';
        browse.setAttribute('aria-label', 'Browse Plotlight cards');
        const icon = el('i', null, 'fa-solid fa-masks-theater');
        icon.setAttribute('aria-hidden', 'true');
        browse.append(icon);
        container.append(browse);
    }
    const entries = [
        ['export_oai_preset', 'nemo_plotlight_presets', 'presets'],
        ['world_popup_export', 'nemo_plotlight_lorebooks', 'lorebooks'],
        ['nemo-world-info-import-button', 'nemo_plotlight_lorebooks_enhanced', 'lorebooks'],
        ['personas_backup', 'nemo_plotlight_personas', 'personas'],
    ];
    for (const [anchorId, id, type] of entries) {
        const anchor = document.getElementById(anchorId);
        if (!anchor || document.getElementById(id)) continue;
        const browse = button('PL', () => openBrowser(type));
        browse.id = id;
        browse.classList.add('npl-toolbar-button');
        browse.title = `Browse Plotlight ${type}`;
        browse.setAttribute('aria-label', browse.title);
        anchor.after(browse);
    }
}
mount();
// Remount if ST or a UI extension rebuilds the native character toolbar.
const observer = new MutationObserver(mount);
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
