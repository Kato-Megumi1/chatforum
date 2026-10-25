// Read-only health check; not a scheduled automation.
const base = new URL(process.argv[2] || 'http://127.0.0.1:8080');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
  throw Error('Provide an HTTP(S) origin without credentials, query or fragment');
(async () => {
  const results = await Promise.all(['live', 'ready'].map(async name => {
    try {
      const response = await fetch(new URL('/api/health/' + name, base), { signal: AbortSignal.timeout(6000), redirect: 'error' });
      const body = await response.json();
      const ok = response.ok && body.success === true && body.data?.status === 'ok';
      return { check: name, status: response.status, ok };
    } catch { return { check: name, status: 'unreachable', ok: false }; }
  }));
  for (const result of results) console.log(JSON.stringify(result));
  if (results.some(r => !r.ok)) process.exitCode = 1;
})();
