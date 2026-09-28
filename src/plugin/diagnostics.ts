import type { TaggedSettings } from './settings';

export interface Diagnostics {
  elapsedMs: number;
  httpStatus?: number;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  contentCharacters?: number;
  reasoningCharacters?: number;
  providerCode?: string;
  providerType?: string;
  providerParameter?: string;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const knownCodes = new Set([
  'invalid_api_key',
  'invalid_request_error',
  'model_not_found',
  'context_length_exceeded',
  'rate_limit_exceeded',
  'insufficient_quota',
  'unsupported_parameter',
  'unsupported_value',
  'server_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
]);
const knownTypes = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'server_error',
  'api_error',
  'tokens',
]);
const knownParams = new Set([
  'model',
  'messages',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'reasoning_effort',
  'response_format',
]);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const length = (value: unknown) =>
  typeof value === 'string' ? Array.from(value).length : undefined;
/** Select numeric measurements and recognized protocol identifiers, never echoed provider text. */
export function responseDiagnostics(status: number, json: unknown, elapsedMs: number): Diagnostics {
  const root = isRecord(json) ? json : {};
  const choice: unknown = Array.isArray(root.choices) ? root.choices[0] : undefined;
  const item = isRecord(choice) ? choice : {};
  const message = isRecord(item.message) ? item.message : {};
  const usage = isRecord(root.usage) ? root.usage : {};
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const error = isRecord(root.error) ? root.error : {};
  const safeField = (value: unknown, allowed: Set<string>) =>
    typeof value === 'string' && allowed.has(value) ? value : undefined;
  const finish = safeField(
    item.finish_reason,
    new Set(['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'error']),
  );
  return {
    elapsedMs,
    httpStatus: status,
    finishReason:
      finish ??
      (item.finish_reason === null
        ? 'null'
        : item.finish_reason === undefined
          ? 'missing'
          : 'unrecognized'),
    promptTokens: count(usage.prompt_tokens),
    completionTokens: count(usage.completion_tokens),
    reasoningTokens: count(details.reasoning_tokens),
    contentCharacters: message.content === null ? 0 : length(message.content),
    reasoningCharacters: length(message.reasoning_content ?? message.reasoning),
    providerCode: safeField(error.code, knownCodes),
    providerType: safeField(error.type, knownTypes),
    providerParameter: safeField(error.param, knownParams),
  };
}
export class RequestFailure extends Error {}
export class ClassificationError extends Error {
  constructor(summary: string, diagnostics: Diagnostics, settings: TaggedSettings) {
    const fields = [
      diagnostics.httpStatus === undefined
        ? 'HTTP: no response'
        : `HTTP: ${diagnostics.httpStatus}`,
      `elapsed: ${diagnostics.elapsedMs} ms`,
      ...(diagnostics.finishReason ? [`finish_reason: ${diagnostics.finishReason}`] : []),
    ];
    const measurements = [
      ['prompt_tokens', diagnostics.promptTokens],
      ['completion_tokens', diagnostics.completionTokens],
      ['reasoning_tokens', diagnostics.reasoningTokens],
      ['content_chars', diagnostics.contentCharacters],
      ['reasoning_chars', diagnostics.reasoningCharacters],
    ]
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    const provider = [
      ['provider_code', diagnostics.providerCode],
      ['provider_type', diagnostics.providerType],
      ['parameter', diagnostics.providerParameter],
    ]
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    super(
      [
        summary,
        fields.join(' · '),
        measurements.join(' · '),
        provider.join(' · '),
        `max_tokens: ${settings.maxTokens} · reasoning_effort: ${settings.reasoning === 'omit' ? 'provider default (omitted)' : settings.reasoning} · response_format: ${settings.responseFormat}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    this.name = 'ClassificationError';
  }
}
export function transportFailure(error: unknown): RequestFailure {
  // Native errors can include request bodies or credentials. Report only known network codes.
  const message = error instanceof Error ? error.message : '';
  const code = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_CERT_AUTHORITY_INVALID',
    'ERR_CERT_DATE_INVALID',
  ].find((value) => new RegExp(`\\b${value}\\b`).test(message));
  return new RequestFailure(
    `Could not reach the API${code ? ` (${code})` : ''}. Check the URL, network, and provider settings.`,
  );
}
