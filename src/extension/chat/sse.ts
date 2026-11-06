export interface SseEvent {
  event: string;
  data: string;
}

// Server-sent events parser over decoded text; chunks may split lines and CRLF pairs anywhere.
export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let start = 0;
    for (;;) {
      const cr = this.buffer.indexOf('\r', start);
      const lf = this.buffer.indexOf('\n', start);
      if (cr === -1 && lf === -1) break;
      const end = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
      let next = end + 1;
      if (end === cr) {
        if (end + 1 >= this.buffer.length) break;
        if (this.buffer[end + 1] === '\n') next = end + 2;
      }
      const event = this.line(this.buffer.slice(start, end));
      if (event) events.push(event);
      start = next;
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  // At end of stream a held CR still ends its line; an unterminated last line is discarded.
  flush(): SseEvent[] {
    const events = this.buffer.endsWith('\r') ? this.push('\n') : [];
    this.buffer = '';
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') {
      const event = this.dataLines.length > 0 ? { event: this.eventName || 'message', data: this.dataLines.join('\n') } : undefined;
      this.eventName = '';
      this.dataLines = [];
      return event;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return undefined;
  }
}
