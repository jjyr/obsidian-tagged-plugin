import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient } from '../src/plugin/llm';
import { responseDiagnostics, transportFailure } from '../src/plugin/diagnostics';
import { DEFAULT_SETTINGS, migrateSettings, SETTINGS_VERSION } from '../src/plugin/settings';

test('none is the default; legacy default migrates once and explicit new choices persist', () => {
  assert.equal(DEFAULT_SETTINGS.reasoning, 'none');
  assert.equal(migrateSettings({ reasoning: 'omit' }, 0).reasoning, 'none');
  assert.equal(migrateSettings({ reasoning: 'low' }, 0).reasoning, 'low');
  assert.equal(migrateSettings({ reasoning: 'omit' }, SETTINGS_VERSION).reasoning, 'omit');
});

test('truncation errors report real response metadata without revealing generated text', async () => {
  const client = new LlmClient(async () => ({
    status: 200,
    json: {
      choices: [
        {
          finish_reason: 'length',
          message: { content: '', reasoning_content: 'sensitive reasoning' },
        },
      ],
      usage: {
        prompt_tokens: 362,
        completion_tokens: 256,
        completion_tokens_details: { reasoning_tokens: 256 },
      },
    },
  }));
  await assert.rejects(
    client.test({ ...DEFAULT_SETTINGS, model: 'local', reasoning: 'omit' }),
    (error) => {
      assert.ok(error instanceof Error);
      for (const expected of [
        'HTTP: 200',
        'finish_reason: length',
        'prompt_tokens: 362',
        'completion_tokens: 256',
        'reasoning_tokens: 256',
        'content_chars: 0',
        'reasoning_chars: 19',
        'max_tokens: 256',
        'provider default (omitted)',
      ])
        assert.ok(error.message.includes(expected), expected);
      assert.ok(!error.message.includes('sensitive reasoning'));
      return true;
    },
  );
});

test('provider codes and rejected parameter are visible; echoed message and credentials are not', async () => {
  const client = new LlmClient(async () => ({
    status: 400,
    json: {
      error: {
        code: 'unsupported_parameter',
        type: 'invalid_request_error',
        param: 'reasoning_effort',
        message: 'secret-key and PRIVATE NOTE',
      },
    },
  }));
  await assert.rejects(
    client.test({ ...DEFAULT_SETTINGS, model: 'local', apiKey: 'secret-key' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /provider_code: unsupported_parameter/);
      assert.match(error.message, /parameter: reasoning_effort/);
      assert.match(error.message, /Try Provider default/);
      assert.ok(!error.message.includes('secret-key'));
      assert.ok(!error.message.includes('PRIVATE NOTE'));
      return true;
    },
  );
  const diagnostics = responseDiagnostics(
    400,
    { error: { code: 'private-message', type: 'private-message', param: 'private-message' } },
    10,
  );
  assert.equal(diagnostics.providerCode, undefined);
  assert.equal(diagnostics.providerParameter, undefined);
});

test('invalid classification includes finish reason and content size without echoing content', async () => {
  const client = new LlmClient(async () => ({
    status: 200,
    json: {
      choices: [{ finish_reason: 'stop', message: { content: 'private unstructured output' } }],
    },
  }));
  await assert.rejects(
    client.test({ ...DEFAULT_SETTINGS, model: 'local' }),
    (error) =>
      error instanceof Error &&
      error.message.includes('finish_reason: stop') &&
      error.message.includes('content_chars: 27') &&
      !error.message.includes('private unstructured output'),
  );
});

test('safe network error codes survive while URLs and secrets are dropped', () => {
  const error = transportFailure(
    new Error('net::ERR_CONNECTION_REFUSED at https://host/secret-key with PRIVATE NOTE'),
  );
  assert.match(error.message, /ERR_CONNECTION_REFUSED/);
  assert.ok(!error.message.includes('secret-key'));
  assert.ok(!error.message.includes('PRIVATE NOTE'));
});
