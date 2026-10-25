import { providerToolReasoningFetch } from './provider-tool-reasoning';

const toolCalls = (...ids: string[]) => ids.map(id => ({ id, type: 'function', function: { name: 'fixture', arguments: '{}' } }));
const request = (messages: any[], stream = false): RequestInit => ({ method: 'POST', body: JSON.stringify({ model: 'fixture', messages, stream }) });
const response = (ids: string[], reasoning: unknown) => Response.json({ choices: [{ index: 0,
  message: { role: 'assistant', content: null, tool_calls: toolCalls(...ids), ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) }, finish_reason: 'tool_calls' }] });
const initial = [{ role: 'user', content: 'synthetic fixture' }];
const assistant = (...ids: string[]) => ({ role: 'assistant', content: '', tool_calls: toolCalls(...ids) });

describe('execution-local provider tool reasoning compatibility', () => {
  test('unchanged request bytes remain untouched; rewritten bodies discard only their stale Content-Length', async () => {
    const received: RequestInit[] = [];
    const bridge = providerToolReasoningFetch((async (_url: any, init: any) => {
      received.push(init); return response(['one'], '完整🌸reasoning');
    }) as typeof fetch);
    const firstBody = JSON.stringify({ model: 'fixture', messages: initial }, null, 2);
    const first = { method: 'POST', body: firstBody, headers: { 'Content-Length': String(Buffer.byteLength(firstBody)), Authorization: 'fixture-only' } };
    await bridge.fetch('https://fixture.invalid', first);
    expect(received[0]).toBe(first); expect(received[0].body).toBe(firstBody);
    const nextBody = JSON.stringify({ model: 'fixture', messages: [...initial, assistant('one')] }, null, 2);
    await bridge.fetch('https://fixture.invalid', { method: 'POST', body: nextBody,
      headers: { 'CONTENT-LENGTH': String(Buffer.byteLength(nextBody)), Authorization: 'fixture-only', 'Content-Type': 'application/json' } });
    const headers = new Headers(received[1].headers);
    expect(headers.has('content-length')).toBe(false);
    expect(headers.get('authorization')).toBe('fixture-only'); expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(received[1].body)).messages[1].reasoning_content).toBe('完整🌸reasoning');
    bridge.clear();
  });

  test('nonstream reasoning is replayed byte-for-byte only for the exact complete tool-call group', async () => {
    const received: any[] = [], text = '  仅供供应商继续工具回合\n🌸 line 2  ';
    const wire = jest.fn(async (_url: any, init: any) => { received.push(JSON.parse(init.body)); return response(['one', 'two'], text); });
    const bridge = providerToolReasoningFetch(wire as typeof fetch);
    try {
      await bridge.fetch('https://fixture.invalid', request(initial));
      const replay = [...initial, assistant('one', 'two'), { role: 'tool', tool_call_id: 'one', content: 'ok' },
        { role: 'tool', tool_call_id: 'two', content: 'ok' }];
      await bridge.fetch('https://fixture.invalid', request(replay));
      expect(received[1].messages[1].reasoning_content).toBe(text);
      expect(received[0].messages[0]).not.toHaveProperty('reasoning_content');
      for (const ids of [['one'], ['two', 'one'], ['one', 'unknown'], ['one', 'one']]) {
        await bridge.fetch('https://fixture.invalid', request([...initial, assistant(...ids)]));
        expect(received.at(-1).messages[1]).not.toHaveProperty('reasoning_content');
      }
      expect(replay[1]).not.toHaveProperty('reasoning_content');
    } finally { bridge.clear(); }
  });

  test('historical messages with colliding IDs and unrelated user messages never receive new reasoning', async () => {
    const received: any[] = [];
    const wire = jest.fn(async (_url: any, init: any) => { received.push(JSON.parse(init.body)); return response(['one'], 'current private reasoning'); });
    const bridge = providerToolReasoningFetch(wire as typeof fetch);
    const baseline = [assistant('one'), { role: 'tool', tool_call_id: 'one', content: 'old' }, ...initial];
    await bridge.fetch('https://fixture.invalid', request(baseline));
    await bridge.fetch('https://fixture.invalid', request([...baseline, assistant('one'), { role: 'user', tool_calls: toolCalls('one'), content: 'not assistant' }]));
    expect(received[1].messages[0]).not.toHaveProperty('reasoning_content');
    expect(received[1].messages[3].reasoning_content).toBe('current private reasoning');
    expect(received[1].messages[4]).not.toHaveProperty('reasoning_content');
    bridge.clear();
  });

  test('concurrent execution bridges cannot exchange reasoning even when provider IDs collide', async () => {
    const records: any[][] = [[], []];
    const bridges = records.map((received, index) => providerToolReasoningFetch((async (_url: any, init: any) => {
      received.push(JSON.parse(init.body)); return response(['same'], `private task ${index}`);
    }) as typeof fetch));
    await Promise.all(bridges.map(bridge => bridge.fetch('https://fixture.invalid', request(initial))));
    await Promise.all(bridges.map(bridge => bridge.fetch('https://fixture.invalid', request([...initial, assistant('same')]))));
    expect(records[0][1].messages[1].reasoning_content).toBe('private task 0');
    expect(records[1][1].messages[1].reasoning_content).toBe('private task 1');
    bridges.forEach(bridge => bridge.clear());
    await bridges[0].fetch('https://fixture.invalid', request([...initial, assistant('same')]));
    expect(records[0][2].messages[1]).not.toHaveProperty('reasoning_content');
  });

  test('successive provider turns reusing the same IDs retain each exact assistant position', async () => {
    const received: any[] = [];
    const bridge = providerToolReasoningFetch((async (_url: any, init: any) => {
      received.push(JSON.parse(init.body)); return response(['same'], `private round ${received.length}`);
    }) as typeof fetch);
    await bridge.fetch('https://fixture.invalid', request(initial));
    const first = [...initial, assistant('same'), { role: 'tool', tool_call_id: 'same', content: 'first' }];
    await bridge.fetch('https://fixture.invalid', request(first));
    await bridge.fetch('https://fixture.invalid', request([...first, assistant('same'), { role: 'tool', tool_call_id: 'same', content: 'second' }]));
    expect(received[2].messages[1].reasoning_content).toBe('private round 1');
    expect(received[2].messages[3].reasoning_content).toBe('private round 2');
    bridge.clear();
  });

  test.each([undefined, null])('missing reasoning %s is never synthesized as an empty string', async reasoning => {
    const received: any[] = [];
    const bridge = providerToolReasoningFetch((async (_url: any, init: any) => {
      received.push(JSON.parse(init.body)); return response(['one'], reasoning);
    }) as typeof fetch);
    await bridge.fetch('https://fixture.invalid', request(initial));
    await bridge.fetch('https://fixture.invalid', request([...initial, assistant('one')]));
    expect(received[1].messages[1]).not.toHaveProperty('reasoning_content');
    bridge.clear();
  });

  test('streaming reasoning and indexed tool IDs survive fragmented UTF-8/CRLF without changing response bytes', async () => {
    const event = (delta: any, finish_reason: unknown = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\r\n\r\n';
    const text = '完整🌸思考\ncontinued';
    const payload = event({ reasoning_content: '完整🌸' }) + event({ reasoning_content: '思考\ncontinued', tool_calls: [
      { index: 1, id: 'call_b' }, { index: 0, id: 'call_' }] }) + event({ tool_calls: [{ index: 0, id: 'a' }] }) +
      event({}, 'tool_calls') + 'data: [DONE]\r\n\r\n';
    const encoded = new TextEncoder().encode(payload), received: any[] = [];
    const bridge = providerToolReasoningFetch((async (_url: any, init: any) => {
      received.push(JSON.parse(init.body));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 7) controller.enqueue(encoded.slice(offset, offset + 7));
        controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch);
    expect(await (await bridge.fetch('https://fixture.invalid', request(initial, true))).text()).toBe(payload);
    await bridge.fetch('https://fixture.invalid', request([...initial, assistant('call_a', 'call_b')], true));
    expect(received[1].messages[1].reasoning_content).toBe(text);
    bridge.clear();
  });

  test('non-tool and incomplete streams cannot supply a later tool-call reasoning field', async () => {
    for (const finish of ['stop', null]) {
      const received: any[] = [];
      const payload = 'data: ' + JSON.stringify({ choices: [{ index: 0,
        delta: { reasoning_content: 'not reusable', tool_calls: [{ index: 0, id: 'one' }] }, finish_reason: finish }] }) + '\n\n';
      const bridge = providerToolReasoningFetch((async (_url: any, init: any) => {
        received.push(JSON.parse(init.body)); return new Response(payload);
      }) as typeof fetch);
      await (await bridge.fetch('https://fixture.invalid', request(initial, true))).text();
      await bridge.fetch('https://fixture.invalid', request([...initial, assistant('one')], true));
      expect(received[1].messages[1]).not.toHaveProperty('reasoning_content');
      bridge.clear();
    }
  });

  test('clearing an active stream prevents its late completion from retaining reasoning', async () => {
    const received: any[] = [];
    const payload = 'data: ' + JSON.stringify({ choices: [{ index: 0,
      delta: { reasoning_content: 'late private text', tool_calls: [{ index: 0, id: 'one' }] }, finish_reason: 'tool_calls' }] }) + '\n\n';
    const bridge = providerToolReasoningFetch((async (_url: any, init: any) => {
      received.push(JSON.parse(init.body)); return new Response(payload);
    }) as typeof fetch);
    const active = await bridge.fetch('https://fixture.invalid', request(initial, true));
    bridge.clear(); await active.text();
    await bridge.fetch('https://fixture.invalid', request([...initial, assistant('one')], true));
    expect(received[1].messages[1]).not.toHaveProperty('reasoning_content');
  });
});
