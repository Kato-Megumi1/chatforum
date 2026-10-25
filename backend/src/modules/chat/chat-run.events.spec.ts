import { MAX_PUBLIC_TEXT_FRAME_UNITS, publicTerminalResult, runEvents } from './chat-run.events';

describe('durable SSE delivery', () => {
  test('public generation progress is delivered separately without changing text offsets', async () => {
    let complete = false;
    const stream = runEvents(async () => ({ status: complete ? 'COMPLETED' : 'RUNNING',
      progress: {stage:'verifying',phase:'thinking',elapsedMs:3500,firstTokenMs:null,stages:[],
        phases:[{phase:'thinking',durationMs:3200,modelCalls:1,reasoning_content:'SECRET_INNER'}],
        reasoning_content:'SECRET_REASONING',description:'SECRET_DESCRIPTION'}, result:{content:''} }), 0, new AbortController().signal);
    expect((await stream.next()).value.event).toBe('status');
    const progress = (await stream.next()).value;
    expect(progress).toMatchObject({event:'progress',data:{stage:'verifying',phase:'thinking',elapsedMs:3500,
      phases:[{phase:'thinking',durationMs:3200,modelCalls:1}]}});
    expect(JSON.stringify(progress)).not.toContain('SECRET_');
    complete = true;
    const rest = []; for await (const event of stream) rest.push(event);
    expect(rest.at(-1).event).toBe('complete');
    expect(rest.some(event=>event.event==='delta')).toBe(false);
  });
  test('long-running healthy tasks have no whole-subscription deadline', async () => {
    let now=0,complete=false;const time=jest.spyOn(Date,'now').mockImplementation(()=>now);
    try {
      const stream=runEvents(async()=>({status:complete?'COMPLETED':'RUNNING',result:{content:''}}),0,new AbortController().signal);
      expect((await stream.next()).value.event).toBe('status');
      now=60*60*1000;
      expect((await stream.next()).value.event).toBe('ping');
      complete=true;
      const rest=[];for await(const e of stream)rest.push(e);
      expect(rest.at(-1).event).toBe('complete');
      expect(rest.some(e=>e.event==='terminal')).toBe(false);
    } finally {time.mockRestore();}
  });
  test('ordinary text is delivered while the run is still RUNNING', async () => {
    let completed = false;
    const read = jest.fn(async () => ({ status: completed ? 'COMPLETED' : 'RUNNING',
      result: { content: completed ? '你好世界' : '你好' } }));
    const stream = runEvents(read, 0, new AbortController().signal);
    expect((await stream.next()).value.event).toBe('status');
    expect((await stream.next()).value).toMatchObject({ event: 'delta', id: 2, data: { text: '你好' } });
    expect(completed).toBe(false);
    completed = true;
    const rest = []; for await (const event of stream) rest.push(event);
    expect(rest.filter(e => e.event === 'delta').map(e => e.data.text).join('')).toBe('世界');
    expect(rest.at(-1).event).toBe('complete');
  });

  test('verified buffered answers have bounded Unicode-safe frames and final citations', async () => {
    const content = '惠🌸'.repeat(2500);
    const read = jest.fn(async () => ({ status: 'COMPLETED', result: { content, ragMetadata: { citations: [{ label: 1 }] } } }));
    const events = []; for await (const event of runEvents(read, 0, new AbortController().signal)) events.push(event);
    const deltas = events.filter(e => e.event === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThanOrEqual(Math.ceil(content.length / (MAX_PUBLIC_TEXT_FRAME_UNITS - 1)));
    expect(deltas.every(e => e.data.text.length <= MAX_PUBLIC_TEXT_FRAME_UNITS)).toBe(true);
    expect(deltas.map(e => e.data.text).join('')).toBe(content);
    expect(deltas.every(e => !/[\uD800-\uDBFF]$/.test(e.data.text))).toBe(true);
    expect(events.at(-1)).toMatchObject({event:'complete',data:{result:{ragMetadata:{citations:[{label:1}]}}}});
  });

  test('reconnect resumes at the cursor without regenerating or duplicating the prefix', async () => {
    const content = '已经收到。后面的回答';
    const events = []; for await (const e of runEvents(async () => ({ status:'COMPLETED', result:{content} }), 5, new AbortController().signal)) events.push(e);
    expect(events.filter(e=>e.event==='delta').map(e=>(e.data as any).text).join('')).toBe(content.slice(5));
  });

  test('a cursor inside a Unicode surrogate pair is rejected rather than delivering malformed text', async () => {
    const stream = runEvents(async () => ({ status: 'COMPLETED', result: { content: '🌸回答' } }), 1, new AbortController().signal);
    await expect(stream.next()).rejects.toThrow('Invalid stream offset');
  });

  test('cancelled/failed tasks never deliver saved partial drafts', async () => {
    for (const status of ['CANCELLED','FAILED']) {
      const events = []; for await (const e of runEvents(async()=>({status,result:{content:'must not leak'}}),0,new AbortController().signal)) events.push(e);
      expect(events).toEqual([{event:'terminal',data:{status,error:undefined}}]);
    }
  });

  test.each(['FAILED', 'CANCELLED'])('%s terminal delivers safe error and file-resume metadata, not buffered code or private fields', async status => {
    const ref = { draftId: '10000000-0000-4000-8000-000000000001', revision: 2, hash: 'a'.repeat(64) };
    const result = { content: 'PRIVATE_BUFFERED_CODE', privateState: { content: 'PRIVATE_FILE_SOURCE' },
      failure: { stage: 'generation', code: 'GENERATION_FAILED', message: '本次回答未完成。', providerResponse: 'PRIVATE_PROVIDER' },
      ragMetadata: { generation: { finishReason: null, fileIncomplete: true, truncated: true, canContinue: true,
        fileFailureReason: 'SERVICE_ERROR', resumeFile: { ...ref, content: 'PRIVATE_EXTRA' }, filePaths: ['page.html', '../private.html'],
        reasoning_content: 'PRIVATE_REASONING', toolArguments: 'PRIVATE_TOOL_ARGS' },
      source: 'PRIVATE_SOURCE', fileArtifacts: [{ content: 'PRIVATE_ARTIFACT' }] } };
    const events = [];
    for await (const event of runEvents(async () => ({ status, result, error: '本次回答未完成。' }), 0, new AbortController().signal)) events.push(event);
    expect(events).toEqual([{ event: 'terminal', data: { status, error: '本次回答未完成。', result: {
      failure: { stage: 'generation', code: 'GENERATION_FAILED', message: '本次回答未完成。' },
      ragMetadata: { generation: { finishReason: null, fileIncomplete: true, truncated: true, canContinue: true,
        fileFailureReason: 'SERVICE_ERROR', resumeFile: ref, filePaths: ['page.html'] } } } } }]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });

  test('terminal projection rejects malformed resume objects and unbounded/unrecognized metadata', () => {
    const projected = publicTerminalResult({ failure: { stage: 'PRIVATE <raw>', code: 'bad code', message: 'x'.repeat(501) },
      ragMetadata: { generation: { finishReason: 'PRIVATE_REASONING', canContinue: 'yes', truncated: 1,
        fileFailureReason: 'PRIVATE_UNKNOWN', resumeFile: { draftId: '../wrong', revision: -1, hash: 'bad' },
        filePaths: ['../unsafe', '.env'] } } });
    expect(projected).toBeUndefined();
  });

  test('revocation between chunks blocks further delivery, even after generation completed', async () => {
    const read = jest.fn().mockResolvedValueOnce({status:'COMPLETED',result:{content:'安全'.repeat(2500)}})
      .mockRejectedValueOnce(new Error('revoked'));
    const stream = runEvents(read,0,new AbortController().signal);
    await stream.next(); expect((await stream.next()).value.event).toBe('delta');
    await expect(stream.next()).rejects.toThrow('revoked');
  });

  test('disconnect releases the subscription without cancelling the durable task', async () => {
    const controller = new AbortController();
    const read = jest.fn(async()=>({status:'RUNNING'}));
    const stream = runEvents(read,0,controller.signal);
    await stream.next(); controller.abort();
    await expect(stream.next()).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('buffered code catches up without a per-frame typing delay and retains artifact metadata', async () => {
    const content = '<div>示例🌸</div>'.repeat(2000), artifact = { changeId: 71, path: 'synthetic.html' };
    const read = jest.fn(async () => ({ status: 'COMPLETED', result: { content, ragMetadata: { fileArtifacts: [artifact] } } }));
    const started = performance.now(), events = [];
    for await (const event of runEvents(read, 0, new AbortController().signal)) events.push(event);
    expect(events.filter(e => e.event === 'delta').map(e => e.data.text).join('')).toBe(content);
    expect(read.mock.calls.length).toBeLessThan(30);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(events.at(-1)).toMatchObject({ event: 'complete', data: { result: { ragMetadata: { fileArtifacts: [artifact] } } } });
  });
});
