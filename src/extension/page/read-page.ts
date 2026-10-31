import { buildAccessibilityTree } from './accessibility-tree';
import { READ_PAGE_ENTRY, type ReadPageEntry } from './read-page-api';
import { RefRegistry } from './ref-registry';

// Installs once per document: a second injection keeps the first registry, so refs stay stable.
export function installReadPage(scope: Record<string, unknown>, doc: Document, view: Window): void {
  if (typeof scope[READ_PAGE_ENTRY] === 'function') return;
  const registry = new RefRegistry();
  const entry: ReadPageEntry = (options) => {
    const result = buildAccessibilityTree(doc, registry, options);
    if (!result.ok) return result;
    return { ok: true, tree: result.tree, viewport: { width: view.innerWidth, height: view.innerHeight } };
  };
  scope[READ_PAGE_ENTRY] = entry;
}

installReadPage(globalThis as unknown as Record<string, unknown>, document, window);
