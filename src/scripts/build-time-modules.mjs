import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

/** @param {string} file */
async function evaluate(file) {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text ?? '';
  return /** @type {Record<string, unknown>} */ (
    await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  );
}

/** @param {unknown} value */
const isJsonData = (value) => value !== undefined && isDeepStrictEqual(JSON.parse(JSON.stringify(value) ?? 'null'), value);

/**
 * esbuild plugin that runs the listed modules in Node at build time and replaces each with its
 * exports as JSON literals, so their dependencies are not bundled. Every export must be plain JSON data.
 * @param {string[]} files absolute paths of the modules
 * @returns {import('esbuild').Plugin}
 */
export function buildTimeModules(files) {
  const listed = new Set(files);
  return {
    name: 'build-time-modules',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
        if (!listed.has(args.path)) return undefined;
        const exports = await evaluate(args.path);
        const lines = [];
        for (const [name, value] of Object.entries(exports)) {
          if (!isJsonData(value)) return { errors: [{ text: `Export ${name} of ${args.path} is not plain JSON data` }] };
          const literal = JSON.stringify(value);
          lines.push(name === 'default' ? `export default ${literal};` : `export const ${name} = ${literal};`);
        }
        return { contents: `${lines.join('\n')}\n`, loader: 'js' };
      });
    },
  };
}
