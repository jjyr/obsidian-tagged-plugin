import { Plugin, TFile, TFolder, MarkdownView, Notice, requestUrl, getAllTags } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  migrateSettings,
  SETTINGS_VERSION,
  endpoint,
  type TaggedSettings,
} from './plugin/settings';
import { ASSET_EXTENSIONS, validateAssetsFolder } from './plugin/assets';
import { validatePrompt } from './plugin/prompts';
import { LlmClient } from './plugin/llm';
import { RequestFailure, transportFailure } from './plugin/diagnostics';
import { Engine, type Host, type Snapshot } from './plugin/engine';
import { validateSkipRegex, validateSkipTags } from './plugin/filing';
import { inlineTags, normalizeTag } from './plugin/content';
import { WorkQueue } from './plugin/queue';
import { TaggedSettingTab, ReorganizeModal } from './plugin/ui';

interface StoredData {
  settingsVersion: number;
  settings: TaggedSettings;
  managedTags: Record<string, string[]>;
}
class StaleWrite extends Error {}
export default class TaggedPlugin extends Plugin {
  settings: TaggedSettings = { ...DEFAULT_SETTINGS };
  private managedTags: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  private remembered = new WeakMap<TFile, string>();
  private moving = new WeakSet<TFile>();
  private queue!: WorkQueue<TFile>;
  private revision = 0;
  private alive = false;
  private saving: Promise<void> = Promise.resolve();
  private status!: HTMLElement;
  private batch: {
    remaining: Set<TFile>;
    total: number;
    notes: number;
    done: number;
    errors: number;
    assetsMoved: number;
    assetConflicts: number;
  } | null = null;
  private requestTimers = new Map<number, () => void>();
  private lastErrorNotice = 0;

