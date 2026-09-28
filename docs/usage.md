# Using Tagged

## Connect a model

Tagged supports OpenAI-compatible `/chat/completions` APIs, including local llama.cpp servers. Enter the API base URL (including `/v1` where required), model ID or alias, and optional API key. Do not append `/chat/completions` to the base URL.

Use **Test connection** to send a synthetic request without vault contents. JSON schema is the default response format; choose JSON object if the provider does not support schemas. Both modes validate candidates and exact lowercase ratings. Choose a model capable of returning structured JSON. Models and providers differ in which sampling and reasoning parameters they support.

Settings include temperature, top P, output token budget, frequency penalty, presence penalty, optional seed, reasoning effort, request timeout, and maximum note characters. Long notes retain their beginning and end within the character limit. This is verbatim text, not an anonymized summary.

## LLM prompts

The **LLM prompts** section shows the full default tag recommendation and directory classification system prompts in editable, resizable text areas. Changes are saved in this vault's plugin settings and replace the corresponding system prompt for subsequent requests. Each prompt has its own **Restore default** action. Blank prompts are rejected; older settings without these fields use the built-in defaults. Prompt changes cancel pending work just like other settings changes.

Candidate names and note data are supplied separately in the user message; no placeholders are needed. Keep the JSON contract when editing: tags must return exactly the three best distinct allowed candidates (or all when fewer exist), each with `tag` and `relevance`; directory classification must return `directory` (an exact allowed name or JSON `null`) and `confidence`. Ratings remain `high`, `medium` or `low`. Only high ratings apply tags or permit a move. Output schemas and client validation still apply to custom prompts.

**Test connection** uses the current directory prompt with synthetic content. Asset filing does not use either prompt.

## Privacy

A local LLM is recommended. Every classification request can disclose the title, filename, current folder, original note text, existing tags, and candidate tag or folder names to your API provider. No API calls occur until a model is configured and an eligible edit or command occurs. There is no telemetry or automatic cloud fallback.

API keys are stored unencrypted in the plugin's `data.json`, alongside settings and the list of tags managed by Tagged. Do not publish or share that file. Review vault synchronization and backup settings when using credentials.

## Automatic tags

Tag recommendations are on by default. **Keep refresh** is off by default, including when upgrading from settings without this option: use commands to organize notes. When enabled, saving a Markdown note starts a per-note delay of 15 seconds. Further saves restart the delay. Notes across the vault are handled one at a time. Turning Keep refresh off hides the delay setting and cancels pending work; manual commands remain available.

**Only recommend tags for untagged notes** is off by default and appears under Tag recommendations when that feature is enabled. Turn it on to skip tag recommendations for notes with any frontmatter or body tags, including tags previously added by Tagged. Empty tag lists and hashtags inside code do not count. Root-note filing can still run. Turning Tag recommendations off hides this sub-option while retaining its value.

Candidates come from existing tags in Obsidian's metadata cache, including frontmatter and inline tags. Tagged never invents tags. With no existing tags, tag classification is skipped; add your preferred vocabulary to some notes first.

The model rates up to three candidates as high, medium, or low. Only high-rated tags are applied to the YAML `tags` property. Pre-existing manual tags and inline tags are preserved. On later edits, Tagged may remove or replace only frontmatter tags it previously added. Consequently, the total number of tags on a note may exceed three.

Tag ownership is stored by path in plugin data and follows file/folder renames. Deleting plugin data loses ownership history: existing tags will then be treated as manual and retained. There is no way to distinguish a manual reaffirmation of an identical generated tag; a tag already owned by Tagged remains managed until ownership is removed. Never hand-edit ownership data while the plugin is running.

Malformed YAML, an unsupported tags property, or invalid/incomplete API output causes that note to be skipped without replacing its tags. YAML comments and unrelated properties are retained where possible, but formatting of modified frontmatter may change.

## Root-note filing

**Automatically file root notes** is off by default. When enabled, Tagged first finishes tag processing, then sends the updated note for a single folder recommendation. If tags are disabled, folder classification can run on its own. A failed tag request stops the current note's pipeline.

The following sub-options appear when root-note filing is enabled. Their values are retained when it is disabled. Any matching exclusion skips the folder request and move; tag recommendations still run according to their own settings. Both manual commands and Keep refresh respect these exclusions.

- **Skip daily notes** is on by default. It matches filenames without `.md` against `^\d{4}-\d{2}-\d{2}$`, for example `2026-09-23`.
- **Skip notes with tags** starts empty. Separate tags with spaces, commas, or newlines; a leading `#` is optional. Any complete, case-insensitive frontmatter or body tag match excludes the note. `journal` does not match `journal/daily`. Both pre-update and post-update tags are checked.
- **Skip filenames matching regex** starts empty. Enter one JavaScript regular expression per line, without `/` delimiters or flags. Patterns match filenames without `.md`, case-sensitively. Any match excludes the note. For example, `^Journal-` skips `Journal-weekly.md`. Invalid expressions show the line number and leave the last valid setting unchanged.

