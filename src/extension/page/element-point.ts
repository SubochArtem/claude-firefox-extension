import type { ElementPointOptions, ElementPointResult } from './element-point-api';
import type { RefRegistry } from './ref-registry';

function refError(ref: string, reason: string): ElementPointResult {
  return { ok: false, error: `${ref} ${reason}. Call read_page or find to get fresh element references.` };
}

export function elementPoint(registry: RefRegistry, doc: Document, options: ElementPointOptions): ElementPointResult {
  const { ref } = options;
  const resolution = registry.resolve(ref);
  if (resolution.status === 'not-found') return refError(ref, 'was not found in this page');
  if (resolution.status === 'gone') return refError(ref, 'no longer exists in the page');
  const { element } = resolution;
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (options.scrollOnly) return { ok: true, x, y };
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return { ok: false, error: `${ref} has no size on the page, so it cannot be targeted. Take a screenshot and use coordinates instead.` };
  }
  // clientWidth/clientHeight of the root exclude the scrollbars, where a click would not reach the page.
  const { clientWidth, clientHeight } = doc.documentElement;
  if (!(x >= 0 && y >= 0 && x < clientWidth && y < clientHeight)) {
    return {
      ok: false,
      error: `The center of ${ref} is outside the visible part of the page even after scrolling it into view. Take a screenshot and use coordinates instead.`,
    };
  }
  return { ok: true, x, y };
}
