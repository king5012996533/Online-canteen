'use strict';
/**
 * mod = 'pay'：微信支付 V3（JSAPI 小程序支付）
 *
 * action:
 *   - create：用户端统一下单（入参 orderNo），返回 uni.requestPayment 所需参数
 *   - sync  ：用户端支付后主动查询微信订单并落库（回调不可达时的兜底确认）
 *   - notify：微信服务器回调（notify_url 带 ?mod=pay 进入；p.resource 存在即走此分支）
 *
 * 签名：WECHATPAY2-SHA256-RSA2048，商户私钥 apiclient_key.pem（不入 Git，与 secrets.js 同目录）。
 * 安全：payCreate/paySync 均按 token 反查 uid 并校验订单归属；notify 依赖 APIv3 密钥的
 *       AES-256-GCM 解密成功作为真实性校验（解密密钥仅商户与微信持有），并核对回调整单金额。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WX_APPID, MCH_ID, MCH_SERIAL_NO, APIV3_KEY, PAY_NOTIFY_URL } = require('./config.js');
const { ok, fail, round2 } = require('./util.js');

function payConfigured() {
	return MCH_ID !== '' && MCH_ID.indexOf('__') < 0 && MCH_SERIAL_NO !== '' && MCH_SERIAL_NO.indexOf('__') < 0 && APIV3_KEY !== '' && APIV3_KEY.indexOf('__') < 0;
}

function privateKeyPem() {
	try {
		const p = path.join(__dirname, 'apiclient_key.pem');
		if (!fs.existsSync(p)) { return ''; }
		const pem = fs.readFileSync(p, 'utf8');
		return pem.indexOf('PRIVATE KEY') >= 0 ? pem : '';
	} catch (e) { return ''; }
}

function nonceStr() { return crypto.randomBytes(16).toString('hex'); }

// v3 请求签名头：message = 方法\n路径\n时间戳\n随机串\n请求体\n
function authHeader(method, urlPath, bodyText, pem) {
	const ts = Math.floor(Date.now() / 1000).toString();
	const n = nonceStr();
	const message = method + '\n' + urlPath + '\n' + ts + '\n' + n + '\n' + (bodyText || '') + '\n';
	const signature = crypto.createSign('RSA-SHA256').update(message).sign(pem, 'base64');
	return 'WECHATPAY2-SHA256-RSA2048 mchid="' + MCH_ID + '",nonce_str="' + n + '",signature="' + signature + '",timestamp="' + ts + '",serial_no="' + MCH_SERIAL_NO + '"';
}

// 统一请求微信 v3 接口（bodyObj 为 null 时走 GET，urlPath 需自带 query 且参与签名）
async function wxV3(method, urlPath, bodyObj) {
	const pem = privateKeyPem();
	const bodyText = bodyObj ? JSON.stringify(bodyObj) : '';
	const res = await uniCloud.httpclient.request('https://api.mch.weixin.qq.com' + urlPath, {
		method: method,
		data: bodyObj || undefined,
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'Authorization': authHeader(method, urlPath, bodyText, pem),
			'User-Agent': 'fuji-canteen-cf-api'
		},
		contentType: 'json',
		dataType: 'json',
		timeout: 15000
	});
	return res;
}

// 按 token 反查 uid 并校验订单归属（防越权支付/查询他人订单）
async function ownOrder(db, orderNo, token) {
	if (typeof token !== 'string' || token === '') { return { err: '登录已失效' }; }
	const uRes = await db.collection('users').where({ token: token }).limit(1).get();
	if (!uRes.data || uRes.data.length === 0) { return { err: '登录已失效' }; }
	const uid = uRes.data[0]._id;
	const oRes = await db.collection('orders').where({ order_no: orderNo }).limit(1).get();
	if (!oRes.data || oRes.data.length === 0) { return { err: '订单不存在' }; }
	const order = oRes.data[0];
	if (order.uid && order.uid !== uid) { return { err: '订单不存在' }; }
	return { order: order, uid: uid };
}

// action=create：JSAPI 统一下单，返回 uni.requestPayment 参数
async function payCreate(p) {
	if (!payConfigured() || privateKeyPem() === '') { return fail('支付未配置'); }
	const orderNo = typeof p.orderNo === 'string' ? p.orderNo.trim() : '';
	if (orderNo === '') { return fail('缺少订单号'); }
	const db = uniCloud.database();
	const own = await ownOrder(db, orderNo, p.token);
	if (own.err) { return fail(own.err); }
	const order = own.order;
	if (order.pay_status === 'paid') { return ok({ paid: true }); }

	// JSAPI 支付必须知道付款人 openid：游客订单（uid 为空）无法在线支付
	let openid = '';
	if (own.uid) {
		const u = await db.collection('users').doc(own.uid).get();
		if (u.data && u.data.length > 0) { openid = u.data[0].openid || ''; }
	}
	if (openid === '') { return fail('未登录，无法在线支付'); }

	const totalFen = Math.round(order.total * 100);
	if (totalFen < 1) { return fail('订单金额异常'); }
	const bodyObj = {
		appid: WX_APPID,
		mchid: MCH_ID,
		description: '富记线上饭堂-' + (order.meal === 'dinner' ? '晚餐' : '午餐'),
		out_trade_no: orderNo,
		notify_url: PAY_NOTIFY_URL,
		amount: { total: totalFen, currency: 'CNY' },
		payer: { openid: openid }
	};
	const res = await wxV3('POST', '/v3/pay/transactions/jsapi', bodyObj);
	if (res.status !== 200 || !res.data || !res.data.prepay_id) {
		const msg = (res.data && res.data.message) ? res.data.message : ('HTTP ' + res.status);
		return fail('支付下单失败：' + msg);
	}
	const pkg = 'prepay_id=' + res.data.prepay_id;
	const ts = Math.floor(Date.now() / 1000).toString();
	const n = nonceStr();
	// 拉起支付签名串：appId\n时间戳\n随机串\npackage\n
	const paySign = crypto.createSign('RSA-SHA256')
		.update(WX_APPID + '\n' + ts + '\n' + n + '\n' + pkg + '\n')
		.sign(privateKeyPem(), 'base64');
	return ok({
		timeStamp: ts,
		nonceStr: n,
		package: pkg,
		signType: 'RSA',
		paySign: paySign
	});
}

// action=sync：主动查询微信侧支付结果并落库（前端拉起支付成功回调后调用）
async function paySync(p) {
	if (!payConfigured() || privateKeyPem() === '') { return fail('支付未配置'); }
	const orderNo = typeof p.orderNo === 'string' ? p.orderNo.trim() : '';
	if (orderNo === '') { return fail('缺少订单号'); }
	const db = uniCloud.database();
	const own = await ownOrder(db, orderNo, p.token);
	if (own.err) { return fail(own.err); }
	if (own.order.pay_status === 'paid') { return ok({ paid: true }); }
	const res = await wxV3('GET', '/v3/pay/transactions/out-trade-no/' + orderNo + '?mchid=' + MCH_ID, null);
	const state = (res.data && res.data.trade_state) || '';
	if (res.status !== 200 || state !== 'SUCCESS') {
		return ok({ paid: false, state: state || ('HTTP ' + res.status) });
	}
	await db.collection('orders').where({ order_no: orderNo }).update({
		pay_status: 'paid',
		transaction_id: (res.data.transaction_id || ''),
		pay_time: Date.now()
	});
	return ok({ paid: true });
}

// notify：微信服务器回调。APIv3 密钥 AES-256-GCM 解密成功即视为可信，再核对订单金额后落库
function decryptResource(resource) {
	const key = Buffer.from(APIV3_KEY, 'utf8');
	const ct = Buffer.from(resource.ciphertext, 'base64');
	const authTag = ct.subarray(ct.length - 16);
	const data = ct.subarray(0, ct.length - 16);
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
	decipher.setAAD(Buffer.from(resource.associated_data || 'transaction', 'utf8'));
	decipher.setAuthTag(authTag);
	return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

async function payNotify(p) {
	if (!payConfigured()) { return { code: 'FAIL', message: '支付未配置' }; }
	let body = {};
	try { body = typeof p.resource === 'object' ? p : JSON.parse(p.__rawBody || '{}'); } catch (e) { body = {}; }
	if (!body.resource || typeof body.resource.ciphertext !== 'string') {
		return { code: 'FAIL', message: '回调报文缺少 resource' };
	}
	let decoded;
	try { decoded = decryptResource(body.resource); } catch (e) {
		return { code: 'FAIL', message: '回调解密失败' };
	}
	const orderNo = decoded.out_trade_no || '';
	const db = uniCloud.database();
	const oRes = await db.collection('orders').where({ order_no: orderNo }).limit(1).get();
	if (!oRes.data || oRes.data.length === 0) { return { code: 'SUCCESS', message: 'OK' }; }
	const order = oRes.data[0];
	if (decoded.trade_state === 'SUCCESS') {
		// 金额核对：回调金额（分）必须与订单合计一致，防止篡改/错单
		const expectFen = Math.round(order.total * 100);
		const paidFen = decoded.amount && decoded.amount.payer_total ? decoded.amount.payer_total : (decoded.amount ? decoded.amount.total : 0);
		if (paidFen !== expectFen) { return { code: 'FAIL', message: '回调金额与订单不符' }; }
		if (order.pay_status !== 'paid') {
			const log = order.status_log || {};
			await db.collection('orders').where({ order_no: orderNo }).update({
				pay_status: 'paid',
				transaction_id: decoded.transaction_id || '',
				pay_time: Date.now(),
				status_log: log
			});
		}
	}
	return { code: 'SUCCESS', message: 'OK' };
}

async function payHandle(p) {
	if (p.action === 'create') { return await payCreate(p); }
	if (p.action === 'sync') { return await paySync(p); }
	if (p.resource) { return await payNotify(p); }
	return fail('不支持的操作');
}

module.exports = {
	payHandle: payHandle
};
