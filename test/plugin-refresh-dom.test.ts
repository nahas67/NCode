import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';
const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiber = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let dom: JSDOM;
afterEach(() => dom?.window.close());
const tool = { name: 'read', description: 'Read an exact file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
function page() {
  dom = new JSDOM('<section role="tabpanel" aria-labelledby="einstellungen-erweiterungen"><h2>NCode Core</h2><button id="schema">Schema kopieren</button><footer><button id="refresh">Aktualisieren</button></footer></section>', { runScripts: 'outside-only', url: 'https://chatgpt.com/#settings/Plugins/plugin_asdk_app_synthetic' });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const props = { connector: { id: 'asdk_app_synthetic', name: 'NCode Core', app_metadata: { version_id: 'asdk_app_v_synthetic' }, owners: ['never-copy'] },
    actions: [{ name: tool.name, description: tool.description, description_model: null, params: tool.inputSchema }], isLoadingActions: false };
  (win.document.getElementById('schema') as any).__reactFiber$fixture = { memoizedProps: props };
  (win.document.getElementById('refresh') as any).__reactFiber$fixture = { memoizedProps: { details: [{ title: 'App-Kennung', value: props.connector.id }], reportEntity: { id: props.connector.id, entityType: 'connector' }, headerTrailingContent: {} } };
  win.eval(fiber); win.eval(source);
  return { api: (win as any).CLF_DOM, props };
}
it('reads localized installed declarations and the unique native refresh action from provider state', async () => {
  const { api } = page(); const view = await api.pluginRefreshView('NCode Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.textContent).toBe('Aktualisieren'); expect(view).not.toHaveProperty('success');
});
it('does not substitute expected declarations for changed provider descriptions', async () => {
  const { api, props } = page(); props.actions[0]!.description = 'Changed declaration.';
  expect((await api.pluginRefreshView('NCode Core', [tool])).tools[0].description).toBe('Changed declaration.');
  props.actions.push(props.actions[0]!);
  expect(await api.pluginRefreshView('NCode Core')).toBeNull();
});
it('uses an enrolled App ID through renames, but refuses mismatched IDs and loading schemas', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  expect(await api.pluginRefreshView('NCode Core')).toBeNull();
  expect(await api.pluginRefreshView('NCode Core', [], 'asdk_app_synthetic')).not.toBeNull();
  expect(await api.pluginRefreshView('NCode Core', [], 'asdk_app_other')).toBeNull();
  props.isLoadingActions = true;
  expect(await api.pluginRefreshView('Renamed')).toBeNull();
});
it('rejects oversized or cyclic schemas before projecting them to the isolated world', async () => {
  const { api, props } = page();
  const schema = { type: 'object', description: 'x'.repeat(300000) };
  props.actions[0]!.params = schema as any;
  expect(await api.pluginRefreshView('NCode Core')).toBeNull();
  props.actions[0]!.params = { type: 'object', properties: {} } as any;
  (props.actions[0]!.params as any).properties.self = props.actions[0]!.params;
  expect(await api.pluginRefreshView('NCode Core')).toBeNull();
});
it.each([118, 257])('accepts %s declarations for the Plugins connector including its optional code-mode tool', async (count) => {
  const { api, props } = page();
  props.connector.name = 'NCode Plugins';
  props.actions = Array.from({ length: count }, (_, i) => ({ name: i === 256 ? 'exec' : `plugin_tool_${i}`, description: `Plugin tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  const view = await api.pluginRefreshView('NCode Plugins');
  expect(view?.tools).toHaveLength(count);
});
it('reads a Plugins catalog that fits the publication budget even with long schemas', async () => {
  // Measured 2026-10-01: Unity's 82 tools are ~116 KB of JSON, well within the 250,000-byte
  // publication budget, but the page reader's worst-case accounting (3 per character) came to
  // 287,483 against 280,000, so every Plugins refresh failed with an unreadable settings card.
  const { api, props } = page();
  props.connector.name = 'NCode Plugins';
  props.actions = Array.from({ length: 82 }, (_, i) => ({ name: `manage_tool_${i}`, description: `Tool ${i}. ${'Detailed usage notes. '.repeat(40)}`, description_model: null,
    params: { type: 'object', properties: { action: { type: 'string', description: 'What to do. '.repeat(25) }, target: { type: 'string' } }, required: ['action'] } })) as any;
  expect(JSON.stringify(props.actions).length).toBeGreaterThan(100_000);
  expect(JSON.stringify(props.actions).length).toBeLessThan(250_000);
  const view = await api.pluginRefreshView('NCode Plugins');
  expect(view?.tools).toHaveLength(82);
});
it.each([['NCode Plugins', 258], ['NCode Core', 17]] as const)('retains the %s observation count guard', async (connector, count) => {
  const { api, props } = page();
  props.connector.name = connector;
  props.actions = Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  expect(await api.pluginRefreshView(connector)).toBeNull();
});
it('refuses ambiguous native actions and never copies unrelated connector properties', async () => {
  const { api } = page(); const messages: unknown[] = [];
  dom.window.addEventListener('message', event => { if (event.data?.source === 'clf-plugin-reply') messages.push(event.data); });
  await api.pluginRefreshView('NCode Core'); expect(JSON.stringify(messages)).not.toContain('never-copy');
  const button = dom.window.document.getElementById('refresh')!;
  const copy = button.cloneNode(true) as any; copy.__reactFiber$fixture = (button as any).__reactFiber$fixture; button.after(copy);
  expect(await api.pluginRefreshView('NCode Core')).toBeNull();
});
it('discovers exact installed rows across languages and preserves ambiguity', () => {
  const { api } = page(); const panel = dom.window.document.querySelector('section')!;
  panel.setAttribute('aria-labelledby', 'settings-trigger-Erweiterungen');
  panel.innerHTML = '<a href="/plugins">Plugins durchsuchen</a>';
  expect(api.pluginInstalledButtons('NCode Core')).toBeNull();
  panel.insertAdjacentHTML('beforeend', '<button><span data-testid="plugin-icon-wrapper"></span><div>NCode Core</div><span>Alle zulassen</span></button>');
  expect(api.pluginInstalledButtons('NCode Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('NCode Desktop')).toEqual([]);
  panel.insertAdjacentHTML('beforeend', panel.querySelector('button')!.outerHTML);
  expect(api.pluginInstalledButtons('NCode Core')).toHaveLength(2);
});

it('observes an exact installed card without a refresh action through the real Fiber bridge', async () => {
  const { api } = page();
  const refresh = dom.window.document.getElementById('refresh') as any;
  const card = { ...refresh.__reactFiber$fixture.memoizedProps, headerTrailingContent: null };
  (dom.window.document.getElementById('schema') as any).__reactFiber$fixture.return = { memoizedProps: card };
  refresh.remove();
  expect(await api.pluginRefreshView('NCode Core', [tool])).toMatchObject({ appId: 'asdk_app_synthetic', tools: [tool], refresh: null });
  delete (dom.window.document.getElementById('schema') as any).__reactFiber$fixture.return;
  expect(await api.pluginRefreshView('NCode Core', [tool])).toBeNull();
});

// The newer shell: a full page at /settings/plugins-settings/plugin_<app>, the connector (with
// its `actions`) a few Fibers above each management button, and only Refresh's wrapper loading.
function settingsPage(path = '/settings/plugins-settings/plugin_asdk_app_synthetic') {
  dom = new JSDOM('<main><h1>NCode Core</h1><button id="edit">Bearbeiten</button><button id="refresh">Tools aktualisieren</button><button id="delete">App löschen</button></main>', { runScripts: 'outside-only', url: `https://chatgpt.com${path}` });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const connector = { id: 'asdk_app_synthetic', name: 'NCode Core', tunnel_id: 'tunnel_synthetic01' as unknown, app_metadata: { version_id: 'asdk_app_v_synthetic' }, owners: ['never-copy'],
    actions: [{ name: tool.name, description: tool.description, description_model: '' as string | null, params: tool.inputSchema }] };
  const owner = { memoizedProps: { connector, link: {}, plugin: {} } };
  const chain = (wrapper: object) => ({ memoizedProps: { children: 'x' }, return: { memoizedProps: wrapper, return: { memoizedProps: { className: 'row' }, return: owner } } });
  const set = (id: string, wrapper: object) => { (win.document.getElementById(id) as any).__reactFiber$fixture = chain(wrapper); };
  set('edit', { color: 'secondary', onClick() {} });
  set('refresh', { color: 'secondary', loading: false, onClick() {} });
  set('delete', { color: 'danger', disabled: false, onClick() {} });
  win.eval(fiber); win.eval(source);
  return { api: (win as any).CLF_DOM, connector, set };
}
it.each(['/settings/plugins-settings/plugin_asdk_app_synthetic', '/plugins/plugin_asdk_app_synthetic'])('reads the plugin page at %s and only its Refresh tools control', async (path) => {
  const { api } = settingsPage(path);
  const view = await api.pluginRefreshView('NCode Core', [tool]);
  expect(view).toMatchObject({ appId: 'asdk_app_synthetic', versionId: 'asdk_app_v_synthetic', tools: [tool] });
  expect(view.refresh.id).toBe('refresh');
  expect(dom.window.document.querySelectorAll('[data-clf-plugin-refresh]')).toHaveLength(1);
});
it('never offers a destructive control as the page refresh, and refuses an ambiguous one', async () => {
  const { api, set } = settingsPage();
  set('refresh', { color: 'secondary', onClick() {} }); set('delete', { color: 'danger', loading: false, onClick() {} });
  set('edit', { color: 'ghost', loading: false, 'aria-haspopup': 'menu' });
  expect((await api.pluginRefreshView('NCode Core', [tool]))?.refresh).toBeNull();
  expect(dom.window.document.querySelector('[data-clf-plugin-refresh]')).toBeNull();
  set('refresh', { loading: false }); set('edit', { loading: false });
  expect(await api.pluginRefreshView('NCode Core', [tool])).toBeNull();
});
it('refuses the plugin page when the route and connector disagree', async () => {
  const { api, connector } = settingsPage();
  connector.id = 'asdk_app_other';
  expect(await api.pluginRefreshView('NCode Core', [tool])).toBeNull();
  dom.window.close(); settingsPage('/settings/plugins-settings/plugin_asdk_app_synthetic');
  dom.window.history.replaceState(null, '', '/settings/plugins-settings/plugin_asdk_app_synthetic#settings/Plugins');
  expect(await (dom.window as any).CLF_DOM.pluginRefreshView('NCode Core', [tool])).toBeNull();
});
it('finds installed rows on the plugins settings page', () => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<button><div><span>NCode Core</span></div><span>Custom</span></button><button><span>NCode Desktop</span></button>';
  const api = (dom.window as any).CLF_DOM;
  expect(api.pluginInstalledButtons('NCode Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('NCode')).toBeNull();
});
it('discovers native installed links by their exact connector name across languages', () => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<h1>プラグイン</h1><a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>NCode Core</span><span>説明</span></a><span>すべてを許可</span>';
  const api = (dom.window as any).CLF_DOM;
  expect(api.pluginInstalledButtons('NCode Core')).toEqual([main.querySelector('a')]);
  expect(api.pluginInstalledButtons('NCode')).toBeNull();
  main.insertAdjacentHTML('beforeend', '<a href="/settings/plugins-settings/plugin_asdk_app_other"><span>NCode Core</span></a>');
  expect(api.pluginInstalledButtons('NCode Core')).toHaveLength(2);
});
it('ignores hidden, catalog, external and unrelated links when discovering installed connectors', () => {
  settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = [
    '<a hidden href="/settings/plugins-settings/plugin_asdk_app_hidden"><span>NCode Core</span></a>',
    '<a href="/plugins/plugin_asdk_app_catalog"><span>NCode Core</span></a>',
    '<a href="https://example.com/settings/plugins-settings/plugin_asdk_app_external"><span>NCode Core</span></a>',
    '<a href="/settings/plugins-settings/plugin_connector_unrelated"><span>NCode Core</span></a>',
    '<section data-testid="conversation-turn-1"><a href="/settings/plugins-settings/plugin_asdk_app_quoted"><span>NCode Core</span></a></section>',
    '<div class="clf-stage"><a href="/settings/plugins-settings/plugin_asdk_app_own"><span>NCode Core</span></a></div>',
  ].join('');
  dom.window.document.body.insertAdjacentHTML('beforeend', '<a href="/settings/plugins-settings/plugin_asdk_app_outside"><span>NCode Core</span></a>');
  expect((dom.window as any).CLF_DOM.pluginInstalledButtons('NCode Core')).toBeNull();
});
it('reads the page description when the model description is empty, and prefers a set one', async () => {
  const { api, connector } = settingsPage();
  expect((await api.pluginRefreshView('NCode Core', [tool])).tools[0].description).toBe(tool.description);
  connector.actions[0]!.description_model = 'Model-facing declaration.';
  expect((await api.pluginRefreshView('NCode Core', [tool])).tools[0].description).toBe('Model-facing declaration.');
});
it('reports the page connector tunnel and a settled empty Plugins list', async () => {
  const { api, connector } = settingsPage();
  expect(await api.pluginRefreshView('NCode Core', [tool])).toMatchObject({ tunnelId: 'tunnel_synthetic01', settled: true });
  connector.tunnel_id = { toString: () => 'tunnel_x' };
  expect((await api.pluginRefreshView('NCode Core', [tool])).tunnelId).toBeNull();
  connector.name = 'NCode Plugins'; connector.actions = [];
  expect(await api.pluginRefreshView('NCode Plugins')).toMatchObject({ tools: [], settled: true });
});
it.each([
  ['NCode Plugins (Windows)', 257, true],
  ['NCode Core (Windows)', 17, false],
  ['NCode Plugins Backup', 17, false]
] as const)('applies the Plugins connector\'s limits to %s by its kind, whatever the computer', async (connector, count, accepted) => {
  // One ChatGPT account on two computers: this computer's Plugins connector carries its suffix
  // and still holds every enabled external plugin's tools.
  const { api, props } = page();
  props.connector.name = connector;
  props.actions = Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  const view = await api.pluginRefreshView(connector);
  if (accepted) expect(view?.tools).toHaveLength(count);
  else expect(view).toBeNull();
});
// A connector renamed in ChatGPT keeps its app id (2026-10-11). With the app's proven ids, refresh
// finds it by that id and its current name; a same-named app with another id stays foreign.
it('refreshes a renamed connector by its proven app id', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'Renamed' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('NCode Core', [tool])).toMatchObject({ appId: 'asdk_app_synthetic', connectorName: 'Renamed' });
});
it('refuses a same-named app once another app id is proven for that connector', async () => {
  const { api } = page();
  api.setConnectorApps({ core: [{ appId: 'asdk_app_other', linkId: null, name: 'NCode Core' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('NCode Core', [tool])).toBeNull();
});
it.each(['legacy', 'native'])('retains proven identity when the request itself uses the renamed name (%s)', async route => {
  const fixture = route === 'native' ? settingsPage() : page();
  const connector = 'connector' in fixture ? fixture.connector : fixture.props.connector;
  const api = fixture.api; connector.name = 'Renamed';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_other', name: 'Renamed' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('Renamed', [tool])).toBeNull();
  // A legitimately recreated connector becomes usable when its own ID is proven.
  api.setConnectorApps({ core: [{ appId: 'asdk_app_other', name: 'Renamed' },
    { appId: 'asdk_app_synthetic', name: 'Renamed' }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView('Renamed', [tool])).toMatchObject({ appId: 'asdk_app_synthetic' });
});
it('refuses a name shared by different proven surfaces rather than guessing one', async () => {
  const { api, props } = page(); props.connector.name = 'Renamed';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'Renamed' }],
    desktop: [{ appId: 'asdk_app_desktop', name: 'Renamed' }], plugins: [] });
  expect(await api.pluginRefreshView('Renamed', [tool])).toBeNull();
  expect(api.pluginInstalledButtons('Renamed')).toBeNull();
  expect(await api.pluginRefreshView('Renamed', [tool], 'asdk_app_synthetic')).toMatchObject({ appId: 'asdk_app_synthetic' });
  expect(await api.pluginRefreshView('Renamed', [tool], 'asdk_app_desktop')).toBeNull();
  props.connector.name = 'NCode Desktop';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: props.connector.name }], desktop: [], plugins: [] });
  expect(await api.pluginRefreshView(props.connector.name, [tool])).toBeNull();
});
it('retains the Plugins declaration budget after a proven rename', async () => {
  const { api, connector } = settingsPage(); connector.name = 'Renamed Plugins';
  connector.actions = Array.from({ length: 118 }, (_, i) => ({ name: `plugin_tool_${i}`, description: `Tool ${i}`,
    description_model: '', params: tool.inputSchema }));
  api.setConnectorApps({ core: [], desktop: [], plugins: [{ appId: connector.id, name: connector.name }] });
  expect((await api.pluginRefreshView(connector.name)).tools).toHaveLength(118);
  connector.name = 'NCode Core';
  api.setConnectorApps({ core: [], desktop: [], plugins: [{ appId: connector.id, name: connector.name }] });
  expect(await api.pluginRefreshView(connector.name)).toBeNull();
  expect((await api.pluginRefreshView(connector.name, [], connector.id)).tools).toHaveLength(118);
});
it('finds a renamed connector\'s installed row by its proven current name', () => {
  const { api } = page(); const panel = dom.window.document.querySelector('section')!;
  panel.setAttribute('aria-labelledby', 'settings-trigger-Erweiterungen');
  panel.innerHTML = '<a href="/plugins">Plugins durchsuchen</a><button><span data-testid="plugin-icon-wrapper"></span><div>Renamed</div></button>';
  expect(api.pluginInstalledButtons('NCode Core')).toEqual([]);
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'Renamed' }], desktop: [], plugins: [] });
  expect(api.pluginInstalledButtons('NCode Core')).toHaveLength(1);
  expect(api.pluginInstalledButtons('NCode Desktop')).toEqual([]);
});
it('finds renamed native installed links by proven identity while retaining visibility, route and ambiguity checks', () => {
  const { api } = settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>Renamed</span></a>' +
    '<a hidden href="/settings/plugins-settings/plugin_asdk_app_hidden"><span>Renamed</span></a>' +
    '<a href="/plugins/plugin_asdk_app_catalog"><span>Renamed</span></a>' +
    '<a href="https://example.com/settings/plugins-settings/plugin_asdk_app_external"><span>Renamed</span></a>';
  expect(api.pluginInstalledButtons('NCode Core')).toBeNull();
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'Renamed' }], desktop: [], plugins: [] });
  expect(api.pluginInstalledButtons('NCode Core')).toEqual([main.querySelector('a')]);
  expect(api.pluginInstalledButtons('NCode Desktop')).toBeNull();
  main.insertAdjacentHTML('beforeend', '<a href="/settings/plugins-settings/plugin_asdk_app_other"><span>Renamed</span></a>');
  expect(api.pluginInstalledButtons('NCode Core')).toEqual([main.querySelector('a')]); // A same-named foreign ID is not this connector.
  main.insertAdjacentHTML('beforeend', main.querySelector('a')!.outerHTML);
  expect(api.pluginInstalledButtons('NCode Core')).toHaveLength(2);
});
function renamedNativeList() {
  const { api } = settingsPage('/settings/plugins-settings');
  const main = dom.window.document.querySelector('main')!;
  main.innerHTML = '<a href="/settings/plugins-settings/plugin_asdk_app_synthetic"><span>My renamed connector 日本語</span></a>';
  api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'NCode Core' }], desktop: [], plugins: [] });
  return { api, main, link: main.querySelector('a')! };
}
it('finds an arbitrarily renamed native installed app even while its proven name remains old', () => {
  const { api, main, link } = renamedNativeList();
  main.insertAdjacentHTML('beforeend', '<a href="/settings/plugins-settings/plugin_asdk_app_foreign"><span>NCode Core</span></a>');
  expect(api.connectorApps()[0].name).toBe('NCode Core');
  expect(api.pluginInstalledButtons('NCode Core')).toEqual([link]);
});
it.each(['external', 'catalog', 'hash', 'wrong-id', 'hidden', 'detached', 'replacement-foreign', 'outside', 'quoted', 'own-surface'])(
  'keeps proven native link selection closed when the row is %s', mode => {
    const { api, main, link } = renamedNativeList();
    if (mode === 'external') link.href = 'https://example.com/settings/plugins-settings/plugin_asdk_app_synthetic';
    if (mode === 'catalog') link.href = '/plugins/plugin_asdk_app_synthetic';
    if (mode === 'hash') link.href += '#unowned';
    if (mode === 'wrong-id') { link.href = '/settings/plugins-settings/plugin_asdk_app_foreign'; link.querySelector('span')!.textContent = 'NCode Core'; }
    if (mode === 'hidden') link.hidden = true;
    if (mode === 'detached') link.remove();
    if (mode === 'replacement-foreign') {
      const other = link.cloneNode(true) as HTMLAnchorElement;
      other.href = '/settings/plugins-settings/plugin_asdk_app_foreign'; other.querySelector('span')!.textContent = 'NCode Core'; link.replaceWith(other);
    }
    if (mode === 'outside') dom.window.document.body.append(link);
    if (mode === 'quoted' || mode === 'own-surface') {
      const host = dom.window.document.createElement('section');
      if (mode === 'quoted') host.dataset.testid = 'conversation-turn-1';
      else host.className = 'clf-stage';
      main.append(host); host.append(link);
    }
    expect(api.pluginInstalledButtons('NCode Core')).toBeNull();
  }
);
it.each(['duplicate-id', 'multiple-core-ids'])('preserves ambiguity among proven native rows (%s)', mode => {
  const { api, main, link } = renamedNativeList();
  const other = link.cloneNode(true) as HTMLAnchorElement;
  if (mode === 'multiple-core-ids') {
    other.href = '/settings/plugins-settings/plugin_asdk_app_other'; other.textContent = 'Another renamed connector';
    api.setConnectorApps({ core: [{ appId: 'asdk_app_synthetic', name: 'NCode Core' },
      { appId: 'asdk_app_other', name: 'Older known name' }], desktop: [], plugins: [] });
  }
  main.append(other);
  expect(api.pluginInstalledButtons('NCode Core')).toEqual([link, other]); // The workflow must refuse length !== 1.
});
it('does not use unproven IDs or an unknown request name to discover a renamed native app', () => {
  const { api, link } = renamedNativeList();
  api.setConnectorApps({ core: [], desktop: [], plugins: [] });
  expect(api.pluginInstalledButtons('NCode Core')).toBeNull();
  link.querySelector('span')!.textContent = 'Unknown connector';
  expect(api.pluginInstalledButtons('Unknown connector')).toBeNull();
});
it('keeps the Plugins connector\'s larger catalog limit after a rename, by its proven app id', async () => {
  const { api, props } = page();
  props.connector.name = 'My external apps';
  props.actions = Array.from({ length: 118 }, (_, i) => ({ name: `plugin_tool_${i}`, description: `Plugin tool ${i}`, description_model: null,
    params: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }));
  api.setConnectorApps({ core: [], desktop: [], plugins: [{ appId: 'asdk_app_synthetic', linkId: null, name: 'My external apps' }] });
  expect((await api.pluginRefreshView('NCode Plugins'))?.tools).toHaveLength(118);
});
