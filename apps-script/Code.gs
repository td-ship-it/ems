// ============================================================
//  EMS — Hệ Thống Quản Lý Bảo Trì Thiết Bị · Trường Dược
//  Code.gs  |  Google Apps Script Backend  v4.1
//
//  Kiến trúc:
//    Trình duyệt → Cloudflare Pages (/api) → Apps Script (file này) → Google Sheets
//
//  Bảo mật:
//    - Mọi request phải kèm API_KEY (chỉ Cloudflare biết, lưu trong Script Properties)
//    - Đăng nhập trả về token phiên (6 giờ, gia hạn khi dùng)
//    - Phân quyền kiểm tra ở server: viewer < technician < admin
//    - Đăng nhập 2 bước: CCCD → mã OTP 6 số gửi về email của tài khoản
//    - Khóa tạm IP sau 10 lần đăng nhập sai trong 15 phút
//
//  Thiết lập lần đầu (xem README.md):
//    1. Chạy hàm taoApiKey()   → copy API key trong Execution log
//    2. Chạy hàm khoiTaoDuLieu() → tạo 5 sheet + dữ liệu mẫu
//    3. Deploy → Web app (Execute as: Me · Who has access: Anyone)
// ============================================================

var SS_ID = '';   // Để trống: dùng spreadsheet đang gắn script
var TZ = 'Asia/Ho_Chi_Minh';
var SESSION_TTL = 6 * 3600;          // giây
var MAX_FAIL = 10, FAIL_WINDOW = 900; // 10 lần sai / 15 phút
var OTP_TTL = 300;                   // mã OTP hết hạn sau 5 phút
var OTP_MAX_TRY = 5;                 // nhập sai 5 lần → mã bị hủy
var OTP_COOLDOWN = 60;               // phải chờ 60 giây mới gửi lại mã
var OTP_MAX_PER_HOUR = 5;            // tối đa 5 mã / tài khoản / giờ
var APP_NAME = 'EMS Trường Dược';

var SHEET = { USERS:'NguoiDung', EQ:'ThietBi', MT:'BaoTri', LOC:'DiaDiem', LOG:'NhatKy' };

var USR_H = ['cccd','hoTen','vaiTro','donVi','sdt','email','trangThai'];
var LOC_H = ['loai','ten'];
var EQ_H  = ['soSeri','tenThietBi','danhMuc','model','ngayNhap','giaTriNhap','pctHaoNam',
             'diaDiem','trangThai','ngayBTTiep','moTa','ngayHetHan','pctConLai','haoMon','hieuQua'];
var MT_H  = ['id','eqSeri','tenThietBi','loaiBT','ngayThucHien','nhanVien',
             'chiPhi','ketQua','trangThai','ngayBTTiep','moTaCongViec','ghiChu'];
var LOG_H = ['thoiGian','nguoiThucHien','hanhDong','chiTiet'];

var ROLES      = ['viewer','technician','admin'];
var LOC_TYPES  = ['bomon','phcn','gd','ph'];
var EQ_STATUS  = ['Hoạt động','Bảo trì','Hỏng hóc','Nghỉ hưu'];
var MT_STATUS  = ['Hoàn thành','Đang xử lý','Chờ xử lý'];

// Quyền tối thiểu cho từng action
var PERM = {
  me:'viewer', logout:'viewer',
  getDashboard:'viewer', getEquipment:'viewer', getMaintenance:'viewer',
  getSchedule:'viewer', getLocations:'viewer', getUsers:'viewer',
  addEquipment:'technician', editEquipment:'technician',
  addMaintenance:'technician', editMaintenance:'technician',
  deleteEquipment:'admin', addUser:'admin', editUser:'admin', deleteUser:'admin',
  getLog:'admin', addLocation:'admin', editLocation:'admin', deleteLocation:'admin',
  init:'admin'
};

var HANDLERS = {
  me:apiMe, logout:apiLogout,
  getDashboard:apiDashboard, getEquipment:apiGetEq, addEquipment:apiAddEq,
  editEquipment:apiEditEq, deleteEquipment:apiDelEq,
  getMaintenance:apiGetMt, addMaintenance:apiAddMt, editMaintenance:apiEditMt,
  getUsers:apiGetUsers, addUser:apiAddUser, editUser:apiEditUser, deleteUser:apiDeleteUser,
  getSchedule:apiSchedule, getLog:apiGetLog,
  getLocations:apiGetLocs, addLocation:apiAddLoc, editLocation:apiEditLoc, deleteLocation:apiDelLoc,
  init:function(d, me) { return apiInit(me); }
};

// ──────────────────────────────────────────────────────────
//  ENTRY POINTS
// ──────────────────────────────────────────────────────────
function doGet() {
  return jsonOut({ ok:true, service:'EMS Trường Dược', version:'4.1' });
}

function doPost(e) {
  var r;
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    r = handle(p);
  } catch (err) {
    r = { ok:false, msg:'Lỗi server: ' + err.message };
  }
  return jsonOut(r);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle(p) {
  var key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key) return { ok:false, msg:'Apps Script chưa có API_KEY. Chạy hàm taoApiKey() trong trình soạn thảo.' };
  if (!p || p.key !== key) return { ok:false, code:'KEY', msg:'API key không hợp lệ.' };

  var action = String(p.action || '');
  var d = (p.data && typeof p.data === 'object') ? p.data : {};

  if (action === 'login')     return apiLogin(d, String(p.ip || ''));
  if (action === 'verifyOtp') return apiVerifyOtp(d, String(p.ip || ''));

  // Cho phép khởi tạo lần đầu khi chưa có người dùng nào
  if (action === 'init' && !hasAnyUser()) return apiInit(null);

  var fn = HANDLERS[action];
  if (!fn) return { ok:false, msg:'Action không hợp lệ: ' + action };

  var me = getSessionUser(String(p.token || ''));
  if (!me) return { ok:false, code:'AUTH', msg:'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' };
  if (!hasRole(me, PERM[action] || 'admin')) return { ok:false, code:'FORBIDDEN', msg:'Bạn không có quyền thực hiện thao tác này.' };

  me._token = String(p.token);
  return fn(d, me);
}

// ──────────────────────────────────────────────────────────
//  SPREADSHEET HELPERS
// ──────────────────────────────────────────────────────────
function getSS() { return SS_ID ? SpreadsheetApp.openById(SS_ID) : SpreadsheetApp.getActiveSpreadsheet(); }
function getSheet(n) {
  var sh = getSS().getSheetByName(n);
  if (!sh) throw new Error('Sheet "' + n + '" chưa tồn tại. Chạy khởi tạo dữ liệu trước.');
  return sh;
}

