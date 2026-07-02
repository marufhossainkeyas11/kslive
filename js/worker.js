/**
 * KSLIVE Universal Proxy — Cloudflare Worker v2 (Beast Edition)
 *
 * Supports: HLS (.m3u8), DASH/MPD (.mpd), TS segments, fMP4/CMAF,
 *           direct video (MP4 / WebM), audio, VTT/SRT subtitles, ENC keys
 *
 * ?url=<encoded target URL>
 * &h_cookie=...   &h_user-agent=...   &h_referer=...   (any h_* header)
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 9; Redmi S2 Build/PKQ1.181203.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.7049.79 Mobile Safari/537.36';

const MIME_MAP = {
  m3u8: 'application/vnd.apple.mpegurl',
  m3u:  'application/vnd.apple.mpegurl',
  mpd:  'application/dash+xml',
  ts:   'video/MP2T',
  mts:  'video/MP2T',
  m2ts: 'video/MP2T',
  mp4:  'video/mp4',
  m4s:  'video/mp4',
  m4v:  'video/mp4',
  cmaf: 'video/mp4',
  webm: 'video/webm',
  aac:  'audio/aac',
  mp3:  'audio/mpeg',
  ogg:  'audio/ogg',
  vtt:  'text/vtt',
  srt:  'text/plain',
  ass:  'text/plain',
  key:  'application/octet-stream',
  bin:  'application/octet-stream',
};

function cors() {
  return {
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers':  '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges, X-KSLIVE-DRM',
  };
}

function guessMime(url) {
  const ext = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const method = request.method;

    // ── CORS preflight ──────────────────────────────────────────────
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    // ── Health check (no ?url param) ────────────────────────────────
    const target = reqUrl.searchParams.get('url');
    if (!target) return jsonRes({ status: 'ok', name: 'KSLIVE Universal Proxy', version: '2.0' });

    // ── Build forwarded headers from h_* params ─────────────────────
    const fwdHeaders = {};
    for (const [key, val] of reqUrl.searchParams.entries()) {
      if (key.startsWith('h_')) fwdHeaders[key.slice(2)] = val;
    }
    if (!fwdHeaders['user-agent']) fwdHeaders['user-agent'] = DEFAULT_UA;

    // ── Decode + validate target URL ────────────────────────────────
    let targetURL;
    try {
      targetURL = decodeURIComponent(target);
      new URL(targetURL); // throws if invalid
    } catch {
      return jsonRes({ error: 'invalid_url' }, 400);
    }

    // ── Forward Range header so seekable MP4/WebM work ──────────────
    const range = request.headers.get('range');
    if (range) fwdHeaders['range'] = range;

    // ── Fetch upstream ──────────────────────────────────────────────
    let upstream;
    try {
      upstream = await fetch(targetURL, {
        method:   method === 'HEAD' ? 'HEAD' : 'GET',
        headers:  fwdHeaders,
        redirect: 'follow',
      });
    } catch (err) {
      return jsonRes({ error: 'upstream_fetch_failed', message: err.message }, 502);
    }

    // Pass non-2xx / non-206 upstream codes straight back
    if (!upstream.ok && upstream.status !== 206) {
      return jsonRes({ error: 'upstream_error', status: upstream.status }, upstream.status);
    }

    const ct   = upstream.headers.get('content-type') || '';
    const lurl = targetURL.split('?')[0].split('#')[0].toLowerCase();

    const isM3U8 = lurl.endsWith('.m3u8') || lurl.endsWith('.m3u')
      || ct.includes('mpegurl') || ct.includes('x-mpegurl');

    const isMPD  = lurl.endsWith('.mpd')
      || ct.includes('dash+xml') || ct.includes('mpd+xml');

    // ── HLS manifest ────────────────────────────────────────────────
    if (isM3U8) {
      const rewritten = rewriteM3U8(await upstream.text(), targetURL, fwdHeaders, reqUrl);
      return new Response(rewritten, {
        status: 200,
        headers: { ...cors(), 'Content-Type': MIME_MAP.m3u8, 'Cache-Control': 'no-cache, no-store' },
      });
    }

    // ── DASH/MPD manifest ───────────────────────────────────────────
    if (isMPD) {
      const mpdText  = await upstream.text();
      const drmInfo  = detectDrm(mpdText);
      const rewritten = rewriteMPD(mpdText, targetURL, fwdHeaders, reqUrl);
      const mpdHeaders = { ...cors(), 'Content-Type': MIME_MAP.mpd, 'Cache-Control': 'no-cache, no-store' };
      if (drmInfo) mpdHeaders['X-KSLIVE-DRM'] = drmInfo; // e.g. "widevine,playready"
      return new Response(rewritten, { status: 200, headers: mpdHeaders });
    }

    // ── Binary passthrough (segments, keys, video, audio, subtitles) ─
    const out = new Headers(cors());
    out.set('Content-Type', ct || guessMime(lurl));

    // Forward seek / range headers
    for (const h of ['content-range', 'content-length', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }

    // Don't cache encryption keys
    const isKey = lurl.includes('.key') || lurl.includes('/key/') || lurl.includes('keyuri');
    out.set('Cache-Control', isKey ? 'no-store, no-cache' : 'public, max-age=30');

    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

/* ════════════════════════════════════════════════════════════
   M3U8 REWRITER
   Proxies: segments, EXT-X-KEY, EXT-X-MAP (fMP4 init), variant playlists
   ════════════════════════════════════════════════════════════ */
