# EMS · Hệ Thống Quản Lý Bảo Trì Thiết Bị – Trường Dược

Ứng dụng web quản lý thiết bị, lịch sử bảo trì, lịch bảo trì định kỳ, địa điểm và nhân viên.

```
Trình duyệt ──► Cloudflare Pages (public/index.html)
                    │  POST /api   (functions/api.js — giữ API key bí mật)
                    ▼
             Google Apps Script (apps-script/Code.gs)
                    ▼
             Google Sheets (5 sheet: NguoiDung, ThietBi, BaoTri, DiaDiem, NhatKy)
```

## Cấu trúc thư mục

| Đường dẫn | Mô tả |
|---|---|
| `public/index.html` | Giao diện (HTML/CSS/JS một file) |
| `public/_headers` | Header bảo mật cho Cloudflare Pages |
| `functions/api.js` | Cloudflare Pages Function: proxy `/api` → Apps Script |
| `apps-script/Code.gs` | Backend Google Apps Script |
| `apps-script/appsscript.json` | Manifest Apps Script (múi giờ, quyền Web App) |
| `wrangler.toml` | Cấu hình Cloudflare Pages |

---

## Bước 1 — Thiết lập Google Sheets + Apps Script

1. Tạo một **Google Spreadsheet** mới.
2. Mở **Tiện ích mở rộng → Apps Script**.
3. Xóa nội dung mặc định, dán toàn bộ `apps-script/Code.gs`, bấm **Lưu**.
4. (Tùy chọn) **Cài đặt dự án** → bật *Hiển thị tệp kê khai "appsscript.json"* → dán nội dung `apps-script/appsscript.json`.
5. Chọn hàm **`taoApiKey`** trên thanh công cụ → **Chạy** → cấp quyền khi được hỏi.
   Mở **Nhật ký thực thi**, copy giá trị sau `API_KEY = ` (cần ở Bước 3).
6. Chọn hàm **`guiThuEmail`** → **Chạy** → cấp quyền **gửi email** (bắt buộc cho OTP). Kiểm tra hộp thư có email thử.
7. Chọn hàm **`khoiTaoDuLieu`** → **Chạy** → tạo 5 sheet và dữ liệu mẫu. 3 tài khoản mẫu nhận OTP qua **email Google của bạn** (chủ Apps Script).
8. (Tùy chọn) Chọn hàm **`setupTrigger`** → **Chạy** để bật kiểm tra hằng ngày lúc 7h và gửi email cảnh báo cho Admin.
9. **Triển khai → Tùy chọn triển khai mới → Ứng dụng web**:
   - *Thực thi dưới dạng*: **Tôi**
   - *Người có quyền truy cập*: **Bất kỳ ai**
   - Bấm **Triển khai**, copy **URL ứng dụng web** (kết thúc bằng `/exec`).

> Nếu đang dùng dữ liệu của bản cũ (v3), chạy hàm **`suaDinhDangDuLieuCu`** một lần (bù số 0 bị mất ở CCCD/SĐT, thêm cột nhật ký),
> rồi **kiểm tra cột `email` của từng nhân viên là email thật** — không có email sẽ không đăng nhập được.

## Bước 2 — Đưa mã nguồn lên GitHub

Repo này đã có sẵn cấu trúc. Nếu tự tạo repo mới:

```bash
git init && git add . && git commit -m "EMS v4.1"
git remote add origin https://github.com/<tai-khoan>/ems-truong-duoc.git
git push -u origin main
```

## Bước 3 — Deploy lên Cloudflare Pages

1. Đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git**.
2. Chọn repo `ems-truong-duoc`, nhánh `main`.
3. Cấu hình build:
   - *Framework preset*: **None**
   - *Build command*: *(để trống)*
   - *Build output directory*: **`public`**
4. **Environment variables** (thêm cho cả *Production* và *Preview*):
   | Tên | Giá trị | Loại |
   |---|---|---|
   | `GAS_URL` | URL Web App ở Bước 1.9 | Text |
   | `GAS_KEY` | API key ở Bước 1.5 | **Secret** (Encrypt) |
5. Bấm **Save and Deploy**. Sau khoảng 1 phút bạn có địa chỉ `https://ems-truong-duoc.pages.dev`.
6. Mỗi lần `git push` lên `main`, Cloudflare tự deploy lại.

> Nếu thêm/sửa biến môi trường sau khi đã deploy, vào **Deployments → Retry deployment** để áp dụng.

### Đăng nhập

1. Nhập số CCCD → hệ thống gửi **mã OTP 6 số** tới email của tài khoản (email hiển thị dạng che, vd `ng•••n@gmail.com`).
2. Nhập mã trong vòng **5 phút** → vào hệ thống. Phiên kéo dài 6 giờ (tự gia hạn khi dùng).

### Đăng nhập thử (dữ liệu mẫu — OTP gửi về email chủ Apps Script)

