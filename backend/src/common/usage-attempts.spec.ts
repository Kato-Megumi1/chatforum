import { recordUsageSnapshot, recordUsageStep, usageStepRow } from './usage-ledger';
describe('resumed durable task usage is append-only per execution attempt',()=>{
  const owner={scope:'CHAT' as const,sourceId:'same-run',userId:3,createdAt:new Date(0)};
  const step={kind:'chat' as const,model:'fixture',inputTokens:10,outputTokens:20,status:'ok' as const};
  test('ordinary historical keys remain stable; attempt IDs are not database columns',()=>{
    expect(usageStepRow(owner,step,0).sourceKey).toBe('CHAT:same-run:0');
    const row=usageStepRow({...owner,attemptId:'execution-one'},step,0);
    expect(row.sourceKey).toBe('CHAT:same-run:attempt:execution-one:0');
    expect(row).not.toHaveProperty('attemptId');expect(row.sourceId).toBe('same-run');
  });
  test('a second execution at index zero is retained while replaying its repair is idempotent',async()=>{
    const stored=new Map<string,any>();
    const db={modelUsageEntry:{createMany:jest.fn(async({data})=>{for(const row of data)if(!stored.has(row.sourceKey))stored.set(row.sourceKey,row);})}};
    const first={...owner,attemptId:'10000000-0000-4000-8000-000000000001'},second={...owner,attemptId:'10000000-0000-4000-8000-000000000002'};
    await recordUsageStep(db as any,first,step as any,0);await recordUsageStep(db as any,second,step as any,0);
    await recordUsageSnapshot(db as any,owner,{attemptId:second.attemptId,steps:[step]});
    expect(stored.size).toBe(2);expect([...stored.values()].reduce((sum,row)=>sum+row.outputTokens,0)).toBe(40);
    expect([...stored.values()].every(row=>row.sourceId===owner.sourceId)).toBe(true);
  });
});
