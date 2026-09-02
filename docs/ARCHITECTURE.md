# 富记线上饭堂 · 架构文档（架构即现实）

> 本文档描述系统**当前真实形态**（2026-09-02，UI 4.0 绿色系 + 一天两餐 + 自由定价落地的样子），
> 而非最初设想。先撸码后补图的部分都在这里转正了。

## 1. 系统总览

```
┌─────────────┐        ┌─────────────┐
│  用户小程序   │        │  厨房端页面   │
│ (4 Tab .uvue)│        │ (admin.uvue) │
└──────┬──────┘        └──────┬──────┘
       │  http.uts（token 注入）│  口令 + token
       ▼                      ▼
┌─────────────────────────────────────┐
│  cf-api（uniCloud 阿里云，URL 化）    │
│  mod 路由：menu / order / admin / user│
│  lib/: config secrets util menu      │
│        order admin user              │
└──────┬──────────────┬───────────────┘
       ▼              ▼
┌────────────┐  ┌──────────────────┐
│ 云数据库     │  │ 外部服务           │
│ dishes      │  │ 微信 jscode2session│
│ orders      │  │ 生图 gpt-image-2   │
│ users       │  │ （SSRF 防护内）     │
│ counters    │  └──────────────────┘
└────────────┘
厨房现场：蓝牙 thermal 打印机（admin 直连，ESC/POS + GBK）
```

**为什么是单云函数**：阿里云 FC 每函数每小时有最低消耗，三个函数并存保底烧 3 份；
合并为一个 cf-api（mod 路由分发）后降为 1 份，月套餐用量省 2/3。

## 2. 业务模型

### 2.1 一天两餐（同一份日菜单）

| 餐次 | 备菜 | 截单(下单截止) | 出炉 | 收档 |
|------|------|------|------|------|
| 午餐 L | 10:00 | 11:00 | 11:30 | 13:00 |
| 晚餐 D | 15:00 | 16:00 | 17:30 | 19:30 |

- 时刻表唯一来源：`cf-api/lib/config.js` 的 `MEALS`；前端镜像在 `common/meals.uts`（改两处要同步）
- 一单一餐：订单带 `meal` 字段，按各自截单时刻服务端校验
- 订单号：`FJ-MMDD-L001` / `FJ-MMDD-D001`（counters 按 餐次+日 分开计数）；取餐码 = 尾 4 位 `#L001`

### 2.2 自由定价

- 每道菜有 `base_price`（最低售价）且默认 `can_custom_price: true`
- 用户端：详情页三档份量（基础 / ×1.34 加量 / ×1.67 更足）+ 滑杆（min=起价，max=×2.5）
- 服务端只校验 `pay ≥ base_price`（上限待加，见 ARCHITECTURE 已知弱点）
- 饭盒行内 `spec` 标签（标准/加量/更足）由所选价格区间推导

### 2.3 履约与状态机

```
pending(已下单) → cooking(备餐中) → ready(待配送) → delivering(配送中) → delivered(已送达)
      │               │               │                │
      └───────────────┴───────────────┴────────────────┴──▶ canceled(已取消)
```

- 厨房端驱动：开始备餐 / 出餐完成 / 开始配送（按地点批量）/ 完成配送（按地点批量）
- 每次流转写 `status_log[status] = Date.now()`，用户端时间线按它展示真实时间
- 状态唯一事实源在云端订单文档；管理端配送分组徽章从订单真实状态推导（无本地私有状态）

### 2.4 配送模式

配送到「公司前台」地点（订单 `customer.location`），时间窗 = 各餐 ready→close。
厨房端按地点聚合：待配送（全 ready）→ 开始配送 → 配送中（有 delivering）→ 完成配送 → 已完成（全 delivered）。

## 3. 数据集合

