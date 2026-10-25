/**
 * Request-local transport compatibility for providers that require their original
 * reasoning_content on subsequent assistant tool-call messages. LangChain's
 * OpenAI adapter currently drops that field when rebuilding its scratchpad.
 *
 * This is not user-visible reasoning: it is never returned by this helper,
 * logged, attached to task metadata, or reused by another execution.
 */
export function providerToolReasoningFetch(transport: typeof fetch) {
  const turns = new Map<string, Map<number, string>>();
  let closed = false;
  const key = (calls: unknown): string | undefined => {
    if (!Array.isArray(calls) || !calls.length) return undefined;
    const ids = calls.map(call => call?.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return undefined;
    return JSON.stringify(ids);
  };
  const save = (calls: unknown, text: unknown, messageIndex: number) => {
    const signature = key(calls);
    if (!closed && signature && typeof text === 'string') {
      const positions = turns.get(signature) || new Map<number, string>();
      positions.set(messageIndex, text); turns.set(signature, positions);
    }
  };
  const fetchWithReasoning = (async (url: any, init: any) => {
    let body: any;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { /* Transport handles invalid input. */ }
    const messages: any[] | undefined = Array.isArray(body?.messages) ? body.messages : undefined;
    if (!closed && messages) {
      let changed = false;
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        const signature = key(message.tool_calls), saved = signature ? turns.get(signature)?.get(index) : undefined;
        // Do not attach a current turn's reasoning to historical messages that
        // happen to use the same tool-call IDs.
        if (saved !== undefined && message.reasoning_content !== saved) { message.reasoning_content = saved; changed = true; }
      }
      if (changed) {
        // The SDK may provide an explicit byte length for its original JSON.
        // Let fetch recompute it after injecting the provider's private field.
        const headers = new Headers(init.headers); headers.delete('content-length');
        init = { ...init, headers, body: JSON.stringify(body) };
      }
    }
    const response = await transport(url, init);
    if (closed || !response.ok || !messages) return response;
    if (!body.stream) {
      const data = await response.clone().json();
      const message = data?.choices?.find((choice: any) => choice.index === 0)?.message || data?.choices?.[0]?.message;
      if (message?.role === 'assistant') save(message.tool_calls, message.reasoning_content, messages.length);
      return response;
    }
    if (!response.body) return response;
    // Parse only protocol metadata while forwarding every original byte. Do not
    // buffer the provider response or forward reasoning as public text tokens.
    const decoder = new TextDecoder();
    let pending = '', reasoning = '', hasReasoning = false;
    const calls = new Map<number, { id: string }>();
    const line = (value: string) => {
      if (!value.startsWith('data:')) return;
      const encoded = value.slice(5).trim();
      if (!encoded || encoded === '[DONE]') return;
      let data: any;
      try { data = JSON.parse(encoded); } catch { return; }
      const choice = data?.choices?.find((candidate: any) => candidate.index === 0);
      if (!choice) return;
      const delta = choice.delta;
      if (typeof delta?.reasoning_content === 'string') { hasReasoning = true; reasoning += delta.reasoning_content; }
      for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        if (!Number.isSafeInteger(call?.index) || call.index < 0) continue;
        const previous = calls.get(call.index) || { id: '' };
        if (typeof call.id === 'string') previous.id += call.id;
        calls.set(call.index, previous);
      }
      // Commit before [DONE]: SDK consumers may stop/cancel the stream at its
      // sentinel without asking for the underlying ReadableStream flush.
      if (hasReasoning && choice.finish_reason === 'tool_calls') save([...calls].sort((a, b) => a[0] - b[0]).map(([, call]) => call), reasoning, messages.length);
    };
    const transformed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n'); pending = lines.pop() || '';
        for (const value of lines) line(value.replace(/\r$/, ''));
        controller.enqueue(chunk);
      },
      flush() { pending += decoder.decode(); if (pending) line(pending.replace(/\r$/, '')); },
    }));
    return new Response(transformed, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  return { fetch: fetchWithReasoning, clear() { closed = true; turns.clear(); } };
}
