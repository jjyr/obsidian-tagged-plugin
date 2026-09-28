import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, parseTagResult, parseDirectoryResult, type NoteInput } from '../src/plugin/llm';
import { DEFAULT_SETTINGS, normalizeSettings, endpoint } from '../src/plugin/settings';
const note: NoteInput = {
  title: 'Title',
  filename: 'Title',
  directory: '',
  existing_tags: [],
  content: 'Body',
};
test('exact enums and candidate names are mandatory; invalid results cannot remove owned tags', () => {
  assert.deepEqual(parseTagResult({ tags: [{ tag: 'ai', relevance: 'low' }] }, ['ai']), []);
  for (const tags of [
    [],
    [{ tag: 'new', relevance: 'high' }],
    [{ tag: 'ai', relevance: 'HIGH' }],
    [
      { tag: 'ai', relevance: 'high' },
      { tag: 'ai', relevance: 'low' },
    ],
  ])
    assert.throws(() => parseTagResult({ tags }, ['ai']));
  assert.throws(() =>
    parseDirectoryResult({ directory: '../elsewhere', confidence: 'high' }, ['AI']),
  );
  assert.deepEqual(parseDirectoryResult({ directory: null, confidence: 'high' }, ['Other']), {
    directory: null,
    confidence: 'high',
  });
  assert.deepEqual(parseDirectoryResult({ directory: 'Other', confidence: 'high' }, ['Other']), {
    directory: 'Other',
    confidence: 'high',
  });
});
test('API parameters and single-folder schema are sent; truncated completions fail', async () => {
  let sent: Record<string, unknown> = {};
  const client = new LlmClient(async (url, headers, body) => {
    assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(headers.Authorization, 'Bearer test-key');
    sent = JSON.parse(body) as Record<string, unknown>;
    return {
      status: 200,
      json: {
        choices: [
          { finish_reason: 'stop', message: { content: '{"directory":null,"confidence":"high"}' } },
        ],
      },
    };
  });
  await client.directory(note, ['AI'], {
    ...DEFAULT_SETTINGS,
    model: 'local',
    apiKey: 'test-key',
    temperature: 0.2,
    topP: 0.8,
    seed: '42',
    reasoning: 'none',
  });
  assert.equal(sent.temperature, 0.2);
  assert.equal(sent.top_p, 0.8);
  assert.equal(sent.seed, 42);
  assert.equal(sent.reasoning_effort, 'none');
  assert.equal(sent.stream, false);
  assert.match(JSON.stringify(sent.response_format), /null/);
  const bad = new LlmClient(async () => ({
    status: 200,
    json: { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
  }));
  await assert.rejects(
    bad.directory(note, ['AI'], { ...DEFAULT_SETTINGS, model: 'local' }),
    /output token limit/,
  );
});
test('provider failures do not expose response contents', async () => {
  const client = new LlmClient(async () => ({ status: 401, json: { error: 'secret body' } }));
  await assert.rejects(
    client.directory(note, ['AI'], { ...DEFAULT_SETTINGS, model: 'local' }),
    (error) =>
      error instanceof Error &&
      !error.message.includes('secret body') &&
      error.message.includes('401'),
  );
});
test('settings have privacy-friendly defaults and reject invalid numeric input', () => {
  assert.equal(DEFAULT_SETTINGS.autoTags, true);
  assert.equal(DEFAULT_SETTINGS.autoMove, false);
  assert.equal(DEFAULT_SETTINGS.delaySeconds, 15);
  assert.equal(normalizeSettings({ delaySeconds: -2, temperature: NaN }).delaySeconds, 15);
  assert.throws(() =>
    endpoint({ ...DEFAULT_SETTINGS, baseUrl: 'https://user:secret@example.com/v1' }),
  );
});

test('reasoning-only truncated output gives an actionable setting hint without exposing reasoning', async () => {
  const client = new LlmClient(async () => ({
    status: 200,
    json: {
      choices: [
        {
          finish_reason: 'length',
          message: { content: '', reasoning_content: 'private reasoning text' },
        },
      ],
    },
  }));
  await assert.rejects(
    client.test({ ...DEFAULT_SETTINGS, model: 'local' }),
    (error) =>
      error instanceof Error &&
      error.message.includes('Reasoning effort to None') &&
      !error.message.includes('private reasoning text'),
  );
});

test('missing or empty stored prompts use defaults and custom prompt formatting is preserved', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.tagPrompt, DEFAULT_SETTINGS.tagPrompt);
  assert.equal(defaults.directoryPrompt, DEFAULT_SETTINGS.directoryPrompt);
  const empty = normalizeSettings({ tagPrompt: ' \n', directoryPrompt: '' });
  assert.equal(empty.tagPrompt, DEFAULT_SETTINGS.tagPrompt);
  assert.equal(empty.directoryPrompt, DEFAULT_SETTINGS.directoryPrompt);
  const custom = 'Custom policy\n  Preserve formatting.\n';
  assert.equal(normalizeSettings({ tagPrompt: custom }).tagPrompt, custom);
});

test('custom prompts preserve the input contract and invalid output is still rejected', async () => {
  const client = new LlmClient(async (_url, _headers, body) => {
    const request = JSON.parse(body);
    assert.equal(request.messages[0].content, 'Custom tag policy');
    assert.deepEqual(JSON.parse(request.messages[1].content), {
      allowed_tags: ['ai'],
      document: note,
    });
    assert.equal(request.response_format.json_schema.schema.properties.tags.maxItems, 1);
    return {
      status: 200,
      json: {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '{"tags":[{"tag":"invented","relevance":"high"}]}' },
          },
        ],
      },
    };
  });
  await assert.rejects(
    client.tags(note, ['ai'], {
      ...DEFAULT_SETTINGS,
      model: 'local',
      tagPrompt: 'Custom tag policy',
    }),
    /invalid tag ratings/,
  );
});