// Chuẩn hóa giá trị ô khi đọc: Date → chuỗi, CCCD/SĐT bị mất số 0 → bù lại
function cellOut(v, key) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, TZ, key === 'thoiGian' ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  if (key === 'cccd') return normCccd(v);
  if (key === 'sdt')  return normPhone(v);
  return v === undefined || v === null ? '' : v;
}

function sheetToObjects(sh) {
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var h = v[0].map(String);
  return v.slice(1).filter(function(row) {
    return row.some(function(c) { return c !== '' && c !== null; });
  }).map(function(row) {
    var o = {};
    h.forEach(function(k, i) { o[k] = cellOut(row[i], k); });
    return o;
  });
}

function rowFrom(obj, headers) {
  return headers.map(function(h) { return obj[h] !== undefined && obj[h] !== null ? obj[h] : ''; });
}

// Tìm dòng (1-based) theo giá trị cột; keyFn để chuẩn hóa (vd CCCD)
function findRow(sh, colIdx, val, keyFn) {
  var v = sh.getDataRange().getValues();
  var norm = keyFn || function(x) { return String(x).trim(); };
  var target = norm(val);
  for (var i = 1; i < v.length; i++) if (norm(v[i][colIdx]) === target) return i + 1;
  return -1;
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function isDateStr(s) { return !s || /^\d{4}-\d{2}-\d{2}$/.test(s); }

// CCCD 12 số / CMND 9 số. Sheets có thể đã đổi "0793…" thành số 793… → bù số 0
function normCccd(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
  if (s.length === 11 || s.length === 8) s = '0' + s;
  return s;
}
function normPhone(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/\s/g, '');
  if (/^\d{9}$/.test(s)) s = '0' + s;
  return s;
}