  async onload() {
    const data = (await this.loadData()) as Partial<StoredData> | null;
    this.settings = migrateSettings(data?.settings, data?.settingsVersion ?? 0);
    if (data?.managedTags && typeof data.managedTags === 'object')
      for (const [key, value] of Object.entries(data.managedTags)) {
        if (Array.isArray(value) && value.every((x) => typeof x === 'string' && normalizeTag(x)))
          this.managedTags[key] = value;
      }
    if (data?.settingsVersion !== SETTINGS_VERSION) await this.persist();
    this.alive = true;
    this.status = this.addStatusBarItem();
    const host: Host<TFile> = {
      read: (file) => this.read(file),
      allowedTags: () => this.allowedTags(),
      directories: () => this.directories(),
      owned: (file) => this.managedTags[file.path] ?? [],
      commitTags: (file, expected, content, owned, current) =>
        this.commitTags(file, expected, content, owned, current),
      move: (file, expected, folder, current) => this.move(file, expected, folder, current),
      remember: (file, source) => this.remembered.set(file, source),
      isRemembered: (file, source) => this.remembered.get(file) === source,
      retry: (file, force) => this.schedule(file, force),
    };
    this.queue = new WorkQueue(
      { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) },
      async (file, force) => {
        const revision = this.revision;
        const batch = this.batch;
        const settings = { ...this.settings };
        this.status.setText(`Tagged: organizing ${file.basename}`);
        let finished = true;
        try {
          if (file.extension.toLowerCase() !== 'md') {
            const result = await this.moveAsset(
              file,
              () => this.alive && revision === this.revision,
            );
            if (batch && this.batch === batch) {
              if (result === 'moved') batch.assetsMoved++;
              if (result === 'conflict') batch.assetConflicts++;
            }
            return;
          }
          if (!this.configured() || !(settings.autoTags || settings.autoMove)) return;
          const engine = new Engine(host, this.client(settings));
          const outcome = await engine.run(
            file,
            settings,
            () => this.alive && revision === this.revision,
            force,
          );
          finished = outcome !== 'stale';
        } catch (error) {
          if (revision === this.revision && this.alive) {
            if (batch && this.batch === batch && batch.remaining.has(file)) batch.errors++;
            this.reportError(error);
          }
        } finally {
          if (finished && batch && this.batch === batch && batch.remaining.delete(file))
            batch.done++;
          this.updateStatus();
        }
      },
      (error) => this.reportError(error),
      () => this.updateStatus(),
    );
    this.addSettingTab(new TaggedSettingTab(this.app, this));
    this.addCommand({
      id: 'reorganize-all-notes',
      name: 'Reorganize all notes',
      callback: () => {
        if (!this.configured() && !this.assetsEnabled()) {
          new Notice('Tagged: configure an API URL and model first.');
          return;
        }
        if (!(this.settings.autoTags || this.settings.autoMove)) {
          new Notice('Tagged: enable tag recommendations or root-note filing first.');
          return;
        }
        if (this.batch) {
          new Notice('Tagged: a batch is already running.');
          return;
        }
        const files = this.batchFiles();
        new ReorganizeModal(
          this.app,
          files.filter((file) => file.extension.toLowerCase() === 'md').length,
          this.settings,
          () => this.startBatch(),
          files.filter((file) => file.extension.toLowerCase() !== 'md').length,
        ).open();
      },
    });
    this.addCommand({
      id: 'organize-current-note',
      name: 'Organize current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== 'md') return false;
        if (!checking) {
          if (!this.configured()) new Notice('Tagged: configure an API URL and model first.');
          else if (!(this.settings.autoTags || this.settings.autoMove))
            new Notice('Tagged: enable a classification feature first.');
          else this.queue.add(file);
        }
        return true;
      },
    });
    this.addCommand({
      id: 'stop-organizing',
      name: 'Stop organizing',
      callback: () => this.cancel(),
    });
    this.app.workspace.onLayoutReady(() => {
      if (!this.alive) return;
      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file instanceof TFile) this.schedule(file);
        }),
      );
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          if (file instanceof TFile) this.schedule(file);
        }),
      );
      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          for (const key of Object.keys(this.managedTags))
            if (key === file.path || key.startsWith(`${file.path}/`)) delete this.managedTags[key];
          if (file instanceof TFile) {
            this.queue.remove(file);
            this.remembered.delete(file);
            if (this.batch?.remaining.delete(file)) this.batch.done++;
          }
          void this.persist().catch((error) => this.reportError(error));
          this.updateStatus();
        }),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          for (const key of Object.keys(this.managedTags))
            if (key === oldPath || key.startsWith(`${oldPath}/`)) {
              this.managedTags[file.path + key.slice(oldPath.length)] = this.managedTags[key];
              delete this.managedTags[key];
            }
          if (file instanceof TFile && !this.moving.has(file)) {
            this.remembered.delete(file);
            this.schedule(file);
          }
          void this.persist().catch((error) => this.reportError(error));
        }),
      );
    });
    this.updateStatus();
  }
  onunload() {
    this.alive = false;
    this.revision++;
    this.queue?.stop();
    for (const [id, reject] of this.requestTimers) {
      window.clearTimeout(id);
      reject();
    }
    this.requestTimers.clear();
  }
  private configured() {
    try {
      endpoint(this.settings);
      return Boolean(this.settings.model.trim());
    } catch {
      return false;
    }
  }
  private schedule(file: TFile, force = false) {
    if (!this.alive || (!force && !this.settings.keepRefresh)) return;
    if (file.extension.toLowerCase() !== 'md') {
      if (!this.assetsEnabled() || !this.isRootAsset(file)) return;
    } else {
      if (!this.configured() || !(this.settings.autoTags || this.settings.autoMove)) return;
      if (!this.settings.autoTags && file.parent !== this.app.vault.getRoot()) return;
    }
    this.queue.schedule(file, this.settings.delaySeconds * 1000, force);
  }
  private assetsEnabled() {
    return this.settings.autoMove && this.settings.organizeAssets;
  }
  private isRootAsset(file: TFile) {
    return (
      file.parent === this.app.vault.getRoot() && ASSET_EXTENSIONS.has(file.extension.toLowerCase())
    );
  }
  private batchFiles(): TFile[] {
    const notes = this.configured() ? this.app.vault.getMarkdownFiles() : [];
    const assets = this.assetsEnabled()
      ? this.app.vault
          .getRoot()
          .children.filter((file): file is TFile => file instanceof TFile && this.isRootAsset(file))
      : [];
    return [...notes, ...assets].sort((a, b) => a.path.localeCompare(b.path));
  }
  private async moveAsset(
    file: TFile,
    current: () => boolean,
  ): Promise<'moved' | 'conflict' | 'skipped'> {
    const originalPath = file.path;
    const valid = () =>
      current() &&
      this.assetsEnabled() &&
      this.isRootAsset(file) &&
      file.path === originalPath &&
      this.app.vault.getFileByPath(originalPath) === file;
    if (!valid()) return 'skipped';
    const folder = this.settings.assetsFolder.trim();
    const error = validateAssetsFolder(folder);
    if (error) throw new Error(error);
    // Also keep assets out of Obsidian's hidden configuration directory.
    const configDir = this.app.vault.configDir.toLowerCase();
    if (folder.toLowerCase() === configDir || folder.toLowerCase().startsWith(`${configDir}/`))
      throw new Error('Choose an assets folder outside the vault configuration directory.');
    let path = '';
    for (const part of folder.split('/')) {
      if (!valid()) return 'skipped';
      path = path ? `${path}/${part}` : part;
      const existing = this.app.vault
        .getAllLoadedFiles()
        .find((item) => item.path.toLowerCase() === path.toLowerCase());
      if (existing) {
        if (!(existing instanceof TFolder))
          throw new Error(`Cannot create assets folder: ${path} is a file.`);
        path = existing.path;
      } else {
        try {
          await this.app.vault.createFolder(path);
        } catch (error) {
          // A concurrent creator may have made the same folder.
          if (!this.app.vault.getFolderByPath(path)) throw error;
        }
      }
    }
    if (!valid()) return 'skipped';
    const target = `${path}/${file.name}`;
    if (
      this.app.vault
        .getAllLoadedFiles()
        .some((item) => item.path.toLowerCase() === target.toLowerCase())
    ) {
      new Notice(`Tagged: skipped ${file.name}; ${target} already exists.`);
      return 'conflict';
    }
    this.moving.add(file);
    try {
      await this.app.fileManager.renameFile(file, target);
      return 'moved';
    } finally {
      this.moving.delete(file);
    }
  }
  private async read(file: TFile): Promise<Snapshot | null> {
    if (this.app.vault.getFileByPath(file.path) !== file || file.extension.toLowerCase() !== 'md')
      return null;
    const path = file.path;
    const source = await this.app.vault.read(file);
    if (file.path !== path) return null;
    return { path, name: file.basename, source, inlineTags: inlineTags(source) };
  }
  private allowedTags() {
    const tags = new Map<string, string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      for (const raw of cache ? (getAllTags(cache) ?? []) : []) {
        const tag = normalizeTag(raw);
        if (tag && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
      }
    }
    return [...tags.values()].sort((a, b) => a.localeCompare(b));
  }
  private directories() {
    return this.app.vault
      .getRoot()
      .children.filter(
        (file): file is TFolder => file instanceof TFolder && !file.name.startsWith('.'),
      )
      .map((folder) => folder.path)
      .sort((a, b) => a.localeCompare(b));
  }
  private editorChanged(file: TFile, source: string) {
    return this.app.workspace
      .getLeavesOfType('markdown')
      .some(
        (leaf) =>
          leaf.view instanceof MarkdownView &&
          leaf.view.file === file &&
          leaf.view.editor.getValue() !== source,
      );
  }
  private async commitTags(
    file: TFile,
    expected: Snapshot,
    content: string,
    owned: string[],
    current: () => boolean,
  ) {
    if (!current() || file.path !== expected.path || this.editorChanged(file, expected.source))
      return false;
    try {
      if (content !== expected.source)
        await this.app.vault.process(file, (actual) => {
          if (
            !current() ||
            file.path !== expected.path ||
            actual !== expected.source ||
            this.editorChanged(file, expected.source)
          )
            throw new StaleWrite();
          // Set before the modify event, not after a time-based suppression window.
          this.remembered.set(file, content);
          return content;
        });
      else if (
        (await this.app.vault.read(file)) !== expected.source ||
        !current() ||
        file.path !== expected.path
      )
        return false;
    } catch (error) {
      if (error instanceof StaleWrite) return false;
      this.remembered.delete(file);
      throw error;
    }
    this.managedTags[file.path] = owned;
    await this.persist();
    return true;
  }
  private async move(file: TFile, expected: Snapshot, folder: string, current: () => boolean) {
    if (!current() || file.path !== expected.path || file.parent !== this.app.vault.getRoot())
      return false;
    const targetFolder = this.app.vault.getFolderByPath(folder);
    if (!targetFolder || targetFolder.parent !== this.app.vault.getRoot()) return false;
    const target = `${targetFolder.path}/${file.name}`;
    if (
      this.app.vault
        .getAllLoadedFiles()
        .some((item) => item.path.toLowerCase() === target.toLowerCase())
    )
      throw new Error(`A file already exists at ${target}. The root note was not moved.`);
    if (
      (await this.app.vault.read(file)) !== expected.source ||
      !current() ||
      file.path !== expected.path ||
      this.editorChanged(file, expected.source)
    )
      return false;
    this.moving.add(file);
    try {
      // FileManager updates links according to the user's Obsidian link settings.
      await this.app.fileManager.renameFile(file, target);
      await this.persist();
      return true;
    } finally {
      this.moving.delete(file);
    }
  }
  private client(settings: TaggedSettings) {
    return new LlmClient(async (url, headers, body) => {
      let id = 0;
      const timeout = new Promise<never>((_resolve, reject) => {
        id = window.setTimeout(
          () =>
            reject(
              new RequestFailure(
                `The API request timed out after ${settings.timeoutSeconds} seconds. No late result will be applied.`,
              ),
            ),
          settings.timeoutSeconds * 1000,
        );
        this.requestTimers.set(id, () => reject(new RequestFailure('Tagged was unloaded.')));
      });
      try {
        const response = await Promise.race([
          requestUrl({ url, headers, body, method: 'POST', throw: false }),
          timeout,
        ]);
        let json: unknown = null;
        // Error responses may contain useful protocol codes. Never display their raw text.
        try {
          json = JSON.parse(response.text);
        } catch {
          /* Diagnosed by the API layer with status. */
        }
        return { status: response.status, json };
      } catch (error) {
        if (error instanceof RequestFailure) throw error;
        throw transportFailure(error);
      } finally {
        window.clearTimeout(id);
        this.requestTimers.delete(id);
      }
    });
  }
  async testConnection() {
    await this.client({ ...this.settings }).test({ ...this.settings });
  }
  async changeSettings(next: TaggedSettings) {
    const error =
      validateSkipRegex(next.skipFilenameRegex) ??
      validateSkipTags(next.skipTags) ??
      validateAssetsFolder(next.assetsFolder) ??
      validatePrompt(next.tagPrompt) ??
      validatePrompt(next.directoryPrompt);
    if (error) throw new Error(error);
    this.settings = normalizeSettings(next);
    this.remembered = new WeakMap<TFile, string>();
    this.revision++;
    this.queue.clear();
    this.batch = null;
    await this.persist();
    this.updateStatus();
  }
  private persist() {
    const data: StoredData = {
      settingsVersion: SETTINGS_VERSION,
      settings: { ...this.settings },
      managedTags: JSON.parse(JSON.stringify(this.managedTags)) as Record<string, string[]>,
    };
    const task = this.saving.catch(() => {}).then(() => this.saveData(data));
    this.saving = task;
    return task;
  }
  private startBatch() {
    if (!this.alive || this.batch) return;
    if (!(this.settings.autoTags || this.settings.autoMove)) return;
    const files = this.batchFiles();
    this.batch = {
      remaining: new Set(files),
      total: files.length,
      notes: files.filter((file) => file.extension.toLowerCase() === 'md').length,
      done: 0,
      errors: 0,
      assetsMoved: 0,
      assetConflicts: 0,
    };
    for (const file of files) this.queue.add(file, true);
    this.updateStatus();
  }
  cancel() {
    this.revision++;
    this.queue.clear();
    this.batch = null;
    this.updateStatus();
    new Notice(
      'Tagged: pending work stopped. Results from the current request will be ignored. Future edits still follow your settings.',
    );
  }
  private updateStatus() {
    if (!this.alive) return;
    if (this.batch && this.batch.remaining.size === 0) {
      new Notice(
        `Tagged: finished ${this.batch.notes} notes (${this.batch.errors} errors). Assets moved: ${this.batch.assetsMoved}; conflicts skipped: ${this.batch.assetConflicts}.`,
      );
      this.batch = null;
    }
    this.status.setText(
      this.batch
        ? `Tagged: ${this.batch.done}/${this.batch.total}`
        : this.queue?.size
          ? 'Tagged: pending'
          : 'Tagged',
    );
  }
  private reportError(error: unknown) {
    if (!this.alive) return;
    // No note body, prompt, API key, or raw provider response is logged.
    const message = error instanceof Error ? error.message : 'Could not organize this note.';
    if (Date.now() - this.lastErrorNotice > 5000) {
      new Notice(`Tagged: ${message}`, 15000);
      this.lastErrorNotice = Date.now();
    }
    this.status.setText('Tagged: error');
  }
}
