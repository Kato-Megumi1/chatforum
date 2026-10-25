type PostLink = { id: number; title: string };
const label = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]()<>!#|]/g, '\\$&');

/** IDs come from approved posts, never from model-generated titles or IDs. */
export function attachForumLinks(content: string, posts: PostLink[], appendMissing = true) {
  const missing: PostLink[] = [];
  for (const post of posts) {
    const url = `/forum/post/${post.id}`;
    if (content.includes(`](${url})`)) continue;
    const bold = `**${post.title}**`, link = `[${label(post.title)}](${url})`;
    const segments = content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
    let linked = false;
    for (let i = 0; i < segments.length; i += 2) {
      segments[i] = segments[i].split('\n').map(line => {
        if (!/^(?:\s*(?:\d+[.)]|[-*])\s+)?\*\*/.test(line) || !line.includes(bold)) return line;
        linked = true;
        return line.replace(bold, link);
      }).join('\n');
    }
    content = segments.join('');
    if (!linked) missing.push(post);
  }
  if (appendMissing && missing.length) content += '\n\n相关帖子：\n\n' + missing.map(p => `- [${label(p.title)}](/forum/post/${p.id})`).join('\n');
  return content;
}
export function legacyForumTitles(content: string) {
  return [...content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').matchAll(/^(?:\s*(?:\d+[.)]|[-*])\s+)?\*\*([^*\n]{1,200})\*\*/gm)].map(m => m[1]);
}
