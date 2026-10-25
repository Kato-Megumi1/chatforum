// Question identity travels with every stage. Search rewrites are hypotheses, not authority.
export const ANSWER_TARGET_RULE =
  'questionTarget.originalQuestion 始终是要回答的问题，persona 指明当前交谈的角色。' +
  '用户对角色说的“你”指 persona，不是原文叙述者；resolvedQuery 只辅助消解指代，不能改掉原问题。' +
  '逐一核对谁做了什么、对谁、在何时，不能只因动作或收礼人相同，就用另一个人的事件回答。' +
  '例如问甲是否送乙礼物，丙送乙、或甲送丁，均不能证明甲送乙，也不能证明甲从未送乙。' +
  '只有证据明确对应用户所指的同一个具体事件，才可纠正其中的人物前提；泛问是否发生过时，' +
  '另一个送礼场景不构成反证。不要用用户的猜测或历史助理的说法确认事实。';

export type QuestionAlignment = 'direct' | 'supported_correction' | 'different_event' | 'unresolved';
export interface AnswerVerification {
  supported: boolean[];
  neutralSupported: boolean[];
  eventSupported?: boolean[];
  answersQuestion: boolean;
  neutralAnswersQuestion: boolean;
  questionAlignment: QuestionAlignment;
  neutralQuestionAlignment: QuestionAlignment;
  inCharacter: boolean;
  injection: boolean;
}

export function aligned(value: unknown): boolean {
  return value === 'direct' || value === 'supported_correction';
}

export function knownAlignment(value: unknown): boolean {
  return aligned(value) || value === 'different_event' || value === 'unresolved';
}

export function verifiedVoice(check: AnswerVerification, count: number, persona: string): boolean {
  return check?.injection === false && check.answersQuestion === true && aligned(check.questionAlignment) &&
    (!persona.trim() || check.inCharacter === true) &&
    Array.isArray(check.supported) && check.supported.length === count && check.supported.every(s => s === true);
}

export function repairableFacts(check: AnswerVerification, count: number): boolean {
  return check?.injection === false && check.neutralAnswersQuestion === true && aligned(check.neutralQuestionAlignment) &&
    Array.isArray(check.neutralSupported) && check.neutralSupported.length === count && check.neutralSupported.every(s => s === true);
}

export function validVoiceMapping(value: unknown, count: number): value is Array<{ factId: number; text: string }> {
  return Array.isArray(value) && value.length === count && new Set(value.map(c => c?.factId)).size === count &&
    value.every(c => c && Number.isInteger(c.factId) && c.factId >= 1 && c.factId <= count &&
      typeof c.text === 'string' && c.text.trim().length > 0 && c.text.length <= 1200);
}
