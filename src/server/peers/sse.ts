/**
 * A minimal Server-Sent Events reader for the peer stream (D48): `event:` + `data:`
 * lines, frames separated by a blank line, comments (`: keepalive`) ignored. Only
 * what `/hub` and `/peer/v1/events` send (one `data:` line per frame; several are
 * joined with `\n` per the SSE rules).
 */

/** One received frame. */
export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/** Splits a growing text stream into frames. */
export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];

  /** Feeds a chunk; returns the frames it completed. */
  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const cut = this.#buffer.search(/\r?\n/);
      if (cut < 0) break;
      const line = this.#buffer.slice(0, cut);
      this.#buffer = this.#buffer.slice(this.#buffer[cut] === '\r' ? cut + 2 : cut + 1);
      if (line === '') {
        if (this.#data.length > 0) frames.push({ event: this.#event || 'message', data: this.#data.join('\n') });
        this.#event = '';
        this.#data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.#event = value;
      else if (field === 'data') this.#data.push(value);
    }
    return frames;
  }
}

/**
 * Reads `body` to its end (or until `signal` aborts), calling `onFrame` per frame
 * and `onChunk` for every chunk received (keepalive comments too: the stall check
 * of the peer connection).
 */
export async function readSse(body: ReadableStream<Uint8Array>, onFrame: (frame: SseFrame) => void, signal?: AbortSignal, onChunk?: () => void): Promise<void> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) onFrame(frame);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
