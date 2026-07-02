/**
 * Universal IPTV/HLS Proxy — Cloudflare Worker
 * কোনো host hardcode নাই। সব dynamic params দিয়ে চলে।
 *
 * ব্যবহার:
 *   ?url=<encoded target m3u8/ts/key URL>
 *   &h_cookie=<encoded cookie>          (optional, কোনো header h_ prefix দিয়ে দেওয়া যাবে)
 *   &h_user-agent=<encoded UA>
 *   &h_referer=<encoded referer>
 *   &h_origin=<encoded origin>
 */

const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 9; Redmi S2 Build/PKQ1.181203.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.79 Mobile Safari/537.36';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('Universal Proxy OK', { status: 200, headers: cors() });
    }

    // h_* প্যারামগুলো থেকে dynamic headers বানানো
    const fwdHeaders = {};
    for (const [key, val] of url.searchParams.entries()) {
      if (key.startsWith('h_')) {
        const headerName = key.substring(2); // h_cookie -> cookie
        fwdHeaders[headerName] = val;
      }
    }
    if (!fwdHeaders['user-agent']) fwdHeaders['user-agent'] = DEFAULT_UA;

    let targetURL;
    try {
      targetURL = decodeURIComponent(target);
    } catch {
      return new Response('Invalid url param', { status: 400, headers: cors() });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(targetURL, {
        method: 'GET',
        headers: fwdHeaders,
        redirect: 'follow',
      });
    } catch (e) {
      return new Response('fetch error: ' + e.message, { status: 502, headers: cors() });
    }

    if (!upstreamRes.ok) {
      return new Response('upstream ' + upstreamRes.status, { status: upstreamRes.status, headers: cors() });
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isM3U8 = targetURL.includes('.m3u8') || targetURL.includes('.m3u')
      || contentType.includes('mpegurl') || contentType.includes('m3u');

    if (isM3U8) {
      const text = await upstreamRes.text();
      const rewritten = rewriteM3U8(text, targetURL, fwdHeaders, url);
      return new Response(rewritten, {
        status: 200,
        headers: {
          ...cors(),
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Binary segment / key — pass-through stream
    const headers = new Headers(cors());
    headers.set('Content-Type', contentType || 'video/MP2T');
    headers.set('Cache-Control', 'public, max-age=30');
    return new Response(upstreamRes.body, { status: 200, headers });
  },
};

/**
 * M3U8 এর ভেতরের প্রতিটা লাইন (segment, key, nested master variant)
 * resolve + re-wrap করে আবার এই Worker দিয়েই route করায়, headers preserve করে।
 */
function rewriteM3U8(text, sourceURL, fwdHeaders, workerURL) {
  const srcU = new URL(sourceURL);
  const base = srcU.origin + srcU.pathname.substring(0, srcU.pathname.lastIndexOf('/') + 1);
  const origin = workerURL.origin;

  function wrap(absoluteUrl) {
    const p = new URLSearchParams();
    p.set('url', encodeURIComponent(absoluteUrl));
    for (const [k, v] of Object.entries(fwdHeaders)) {
      p.set('h_' + k, v);
    }
    return `${origin}?${p.toString()}`;
  }

  function resolve(line) {
    if (line.startsWith('http')) return line;
    if (line.startsWith('//')) return srcU.protocol + line;
    if (line.startsWith('/')) return srcU.origin + line;
    // relative path resolve
    const parts = (base + line).split('/');
    const out = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part !== '.') out.push(part);
    }
    return out.join('/');
  }

  return text.split('\n').map(line => {
    const trimmed = line.trim();

    // EXT-X-KEY URI rewrite
    if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (m, keyUrl) => {
        try {
          return `URI="${wrap(resolve(keyUrl))}"`;
        } catch { return m; }
      });
    }

    // EXT-X-STREAM-INF এর নিচের লাইন = nested/master playlist variant URL
    if (!trimmed || trimmed.startsWith('#')) return line;

    try {
      return wrap(resolve(trimmed));
    } catch {
      return line;
    }
  }).join('\n');
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
  };
}