// Đặt định dạng văn bản thuần (@) cho các cột dễ bị Sheets tự chuyển đổi
function ensureFormats() {
  var ss = getSS();
  function textCols(name, headers, cols) {
    var sh = ss.getSheetByName(name); if (!sh) return;
    cols.forEach(function(c) {
      var i = headers.indexOf(c);
      if (i >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  textCols(SHEET.USERS, USR_H, USR_H);
  textCols(SHEET.LOC, LOC_H, LOC_H);
  textCols(SHEET.EQ, EQ_H, ['soSeri','model','ngayNhap','ngayBTTiep','ngayHetHan']);
  textCols(SHEET.MT, MT_H, ['id','eqSeri','ngayThucHien','ngayBTTiep']);
  textCols(SHEET.LOG, LOG_H, ['thoiGian']);
}

// ──────────────────────────────────────────────────────────
//  AUTH & SESSION
// ──────────────────────────────────────────────────────────
function hasRole(u, need) { return ROLES.indexOf(u.vaiTro) >= ROLES.indexOf(need); }

function hasAnyUser() {
  var sh = getSS().getSheetByName(SHEET.USERS);
  return !!sh && sh.getLastRow() > 1;
}

function findUser(cccd) {
  var c = normCccd(cccd);
  return sheetToObjects(getSheet(SHEET.USERS)).find(function(u) { return u.cccd === c; }) || null;
}

function publicUser(u) {
  return { cccd:u.cccd, hoTen:u.hoTen, vaiTro:u.vaiTro, donVi:u.donVi || '', sdt:u.sdt || '', email:u.email || '' };
}

function getSessionUser(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache();
  var cccd = cache.get('s:' + token);
  if (!cccd) return null;
  var u = findUser(cccd);
  if (!u || String(u.trangThai).toLowerCase() !== 'active') { cache.remove('s:' + token); return null; }
  cache.put('s:' + token, cccd, SESSION_TTL); // gia hạn phiên
  return u;
}

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }

function maskEmail(e) {
  var p = String(e).split('@'), n = p[0];
  var shown = n.length <= 2 ? n.charAt(0) : n.slice(0, 2);
  return shown + '•••' + (n.length > 3 ? n.slice(-1) : '') + '@' + p[1];
}

// Mã 6 số ngẫu nhiên lấy từ UUID (nguồn ngẫu nhiên an toàn của Apps Script)
function genOtp() {
  var hex = Utilities.getUuid().replace(/-/g, '');
  return String(parseInt(hex.slice(0, 12), 16) % 1000000).padStart(6, '0');
}

function loginFails(ip) {
  var cache = CacheService.getScriptCache(), k = 'f:' + (ip || 'unknown');
  return {
    count: parseInt(cache.get(k) || '0', 10),
    add: function() { cache.put(k, String(this.count + 1), FAIL_WINDOW); },
    clear: function() { cache.remove(k); }
  };
}

function sendOtpMail(u, otp) {
  var mins = Math.round(OTP_TTL / 60);
  var html =
    '<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:24px;border:1px solid #c8dfc9;border-radius:12px">' +
    '<div style="font-size:13px;color:#1a7a3c;font-weight:bold;letter-spacing:.5px">⚕️ ' + APP_NAME.toUpperCase() + '</div>' +
    '<h2 style="margin:12px 0 6px;color:#1a2e1b">Mã đăng nhập của bạn</h2>' +
    '<p style="color:#4a7055;font-size:14px">Xin chào <b>' + escHtml(u.hoTen) + '</b>, dùng mã dưới đây để đăng nhập hệ thống quản lý bảo trì thiết bị:</p>' +
    '<div style="font-size:34px;font-weight:bold;letter-spacing:10px;text-align:center;background:#f0f7f1;color:#1a7a3c;padding:16px;border-radius:10px;margin:18px 0;font-family:monospace">' + otp + '</div>' +
    '<p style="color:#4a7055;font-size:13px">Mã có hiệu lực trong <b>' + mins + ' phút</b> và chỉ dùng được một lần.</p>' +
    '<p style="color:#8aaa8c;font-size:12px">Nếu bạn không yêu cầu đăng nhập, hãy bỏ qua email này và báo cho quản trị viên — có thể ai đó đang thử dùng số CCCD của bạn.</p>' +
    '</div>';
  MailApp.sendEmail({
    to: u.email,
    subject: '[' + APP_NAME + '] Mã đăng nhập: ' + otp,
    body: 'Mã đăng nhập ' + APP_NAME + ': ' + otp + '\nCó hiệu lực ' + mins + ' phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.',
    htmlBody: html,
    name: APP_NAME
  });
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Bước 1: nhập CCCD → gửi OTP về email
function apiLogin(d, ip) {
  var cache = CacheService.getScriptCache();
  var fails = loginFails(ip);
  if (fails.count >= MAX_FAIL) return { ok:false, msg:'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' };

  var cccd = normCccd(d.cccd);
  if (!/^\d{9}$|^\d{12}$/.test(cccd)) return { ok:false, msg:'CCCD phải có 9 hoặc 12 chữ số.' };

  var u = findUser(cccd);
  if (!u) { fails.add(); return { ok:false, msg:'CCCD không tồn tại trong hệ thống.' }; }
  if (String(u.trangThai).toLowerCase() !== 'active') return { ok:false, msg:'Tài khoản đã bị vô hiệu hóa.' };
  if (!isEmail(u.email)) return { ok:false, msg:'Tài khoản chưa có email hợp lệ để nhận mã OTP. Vui lòng liên hệ Admin.' };

  var cdKey = 'cd:' + cccd, hrKey = 'hr:' + cccd;
  var cdLeft = parseInt(cache.get(cdKey) || '0', 10) - Math.floor(Date.now() / 1000);
  if (cdLeft > 0) return { ok:false, wait:cdLeft, msg:'Vui lòng chờ ' + cdLeft + ' giây trước khi gửi lại mã.' };
  var sentHour = parseInt(cache.get(hrKey) || '0', 10);
  if (sentHour >= OTP_MAX_PER_HOUR) return { ok:false, msg:'Đã gửi quá nhiều mã cho tài khoản này. Vui lòng thử lại sau 1 giờ.' };

  var otp = genOtp();
  var challenge = Utilities.getUuid().replace(/-/g, '');
  try {
    sendOtpMail(u, otp);
  } catch (e) {
    return { ok:false, msg:'Không gửi được email OTP: ' + e.message };
  }
  // Mỗi tài khoản chỉ có 1 mã còn hiệu lực: hủy mã cũ
  var old = cache.get('oc:' + cccd); if (old) cache.remove('o:' + old);
  cache.put('o:' + challenge, JSON.stringify({ cccd:cccd, otp:otp, tries:0, exp:Date.now() + OTP_TTL * 1000 }), OTP_TTL);
  cache.put('oc:' + cccd, challenge, OTP_TTL);
  cache.put(cdKey, String(Math.floor(Date.now() / 1000) + OTP_COOLDOWN), OTP_COOLDOWN);
  cache.put(hrKey, String(sentHour + 1), 3600);
  addLogEntry(u, 'Gửi mã OTP', u.hoTen + ' → ' + maskEmail(u.email));
  return { ok:true, otp:true, challenge:challenge, email:maskEmail(u.email), ttl:OTP_TTL, cooldown:OTP_COOLDOWN };
}

// Bước 2: nhập mã OTP → nhận token phiên
function apiVerifyOtp(d, ip) {
  var cache = CacheService.getScriptCache();
  var fails = loginFails(ip);
  if (fails.count >= MAX_FAIL) return { ok:false, msg:'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' };

  var challenge = str(d.challenge), code = String(d.otp || '').replace(/\D/g, '');
  var raw = challenge ? cache.get('o:' + challenge) : null;
  if (!raw) return { ok:false, expired:true, msg:'Mã OTP đã hết hạn hoặc không còn hiệu lực. Vui lòng gửi lại mã.' };
  var c = JSON.parse(raw);
  if (Date.now() > c.exp) { cache.remove('o:' + challenge); return { ok:false, expired:true, msg:'Mã OTP đã hết hạn. Vui lòng gửi lại mã.' }; }

  if (code.length !== 6 || code !== c.otp) {
    fails.add();
    c.tries++;
    if (c.tries >= OTP_MAX_TRY) {
      cache.remove('o:' + challenge);
      return { ok:false, expired:true, msg:'Nhập sai quá ' + OTP_MAX_TRY + ' lần. Mã đã bị hủy, vui lòng gửi lại mã mới.' };
    }
    cache.put('o:' + challenge, JSON.stringify(c), Math.max(1, Math.ceil((c.exp - Date.now()) / 1000)));
    return { ok:false, msg:'Mã OTP không đúng. Còn ' + (OTP_MAX_TRY - c.tries) + ' lần thử.' };
  }

  cache.remove('o:' + challenge);
  cache.remove('oc:' + c.cccd);
  var u = findUser(c.cccd);
  if (!u || String(u.trangThai).toLowerCase() !== 'active') return { ok:false, msg:'Tài khoản đã bị vô hiệu hóa.' };

  fails.clear();
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('s:' + token, u.cccd, SESSION_TTL);
  addLogEntry(u, 'Đăng nhập', u.hoTen + ' (xác thực OTP)');
  return { ok:true, token:token, user:publicUser(u) };
}

function apiMe(d, me) { return { ok:true, user:publicUser(me) }; }

function apiLogout(d, me) {
  CacheService.getScriptCache().remove('s:' + me._token);
  return { ok:true };
}

// ──────────────────────────────────────────────────────────
//  CALCULATIONS (tính khi đọc — không ghi sheet mỗi request)
// ──────────────────────────────────────────────────────────
// pctHaoNam: % hao mòn mỗi năm (10 → tuổi thọ 10 năm = 120 tháng)
var MS_MONTH = 1000 * 60 * 60 * 24 * 30.44;

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function pctHaoToMonths(p) { return p > 0 ? Math.round(1200 / p) : 0; }
function calcNgayHetHan(importDate, p) {
  var d = toDate(importDate); if (!d || !p) return '';
  return Utilities.formatDate(new Date(d.getTime() + pctHaoToMonths(p) * MS_MONTH), TZ, 'yyyy-MM-dd');
}
function usedMonths(importDate) { var d = toDate(importDate); return d ? (Date.now() - d.getTime()) / MS_MONTH : 0; }
function calcPctConLai(importDate, p) {
  if (!toDate(importDate) || !p) return 100;
  return Math.max(0, Math.round((1 - usedMonths(importDate) / pctHaoToMonths(p)) * 1000) / 10);
}
function calcWear(importDate, p) {
  if (!toDate(importDate) || !p) return 0;
  return Math.min(100, Math.max(0, Math.round(usedMonths(importDate) / pctHaoToMonths(p) * 1000) / 10));
}
function calcEff(status, wear) {
  if (['Hỏng hóc','Nghỉ hưu','Bảo trì'].indexOf(status) > -1) return 0;
  return Math.max(0, Math.round((100 - wear) * 10) / 10);
}
function enrichEq(e) {
  var p = num(e.pctHaoNam) || 10;
  e.haoMon = calcWear(e.ngayNhap, p);
  e.hieuQua = calcEff(e.trangThai, e.haoMon);
  e.ngayHetHan = calcNgayHetHan(e.ngayNhap, p);
  e.pctConLai = calcPctConLai(e.ngayNhap, p);
  return e;
}
function loadEq() { return sheetToObjects(getSheet(SHEET.EQ)).map(enrichEq); }

// Ghi các cột tính toán vào sheet một lần (dùng cho trigger hằng ngày)
function recalcAllEquipment() {
  var sh = getSS().getSheetByName(SHEET.EQ); if (!sh) return;
  var eqs = loadEq(); if (!eqs.length) return;
  var iHH = EQ_H.indexOf('ngayHetHan');
  sh.getRange(2, iHH + 1, eqs.length, 4).setValues(eqs.map(function(e) {
    return [e.ngayHetHan, e.pctConLai, e.haoMon, e.hieuQua];
  }));
}

function daysFromNow(v) { var d = toDate(v); return d ? (d.getTime() - Date.now()) / 86400000 : null; }

// ──────────────────────────────────────────────────────────
//  LOCATIONS (DiaDiem)
// ──────────────────────────────────────────────────────────
function apiGetLocs() { return { ok:true, data:sheetToObjects(getSheet(SHEET.LOC)) }; }

function apiAddLoc(d, me) {
  var ten = str(d.ten), loai = str(d.loai);
  if (!ten || LOC_TYPES.indexOf(loai) < 0) return { ok:false, msg:'Thiếu tên hoặc loại địa điểm không hợp lệ.' };
  return withLock(function() {
    var sh = getSheet(SHEET.LOC);
    if (findRow(sh, 1, ten) > 0) return { ok:false, msg:'Địa điểm "' + ten + '" đã tồn tại.' };
    sh.appendRow([loai, ten]);
    addLogEntry(me, 'Thêm địa điểm', ten + ' (' + loai + ')');
    return { ok:true };
  });
}

function apiEditLoc(d, me) {
  var tenCu = str(d.tenCu), ten = str(d.ten), loai = str(d.loai);
  if (!tenCu || !ten || LOC_TYPES.indexOf(loai) < 0) return { ok:false, msg:'Thiếu thông tin địa điểm.' };
  return withLock(function() {
    var sh = getSheet(SHEET.LOC);
    var row = findRow(sh, 1, tenCu);
    if (row < 0) return { ok:false, msg:'Không tìm thấy địa điểm "' + tenCu + '".' };
    if (tenCu !== ten && findRow(sh, 1, ten) > 0) return { ok:false, msg:'Địa điểm "' + ten + '" đã tồn tại.' };
    sh.getRange(row, 1, 1, 2).setValues([[loai, ten]]);
    if (tenCu !== ten) {
      var eqsh = getSS().getSheetByName(SHEET.EQ);
      if (eqsh && eqsh.getLastRow() > 1) {
        var hi = EQ_H.indexOf('diaDiem');
        var rg = eqsh.getRange(2, hi + 1, eqsh.getLastRow() - 1, 1);
        rg.setValues(rg.getValues().map(function(r) { return [String(r[0]) === tenCu ? ten : r[0]]; }));
      }
    }
    addLogEntry(me, 'Sửa địa điểm', tenCu + ' → ' + ten);
    return { ok:true };
  });
}

function apiDelLoc(d, me) {
  var ten = str(d.ten);
  if (!ten) return { ok:false, msg:'Thiếu tên địa điểm.' };
  return withLock(function() {
    var used = sheetToObjects(getSheet(SHEET.EQ)).filter(function(e) { return e.diaDiem === ten; }).length;
    if (used > 0) return { ok:false, msg:'Không thể xóa: có ' + used + ' thiết bị đang dùng địa điểm này.' };
    var sh = getSheet(SHEET.LOC);
    var row = findRow(sh, 1, ten);
    if (row < 0) return { ok:false, msg:'Không tìm thấy địa điểm.' };
    sh.deleteRow(row);
    addLogEntry(me, 'Xóa địa điểm', ten);
    return { ok:true };
  });
}

// ──────────────────────────────────────────────────────────
//  DASHBOARD
// ──────────────────────────────────────────────────────────
function apiDashboard() {
  var eqs = loadEq();
  var mts = sheetToObjects(getSheet(SHEET.MT));
  var locType = {};
  sheetToObjects(getSheet(SHEET.LOC)).forEach(function(r) { locType[r.ten] = r.loai; });

  function count(st) { return eqs.filter(function(e) { return e.trangThai === st; }).length; }
  function avg(k) { return eqs.length ? +(eqs.reduce(function(s, e) { return s + num(e[k]); }, 0) / eqs.length).toFixed(1) : 0; }

  var stats = {
    total:eqs.length, active:count('Hoạt động'), mt:count('Bảo trì'),
    broken:count('Hỏng hóc'), retired:count('Nghỉ hưu'),
    totalCost:mts.reduce(function(s, m) { return s + num(m.chiPhi); }, 0),
    avgWear:avg('haoMon'), avgEff:avg('hieuQua')
  };
  var catMap = {}, locMap = { bomon:0, phcn:0, gd:0, ph:0 };
  eqs.forEach(function(e) {
    var c = e.danhMuc || 'Khác'; catMap[c] = (catMap[c] || 0) + 1;
    var t = locType[e.diaDiem] || 'gd'; if (locMap[t] !== undefined) locMap[t]++;
  });
  var upcoming = eqs.filter(function(e) {
    if (e.trangThai === 'Nghỉ hưu') return false;
    var dd = daysFromNow(e.ngayBTTiep); return dd !== null && dd <= 30 && dd > -1;
  }).length;
  var recentMt = mts.slice().sort(function(a, b) {
    return String(b.ngayThucHien).localeCompare(String(a.ngayThucHien));
  }).slice(0, 8);
  return { ok:true, stats:stats, catMap:catMap, locMap:locMap, upcoming:upcoming, recentMt:recentMt };
}

// ──────────────────────────────────────────────────────────
//  EQUIPMENT — soSeri là khóa chính
// ──────────────────────────────────────────────────────────
function apiGetEq(d) {
  var rows = loadEq();
  if (d.diaDiem)   rows = rows.filter(function(r) { return r.diaDiem === d.diaDiem; });
  if (d.trangThai) rows = rows.filter(function(r) { return r.trangThai === d.trangThai; });
  if (d.danhMuc)   rows = rows.filter(function(r) { return r.danhMuc === d.danhMuc; });
  if (d.q) {
    var q = String(d.q).toLowerCase();
    rows = rows.filter(function(r) {
      return [r.tenThietBi, r.soSeri, r.model, r.diaDiem].join(' ').toLowerCase().indexOf(q) > -1;
    });
  }
  return { ok:true, data:rows };
}

function eqRecord(d) {
  var rec = {
    soSeri:str(d.soSeri), tenThietBi:str(d.tenThietBi), danhMuc:str(d.danhMuc) || 'Khác',
    model:str(d.model), ngayNhap:str(d.ngayNhap), giaTriNhap:num(d.giaTriNhap),
    pctHaoNam:num(d.pctHaoNam) || 10, diaDiem:str(d.diaDiem),
    trangThai:EQ_STATUS.indexOf(str(d.trangThai)) > -1 ? str(d.trangThai) : 'Hoạt động',
    ngayBTTiep:str(d.ngayBTTiep), moTa:str(d.moTa)
  };
  return enrichEq(rec);
}

function validateEq(rec) {
  if (!rec.soSeri || !rec.tenThietBi || !rec.diaDiem) return 'Thiếu Số Serial, tên thiết bị hoặc địa điểm.';
  if (!isDateStr(rec.ngayNhap) || !isDateStr(rec.ngayBTTiep)) return 'Ngày không đúng định dạng yyyy-MM-dd.';
  if (rec.pctHaoNam <= 0 || rec.pctHaoNam > 100) return '% hao mòn/năm phải trong khoảng 0–100.';
  if (findRow(getSheet(SHEET.LOC), 1, rec.diaDiem) < 0) return 'Địa điểm "' + rec.diaDiem + '" không tồn tại.';
  return '';
}

function apiAddEq(d, me) {
  var rec = eqRecord(d);
  var err = validateEq(rec); if (err) return { ok:false, msg:err };
  return withLock(function() {
    var sh = getSheet(SHEET.EQ);
    if (findRow(sh, 0, rec.soSeri) > 0) return { ok:false, msg:'Số Serial "' + rec.soSeri + '" đã tồn tại.' };
    sh.appendRow(rowFrom(rec, EQ_H));
    addLogEntry(me, 'Thêm thiết bị', rec.tenThietBi + ' [' + rec.soSeri + '] tại ' + rec.diaDiem);
    return { ok:true, data:rec };
  });
}

function apiEditEq(d, me) {
  var rec = eqRecord(d);
  var err = validateEq(rec); if (err) return { ok:false, msg:err };
  return withLock(function() {
    var sh = getSheet(SHEET.EQ);
    var row = findRow(sh, 0, rec.soSeri);
    if (row < 0) return { ok:false, msg:'Không tìm thấy Serial "' + rec.soSeri + '".' };
    sh.getRange(row, 1, 1, EQ_H.length).setValues([rowFrom(rec, EQ_H)]);
    addLogEntry(me, 'Cập nhật thiết bị', rec.tenThietBi + ' [' + rec.soSeri + ']');
    return { ok:true, data:rec };
  });
}

function apiDelEq(d, me) {
  var seri = str(d.soSeri);
  if (!seri) return { ok:false, msg:'Thiếu Số Serial.' };
  return withLock(function() {
    var sh = getSheet(SHEET.EQ);
    var row = findRow(sh, 0, seri);
    if (row < 0) return { ok:false, msg:'Không tìm thấy thiết bị.' };
    var name = sh.getRange(row, 2).getValue();
    sh.deleteRow(row);
    addLogEntry(me, 'Xóa thiết bị', name + ' [' + seri + ']');
    return { ok:true };
  });
}

// ──────────────────────────────────────────────────────────
//  MAINTENANCE
// ──────────────────────────────────────────────────────────
function apiGetMt(d) {
  var rows = sheetToObjects(getSheet(SHEET.MT));
  if (d.trangThai) rows = rows.filter(function(r) { return r.trangThai === d.trangThai; });
  if (d.eqSeri)    rows = rows.filter(function(r) { return r.eqSeri === d.eqSeri; });
  rows.sort(function(a, b) { return String(b.ngayThucHien).localeCompare(String(a.ngayThucHien)); });
  return { ok:true, data:rows };
}

function mtRecord(d, id) {
  return {
    id:id, eqSeri:str(d.eqSeri), tenThietBi:str(d.tenThietBi),
    loaiBT:str(d.loaiBT) || 'Bảo dưỡng định kỳ', ngayThucHien:str(d.ngayThucHien),
    nhanVien:str(d.nhanVien), chiPhi:num(d.chiPhi), ketQua:str(d.ketQua) || 'Tốt',
    trangThai:MT_STATUS.indexOf(str(d.trangThai)) > -1 ? str(d.trangThai) : 'Hoàn thành',
    ngayBTTiep:str(d.ngayBTTiep), moTaCongViec:str(d.moTaCongViec), ghiChu:str(d.ghiChu)
  };
}

function syncNextMaintenance(eqSeri, ngayBTTiep) {
  if (!ngayBTTiep) return;
  var sh = getSheet(SHEET.EQ);
  var row = findRow(sh, 0, eqSeri);
  if (row > 0) sh.getRange(row, EQ_H.indexOf('ngayBTTiep') + 1).setValue(ngayBTTiep);
}

function apiAddMt(d, me) {
  if (!str(d.eqSeri) || !str(d.ngayThucHien)) return { ok:false, msg:'Thiếu thiết bị hoặc ngày thực hiện.' };
  if (!isDateStr(str(d.ngayThucHien)) || !isDateStr(str(d.ngayBTTiep))) return { ok:false, msg:'Ngày không đúng định dạng.' };
  return withLock(function() {
    if (findRow(getSheet(SHEET.EQ), 0, d.eqSeri) < 0) return { ok:false, msg:'Thiết bị không tồn tại.' };
    var id = 'BT' + Utilities.formatDate(new Date(), TZ, 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
    var rec = mtRecord(d, id);
    getSheet(SHEET.MT).appendRow(rowFrom(rec, MT_H));
    syncNextMaintenance(rec.eqSeri, rec.ngayBTTiep);
    addLogEntry(me, 'Ghi nhận bảo trì', rec.tenThietBi + ' [' + rec.eqSeri + '] – ' + rec.loaiBT);
    return { ok:true, id:id, data:rec };
  });
}

function apiEditMt(d, me) {
  var id = str(d.id);
  if (!id) return { ok:false, msg:'Thiếu ID bảo trì.' };
  if (!isDateStr(str(d.ngayThucHien)) || !isDateStr(str(d.ngayBTTiep))) return { ok:false, msg:'Ngày không đúng định dạng.' };
  return withLock(function() {
    var sh = getSheet(SHEET.MT);
    var row = findRow(sh, 0, id);
    if (row < 0) return { ok:false, msg:'Không tìm thấy bản ghi.' };
    var rec = mtRecord(d, id);
    sh.getRange(row, 1, 1, MT_H.length).setValues([rowFrom(rec, MT_H)]);
    syncNextMaintenance(rec.eqSeri, rec.ngayBTTiep);
    addLogEntry(me, 'Sửa bảo trì', id + ' – ' + rec.tenThietBi);
    return { ok:true, data:rec };
  });
}

// ──────────────────────────────────────────────────────────
//  SCHEDULE
// ──────────────────────────────────────────────────────────
function apiSchedule() {
  var data = loadEq().filter(function(e) {
    if (e.trangThai === 'Nghỉ hưu') return false;
    var dd = daysFromNow(e.ngayBTTiep); return dd !== null && dd <= 60;
  }).sort(function(a, b) { return String(a.ngayBTTiep).localeCompare(String(b.ngayBTTiep)); });
  return { ok:true, data:data };
}

// ──────────────────────────────────────────────────────────
//  USERS
// ──────────────────────────────────────────────────────────
function activeAdmins(users) {
  return users.filter(function(u) { return u.vaiTro === 'admin' && String(u.trangThai).toLowerCase() === 'active'; });
}

function apiGetUsers(d, me) {
  var users = sheetToObjects(getSheet(SHEET.USERS));
  // CCCD là mật khẩu → chỉ Admin thấy đầy đủ
  if (me.vaiTro !== 'admin') {
    return { ok:true, data:users.filter(function(u) { return u.trangThai === 'active'; })
      .map(function(u) { return { hoTen:u.hoTen, vaiTro:u.vaiTro }; }) };
  }
  return { ok:true, data:users };
}

function userRecord(d) {
  return {
    cccd:normCccd(d.cccd), hoTen:str(d.hoTen),
    vaiTro:ROLES.indexOf(str(d.vaiTro)) > -1 ? str(d.vaiTro) : 'viewer',
    donVi:str(d.donVi), sdt:str(d.sdt), email:str(d.email),
    trangThai:str(d.trangThai) === 'inactive' ? 'inactive' : 'active'
  };
}

function apiAddUser(d, me) {
  var rec = userRecord(d);
  if (!rec.hoTen) return { ok:false, msg:'Thiếu họ tên.' };
  if (!/^\d{9}$|^\d{12}$/.test(rec.cccd)) return { ok:false, msg:'CCCD phải có 9 hoặc 12 chữ số.' };
  if (!isEmail(rec.email)) return { ok:false, msg:'Email không hợp lệ — cần email để nhận mã OTP khi đăng nhập.' };
  return withLock(function() {
    if (findUser(rec.cccd)) return { ok:false, msg:'CCCD đã tồn tại.' };
    getSheet(SHEET.USERS).appendRow(rowFrom(rec, USR_H));
    addLogEntry(me, 'Thêm nhân viên', rec.hoTen);
    return { ok:true, data:rec };
  });
}

function apiEditUser(d, me) {
  var rec = userRecord(d);
  if (!rec.cccd || !rec.hoTen) return { ok:false, msg:'Thiếu CCCD hoặc họ tên.' };
  if (!isEmail(rec.email)) return { ok:false, msg:'Email không hợp lệ — cần email để nhận mã OTP khi đăng nhập.' };
  return withLock(function() {
    var sh = getSheet(SHEET.USERS);
    var users = sheetToObjects(sh);
    var target = users.find(function(u) { return u.cccd === rec.cccd; });
    if (!target) return { ok:false, msg:'Không tìm thấy nhân viên.' };
    var losingAdmin = target.vaiTro === 'admin' && target.trangThai === 'active' &&
                      (rec.vaiTro !== 'admin' || rec.trangThai !== 'active');
    if (losingAdmin && rec.cccd === me.cccd) return { ok:false, msg:'Bạn không thể tự hạ quyền hoặc khóa tài khoản của chính mình.' };
    if (losingAdmin && activeAdmins(users).length <= 1) return { ok:false, msg:'Hệ thống phải còn ít nhất một Admin đang hoạt động.' };
    var row = findRow(sh, 0, rec.cccd, normCccd);
    sh.getRange(row, 1, 1, USR_H.length).setValues([rowFrom(rec, USR_H)]);
    addLogEntry(me, 'Sửa nhân viên', rec.hoTen);
    return { ok:true, data:rec };
  });
}

function apiDeleteUser(d, me) {
  var cccd = normCccd(d.cccd);
  if (!cccd) return { ok:false, msg:'Thiếu CCCD.' };
  if (cccd === me.cccd) return { ok:false, msg:'Bạn không thể xóa tài khoản của chính mình.' };
  return withLock(function() {
    var sh = getSheet(SHEET.USERS);
    var users = sheetToObjects(sh);
    var target = users.find(function(u) { return u.cccd === cccd; });
    if (!target) return { ok:false, msg:'Không tìm thấy nhân viên.' };
    if (target.vaiTro === 'admin' && target.trangThai === 'active' && activeAdmins(users).length <= 1)
      return { ok:false, msg:'Không thể xóa Admin duy nhất còn lại của hệ thống.' };
    sh.deleteRow(findRow(sh, 0, cccd, normCccd));
    addLogEntry(me, 'Xóa nhân viên', target.hoTen);
    return { ok:true };
  });
}

// ──────────────────────────────────────────────────────────
//  LOG
// ──────────────────────────────────────────────────────────
function addLogEntry(actor, action, detail) {
  try {
    var sh = getSS().getSheetByName(SHEET.LOG);
    if (!sh) return;
    sh.appendRow([Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
                  actor ? actor.hoTen : 'Hệ thống', action, detail]);
  } catch (e) {}
}

function apiGetLog() {
  var sh = getSS().getSheetByName(SHEET.LOG);
  if (!sh) return { ok:true, data:[] };
  return { ok:true, data:sheetToObjects(sh).reverse().slice(0, 100) };
}

// ──────────────────────────────────────────────────────────
//  DAILY TRIGGER
// ──────────────────────────────────────────────────────────
function dailyJob() { recalcAllEquipment(); sendMaintenanceAlerts(); }

function sendMaintenanceAlerts() {
  var admins = activeAdmins(sheetToObjects(getSheet(SHEET.USERS)))
    .map(function(u) { return u.email; }).filter(Boolean);
  if (!admins.length) return;
  var alerts = loadEq().filter(function(e) {
    if (e.trangThai === 'Nghỉ hưu') return false;
    var dd = daysFromNow(e.ngayBTTiep); return dd !== null && dd <= 7 && dd >= -1;
  });
  if (!alerts.length) return;
  var body = 'Thiết bị sắp đến hạn bảo trì (trong 7 ngày):\n\n';
  alerts.forEach(function(e) {
    body += '• ' + e.tenThietBi + ' [' + e.soSeri + '] – ' + e.diaDiem + ' – BT: ' + e.ngayBTTiep + '\n';
  });
  MailApp.sendEmail(admins.join(','), '[EMS Trường Dược] Cảnh báo lịch bảo trì', body);
}

// Chạy 1 lần trong trình soạn thảo để bật trigger 7h sáng hằng ngày
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(7).create();
}

// ──────────────────────────────────────────────────────────
//  HÀM CHẠY TRONG TRÌNH SOẠN THẢO
// ──────────────────────────────────────────────────────────
// Tạo API key ngẫu nhiên → copy giá trị trong "Execution log" dán vào Cloudflare (GAS_KEY)
function taoApiKey() {
  var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  Logger.log('API_KEY = ' + key);
}

// Khởi tạo dữ liệu mẫu (GHI ĐÈ toàn bộ dữ liệu)
function khoiTaoDuLieu() { Logger.log(JSON.stringify(apiInit(null))); }

// Gửi thử 1 email để cấp quyền gửi mail và xem hạn mức còn lại trong ngày
function guiThuEmail() {
  var to = ownerEmail();
  MailApp.sendEmail(to, '[' + APP_NAME + '] Email thử', 'Apps Script gửi email OTP hoạt động bình thường.');
  Logger.log('Đã gửi tới ' + to + ' · Hạn mức email còn lại hôm nay: ' + MailApp.getRemainingDailyQuota());
}

// Sửa dữ liệu cũ: đặt định dạng văn bản + bù số 0 cho CCCD/SĐT đã bị mất
function suaDinhDangDuLieuCu() {
  ensureFormats();
  var sh = getSS().getSheetByName(SHEET.USERS);
  // Sheet NhatKy bản cũ có 3 cột → chèn cột nguoiThucHien
  var lg = getSS().getSheetByName(SHEET.LOG);
  if (lg && String(lg.getRange(1, 2).getValue()) !== 'nguoiThucHien') {
    lg.insertColumnAfter(1);
    lg.getRange(1, 2).setValue('nguoiThucHien');
  }
  if (sh && sh.getLastRow() > 1) {
    var rg = sh.getRange(2, 1, sh.getLastRow() - 1, USR_H.length);
    rg.setValues(rg.getValues().map(function(r) {
      r[0] = normCccd(r[0]); r[4] = normPhone(r[4]); return r;
    }));
  }
  recalcAllEquipment();
  Logger.log('Đã cập nhật định dạng.');
}

// ──────────────────────────────────────────────────────────
//  INIT — tạo 5 sheets + dữ liệu mẫu
// ──────────────────────────────────────────────────────────
function ownerEmail() {
  try { return Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function resetSheet(ss, name, headers, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function writeRows(sh, headers, rows) {
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function apiInit(me) {
  return withLock(function() {
    var ss = getSS();
    var ush = resetSheet(ss, SHEET.USERS, USR_H);
    var lsh = resetSheet(ss, SHEET.LOC, LOC_H);
    var esh = resetSheet(ss, SHEET.EQ, EQ_H);
    var msh = resetSheet(ss, SHEET.MT, MT_H);
    var nsh = resetSheet(ss, SHEET.LOG, LOG_H);
    ensureFormats(); // phải đặt định dạng TRƯỚC khi ghi dữ liệu

    // Tài khoản mẫu nhận OTP qua email của người sở hữu Apps Script (để đăng nhập thử được ngay)
    var owner = ownerEmail();
    writeRows(ush, USR_H, [
      ['079301001234','Nguyễn Văn Quản Lý','admin','Ban Giám Hiệu','0901234567', owner || 'quanly@truongduoc.edu.vn','active'],
      ['079201005678','Trần Thị Kỹ Thuật','technician','Phòng Kế Hoạch - Tài Chính','0912345678', owner || 'kythuat@truongduoc.edu.vn','active'],
      ['079101009999','Lê Văn Xem','viewer','Phòng Đào Tạo','0923456789', owner || 'xem@truongduoc.edu.vn','active']
    ]);

    var locs = [];
    ['BM Dược liệu - Dược học cổ truyền','BM Dược lý','BM Hóa dược - Kiểm nghiệm thuốc','BM Hóa sinh - Độc chất',
     'BM Bào chế - Công nghệ dược','BM Quản lý & Kinh tế dược','BM Vi sinh - Ký sinh trùng','BM Sinh lý - Sinh lý bệnh',
     'BM Giải phẫu - Mô phôi','BM Toán - Tin học','BM Lý - Hóa cơ sở','BM Ngoại ngữ'].forEach(function(t) { locs.push(['bomon', t]); });
    ['Phòng Đào Tạo','Phòng Hành Chính - Tổng Hợp','Phòng Kế Hoạch - Tài Chính'].forEach(function(t) { locs.push(['phcn', t]); });
    ['Giảng Đường A101','Giảng Đường A102','Giảng Đường A103','Giảng Đường A104','Giảng Đường A201','Giảng Đường A202',
     'Giảng Đường A203','Giảng Đường A204','Giảng Đường B101','Giảng Đường B102','Giảng Đường B201','Giảng Đường B202',
     'Phòng Thực Hành TH01','Phòng Thực Hành TH02','Phòng Thực Hành TH03','Phòng Lab Dược liệu','Phòng Lab Hóa dược',
     'Phòng Lab Vi sinh','Phòng Lab Bào chế','Phòng Máy Tính MT01','Phòng Máy Tính MT02'].forEach(function(t) { locs.push(['gd', t]); });
    ['Phòng Họp Ban Giám Hiệu','Phòng Họp Tầng 2','Hội Trường'].forEach(function(t) { locs.push(['ph', t]); });
    writeRows(lsh, LOC_H, locs);

    var eqs = [
      ['LG-VN-001','Điều Hòa LG 2HP Inverter','Điều Hòa','LG V13ENS1','2022-03-10',14500000,10,'Phòng Họp Ban Giám Hiệu','Hoạt động','2026-11-10','Điều hòa phòng họp BGH'],
      ['EP-X51-002','Máy Chiếu Epson EB-X51','Máy Chiếu','Epson EB-X51','2021-08-15',18000000,12,'Giảng Đường A101','Hoạt động','2026-10-15','Máy chiếu 3800lm'],
      ['EP-X51-003','Máy Chiếu Epson EB-X51','Máy Chiếu','Epson EB-X51','2021-08-15',18000000,12,'Giảng Đường A102','Hoạt động','2026-10-20',''],
      ['PA-VW-004','Máy Chiếu Panasonic PT-VW360','Máy Chiếu','Panasonic PT-VW360','2020-01-20',22000000,12,'Hội Trường','Bảo trì','2026-10-01','Đang thay bóng đèn'],
      ['CN-LBP-005','Máy In Canon LBP6030','Máy In','Canon LBP6030','2021-05-01',3800000,20,'Phòng Đào Tạo','Hoạt động','2026-11-01',''],
      ['CN-MF-006','Máy In Canon MF3010','Máy In','Canon MF3010','2020-07-10',4200000,20,'Phòng Hành Chính - Tổng Hợp','Hoạt động','2027-01-10',''],
      ['HP-MN-007','Máy In HP LaserJet M404n','Máy In','HP M404n','2022-11-20',6500000,15,'Phòng Kế Hoạch - Tài Chính','Hoạt động','2026-11-20',''],
      ['DL-OP-008','Máy Tính Dell OptiPlex 7090','Máy Tính / Laptop','Dell OptiPlex 7090','2023-02-01',26000000,20,'Phòng Máy Tính MT01','Hoạt động','2027-02-01','PC i7'],
      ['DL-OP-009','Máy Tính Dell OptiPlex 7090','Máy Tính / Laptop','Dell OptiPlex 7090','2023-02-01',26000000,20,'Phòng Máy Tính MT02','Hoạt động','2027-02-01',''],
      ['APC-15-010','UPS APC 1500VA','Điện - UPS','APC SMT1500I','2020-04-15',9500000,20,'Phòng Lab Hóa dược','Hỏng hóc','2026-09-30','Mạch nạp hỏng'],
      ['DK-FC-011','Điều Hòa Daikin 1.5HP','Điều Hòa','Daikin FTKC35RVMV','2022-09-01',11000000,10,'BM Dược liệu - Dược học cổ truyền','Hoạt động','2026-12-01',''],
      ['BQ-MW-012','Máy Chiếu BenQ MW535','Máy Chiếu','BenQ MW535','2022-06-10',14000000,12,'Giảng Đường B101','Hoạt động','2026-12-10',''],
      ['LG-MH-013','Màn Hình LG 27 4K','Màn Hình','LG 27UK850','2023-05-20',8500000,15,'Phòng Họp Tầng 2','Hoạt động','2027-05-20',''],
      ['HK-CAM-014','Camera IP Hikvision 4MP','Camera / An Ninh','DS-2CD2143G2-I','2022-01-05',2800000,15,'Giảng Đường A201','Hoạt động','2027-01-05',''],
      ['JBL-PR-015','Bộ Loa JBL PRX915','Thiết Bị Âm Thanh','JBL PRX915','2021-10-10',35000000,10,'Hội Trường','Hoạt động','2026-10-10',''],
      ['LN-TC-016','Máy Tính Lenovo ThinkCentre','Máy Tính / Laptop','ThinkCentre M70q','2023-08-15',18000000,20,'BM Dược lý','Hoạt động','2027-08-15',''],
      ['SS-AC-017','Điều Hòa Samsung 2HP','Điều Hòa','Samsung AR18TYHYE','2021-12-01',13000000,10,'Phòng Thực Hành TH01','Hoạt động','2026-12-01',''],
      ['HP-CL-018','Máy In Màu HP CLJ M454dn','Máy In','HP CLJ M454dn','2022-04-20',12000000,15,'BM Hóa sinh - Độc chất','Hoạt động','2026-10-20',''],
      ['LED-PN-019','Đèn LED Panel 600x600','Thiết Bị Phòng Học','LED Panel','2021-03-01',5500000,12,'Giảng Đường A103','Nghỉ hưu','','Hết tuổi thọ'],
      ['DL-LT-020','Laptop Dell Latitude 5430','Máy Tính / Laptop','Dell Latitude 5430','2023-06-10',28000000,20,'BM Bào chế - Công nghệ dược','Hoạt động','2027-06-10','']
    ].map(function(r) {
      var o = {}; EQ_H.slice(0, 11).forEach(function(h, i) { o[h] = r[i]; });
      return rowFrom(enrichEq(o), EQ_H);
    });
    writeRows(esh, EQ_H, eqs);

    writeRows(msh, MT_H, [
      ['BT001','LG-VN-001','Điều Hòa LG 2HP Inverter','Bảo dưỡng định kỳ','2026-05-10','Trần Thị Kỹ Thuật',450000,'Tốt','Hoàn thành','2026-11-10','Vệ sinh phin lọc, kiểm tra gas','Gas đủ'],
      ['BT002','EP-X51-002','Máy Chiếu Epson EB-X51','Bảo dưỡng định kỳ','2026-04-15','Trần Thị Kỹ Thuật',300000,'Tốt','Hoàn thành','2026-10-15','Vệ sinh quang học, kiểm tra đèn',''],
      ['BT003','PA-VW-004','Máy Chiếu Panasonic PT-VW360','Sửa chữa','2026-09-20','Trần Thị Kỹ Thuật',2800000,'Đang xử lý','Đang xử lý','2026-10-01','Thay bóng đèn chiếu','Đã đặt hàng'],
      ['BT004','CN-LBP-005','Máy In Canon LBP6030','Thay thế linh kiện','2026-05-01','Trần Thị Kỹ Thuật',1100000,'Tốt','Hoàn thành','2026-11-01','Thay drum unit, hộp mực',''],
      ['BT005','APC-15-010','UPS APC 1500VA','Sửa chữa','2026-08-15','Trần Thị Kỹ Thuật',3500000,'Không khắc phục được','Hoàn thành','','Thay ắc quy 12V 9Ah x4','Đề nghị mua mới'],
      ['BT006','DK-FC-011','Điều Hòa Daikin 1.5HP','Bảo dưỡng định kỳ','2026-06-01','Trần Thị Kỹ Thuật',400000,'Tốt','Hoàn thành','2026-12-01','Vệ sinh tổng thể, kiểm tra gas',''],
      ['BT007','CN-MF-006','Máy In Canon MF3010','Kiểm tra định kỳ','2026-07-10','Trần Thị Kỹ Thuật',150000,'Cần theo dõi','Hoàn thành','2027-01-10','Vệ sinh con lăn giấy','Con lăn có dấu hiệu mòn']
    ]);

    writeRows(nsh, LOG_H, [[Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
      me ? me.hoTen : 'Hệ thống', 'Khởi tạo hệ thống', 'Init v4.1 – 20 thiết bị, 39 địa điểm, 7 bảo trì, 3 tài khoản']]);

    return { ok:true, msg:'Khởi tạo thành công! 20 thiết bị, 39 địa điểm, 7 bảo trì, 3 tài khoản.' };
  });
}
