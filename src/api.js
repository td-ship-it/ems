// Xử lý POST /api — dùng chung cho Cloudflare Worker (src/worker.js) và Pages Function (functions/api.js)
// Chuyển tiếp request từ trình duyệt tới Google Apps Script, kèm API key bí mật.
// Biến môi trường (Cloudflare → Settings → Variables and Secrets):
//   GAS_URL : URL Web App của Apps Script (…/exec)
//   GAS_KEY : API key tạo bằng hàm taoApiKey() trong Apps Script (đặt dạng Secret)

const MAX_BODY = 64 * 1024; // 64 KB

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleApi(request, env) {
  if (request.method !== 'POST') return json({ ok: false, msg: 'Chỉ hỗ trợ phương thức POST.' }, 405);

  if (!env.GAS_URL || !env.GAS_KEY) {
    return json({ ok: false, msg: 'Máy chủ chưa cấu hình GAS_URL / GAS_KEY trên Cloudflare.' }, 500);
  }

  // Chỉ nhận request cùng nguồn (chặn trang web khác gọi API)
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, msg: 'Nguồn gọi API không hợp lệ.' }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, msg: 'Dữ liệu gửi lên quá lớn.' }, 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, msg: 'Dữ liệu gửi lên không hợp lệ.' }, 400); }
  if (!body || typeof body.action !== 'string') return json({ ok: false, msg: 'Thiếu action.' }, 400);

  const payload = {
    action: body.action,
    data: body.data && typeof body.data === 'object' ? body.data : {},
    token: typeof body.token === 'string' ? body.token : '',
    key: env.GAS_KEY,
    ip: request.headers.get('CF-Connecting-IP') || '',
  };

  let res;
  try {
    // Apps Script trả 302 → googleusercontent.com; fetch tự theo redirect (POST → GET) để lấy kết quả
    res = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
  } catch (e) {
    return json({ ok: false, msg: 'Không kết nối được Apps Script: ' + e.message }, 502);
  }

  const text = await res.text();
  try {
    JSON.parse(text);
  } catch {
    return json({
      ok: false,
      msg: 'Apps Script không trả về JSON (HTTP ' + res.status + '). Kiểm tra GAS_URL và quyền truy cập Web App = "Anyone".',
    }, 502);
  }
  return new Response(text, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