| 集合 | 关键字段 | 说明 |
|------|----------|------|
| dishes | id, category, name, desc, base_price, can_custom_price, image, sold_out, sort, is_template, menu_date, batch | 日菜单 + 模板；**两阶段发布**（batch 时间戳，读取端只认最大 batch，发布中途不出现空菜单） |
| orders | order_no, menu_date, meal, status, status_log, items[], total, custom_extra, customer{name,location,phone}, uid, request_id, test_order, created_at | customer 为下单时快照；request_id 为幂等键 |
| users | openid, token, token_expires_at, profile{name,phone,location}, created_at, last_login_at | 静默登录建档；token 30 天过期；schema 权限全 false，只能走云函数 |
| counters | key, count | 序号：`order_L/D_YYYYMMDD` |

## 4. API 契约（cf-api，URL 化）

统一响应：`{"ok":true,"data":{...}}` / `{"ok":false,"err":"中文提示"}`。
前端 `common/http.uts` 按 path 前缀推断 mod 并自动注入 `token`。

| mod | action | 鉴权 | 说明 |
|-----|--------|------|------|
| menu | getToday | 无 | 今日菜单（空则从模板播种；只认最大 batch） |
| order | create | 无（游客可下单；token 存在则挂 uid） | 入参 meal/items/customer/request_id；request_id 幂等去重 |
| admin | summary / updateStatus / getMenu / saveMenu / genDishImage | 口令 + IP 限流（5 次锁 10 分钟） | summary 输出按餐次聚合 + orders（含 status_log）；updateStatus 走状态机校验 |
| user | login / getProfile / saveProfile / myOrders | token（30 天过期） | login 换 openid 建档发 token |

安全机制：机密全在 `lib/secrets.js`（不入库）；生图下载走 SSRF 防护（https + 内网段/裸 IP 拦截 + 20MB 上限）；管理端批量操作有防重入锁。

## 5. 前端架构

- **4 Tab**：index（今日菜单，内含 home/menu/dish 三屏态）· box（我的饭盒，list/confirm/pay/success 四屏态）· orders（列表/status 时间线两屏态）· profile
- **跨 Tab 共享**：`common/cart.uts`（饭盒单例：条目/餐次/角标；切餐次在饭盒非空时被拒）、`common/session.uts`（静默登录 + 顾客信息单例）、`common/meals.uts`（餐次配置镜像）
- **设计系统**：`App.uvue` 全局 g-* 类（森林绿 #2F6B3F 系 + 米白底 + 金棕点缀），页面只写布局；色板与组件规范见 App.uvue 头注释
- **状态文案**：用户侧统一 `common/status.uts`；厨房端词汇独立（制作中/待配送——给老板看的说法）
- **蓝牙打印**：`admin/bt-printer.uts`（BLE 扫描/连接 + ESC/POS + GBK 编码表 `gbk-table.uts`），58mm 热敏，逐单小票

## 6. 安全模型与已知弱点

已落地：接口鉴权收敛（订单查询/改状态仅口令通道）、口令限流、下单幂等键、token 过期、SSRF 防护、机密出库、状态机服务端校验、菜单两阶段发布。

已知弱点（按上线优先级）：
1. HTTP 明文 + urlCheck 关闭（等 HTTPS 证书，见上线清单）
2. git 历史含旧版明文密钥（上线前统一轮换三件：AppSecret / IMG key / 口令）
3. 幂等为「先查后写」，极端并发有重复窗口；request_id 未绑 uid
4. 自由定价无服务端上限；文本字段无长度截断
5. order/create 匿名可调（设计如此：游客可下单），无限流

## 7. 演进路线

1. **微信支付**（商户号已批）：cf-api 增统一下单 + 回调模块；订单加已支付态
2. **净菜预订配送**：同一套「限时下单 + 定时履约」引擎，商品 SKU 化 + 配送地址/时间窗
3. **市场平台化**（整栋楼摊位上线）：摊主维度、角色权限、分账——建议先自营统收，规避平台资质
