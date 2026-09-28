import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
const loader = import.meta.resolve('tsx');
const entries = {
  tags: path.resolve('src/cli.js'),
  directories: path.resolve('src/directory-cli.js'),
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tagged-private-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'AI'), { recursive: true });
  await mkdir(path.join(vault, '其他'));
  await mkdir(path.join(vault, '.obsidian'));
  await symlink(path.join(vault, 'AI'), path.join(vault, 'alias'));
  const source = '---\ntags: [ai]\n---\nBody #inline %% #hidden %% `#code`';
  await writeFile(path.join(vault, 'note.md'), source);
  await writeFile(path.join(vault, 'AI', 'nested.md'), 'Nested #nested');
  await writeFile(path.join(vault, '.hidden.md'), '#private');
  const invoke = (mode, args = [], env = {}) =>
    exec(process.execPath, ['--import', loader, entries[mode], '--vault', vault, ...args], {
      cwd: root,
      env: { ...process.env, TAGGED_API_KEY: '', ...env },
    });
  return { root, vault, source, invoke };
}

test('CLI scan shares parsing, excludes hidden/symlink entries, and omits local configuration', async (t) => {
  const f = await fixture(t);
  for (const mode of ['tags', 'directories']) {
    const out = path.join(f.root, mode);
    await f.invoke(
      mode,
      [
        '--scan-only',
        '--out',
        out,
        '--base-url',
        'http://private-host.invalid/v1',
        '--model',
        'private-model',
      ],
      { TAGGED_API_KEY: 'private-key' },
    );
    const config = await readFile(path.join(out, 'run.json'), 'utf8');
    for (const secret of [f.root, 'private-host', 'private-model', 'private-key'])
      assert.ok(!config.includes(secret));
    const run = JSON.parse(config);
    assert.equal(run.targets, 1);
    if (mode === 'tags') {
      assert.equal(run.scanned, 2);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(out, 'tags.json'), 'utf8')).map((item) => item.tag),
        ['ai', 'inline', 'nested'],
      );
    } else {
      assert.equal(run.scanned, 1);
      assert.deepEqual(JSON.parse(await readFile(path.join(out, 'directories.json'), 'utf8')), [
        'AI',
        '其他',
      ]);
    }
  }
  assert.equal(await readFile(path.join(f.vault, 'note.md'), 'utf8'), f.source);
});

test('CLI rejects removed options and prevents output inside vault, including symlinks', async (t) => {
  const f = await fixture(t);
  for (const mode of ['tags', 'directories']) {
    await assert.rejects(f.invoke(mode), /Provide --model/);
    await assert.rejects(
      f.invoke(mode, ['--pi']),
      (error) => error.code !== 0 && !error.stderr.includes(f.root),
    );
    await assert.rejects(
      f.invoke(mode, ['--scan-only', '--out', path.join(f.vault, 'output')]),
      /Output must be outside/,
    );
    const alias = path.join(f.root, `alias-${mode}`);
    await symlink(f.vault, alias);
    await assert.rejects(
      f.invoke(mode, ['--scan-only', '--out', path.join(alias, 'output')]),
      /Output must be outside/,
    );
    await f.invoke(mode, ['--scan-only']);
    assert.ok((await readdir(f.root)).some((name) => name.startsWith(`tagged-${mode}-run-`)));
  }
});

test('CLI uses strict frontmatter handling and avoids filesystem paths in errors', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.vault, 'note.md'), '---\ntags: [unclosed');
  await assert.rejects(
    f.invoke('tags', ['--scan-only']),
    (error) => !error.stderr.includes(f.root),
  );
  await assert.rejects(
    f.invoke('tags', ['--vault', path.join(f.root, 'missing'), '--scan-only']),
    (error) => !error.stderr.includes(f.root),
  );
});
