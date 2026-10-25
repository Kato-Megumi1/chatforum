/**
 * 路人女主的养成方法 (Saekano) 专有名词词典
 * 用于 RAG 关键词扩展，替代噪声多的 KB 统计共现
 */

export const SAEKANO_DICT: Record<string, string[]> = {
  // 核心人物
  '伦也': ['安艺伦也', 'TAKI', 'blessing software', '伦也'],
  '安艺': ['安艺伦也', 'TAKI', 'blessing software'],
  '惠': ['加藤惠', '女主角', '副代表', '巡璃'],
  '加藤': ['加藤惠', '女主角', '巡璃', '加藤宏美'],
  '英梨梨': ['泽村史宾瑟英梨梨', '柏木英理', '原画师', '金发'],
  '泽村': ['泽村史宾瑟英梨梨', '柏木英理'],
  '柏木英理': ['柏木英理', 'egoistic-lily', '英梨梨', '原画'],
  '诗羽': ['霞之丘诗羽', '霞诗子', '恋爱节拍器', '剧本'],
  '霞之丘': ['霞之丘诗羽', '霞诗子', '恋爱节拍器'],
  '霞诗子': ['霞诗子', '恋爱节拍器', '纯情百帕'],
  '美智留': ['冰堂美智留', 'icy tail', '音乐', '乐团'],
  '冰堂': ['冰堂美智留', 'icy tail', '乐团'],
  '出海': ['波岛出海', '插画', '同人'],
  '伊织': ['波岛伊织', 'rouge en rouge', '制作人'],

  // 社团
  'blessing': ['blessing software', '同人游戏', 'cherry blessing'],
  'rouge': ['rouge en rouge', '波岛伊织', '大型社团'],
  'icy tail': ['icy tail', '冰堂美智留', '乐团', '演唱会'],
  'icy': ['icy tail', '冰堂美智留', '乐团'],

  // 作品
  '恋爱节拍器': ['恋爱节拍器', '霞诗子', '沙由佳', '真唯', '轻小说'],
  'cherry blessing': ['cherry blessing', 'blessing software', '同人游戏', '叶巡璃'],
  '巡璃': ['叶巡璃', '第一女主角', 'blessing software', 'cherry blessing'],
  '叶巡璃': ['叶巡璃', '女主角', '巡璃线', '原画'],
  '寰域': ['寰域编年纪', '马尔兹', '红坂朱音', '移植'],

  // 地点
  '侦探坡': ['侦探坡', '坡道', '樱花', '贝雷帽'],
  '坡道': ['侦探坡', '坡道', '樱花', '贝雷帽', '帽子'],
  '丰之崎': ['丰之崎学园', '校庆', 'icy tail', '侦探坡'],
  '六天场': ['六天场购物中心', '商场', '约会', '甜品'],
  '秋叶原': ['秋叶原', '虎之穴', 'Gamers', 'Comiket'],

  // 事件
  '校庆': ['丰之崎校庆', 'icy tail', '演唱会', '舞台'],
  'Comiket': ['Comiket', '夏COMI', '冬COMI', '同人即卖会'],
  '冬COMI': ['冬COMI', 'Comiket', '同人即卖会', 'blessing software'],
  '夏COMI': ['夏COMI', 'Comiket', '同人即卖会'],
};

const ALL_TERMS: Set<string> = new Set();
for (const terms of Object.values(SAEKANO_DICT)) {
  for (const t of terms) ALL_TERMS.add(t);
}

/**
 * Expand keywords using the Saekano dictionary.
 * When input keywords match a dictionary key, add all related terms.
 */
export function expandWithDictionary(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    const related = SAEKANO_DICT[kw];
    if (related) {
      for (const t of related) expanded.add(t);
    }
  }
  return [...expanded];
}

/**
 * Check if a keyword is a known Saekano term
 */
export function isSaekanoTerm(word: string): boolean {
  return ALL_TERMS.has(word) || word in SAEKANO_DICT;
}
