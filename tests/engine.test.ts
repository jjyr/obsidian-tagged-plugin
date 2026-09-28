import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type Host, type Snapshot, type Classifier } from '../src/plugin/engine';
import { DEFAULT_SETTINGS } from '../src/plugin/settings';
import { splitNote, updateTags, inlineTags } from '../src/plugin/content';

function fixture(source = 'A note about language models.', path = 'note.md') {
  const state = {
    source,
    path,
    owned: [] as string[],
    remembered: '',
    retries: 0,
    writes: 0,
    moves: 0,
    deleted: false,
  };
  const calls: string[] = [];
  const snapshot = (): Snapshot => ({
    source: state.source,
    path: state.path,
    name: state.path.split('/').at(-1)!.replace(/\.md$/, ''),
    inlineTags: inlineTags(state.source),
  });
  const host: Host<string> = {
    read: async () => (state.deleted ? null : snapshot()),
    allowedTags: () => ['ai', 'llm', 'manual'],
    directories: () => ['AI'],
    owned: () => state.owned,
    commitTags: async (_file, expected, content, owned, current) => {
      if (!current() || expected.source !== state.source || expected.path !== state.path)
        return false;
      if (content !== state.source) {
        state.writes++;
        state.source = content;
        state.remembered = content;
      }
      state.owned = owned;
      return true;
    },
    move: async (_file, expected, folder, current) => {
      if (!current() || state.source !== expected.source || state.path.includes('/')) return false;
      state.path = `${folder}/note.md`;
      state.moves++;
      return true;
    },
    remember: (_file, content) => {
      state.remembered = content;
    },
    isRemembered: (_file, content) => state.remembered === content,
    retry: () => {
      state.retries++;
    },
  };
  const client: Classifier = {
    tags: async () => {
      calls.push('tags');
      return ['llm'];
    },
    directory: async (note) => {
      calls.push('directory');
      assert.ok(note.existing_tags.includes('llm'));
      return { directory: 'AI', confidence: 'high' };
    },
  };
  return { state, host, client, calls, engine: new Engine(host, client) };
}

test('tag writes do not recursively classify; a genuine subsequent edit does', async () => {
  const f = fixture();
  assert.equal(await f.engine.run('note', DEFAULT_SETTINGS, () => true), 'classified');
  assert.equal(await f.engine.run('note', DEFAULT_SETTINGS, () => true), 'unchanged');
  assert.deepEqual(f.calls, ['tags']);
  f.state.source += '\nA new user edit.';
  await f.engine.run('note', DEFAULT_SETTINGS, () => true);
  assert.deepEqual(f.calls, ['tags', 'tags']);
  assert.equal(f.state.writes, 1);
});

test('directory inference follows tag commit and sees updated tags', async () => {
  const f = fixture();
  assert.equal(
    await f.engine.run('note', { ...DEFAULT_SETTINGS, autoMove: true }, () => true),
    'moved',
  );
  assert.deepEqual(f.calls, ['tags', 'directory']);
  assert.equal(f.state.path, 'AI/note.md');
  assert.equal(
    await f.engine.run('note', { ...DEFAULT_SETTINGS, autoMove: true }, () => true),
    'unchanged',
  );
});

test('no root filing by default and no moving notes already inside folders', async () => {
  for (const [path, settings] of [
    ['note.md', DEFAULT_SETTINGS],
    ['AI/note.md', { ...DEFAULT_SETTINGS, autoMove: true }],
  ] as const) {
    const f = fixture('Body', path);
    await f.engine.run('note', settings, () => true);
    assert.equal(f.state.moves, 0);
    assert.deepEqual(f.calls, ['tags']);
  }
});

test('a user edit during inference invalidates tags and schedules reevaluation', async () => {
  const f = fixture();
  f.client.tags = async () => {
    f.state.source = 'New user text';
    return ['ai'];
  };
  assert.equal(await f.engine.run('note', DEFAULT_SETTINGS, () => true), 'stale');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.source, 'New user text');
  assert.equal(f.state.retries, 1);
});

test('an edit during directory inference prevents moving and keeps the new text', async () => {
  const f = fixture();
  f.client.directory = async () => {
    f.state.source += '\nUser change';
    return { directory: 'AI', confidence: 'high' };
  };
  assert.equal(
    await f.engine.run('note', { ...DEFAULT_SETTINGS, autoMove: true }, () => true),
    'stale',
  );
  assert.equal(f.state.moves, 0);
  assert.match(f.state.source, /User change/);
});

test('cancellation/settings revision prevents a delayed response from writing', async () => {
  const f = fixture();
  let current = true;
  f.client.tags = async () => {
    current = false;
    return ['ai'];
  };
  assert.equal(await f.engine.run('note', DEFAULT_SETTINGS, () => current), 'cancelled');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.retries, 0);
});

test('cancellation during tag persistence prevents the subsequent folder API request', async () => {
  const f = fixture();
  let current = true;
  const commit = f.host.commitTags;
  f.host.commitTags = async (...args) => {
    const result = await commit(...args);
    current = false;
    return result;
  };
  assert.equal(
    await f.engine.run('note', { ...DEFAULT_SETTINGS, autoMove: true }, () => current),
    'cancelled',
  );
  assert.deepEqual(f.calls, ['tags']);
  assert.equal(f.state.moves, 0);
});

