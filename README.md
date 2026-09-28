# Tagged

Tagged is an Obsidian plugin that organizes notes with your existing tags and an OpenAI-compatible LLM.

- Organize on command, or enable **Keep refresh** to organize 15 seconds after saving.
- Optionally recommend tags only for notes that have no tags.
- Edit the tag and directory prompts in settings, with full defaults and individual reset actions.
- Preserve your manual tags and replace only tags added by Tagged.
- Optionally file root-level notes into existing top-level folders, after tags are updated.
- Optionally collect root images into `Assets` or another folder without using the model.
- Keep daily notes in the root by default; optionally exclude tags or filename patterns.
- Choose **Other** to keep a note in the vault root.
- Reorganize all Markdown notes from the command palette, or organize just the current note.

**Prefer a local LLM for private notes.** Your configured API receives note titles, original text, existing tags, and classification candidates. A remote API provider can access that content. Tagged has no telemetry.

## Install

Copy `main.js`, `manifest.json`, and `styles.css` from the release folder into `<vault>/.obsidian/plugins/tagged/`, then enable **Tagged** under Community plugins. Requires Obsidian 1.13.0 or later.

Open Tagged settings and enter an API base URL, model ID, and API key if needed. The default URL is `http://127.0.0.1:8080/v1`. Test the connection before editing notes. Reasoning effort defaults to **None**. If your provider rejects this parameter, choose **Provider default**.

Tag recommendations are enabled by default. Root-note filing and **Keep refresh** are disabled by default. Use commands to organize notes, or enable Keep refresh for automatic processing after saves. No notes are processed just because the plugin starts.

## Settings preview

![Tagged settings showing API connection and organization options](docs/images/settings.png)

## Guides

- [Usage, privacy, and settings](docs/usage.md)
- [Build and development](docs/development.md)
- [Classification and event handling](docs/architecture.md)
- [CLI tools using the plugin core](docs/experiments.md)

LLM decisions can be wrong. Review the behavior on a small vault before enabling automatic filing or running a full reorganization.
