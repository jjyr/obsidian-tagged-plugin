import { TAG_PROMPT, DIRECTORY_PROMPT } from './prompts';

export interface TaggedSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  tagPrompt: string;
  directoryPrompt: string;
  autoTags: boolean;
  onlyUntagged: boolean;
  autoMove: boolean;
  organizeAssets: boolean;
  assetsFolder: string;
  keepRefresh: boolean;
  skipDailyNotes: boolean;
  skipTags: string;
  skipFilenameRegex: string;
  delaySeconds: number;
  temperature: number;
  topP: number;
  maxTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  seed: string;
  reasoning: string;
  responseFormat: 'json_schema' | 'json_object';
  timeoutSeconds: number;
  maxInputChars: number;
}
export const DEFAULT_SETTINGS: TaggedSettings = {
  baseUrl: 'http://127.0.0.1:8080/v1',
  apiKey: '',
  model: '',
  tagPrompt: TAG_PROMPT,
  directoryPrompt: DIRECTORY_PROMPT,
  autoTags: true,
  onlyUntagged: false,
  autoMove: false,
  organizeAssets: false,
  assetsFolder: 'Assets',
  keepRefresh: false,
  skipDailyNotes: true,
  skipTags: '',
  skipFilenameRegex: '',
  delaySeconds: 15,
  temperature: 0,
  topP: 1,
  maxTokens: 256,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: '',
  reasoning: 'none',
  responseFormat: 'json_schema',
  timeoutSeconds: 120,
  maxInputChars: 12000,
};
export function normalizeSettings(input: Partial<TaggedSettings> = {}): TaggedSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const s = { ...DEFAULT_SETTINGS };
  for (const key of [
    'baseUrl',
    'apiKey',
    'model',
    'seed',
    'skipTags',
    'skipFilenameRegex',
    'assetsFolder',
  ] as const)
    if (typeof input[key] === 'string') s[key] = input[key];
  for (const key of [
    'autoTags',
    'autoMove',
    'keepRefresh',
    'skipDailyNotes',
    'onlyUntagged',
    'organizeAssets',
  ] as const)
    if (typeof input[key] === 'boolean') s[key] = input[key];
  for (const key of ['tagPrompt', 'directoryPrompt'] as const)
    if (typeof input[key] === 'string' && input[key].trim()) s[key] = input[key];
  const ranges = {
    delaySeconds: [1, 3600],
    temperature: [0, 2],
    topP: [0, 1],
    maxTokens: [64, 32768],
    frequencyPenalty: [-2, 2],
    presencePenalty: [-2, 2],
    timeoutSeconds: [5, 600],
    maxInputChars: [100, 1000000],
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const value = input[key];
    const [min, max] = ranges[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
      s[key] = value;
  }
  for (const key of ['maxTokens', 'maxInputChars'] as const) s[key] = Math.floor(s[key]);
  if (
    input.reasoning &&
    ['omit', 'none', 'minimal', 'low', 'medium', 'high'].includes(input.reasoning)
  )
    s.reasoning = input.reasoning;
  if (input.responseFormat === 'json_object') s.responseFormat = 'json_object';
  if (s.seed && (!/^-?\d+$/.test(s.seed) || !Number.isSafeInteger(Number(s.seed)))) s.seed = '';
  return s;
}
export function endpoint(settings: TaggedSettings): string {
  const url = new URL(settings.baseUrl.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP(S) API base URL without credentials, query parameters, or fragments.',
    );
  return `${url.href.replace(/\/$/, '')}/chat/completions`;
}

export const SETTINGS_VERSION = 1;
/** Upgrade the old provider-default setting once, retaining later explicit choices. */
export function migrateSettings(input: Partial<TaggedSettings> = {}, version = 0): TaggedSettings {
  const settings = normalizeSettings(input);
  if (version < SETTINGS_VERSION && settings.reasoning === 'omit') settings.reasoning = 'none';
  return settings;
}
