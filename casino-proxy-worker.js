const CASINO_BASE = 'https://admin.celuapuestas.bond';

export default {
  async fetch(request, env) {
    const secret = request.headers.get('X-Proxy-Secret');
    if (!secret || secret !== env.PROXY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const targetUrl = CASINO_BASE + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete('X-Proxy-Secret');
    headers.delete('host');
    headers.set('Origin', CASINO_BASE);
    headers.set('Referer', CASINO_BASE + '/');
    const casinoResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });
    const responseHeaders = new Headers(casinoResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    return new Response(casinoResponse.body, {
      status: casinoResponse.status,
      statusText: casinoResponse.statusText,
      headers: responseHeaders,
    });
  },
};
