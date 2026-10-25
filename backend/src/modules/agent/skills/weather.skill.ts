import { BaseSkill, SkillTool, SkillResult, SkillExecutionContext } from './skill.interface';

const WMO_CODES: Record<number, string> = {
  0: '☀️ 晴天',
  1: '🌤 大部晴朗',
  2: '⛅ 部分多云',
  3: '☁️ 多云',
  45: '🌫 雾',
  48: '🌫 雾凇',
  51: '🌧 小毛毛雨',
  53: '🌧 毛毛雨',
  55: '🌧 大毛毛雨',
  56: '🌧 小冻雨',
  57: '🌧 冻雨',
  61: '🌧 小雨',
  63: '🌧 中雨',
  65: '🌧 大雨',
  66: '🌧 小冻雨',
  67: '🌧 冻雨',
  71: '🌨 小雪',
  73: '🌨 中雪',
  75: '🌨 大雪',
  77: '🌨 雪粒',
  80: '🌧 阵雨',
  81: '🌧 中阵雨',
  82: '🌧 大阵雨',
  85: '🌨 小阵雪',
  86: '🌨 大阵雪',
  95: '⛈ 雷暴',
  96: '⛈ 雷暴+小冰雹',
  99: '⛈ 雷暴+大冰雹',
};

function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

export class WeatherSkill extends BaseSkill {
  tool: SkillTool = {
    name: 'get_weather',
    description: '查询指定城市的天气信息，包括当天和未来一周预报。当用户询问天气、气温、天气状况时使用。',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '城市名称，如"北京"、"上海"、"广州"。支持中文名和英文名',
        },
      },
      required: ['city'],
    },
  };

  async execute(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult> {
    try {
      const city = args.city || '';

      // Step 1: Geocode city name to coordinates
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
      const geoRes = await fetchWithTimeout(geoUrl);
      if (!geoRes.ok) {
        return { success: false, result: null, displayText: `地理编码失败: HTTP ${geoRes.status}` };
      }

      const geoData = await geoRes.json();
      const location = geoData.results?.[0];
      if (!location) {
        return { success: false, result: null, displayText: `未找到城市 "${city}"，请尝试更具体的名称` };
      }

      const { latitude, longitude, name, country } = location;

      // Step 2: Fetch weather forecast
      const forecastUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max,wind_speed_10m_max` +
        `&forecast_days=7&timezone=auto`;
      const fcRes = await fetchWithTimeout(forecastUrl);
      if (!fcRes.ok) {
        return { success: false, result: null, displayText: `天气查询失败: HTTP ${fcRes.status}` };
      }

      const fcData = await fcRes.json();
      const daily = fcData.daily;
      if (!daily) {
        return { success: false, result: null, displayText: `未获取到 "${name}" 的天气数据` };
      }

      // Build display
      const countryStr = country ? ` (${country})` : '';
      let displayText = `🌤 **${name}${countryStr} 一周天气预报**\n\n`;

      const forecast: Array<Record<string, any>> = [];
      for (let i = 0; i < daily.time.length; i++) {
        const code = daily.weathercode[i];
        const desc = WMO_CODES[code] || `天气代码 ${code}`;
        const dayOfWeek = new Date(daily.time[i] + 'T00:00:00').toLocaleDateString('zh-CN', { weekday: 'short' });
        const dateStr = daily.time[i];

        displayText +=
          `**${dateStr} ${dayOfWeek}**  ${desc}\n` +
          `  🌡 高温 ${daily.temperature_2m_max[i]}°C / 低温 ${daily.temperature_2m_min[i]}°C` +
          `  |  💧 降水概率 ${daily.precipitation_probability_max[i]}%` +
          `  |  💨 最大风速 ${daily.wind_speed_10m_max[i]} km/h\n\n`;

        forecast.push({
          date: dateStr,
          dayOfWeek,
          weather: desc,
          tempMax: daily.temperature_2m_max[i],
          tempMin: daily.temperature_2m_min[i],
          precipitationProb: daily.precipitation_probability_max[i],
          windSpeedMax: daily.wind_speed_10m_max[i],
        });
      }

      return { success: true, result: { city: name, country, forecast }, displayText: displayText.trim() };
    } catch (error: any) {
      const isTimeout = error.name === 'AbortError';
      return {
        success: false,
        result: null,
        displayText: isTimeout ? '天气查询超时，Open-Meteo 服务暂不可达' : `查询天气出错: ${error.message}`,
      };
    }
  }
}
