import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { TAG_PROMPT, DIRECTORY_PROMPT } from '../src/plugin/prompts.ts';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Exercise the bundled plugin with public-API host doubles, never the user's vault.
const output = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2021',
  write: false,
  alias: {
    'decode-named-character-reference': fileURLToPath(
      import.meta.resolve('decode-named-character-reference'),
    ),
  },
});
const code = output.outputFiles[0].text;
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function harness({
  autoMove = false,
  keepRefresh = false,
  collision = false,
  responseHook = null,
  storedData = null,
} = {}) {
  const notices = [],
    requests = [],
    timers = new Map(),
    events = new Map();
  let timerId = 0;
  const status = {
    text: '',
    title: '',
    setText(text) {
      this.text = text;
    },
  };
  class TFolder {
    constructor(path, parent) {
      this.path = path;
      this.name = path;
      this.parent = parent;
      this.children = [];
    }
  }
  class TFile {
    constructor(path, parent, source) {
      this.path = path;
      this.parent = parent;
      this.source = source;
      this.name = path.split('/').at(-1);
      this.extension = this.name.split('.').at(-1);
      this.basename = this.name.slice(0, -(this.extension.length + 1));
    }
  }
  class MarkdownView {}
  const root = new TFolder('', null);
  const ai = new TFolder('AI', root);
  const note = new TFile('Note.md', root, 'A note about language models.');
  root.children = [ai, note];
  const files = [note];
  const folders = [root, ai];
  if (collision) {
    const existing = new TFile('AI/Note.md', ai, 'Existing note');
    ai.children.push(existing);
    files.push(existing);
  }
  const emit = (name, ...args) => {
    for (const callback of events.get(name) ?? []) callback(...args);
  };
  const register = (name, callback) => {
    const list = events.get(name) ?? [];
    list.push(callback);
    events.set(name, list);
    return { name, callback };
  };
  const app = {
    vault: {
      getRoot: () => root,
      configDir: '.obsidian',
      getMarkdownFiles: () => files.filter((file) => file.extension.toLowerCase() === 'md'),
      getAllLoadedFiles: () => [...folders, ...files],
      getFileByPath: (path) => files.find((f) => f.path === path) ?? null,
      getFolderByPath: (path) => folders.find((folder) => folder.path === path) ?? null,
      createFolder: async (path) => {
        const parent = folders.find(
          (folder) => folder.path === path.split('/').slice(0, -1).join('/'),
        );
        assert.ok(parent);
        const folder = new TFolder(path, parent);
        folders.push(folder);
        parent.children.push(folder);
        return folder;
      },
      read: async (file) => file.source,
      process: async (file, fn) => {
        file.source = fn(file.source);
        emit('modify', file);
        return file.source;
      },
      on: register,
    },
    metadataCache: { getFileCache: () => ({ tags: [{ tag: '#llm' }, { tag: '#manual' }] }) },
    workspace: {
      onLayoutReady: (fn) => fn(),
      getActiveFile: () => note,
      getLeavesOfType: () => [],
    },
    fileManager: {
      renameFile: async (file, path) => {
        const old = file.path;
        assert.ok(
          !files.some((other) => other !== file && other.path.toLowerCase() === path.toLowerCase()),
        );
        file.parent.children = file.parent.children.filter((child) => child !== file);
        file.path = path;
        file.name = path.split('/').at(-1);
        file.parent = folders.find(
          (folder) => folder.path === path.split('/').slice(0, -1).join('/'),
        );
        assert.ok(file.parent);
        file.parent.children.push(file);
        emit('rename', file, old);
      },
    },
  };
  class Plugin {
    constructor() {
      this.app = app;
      this.commands = [];
      this.saved = null;
      this.refs = [];
    }
    async loadData() {
      if (storedData) return storedData;
      return {
        settingsVersion: 1,
        settings: { model: 'local', autoMove, keepRefresh, reasoning: 'none' },
        managedTags: {},
      };
    }
    async saveData(data) {
      this.saved = JSON.parse(JSON.stringify(data));
    }
    addSettingTab(tab) {
      this.settingTab = tab;
    }
    addCommand(command) {
      this.commands.push(command);
    }
    addStatusBarItem() {
      return status;
    }
    registerEvent(ref) {
      this.refs.push(ref);
    }
  }
  class PluginSettingTab {
    refreshDomState() {}
    update() {}
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  }
  const obsidian = {
    Plugin,
    TFile,
    TFolder,
    MarkdownView,
    PluginSettingTab,
    Modal: class {},
    Setting: class {},
    Notice: class {
      constructor(text) {
        notices.push(text);
      }
    },
    getAllTags: (cache) => cache.tags.map((t) => t.tag),
    requestUrl: async (request) => {
      const body = JSON.parse(request.body);
      requests.push(body);
      if (responseHook) await responseHook({ app, note, emit, body });
      const result =
        body.response_format.json_schema.name === 'tagged_tags'
          ? {
              tags: [
                { tag: 'llm', relevance: 'high' },
                { tag: 'manual', relevance: 'low' },
              ],
            }
          : {
              directory: body.messages[1].content.includes('Connection test') ? null : 'AI',
              confidence: 'high',
            };
      return {
        status: 200,
        text: JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        }),
      };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.equal(name, 'obsidian');
      return obsidian;
    },
    window: {
      setTimeout: (fn, ms) => {
        const id = ++timerId;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
    console,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  });
  const plugin = new module.exports.default();
  await plugin.onload();
  const fireDebounce = async () => {
    const list = [...timers.entries()].filter(([, t]) => t.ms === 15000);
    for (const [id, { fn }] of list) {
      timers.delete(id);
      fn();
    }
    await settle();
  };
  const organize = () =>
    plugin.commands.find((c) => c.id === 'organize-current-note').checkCallback(false);
  return {
    plugin,
    status,
    app,
    note,
    files,
    emit,
    fireDebounce,
    requests,
    notices,
    organize,
    timers,
    ai,
    TFile,
    addFile: (path, source = 'binary image') => {
      const parent = folders.find(
        (folder) => folder.path === path.split('/').slice(0, -1).join('/'),
      );
      assert.ok(parent);
      const file = new TFile(path, parent, source);
      files.push(file);
      parent.children.push(file);
      return file;
    },
  };
}

