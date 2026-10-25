import { sceneEventCard, eventCandidates } from './scene-event-memory';
import { ragHistoryContext } from './rag-history';
import { NovelAnswerService } from './novel-answer.service';

const quote='加藤惠把眼镜送给安艺伦也';
const citation={chunkId:'fixture',documentId:1,documentVersion:1,indexVersion:1,chunkIndex:0,fileName:'fixture.txt',chapter:'第一卷 第一章',url:'/fixture'};
const claim={text:quote+'。',quote,sourceId:1,event:{actor:'加藤惠',recipient:'安艺伦也',action:'送给',object:'眼镜'}};
const card=sceneEventCard(claim,citation,true,true)!;
const old={role:'assistant',messageId:2,content:'我送了眼镜。',ragMetadata:{state:'grounded',knowledgeBaseId:1,indexVersion:1,citations:[{...citation,quote}],sceneEvents:[card]}};
const passage={content:quote+'。他接过了礼物。',citation,score:1,acl:{visibility:'PRIVATE'}};
const verdict={supported:[true],neutralSupported:[true],eventSupported:[true],answersQuestion:true,neutralAnswersQuestion:true,
  questionAlignment:'direct',neutralQuestionAlignment:'direct',inCharacter:true,injection:false};

describe('source-addressed scene memory',()=>{
  test('event roles require an independent verdict and remain historical, never inferred time or motive',()=>{
    expect(card).toMatchObject({actor:'加藤惠',recipient:'安艺伦也',object:'眼镜',storyTime:null,verification:'historical_check_only'});
    expect(sceneEventCard(claim,citation,true,false)).toBeUndefined();
    expect(sceneEventCard({...claim,event:{...claim.event,object:'未出现的手表'}},citation,true,true)).toBeUndefined();
  });
  test('ACL, version and scope are rechecked before historical cards can assist retrieval',async()=>{
    const source=jest.fn().mockResolvedValue({...citation,content:passage.content});
    const context=await ragHistoryContext([old],1,source);
    expect(context[0].evidence.events[0].citation.url).toBe('/rag/knowledge-bases/1/citations/fixture');
    expect(eventCandidates(context,'为什么送眼镜',1)).toHaveLength(1);
    expect(eventCandidates(context,'为什么送眼镜',2)).toHaveLength(0);
    expect(eventCandidates(context,'第二卷为什么送眼镜',1)).toHaveLength(0);
    expect((await ragHistoryContext([old],2,source))[0].evidence.events).toEqual([]);
    source.mockRejectedValue(new Error('not readable'));
    expect(eventCandidates(await ragHistoryContext([old],1,source),'为什么送眼镜',1)).toHaveLength(0);
  });
  test('gift then motive follows the verified event through rewrite, retrieval and independent verification',async()=>{
    const rag={authorize:jest.fn().mockResolvedValue({kb:{minConfidence:.55,activeIndexVersion:1}}),citation:jest.fn().mockResolvedValue({...citation,content:passage.content}),
      search:jest.fn().mockResolvedValue({passages:[passage],indexVersion:1,confidence:1}),historyPassages:jest.fn().mockResolvedValue([passage]),review:jest.fn()};
    const model={json:jest.fn()};
    for(const r of [{intent:'canon',query:'加藤惠 礼物'},{scores:[{sourceId:1,score:5}]},{sufficient:true,claims:[claim]},
      {claims:[{factId:1,text:'我送了眼镜给伦也。'}]},verdict,
      {intent:'canon',query:'为什么送眼镜',eventId:card.id},{scores:[{sourceId:1,score:5}]},{sufficient:true,claims:[claim]},
      {claims:[{factId:1,text:'送的是眼镜。至于用意，我觉得可以从当时的互动来理解。'}]},verdict])model.json.mockResolvedValueOnce(r);
    const service=new NovelAnswerService(rag as any,model as any);
    const first=await service.answer(1,'原作里你送给伦也什么？',[],'加藤惠',{userId:1},{maxSearchAttempts:1});
    expect(first.metadata.sceneEvents).toHaveLength(1);
    const second=await service.answer(1,'为什么你当时送他眼镜？',[{role:'user',messageId:1,content:'你送给伦也什么？'},
      {role:'assistant',messageId:2,content:first.content,ragMetadata:first.metadata}],'加藤惠',{userId:1},{maxSearchAttempts:1});
    expect(second.metadata.state).toBe('grounded');
    expect(rag.search.mock.calls[1][1]).toContain('加藤惠');expect(rag.search.mock.calls[1][1]).toContain('安艺伦也');
    expect(model.json.mock.calls[6][1].questionTarget.historicalEvent.id).toBe(card.id);
    expect(rag.historyPassages).toHaveBeenCalled();expect(model.json.mock.calls[9][1].claims[0].evidence).toBe(passage.content);
    expect(rag.review).not.toHaveBeenCalled();
  });
});