test('Other and non-high directory confidence never move', async () => {
  for (const result of [
    { directory: null, confidence: 'high' },
    { directory: 'AI', confidence: 'medium' },
    { directory: 'AI', confidence: 'low' },
  ] as const) {
    const f = fixture();
    f.client.directory = async () => result;
    await f.engine.run('note', { ...DEFAULT_SETTINGS, autoMove: true }, () => true);
    assert.equal(f.state.moves, 0);
  }
});

test('root filing works when tags are disabled; empty vocabulary does not invent tags', async () => {
  const f = fixture();
  f.client.directory = async () => ({ directory: 'AI', confidence: 'high' });
  await f.engine.run('note', { ...DEFAULT_SETTINGS, autoTags: false, autoMove: true }, () => true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.moves, 1);
  const g = fixture();
  g.host.allowedTags = () => [];
  await g.engine.run('note', DEFAULT_SETTINGS, () => true);
  assert.equal(g.state.writes, 0);
  assert.deepEqual(g.calls, []);
});

test('manual and inline tags survive; only owned frontmatter tags are replaced', () => {
  const source =
    '---\ntitle: Hello\ntags: [manual, old]\ncustom: 42 # keep this\n---\nBody #inline\n';
  const patch = updateTags(source, ['old'], ['inline', 'new'], inlineTags(source));
  assert.deepEqual(splitNote(patch.content).tags, ['manual', 'new']);
  assert.deepEqual(patch.owned, ['new']);
  assert.match(patch.content, /custom: 42 # keep this/);
  assert.equal(splitNote(patch.content).body, splitNote(source).body);
});

test('no-op leaves source byte-for-byte unchanged and YAML errors are not overwritten', () => {
  const source = '---\ntags: [manual]\n---\nBody';
  assert.equal(updateTags(source, [], ['manual'], []).content, source);
  for (const invalid of [
    '---\ntags: [oops\n---\nBody',
    '---\nnot closed',
    '---\ntags: 7\n---\nBody',
  ])
    assert.throws(() => updateTags(invalid, [], ['ai'], []));
  assert.deepEqual(
    inlineTags(
      'Body #valid\n\n```\n#nope\n```\n`#inlineCode`\n[link #hidden](url)\n%% #comment %%',
    ),
    ['valid'],
  );
});

test('filing exclusions preserve tag updates and skip the folder request', async () => {
  for (const [source, path, extra] of [
    ['Body', '2026-09-23.md', {}],
    ['---\ntags: [Journal]\n---\nBody', 'note.md', { skipTags: '#journal' }],
    ['Body #journal', 'note.md', { skipTags: 'other, journal' }],
    ['Body', 'Journal-weekly.md', { skipFilenameRegex: '^Draft\n^Journal-' }],
    ['Body', 'note.md', { skipTags: 'llm' }],
  ] as const) {
    const f = fixture(source, path);
    await f.engine.run('note', { ...DEFAULT_SETTINGS, autoMove: true, ...extra }, () => true, true);
    assert.deepEqual(f.calls, ['tags']);
    assert.equal(f.state.moves, 0);
    assert.ok(splitNote(f.state.source).tags.includes('llm'));
  }
});

test('filing exclusion checks tags before their managed replacements', async () => {
  const f = fixture('---\ntags: [journal]\n---\nBody');
  f.state.owned = ['journal'];
  await f.engine.run(
    'note',
    { ...DEFAULT_SETTINGS, autoMove: true, skipTags: 'journal' },
    () => true,
  );
  assert.deepEqual(splitNote(f.state.source).tags, ['llm']);
  assert.deepEqual(f.calls, ['tags']);
  assert.equal(f.state.moves, 0);
});

test('daily exclusion can be disabled and parent tags do not match nested tags', async () => {
  for (const [source, path] of [
    ['Body', '2026-09-23.md'],
    ['Body #journal/daily', 'note.md'],
  ]) {
    const f = fixture(source, path);
    await f.engine.run(
      'note',
      { ...DEFAULT_SETTINGS, autoMove: true, skipDailyNotes: false, skipTags: 'journal' },
      () => true,
    );
    assert.equal(f.state.moves, 1);
  }
});

test('only untagged skips all existing tags while allowing filing', async () => {
  for (const source of ['---\ntags: [manual]\n---\nBody', 'Body #manual']) {
    const f = fixture(source);
    f.client.directory = async (note) => {
      f.calls.push('directory');
      assert.ok(note.existing_tags.includes('manual'));
      return { directory: 'AI', confidence: 'high' };
    };
    await f.engine.run(
      'note',
      { ...DEFAULT_SETTINGS, autoMove: true, onlyUntagged: true },
      () => true,
    );
    assert.deepEqual(f.calls, ['directory']);
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.moves, 1);
    assert.equal(f.state.source, source);
  }
});

test('only untagged still recommends tags for empty tags and ignores code hashtags', async () => {
  for (const source of ['Body', '---\ntags: []\n---\nBody', 'Body `#code`']) {
    const f = fixture(source);
    await f.engine.run('note', { ...DEFAULT_SETTINGS, onlyUntagged: true }, () => true);
    assert.deepEqual(f.calls, ['tags']);
    assert.equal(f.state.writes, 1);
    f.state.source += '\nAn edit';
    await f.engine.run('note', { ...DEFAULT_SETTINGS, onlyUntagged: true }, () => true, true);
    assert.deepEqual(f.calls, ['tags']);
  }
});
