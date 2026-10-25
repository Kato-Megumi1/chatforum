import { BaseSkill, SkillTool, SkillResult, SkillExecutionContext } from './skill.interface';

export class DateTimeSkill extends BaseSkill {
  tool: SkillTool = {
    name: 'get_datetime',
    description: '获取当前日期和时间。当用户询问今天星期几、现在几点、当前日期时使用。',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: '时区（可选），如"Asia/Shanghai"。默认为"Asia/Shanghai"',
        },
        format: {
          type: 'string',
          description: '输出格式（可选），如"full"、"short"。默认为"full"',
        },
      },
    },
  };

  async execute(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult> {
    try {
      const now = new Date();

      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const weekDay = weekdays[now.getDay()];
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');

      const displayText = ` 当前时间\n` +
        `━━━━━━━━━━━━━━━\n` +
        ` 日期：${year}年${month}月${day}日 ${weekDay}\n` +
        ` 时间：${hours}:${minutes}:${seconds}\n` +
        ` 时区：Asia/Shanghai (UTC+8)\n` +
        `━━━━━━━━━━━━━━━`;

      return {
        success: true,
        result: {
          date: `${year}-${month}-${day}`,
          weekday: weekDay,
          time: `${hours}:${minutes}:${seconds}`,
          timestamp: now.getTime(),
          timezone: 'Asia/Shanghai',
        },
        displayText,
      };
    } catch (error: any) {
      return {
        success: false,
        result: null,
        displayText: `获取时间出错: ${error.message}`,
      };
    }
  }
}
