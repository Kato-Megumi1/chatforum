export interface SseFrame { event: string; data: string; id?: string }

// Fetch streams can split anywhere, including inside a Chinese UTF-8 character or CRLF.
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', event = 'message', data: string[] = [], id: string | undefined;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join('\n'), id };
          event = 'message'; data = []; id = undefined;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const key = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (key === 'event') event = value;
          if (key === 'data') data.push(value);
          if (key === 'id') id = value;
        }
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
