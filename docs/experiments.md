# Tagged command-line tools

These read-only commands exercise the plugin's shared note parsing, input clipping, default prompts, LLM client, response schemas, validation and error diagnostics. Only filesystem scanning, Node fetch transport and report output are CLI-specific. They do not modify notes, move files, load saved Obsidian settings, or run the plugin's event queue and filing rules.

```sh
npm run classify -- --model YOUR_MODEL --vault /absolute/path/to/vault
npm run classify-directories -- --model YOUR_MODEL --vault /absolute/path/to/vault
```

Run `npm ci` first. Both commands use `tsx` to load the same TypeScript modules as the plugin. Use `--base-url` for the API endpoint (default `http://127.0.0.1:8080/v1`), `TAGGED_API_KEY` for authentication, and `--reasoning` to override the shared default `none`. Classification requires `--model`; `--scan-only` exports candidates without contacting a model. `--pi` is not supported.

Tag classification scans all notes to discover tags, then processes up to 30 root notes by default; `--all` includes nested targets. Directory classification processes all root notes by default. Both support `--limit`, `--max-chars` (default 12000), `--timeout` in milliseconds (default 120000), and `--out` pointing to a new directory outside the vault. Hidden files and symlinks are excluded. No existing report directory is overwritten.

Default output directories are `tagged-tags-run-<timestamp>` and `tagged-directories-run-<timestamp>`, both ignored by Git. Reports include candidate inventories, allowlisted run metadata, `results.jsonl`, `report.md` and `summary.json`. Scan-only runs write just inventories and metadata. The old independent relevance reports and permissive rating parser have been removed: invalid output fails exactly as it does in the plugin. A directory of JSON `null` means stay in root; a real folder named `其他` or `Other` remains a valid destination candidate. Only high confidence represents a move recommendation.

Reports never store the absolute vault/output paths, endpoint, model identifier, API key, original note body, or raw provider errors. They **do** contain vault-relative note names, candidate tags/folders and classification results, which may be private. API requests send note content and candidates just as the plugin does; this is not anonymization. Reports remain local and ignored unless explicitly shared. Fatal filesystem/argument errors use generic messages to avoid printing local paths.
