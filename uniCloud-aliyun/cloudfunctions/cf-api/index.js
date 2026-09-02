'use strict';
/**
 * 富记线上饭堂 - 统一 API 云函数（cf-menu / cf-order / cf-admin / cf-user 四合一）
 *
 * 【为什么要合并】阿里云 FC 2026-03 新规：每个云函数在每个"有调用的小时"里
 * 有最低消耗 90 GBs（不足 0.01 元按 0.01 元计）。三个函数并存时，每天活跃的
 * 小时里保底烧 3×90 GBs；合并成一个后降为 1×90，月套餐用量直接省 2/3。
 *
 * 本文件只是入口：HTTP 入参解析、按 mod 路由、响应包装；
 * 业务实现按模块拆在 lib/ 下（config / util / menu / order / admin / user）。
 *
 * 路由约定（前端 http.uts 按 path 前缀 /cf-menu /cf-order /cf-admin /cf-user
 * 推断出 mod 统一放进 body，云函数只认 body.mod，旧路径因此保持兼容）：
 *   mod = 'menu'  → lib/menu.js  （action: getToday）
 *   mod = 'order' → lib/order.js （action: create——仅下单；订单查询/改状态在 admin）
 *   mod = 'admin' → lib/admin.js （口令校验后：summary / updateStatus / getMenu / saveMenu / genDishImage）
 *   mod = 'user'  → lib/user.js  （微信登录：login / getProfile / saveProfile / myOrders）
 *
 * 响应格式（前端按此解析）：
 *   成功：{"ok":true,"data":{...}}
 *   失败：{"ok":false,"err":"中文错误信息"}
 *
 * 时区约定：云函数默认 UTC，北京时间 = UTC+8。
 *   统一用"平移后的日期对象"读北京时间墙上钟（工具在 lib/util.js）：
 *     const bj = new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000)
 *   然后一律用 bj.getUTCFullYear()/getUTCMonth()/getUTCDate()/getUTCHours()/getUTCDay()。
 *   截单时刻 = 当天北京 11:00。
 *
 * 集合：dishes（is_template=true 为模板）、orders、counters、users
 */

const { fail } = require('./lib/util.js');
const { menuGetToday } = require('./lib/menu.js');
const { orderHandle } = require('./lib/order.js');
const { adminHandle } = require('./lib/admin.js');
const { userHandle } = require('./lib/user.js');

// ---------- HTTP URL 化支持 ----------

// CORS 说明：uniCloud 阿里云网关会自动回显 Access-Control-Allow-Origin，
// 函数里再手动加会与网关重复，触发 Chrome 的 MultipleAllowOriginValues 拦截，
// 所以这里只保留 Content-Type，跨域全部交给网关处理。
const CORS_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8'
};

function http(payload, statusCode) {
	return {
		mpserverlessComposedResponse: true,
		statusCode: statusCode || 200,
		headers: CORS_HEADERS,
		body: JSON.stringify(payload)
	};
}

// 入参解析（兼容 query / JSON 字符串 / base64 / 对象），body 键优先于 query
function parseParams(event) {
	const params = {};

	const q = event.queryStringParameters || {};
	Object.keys(q).forEach(function (k) { params[k] = q[k]; });

	let body = event.body;
	if (body !== undefined && body !== null && body !== '') {
		if (event.isBase64Encoded && typeof body === 'string') {
			body = Buffer.from(body, 'base64').toString('utf8');
		}
		if (typeof body === 'string') {
			try {
				body = JSON.parse(body);
			} catch (e) {
				return { err: '请求体不是合法 JSON' };
			}
		}
		if (typeof body === 'object') {
			Object.keys(body).forEach(function (k) { params[k] = body[k]; });
		}
	}
	return { params: params };
}

// 阿里云 URL 化的 event 带 path / httpMethod 字段，callFunction 的 event 没有
function isHttpEvent(e) {
	return e.path !== undefined || e.httpMethod !== undefined;
}

// ============================================================
// 入口：按 mod 路由
// ============================================================

exports.main = async function (event, context) {
	const e = event || {};
	const httpMode = isHttpEvent(e);
	// 客户端 IP（用于后台口令限流）：URL 化 event 与 callFunction context 二者取其一
	const clientIP = (context && context.CLIENTIP) || e.clientIP || '';
	try {
		// 浏览器跨域预检直接放行
		if (httpMode && String(e.httpMethod || 'POST').toUpperCase() === 'OPTIONS') {
			return {
				mpserverlessComposedResponse: true,
				statusCode: 204,
				headers: CORS_HEADERS,
				body: ''
			};
		}

		const parsed = parseParams(e);
		if (parsed.err !== undefined) {
			const bad = fail(parsed.err);
			return httpMode ? http(bad, 400) : bad;
		}

		const p = parsed.params || {};
		const mod = typeof p.mod === 'string' ? p.mod : '';
		let payload;
		if (mod === 'menu') {
			payload = await menuGetToday();
		} else if (mod === 'order') {
			payload = await orderHandle(p);
		} else if (mod === 'admin') {
			payload = await adminHandle(p, clientIP); // 口令错误也返回 200，错误信息放在 payload.err
		} else if (mod === 'user') {
			payload = await userHandle(p);
		} else {
			payload = fail('缺少 mod 参数（menu / order / admin）');
		}
		return httpMode ? http(payload, 200) : payload;
	} catch (err) {
		console.error('cf-api error:', err);
		const payload = fail('服务器开小差了，请稍后再试');
		return httpMode ? http(payload, 500) : payload;
	}
};
