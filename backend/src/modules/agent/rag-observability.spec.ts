import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ragHistoryContext, storedRagMessage, historyEvidenceManifest } from './rag-history';
import { NovelAnswerService } from './novel-answer.service';
import { ChatRunService } from '../chat/chat-run.service';
import { RagService } from './rag.service';

const text = '阿青把蓝色雨伞交给小舟，然后独自回家。';
const quote = '阿青把蓝色雨伞交给小舟';
const citation = {chunkId:'fixture-a',documentId:2,documentVersion:3,indexVersion:5,chunkIndex:8,
  fileName:'fixture.txt',chapter:'第一章',page:2,url:'/rag/knowledge-bases/1/citations/fixture-a'};
const metadata = {state:'grounded',knowledgeBaseId:1,indexVersion:5,citations:[{...citation,label:1,quote}],
  hiddenPrompt:'must-not-propagate',historyEvidence:[{recursive:'must-not-propagate'}]};
const passage = {content:text,score:1,citation,acl:{visibility:'INHERIT'}};
const source = () => jest.fn().mockResolvedValue({...citation,content:text});
const facts = {sufficient:true,claims:[{text:'阿青给了小舟雨伞。',sourceId:1,quote}]};
const voice = {claims:[{factId:1,text:'我给了小舟雨伞。'}]};
const failedCheck = {supported:[false],neutralSupported:[false],answersQuestion:true,neutralAnswersQuestion:false,injection:false,
  questionAlignment:'direct',neutralQuestionAlignment:'unresolved',inCharacter:true};

function setup(responses:any[]) {
  const rag = {authorize:jest.fn().mockResolvedValue({kb:{minConfidence:.55}}),principal:jest.fn().mockResolvedValue({id:2}),
    search:jest.fn().mockResolvedValue({passages:[passage],confidence:.9,indexVersion:5}),citation:source(),review:jest.fn().mockResolvedValue(14)};
  const model = {json:jest.fn(async (...args:any[]) => {
    if (args[0].includes('CONTINUATION_CHECK_V2')) return { unsupportedClaims: [], continuity: true, bounded: true,
      citationsValid: true, inCharacter: true, injection: false };
    const response = responses.shift();
    return args[0].includes('CONTINUATION_DRAFT_V2') ? { ...response, factIds: [] } : response;
  })};
  return {rag,model,novel:new NovelAnswerService(rag as any,model as any)};
}

