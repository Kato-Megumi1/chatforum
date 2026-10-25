import { ServiceUnavailableException } from '@nestjs/common';
import { ToolStepUncertainError } from '../tool-runs/tool-run.policy';

export class ModelOutputError extends ServiceUnavailableException {
  constructor(readonly code: 'MODEL_OUTPUT_FORMAT' | 'MODEL_OUTPUT_TRUNCATED' | 'MODEL_SAFETY_BLOCKED') {
    super(code === 'MODEL_SAFETY_BLOCKED' ? '模型未返回可用回答' : '模型返回格式异常');
  }
}
export class AnswerStageError extends ServiceUnavailableException {
  constructor(readonly stage: string, readonly code: string) { super('回答处理暂时失败'); }
}
export class ModelRequestTimeoutError extends ServiceUnavailableException {
  readonly code = 'MODEL_REQUEST_TIMEOUT';
  constructor() { super('模型长时间未返回新数据，请重试。'); }
}

export class AgentToolLoopIncompleteError extends ServiceUnavailableException {
  readonly code = 'AGENT_TOOL_LOOP_INCOMPLETE';
  constructor() { super('工具处理尚未完成，未生成最终回答。请重试或缩小任务范围。'); }
}

export class ConversationHistoryChangedError extends ServiceUnavailableException {
  readonly code = 'CONVERSATION_HISTORY_CHANGED';
  constructor() { super('对话历史已改变，本次回答未保存。请基于当前对话重新发送。'); }
}

// Only fixed messages/codes are public. Never serialize provider response bodies or exceptions.
export function publicRunFailure(error: unknown, stage = 'generation') {
  if(error instanceof ToolStepUncertainError)return{stage:'tools',code:error.code,message:'这项操作的执行结果尚未确认，未自动重复执行。请先检查操作记录。'};
  if (error instanceof ConversationHistoryChangedError)
    return { stage: 'context', code: error.code, message: error.message };
  if (error instanceof AgentToolLoopIncompleteError)
    return { stage: 'tools', code: error.code, message: error.message };
  if (error instanceof ModelRequestTimeoutError)
    return { stage, code: error.code, message: error.message };
  if (['APIConnectionError', 'APIConnectionTimeoutError'].includes((error as any)?.name))
    return { stage, code: (error as any)?.name === 'APIConnectionTimeoutError' ? 'MODEL_REQUEST_TIMEOUT' : 'MODEL_CONNECTION_FAILED',
      message: (error as any)?.name === 'APIConnectionTimeoutError' ? '模型长时间未返回新数据，请重试。' : '与模型服务的连接中断，请重试。' };
  if (error instanceof AnswerStageError || error instanceof ModelOutputError) {
    const at = error instanceof AnswerStageError ? error.stage : stage;
    const name = ({ voice: '角色表达', verification: '答案核验', retrieval: '资料检索', evidence: '证据整理' } as Record<string,string>)[at] || '回答生成';
    return { stage: at, code: error.code, message: error.code === 'MODEL_OUTPUT_FORMAT' || error.code === 'MODEL_OUTPUT_TRUNCATED'
      ? `${name}时模型输出格式异常，自动重试仍未通过，请重试；并非未检索到资料。`
      : `${name}未完成，请重试；没有将未核验内容作为答案发出。` };
  }
  const status = typeof (error as any)?.getStatus === 'function' ? (error as any).getStatus() : undefined;
  if ([401, 403, 404].includes(status)) return { stage, code: 'ACCESS_CHANGED', message: '账号、会话或资料访问权限已变化，请刷新后检查。' };
  return { stage, code: 'GENERATION_FAILED', message: '本次回答生成未完成，请重试。持续失败时可由管理员按任务记录排查。' };
}
