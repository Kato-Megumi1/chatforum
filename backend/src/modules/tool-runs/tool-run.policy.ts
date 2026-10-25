import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const TOOL_POLICY_VERSION = 'tool-execution-v1';
export interface ToolRunScope {
  userId?: number; conversationId?: number; runId?: string; workerToken?: string; fileSourceEpoch?: number;
}
export interface ToolPolicy { effect: 'READ' | 'WRITE'; approval: boolean }
const readers = new Set(['calculator','get_datetime','get_weather','web_search','get_hot_topics','get_recent_posts',
  'search_forum_posts','get_forum_post','get_forum_categories']);
export function toolPolicy(name: string, args: Record<string, unknown>): ToolPolicy {
  if (readers.has(name)) return { effect: 'READ', approval: false };
  if (name === 'manage_forum_tracking') return { effect: args.action === 'list' ? 'READ' : 'WRITE', approval: args.action !== 'list' };
  // Proposals are private copies; applying/rejecting them still uses the existing authenticated user action.
  if (name === 'code_workspace') return { effect: args.action === 'propose' ? 'WRITE' : 'READ', approval: false };
  throw Error('TOOL_POLICY_UNAVAILABLE');
}
export function normalizedToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const check=(value:unknown)=>{
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      if(/^(?:reasoning(?:_content)?|api_?key|authorization|password|secret|access_?token|refresh_?token)$/i.test(key))throw Error('TOOL_PRIVATE_FIELD_REJECTED');
      check(child);
    }
  };
  check(args);
  const copy = { ...args };
  if (name === 'manage_forum_tracking') delete copy.confirmed; // A model-supplied boolean is never consent.
  return copy;
}
export function stableToolJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(Object.keys(item).sort().filter(key => (item as any)[key] !== undefined).map(key => [key, normalize((item as any)[key])]));
    throw Error('TOOL_ARGUMENTS_INVALID');
  };
  return JSON.stringify(normalize(value));
}
export const toolArgsHash = (name: string, args: Record<string, unknown>) =>
  createHash('sha256').update(stableToolJson({ tool: name, arguments: normalizedToolArgs(name, args), policy: TOOL_POLICY_VERSION })).digest('hex');

interface WriteCapability { userId: number; conversationId: number; runId: string; sourceEpoch: number; authVersion: number; argsHash: string; workerToken: string }
const capabilities = new AsyncLocalStorage<WriteCapability>();
export function withToolWriteApproval<T>(capability: WriteCapability, action: () => Promise<T>) {
  return capabilities.run(capability, action);
}
export const currentApprovedToolWrite = () => capabilities.getStore();
export function currentToolWriteApproval(scope: ToolRunScope, args: Record<string, unknown>): WriteCapability | undefined {
  const proof = capabilities.getStore();
  return proof && proof.userId === scope.userId && proof.conversationId === scope.conversationId && proof.runId === scope.runId &&
    proof.argsHash === toolArgsHash('manage_forum_tracking', args) ? proof : undefined;
}
export class ToolApprovalPendingError extends Error {
  readonly code = 'TOOL_APPROVAL_PENDING';
  constructor(readonly stepId: string) { super('工具操作等待用户确认'); }
}
export class ToolStepUncertainError extends Error {
  readonly code = 'TOOL_STEP_UNCERTAIN';
  constructor() { super('工具操作结果尚未确认，未自动重复执行'); }
}
