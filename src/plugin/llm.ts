import { endpoint, type TaggedSettings } from './settings';
import {
  ClassificationError,
  RequestFailure,
  responseDiagnostics,
  type Diagnostics,
} from './diagnostics';
export interface NoteInput {
  title: string;
  filename: string;
  directory: string;
  existing_tags: string[];
  content: string;
}
export type Confidence = 'high' | 'medium' | 'low';
export interface DirectoryResult {
  directory: string | null;
  confidence: Confidence;
}
export type Transport = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; json: unknown }>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const levels = ['high', 'medium', 'low'];
export function parseTagResult(value: unknown, allowed: string[]): string[] {
  if (!record(value) || !Array.isArray(value.tags))
    throw new Error('The API returned invalid tag JSON.');
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const item of value.tags) {
    if (
      !record(item) ||
      typeof item.tag !== 'string' ||
      !allowed.includes(item.tag) ||
      typeof item.relevance !== 'string' ||
      !levels.includes(item.relevance) ||
      seen.has(item.tag)
    )
      continue;
    seen.add(item.tag);
    if (item.relevance === 'high') selected.push(item.tag);
  }
  // Invalid entries must not erase previous tags under the guise of a valid empty result.
  if (
    seen.size !== Math.min(3, allowed.length) ||
    value.tags.length !== Math.min(3, allowed.length)
  )
    throw new Error(
      'The API returned missing, duplicate, or invalid tag ratings. Existing tags were kept.',
    );
  return selected.slice(0, 3);
}
export function parseDirectoryResult(value: unknown, allowed: string[]): DirectoryResult {
  if (
    !record(value) ||
    !(
      value.directory === null ||
      (typeof value.directory === 'string' && allowed.includes(value.directory))
    ) ||
    typeof value.confidence !== 'string' ||
    !levels.includes(value.confidence)
  )
    throw new Error('The API returned an invalid folder recommendation.');
  return { directory: value.directory, confidence: value.confidence as Confidence };
}
export class LlmClient {
  constructor(private transport: Transport) {}
  private async complete(
    settings: TaggedSettings,
    prompt: string,
    input: unknown,
    schema: unknown,
    name: string,
  ): Promise<{ value: unknown; diagnostics: Diagnostics }> {
    if (!settings.model.trim()) throw new Error('Choose an API model in Tagged settings first.');
    const body = {
      model: settings.model.trim(),
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(input) },
      ],
      stream: false,
      temperature: settings.temperature,
      top_p: settings.topP,
      max_tokens: settings.maxTokens,
      frequency_penalty: settings.frequencyPenalty,
      presence_penalty: settings.presencePenalty,
      ...(settings.seed ? { seed: Number(settings.seed) } : {}),
      ...(settings.reasoning !== 'omit' ? { reasoning_effort: settings.reasoning } : {}),
      response_format:
        settings.responseFormat === 'json_schema'
          ? { type: 'json_schema', json_schema: { name, strict: true, schema } }
          : { type: 'json_object' },
    };
    const started = Date.now();
    let response: Awaited<ReturnType<Transport>>;
    try {
      response = await this.transport(
        endpoint(settings),
        {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        JSON.stringify(body),
      );
    } catch (error) {
      throw new ClassificationError(
        error instanceof RequestFailure
          ? error.message
          : 'The API transport failed. Check the endpoint and network.',
        { elapsedMs: Date.now() - started },
        settings,
      );
    }
    const diagnostics = responseDiagnostics(response.status, response.json, Date.now() - started);
    const fail = (message: string) => new ClassificationError(message, diagnostics, settings);
    if (response.status < 200 || response.status >= 300) {
      const hints: Record<number, string> = {
        400: 'Check which request parameters your provider supports.',
        401: 'Check your API key.',
        403: 'Check model access and API permissions.',
        404: 'Check the API base URL and model ID.',
        429: 'Check rate limits and available quota.',
      };
      const hint =
        diagnostics.providerParameter === 'reasoning_effort'
          ? 'This provider rejected reasoning_effort. Try Provider default in Reasoning effort.'
          : (hints[response.status] ?? 'Check the provider status and configuration.');
      throw fail(`API request failed. ${hint}`);
    }
    if (!record(response.json) || !Array.isArray(response.json.choices))
      throw fail('The endpoint did not return an OpenAI-compatible completion.');
    const choice: unknown = response.json.choices[0];
    if (record(choice) && choice.finish_reason === 'length') {
      const message = record(choice.message) ? choice.message : {};
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0 && !message.content) {
        throw fail(
          'The model used the output token limit for reasoning and returned no JSON. Set Reasoning effort to None for compatible local models, or increase Maximum output tokens.',
        );
      }
      throw fail(
        'The response reached the output token limit before finishing. Increase Maximum output tokens, or disable reasoning if your model supports it.',
      );
    }
    if (
      !record(choice) ||
      choice.finish_reason !== 'stop' ||
      !record(choice.message) ||
      typeof choice.message.content !== 'string'
    )
      throw fail(
        'The model did not finish a JSON response. Check the output token limit and reasoning settings.',
      );
    try {
      return { value: JSON.parse(choice.message.content) as unknown, diagnostics };
    } catch {
      throw fail('The model returned malformed JSON. No classification was applied.');
    }
  }
  async tags(note: NoteInput, allowed: string[], settings: TaggedSettings): Promise<string[]> {
    if (!allowed.length) return [];
    const count = Math.min(3, allowed.length);
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          minItems: count,
          maxItems: count,
          items: {
            type: 'object',
            properties: {
              tag: { type: 'string', enum: allowed },
              relevance: { type: 'string', enum: levels },
            },
            required: ['tag', 'relevance'],
            additionalProperties: false,
          },
        },
      },
      required: ['tags'],
      additionalProperties: false,
    };
    const result = await this.complete(
      settings,
      settings.tagPrompt,
      { allowed_tags: allowed, document: note },
      schema,
      'tagged_tags',
    );
    try {
      return parseTagResult(result.value, allowed);
    } catch (error) {
      throw new ClassificationError(
        error instanceof Error ? error.message : 'Invalid tag result.',
        result.diagnostics,
        settings,
      );
    }
  }

  async directory(
    note: NoteInput,
    allowed: string[],
    settings: TaggedSettings,
  ): Promise<DirectoryResult> {
    if (!allowed.length) return { directory: null, confidence: 'high' };
    const schema = {
      type: 'object',
      properties: {
        directory: { type: ['string', 'null'], enum: [...allowed, null] },
        confidence: { type: 'string', enum: levels },
      },
      required: ['directory', 'confidence'],
      additionalProperties: false,
    };
    const result = await this.complete(
      settings,
      settings.directoryPrompt,
      { allowed_directories: allowed, other: null, document: note },
      schema,
      'tagged_directory',
    );
    try {
      return parseDirectoryResult(result.value, allowed);
    } catch (error) {
      throw new ClassificationError(
        error instanceof Error ? error.message : 'Invalid directory result.',
        result.diagnostics,
        settings,
      );
    }
  }

  async test(settings: TaggedSettings) {
    await this.directory(
      {
        title: 'Connection test',
        filename: 'Connection test',
        directory: '',
        existing_tags: [],
        content: 'This is a synthetic connection test, not a note. Keep it in Other.',
      },
      ['Test'],
      settings,
    );
  }
}
