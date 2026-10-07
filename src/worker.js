// Cloudflare Worker: /api → Apps Script, mọi đường dẫn khác → file tĩnh trong public/
import { handleApi } from './api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname === '/api/') return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
