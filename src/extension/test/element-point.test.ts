// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elementPoint } from '../page/element-point';
import { RefRegistry } from '../page/ref-registry';

// The viewport without scrollbars; window.innerWidth/innerHeight would include them.
const CLIENT = { width: 1000, height: 600 };

function setClientSize(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
}

function button(rect: { left: number; top: number; width: number; height: number }) {
  document.body.innerHTML = '<button>Save</button>';
  const element = document.querySelector('button');
  if (!element) throw new Error('no button');
  const scrollIntoView = vi.fn();
  element.scrollIntoView = scrollIntoView;
  element.getBoundingClientRect = () => DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return { element, scrollIntoView };
}

beforeEach(() => {
  setClientSize(CLIENT.width, CLIENT.height);
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (document.documentElement as Partial<Record<'clientWidth' | 'clientHeight', number>>).clientWidth;
  delete (document.documentElement as Partial<Record<'clientWidth' | 'clientHeight', number>>).clientHeight;
});

describe('elementPoint', () => {
  it('scrolls the element into view and returns its center in viewport CSS pixels', () => {
    const registry = new RefRegistry();
    const { element, scrollIntoView } = button({ left: 100, top: 50, width: 80, height: 21 });
    const ref = registry.refFor(element);
    expect(elementPoint(registry, document, { ref })).toEqual({ ok: true, x: 140, y: 60.5 });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'instant', block: 'center', inline: 'center' });
  });

  it('reports an unknown ref', () => {
    expect(elementPoint(new RefRegistry(), document, { ref: 'ref_7' })).toEqual({
      ok: false,
      error: 'ref_7 was not found in this page. Call read_page or find to get fresh element references.',
    });
  });

  it('reports a ref whose element was removed', () => {
    const registry = new RefRegistry();
    const { element, scrollIntoView } = button({ left: 0, top: 0, width: 10, height: 10 });
    const ref = registry.refFor(element);
    element.remove();
    expect(elementPoint(registry, document, { ref })).toEqual({
      ok: false,
      error: `${ref} no longer exists in the page. Call read_page or find to get fresh element references.`,
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([
    { left: 10, top: 10, width: 0, height: 20 },
    { left: 10, top: 10, width: 20, height: 0 },
  ])('refuses an element without size %o', (rect) => {
    const registry = new RefRegistry();
    const ref = registry.refFor(button(rect).element);
    expect(elementPoint(registry, document, { ref })).toEqual({
      ok: false,
      error: `${ref} has no size on the page, so it cannot be targeted. Take a screenshot and use coordinates instead.`,
    });
  });

  it.each([
    { left: -100, top: 10, width: 50, height: 20 },
    { left: 10, top: -40, width: 50, height: 20 },
    { left: 980, top: 10, width: 50, height: 20 },
    { left: 10, top: 590, width: 50, height: 40 },
  ])('refuses an element whose center stays outside the viewport %o', (rect) => {
    const registry = new RefRegistry();
    const ref = registry.refFor(button(rect).element);
    expect(elementPoint(registry, document, { ref })).toEqual({
      ok: false,
      error: `The center of ${ref} is outside the visible part of the page even after scrolling it into view. Take a screenshot and use coordinates instead.`,
    });
  });

  it('treats a center under a scrollbar as outside the viewport', () => {
    setClientSize(985, 585);
    const registry = new RefRegistry();
    const ref = registry.refFor(button({ left: 980, top: 10, width: 20, height: 20 }).element);
    expect(elementPoint(registry, document, { ref })).toMatchObject({ ok: false, error: expect.stringMatching(/^The center of/) });
  });

  it.each([
    { left: 10, top: 10, width: 0, height: 0 },
    { left: -100, top: 900, width: 50, height: 20 },
  ])('only scrolls for scroll_to, whatever the size and position %o', (rect) => {
    const registry = new RefRegistry();
    const { element, scrollIntoView } = button(rect);
    const ref = registry.refFor(element);
    expect(elementPoint(registry, document, { ref, scrollOnly: true })).toEqual({
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('still reports a missing ref for scroll_to', () => {
    expect(elementPoint(new RefRegistry(), document, { ref: 'ref_7', scrollOnly: true })).toMatchObject({ ok: false });
  });
});
