// Public progress is telemetry, not model reasoning. Never forward server-supplied
// labels, descriptions, tool arguments or model text into this presentation model.
const activityDescriptions: Record<string, string> = {
  web_search: '正在搜索网页并整理来源', forum_search: '正在查询社区帖子', read_files: '正在读取本次会话中的文件',
  save_file: '正在保存生成的文件', preview_html: '正在生成手机和桌面的页面预览',
  review_html: '正在检查页面预览中的布局和画面', repair_html: '正在修复预览发现的页面问题',
};
const phaseDefinitions = {
  queued: { label: '等待开始', description: '请求已提交，正在等待处理' },
  context: { label: '整理上下文', description: '读取本轮消息和最近对话，整理回答所需信息' },
  understanding: { label: '理解问题', description: '确认问题重点和需要完成的任务' },
  retrieving: { label: '检索原文', description: '从当前有权限的资料中查找相关内容' },
  evidence: { label: '整理依据', description: '筛选能支持回答的内容和引用' },
  thinking: { label: '深度思考', description: '分析问题并形成回答思路' },
  generating: { label: '生成回答', description: '分析问题并组织回答' },
  tools: { label: '处理任务', description: '执行已启用的工具并整理结果' },
  verifying: { label: '核对依据', description: '检查回答是否切题，并核对结果与依据' },
  delivering: { label: '输出回答', description: '保存并发送最终回答' },
  completed: { label: '已完成', description: '回答已完成' },
} as const;

export type PublicGenerationPhase = keyof typeof phaseDefinitions;
const legacyPhases: Record<string, PublicGenerationPhase> = {
  preparing: 'context', generating: 'generating', tools: 'tools', verifying: 'verifying', completed: 'completed',
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const duration = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const phaseKey = (value: unknown): PublicGenerationPhase | undefined =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(phaseDefinitions, value) ? value as PublicGenerationPhase : undefined;
const legacyKey = (value: unknown): PublicGenerationPhase | undefined =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(legacyPhases, value) ? legacyPhases[value] : undefined;

export interface GenerationProcessPhase {
  phase: PublicGenerationPhase;
  label: string;
  description: string;
  durationMs: number | null;
  modelCalls: number | null;
  active: boolean;
}

export function generationProcessView(input: unknown, pending: boolean, extensionMs = 0, allowThinking = false) {
  const source = record(input);
  const elapsed = duration(source?.elapsedMs);
  const receivedPhase = elapsed !== null ? phaseKey(source?.phase) || legacyKey(source?.stage) : undefined;
  // The actual server phase is authoritative for ASSISTANT, even when old message
  // option metadata is absent. ROLEPLAY/LEGACY never inherit thinking presentation.
  const phase = receivedPhase === 'thinking' && !allowThinking ? legacyKey(source?.stage) : receivedPhase;
  const hasProgress = phase !== undefined;
  // A terminal snapshot never advances, even if a delayed pending flag is still true.
  const extra = hasProgress && phase !== 'completed' ? duration(extensionMs) ?? 0 : 0;
  const elapsedMs = hasProgress ? Math.min(Number.MAX_SAFE_INTEGER, elapsed! + extra) : null;
  const firstToken = duration(source?.firstTokenMs);
  const firstTokenMs = hasProgress && firstToken !== null && firstToken <= elapsedMs! ? firstToken : null;
  const rows = Array.isArray(source?.phases) ? source.phases : Array.isArray(source?.stages) ? source.stages : [];
  const phases: GenerationProcessPhase[] = [];
  const seen = new Set<PublicGenerationPhase>();
  if (hasProgress) for (const item of rows.slice(0, 40)) {
    const row = record(item);
    const key = phaseKey(row?.phase) || legacyKey(row?.stage);
    const ms = duration(row?.durationMs);
    if (!key || key === 'completed' || key === 'thinking' && !allowThinking || ms === null || seen.has(key)) continue;
    seen.add(key);
    phases.push({ phase: key, label: phaseDefinitions[key].label, description: phaseDefinitions[key].description,
      durationMs: Math.min(Number.MAX_SAFE_INTEGER, ms + (key === phase ? extra : 0)),
      modelCalls: count(row?.modelCalls), active: pending && key === phase });
  }
  if (phase && phase !== 'completed' && !seen.has(phase)) {
    const phaseMs = duration(source?.phaseElapsedMs);
    phases.push({ phase, label: phaseDefinitions[phase].label, description: phaseDefinitions[phase].description,
      durationMs: phaseMs === null ? null : Math.min(Number.MAX_SAFE_INTEGER, phaseMs + extra),
      modelCalls: null, active: pending });
  }
  // Durations aggregate repeated phases. The model-call wait starts as generating,
  // so group confirmed thinking before answer generation for the process display.
  const thinkingIndex = phases.findIndex(row => row.phase === 'thinking');
  const generatingIndex = phases.findIndex(row => row.phase === 'generating');
  if (generatingIndex >= 0 && thinkingIndex > generatingIndex)
    phases.splice(generatingIndex, 0, phases.splice(thinkingIndex, 1)[0]);
  const output = record(source?.modelOutput);
  const thinkingChars = allowThinking ? count(output?.thinkingChars) || 0 : 0;
  const textChars = count(output?.textChars) || 0, toolChars = count(output?.toolChars) || 0;
  const receivedChars = thinkingChars + textChars + toolChars;
  const activity = typeof source?.activity === 'string' && Object.prototype.hasOwnProperty.call(activityDescriptions, source.activity) ? activityDescriptions[source.activity] : '';
  const summary = pending && activity ? activity : receivedChars
    ? pending && phase === 'thinking' ? `模型正在分析本次请求，已收到 ${thinkingChars.toLocaleString('zh-CN')} 字思考数据`
      : `已收到 ${receivedChars.toLocaleString('zh-CN')} 字模型数据${pending ? '，正在继续处理' : ''}`
    : pending && (count(source?.activeModelCalls) || 0) > 0 ? '请求已送达模型，等待返回数据' : '';
  const lastData = duration(output?.lastDataElapsedMs);
  const lastDataAgeMs = pending && receivedChars && lastData !== null && elapsedMs !== null
    ? Math.max(0, elapsedMs - lastData) : null;
  return {
    hasProgress, phase, elapsedMs, firstTokenMs, phases, summary, lastDataAgeMs,
    label: pending
      ? phase === 'thinking' ? '深度思考中'
        : phase ? phaseDefinitions[phase].label : '等待中'
      : phases.some(row => row.phase === 'thinking') ? '深度思考完成' : '已完成',
    modelCalls: hasProgress ? count(source?.modelCalls) : null,
    activeModelCalls: hasProgress && pending && phase !== 'completed' ? count(source?.activeModelCalls) : null,
    queueMs: hasProgress ? duration(source?.queueMs) : null,
  };
}

export function generationSeconds(ms: number): string {
  return ((duration(ms) ?? 0) / 1000).toFixed(1);
}
