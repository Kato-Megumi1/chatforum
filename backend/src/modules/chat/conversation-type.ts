import { BadRequestException, ConflictException } from '@nestjs/common';
import { personaMemoryKey } from '../agent/conversation-memory.policy';

export function conversationIdentity(input: { conversationType?: string; persona?: string; personaLabel?: string; customPersonaPrompt?: string }) {
  const type = input.conversationType || (input.persona ? 'ROLEPLAY' : 'ASSISTANT');
  if (!['ASSISTANT','ROLEPLAY'].includes(type)) throw new BadRequestException('请选择普通 AI 或角色扮演会话');
  if (type === 'ASSISTANT') {
    if (input.persona || input.customPersonaPrompt) throw new BadRequestException('普通 AI 会话不能配置角色身份');
    return { conversationType: type, personaKey: 'assistant', personaLabel: 'AI 助手', customPersonaPrompt: null };
  }
  const labels = { kato_megumi_persona: '加藤惠', yukinoshita_yukino_persona: '雪之下雪乃', custom: '自定义角色' };
  if (!Object.prototype.hasOwnProperty.call(labels,input.persona || '')) throw new BadRequestException('请选择有效角色');
  if (input.customPersonaPrompt && (typeof input.customPersonaPrompt !== 'string' || input.customPersonaPrompt.length > 6000))
    throw new BadRequestException('角色设定过长');
  return { conversationType: type, personaKey: personaMemoryKey(input.persona, input.customPersonaPrompt),
    personaLabel: input.persona === 'custom' ? String(input.personaLabel || labels.custom).slice(0,80) : labels[input.persona],
    customPersonaPrompt: input.persona === 'custom' ? input.customPersonaPrompt || '' : null };
}

export function assertConversationIdentity(conversation: { conversationType: string; personaKey: string | null }, persona?: string, custom?: string) {
  if (conversation.conversationType === 'LEGACY') throw new ConflictException('这段历史的身份不明确，请在普通 AI 或对应角色下新建会话；旧消息已保留');
  const key = personaMemoryKey(persona,custom);
  if (conversation.personaKey !== key || (conversation.conversationType === 'ASSISTANT') !== (key === 'assistant'))
    throw new ConflictException('不能在同一会话切换身份，请新建对应模式或角色的会话');
}
