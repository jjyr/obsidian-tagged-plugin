import { parseArgs } from 'node:util';
import { readdir, readFile, mkdir, writeFile, appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inlineTags, splitNote } from '../plugin/content';
import { noteInput, type Snapshot } from '../plugin/engine';
import { LlmClient } from '../plugin/llm';
import { ClassificationError } from '../plugin/diagnostics';
import { DEFAULT_SETTINGS, endpoint } from '../plugin/settings';

type Mode = 'tags' | 'directories';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Filesystem/report adapter only. Classification is the plugin's LlmClient. */
export async function run(mode: Mode) {
  const { values: args } = parseArgs({
    options: {
      vault: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string', default: DEFAULT_SETTINGS.baseUrl },
      out: { type: 'string' },
      limit: { type: 'string', default: mode === 'tags' ? '30' : String(Number.MAX_SAFE_INTEGER) },
      'max-chars': { type: 'string', default: String(DEFAULT_SETTINGS.maxInputChars) },
      timeout: { type: 'string', default: String(DEFAULT_SETTINGS.timeoutSeconds * 1000) },
      reasoning: { type: 'string', default: DEFAULT_SETTINGS.reasoning },
      all: { type: 'boolean', default: false },
      'scan-only': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (args.help) {
    console.log(`Tagged ${mode} classification (report only; notes are never modified).
--vault PATH [--model NAME] [--base-url URL] [--reasoning none] [--limit N] [--all] [--scan-only] [--out NEW_DIRECTORY] [--max-chars 12000] [--timeout 120000]
API key: TAGGED_API_KEY. Classification requires --model; --scan-only does not.
Reports contain vault-relative note names and candidates. Absolute paths and API connection details are not saved.`);
    return;
  }
  if (!args.vault || !path.isAbsolute(args.vault))
    throw new Error('Provide an absolute --vault path.');
  if (!args['scan-only'] && !args.model?.trim())
    throw new Error('Provide --model NAME or use --scan-only.');
  for (const key of ['limit', 'max-chars', 'timeout'] as const)
    if (!Number.isSafeInteger(Number(args[key])) || Number(args[key]) < 1)
      throw new Error(`${key} must be a positive integer.`);
  if (!['omit', 'none', 'minimal', 'low', 'medium', 'high'].includes(args.reasoning))
    throw new Error('Unsupported reasoning value.');
  if (mode === 'directories' && args.all)
    throw new Error('--all is only supported for tag classification.');
  const settings = {
    ...DEFAULT_SETTINGS,
    baseUrl: args['base-url'],
    model: args.model ?? '',
    apiKey: process.env.TAGGED_API_KEY ?? '',
    reasoning: args.reasoning,
    maxInputChars: Number(args['max-chars']),
    timeoutSeconds: Number(args.timeout) / 1000,
  };
  endpoint(settings);
  const vault = await realpath(args.vault);
  const out = path.resolve(
    args.out ?? `tagged-${mode}-run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  const actualOut = path.join(await realpath(path.dirname(out)), path.basename(out));
  const relativeOut = path.relative(vault, actualOut);
  if (
    !relativeOut.startsWith(`..${path.sep}`) &&
    relativeOut !== '..' &&
    !path.isAbsolute(relativeOut)
  )
    throw new Error('Output must be outside the vault.');
  const notes: Snapshot[] = [];
  async function walk(directory: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (mode === 'tags') await walk(file);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const source = await readFile(file, 'utf8');
        notes.push({
          path: path.relative(vault, file).split(path.sep).join('/'),
          name: entry.name.slice(0, -3),
          source,
          inlineTags: inlineTags(source),
        });
      }
    }
  }
  await walk(vault);
  const tagIndex = new Map<string, { tag: string; count: number }>();
  for (const note of notes) {
    const tags = [...splitNote(note.source).tags, ...note.inlineTags];
    for (const lower of new Set(tags.map((tag) => tag.toLowerCase()))) {
      const existing = tagIndex.get(lower);
      if (existing) existing.count++;
      else tagIndex.set(lower, { tag: tags.find((tag) => tag.toLowerCase() === lower)!, count: 1 });
    }
  }
  const tags = [...tagIndex.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  const folders = (await readdir(vault, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const allowed = mode === 'tags' ? tags.map((entry) => entry.tag) : folders;
  const targets = notes
    .filter((note) => args.all || !note.path.includes('/'))
    .slice(0, Number(args.limit));
  const prompt = mode === 'tags' ? settings.tagPrompt : settings.directoryPrompt;
  await mkdir(actualOut);
  await writeFile(
    path.join(actualOut, mode === 'tags' ? 'tags.json' : 'directories.json'),
    JSON.stringify(mode === 'tags' ? tags : folders, null, 2),
  );
  // Deliberate allowlist: never spread CLI arguments or settings into reports.
  await writeFile(
    path.join(actualOut, 'run.json'),
    JSON.stringify(
      {
        mode,
        scanned: notes.length,
        targets: targets.length,
        scanOnly: args['scan-only'],
        maxInputChars: settings.maxInputChars,
        reasoning: settings.reasoning,
        prompt,
        promptHash: hash(prompt),
        candidateHash: hash(allowed),
      },
      null,
      2,
    ),
  );
  console.log(
    `Scanned ${notes.length} notes; ${allowed.length} candidates; ${targets.length} targets.`,
  );
  if (args['scan-only']) return;
  const client = new LlmClient(async (url, headers, body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(Number(args.timeout)),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      /* The shared client diagnoses invalid responses. */
    }
    return { status: response.status, json };
  });
  const results: {
    path: string;
    status: string;
    tags?: string[];
    directory?: string | null;
    confidence?: string;
    error?: string;
    elapsedMs: number;
  }[] = [];
  for (const note of targets) {
    const start = performance.now();
    let result: (typeof results)[number];
    try {
      const input = noteInput(note, settings.maxInputChars);
      const classification =
        mode === 'tags'
          ? { tags: await client.tags(input, allowed, settings) }
          : await client.directory(input, allowed, settings);
      result = {
        path: note.path,
        status: 'ok',
        ...classification,
        elapsedMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      result = {
        path: note.path,
        status: 'error',
        error: error instanceof ClassificationError ? error.message : 'Classification failed.',
        elapsedMs: Math.round(performance.now() - start),
      };
    }
    results.push(result);
    await appendFile(path.join(actualOut, 'results.jsonl'), JSON.stringify(result) + '\n');
  }
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  await writeFile(
    path.join(actualOut, 'report.md'),
    [
      '# Tagged classification report',
      '',
      '| Note | Result | Milliseconds |',
      '| --- | --- | --- |',
      ...results.map(
        (result) =>
          `| ${cell(result.path)} | ${cell(result.error ?? (result.tags ? result.tags.join(', ') || 'No high tags' : result.directory !== null && result.confidence === 'high' ? result.directory! : 'Keep in root'))} | ${result.elapsedMs} |`,
      ),
    ].join('\n') + '\n',
  );
  await writeFile(
    path.join(actualOut, 'summary.json'),
    JSON.stringify(
      {
        count: results.length,
        success: results.filter((result) => result.status === 'ok').length,
        errors: results.filter((result) => result.status === 'error').length,
      },
      null,
      2,
    ),
  );
  console.log('Reports written to the selected output directory.');
  if (results.some((result) => result.status === 'error')) process.exitCode = 1;
}

export function reportCliError(error: unknown) {
  // Filesystem and argument errors may embed absolute paths or raw option values.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  console.error(
    code
      ? 'CLI failed. Check arguments, input files, output directory and permissions.'
      : error instanceof Error &&
          /^(Provide |Output must|Unsupported reasoning|--all is only|(?:limit|max-chars|timeout) must)/.test(
            error.message,
          )
        ? error.message
        : 'CLI failed. Check the input notes and API configuration.',
  );
  process.exitCode = 1;
}
