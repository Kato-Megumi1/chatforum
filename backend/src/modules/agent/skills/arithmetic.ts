// Recursive-descent arithmetic; no JS evaluation, globals, properties or calls.
export function arithmetic(source: string): number {
  if (typeof source !== 'string' || !source.trim() || source.length > 300) throw new Error('表达式长度无效');
  const tokens = source.match(/\d+(?:\.\d*)?|\.\d+|\*\*|[()+\-*/%]|\s+/g);
  if (!tokens || tokens.join('') !== source) throw new Error('只允许数字和算术运算符');
  const parts = tokens.filter(t => !/^\s+$/.test(t));
  let i = 0;
  const atom = (): number => {
    if (parts[i] === '(') { i++; const n = sum(); if (parts[i++] !== ')') throw new Error('括号不匹配'); return n; }
    const value = parts[i++];
    if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error('缺少数字');
    return Number(value);
  };
  const power = (): number => { const left = atom(); if (parts[i] !== '**') return left; i++; return left ** unary(); };
  const unary = (): number => { if (parts[i] === '-') { i++; return -unary(); } if (parts[i] === '+') { i++; return unary(); } return power(); };
  const product = (): number => {
    let n = unary();
    while (['*', '/', '%'].includes(parts[i])) {
      const op = parts[i++], right = unary();
      n = op === '*' ? n * right : op === '/' ? n / right : n % right;
    }
    return n;
  };
  const sum = (): number => {
    let n = product();
    while (['+', '-'].includes(parts[i])) { const op = parts[i++], right = product(); n = op === '+' ? n + right : n - right; }
    return n;
  };
  const result = sum();
  if (i !== parts.length || !Number.isFinite(result)) throw new Error('无效表达式或结果超出范围');
  return result;
}
