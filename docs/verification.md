# Verification

The current workspace build passed `npm run verify`:

- 3 CLI adapter tests covering read-only scans, containment checks, report metadata privacy and filesystem error redaction. Classification behavior is covered by the shared plugin tests.
- 51 plugin tests covering classification validation, ownership, debounce, serial execution, cancellation, stale results, filing exclusions, untagged-only recommendations, asset filing, editable prompts, and the bundled Obsidian adapter.
- The recommended `eslint-plugin-obsidianmd` checks with no errors or warnings.
- TypeScript checking against the actual installed Obsidian API declarations.
- A production browser-targeted CommonJS bundle with only the host `obsidian` module externalized.

The bundled-plugin tests use public-API host doubles. They exercise saved-note events, self-write loop prevention, tag-to-folder sequencing, file collisions, ownership migration, batch completion, cancellation, and the final atomic write guard. They do not launch Obsidian or modify a real vault.

The installable files are `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. This build requires Obsidian 1.13.0 for searchable declarative settings. Live desktop and mobile behavior still needs the manual verification steps in [development.md](development.md).
