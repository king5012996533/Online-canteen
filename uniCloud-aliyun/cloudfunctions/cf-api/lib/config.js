'use strict';
/**
 * 全局配置：业务常量、后台口令、外部服务密钥，全部集中在这一个文件。
 * 改完记得在 HBuilderX 重新上传部署 cf-api 才生效。
 */

// ---------- 业务常量 ----------
const ADMIN_PASSWORD = 'xk2026'; // 上线前务必修改！
const MIN_ORDER_TOTAL = 16;  // 起送金额（元）
const MAX_QTY_PER_ITEM = 20; // 单个菜品最大数量
// 一天两餐（同一份日菜单）：各餐次备菜 / 截单 / 出炉 / 收档时刻；seq 为订单号里的餐次字母
const MEALS = {
	lunch: { key: 'lunch', label: '午餐', seq: 'L', prep: '10:00', orderClose: '11:00', ready: '11:30', close: '13:00' },
	dinner: { key: 'dinner', label: '晚餐', seq: 'D', prep: '15:00', orderClose: '16:00', ready: '17:30', close: '19:30' }
};
const CUTOFF_HOUR = 11;      // 【已由 MEALS.lunch.orderClose 取代】仅保留导出兼容旧引用，新代码勿用
// 【测试开关】true = 暂时解除截单限制，随时可下测试单（订单会带 test_order:true 标记）。
// 正式上线前必须改回 false 并重新上传部署！
const BYPASS_CUTOFF = true;

// ---------- AI 菜品配图 ----------
// 复用本机电商生图技能同款 OpenAI 兼容接口（gpt-image-2）；
// key 是用户自己的，跑在用户自己的云函数里。
const IMG_API_BASE = 'https://www.ggwk1.online/v1';
const IMG_API_KEY = 'sk-RhCNZ9afpFdNlqZyth53Cq37MrFmNAWP7wawmr5Pk1GSLvqs';
const IMG_MODEL = 'gpt-image-2';

// ---------- 微信小程序登录 ----------
const WX_APPID = 'wxa9fac6425421ee50';
// AppSecret 占位符：到微信公众平台「开发管理 → 开发设置」复制 AppSecret 替换，
// 不替换的话 login 会统一按"微信登录失败，请稍后重试"处理。
const WX_APP_SECRET = 'fb97a88b4ab11deb0c22f45ab88cf8db';

module.exports = {
	ADMIN_PASSWORD: ADMIN_PASSWORD,
	MIN_ORDER_TOTAL: MIN_ORDER_TOTAL,
	MAX_QTY_PER_ITEM: MAX_QTY_PER_ITEM,
	MEALS: MEALS,
	CUTOFF_HOUR: CUTOFF_HOUR,
	BYPASS_CUTOFF: BYPASS_CUTOFF,
	IMG_API_BASE: IMG_API_BASE,
	IMG_API_KEY: IMG_API_KEY,
	IMG_MODEL: IMG_MODEL,
	WX_APPID: WX_APPID,
	WX_APP_SECRET: WX_APP_SECRET
};