function rewriteM3U8(text, sourceURL, fwdHeaders, workerURL) {
  const srcU   = new URL(sourceURL);
  const base   = srcU.origin + srcU.pathname.substring(0, srcU.pathname.lastIndexOf('/') + 1);
  const origin = workerURL.origin;

  function wrap(abs) {
    const p = new URLSearchParams();
    p.set('url', encodeURIComponent(abs));
    for (const [k, v] of Object.entries(fwdHeaders)) p.set('h_' + k, v);
    return `${origin}?${p.toString()}`;
  }

  function resolve(line) {
    if (line.startsWith('http://') || line.startsWith('https://')) return line;
    if (line.startsWith('//'))  return srcU.protocol + line;
    if (line.startsWith('/'))   return srcU.origin + line;
    const parts = (base + line).split('/');
    const out   = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part !== '.') out.push(part);
    }
    return out.join('/');
  }

  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;

    // EXT-X-KEY — encryption key URI
    if (t.startsWith('#EXT-X-KEY') && t.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (_, u) => {
        try { return `URI="${wrap(resolve(u))}"`; } catch { return _; }
      });
    }

    // EXT-X-MAP — fMP4 / CMAF init segment
    if (t.startsWith('#EXT-X-MAP') && t.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/, (_, u) => {
        try { return `URI="${wrap(resolve(u))}"`; } catch { return _; }
      });
    }

    if (t.startsWith('#')) return line; // other directives — pass through

    // Segment URL or variant playlist URL
    try { return wrap(resolve(t)); } catch { return line; }
  }).join('\n');
}

/* ════════════════════════════════════════════════════════════
   DRM DETECTOR
   Scans <ContentProtection schemeIdUri="urn:uuid:..."> for known
   DRM system UUIDs (Widevine, PlayReady, FairPlay, ClearKey/CENC).
   Returns a comma-separated label string, or null if none found.
   ════════════════════════════════════════════════════════════ */
const DRM_SCHEMES = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'fairplay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'cenc', // generic/common ClearKey-style CENC
};

function detectDrm(mpdText) {
  const found = new Set();

  // <ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-...">
  const uuidRx = /schemeIdUri="urn:uuid:([0-9a-fA-F-]{36})"/g;
  let m;
  while ((m = uuidRx.exec(mpdText)) !== null) {
    const label = DRM_SCHEMES[m[1].toLowerCase()];
    if (label) found.add(label);
  }

  // Fallback: some manifests just say scheme="urn:mpeg:dash:mp4protection:2011"
  // combined with a named cenc:default_KID — treat as generic "cenc" if nothing else matched
  if (found.size === 0 && /<ContentProtection\b/i.test(mpdText) && /mp4protection/i.test(mpdText)) {
    found.add('cenc');
  }

  return found.size ? [...found].join(',') : null;
}