test('bundled plugin waits 15 seconds, writes tags once, and ignores its own modify event', async () => {
  const h = await harness({ keepRefresh: true });
  h.emit('modify', h.note);
  h.emit('modify', h.note);
  assert.equal(h.requests.length, 0);
  await h.fireDebounce();
  assert.equal(h.requests.length, 1);
  assert.match(h.note.source, /tags:/);
  await h.fireDebounce();
  assert.equal(h.requests.length, 1);
  h.note.source += '\nA real user edit';
  h.emit('modify', h.note);
  await h.fireDebounce();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.plugin.saved.managedTags['Note.md'], ['llm']);
  h.plugin.onunload();
  assert.equal(h.timers.size, 0);
});

test('upgrade persists the new default without losing credentials or managed tags', async () => {
  const h = await harness({
    storedData: {
      settings: { model: 'local', reasoning: 'omit', apiKey: 'test-key', temperature: 0.4 },
      managedTags: { 'Note.md': ['manual'] },
    },
  });
  assert.equal(h.plugin.saved.settingsVersion, 1);
  assert.equal(h.plugin.saved.settings.reasoning, 'none');
  assert.equal(h.plugin.saved.settings.apiKey, 'test-key');
  assert.equal(h.plugin.saved.settings.temperature, 0.4);
  assert.deepEqual(h.plugin.saved.managedTags, { 'Note.md': ['manual'] });
  assert.equal(h.requests.length, 0);
  h.plugin.onunload();
});
test('bundled plugin moves after tags, follows ownership on rename and never overwrites a collision', async () => {
  const h = await harness({ autoMove: true });
  h.organize();
  await settle();
  assert.equal(h.note.path, 'AI/Note.md');
  assert.equal(h.requests.length, 2);
  assert.ok(JSON.parse(h.requests[1].messages[1].content).document.existing_tags.includes('llm'));
  assert.deepEqual(h.plugin.saved.managedTags['AI/Note.md'], ['llm']);
  assert.equal(h.plugin.saved.managedTags['Note.md'], undefined);
  h.plugin.onunload();
  const c = await harness({ autoMove: true, collision: true });
  c.organize();
  await settle();
  assert.equal(c.note.path, 'Note.md');
  assert.equal(c.files[1].source, 'Existing note');
  assert.ok(c.notices.some((n) => n.includes('already exists')));
  c.plugin.onunload();
});
test('bundled plugin rejects a stale note and ignores requests after cancellation', async () => {
  let changed = false;
  const h = await harness({
    responseHook: async ({ note, emit }) => {
      if (!changed) {
        changed = true;
        note.source = 'New user text';
        emit('modify', note);
      }
    },
  });
  h.organize();
  await settle();
  assert.equal(h.note.source, 'New user text');
  await h.fireDebounce();
  assert.match(h.note.source, /New user text/);
  h.plugin.onunload();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const c = await harness({ responseHook: () => gate });
  c.organize();
  await settle();
  c.plugin.cancel();
  release();
  await settle();
  assert.equal(c.note.source, 'A note about language models.');
  c.plugin.onunload();
});

