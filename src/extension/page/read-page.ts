import { buildAccessibilityTree } from './accessibility-tree';
import { FIND_ENTRY, type FindEntry } from './find-api';
import { findElements } from './find-elements';
import { setFormValue } from './form-input';
import { FORM_INPUT_ENTRY, type FormInputEntry } from './form-input-api';
import { READ_PAGE_ENTRY, type ReadPageEntry } from './read-page-api';
import { RefRegistry } from './ref-registry';

const ENTRIES = [READ_PAGE_ENTRY, FIND_ENTRY, FORM_INPUT_ENTRY];

// A second injection keeps the first registry, so refs stay stable.
// read_page, find and form_input share the registry, so a ref from read_page or find works with all three.
// A page that still runs a bundle from before an extension update lacks newer entries; its registry lives in that
// bundle's closure and cannot be shared, so all entries are replaced together and the old refs stop resolving.
export function installReadPage(scope: Record<string, unknown>, doc: Document, view: Window): void {
  if (ENTRIES.every((name) => typeof scope[name] === 'function')) return;
  const registry = new RefRegistry();
  const entry: ReadPageEntry = (options) => {
    const result = buildAccessibilityTree(doc, registry, options);
    if (!result.ok) return result;
    return { ok: true, tree: result.tree, viewport: { width: view.innerWidth, height: view.innerHeight } };
  };
  const find: FindEntry = (options) => findElements(doc, registry, options.query);
  const formInput: FormInputEntry = (options) => setFormValue(registry, options);
  scope[READ_PAGE_ENTRY] = entry;
  scope[FIND_ENTRY] = find;
  scope[FORM_INPUT_ENTRY] = formInput;
}

installReadPage(globalThis as unknown as Record<string, unknown>, document, window);
