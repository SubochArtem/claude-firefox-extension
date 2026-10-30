import { posix } from 'node:path';

// Decisions for a local e2e run (--force outside CI), kept pure so they can be tested. The run
// installs the native host, and the installer writes into HOME and XDG_DATA_HOME, so a local run is
// only allowed when everything it writes lands in a throwaway directory.

/**
 * @param {string} parent
 * @param {string} child
 */
export function isStrictlyInside(parent, child) {
  const rel = posix.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
}

/**
 * All paths are expected to be absolute and already resolved with realpath by the caller.
 * @param {{ platform: string, home: string | undefined, realHome: string, runtimeDir: string | undefined, tempRoots: string[] }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function localRunSafety({ platform, home, realHome, runtimeDir, tempRoots }) {
  if (platform !== 'linux') {
    return {
      ok: false,
      reason:
        `local e2e runs (--force without CI) are supported only on Linux; on ${platform} the installer or the bridge ` +
        'uses locations outside HOME (the registry and %LOCALAPPDATA% on Windows, /tmp on macOS). Run e2e in CI there.',
    };
  }
  const roots = tempRoots.join(' or ');
  if (!home || !posix.isAbsolute(home)) {
    return { ok: false, reason: `HOME must be set to an existing temporary directory under ${roots}` };
  }
  if (home === realHome || isStrictlyInside(home, realHome) || isStrictlyInside(realHome, home)) {
    return {
      ok: false,
      reason: `HOME (${home}) is, contains or lies inside your real home directory ${realHome}; point it at a temporary directory under ${roots}`,
    };
  }
  if (!tempRoots.some((root) => isStrictlyInside(root, home))) {
    return { ok: false, reason: `HOME (${home}) is not a temporary directory under ${roots}` };
  }
  if (!runtimeDir || !posix.isAbsolute(runtimeDir)) {
    return {
      ok: false,
      reason: `XDG_RUNTIME_DIR must be set to an existing temporary directory under ${roots}, so the bridge does not share the real runtime directory`,
    };
  }
  if (!tempRoots.some((root) => isStrictlyInside(root, runtimeDir))) {
    return { ok: false, reason: `XDG_RUNTIME_DIR (${runtimeDir}) is not a temporary directory under ${roots}` };
  }
  return { ok: true };
}

/**
 * XDG base directories inside the temporary HOME. They are set explicitly, because unsetting them
 * would still let a child fall back to whatever its own environment provides.
 * @param {string} home
 */
export function isolatedXdgEnv(home) {
  return {
    XDG_DATA_HOME: posix.join(home, '.local/share'),
    XDG_CONFIG_HOME: posix.join(home, '.config'),
    XDG_CACHE_HOME: posix.join(home, '.cache'),
    XDG_STATE_HOME: posix.join(home, '.local/state'),
  };
}

/**
 * @param {string} home
 * @param {string[]} paths
 */
export function pathsOutside(home, paths) {
  return paths.filter((path) => !posix.isAbsolute(path) || !isStrictlyInside(home, posix.normalize(path)));
}
