import {
  App,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
  type SettingDefinition,
} from 'obsidian';
import { validatePrompt } from './prompts';
import { validateAssetsFolder } from './assets';
import { validateSkipRegex, validateSkipTags } from './filing';
import type TaggedPlugin from '../main';
import { DEFAULT_SETTINGS, endpoint, type TaggedSettings } from './settings';

type NumberKey = keyof Pick<
  TaggedSettings,
  | 'delaySeconds'
  | 'temperature'
  | 'topP'
  | 'maxTokens'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'timeoutSeconds'
  | 'maxInputChars'
>;
export class TaggedSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: TaggedPlugin,
  ) {
    super(app, plugin);
  }
  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof TaggedSettings];
  }
  async setControlValue(key: string, value: unknown) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
    if (typeof value !== typeof DEFAULT_SETTINGS[key as keyof TaggedSettings]) return;
    try {
      await this.plugin.changeSettings({ ...this.plugin.settings, [key]: value });
      this.refreshDomState();
    } catch {
      new Notice('Tagged: could not save settings.');
    }
  }
  private async resetPrompt(key: 'tagPrompt' | 'directoryPrompt') {
    try {
      await this.plugin.changeSettings({ ...this.plugin.settings, [key]: DEFAULT_SETTINGS[key] });
      this.update();
    } catch {
      new Notice('Tagged: could not restore the default prompt.');
    }
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const number = (
      key: NumberKey,
      name: string,
      desc: string,
      min: number,
      max: number,
      integer = false,
    ): SettingDefinition => ({
      name,
      desc,
      control: {
        type: 'number',
        key,
        min,
        max,
        step: integer ? 1 : 'any',
        validate: (value) => {
          if (
            !Number.isFinite(value) ||
            value < min ||
            value > max ||
            (integer && !Number.isInteger(value))
          )
            return `Enter ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`;
        },
      },
    });
    return [
      {
        type: 'group',
        heading: 'Privacy',
        cls: 'tagged-privacy',
        items: [
          {
            name: 'Use a local LLM for private notes',
            desc: 'Your configured API receives note titles, original text, existing tags, and candidate names. A remote API provider can access this content. We recommend a local OpenAI-compatible server, such as llama.cpp. There is no telemetry.',
          },
          {
            name: 'Credential storage',
            desc: 'Your API key is stored unencrypted in this vault’s plugin settings. Keep plugin settings out of shared vaults and public backups.',
          },
        ],
      },
      {
        type: 'group',
        heading: 'API connection',
        items: [
          {
            name: 'Automatic organization status',
            render: (setting) => {
              const details = setting.infoEl.createDiv({ cls: 'tagged-test-result' });
              const refresh = () =>
                details.setText(
                  [this.plugin.getAutomaticStatus(), this.plugin.getAutomaticDetails()]
                    .filter(Boolean)
                    .join('\n'),
                );
              refresh();
              setting.addButton((button) => button.setButtonText('Refresh').onClick(refresh));
            },
          },
          {
            name: 'API base URL',
            desc: 'Include the API prefix, usually /v1. Do not include /chat/completions.',
            control: {
              type: 'text',
              key: 'baseUrl',
              validate: (value) => {
                try {
                  endpoint({ ...this.plugin.settings, baseUrl: value });
                } catch {
                  return 'Enter a valid HTTP(S) base URL without credentials, a query, or a fragment.';
                }
              },
            },
          },
          {
            name: 'API key',
            desc: 'Optional for local servers.',
            render: (setting) => {
              setting.addText((text) => {
                text.inputEl.type = 'password';
                text
                  .setValue(this.plugin.settings.apiKey)
                  .onChange((value) => this.setControlValue('apiKey', value.trim()));
              });
            },
          },
          {
            name: 'Model',
            desc: 'The model ID or alias accepted by your API.',
            control: { type: 'text', key: 'model' },
          },
          {
            name: 'Test connection',
            desc: 'Sends a synthetic request; no vault content is included.',
            render: (setting) => {
              const details = setting.infoEl.createDiv({ cls: 'tagged-test-result' });
              details.setAttribute('aria-live', 'polite');
              setting.addButton((button) =>
                button.setButtonText('Test').onClick(async () => {
                  button.setDisabled(true);
                  button.setButtonText('Testing…');
                  details.setText('Testing connection…');
                  try {
                    await this.plugin.testConnection();
                    details.setText('Connection successful. JSON response verified.');
                    new Notice('Tagged: connection successful. JSON response verified.');
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Connection failed.';
                    details.setText(`Connection test failed.\n${message}`);
                    new Notice(message, 15000);
                  } finally {
                    button.setDisabled(false);
                    button.setButtonText('Test');
                  }
                }),
              );
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Organization',
        items: [
          {
            name: 'Tag recommendations',
            desc: 'Apply high-relevance existing tags when organizing. Preserve manual tags and replace only tags previously added by this plugin.',
            control: { type: 'toggle', key: 'autoTags' },
          },
          {
            name: 'Only recommend tags for untagged notes',
            desc: 'Skip tag recommendations when a note already has any tags in its properties or body. Root-note filing can still run.',
            visible: () => this.plugin.settings.autoTags,
            control: { type: 'toggle', key: 'onlyUntagged' },
          },
          {
            name: 'Automatically file root notes',
            desc: 'After tag processing, choose one existing top-level folder. Move only high-confidence matches; Other means stay in the root. Notes already in folders are not moved.',
            control: { type: 'toggle', key: 'autoMove' },
          },
          {
            name: 'Skip daily notes',
            desc: 'Keep YYYY-MM-DD notes, such as 2026-09-23.md, in the root. Tag recommendations still apply.',
            visible: () => this.plugin.settings.autoMove,
            control: { type: 'toggle', key: 'skipDailyNotes' },
          },
          {
            name: 'Skip notes with tags',
            desc: 'Separate tags with spaces, commas, or newlines. Matches any complete tag in properties or the body, ignoring case. A leading # is optional.',
            visible: () => this.plugin.settings.autoMove,
            control: { type: 'textarea', key: 'skipTags', validate: validateSkipTags },
          },
          {
            name: 'Skip filenames matching regex',
            desc: 'One JavaScript regular expression per line, without / delimiters or flags. Matches the filename without .md; any match prevents filing. Example: ^Journal-',
            visible: () => this.plugin.settings.autoMove,
            control: { type: 'textarea', key: 'skipFilenameRegex', validate: validateSkipRegex },
          },
          {
            name: 'Organize root assets',
            desc: 'Move root-level JPG, JPEG, PNG, GIF, WebP, SVG, BMP, AVIF, HEIC, TIF and TIFF images into one folder without using the model. Existing destination files are never overwritten.',
            visible: () => this.plugin.settings.autoMove,
            control: { type: 'toggle', key: 'organizeAssets' },
          },
          {
            name: 'Assets folder',
            desc: 'Vault-relative destination, created if missing. Default: Assets. For example: Resources/Images.',
            visible: () => this.plugin.settings.autoMove && this.plugin.settings.organizeAssets,
            control: { type: 'text', key: 'assetsFolder', validate: validateAssetsFolder },
          },
          {
            name: 'Keep refresh',
            desc: 'Automatically organize after the last save. Off by default: use commands to organize notes manually.',
            control: { type: 'toggle', key: 'keepRefresh' },
          },
          {
            ...number(
              'delaySeconds',
              'Delay after saving',
              'Seconds after the most recent save before organizing. Default: 15.',
              1,
              3600,
            ),
            visible: () => this.plugin.settings.keepRefresh,
          },
        ],
      },
      {
        type: 'group',
        heading: 'LLM prompts',
        cls: 'tagged-prompts',
        items: [
          {
            name: 'Tag recommendation prompt',
            desc: 'Replaces the system prompt. Note data and allowed_tags are supplied separately. Return exactly three distinct candidates (all if fewer than three) as JSON tags with tag and relevance fields; ratings must be high, medium or low.',
            control: { type: 'textarea', key: 'tagPrompt', rows: 14, validate: validatePrompt },
          },
          {
            name: 'Restore default tag prompt',
            action: () => {
              void this.resetPrompt('tagPrompt');
            },
          },
          {
            name: 'Directory classification prompt',
            desc: 'Replaces the system prompt, including for Test connection. Note data and allowed_directories are supplied separately. Return JSON with directory (an exact candidate or null) and confidence (high, medium or low). Only high confidence permits a move.',
            control: {
              type: 'textarea',
              key: 'directoryPrompt',
              rows: 14,
              validate: validatePrompt,
            },
          },
          {
            name: 'Restore default directory prompt',
            action: () => {
              void this.resetPrompt('directoryPrompt');
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Model parameters',
        items: [
          number(
            'temperature',
            'Temperature',
            'Lower values usually make classification more consistent. Default: 0.',
            0,
            2,
          ),
          number('topP', 'Top P', 'Nucleus sampling probability. Default: 1.', 0, 1),
          number(
            'maxTokens',
            'Maximum output tokens',
            'Increase if responses are cut off. Default: 256.',
            64,
            32768,
            true,
          ),
          number(
            'frequencyPenalty',
            'Frequency penalty',
            'OpenAI-compatible frequency penalty. Default: 0.',
            -2,
            2,
          ),
          number(
            'presencePenalty',
            'Presence penalty',
            'OpenAI-compatible presence penalty. Default: 0.',
            -2,
            2,
          ),
          {
            name: 'Seed',
            desc: 'Optional integer; your provider may not support it.',
            control: {
              type: 'text',
              key: 'seed',
              validate: (value) => {
                if (
                  value !== '' &&
                  (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
                )
                  return 'Enter an integer or leave blank.';
              },
            },
          },
          {
            name: 'Reasoning effort',
            desc: 'Default: none. Disable reasoning for concise classification. If your provider rejects this parameter, choose its default instead.',
            control: {
              type: 'dropdown',
              key: 'reasoning',
              options: {
                omit: 'Provider default',
                none: 'None',
                minimal: 'Minimal',
                low: 'Low',
                medium: 'Medium',
                high: 'High',
              },
            },
          },
          {
            name: 'Response format',
            desc: 'Use JSON object if your provider does not support JSON schema. Both formats are validated.',
            control: {
              type: 'dropdown',
              key: 'responseFormat',
              options: { json_schema: 'JSON schema', json_object: 'JSON object' },
            },
          },
          number(
            'timeoutSeconds',
            'Request timeout',
            'Seconds before abandoning a response. Default: 120.',
            5,
            600,
          ),
          number(
            'maxInputChars',
            'Maximum note characters',
            'Long bodies keep their beginning and end. Selected text is sent verbatim. Default: 12000.',
            100,
            1000000,
            true,
          ),
        ],
      },
      {
        name: 'Organize existing notes',
        desc: 'Use the command palette to reorganize all notes, organize the current note, or stop pending work. Changing settings also cancels pending work.',
      },
    ];
  }
}

export class ReorganizeModal extends Modal {
  constructor(
    app: App,
    private count: number,
    private settings: TaggedSettings,
    private start: () => void,
    private assetCount = 0,
  ) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText('Reorganize all notes?');
    this.contentEl.createEl('p', {
      text: this.count
        ? `Process ${this.count} Markdown notes using ${this.settings.model}? Note text will be sent to ${new URL(this.settings.baseUrl).origin}.`
        : 'No Markdown notes will be processed. Note organization requires a configured model.',
    });
    this.contentEl.createEl('p', {
      text: this.settings.autoTags
        ? this.settings.onlyUntagged
          ? 'Tagged will recommend tags only for notes with no property or body tags.'
          : 'Tagged will refresh its own tags while preserving your manual tags.'
        : 'Tag recommendations are disabled.',
    });
    this.contentEl.createEl('p', {
      text: this.settings.autoMove
        ? 'High-confidence root notes will be moved into existing top-level folders unless a filing exclusion matches. Other stays in the root. Back up your vault before a large reorganization.'
        : 'Automatic filing is disabled. No notes will be moved.',
    });
    if (this.settings.autoMove && this.settings.organizeAssets)
      this.contentEl.createEl('p', {
        text: `Move ${this.assetCount} root images to ${this.settings.assetsFolder.trim()}. Missing folders will be created; conflicts will be skipped. Images are not sent to the model. Links follow Obsidian settings.`,
      });
    const buttons = this.contentEl.createDiv({ cls: 'tagged-actions' });
    new Setting(buttons)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Reorganize')
          .setCta()
          .onClick(() => {
            this.close();
            this.start();
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}
