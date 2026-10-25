import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import configuration from '../../config/configuration';

export const CHAT_MODEL_IDS = ['deepseek-v4-pro', 'qwen3.8-max'] as const;
export const DEFAULT_CHAT_MODEL_ID = 'qwen3.8-max';
export interface ServerChatModel {
  id: string; label: string; defaultModel: string; defaultApiBase: string; defaultApiKey: string;
  bodyOptions: Record<string, unknown>; pricingPrefix: string;
  deepThinking?: boolean; webSearch?: boolean;
}
export interface ChatModelRequestOptions { deepThinking?: boolean; webSearch?: boolean; }
const context = new AsyncLocalStorage<ServerChatModel>();

// Only the server maps menu IDs to credentials/endpoints. Never serialize these records to clients.
function catalog(): ServerChatModel[] {
  const legacy = configuration().llm;
  // An existing credential is reusable only for the same configured DeepSeek endpoint.
  let isDeepSeek = false;
  try { isDeepSeek = new URL(legacy.defaultApiBase).hostname === 'api.deepseek.com'; } catch { /* unavailable */ }
  return [
    { id: CHAT_MODEL_IDS[0], label: 'DeepSeek V4 Pro', defaultModel: 'deepseek-v4-pro',
      defaultApiBase: process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com',
      defaultApiKey: process.env.DEEPSEEK_API_KEY || (isDeepSeek ? legacy.defaultApiKey : ''),
      bodyOptions: { thinking: { type: 'disabled' } }, pricingPrefix: 'DEEPSEEK_V4_PRO' },
    { id: CHAT_MODEL_IDS[1], label: 'Qwen3.8-Max', defaultModel: process.env.QWEN_MODEL_NAME || 'qwen3.8-max-0902',
      defaultApiBase: process.env.QWEN_API_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultApiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '',
      bodyOptions: { enable_thinking: false }, pricingPrefix: 'QWEN38_MAX' },
  ];
}
export function publicChatModels() {
  const models = catalog().map(m => {
    const enabled = process.env[m.id === 'deepseek-v4-pro' ? 'DEEPSEEK_CHAT_ENABLED' : 'QWEN_CHAT_ENABLED'] !== 'false';
    return { id: m.id, label: m.label, configured: !!m.defaultApiKey, available: enabled && !!m.defaultApiKey,
      unavailableReason: !enabled ? '管理员已停用此模型' : m.defaultApiKey ? null : '管理员尚未配置此模型的服务端凭据' };
  });
  const preferred = process.env.CHAT_DEFAULT_MODEL || DEFAULT_CHAT_MODEL_ID;
  // A missing preferred credential must never silently spend another provider's balance.
  const defaultModelId = models.find(m => m.id === preferred)?.id || DEFAULT_CHAT_MODEL_ID;
  return { configured: !!models.find(m => m.id === defaultModelId)?.available, model: defaultModelId, defaultModelId, models };
}
export function resolveChatModel(id?: string, options: ChatModelRequestOptions = {}): ServerChatModel {
  const chosen = id ?? publicChatModels().defaultModelId;
  const model = catalog().find(m => m.id === chosen);
  if (!model) throw new BadRequestException('请选择服务端提供的模型');
  if (process.env[chosen === 'deepseek-v4-pro' ? 'DEEPSEEK_CHAT_ENABLED' : 'QWEN_CHAT_ENABLED'] === 'false')
    throw new ServiceUnavailableException(model.label + ' 已停用，不能调用或自动替换');
  if (!model.defaultApiKey) throw new ServiceUnavailableException(model.label + ' 尚未配置，不能调用或自动替换');
  // Old clients without switches retain non-thinking/no-network behavior. Never mutate the catalog.
  return { ...model, deepThinking: options.deepThinking === true, webSearch: options.webSearch === true };
}
function bodyOptions(config: ServerChatModel, generation: boolean): Record<string, unknown> {
  const enabled = generation && config.deepThinking === true;
  if (config.id === 'deepseek-v4-pro') return { ...config.bodyOptions, thinking: { type: enabled ? 'enabled' : 'disabled' } };
  if (config.id === 'qwen3.8-max') return { ...config.bodyOptions, enable_thinking: enabled };
  return { ...config.bodyOptions }; // Existing offline fixtures/legacy eval configuration is not reinterpreted.
}
// Only user-facing generation opts in. Extraction, planning, ranking, checking and attachment
// readers keep their existing non-thinking contract even inside a deep-thinking conversation.
export const generationBodyOptions = (config = currentChatModel()) => bodyOptions(config, true);
export const internalBodyOptions = (config = currentChatModel()) => bodyOptions(config, false);
// Async-local scope isolates simultaneous users, graph extraction and all RAG stages.
// Offline historical evals without a scope continue to use their configured legacy baseline.
export function currentChatModel(): ServerChatModel {
  return context.getStore() || { ...configuration().llm, id: configuration().llm.defaultModel,
    label: configuration().llm.defaultModel, bodyOptions: {}, pricingPrefix: 'RAG' };
}
export const withChatModel = <T>(model: ServerChatModel, operation: () => Promise<T>): Promise<T> => context.run(model, operation);