test('bulk command processes nested notes without moving them and reports completion', async () => {
  const h = await harness({ autoMove: true });
  const nested = new h.TFile('AI/Nested.md', h.ai, 'A second note about language models.');
  h.files.push(nested);
  h.ai.children.push(nested);
  h.plugin.startBatch();
  await settle();
  assert.equal(h.requests.length, 3); // Two tag requests, only one root folder request.
  assert.equal(nested.path, 'AI/Nested.md');
  assert.match(nested.source, /tags:/);
  assert.ok(h.notices.some((n) => n.includes('finished 2 notes (0 errors)')));
  await h.fireDebounce();
  assert.equal(h.requests.length, 3);
  h.plugin.onunload();
});

test('settings changes invalidate active requests and clear scheduled edits', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness({ responseHook: () => gate });
  h.organize();
  await settle();
  h.emit('modify', h.note);
  await h.plugin.changeSettings({ ...h.plugin.settings, autoTags: false });
  release();
  await settle();
  await h.fireDebounce();
  assert.equal(h.note.source, 'A note about language models.');
  assert.equal(h.requests.length, 1);
  h.plugin.onunload();
  assert.equal(h.timers.size, 0);
});

test('atomic tag guard preserves edits made immediately before the host write', async () => {
  const h = await harness();
  const process = h.app.vault.process;
  h.app.vault.process = async (file, fn) => {
    file.source = 'An edit made just before committing tags.';
    return process(file, fn);
  };
  h.organize();
  await settle();
  assert.equal(h.note.source, 'An edit made just before committing tags.');
  assert.equal(h.plugin.saved, null);
  h.plugin.onunload();
});

test('keep refresh defaults off for old settings; commands still organize', async () => {
  const h = await harness({ storedData: { settingsVersion: 1, settings: { model: 'local' } } });
  assert.equal(h.plugin.settings.keepRefresh, false);
  assert.equal(h.plugin.settings.skipDailyNotes, true);
  assert.equal(h.plugin.settings.onlyUntagged, false);
  for (const event of ['create', 'modify', 'rename']) h.emit(event, h.note, 'Old.md');
  await h.fireDebounce();
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  h.organize();
  await settle();
  assert.equal(h.requests.length, 1);
  h.plugin.onunload();
});

test('turning keep refresh off clears automatic timers and rejects late writes', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness({ keepRefresh: true, responseHook: () => gate });
  h.emit('modify', h.note);
  await h.fireDebounce();
  h.emit('modify', h.note);
  await h.plugin.changeSettings({ ...h.plugin.settings, keepRefresh: false });
  release();
  await settle();
  await h.fireDebounce();
  assert.equal(h.requests.length, 1);
  assert.equal(h.note.source, 'A note about language models.');
  assert.equal(h.timers.size, 0);
  h.organize();
  await settle();
  assert.match(h.note.source, /tags:/);
  h.plugin.onunload();
});

test('manual retry after a concurrent edit works with keep refresh off', async () => {
  let changed = false;
  const h = await harness({
    responseHook: ({ note }) => {
      if (!changed) {
        changed = true;
        note.source = 'A new user edit';
      }
    },
  });
  h.organize();
  await settle();
  await h.fireDebounce();
  assert.equal(h.requests.length, 2);
  assert.match(h.note.source, /tags:/);
  assert.match(h.note.source, /A new user edit/);
  h.plugin.onunload();
});

