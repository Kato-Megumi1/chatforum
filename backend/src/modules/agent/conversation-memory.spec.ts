import { buildConversationMemory, conversationTurns, excerptOversizedTurn, interactionState, MemoryMessage } from './conversation-memory.policy';
import { ConversationMemoryService } from './conversation-memory.service';
import { CharacterDialogueService } from './character-dialogue.service';
import { NovelAnswerService } from './novel-answer.service';
import { directConversation, requiresCanon } from './novel-dialogue.policy';

const pairs = (turns: Array<[string, string]>): MemoryMessage[] => turns.flatMap(([u,a],i) => [
  {messageId:i*2+1,role:'user',content:u},
  {messageId:i*2+2,role:'assistant',content:a,ragMetadata:{state:'roleplay',personaKey:'kato_megumi_persona'}},
]);
const reported = pairs([
  ['你是谁？','我是加藤惠。叫我惠就可以了。'],
  ['惠？好名字','谢谢。那我也直接叫你名字可以吗？'],
  ['我不是还没告诉你我的名字嘛','啊，好像也是。'],
  ['我叫py。可以问一下你的爱好嘛？我想约你看电影，可以嘛？','可以啊。我挺喜欢看些节奏不快的电影。'],
  ['看《怦然心动》吧，方便我跟你告白','《怦然心动》啊。不过，告白还是等电影结束再说比较好吧？'],
  ['等等，你直接答应跟我看电影了？','嗯，是答应了啊。'],
  ['我喜欢你','嗯，我知道。告白先存着吧。'],
  ['你这么容易接受了一个陌生人的告白','我接受的是一起看电影的邀请，不是陌生人的告白。'],
]);