/* ════════════════════════════════════════════════════════════
   DASH/MPD REWRITER
   Proxies: BaseURL, SegmentTemplate (media + init), SegmentURL, Initialization
   Template variables ($Number$, $RepresentationID$, etc.) are preserved
   so dash.js can expand them before fetching each segment.
   ════════════════════════════════════════════════════════════ */
function rewriteMPD(text, sourceURL, fwdHeaders, workerURL) {
  const srcU    = new URL(sourceURL);
  const baseDir = srcU.origin + srcU.pathname.substring(0, srcU.pathname.lastIndexOf('/') + 1);
  const wOrigin = workerURL.origin;

  function resolve(href) {
    if (!href || href.startsWith('data:')) return href;
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    if (href.startsWith('//')) return srcU.protocol + href;
    if (href.startsWith('/')) return srcU.origin + href;
    const parts = (baseDir + href).split('/');
    const out   = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.') out.push(p);
    }
    return out.join('/');
  }

  /**
   * Wrap URL through proxy, preserving DASH template vars ($Number$, etc.)
   * We swap vars for safe placeholders before encodeURIComponent, then
   * restore them afterwards. This lets dash.js expand them at request time.
   * We build the query manually so URLSearchParams never re-encodes the $.
   */
  function wrap(absoluteUrl) {
    if (!absoluteUrl) return absoluteUrl;

    const vars = [];
    const safe = absoluteUrl.replace(/\$[^$\s]+\$/g, m => {
      vars.push(m);
      return `__KSTMPL${vars.length - 1}__`;
    });

    let encoded = encodeURIComponent(safe);
    vars.forEach((v, i) => { encoded = encoded.split(`__KSTMPL${i}__`).join(v); });

    let q = `url=${encoded}`;
    for (const [k, v] of Object.entries(fwdHeaders)) {
      q += `&h_${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    }
    return `${wOrigin}?${q}`;
  }

  // <BaseURL> — anchor for relative segment resolution
  text = text.replace(/<BaseURL(\s[^>]*)?>([^<]*)<\/BaseURL>/gi, (match, attrs = '', href) => {
    const h = href.trim();
    if (!h) return match;
    try { return `<BaseURL${attrs}>${wrap(resolve(h))}</BaseURL>`; } catch { return match; }
  });

  // <SegmentTemplate media="..." initialization="...">
  text = text.replace(/(<SegmentTemplate\b[^>]*>)/gi, tag =>
    tag.replace(/\b(media|initialization)="([^"]*)"/gi, (m, attr, href) => {
      if (!href) return m;
      try {
        const abs = (href.startsWith('http://') || href.startsWith('https://')) ? href : resolve(href);
        return `${attr}="${wrap(abs)}"`;
      } catch { return m; }
    })
  );

  // <SegmentURL media="..." index="..."> (SegmentList-based streams)
  text = text.replace(/(<SegmentURL\b[^>]*\/?>)/gi, tag =>
    tag.replace(/\b(media|index)="([^"]*)"/gi, (m, attr, href) => {
      if (!href) return m;
      try { return `${attr}="${wrap(resolve(href))}"`; } catch { return m; }
    })
  );

  // <Initialization sourceURL="...">
  text = text.replace(/(<Initialization\b[^>]*\/?>)/gi, tag =>
    tag.replace(/\bsourceURL="([^"]*)"/gi, (m, href) => {
      if (!href) return m;
      try { return `sourceURL="${wrap(resolve(href))}"`; } catch { return m; }
    })
  );

  // Note: <ContentProtection> license server URLs are intentionally NOT
  // rewritten — DRM license requests must hit the real server directly.

  return text;
}