test('conditional settings remain configurable for manual commands and retain hidden values', async () => {
  const h = await harness();
  const definitions = h.plugin.settingTab
    .getSettingDefinitions()
    .flatMap((item) => item.items ?? [item]);
  const setting = (key) => definitions.find((item) => item.control?.key === key);
  assert.equal(setting('delaySeconds').visible(), false);
  assert.equal(setting('skipDailyNotes').visible(), false);
  assert.equal(setting('onlyUntagged').visible(), true);
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    keepRefresh: true,
    autoMove: true,
    skipTags: 'journal',
    skipFilenameRegex: '^Draft',
    onlyUntagged: true,
  });
  assert.equal(setting('delaySeconds').visible(), true);
  assert.equal(setting('skipTags').visible(), true);
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    keepRefresh: false,
    autoMove: false,
    autoTags: false,
  });
  assert.equal(setting('delaySeconds').visible(), false);
  assert.equal(setting('skipFilenameRegex').visible(), false);
  assert.equal(setting('onlyUntagged').visible(), false);
  assert.equal(h.plugin.settings.skipTags, 'journal');
  assert.equal(h.plugin.settings.onlyUntagged, true);
  await assert.rejects(
    h.plugin.changeSettings({ ...h.plugin.settings, skipFilenameRegex: '^Valid\n[' }),
    /line 2/,
  );
  assert.equal(h.plugin.settings.skipFilenameRegex, '^Draft');
  assert.match(setting('skipFilenameRegex').control.validate('['), /line 1/);
  assert.match(setting('skipTags').control.validate('bad!'), /Invalid tag/);
  h.plugin.onunload();
});

test('batch commands respect daily filing exclusions with refresh disabled', async () => {
  const h = await harness({ autoMove: true });
  h.note.path = h.note.name = '2026-09-23.md';
  h.note.basename = '2026-09-23';
  h.plugin.startBatch();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.note.path, '2026-09-23.md');
  assert.match(h.note.source, /tags:/);
  assert.ok(h.notices.some((n) => n.includes('finished 1 notes (0 errors)')));
  h.plugin.onunload();
});

test('asset filing defaults off and obeys the parent switch', async () => {
  const h = await harness({ autoMove: true });
  const image = h.addFile('photo.JPG');
  assert.equal(h.plugin.settings.organizeAssets, false);
  assert.equal(h.plugin.settings.assetsFolder, 'Assets');
  h.plugin.startBatch();
  await settle();
  assert.equal(image.path, 'photo.JPG');
  await h.plugin.changeSettings({ ...h.plugin.settings, autoMove: false, organizeAssets: true });
  h.plugin.startBatch();
  await settle();
  assert.equal(image.path, 'photo.JPG');
  h.plugin.onunload();
});

test('asset batch creates nested folders without a model and skips conflicts and non-images', async () => {
  const h = await harness();
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    model: '',
    autoMove: true,
    organizeAssets: true,
    assetsFolder: 'Resources/Images',
  });
  await h.app.vault.createFolder('Resources');
  await h.app.vault.createFolder('Resources/Images');
  const existing = h.addFile('Resources/Images/photo.png', 'keep');
  const conflict = h.addFile('PHOTO.PNG');
  const nested = h.addFile('AI/nested.jpg');
  const pdf = h.addFile('book.pdf');
  const image = h.addFile('new.JpG');
  h.plugin.startBatch();
  await settle();
  assert.equal(image.path, 'Resources/Images/new.JpG');
  assert.equal(conflict.path, 'PHOTO.PNG');
  assert.equal(existing.source, 'keep');
  assert.equal(nested.path, 'AI/nested.jpg');
  assert.equal(pdf.path, 'book.pdf');
  assert.equal(h.requests.length, 0);
  assert.ok(h.notices.some((notice) => notice.includes('Assets moved: 1; conflicts skipped: 1')));
  await h.plugin.changeSettings({ ...h.plugin.settings, assetsFolder: 'New/Nested' });
  const fresh = h.addFile('fresh.webp');
  h.plugin.startBatch();
  await settle();
  assert.equal(fresh.path, 'New/Nested/fresh.webp');
  assert.ok(h.app.vault.getFolderByPath('New/Nested'));
  h.plugin.onunload();
});

test('automatic asset filing debounces only changed root images; current note never sweeps assets', async () => {
  const h = await harness({ autoMove: true });
  await h.plugin.changeSettings({ ...h.plugin.settings, organizeAssets: true });
  const first = h.addFile('first.png');
  const untouched = h.addFile('untouched.jpg');
  h.emit('create', first);
  await h.fireDebounce();
  assert.equal(first.path, 'first.png');
  h.organize();
  await settle();
  assert.equal(first.path, 'first.png');
  await h.plugin.changeSettings({ ...h.plugin.settings, keepRefresh: true, model: '' });
  h.emit('create', first);
  h.emit('modify', first);
  assert.equal(first.path, 'first.png');
  assert.equal([...h.timers.values()].filter((timer) => timer.ms === 15000).length, 1);
  await h.fireDebounce();
  assert.equal(first.path, 'Assets/first.png');
  assert.equal(untouched.path, 'untouched.jpg');
  assert.equal(h.timers.size, 0);
  h.emit('create', untouched);
  await h.plugin.changeSettings({ ...h.plugin.settings, keepRefresh: false });
  await h.fireDebounce();
  assert.equal(untouched.path, 'untouched.jpg');
  h.plugin.onunload();
});