Candidates are actual, visible top-level folders. Other is a virtual option that keeps the note in the vault root, even at high confidence. Only high confidence in an existing folder allows a move. Medium and low results leave the note in place. Folders named Other remain valid real destinations: the API represents the virtual Other as JSON `null`, avoiding a name collision.

Notes already inside a folder are never moved by Tagged. Files at the destination are never overwritten; name collisions are reported. Moves use Obsidian's file manager and respect its link-update setting. No folders are created and no note bodies are rewritten.

## Root asset filing

**Organize root assets** is off by default and appears under root-note filing when that feature is enabled. Its destination field appears only when asset filing is on. The default destination is `Assets`; a vault-relative nested path such as `Resources/Images` is also supported. Missing folders are created. Disabling either switch retains the configured destination.

Only root-level images with these extensions are moved: JPG, JPEG, PNG, GIF, WebP, SVG, BMP, AVIF, HEIC, TIF and TIFF (case-insensitive). Files already in folders and other attachment types, including PDF, audio and video, stay where they are. Note exclusions for dates, tags and regular expressions do not apply to images.

Reorganize all notes also collects eligible root images. Organize current note never scans images. With Keep refresh on, newly created or modified root images are filed after the same save delay; with it off, use the batch command. There is no startup sweep. Asset filing uses no model and can run without API configuration; in that case the batch confirmation states that Markdown notes will not be processed.

Moves use Obsidian's file manager, so link updates follow Obsidian settings. Existing destination files are never overwritten: matching paths, including case-only differences, are skipped with a notice. Batch completion reports images moved and conflicts skipped. Absolute paths, the vault root and parent traversal are rejected. A file blocking a destination folder is reported as an error. Cancellation prevents subsequent moves but does not undo completed moves or folder creation.

## Commands

- **Tagged: Organize current note** — immediately reevaluate the active Markdown note using enabled features.
- **Tagged: Reorganize all notes** — confirm a sequential pass over all Markdown notes. Tags apply vault-wide; optional note moves and image filing apply only to root files. Back up your vault before a large reorganization.
- **Tagged: Stop organizing** — clear pending jobs and ignore the current request's result. Future edits still follow your settings.

Settings changes cancel pending work and invalidate in-flight inference results. Disabling/unloading the plugin removes listeners and timers. Obsidian's request API does not offer network abort, so already sent requests may still complete at the provider; their late results are ignored. Already completed writes or moves are not undone.

## Limitations

Candidate tag discovery relies on Obsidian's metadata cache. Let initial vault indexing finish before a full pass. All Markdown files participate; there is currently no template-folder exclusion setting. Providers may classify templates, technical canvases stored as Markdown, or vague folder names poorly.

A write is rejected if the note or its path changed during inference. Tagged also checks open editor buffers before writing. There is no cross-device transaction: sync software or another plugin can still edit or rename files during host operations. There is no undo history owned by Tagged; use Obsidian's recovery/backups as appropriate.

The plugin is built without desktop-only APIs, but the initial release has not been manually verified on mobile or in a live Obsidian vault.

## Connection test reaches the token limit

If the API succeeds but the model spends the output budget on reasoning, it may return no final JSON. For compatible Qwen/llama.cpp servers, set **Reasoning effort → None** and test again. Provider default can enable thinking even at temperature zero. Increasing the output limit is an alternative when reasoning is intentionally required.

A synthetic test against the configured local Qwen3.6 server returned `finish_reason: length` with 256 completion tokens and no final content under provider-default reasoning. With reasoning disabled, the same test returned valid JSON using 19 completion tokens. No note text was sent during this diagnosis.

## Error details and the reasoning default

Starting in 0.1.2, reasoning effort defaults to **None**. On the first upgrade, the legacy provider-default value is migrated to None; explicit low/medium/high choices are retained. A later manual choice of Provider default is preserved. Credentials, tag ownership and other settings are retained.

Connection-test errors remain visible below the Test button and appear in a longer-lived notice. Where the provider reports them, diagnostics show HTTP status, elapsed milliseconds, finish reason, prompt/completion/reasoning token counts, final-output and reasoning character counts, and the request's token limit, reasoning effort and response format. Missing measurements are not invented.

Recognized provider error codes, types and parameter names are shown with relevant suggestions. Network failures include recognized connection/DNS/certificate error codes. Raw provider messages, generated text, reasoning text, URLs with secrets and API keys are never included.
