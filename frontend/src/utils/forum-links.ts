/** Only rewrite app-owned post routes, never arbitrary URLs from forum text. */
export function forumPostPath(href: string): string | undefined {
  return /^\/forum\/post\/[1-9]\d*$/.test(href) ? href : undefined;
}

export function resolveForumLinks(sanitizedHtml: string, resolve: (path: string) => string): string {
  const fragment = document.createElement('template');
  fragment.innerHTML = sanitizedHtml;
  fragment.content.querySelectorAll('a[href]').forEach(link => {
    const path = forumPostPath(link.getAttribute('href') || '');
    if (path) {
      link.setAttribute('href', resolve(path));
      link.setAttribute('data-forum-post-path', path);
    }
  });
  return fragment.innerHTML;
}
