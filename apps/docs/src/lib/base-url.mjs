/**
 * Prefixes a site-root-relative URL with the site's `base`.
 *
 * Astro emits a root-relative URL verbatim, so when the site is served from a
 * sub-path (`DOCS_BASE_URL=/jev-planner/`, as on `rxova.github.io` without the
 * custom domain) a link written as `/guides/usage/` points one directory above
 * where the site is mounted. Everything that
 * writes a link into the agent-facing surfaces goes through here.
 *
 * Left alone: protocol-relative (`//host`) and absolute URLs, and anything that
 * already carries the base — so applying it twice is a no-op.
 */
export function withBase(url, base = '/') {
  const prefix = base.replace(/\/+$/, '')
  if (!prefix || typeof url !== 'string') return url
  if (!url.startsWith('/') || url.startsWith('//')) return url
  if (url === prefix || url.startsWith(`${prefix}/`)) return url
  return prefix + url
}
