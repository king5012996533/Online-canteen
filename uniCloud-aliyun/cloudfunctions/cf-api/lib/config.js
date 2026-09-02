'use strict';
/**
 * 全局配置：业务常量集中在这一文件；机密（口令/密钥）在 secrets.js（不入 Git）。
 * 改完记得在 HBuilderX 重新上传部署 cf-api 才生效。
 */

// ---------- 机密（secrets.js 被 .gitignore 忽略，模板见 secrets.example.js） ----------
const SECRETS = require('./secrets.js');

// ---------- 业务常量 ----------
const ADMIN_PASSWORD = SECRETS.ADMIN_PASSWORD; // 厨房端口令（改口令改 secrets.js）
const MIN_ORDER_TOTAL = 16;  // 起送金额（元）
const MAX_QTY_PER_ITEM = 20; // 单个菜品最大数量
// 一天两餐（同一份日菜单）：各餐次备菜 / 截单 / 出炉 / 收档时刻；seq 为订单号里的餐次字母
const MEALS = {
	lunch: { key: 'lunch', label: '午餐', seq: 'L', prep: '10:00', orderClose: '11:00', ready: '11:30', close: '13:00' },
	dinner: { key: 'dinner', label: '晚餐', seq: 'D', prep: '15:00', orderClose: '16:00', ready: '17:30', close: '19:30' }
};
// 【测试开关】true = 暂时解除截单限制，随时可下测试单（订单会带 test_order:true 标记）。
// 正式上线前必须改回 false 并重新上传部署！
const BYPASS_CUTOFF = true;

// ---------- AI 菜品配图 ----------
// 复用本机电商生图技能同款 OpenAI 兼容接口（gpt-image-2）；
// key 在 secrets.js，跑在用户自己的云函数里。
const IMG_API_BASE = 'https://www.ggwk1.online/v1';
const IMG_API_KEY = SECRETS.IMG_API_KEY;
const IMG_MODEL = SECRETS.IMG_MODEL;

// ---------- 微信小程序登录 ----------
const WX_APPID = 'wx741ea5af08011b17';
// AppSecret 在 secrets.js。换密钥后旧的 users 记录（openid 属于旧 AppID）不再匹配新登录，
// 正式上线前建议清掉测试数据。
const WX_APP_SECRET = SECRETS.WX_APP_SECRET;

// ---------- 微信支付 V3（商户号关联新 AppID 后启用） ----------
// 回调地址必须 https；微信服务器 POST 到这里（query 带 mod=pay 进路由）。
// 证书未配好时回调不可达不影响支付——前端支付后走 paySync 主动查询兜底。
const PAY_NOTIFY_URL = 'https://xk-api.xingtudesign.com/cf-api?mod=pay';

module.exports = {
	ADMIN_PASSWORD: ADMIN_PASSWORD,
	MIN_ORDER_TOTAL: MIN_ORDER_TOTAL,
	MAX_QTY_PER_ITEM: MAX_QTY_PER_ITEM,
	MEALS: MEALS,
	BYPASS_CUTOFF: BYPASS_CUTOFF,
	IMG_API_BASE: IMG_API_BASE,
	IMG_API_KEY: IMG_API_KEY,
	IMG_MODEL: IMG_MODEL,
	WX_APPID: WX_APPID,
	WX_APP_SECRET: WX_APP_SECRET,
	PAY_NOTIFY_URL: PAY_NOTIFY_URL
};
