import { arithmetic } from './arithmetic';
import { BaseSkill, SkillTool, SkillResult, SkillExecutionContext } from './skill.interface';

export class CalculatorSkill extends BaseSkill {
  tool: SkillTool = {
    name: 'calculator',
    description: '执行数学计算。当用户需要进行加减乘除、幂运算、百分比等数学计算时使用。',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式，如 "2 + 2"、"100 * 0.8"、"2 ** 10"',
        },
      },
      required: ['expression'],
    },
  };

  async execute(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult> {
    try {
      const expression = args.expression || '';

      const result = arithmetic(expression);

      const displayText = `🔢 计算结果\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📝 表达式：${expression}\n` +
        ` 结果：${result}\n` +
        `━━━━━━━━━━━━━━━`;

      return {
        success: true,
        result: Number(result),
        displayText,
      };
    } catch (error: any) {
      return {
        success: false,
        result: null,
        displayText: `计算出错: ${error.message}`,
      };
    }
  }
}
