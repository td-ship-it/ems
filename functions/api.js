// Dùng khi deploy bằng Cloudflare Pages (không cần nếu deploy bằng Worker)
import { handleApi } from '../src/api.js';

export const onRequest = ({ request, env }) => handleApi(request, env);
