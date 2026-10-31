export interface ElementRef {
  deref(): Element | undefined;
}

export type RefResolution =
  | { status: 'found'; element: Element }
  | { status: 'not-found' }
  | { status: 'gone' };

const REF_PATTERN = /^ref_([1-9]\d*)$/;

export class RefRegistry {
  private counter = 0;
  private readonly elements = new Map<string, ElementRef>();
  private readonly refs = new WeakMap<Element, string>();

  constructor(private readonly makeRef: (element: Element) => ElementRef = (element) => new WeakRef(element)) {}

  get size(): number {
    return this.elements.size;
  }

  refFor(element: Element): string {
    const existing = this.refs.get(element);
    if (existing !== undefined && this.elements.has(existing)) return existing;
    this.counter += 1;
    const ref = `ref_${this.counter}`;
    this.elements.set(ref, this.makeRef(element));
    this.refs.set(element, ref);
    return ref;
  }

  resolve(ref: string): RefResolution {
    if (!this.wasIssued(ref)) return { status: 'not-found' };
    const element = this.elements.get(ref)?.deref();
    if (element === undefined || !element.isConnected) return { status: 'gone' };
    return { status: 'found', element };
  }

  sweep(): void {
    for (const [ref, elementRef] of this.elements) {
      if (elementRef.deref() === undefined) this.elements.delete(ref);
    }
  }

  private wasIssued(ref: string): boolean {
    const match = REF_PATTERN.exec(ref);
    return match !== null && Number(match[1]) <= this.counter;
  }
}
