/**
 * Inputs of an esbuild metafile that come from the npm package `name`.
 * @param {import('esbuild').Metafile} metafile
 * @param {string} name
 * @returns {string[]}
 */
export function packageInputs(metafile, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[\\\\/])node_modules[\\\\/]${escaped}[\\\\/]`);
  return Object.keys(metafile.inputs).filter((path) => pattern.test(path));
}