| Vai trò | CCCD |
|---|---|
| Admin | `079301001234` |
| Kỹ thuật viên | `079201005678` |
| Viewer | `079101009999` |

**Hãy đổi/xóa các tài khoản mẫu này ngay sau khi tạo tài khoản thật.** Mỗi nhân viên bắt buộc có email hợp lệ để nhận OTP.

### Hạn mức gửi email

OTP gửi bằng `MailApp` của Google, có giới hạn số người nhận mỗi ngày theo loại tài khoản sở hữu script
(tài khoản Gmail cá nhân thấp hơn nhiều so với Google Workspace của trường). Chạy `guiThuEmail` để xem hạn mức còn lại.
Nên deploy Apps Script bằng **tài khoản Google Workspace của trường** nếu nhiều người đăng nhập mỗi ngày.

---

## Cập nhật backend

Sửa `apps-script/Code.gs` → dán lại vào Apps Script → **Triển khai → Quản lý triển khai → ✏️ → Phiên bản: Phiên bản mới → Triển khai**.
URL `/exec` giữ nguyên nên không cần đổi trên Cloudflare.

## Chạy thử trên máy

```bash
cp .dev.vars.example .dev.vars   # điền GAS_URL, GAS_KEY
npx wrangler pages dev
```

## Phân quyền

| Chức năng | Viewer | Kỹ thuật | Admin |
|---|:-:|:-:|:-:|
| Xem dashboard, thiết bị, bảo trì, lịch, địa điểm | ✅ | ✅ | ✅ |
| Thêm/sửa thiết bị, ghi nhận/sửa bảo trì | | ✅ | ✅ |
| Xóa thiết bị, quản lý địa điểm, nhân viên | | | ✅ |
| Báo cáo, nhật ký, khởi tạo dữ liệu | | | ✅ |

Quyền được kiểm tra **ở server** (Apps Script), không chỉ ẩn nút trên giao diện.

## Bảo mật

- Apps Script chỉ chấp nhận request có `GAS_KEY` (chỉ Cloudflare biết) → không gọi trực tiếp được dù lộ URL `/exec`.
- **Đăng nhập 2 bước:** CCCD + mã OTP 6 số gửi về email. Biết CCCD của người khác không đủ để đăng nhập.
- OTP: hết hạn sau 5 phút, dùng một lần, sai 5 lần là hủy mã, gửi mã mới làm mã cũ mất hiệu lực, chờ 60 giây giữa hai lần gửi, tối đa 5 mã/tài khoản/giờ.
- Đăng nhập thành công trả token phiên (6 giờ, tự gia hạn khi dùng); tài khoản bị khóa/xóa sẽ mất phiên ngay.
- Khóa tạm IP 15 phút sau 10 lần nhập sai (CCCD hoặc OTP).
- Người không phải Admin không nhận được số CCCD của người khác.
- Toàn bộ dữ liệu hiển thị được thoát ký tự HTML (chống XSS).
- Email OTP có cảnh báo: nếu người dùng nhận mã mà không yêu cầu, có thể ai đó đang thử CCCD của họ. Mọi lần gửi mã đều ghi nhật ký.
- **Lưu ý:** bảo mật phụ thuộc hộp thư email của nhân viên — khuyến khích bật xác minh 2 bước cho email.

## Thay đổi v4.1

- Đăng nhập 2 bước bằng mã OTP gửi qua email.
- Email bắt buộc khi thêm/sửa nhân viên.
- Thêm hàm `guiThuEmail` (cấp quyền gửi mail, xem hạn mức); `suaDinhDangDuLieuCu` tự thêm cột `nguoiThucHien` cho sheet NhatKy bản cũ.

## Thay đổi v4.0 so với v3.0

- **Sửa lỗi mất số 0 đầu CCCD/SĐT** (Sheets tự đổi sang số) khiến không đăng nhập được.
- **Badge trạng thái** hiển thị đúng màu cho mọi trạng thái.
- **Kiểm tra quyền ở server** + API key + token phiên (trước đây ai có URL cũng xóa/khởi tạo được).
- Ngày hiển thị dạng `dd/MM/yyyy`, không còn chuỗi ISO lệch múi giờ.
- Topbar, nút đăng nhập, badge theo đúng theme sáng/tối.
- Trang Báo cáo hiển thị nhật ký (có tên người thực hiện).
- Bỏ các hàm khai báo trùng; bộ lọc địa điểm hoạt động đúng.
- Hao mòn/hiệu quả tính khi đọc, không ghi sheet từng ô mỗi request (nhanh hơn nhiều); trigger hằng ngày ghi một lần bằng `setValues`.
- Dashboard đọc sheet địa điểm một lần thay vì mỗi thiết bị một lần.
- Khóa ghi (LockService) tránh trùng dữ liệu khi nhiều người thao tác cùng lúc.
- Không cho tự xóa/hạ quyền chính mình hoặc mất Admin cuối cùng.
- Email cảnh báo gửi tới email các Admin trong sheet thay vì địa chỉ cố định.