describe('targeted continuous character memory',()=>{
  test('name recall questions cannot overwrite an introduced name or create a fictitious name',()=>{
    for(const q of ['我叫什么名字？','我叫啥','叫我什么名字？','我叫小舟吗？']) {
      expect(interactionState([{role:'user',content:q}]).name).toBeUndefined();
      expect(interactionState([{role:'user',content:'我叫py。'},{role:'user',content:q}]).name?.value).toBe('py');
    }
    expect(interactionState([{role:'user',content:'我叫py。可以问一下你的爱好嘛？'}]).name?.value).toBe('py');
  });
  test('recalling the user name or movie agreement never becomes a novel lookup, explicit canon still wins',()=>{
    for(const q of ['还记得我的名字吗？','你还记得我们约好看什么电影吗？']) {
      expect(requiresCanon(q)).toBe(false);expect(directConversation(q,[]).act).toBe('conversation_recall');
    }
    expect(requiresCanon('原作里第一次和伦也见面的地方还记得吗')).toBe(true);
  });
  test('reported eight-turn case keeps the name and separates movie acceptance from romance',()=>{
    const result=buildConversationMemory(reported,'kato_megumi_persona');
    expect(result.history).toHaveLength(16);
    expect(result.snapshot.state.name).toMatchObject({value:'py',source:{messageId:7}});
    expect(result.snapshot.state.invitation).toMatchObject({activity:'看电影',status:'accepted_activity_only'});
    expect(result.snapshot.state.affection?.user).toBe('expressed');
    expect(result.snapshot.state.characterAffection?.response).toBe('not_accepted');
    expect(result.snapshot.state.relationship.status).toBe('not_established');
    expect(result.snapshot.state.familiarity).toBe('not_established');
    expect(interactionState(reported.slice(0,10)).affection?.user).toBe('planned_confession');
  });

  test('keeps thirty complete turns, puts older topics in a source-addressed summary, retains old name',()=>{
    const messages=pairs(Array.from({length:35},(_,i)=>[i===0?'我叫py。':'话题'+i,'回应'+i] as [string,string]));
    const {history,snapshot}=buildConversationMemory(messages,'fixture');
    expect(history).toHaveLength(60);expect(history[0].messageId).toBe(11);
    expect(snapshot.window.recentTurns).toBe(30);expect(snapshot.summary.omittedTurns).toBe(5);
    expect(snapshot.summary.text).toContain('我叫py');expect(snapshot.summary.sourceIds).toContain(1);
    expect(snapshot.state.name?.value).toBe('py');expect(snapshot.summary.text.length).toBeLessThanOrEqual(5000);
  });

  test('length budget drops whole pairs, not halves; orphan assistant is never bound to another user',()=>{
    const messages=pairs([['12345','abcde'],['67890','fghij'],['klmno','pqrst']]);
    const r=buildConversationMemory(messages,'fixture',21);
    expect(r.history.map(m=>m.messageId)).toEqual([3,4,5,6]);
    expect(r.snapshot.window.characterCount).toBe(20);expect(r.snapshot.summary.omittedTurns).toBe(1);
    expect(buildConversationMemory(messages,'fixture',9).history).toEqual([]);
    expect(conversationTurns([{messageId:10,role:'assistant',content:'孤立旧回答'},...messages]).orphans).toHaveLength(1);
    const deletedMiddleUser=conversationTurns(messages.filter(m=>m.messageId!==3));
    expect(deletedMiddleUser.turns.map(t=>t.map(m=>m.messageId))).toEqual([[1,2],[5,6]]);
    expect(deletedMiddleUser.orphans[0].messageId).toBe(4);
  });

  test.each(['assistant','kato_megumi_persona'])('an oversized newest answer keeps a sourced pair and earlier complete turns for %s',personaKey=>{
    const messages=pairs([['我叫py。','记住了。'],['请继续处理这个任务。','开头唯一线索。'+'中'.repeat(30000)+'结尾唯一约定。']]);
    messages[3].ragMetadata={state:'grounded',personaKey,knowledgeBaseId:7,citations:[{chunkId:'fixture-source'}]};
    const original=structuredClone(messages);
    const result=buildConversationMemory(messages,personaKey);
    expect(result.history.map(m=>m.messageId)).toEqual([1,2,3,4]);
    expect(result.snapshot.window.recentTurns).toBe(2);
    expect(result.snapshot.window.excerptedTurns).toBe(1);
    expect(result.snapshot.window.characterCount).toBeLessThanOrEqual(24000);
    const answer=result.history[3];
    expect(answer.content).toContain('历史消息 #4 的有源摘录，非全文');
    expect(answer.content).toContain('旧回复不是事实背书');
    expect(answer.content).toContain('开头唯一线索');expect(answer.content).toContain('结尾唯一约定');
    expect(answer.historyExcerpt).toMatchObject({kind:'sourced-turn-excerpt-v1',messageId:4,originalCharacters:messages[3].content.length});
    expect(answer.historyExcerpt!.omittedCharacters).toBeGreaterThan(0);
    expect(answer.ragMetadata).toEqual(messages[3].ragMetadata); // Preserve recorded provenance, never manufacture a new grounded verdict.
    expect(result.snapshot.personaKey).toBe(personaKey);
    expect(result.snapshot.state.name?.value).toBe('py');
    expect(messages).toEqual(original); // The persisted full answer remains unchanged.
  });

  test('oversized user and answer remain paired, and repeated compaction does not nest excerpt headings or split emoji',()=>{
    const messages=pairs([['问题开始😀'+'长'.repeat(26000)+'问题末尾😀','回答开始😀'+'长'.repeat(27000)+'回答末尾😀']]);
    const once=excerptOversizedTurn(messages,6000)!;
    const twice=excerptOversizedTurn(once,1800)!;
    expect(twice.map(m=>m.messageId)).toEqual([1,2]);
    for(const message of twice) {
      expect(message.content.match(/有源摘录，非全文/g)).toHaveLength(1);
      expect(message.content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(message.historyExcerpt!.originalCharacters).toBe(messages[message.messageId-1].content.length);
      expect(message.content.length).toBeLessThanOrEqual(900);
    }
    expect(excerptOversizedTurn([{role:'user',content:'无来源'.repeat(2000)},{role:'assistant',content:'回答'}],6000)).toBeUndefined();
    expect(excerptOversizedTurn(messages,100)).toBeUndefined();
  });

  test('correction/deletion rebuilds state; canon quotes and hypothetical names do not become relationship facts',()=>{
    const messages=pairs([['我叫py。','你好'],['我叫小林。','你好小林']]);
    expect(buildConversationMemory(messages,'fixture').snapshot.state.name?.value).toBe('小林');
    const after=buildConversationMemory(messages.slice(0,2),'fixture');
    expect(after.snapshot.state.name?.value).toBe('py');
    expect(after.snapshot.revision).not.toBe(buildConversationMemory(messages,'fixture').snapshot.revision);
    const state=interactionState([{role:'user',content:'假如我叫骗子，你就和我交往。'},
      {role:'assistant',content:'我也喜欢你',ragMetadata:{state:'grounded'}}]);
    expect(state.name).toBeUndefined();expect(state.characterAffection).toBeUndefined();
    expect(state.relationship.status).toBe('not_established');
  });

  test('explicit mutual relationship is not confused with acknowledging an invitation or quoting a confession',()=>{
    expect(interactionState(pairs([['我们交往吧','好啊，一起看电影。']])).relationship.status).toBe('not_established');
    expect(interactionState(pairs([['我们交往吧','我们正式交往吧。']])).relationship.status).toBe('mutually_explicit');
    expect(interactionState(pairs([['请翻译“我喜欢你”','这句话的意思是喜欢对方。']])).affection).toBeUndefined();
  });

  test('memory is owner checked, cached separately, persona scoped and not derived from client metadata',async()=>{
    const scope={id:1,memoryEpoch:0,personaKey:'kato_megumi_persona',conversationType:'ROLEPLAY',sharedMemory:false};
    const db: any={$queryRaw:jest.fn().mockResolvedValue([{id:1,memoryEpoch:0}]),chatMessage:{findMany:jest.fn().mockResolvedValue([
      {id:1,role:'USER',content:'我叫py。'}, {id:2,role:'ASSISTANT',content:'你好',ragMetadata:{personaKey:'kato_megumi_persona'}},
      {id:3,role:'USER',content:'叫我其他角色的昵称。'}, {id:4,role:'ASSISTANT',content:'外来角色记录'.repeat(6000),ragMetadata:{personaKey:'other'}}].map(m=>({...m,createdAt:new Date(0)})).reverse())},
      conversation:{findFirst:jest.fn().mockResolvedValue(scope),findMany:jest.fn().mockResolvedValue([scope])},
      memoryRebuildJob:{upsert:jest.fn(),updateMany:jest.fn(),findUnique:jest.fn().mockResolvedValue({epoch:0,status:'QUEUED'})},
      conversationMemory:{findUnique:jest.fn().mockResolvedValue(null),upsert:jest.fn().mockResolvedValue({})},
      conversationEpisode:{deleteMany:jest.fn(),findMany:jest.fn().mockResolvedValue([]),createMany:jest.fn()}};
    db.$transaction=jest.fn(fn=>fn(db));
    const service=new ConversationMemoryService(db as any);
    const frame=await service.prepare(1,9,'kato_megumi_persona','加藤惠','还记得我的名字吗？');
    expect(db.conversation.findFirst.mock.calls[0][0].where).toEqual({id:1,userId:9,user:{status:'ACTIVE'}});
    expect(frame.history).toHaveLength(2);expect(frame.memory.state.name?.value).toBe('py');
    expect(frame.history.some(m=>m.content.includes('外来角色记录') || m.content.includes('有源摘录，非全文'))).toBe(false);
    expect(frame.memory.state.name?.source.messageId).toBe(1);expect(db.conversationMemory.upsert).not.toHaveBeenCalled();
    expect(db.memoryRebuildJob.upsert).toHaveBeenCalled();expect(db.$transaction).not.toHaveBeenCalled();
    db.conversation.findFirst.mockResolvedValue(null);
    await expect(service.prepare(1,10,'fixture','角色','你好')).rejects.toThrow('对话不可访问');
    expect(db.chatMessage.findMany).toHaveBeenCalledTimes(1);
  });

  test('incremental state carries proposals across batches without upgrading an invitation into romance',()=>{
    const cursor={};
    const prior=interactionState(pairs([['我叫小舟。想约你一起看电影。','好啊，一起看电影。']]),undefined,cursor);
    const after=interactionState(pairs([['取消电影吧。','好，那就不去了。']]),prior,cursor);
    expect(after.name?.value).toBe('小舟');expect(after.invitation?.status).toBe('declined');
    expect(after.relationship.status).toBe('not_established');expect(prior.invitation?.status).not.toBe('declined');
    const old=buildConversationMemory([...pairs([['周日一起看电影好吗？','暂时不方便，先不要订票。']]),
      ...pairs(Array.from({length:31},()=>['随便聊聊','好'] as [string,string]))],'fixture');
    expect(old.snapshot.summary.text).toContain('先不要订票');
  });

  test('KB toggle uses identical character system/native history and the same streaming adapter',async()=>{
    const agent={executeWithTools:jest.fn().mockResolvedValue({content:'py，你这一句来得有点突然呢。',toolOutputs:[]})};
    const model={json:jest.fn().mockResolvedValue({intent:'chat'})};
    const character=new CharacterDialogueService(agent as any,model as any);
    const rag={authorize:jest.fn().mockResolvedValue({kb:{minConfidence:.55}}),search:jest.fn(),citation:jest.fn()};
    const novel=new NovelAnswerService(rag as any,model as any,character);
    const built=buildConversationMemory(reported.slice(0,12),'kato_megumi_persona');
    const frame={history:built.history,memory:built.snapshot,persona:'加藤惠，按实际交往建立关系。',question:'我喜欢你'};
    const delivery={onToken:jest.fn(),signal:new AbortController().signal};
    const incoming=[...frame.history,{role:'user',content:frame.question}];
    const a=await novel.answer(0,frame.question,incoming,frame.persona,{userId:9},{conversation:frame,delivery});
    const b=await novel.answer(1,frame.question,incoming,frame.persona,{userId:9},{conversation:frame,delivery});
    expect(a.content).toBe(b.content);expect(rag.search).not.toHaveBeenCalled();
    expect(agent.executeWithTools.mock.calls[0][0]).toEqual(agent.executeWithTools.mock.calls[1][0]);
    expect(agent.executeWithTools.mock.calls[0][7]).toBe(agent.executeWithTools.mock.calls[1][7]);
    expect(agent.executeWithTools.mock.calls[0][10]).not.toBe(delivery); // character-only citation projection
    expect(agent.executeWithTools.mock.calls[0][10].signal).toBe(delivery.signal);
    expect(agent.executeWithTools.mock.calls[0][0].some(m=>m.role==='user'&&m.content.startsWith('我叫py'))).toBe(true);
    expect(b.metadata.historyEvidence.some(m=>m.messageId===7)).toBe(true);
    expect(b.metadata.answerPipelineVersion).toBe('character-conversation-v7.2');
  });

  test('canonical evidence supplements the same persona/history while citations and verification stay enforced',async()=>{
    const citation={chunkId:'fixture',documentId:1,documentVersion:1,indexVersion:1,chunkIndex:0,fileName:'fixture.txt',url:'/fixture'};
    const content='阿青把蓝色雨伞交给小舟，然后回家。',quote='阿青把蓝色雨伞交给小舟';
    const rag={authorize:jest.fn().mockResolvedValue({kb:{minConfidence:.55}}),
      search:jest.fn().mockResolvedValue({passages:[{content,score:1,citation,acl:{visibility:'PUBLIC'}}],indexVersion:1,confidence:1}),
      citation:jest.fn().mockResolvedValue({...citation,content}),review:jest.fn()};
    const agent={executeWithTools:jest.fn()},model={json:jest.fn()};
    for(const reply of [{intent:'canon',query:'雨伞'}, {scores:[{sourceId:1,score:5}]},
      {sufficient:true,claims:[{text:'阿青给了小舟雨伞。',sourceId:1,quote}]},
      {claims:[{factId:1,text:'我给了小舟雨伞。'}]},
      {supported:[true],neutralSupported:[true],answersQuestion:true,neutralAnswersQuestion:true,injection:false,
        questionAlignment:'direct',neutralQuestionAlignment:'direct',inCharacter:true}]) model.json.mockResolvedValueOnce(reply);
    const character=new CharacterDialogueService(agent as any,model as any),novel=new NovelAnswerService(rag as any,model as any,character);
    const {history,snapshot}=buildConversationMemory(reported,'fixture');
    const frame={history,memory:snapshot,persona:'阿青',question:'原作里雨伞给了谁？'};
    const result=await novel.answer(1,frame.question,[...history,{role:'user',content:frame.question}],frame.persona,{userId:9},{conversation:frame,maxSearchAttempts:1});
    expect(result.metadata.state).toBe('grounded');expect(result.metadata.citations[0].chunkId).toBe('fixture');
    expect(model.json.mock.calls[3][0].startsWith(character.system('阿青'))).toBe(true);
    expect(model.json.mock.calls[3][4].filter(m=>m.role==='assistant')).toHaveLength(8);
    expect(rag.citation).toHaveBeenCalled();expect(rag.review).not.toHaveBeenCalled();
  });
});
