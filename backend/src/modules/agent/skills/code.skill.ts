import { BaseSkill, SkillTool, SkillResult, SkillExecutionContext } from './skill.interface';

export class CodeSkill extends BaseSkill {
  tool: SkillTool = {
    name: 'run_code',
    description: '执行 JavaScript 代码。当用户需要运行代码片段、测试算法或计算复杂表达式时使用。',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要执行的 JavaScript 代码',
        },
      },
      required: ['code'],
    },
  };

  async execute(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult> {
    try {
      const code = args.code || '';

      // 安全检查：禁止访问敏感 API
      const forbidden = ['fetch', 'XMLHttpRequest', 'process', 'require', 'import', 'eval', 'Function'];
      for (const word of forbidden) {
        if (code.includes(word)) {
          return {
            success: false,
            result: null,
            displayText: `安全限制：代码中不能使用 "${word}"`,
          };
        }
      }

      // 安全地执行代码
      // eslint-disable-next-line no-eval
      throw new Error('服务端代码执行已禁用；需要独立隔离沙箱才能启用');
      const result = undefined;

      let displayResult: string;
      if (typeof result === 'object' && result !== null) {
        displayResult = JSON.stringify(result, null, 2);
      } else {
        displayResult = String(result);
      }

      const displayText = ` 代码执行结果\n` +
        `━━━━━━━━━━━━━━━\n` +
        `\`\`\`javascript\n${code}\n\`\`\`\n\n` +
        ` 输出：${displayResult}\n` +
        `━━━━━━━━━━━━━━━`;

      return {
        success: true,
        result,
        displayText,
      };
    } catch (error: any) {
      return {
        success: false,
        result: null,
        displayText: `代码执行出错: ${error.message}`,
      };
    }
  }
}
