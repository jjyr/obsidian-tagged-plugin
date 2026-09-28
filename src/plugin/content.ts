import { parseDocument } from 'yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
const markdown = unified().use(remarkParse);
export function inlineTags(source: string): string[] {
  const tags = new Set<string>();
  function visit(node: { type: string; value?: string; children?: readonly { type: string }[] }) {
    if (
      ['code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference'].includes(
        node.type,
      )
    )
      return;
    if (node.type === 'text')
      for (const match of (node.value ?? '').matchAll(/(?:^|[\s(（])#([\p{L}\p{M}\p{N}_/-]+)/gu)) {
        const tag = normalizeTag(match[1]);
        if (tag) tags.add(tag);
      }
    node.children?.forEach(visit);
  }
  visit(markdown.parse(splitNote(source).body.replace(/%%[\s\S]*?%%/g, '')));
  return [...tags];
}

export function normalizeTag(value: string): string | null {
  const tag = value.replace(/^#/, '');
  return /^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag) && !/^\d+$/.test(tag) && tag.split('/').every(Boolean)
    ? tag
    : null;
}
export function readTags(value: unknown): string[] {
  const values =
    typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [];
  return values
    .filter((x): x is string => typeof x === 'string')
    .map(normalizeTag)
    .filter((x): x is string => x !== null);
}
export function splitNote(source: string) {
  const match = source.match(/^(\uFEFF?)---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    if (/^\uFEFF?---\r?\n/.test(source)) throw new Error('Unclosed YAML frontmatter.');
    return {
      body: source.replace(/^\uFEFF/, ''),
      header: null,
      title: null,
      tags: [] as string[],
      document: null,
      bom: source.startsWith('\uFEFF') ? '\uFEFF' : '',
    };
  }
  const document = parseDocument(match[2]);
  if (document.errors.length) throw new Error('Invalid YAML frontmatter.');
  const data: unknown = document.toJSON();
  if (data !== null && (typeof data !== 'object' || Array.isArray(data)))
    throw new Error('Frontmatter must be a mapping.');
  const record = (data ?? {}) as Record<string, unknown>;
  if (
    record.tags !== undefined &&
    typeof record.tags !== 'string' &&
    (!Array.isArray(record.tags) || record.tags.some((x) => typeof x !== 'string'))
  )
    throw new Error('The tags property must be a string or a list of strings.');
  return {
    body: source.slice(match[0].length),
    header: match[0],
    title: typeof record.title === 'string' ? record.title : null,
    tags: readTags(record.tags),
    document,
    bom: match[1],
  };
}
export function clippedBody(body: string, max: number): string {
  const chars = Array.from(body);
  return chars.length <= max
    ? body
    : `${chars.slice(0, Math.ceil(max / 2)).join('')}\n[Middle omitted]\n${chars.slice(-Math.floor(max / 2)).join('')}`;
}
/** Remove only tags previously added by this plugin; never rewrite body tags. */
export function updateTags(
  source: string,
  previousOwned: string[],
  recommended: string[],
  inlineTags: string[],
) {
  const note = splitNote(source);
  const lower = (s: string) => s.toLowerCase();
  const previous = new Set(previousOwned.map(lower));
  const inline = new Set(inlineTags.map(lower));
  const manual = note.tags.filter((tag) => !previous.has(lower(tag)) || inline.has(lower(tag)));
  const manualSet = new Set([...manual.map(lower), ...inline]);
  const selected = [...new Map(recommended.map((tag) => [lower(tag), tag])).values()];
  const owned = selected.filter((tag) => !manualSet.has(lower(tag)));
  const tags = [...manual, ...owned];
  if (JSON.stringify(tags) === JSON.stringify(note.tags)) return { content: source, owned };
  const document = note.document ?? parseDocument('{}');
  if (tags.length) document.set('tags', tags);
  else document.delete('tags');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const yaml = document.toString().trimEnd().replace(/\r?\n/g, newline);
  return { content: `${note.bom}---${newline}${yaml}${newline}---${newline}${note.body}`, owned };
}
