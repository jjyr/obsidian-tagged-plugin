# Classification and event handling

## Pipeline

When Keep refresh is enabled (off by default), a vault create/modify event schedules its Markdown file after a configurable quiet period (15 seconds by default). The queue deduplicates pending files and runs one worker. An explicit command can bypass the delay. No startup sweep occurs.

The worker snapshots source text and path, discovers existing tags through `getAllTags(metadataCache.getFileCache(file))`, and requests up to three tag relevance ratings. It discards stale results and merges only high-rated recommendations with manual tags. An atomic `Vault.process` callback compares the expected source again before replacing YAML frontmatter.

The only-untagged option skips tag inference and writes when the initial document already has frontmatter or body tags. Filing remains independent.

When filing is enabled, the note is still in root, and no daily-filename, tag, or filename-regex exclusion matches, a second request receives the post-tag-update document. It returns one actual top-level folder or JSON null (Other), with a confidence enum. High confidence in a real, still-existing folder permits `FileManager.renameFile`. Name collisions, stale input, and unsaved editor changes prevent the move.

## Asset filing

Root images share the serial queue and debounce with Markdown jobs, but take a separate path before model configuration checks. Both root-note filing and asset filing must be enabled. The current-note command only accepts Markdown; batch jobs include root images, even without a configured model. Source identity, root location and cancellation revision are rechecked after asynchronous destination creation. Destination collisions are skipped; moves use `FileManager.renameFile` so Obsidian controls link updates. Plugin-initiated rename events do not enqueue another asset job.

## Loop prevention

The host records the exact text it is about to write before the modify event can arrive. A later automatic job with identical text exits before making an API call. There is no broad suppression window: a real edit produces different text and is eligible immediately after its own debounce. Successful no-op classifications are also remembered. These in-memory snapshots reset on settings changes and plugin reload; no startup classification is triggered.

A settings/cancellation revision invalidates in-flight results. Unload also clears queue timers and the request timeout bookkeeping. A network request already delivered via `requestUrl` cannot be physically aborted, but late responses cannot resume a cancelled pipeline.

## Ownership and persistence

Manual tags present before the first run are never claimed by Tagged. Owned tags are only newly inserted frontmatter tags, tracked in plugin data by note path. Inline tags are never deleted. If an owned tag also appears inline, it is treated as manual. File and folder rename events migrate ownership keys; delete events remove them.

Settings and ownership saves are serialized to avoid overwriting newer state with older asynchronous saves. Ownership is saved after the note write; if the application crashes in between, the conservative outcome is that a generated tag may subsequently be treated as manual. No note text is persisted in plugin data or logged.

## Provider contract

The plugin uses `requestUrl` for desktop/mobile host networking, with an application-level timeout, and requests non-streaming Chat Completions. JSON schema and JSON object modes are available. Candidate names and exact enum values are checked on the client. Invalid tag entries are ignored during parsing, but an incomplete/invalid candidate set fails the whole tag update to avoid erasing existing owned tags based on malformed output.

Tag judgments are relevance ratings, while the single-folder rating is confidence in placement. Neither is a calibrated probability. Output token budget, temperature, top P, penalties, optional seed, reasoning effort, timeout, and input size are configurable. There is no hidden retry or provider fallback.