test('cancel during assets folder creation prevents a late move', async () => {
  const h = await harness();
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    model: '',
    autoMove: true,
    organizeAssets: true,
  });
  const image = h.addFile('photo.png');
  const create = h.app.vault.createFolder;
  h.app.vault.createFolder = async (path) => {
    const folder = await create(path);
    h.plugin.cancel();
    return folder;
  };
  h.plugin.startBatch();
  await settle();
  assert.equal(image.path, 'photo.png');
  assert.equal(h.requests.length, 0);
  h.plugin.onunload();
});

test('invalid asset destinations retain last valid settings and a file cannot become a folder', async () => {
  const h = await harness();
  for (const assetsFolder of [
    '',
    '/',
    '.',
    '..',
    '../outside',
    '/tmp/assets',
    'A/../B',
    'A//B',
    'C:\\images',
  ]) {
    await assert.rejects(
      h.plugin.changeSettings({ ...h.plugin.settings, assetsFolder }),
      /vault-relative/,
    );
  }
  assert.equal(h.plugin.settings.assetsFolder, 'Assets');
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    model: '',
    autoMove: true,
    organizeAssets: true,
  });
  h.addFile('Assets');
  const image = h.addFile('photo.png');
  h.plugin.startBatch();
  await settle();
  assert.equal(image.path, 'photo.png');
  assert.ok(h.notices.some((notice) => notice.includes('Assets is a file')));
  h.plugin.onunload();
});

test('all supported images participate in a mixed batch independently of note exclusions', async () => {
  const h = await harness({ autoMove: true });
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    organizeAssets: true,
    skipFilenameRegex: '.*',
  });
  const images = [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'avif',
    'heic',
    'tif',
    'tiff',
  ].map((extension) => h.addFile(`image.${extension}`));
  h.plugin.startBatch();
  await settle();
  for (const image of images) assert.ok(image.path.startsWith('Assets/'));
  assert.equal(h.note.path, 'Note.md');
  assert.equal(h.requests.length, 1);
  assert.ok(h.notices.some((notice) => notice.includes('Assets moved: 11; conflicts skipped: 0')));
  h.plugin.onunload();
});

test('asset settings visibility follows both toggles and retains destination', async () => {
  const h = await harness();
  const definitions = h.plugin.settingTab
    .getSettingDefinitions()
    .flatMap((item) => item.items ?? [item]);
  const setting = (key) => definitions.find((item) => item.control?.key === key);
  assert.equal(setting('organizeAssets').visible(), false);
  assert.equal(setting('assetsFolder').visible(), false);
  await h.plugin.changeSettings({ ...h.plugin.settings, autoMove: true });
  assert.equal(setting('organizeAssets').visible(), true);
  assert.equal(setting('assetsFolder').visible(), false);
  await h.plugin.changeSettings({
    ...h.plugin.settings,
    organizeAssets: true,
    assetsFolder: 'Images',
  });
  assert.equal(setting('assetsFolder').visible(), true);
  await h.plugin.changeSettings({ ...h.plugin.settings, autoMove: false });
  assert.equal(setting('assetsFolder').visible(), false);
  assert.equal(h.plugin.settings.assetsFolder, 'Images');
  h.plugin.onunload();
});

