/** web-ext reads its AMO credentials from these variables, so they never appear on the command line. */
export const SIGN_KEYS = /** @type {const} */ (['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']);

export const SIGN_ARGS = /** @type {const} */ (['sign', '--channel=unlisted']);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function missingSignKeys(env) {
  return SIGN_KEYS.filter((name) => (env[name] ?? '').trim() === '');
}

/** @param {string[]} missing */
export function missingKeysMessage(missing) {
  return (
    `Signing failed: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
    'Put the AMO API key and secret into src/.env (template: src/.env.example) or the environment.'
  );
}
