import { DynamicStructuredTool } from '@langchain/core/tools';
import { BaseSkill, AgentSkill, SkillExecutionContext } from './skill.interface';
import { jsonSchemaToZod } from './json-schema-to-zod';
import { serializeToolResult } from './forum-output';
import { positiveSetting } from '../context-budget';

export class SkillRegistry {
  private static skills: Map<string, BaseSkill> = new Map();
  private static skillMetaList: AgentSkill[] = [];

  static register(skill: BaseSkill, meta: AgentSkill) {
    this.skills.set(skill.tool.name, skill);
    const index = this.skillMetaList.findIndex(m => m.name === meta.name);
    if (index >= 0) this.skillMetaList[index] = meta; else this.skillMetaList.push(meta);
  }

  static getTool(name: string): BaseSkill | undefined {
    return this.skills.get(name);
  }

  static getAllTools(): BaseSkill[] {
    return Array.from(this.skills.values());
  }

  static getAllMeta(): AgentSkill[] {
    return this.skillMetaList;
  }

  static getOpenAIFunctions(enabledNames?: string[], context: SkillExecutionContext = {}): any[] {
    const toolSkills = this.getAllTools().filter(t => {
      // Skip non-tool skills (persona/config only)
      const meta = this.skillMetaList.find(m => m.name === t.tool.name);
      if (meta && meta.isTool === false) return false;
      if (t.tool.name === 'web_search' && context.webSearch !== true) return false;
      if (t.tool.name === 'code_workspace' && !enabledNames?.includes(t.tool.name)) return false;
      if (enabledNames) return enabledNames.includes(t.tool.name);
      return true;
    });
    return toolSkills.map(t => t.getOpenAIFunction());
  }

  /**
   * Get persona skill by name (for system prompt injection).
   * Persona skills have isTool: false and provide getSystemPrompt().
   */
  static getPersonaSkill(name: string): BaseSkill | undefined {
    const meta = this.skillMetaList.find(m => m.name === name);
    if (meta && meta.isTool === false) {
      return this.skills.get(name);
    }
    return undefined;
  }

  /**
   * Convert registered skills to LangChain DynamicStructuredTool instances.
   * Filters out persona skills (isTool: false).
   * Respects enabledNames filter if provided.
   */
  static getLangChainTools(enabledNames?: string[], prismaService?: any, context: SkillExecutionContext = {}): DynamicStructuredTool[] {
    const tools: DynamicStructuredTool[] = [];

    for (const [name, skill] of this.skills) {
      const meta = this.skillMetaList.find(m => m.name === name);

      // Skip persona skills (not actual tools)
      if (meta?.isTool === false) continue;
      if (name === 'web_search' && context.webSearch !== true) continue;
      if (name === 'code_workspace' && !enabledNames?.includes(name)) continue;

      // Filter by enabledNames if provided
      if (enabledNames && !enabledNames.includes(name)) continue;

      const zodSchema = jsonSchemaToZod(skill.tool.parameters);

      const langChainTool = new DynamicStructuredTool({
        name: skill.tool.name,
        description: skill.tool.description,
        schema: zodSchema,
        func: async (args: Record<string, any>) => {
          const result = await skill.execute(args, { ...context, prismaService });
          if (name === 'code_workspace') return JSON.stringify({ success: result.success, data: result.modelData });
          if (name === 'web_search') return JSON.stringify({ success: result.success,
            data: result.modelData ?? { message: result.displayText } });
          return serializeToolResult(result, positiveSetting('AGENT_TOOL_OUTPUT_CHAR_LIMIT', 3000, 12000));
        },
      } as any); // as any to avoid TS2589 deep type instantiation

      tools.push(langChainTool);
    }

    return tools;
  }
}