test('prompt editors show defaults, persist overrides, and reset each prompt independently', async () => {
  const h = await harness({ autoMove: true });
  const tab = h.plugin.settingTab;
  const items = tab.getSettingDefinitions().flatMap((item) => item.items ?? [item]);
  const tagEditor = items.find((item) => item.control?.key === 'tagPrompt');
  const directoryEditor = items.find((item) => item.control?.key === 'directoryPrompt');
  assert.equal(tagEditor.control.type, 'textarea');
  assert.equal(tab.getControlValue('tagPrompt'), TAG_PROMPT);
  assert.equal(tab.getControlValue('directoryPrompt'), DIRECTORY_PROMPT);
  assert.match(directoryEditor.control.validate('  \n'), /Enter a prompt/);
  const tagPrompt = 'Custom tag policy.\nReturn JSON ratings.';
  const directoryPrompt = 'Custom directory policy.\nReturn JSON confidence.';
  await tab.setControlValue('tagPrompt', tagPrompt);
  await tab.setControlValue('directoryPrompt', directoryPrompt);
  h.organize();
  await settle();
  assert.equal(h.requests[0].messages[0].content, tagPrompt);
  assert.equal(h.requests[1].messages[0].content, directoryPrompt);
  const reloaded = await harness({ storedData: h.plugin.saved });
  assert.equal(reloaded.plugin.settings.tagPrompt, tagPrompt);
  assert.equal(reloaded.plugin.settings.directoryPrompt, directoryPrompt);
  await assert.rejects(
    h.plugin.changeSettings({ ...h.plugin.settings, tagPrompt: '  ' }),
    /Enter a prompt/,
  );
  assert.equal(h.plugin.settings.tagPrompt, tagPrompt);
  items.find((item) => item.name === 'Restore default tag prompt').action();
  await settle();
  assert.equal(h.plugin.settings.tagPrompt, TAG_PROMPT);
  assert.equal(h.plugin.settings.directoryPrompt, directoryPrompt);
  items.find((item) => item.name === 'Restore default directory prompt').action();
  await settle();
  assert.equal(h.plugin.saved.settings.directoryPrompt, DIRECTORY_PROMPT);
  h.plugin.onunload();
  reloaded.plugin.onunload();
});

test('automatic failures retry three times, then every ten minutes, without notices', async () => {
  let failing = true;
  const h = await harness({
    keepRefresh: true,
    responseHook: () => {
      if (failing) throw new Error('ECONNREFUSED');
    },
  });
  const fireRetry = async (ms) => {
    const retry = [...h.timers.entries()].find(([, timer]) => timer.ms === ms);
    assert.ok(retry, `Expected a ${ms} ms retry timer`);
    h.timers.delete(retry[0]);
    retry[1].fn();
    await settle();
  };
  h.emit('modify', h.note);
  await h.fireDebounce();
  assert.equal(h.requests.length, 1);
  assert.equal(h.status.text, 'Tagged: AI unavailable');
  for (let i = 0; i < 3; i++) {
    h.note.source += `\nEdit ${i}`;
    h.emit('modify', h.note);
    await h.fireDebounce();
    assert.equal(h.requests.length, i + 1);
    await fireRetry(30000);
  }
  assert.equal(h.requests.length, 4);
  assert.match(h.status.title, /Retrying every 10 minutes/);
  assert.deepEqual(h.notices, []);
  await fireRetry(600000);
  assert.equal(h.requests.length, 5);
  failing = false;
  await fireRetry(600000);
  await h.fireDebounce();
  assert.equal(h.status.text, 'Tagged: ready');
  assert.equal(h.status.title, '');
  assert.match(h.note.source, /Edit 2/);
  failing = true;
  h.note.source += '\nAnother edit';
  h.emit('modify', h.note);
  await h.fireDebounce();
  assert.ok([...h.timers.values()].some((timer) => timer.ms === 30000));
  h.plugin.onunload();
  assert.equal(h.timers.size, 0);
});

test('manual connection test bypasses automatic cooldown and success resets retries', async () => {
  let failing = true;
  const h = await harness({
    keepRefresh: true,
    responseHook: () => {
      if (failing) throw new Error('ECONNREFUSED');
    },
  });
  h.emit('modify', h.note);
  await h.fireDebounce();
  await assert.rejects(h.plugin.testConnection(), /Could not reach the API/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.status.text, 'Tagged: AI unavailable');
  failing = false;
  await h.plugin.testConnection();
  assert.equal(h.status.title, '');
  assert.ok(![...h.timers.values()].some((timer) => timer.ms === 30000 || timer.ms === 600000));
  await h.fireDebounce();
  assert.match(h.note.source, /tags:/);
  h.plugin.onunload();
});

test('stopping automatic retries cancels the timer and deferred notes', async () => {
  const h = await harness({
    keepRefresh: true,
    responseHook: () => {
      throw new Error('offline');
    },
  });
  h.emit('modify', h.note);
  await h.fireDebounce();
  h.plugin.cancel();
  assert.equal(h.timers.size, 0);
  assert.equal(h.status.text, 'Tagged: ready');
  h.plugin.onunload();
});
