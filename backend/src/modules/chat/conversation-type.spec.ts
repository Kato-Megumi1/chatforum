import { conversationIdentity, assertConversationIdentity } from './conversation-type';
import { CharacterDialogueService } from '../agent/character-dialogue.service';
import { compactMemory } from '../agent/context-budget';
describe('assistant / persona identity boundary',()=>{
  test('ordinary AI and each role have disjoint server identities; custom prompts are fingerprinted',()=>{
    expect(conversationIdentity({})).toMatchObject({conversationType:'ASSISTANT',personaKey:'assistant'});
    const role=conversationIdentity({conversationType:'ROLEPLAY',persona:'kato_megumi_persona'});
    expect(()=>assertConversationIdentity(role)).toThrow('不能在同一会话切换身份');
    expect(()=>assertConversationIdentity(role,'kato_megumi_persona')).not.toThrow();
    expect(()=>assertConversationIdentity(role,'yukinoshita_yukino_persona')).toThrow();
    expect(()=>conversationIdentity({conversationType:'ASSISTANT',persona:'kato_megumi_persona'})).toThrow();
    expect(()=>conversationIdentity({conversationType:'ROLEPLAY',persona:'toString'})).toThrow();
    const custom=conversationIdentity({persona:'custom',customPersonaPrompt:'甲'});
    expect(()=>assertConversationIdentity(custom,'custom','乙')).toThrow();
    expect(()=>assertConversationIdentity({conversationType:'LEGACY',personaKey:null})).toThrow('旧消息已保留');
  });
  test('assistant prompt is independent from personality and relationship rules',()=>{
    const dialogue=new CharacterDialogueService({} as any,{} as any);
    expect(dialogue.system('加藤惠',true)).not.toContain('加藤惠');
    expect(dialogue.system('加藤惠',true)).not.toContain('一起看电影不等于答应恋爱');
    expect(dialogue.system('加藤惠')).toContain('一起看电影不等于答应恋爱');
    const state={name:{value:'py'},relationship:{status:'mutually_explicit'},affection:{user:'expressed'},
      preferences:[{value:'用户喜欢电影',source:{speaker:'user'}},{value:'角色喜欢散步',source:{speaker:'assistant'}}]};
    const memory=compactMemory({personaKey:'assistant',state});
    expect(memory.state.name).toEqual(state.name);
    expect(memory.state).not.toHaveProperty('relationship');
    expect(memory.state).not.toHaveProperty('affection');
    expect(memory.state.preferences).toHaveLength(1);
    expect(compactMemory({personaKey:'kato_megumi_persona',state}).state).toEqual(state);
  });
});