describe('targeted history provenance and failure diagnostics',()=>{
  test('history preserves source/version/state, never promotes an old unverified answer, and bounds recursive metadata',async()=>{
    const lookup=source();
    const context=await ragHistoryContext([
      storedRagMessage({id:1,role:'ASSISTANT',content:'旧的无引用回答'}),
      storedRagMessage({id:2,role:'ASSISTANT',content:'已引用的回答',ragMetadata:metadata}),
      {role:'user',content:'当前问题',ragMetadata:metadata},
    ],1,lookup);
    expect(context[0].evidence).toMatchObject({recordedState:'legacy_unverified',verification:'unverified',citations:[]});
    expect(context[1]).toMatchObject({messageId:2,role:'assistant',evidence:{recordedState:'grounded',verification:'historical_check_only',
      knowledgeBaseId:1,indexVersion:5,citations:[{...citation,access:'available',quote,quoteStatus:'verbatim'}]}});
    expect(context[2].evidence).toMatchObject({recordedState:'user_statement',citations:[]});
    expect(JSON.stringify(context)).not.toContain('must-not-propagate');
    expect(JSON.stringify(historyEvidenceManifest(context))).not.toContain(quote);
  });

  test('new historical references respect current ACL and KB boundaries without removing message text',async()=>{
    const lookup=jest.fn().mockRejectedValue(new ForbiddenException());
    const old=storedRagMessage({id:3,role:'ASSISTANT',content:'保留这条历史文本',ragMetadata:metadata});
    const [denied]=await ragHistoryContext([old],1,lookup);
    expect(denied.content).toBe(old.content);
    expect(denied.evidence.citations[0]).toMatchObject({access:'unavailable',documentVersion:3,indexVersion:5});
    expect(denied.evidence.citations[0].quote).toBeUndefined();
    const [other]=await ragHistoryContext([old],9,lookup);
    expect(other.evidence.citations[0].access).toBe('different_knowledge_base');expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('worker -> RAG -> model -> persisted message retains authenticated provenance',async()=>{
    const s=setup([{reply:'你好。'}]);
    const saved: any[]=[];
    const tx={chatRun:{updateMany:jest.fn().mockResolvedValue({count:1})},chatMessage:{createMany:jest.fn(async data=>{saved.push(...data.data);})},
      conversation:{update:jest.fn().mockResolvedValue({})}};
    const db={chatMessage:{findMany:jest.fn().mockResolvedValue([
      {id:12,role:'ASSISTANT',content:'历史回答',ragMetadata:metadata},
      {id:11,role:'USER',content:'历史问题',ragMetadata:null},
    ])},chatRun:tx.chatRun,$transaction:jest.fn(async fn=>fn(tx))};
    const memory={prepare:jest.fn().mockResolvedValue({persona:'阿青',question:'你好',history:[
      storedRagMessage({id:11,role:'USER',content:'历史问题'}),
      storedRagMessage({id:12,role:'ASSISTANT',content:'历史回答',ragMetadata:metadata}),
    ],memory:{version:'conversation-memory-v1',personaKey:'fixture',revision:'fixture',window:{},summary:{omittedTurns:0}}}),
      assertCurrentSources:jest.fn()};
    const runs=new ChatRunService(db as any,s.novel,s.rag as any,{} as any,memory as any,{} as any);
    await (runs as any).executeSelected({id:'run',userId:2,conversationId:1,input:{question:'你好',knowledgeBaseId:1,mode:'agent'}},'worker',new AbortController().signal);
    expect(s.model.json.mock.calls[0][1].history[1]).toMatchObject({messageId:12,evidence:{recordedState:'grounded',citations:[{quote}]}});
    expect(saved).toHaveLength(2);
    expect(saved[1].ragMetadata).toMatchObject({diagnosticsVersion:'rag-evidence-trace-v1',historyEvidence:[
      {messageId:11},{messageId:12,recordedState:'grounded',citations:[{chunkId:'fixture-a',documentVersion:3} ]},{kind:'user_statement'},
    ]});
    expect(s.rag.search).not.toHaveBeenCalled();
  });

  test.each([
    ['empty',[],[], 'retrieval','retrieval','NO_HITS'],
    ['low',[passage],[{scores:[{sourceId:1,score:2}]}], 'retrieval','rerank','LOW_RELEVANCE'],
    ['insufficient',[passage],[{scores:[{sourceId:1,score:5}]},{sufficient:false,claims:[]}], 'evidence','evidence','EVIDENCE_INSUFFICIENT'],
    ['quote',[passage],[{scores:[{sourceId:1,score:5}]},{sufficient:true,claims:[{...facts.claims[0],quote:'没有存在于原文的引用'}]}], 'evidence','evidence','INVALID_EVIDENCE_FORMAT'],
    ['verify',[passage],[{scores:[{sourceId:1,score:5}]},facts,voice,failedCheck], 'evidence','verification','VERIFICATION_FAILED'],
  ])('%s has a distinct phase/category without changing the retry or fallback path',async(_id,passages,responses,category,stage,code)=>{
    const s=setup([{intent:'canon'},...responses as any[],{reply:'这处细节我还不太确定。'}]);
    s.rag.search.mockResolvedValue({passages,confidence:.9,indexVersion:5});
    const result=await s.novel.answer(1,'第一次见面',[],'阿青',{userId:2},{maxSearchAttempts:1});
    expect(result.metadata.state).toBe('needs_review');expect(s.rag.search).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('这处细节我还不太确定。');
    expect(result.metadata.diagnostics.finalFailure).toEqual({category,stage,code});
    expect(s.rag.review.mock.calls[0][4]).toContain(`[${category}/${stage}/${code}]`);
    if(_id==='quote')expect(result.metadata.searchAttempts[0].evidence.issues).toContainEqual({claim:1,code:'QUOTE_NOT_VERBATIM'});
    if(_id==='verify')expect(result.metadata.searchAttempts[0].verification.supported).toEqual([false]);
  });

  test('model error records the failing stage, without storing exception text as evidence',async()=>{
    const s=setup([]);s.model.json.mockRejectedValueOnce(new Error('private fixture marker'));
    await expect(s.novel.answer(1,'第一次见面',[],'阿青',{userId:2},{maxSearchAttempts:1})).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(s.rag.review.mock.calls[0][4]).toContain('[service/routing/STAGE_ERROR]');
    expect(s.rag.review.mock.calls[0][4]).not.toContain('private fixture marker');
  });

  test('a failed vector channel is recorded separately from a successful empty lexical search',async()=>{
    const db={ragIndexVersion:{findUnique:jest.fn().mockResolvedValue({id:1,status:'ACTIVE',collectionName:'fixture',manifest:{}})},
      knowledgeBaseDocument:{findMany:jest.fn().mockResolvedValue([{id:2}])},knowledgeChunk:{findMany:jest.fn().mockResolvedValue([])},
      $queryRawUnsafe:jest.fn().mockResolvedValue([])};
    const rag=new RagService(db as any,{} as any,{embed:jest.fn().mockRejectedValue(new Error('fixture'))} as any,{} as any);
    jest.spyOn(rag,'authorize').mockResolvedValue({kb:{id:1,ownerId:2,activeIndexVersion:5,embeddingModel:'fixture'},user:{id:2,role:'USER'}} as any);
    const result=await rag.search(1,'阿青雨伞',{userId:2},6,undefined,{graph:false});
    expect(result.passages).toEqual([]);expect(result.degraded).toBe(true);
    expect(result.retrieval).toEqual({status:'complete',channels:{semantic:'error',lexical:'ok',graph:'skipped'},counts:{semantic:0,lexical:0,graph:0}});
  });
});
