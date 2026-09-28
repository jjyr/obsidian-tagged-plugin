import { context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const production = process.argv.includes('--production');
const build = await context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2021',
  platform: 'browser',
  outfile: 'dist/main.js',
  sourcemap: production ? false : 'inline',
  minify: production,
  // Use the pure decoder instead of the package's DOM/innerHTML browser variant.
  alias: {
    'decode-named-character-reference': fileURLToPath(
      import.meta.resolve('decode-named-character-reference'),
    ),
  },
  plugins: [
    {
      name: 'plugin-artifacts',
      setup(builder) {
        builder.onEnd(async (result) => {
          if (result.errors.length) return;
          await mkdir('dist', { recursive: true });
          await Promise.all(
            ['manifest.json', 'styles.css'].map((name) => copyFile(name, `dist/${name}`)),
          );
        });
      },
    },
  ],
});
if (production) {
  await build.rebuild();
  await build.dispose();
} else {
  await build.watch();
}
