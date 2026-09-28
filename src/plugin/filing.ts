import { normalizeTag, readTags, splitNote } from './content';
import type { Snapshot } from './engine';
import type { TaggedSettings } from './settings';

export function validateSkipTags(value: string): string | undefined {
  for (const tag of value.split(/[\s,]+/).filter(Boolean))
    if (!normalizeTag(tag)) return `Invalid tag: ${tag}`;
}

export function validateSkipRegex(value: string): string | undefined {
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      new RegExp(line.trim());
    } catch {
      return `Invalid regular expression on line ${index + 1}. Enter a pattern without / delimiters.`;
    }
  }
}

/** Filing exclusions do not disable tag recommendations. */
export function shouldSkipFiling(note: Snapshot, settings: TaggedSettings): boolean {
  if (settings.skipDailyNotes && /^\d{4}-\d{2}-\d{2}$/.test(note.name)) return true;
  const excluded = new Set(readTags(settings.skipTags).map((tag) => tag.toLowerCase()));
  if (
    excluded.size &&
    [...splitNote(note.source).tags, ...note.inlineTags].some((tag) =>
      excluded.has(tag.toLowerCase()),
    )
  )
    return true;
  // Invalid externally edited settings must never silently allow a move.
  const error =
    validateSkipRegex(settings.skipFilenameRegex) ?? validateSkipTags(settings.skipTags);
  if (error) throw new Error(error);
  return settings.skipFilenameRegex
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((pattern) => new RegExp(pattern).test(note.name));
}
