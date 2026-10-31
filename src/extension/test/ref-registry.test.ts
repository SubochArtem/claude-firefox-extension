// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { RefRegistry, type ElementRef } from '../page/ref-registry';

class FakeRef implements ElementRef {
  constructor(public element: Element | undefined) {}
  deref(): Element | undefined {
    return this.element;
  }
}

function element(): HTMLElement {
  const el = document.createElement('button');
  document.body.append(el);
  return el;
}

describe('RefRegistry', () => {
  it('issues increasing ref ids', () => {
    const registry = new RefRegistry();
    expect(registry.refFor(element())).toBe('ref_1');
    expect(registry.refFor(element())).toBe('ref_2');
  });

  it('keeps the ref of an element that already has one', () => {
    const registry = new RefRegistry();
    const el = element();
    const ref = registry.refFor(el);
    registry.refFor(element());
    expect(registry.refFor(el)).toBe(ref);
  });

  it('resolves a live connected element', () => {
    const registry = new RefRegistry();
    const el = element();
    const ref = registry.refFor(el);
    expect(registry.resolve(ref)).toEqual({ status: 'found', element: el });
  });

  it('reports an unknown ref as not found', () => {
    const registry = new RefRegistry();
    registry.refFor(element());
    expect(registry.resolve('ref_7').status).toBe('not-found');
    expect(registry.resolve('ref_0').status).toBe('not-found');
    expect(registry.resolve('button').status).toBe('not-found');
    expect(registry.resolve('ref_01').status).toBe('not-found');
  });

  it('reports a disconnected element as gone', () => {
    const registry = new RefRegistry();
    const el = element();
    const ref = registry.refFor(el);
    el.remove();
    expect(registry.resolve(ref).status).toBe('gone');
  });

  it('reports a collected element as gone and sweeps it', () => {
    const refs: FakeRef[] = [];
    const registry = new RefRegistry((el: Element) => {
      const ref = new FakeRef(el);
      refs.push(ref);
      return ref;
    });
    const first = registry.refFor(element());
    registry.refFor(element());
    refs[0]!.element = undefined;
    expect(registry.resolve(first).status).toBe('gone');
    expect(registry.size).toBe(2);
    registry.sweep();
    expect(registry.size).toBe(1);
    expect(registry.resolve(first).status).toBe('gone');
  });

  it('does not reuse ids after a sweep', () => {
    const refs: FakeRef[] = [];
    const registry = new RefRegistry((el: Element) => {
      const ref = new FakeRef(el);
      refs.push(ref);
      return ref;
    });
    registry.refFor(element());
    refs[0]!.element = undefined;
    registry.sweep();
    expect(registry.refFor(element())).toBe('ref_2');
  });
});
