# Development

Tagged follows the local K-Plex project's Obsidian plugin structure: TypeScript, native settings and commands, a CommonJS bundle with `obsidian` externalized, and installable output under `dist/`. K-Plex source files were not copied or modified.

## Toolchain

Use Node.js 22 or later. Commands can be prefixed with `mise exec --` when using mise.

```sh
npm ci
npm run verify
npm run dev
```

`verify` runs shared-core CLI integration tests, plugin core tests, TypeScript checking against the installed Obsidian declarations, and the production build. `dev` watches and rebuilds. `dist/` contains `main.js`, `manifest.json`, and `styles.css`; copy all three into a test vault's `.obsidian/plugins/tagged/` directory.

Do not commit API keys, vault contents, plugin data, or private run artifacts. `runs/`, model files, local environments, and build output are ignored.

## Repository hygiene

Commit source code, tests, documentation and screenshots, build/lint configuration, `manifest.json`, `styles.css`, `package.json`, and `package-lock.json`. Keep the lockfile so `npm ci` reproduces the dependency versions.

Keep `node_modules/` and `dist/` local and ignored: recreate them with `npm ci` and `npm run build`. Release archives, experimental output in `runs/`, model downloads, Python environments, logs, caches, `.env` files, Obsidian configuration, and root-level plugin `data.json` are ignored. Do not place real credentials or vault contents elsewhere in the repository. The tracked README screenshot is an intentional documentation asset.

## Layout

- `src/main.ts`: Obsidian lifecycle, events, atomic tag writes, moves, ownership persistence.
- `src/plugin/ui.ts`: native settings and batch confirmation.
- `src/plugin/settings.ts`: defaults and normalization.
- `src/plugin/engine.ts`: host-independent classify → apply tags → classify folder → move pipeline.
- `src/plugin/queue.ts`: debounce and serial work queue.
- `src/plugin/llm.ts`: OpenAI-compatible requests, schemas, output validation.
- `src/plugin/prompts.ts`: English tag-v6 rules and single-folder selection with Other.
- `src/plugin/content.ts`: frontmatter updates, tag ownership merging, input clipping.
- `tests/`: plugin regression tests.
- `src/cli.js`, `src/directory-cli.js`: thin command entry points.
- `src/cli/run.ts`: filesystem/transport/report adapter using the plugin core; covered by `tests/cli.test.mjs`.

## Manual host verification

In a disposable vault, configure a local model and seed several tags and folders. Verify:

1. With Keep refresh off, saving must not classify. Enable Keep refresh and save repeatedly; exactly one classification starts after the configured quiet period.
2. Generated tags do not cause another request. A subsequent real edit does.
3. Manual and inline tags survive replacement of generated tags.
4. Edit during inference; the stale result is ignored and the newer edit is retried.
5. With filing disabled, no paths change. With filing enabled, only root notes with high-confidence real destinations move, after tag updates.
6. Other and medium/low confidence never move. A destination collision preserves both files.
7. Cancel or unload during inference; no late result is applied.
8. Reorganize all notes, test cancellation, and confirm folder notes receive tags without moving.

A successful build and automated tests are not a substitute for these live-host checks. No live vault is modified by the automated test suite.

## Publishing a release

GitHub Actions publishes a release when a numeric version tag such as `0.1.2` is pushed. Do not prefix the tag with `v`. The workflow requires the tag to match `manifest.json`, `package.json`, and both root versions in `package-lock.json`, then runs `npm ci` and `npm run verify`. It uploads `main.js`, `manifest.json`, and `styles.css` as individual release assets for Obsidian to install. GitHub's built-in token supplies release permissions; no personal token is required.

For a new version, run `npm version NEW_VERSION --no-git-tag-version`, update `manifest.json` to the same version, and commit the changes before tagging:

```sh
git push origin main
git tag 0.1.3
git push origin 0.1.3
```

Use the actual new version in place of `0.1.3`. The tag must point at a commit containing `.github/workflows/release.yml`. Failed verification prevents publishing. Rerunning the workflow for an existing release replaces its three assets with the verified build from the same tag.
