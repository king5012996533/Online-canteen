# 富记线上饭堂

写字楼现炒午餐/晚餐的微信小程序：用户按「最低售价 + 自由定价」点单，后厨现炒，午/晚两餐配送到公司前台。配套一个厨房端（老板后台）管理订单、菜单、配送与蓝牙小票打印。

> 仓库为私有，包含业务代码与部署配置，**不要转公开**。真实机密只在本地 `secrets.js`（不入库）。

## 功能一览

- **用户端（4 Tab）**：今日菜单（自由定价点单）→ 我的饭盒（购物车）→ 订单（状态时间线）→ 我的（常用信息）
- **老板端**：管理首页（今日统计/发布菜单）、订单管理（按地点分组、逐单蓝牙打印）、菜单管理（编辑/AI 配图/发布）、配送管理（按地点两段式配送）、数据统计、设置
- **一天两餐**：午餐（11:00 截单 / 11:30 出炉 / 13:00 收档）、晚餐（16:00 截单 / 17:30 出炉 / 19:30 收档）
- **自由定价**：每道菜有最低售价，用户按档位或滑杆决定支付金额，按价格给份量
- **配送闭环**：已下单 → 备餐中 → 待配送 → 配送中 → 已送达（全状态云端持久化，用户端时间线可见）

## 技术栈

- 小程序：uni-app x（.uvue / UTS），目标平台 mp-weixin
- 后端：uniCloud 阿里云，单云函数 `cf-api`（URL 化），Node.js CommonJS
- 数据库：uniCloud 云数据库（dishes / orders / users / counters）
- 登录：微信静默登录（uni.login → jscode2session → 自发 token）
- 支付：微信支付（商户号已批，对接待做）

## 仓库结构

```
├─ App.uvue                    # 全局设计系统（绿色系 g-* 类，单一来源）
├─ pages.json                  # 页面注册 + 4 Tab 配置
├─ manifest.json               # 应用配置（AppID：wx741ea5af08011b17）
├─ common/
│  ├─ config.uts               # API_BASE（上线改 https 就这一处）
│  ├─ http.uts                 # 统一请求 + token 自动注入
│  ├─ cart.uts                 # 饭盒购物车（跨 Tab 单例）
│  ├─ session.uts              # 静默登录 + 顾客信息（跨 Tab 单例）
│  ├─ meals.uts                # 餐次配置（前端镜像 cf-api MEALS）
│  └─ status.uts               # 订单状态文案/徽章（用户侧统一）
├─ pages/
│  ├─ index/  box/  orders/  profile/   # 用户端 4 Tab
│  └─ admin/                   # 厨房端（老板后台）+ 蓝牙打印 + GBK 编码表
├─ static/                     # 菜品图 / TabBar 图标 / 行内图标
└─ uniCloud-aliyun/
   ├─ cloudfunctions/cf-api/   # 唯一云函数（mod 路由 → lib/ 模块）
   │  └─ lib/secrets.js        # 机密配置（不入库！模板见 secrets.example.js）
   └─ database/                # 各集合 Schema
```

## 快速开始

1. HBuilderX 导入本项目（File → Import → 本地目录）
2. **补机密**：复制 `uniCloud-aliyun/cloudfunctions/cf-api/lib/secrets.example.js` 为同目录 `secrets.js`，填入后台口令、生图 API Key、微信 AppSecret（此文件不入 Git，换机器必须重补）
3. uniCloud 控制台关联云空间，右键 `cf-api` 上传部署，右键 `database/*.schema.json` 上传
4. 运行 → 运行到小程序模拟器 → 微信开发者工具（调试期勾选「不校验合法域名」）

## 部署与上线

- 日常改动只需重新部署 cf-api + 重新编译小程序
- 上线前的完整清单（HTTPS、密钥轮换、关测试开关、类目/备案）见 [`docs/launch-checklist.md`](docs/launch-checklist.md)
- 架构、数据契约、状态机与设计取舍见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## 安全须知

- `secrets.js` 含后台口令与密钥，**永不入库**；泄露嫌疑时在对应平台轮换后更新此文件并重新部署
- `BYPASS_CUTOFF`（cf-api/lib/config.js）与 `testBypass`（pages/index/index.uvue）是测试期开关，**正式上线前必须改回 false**
- 历史提交中存在旧版明文密钥（已废弃），上线前统一轮换一次
