import { beginModelCall, markRuntimeFirstToken, meteredFetch, performanceSnapshot,
  recordAssistantGeneration, runtimeState, setModelStage, withModelRuntime, publicPerformanceSnapshot,
  queuedPerformanceSnapshot, advancePerformanceSnapshot, completedPerformanceSnapshot, withPublicActivity } from './model-runtime';

describe('public runtime progress and assistant output completion',()=>{
  const originalFetch=global.fetch;
  afterEach(()=>{global.fetch=originalFetch;jest.restoreAllMocks();});
  const usage={prompt_tokens:10,completion_tokens:4};
  test('progress aggregates only allowlisted stages, records public first text once and isolates tasks',async()=>{
    const snapshots:any[]=[];
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('query_rewrite');
      beginModelCall('chat','fixture',30,20).finish(usage,false,'stop');
      expect(runtimeState()?.stage).toBe('query_rewrite');
      expect(performanceSnapshot()).toMatchObject({stage:'preparing',phase:'understanding'});
      expect(performanceSnapshot()?.firstTokenMs).toBeNull();
      setModelStage('tools');setModelStage('verification');
      markRuntimeFirstToken();const first=performanceSnapshot()?.firstTokenMs;
      markRuntimeFirstToken();expect(performanceSnapshot()?.firstTokenMs).toBe(first);
      setModelStage('completed');
      expect(performanceSnapshot()).toMatchObject({stage:'completed',firstTokenMs:expect.any(Number)});
      expect(performanceSnapshot()?.stages.every(s=>s.durationMs>=0)).toBe(true);
      expect(JSON.stringify(snapshots)).not.toContain('query_rewrite');
      await withModelRuntime(new AbortController().signal,async()=>{
        expect(performanceSnapshot()?.stage).toBe('preparing');
        expect(performanceSnapshot()?.firstTokenMs).toBeNull();
      });
      expect(performanceSnapshot()?.stage).toBe('completed');
    },undefined,undefined,snapshot=>snapshots.push(snapshot));
    expect(snapshots.map(s=>s.stage).filter((stage,index,all)=>index===0||stage!==all[index-1]))
      .toEqual(['preparing','generating','preparing','tools','verifying','completed']);
    expect(performanceSnapshot()).toBeUndefined();
  });
  test('real queue, context and semantic processing durations remain distinct and counts settle once',async()=>{
    let now=1000; jest.spyOn(Date,'now').mockImplementation(()=>now);
    const snapshots:any[]=[];
    await withModelRuntime(new AbortController().signal,async()=>{
      expect(performanceSnapshot()).toMatchObject({phase:'context',elapsedMs:500,queueMs:500,modelCalls:0,activeModelCalls:0,
        phases:[{phase:'queued',durationMs:500,modelCalls:0},{phase:'context',durationMs:0,modelCalls:0}]});
      now+=20;setModelStage('retrieval');
      const embed=beginModelCall('embedding','fixture',10,0);
      now+=40;expect(performanceSnapshot()).toMatchObject({phase:'retrieving',phaseElapsedMs:40,activeModelCalls:1,modelCalls:1});
      embed.finish({total_tokens:10});embed.finish({total_tokens:10});
      expect(performanceSnapshot()?.activeModelCalls).toBe(0);
      now+=10;setModelStage('verification');const check=beginModelCall('chat','fixture',10,20);
      now+=30;check.finish(usage);markRuntimeFirstToken();setModelStage('completed');
      const result=performanceSnapshot();
      expect(result).toMatchObject({phase:'completed',elapsedMs:600,firstTokenMs:600,modelCalls:2,activeModelCalls:0,
        phases:[{phase:'queued',durationMs:500,modelCalls:0},{phase:'context',durationMs:20,modelCalls:0},
          {phase:'retrieving',durationMs:50,modelCalls:1},{phase:'verifying',durationMs:30,modelCalls:1},
          {phase:'completed',durationMs:0,modelCalls:0}]});
      expect(JSON.stringify(result)).not.toMatch(/fixture|retrieval|verification|prompt|reasoning/);
    },undefined,undefined,value=>snapshots.push(value),500);
    expect(snapshots.some(s=>s.activeModelCalls===1)).toBe(true);
    expect(snapshots.some(s=>s.modelCalls===2&&s.activeModelCalls===0)).toBe(true);
  });
  test('persisted and legacy progress is allowlisted rather than spreading arbitrary server/model data',()=>{
    const progress=publicPerformanceSnapshot({stage:'generating',elapsedMs:12,firstTokenMs:-1,
      secret:'private text',reasoning_content:'private reasoning',phase:'generating',phaseElapsedMs:7,
      queueMs:3,modelCalls:2,activeModelCalls:1,activity:'web_search',
      modelOutput:{thinkingChars:11,textChars:7,toolChars:3,lastDataElapsedMs:9,reasoningContent:'private reasoning'},
      stages:[{stage:'generating',durationMs:12,prompt:'private'},{stage:'untrusted',durationMs:4}],
      phases:[{phase:'generating',durationMs:7,modelCalls:2,toolOutput:'private'},{phase:'prompt injection',durationMs:1,modelCalls:1}]});
    expect(progress).toEqual({stage:'generating',elapsedMs:12,firstTokenMs:null,
      stages:[{stage:'generating',durationMs:12}],phase:'generating',phaseElapsedMs:7,queueMs:3,modelCalls:2,activeModelCalls:1,
      activity:'web_search',modelOutput:{thinkingChars:11,textChars:7,toolChars:3,lastDataElapsedMs:9},
      phases:[{phase:'generating',durationMs:7,modelCalls:2}]});
    expect(JSON.stringify(progress)).not.toContain('private reasoning');
    expect(publicPerformanceSnapshot({stage:'generating',elapsedMs:1,activity:'private_activity',
      modelOutput:{thinkingChars:1,textChars:-1,toolChars:0,lastDataElapsedMs:1}}))
      .toEqual({stage:'generating',elapsedMs:1,firstTokenMs:null,stages:[]});
    expect(publicPerformanceSnapshot({stage:'private stage',elapsedMs:1})).toBeUndefined();
    expect(publicPerformanceSnapshot({stage:'generating',elapsedMs:Infinity})).toBeUndefined();
    expect(publicPerformanceSnapshot({stage:'preparing',elapsedMs:2,stages:[]}))
      .toEqual({stage:'preparing',elapsedMs:2,firstTokenMs:null,stages:[]});
  });
  test('queue and persisted heartbeat extrapolation do not double count queue or advance completed work',()=>{
    const queued=queuedPerformanceSnapshot(new Date(1000),1500);
    expect(queued).toMatchObject({phase:'queued',elapsedMs:500,queueMs:500,phaseElapsedMs:500,modelCalls:0});
    const active={...queued,phase:'generating' as const,phaseElapsedMs:100,elapsedMs:800,
      phases:[{phase:'queued' as const,durationMs:500,modelCalls:0},{phase:'generating' as const,durationMs:100,modelCalls:1}]};
    expect(advancePerformanceSnapshot(active,200)).toMatchObject({queueMs:500,elapsedMs:1000,phaseElapsedMs:300,
      phases:[{phase:'queued',durationMs:500},{phase:'generating',durationMs:300}]});
    const completed={...active,stage:'completed' as const,phase:'completed' as const};
    expect(advancePerformanceSnapshot(completed,200)).toBe(completed);
  });
  test('heartbeat extrapolation advances only the current thinking segment and never resets cumulative generation time',()=>{
    const active={stage:'generating' as const,phase:'thinking' as const,elapsedMs:77600,firstTokenMs:null,
      stages:[{stage:'generating' as const,durationMs:77000}],phaseElapsedMs:74400,queueMs:600,
      phases:[{phase:'queued' as const,durationMs:600,modelCalls:0},{phase:'generating' as const,durationMs:2500,modelCalls:1},
        {phase:'thinking' as const,durationMs:74400,modelCalls:0}],modelCalls:1,activeModelCalls:1};
    expect(advancePerformanceSnapshot(active,500)).toEqual({...active,elapsedMs:78100,phaseElapsedMs:74900,
      stages:[{stage:'generating',durationMs:77500}],phases:[{phase:'queued',durationMs:600,modelCalls:0},
        {phase:'generating',durationMs:2500,modelCalls:1},{phase:'thinking',durationMs:74900,modelCalls:0}]});
  });
  test('public activity overlays are fixed enums, nest safely and never carry operation content',async()=>{
    const snapshots:any[]=[], secret='private activity input must not become progress';
    await withModelRuntime(new AbortController().signal,async()=>{
      await withPublicActivity('web_search',async()=>{
        expect(secret.length).toBeGreaterThan(0);
        expect(performanceSnapshot()?.activity).toBe('web_search');
        await withPublicActivity('save_file',async()=>expect(performanceSnapshot()?.activity).toBe('save_file'));
        expect(performanceSnapshot()?.activity).toBe('web_search');
      });
      expect(performanceSnapshot()).not.toHaveProperty('activity');
    },undefined,undefined,value=>snapshots.push(value));
    expect(snapshots.some(value=>value.activity==='web_search')).toBe(true);
    expect(snapshots.some(value=>value.activity==='save_file')).toBe(true);
    expect(JSON.stringify(snapshots)).not.toContain(secret);
  });
  test('transactional completion metadata does not mark an uncommitted live task completed',async()=>{
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('delivery');
      expect(completedPerformanceSnapshot()).toMatchObject({stage:'completed',phase:'completed',phaseElapsedMs:0});
      expect(performanceSnapshot()).toMatchObject({stage:'preparing',phase:'delivering'});
      setModelStage('completed');expect(performanceSnapshot()?.phase).toBe('completed');
    });
    expect(completedPerformanceSnapshot()).toBeUndefined();
  });
  test('temporary vision calls restore the outer tool phase so the rest of the tool is not model time',async()=>{
    let now=1000;jest.spyOn(Date,'now').mockImplementation(()=>now);
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('tools');now+=10;
      const vision=beginModelCall('chat','fixture',10,20,undefined,'attachment_vision');
      now+=30;expect(performanceSnapshot()).toMatchObject({phase:'generating',activeModelCalls:1});
      vision.finish(usage);expect(performanceSnapshot()).toMatchObject({stage:'tools',phase:'tools',activeModelCalls:0});
      now+=30;
      expect(performanceSnapshot()?.phases).toEqual([{phase:'context',durationMs:0,modelCalls:0},
        {phase:'tools',durationMs:40,modelCalls:0},{phase:'generating',durationMs:30,modelCalls:1}]);
    });
  });
  test('parallel model tickets restore only their own current overlay, in either finish order',async()=>{
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('tools');
      const first=beginModelCall('chat','fixture',10,20,undefined,'attachment_vision');
      const second=beginModelCall('chat','fixture',10,20,undefined,'verification');
      first.setResponsePhase('thinking');
      expect(performanceSnapshot()).toMatchObject({phase:'verifying',activeModelCalls:2});
      first.finish(usage);
      expect(performanceSnapshot()).toMatchObject({phase:'verifying',activeModelCalls:1});
      second.finish(usage);expect(performanceSnapshot()).toMatchObject({phase:'tools',activeModelCalls:0});
      const third=beginModelCall('chat','fixture',10,20,undefined,'attachment_vision');
      const fourth=beginModelCall('chat','fixture',10,20,undefined,'verification');
      fourth.finish(usage);expect(performanceSnapshot()).toMatchObject({phase:'generating',activeModelCalls:1});
      third.finish(usage);expect(performanceSnapshot()).toMatchObject({phase:'tools',activeModelCalls:0});
      expect(runtimeState()?.modelOverlays.size).toBe(0);
    });
  });
  test('an explicit stage change invalidates old overlays, even when the stage label repeats',async()=>{
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('tools');
      const first=beginModelCall('chat','fixture',10,20,undefined,'attachment_vision');
      setModelStage('verification');first.setResponsePhase('thinking');first.finish(usage);
      expect(performanceSnapshot()).toMatchObject({phase:'verifying',activeModelCalls:0});
      const second=beginModelCall('chat','fixture',10,20,undefined,'attachment_vision');
      setModelStage('verification');
      const third=beginModelCall('chat','fixture',10,20,undefined,'attachment_vision');
      second.finish(usage);expect(performanceSnapshot()).toMatchObject({phase:'generating',activeModelCalls:1});
      third.finish(usage);expect(performanceSnapshot()).toMatchObject({phase:'verifying',activeModelCalls:0});
    });
  });
  test('completed public elapsed, phases and call counts freeze before derived memory and ledger work',async()=>{
    let now=1000;jest.spyOn(Date,'now').mockImplementation(()=>now);
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('conversation');const answer=beginModelCall('chat','fixture',10,20);
      now+=80;answer.finish(usage);markRuntimeFirstToken();setModelStage('completed');
      const committed=performanceSnapshot();
      expect(committed).toMatchObject({phase:'completed',elapsedMs:580,firstTokenMs:580,queueMs:500,modelCalls:1});
      now+=5000;setModelStage('context');
      const derived=beginModelCall('embedding','fixture',10,0);
      now+=1000;derived.finish({total_tokens:10});
      expect(runtimeState()?.calls).toBe(2); // Original usage observation still includes all real calls.
      expect(performanceSnapshot()).toEqual(committed);
      expect(performanceSnapshot()?.phases?.find(entry=>entry.phase==='completed')?.durationMs).toBe(0);
    },undefined,undefined,undefined,500);
  });
  test('observation callback failure never aborts generation',async()=>{
    await expect(withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('generating');return 'ok';
    },undefined,undefined,()=>{throw Error('diagnostic failure');})).resolves.toBe('ok');
  });
  test.each(['length','stop'])('nonstream finish reason %s is retained without an automatic retry',async reason=>{
    let calls=0;
    global.fetch=jest.fn(async()=>{calls++;return Response.json({choices:[{finish_reason:reason,message:{content:'text'}}],usage});}) as any;
    await withModelRuntime(new AbortController().signal,async()=>{
      const result=await meteredFetch()('https://invalid.test/chat',{method:'POST',body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'hello'}],max_tokens:10000})});
      await result.json();
      // Internal requests alone do not publish a continuation suggestion.
      expect(runtimeState()?.assistantGeneration).toBeUndefined();
      expect(recordAssistantGeneration()).toEqual({finishReason:reason,truncated:reason==='length',canContinue:reason==='length'});
      expect(calls).toBe(1);
    });
  });
  test('stream length reason survives arbitrary chunk boundaries and is not confused with usage-only events',async()=>{
    const payload='data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}]})+'\n\n'+
      'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\n'+
      'data: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n';
    const bytes=new TextEncoder().encode(payload);
    global.fetch=jest.fn(async()=>new Response(new ReadableStream({start(controller){
      controller.enqueue(bytes.subarray(0,31));controller.enqueue(bytes.subarray(31));controller.close();
    }}))) as any;
    await withModelRuntime(new AbortController().signal,async()=>{
      const response=await meteredFetch()('https://invalid.test/chat',{method:'POST',body:JSON.stringify({model:'fixture',stream:true,messages:[],max_tokens:10000})});
      expect(await response.text()).toBe(payload);
      expect(recordAssistantGeneration()).toEqual({finishReason:'length',truncated:true,canContinue:true});
      expect(runtimeState()?.observedTokens).toBe(14);
      expect(performanceSnapshot()?.firstTokenMs).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
  test('streamed provider reasoning exposes only a real thinking phase, then returns to public generation',async()=>{
    const secret='private chain of thought that must never enter progress';
    const events=[
      'data: '+JSON.stringify({choices:[{delta:{reasoning_content:secret},finish_reason:null}]})+'\n\n',
      'data: '+JSON.stringify({choices:[{delta:{content:'public answer'},finish_reason:null}]})+'\n\n',
      'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n',
      'data: '+JSON.stringify({choices:[],usage:{...usage,completion_tokens_details:{reasoning_tokens:3}}})+'\n\n',
      'data: [DONE]\n\n',
    ];
    let now=1000,index=0;jest.spyOn(Date,'now').mockImplementation(()=>now);
    global.fetch=jest.fn(async()=>new Response(new ReadableStream({pull(controller){
      if(index>=events.length){controller.close();return;}
      now += index===0?20:index===1?80:10;
      controller.enqueue(new TextEncoder().encode(events[index++]));
    }}))) as any;
    const snapshots:any[]=[];
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('conversation');
      const response=await meteredFetch()('https://invalid.test/chat',{method:'POST',body:JSON.stringify({
        model:'fixture',stream:true,enable_thinking:true,messages:[],max_tokens:10000})});
      expect(await response.text()).toBe(events.join(''));
      const progress=performanceSnapshot();
      expect(snapshots.some(snapshot=>snapshot.phase==='thinking')).toBe(true);
      expect(snapshots.some((snapshot,index,all)=>snapshot.phase==='generating'&&all.slice(0,index).some(previous=>previous.phase==='thinking'))).toBe(true);
      expect(progress?.phases?.find(phase=>phase.phase==='thinking')?.durationMs).toBeGreaterThanOrEqual(0);
      expect(progress?.modelOutput).toEqual({thinkingChars:secret.length,textChars:'public answer'.length,toolChars:0,
        lastDataElapsedMs:expect.any(Number)});
      expect(runtimeState()?.steps.at(-1)?.reasoningTokens).toBe(3);
      expect(JSON.stringify({snapshots,progress,runtime:runtimeState()})).not.toContain(secret);
    },undefined,undefined,snapshot=>snapshots.push(snapshot));
  });
  test('reasoning-shaped provider fields are ignored when the server request disabled thinking',async()=>{
    const secret='unexpected private provider field';
    const payload='data: '+JSON.stringify({choices:[{delta:{reasoning_content:secret},finish_reason:null}]})+'\n\n'+
      'data: '+JSON.stringify({choices:[{delta:{content:'answer'},finish_reason:'stop'}],usage})+'\n\n'+
      'data: [DONE]\n\n';
    global.fetch=jest.fn(async()=>new Response(payload)) as any;
    const snapshots:any[]=[];
    await withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('conversation');
      const response=await meteredFetch()('https://invalid.test/chat',{method:'POST',body:JSON.stringify({
        model:'fixture',stream:true,enable_thinking:false,messages:[],max_tokens:10000})});
      await response.text();
      expect(snapshots.some(snapshot=>snapshot.phase==='thinking')).toBe(false);
      expect(performanceSnapshot()?.modelOutput).toEqual({thinkingChars:0,textChars:'answer'.length,toolChars:0,
        lastDataElapsedMs:expect.any(Number)});
      expect(JSON.stringify({snapshots,progress:performanceSnapshot()})).not.toContain(secret);
    },undefined,undefined,snapshot=>snapshots.push(snapshot));
  });
  test('tool calls and unknown finish reasons are never treated as a text truncation',async()=>{
    await withModelRuntime(new AbortController().signal,async()=>{
      beginModelCall('chat','fixture',10,20).finish(usage,false,'tool_calls');
      expect(recordAssistantGeneration()).toMatchObject({canContinue:false,truncated:false});
      beginModelCall('chat','fixture',10,20).finish(usage,false,'arbitrary private provider detail');
      expect(recordAssistantGeneration()).toEqual({finishReason:null,truncated:false,canContinue:false});
    });
  });
});
