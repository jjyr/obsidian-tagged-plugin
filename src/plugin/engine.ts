import { shouldSkipFiling } from './filing';
import { clippedBody, splitNote, updateTags } from './content';
import type { DirectoryResult, NoteInput } from './llm';
import type { TaggedSettings } from './settings';
export interface Snapshot {
  path: string;
  name: string;
  source: string;
  inlineTags: string[];
}
export function noteInput(snapshot: Snapshot, maxInputChars: number): NoteInput {
  const note = splitNote(snapshot.source);
  return {
    title: note.title ?? snapshot.name,
    filename: snapshot.name,
    directory: snapshot.path.includes('/')
      ? snapshot.path.slice(0, snapshot.path.lastIndexOf('/'))
      : '',
    existing_tags: [...new Set([...note.tags, ...snapshot.inlineTags])],
    content: clippedBody(note.body, maxInputChars),
  };
}

export interface Host<T> {
  read(file: T): Promise<Snapshot | null>;
  allowedTags(): string[];
  directories(): string[];
  owned(file: T): string[];
  commitTags(
    file: T,
    expected: Snapshot,
    content: string,
    owned: string[],
    current: () => boolean,
  ): Promise<boolean>;
  move(file: T, expected: Snapshot, folder: string, current: () => boolean): Promise<boolean>;
  remember(file: T, source: string): void;
  isRemembered(file: T, source: string): boolean;
  retry(file: T, force: boolean): void;
}
export interface Classifier {
  tags(note: NoteInput, allowed: string[], settings: TaggedSettings): Promise<string[]>;
  directory(note: NoteInput, allowed: string[], settings: TaggedSettings): Promise<DirectoryResult>;
}
export type Outcome = 'unchanged' | 'classified' | 'moved' | 'stale' | 'cancelled';
export class Engine<T> {
  constructor(
    private host: Host<T>,
    private classifier: Classifier,
  ) {}
  async run(
    file: T,
    settings: TaggedSettings,
    current: () => boolean,
    force = false,
  ): Promise<Outcome> {
    const initial = await this.host.read(file);
    if (!initial || !current()) return 'cancelled';
    if (!force && this.host.isRemembered(file, initial.source)) return 'unchanged';
    const fresh = async (expected: Snapshot) => {
      if (!current()) return false;
      const actual = await this.host.read(file);
      return (
        current() &&
        actual !== null &&
        actual.path === expected.path &&
        actual.source === expected.source
      );
    };
    const stale = (): Outcome => {
      if (current()) this.host.retry(file, force);
      return current() ? 'stale' : 'cancelled';
    };
    let updated = initial;
    const hasTags = () =>
      splitNote(initial.source).tags.length > 0 || initial.inlineTags.length > 0;
    if (settings.autoTags && !(settings.onlyUntagged && hasTags())) {
      const allowed = this.host.allowedTags();
      if (allowed.length) {
        const tags = await this.classifier.tags(
          noteInput(initial, settings.maxInputChars),
          allowed,
          settings,
        );
        if (!(await fresh(initial))) return stale();
        const patch = updateTags(initial.source, this.host.owned(file), tags, initial.inlineTags);
        if (!(await this.host.commitTags(file, initial, patch.content, patch.owned, current)))
          return stale();
        updated = { ...initial, source: patch.content };
      }
    }
    if (!current()) return 'cancelled';
    // Folder inference sees tags after the tag update, including when no write was needed.
    if (
      settings.autoMove &&
      !updated.path.includes('/') &&
      !shouldSkipFiling(initial, settings) &&
      !shouldSkipFiling(updated, settings)
    ) {
      if (!(await fresh(updated))) return stale();
      const result = await this.classifier.directory(
        noteInput(updated, settings.maxInputChars),
        this.host.directories(),
        settings,
      );
      if (!(await fresh(updated))) return stale();
      if (result.directory !== null && result.confidence === 'high') {
        if (!this.host.directories().includes(result.directory)) return stale();
        if (!(await this.host.move(file, updated, result.directory, current))) return stale();
        this.host.remember(file, updated.source);
        return 'moved';
      }
    }
    if (!(await fresh(updated))) return stale();
    this.host.remember(file, updated.source);
    return 'classified';
  }
}
