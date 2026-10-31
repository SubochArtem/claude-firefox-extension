import { buildAccessibilityTree } from './accessibility-tree';
import { FIND_ENTRY, type FindEntry } from './find-api';
import { findElements } from './find-elements';
import { READ_PAGE_ENTRY, type ReadPageEntry } from './read-page-api';
import { RefRegistry } from './ref-registry';

// Installs once per document: a second injection keeps the first registry, so refs stay stable.
// read_page and find share the registry, so a ref from either works with the other.
export function installReadPage(scope: Record<string, unknown>, doc: Document, view: Window): void {
  if (typeof scope[READ_PAGE_ENTRY] === 'function') return;
  const registry = new RefRegistry();
  const entry: ReadPageEntry = (options) => {
    const result = buildAccessibilityTree(doc, registry, options);
    if (!result.ok) return result;
    return { ok: true, tree: result.tree, viewport: { width: view.innerWidth, height: view.innerHeight } };
  };
  const find: FindEntry = (options) => findElements(doc, registry, options.query);
  scope[READ_PAGE_ENTRY] = entry;
  scope[FIND_ENTRY] = find;
}

installReadPage(globalThis as unknown as Record<string, unknown>, document, window);
