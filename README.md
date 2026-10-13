# 計劃通 PlanPro

可以在電腦和手機使用的計劃管理網頁 App，部署在 Cloudflare 的免費方案（Pages + Pages Functions + D1 資料庫）。手機可以「加到主畫面」當成 App 使用（PWA）。

## 功能（第一版）

- 帳號密碼登入；第一次登入或密碼被重設後，必須先改密碼才能使用
- 計劃：新增、編輯、封存、刪除，顯示完成進度
- 任務：狀態（待辦／進行中／完成）、優先度、截止日、負責人
- 看板檢視（電腦可拖拉，手機用 ← → 移動）與清單檢視（勾選完成）
- 管理員：新增使用者（可自訂初始密碼，留白為 `123456`，第一次登入需改密碼）、重設密碼、停用、調整角色

## 功能（第二版）

- 總覽儀表板：所有進行中計劃的進度、時程狀態、預算使用，以及逾期／7 天內到期的任務與近期里程碑
- 進度：任務可設定進度 %（0–100）與權重，計劃進度＝加權平均；依開始日～結束日算出「今天應達幾 %」，顯示超前或落後
- 預算：總預算、預算科目（預計金額）、支出紀錄（可關聯任務），使用率超過 80% 黃色、超支紅色
  - 所有人都能看預算，只有管理員或計劃建立者可以修改
- 里程碑：重要日期節點，逾期未完成會標紅

## 初始管理員

| 帳號 | 初始密碼 |
| --- | --- |
| `toshimi8039` | `123456` |

資料庫沒有任何使用者時，第一次登入會自動建立這個管理員。登入後會被要求改密碼，改完之後 `123456` 就失效了。

## 安全設計

- 密碼用 PBKDF2-SHA256（100,000 次、每人不同的鹽）雜湊後才存，資料庫與程式碼都沒有明碼
- 登入狀態用 HttpOnly、Secure、SameSite=Lax 的 cookie，資料庫只存 token 的雜湊，7 天後過期
- 同一帳號連續輸錯 5 次會鎖定 15 分鐘
- 新密碼至少 8 碼、要有英文和數字、不能是 `123456` 或和帳號相同
- 改密碼後其他裝置的登入狀態會被登出
- 寫入 API 只接受同源的 JSON 請求（防 CSRF），並加上 CSP 等安全標頭

## 部署到 Cloudflare（免費）

1. 註冊／登入 [Cloudflare](https://dash.cloudflare.com/)。
2. 左側選 **Storage & Databases → D1**，建立資料庫，名稱填 `plan-manager-db`。
3. 複製資料庫的 **Database ID**，貼到 [`wrangler.toml`](wrangler.toml) 的 `database_id`，commit 到 GitHub。
4. 左側選 **Workers & Pages → Create application → Continue to Pages → Connect GitHub**，選這個 repo：
   - Framework preset：`None`
   - Build command：留空
   - Build output directory：`public`
5. 部署完成會得到 `https://plan-manager-xxx.pages.dev` 的網址，用初始帳號登入並改密碼。

之後每次 push 到 `main`，Cloudflare 會自動重新部署。

資料表不需要手動建立：程式第一次收到請求時會自動建立或升級（見 [`lib/schema.js`](lib/schema.js)）。

## 本機開發

```bash
npm install
npm run dev    # http://localhost:8788（本機資料庫會自動建立）
npm test       # API 測試
```

## 專案結構

```
public/            前端（HTML / CSS / JS、PWA 設定、圖示）
functions/api/     Cloudflare Pages Functions 入口
lib/               API、密碼雜湊、資料庫結構與自動升級
tests/             API 測試（用 node:sqlite 模擬 D1）
```
