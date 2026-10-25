import { SkillResult } from './skills/skill.interface';

export interface AgentToolStep { action?: { tool?: unknown }; observation?: unknown }

// Registry tools serialize structured observations as {success,data}. Keep the
// outer status for every tool, not only forum versions: a JSON failure is not a
// successful result merely because its display string does not start with Error.
export function extractToolOutputs(steps: readonly AgentToolStep[]): SkillResult[] {
  const outputs: SkillResult[] = [];
  for (const step of steps) {
    if (typeof step.action?.tool !== 'string' || !step.action.tool) continue;
    const observation = step.observation;
    const text = typeof observation === 'string' ? observation :
      observation === null || observation === undefined ? '' : JSON.stringify(observation);
    try {
      const envelope = JSON.parse(text);
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && typeof envelope.success === 'boolean') {
        const data = Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : envelope;
        outputs.push({ success: envelope.success, result: data, modelData: data, displayText: text });
        continue;
      }
    } catch { /* Plain text and non-envelope JSON retain the legacy observation contract. */ }
    outputs.push({ success: !text.trimStart().startsWith('Error:'), result: observation, displayText: text });
  }
  return outputs;
}
