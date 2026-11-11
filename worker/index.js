const BASE = '/tabletop-scorecard';
const AUTH_PREFIX = `${BASE}/auth/`;
const DATA_API = 'https://ep-summer-breeze-bdgam8p2.apirest.c-8.us-east-2.aws.neon.tech';

const CSP = [
  "default-src 'self'",
  `connect-src 'self' ${DATA_API}`,
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function rewriteSetCookie(raw) {
  const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
  const [nameValue, ...attrs] = parts;
  const kept = attrs.filter((a) => {
    const k = a.split('=')[0].trim().toLowerCase();
    return k !== 'domain' && k !== 'path' && k !== 'samesite' && k !== 'partitioned';
  });
  return [nameValue, ...kept, `Path=${AUTH_PREFIX.slice(0, -1)}`, 'SameSite=Lax'].join('; ');
}

const FORWARD_HEADERS = ['accept', 'accept-language', 'content-type', 'origin', 'user-agent'];
const COOKIE_PREFIXES = ['__Secure-neon-auth.', 'neon-auth.'];
const BAD_REST_PATH = /\.\.|%2e|%2f|%5c|\\/i;

function forwardedHeaders(request) {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const cookie = request.headers.get('cookie');
  if (cookie) {
    const kept = cookie.split(';').map((c) => c.trim()).filter((c) => COOKIE_PREFIXES.some((p) => c.startsWith(p)));
    if (kept.length) headers.set('cookie', kept.join('; '));
  }
  return headers;
}

async function proxyAuth(request, env, url) {
  const rest = url.pathname.slice(AUTH_PREFIX.length);
  if (BAD_REST_PATH.test(rest)) return new Response('Bad request', { status: 400 });
  const target = `${env.NEON_AUTH_URL.replace(/\/$/, '')}/${rest}${url.search}`;
  const headers = forwardedHeaders(request);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  const upstream = await fetch(target, init);
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase();
    if (key === 'set-cookie' || key.startsWith('access-control-')) continue;
    out.append(k, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', rewriteSetCookie(c));
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

function decorate(response, pathname) {
  const type = response.headers.get('content-type') || '';
  const isHtml = type.includes('text/html');
  const noCache = pathname.endsWith('/sw.js') || pathname.endsWith('/index.html') || pathname === `${BASE}/`;
  if (!isHtml && !noCache) return response;
  const res = new Response(response.body, response);
  if (isHtml) {
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    res.headers.set('content-security-policy', CSP);
  }
  if (noCache) res.headers.set('cache-control', 'no-cache');
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === BASE) {
      return Response.redirect(`${url.origin}${BASE}/${url.search}`, 301);
    }
    if (pathname.startsWith(AUTH_PREFIX)) {
      return proxyAuth(request, env, url);
    }
    if (!pathname.startsWith(`${BASE}/`)) {
      return new Response('Not found', { status: 404 });
    }

    let res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) {
      res = await env.ASSETS.fetch(new Request(new URL(`${BASE}/`, url), request));
    }
    return decorate(res, pathname);
  },
};
