'use strict';
/**
 * mod = 'user'：微信小程序登录用户模块（新增）
 * action: login / getProfile / saveProfile / myOrders
 *
 * 统一约定：
 *   - token 由前端 http 层自动注入 body.token（storage key: xk_user_token）；
 *   - token 无效或缺失，统一返回 { ok:false, err:'登录已失效' }；
 *   - 集合 users：openid / token / profile{name,phone,location} / created_at / last_login_at，
 *     schema 权限全 false，只能通过本云函数读写。
 */

const crypto = require('crypto');
const { WX_APPID, WX_APP_SECRET } = require('./config.js');
const { ok, fail } = require('./util.js');

// token 失效统一文案
const ERR_TOKEN = '登录已失效';
// 微信侧失败（code 无效 / appid 或 secret 错误 / 密钥没配 / 网络异常）统一文案，不把英文错误堆给用户
const ERR_WX = '微信登录失败，请稍后重试';

// action='login'：入参 {code}（wx.login 拿到的临时凭证），换 openid 后建档发 token
async function userLogin(p) {
	// AppSecret 还是占位符时直接按微信失败处理，不去请求微信接口
	if (!WX_APP_SECRET || WX_APP_SECRET === '__FILL_WX_APP_SECRET__') {
		return fail(ERR_WX);
	}
	const code = typeof p.code === 'string' ? p.code.trim() : '';
	if (!code) {
		return fail(ERR_WX);
	}

	// code 换 openid（GET 请求，httpclient 会把 data 拼进 query）
	let wxData;
	try {
		const res = await uniCloud.httpclient.request('https://api.weixin.qq.com/sns/jscode2session', {
			method: 'GET',
			data: {
				appid: WX_APPID,
				secret: WX_APP_SECRET,
				js_code: code,
				grant_type: 'authorization_code'
			},
			dataType: 'json',
			timeout: 8000
		});
		wxData = (res && res.data) || {};
	} catch (e) {
		return fail(ERR_WX); // 超时 / 网络异常，统一文案
	}
	// 40029 code 无效 / 40013 appid 错误 / 40125 secret 错误等都会带 errcode
	if (wxData.errcode || !wxData.openid) {
		return fail(ERR_WX);
	}
	const openid = wxData.openid;

	// 签发 token：32 位随机 hex
	const token = crypto.randomBytes(16).toString('hex');
	const now = Date.now();
	const emptyProfile = { name: '', phone: '', location: '' };

	const db = uniCloud.database();
	const usersCol = db.collection('users');
	const found = await usersCol.where({ openid: openid }).limit(1).get();
	if (found.data && found.data.length > 0) {
		// 老用户：换新 token 并刷新登录时间，资料原样返回
		await usersCol.doc(found.data[0]._id).update({ token: token, last_login_at: now });
		return ok({ token: token, profile: found.data[0].profile || emptyProfile });
	}

	// 新用户：建档
	await usersCol.add({
		openid: openid,
		token: token,
		profile: emptyProfile,
		created_at: now,
		last_login_at: now
	});
	return ok({ token: token, profile: emptyProfile });
}

// 按 token 找用户记录；找不到返回 null（各 action 统一报"登录已失效"）
async function findUserByToken(usersCol, token) {
	const res = await usersCol.where({ token: token }).limit(1).get();
	if (!res.data || res.data.length === 0) {
		return null;
	}
	return res.data[0];
}

// action='getProfile'：入参 {token} → 返回 {profile}
async function userGetProfile(p) {
	const token = typeof p.token === 'string' ? p.token.trim() : '';
	if (!token) {
		return fail(ERR_TOKEN);
	}
	const db = uniCloud.database();
	const user = await findUserByToken(db.collection('users'), token);
	if (!user) {
		return fail(ERR_TOKEN);
	}
	return ok({ profile: user.profile || { name: '', phone: '', location: '' } });
}

// action='saveProfile'：入参 {token, profile:{name,phone,location}}，name 必填非空
async function userSaveProfile(p) {
	const token = typeof p.token === 'string' ? p.token.trim() : '';
	if (!token) {
		return fail(ERR_TOKEN);
	}
	const src = (p.profile && typeof p.profile === 'object' && !Array.isArray(p.profile)) ? p.profile : {};
	const name = typeof src.name === 'string' ? src.name.trim() : '';
	const phone = typeof src.phone === 'string' ? src.phone.trim() : '';
	const location = typeof src.location === 'string' ? src.location.trim() : '';
	if (!name) {
		return fail('请填写姓名');
	}
	const db = uniCloud.database();
	const user = await findUserByToken(db.collection('users'), token);
	if (!user) {
		return fail(ERR_TOKEN);
	}
	// 整体覆盖 profile，保证 name/phone/location 一起更新
	await db.collection('users').doc(user._id).update({
		profile: { name: name, phone: phone, location: location }
	});
	return ok({});
}

// action='myOrders'：入参 {token} → 我的最近 20 笔订单
async function userMyOrders(p) {
	const token = typeof p.token === 'string' ? p.token.trim() : '';
	if (!token) {
		return fail(ERR_TOKEN);
	}
	const db = uniCloud.database();
	const user = await findUserByToken(db.collection('users'), token);
	if (!user) {
		return fail(ERR_TOKEN);
	}
	// 用 users._id 作 uid 关联 orders（下单时写入的 uid）
	const res = await db.collection('orders')
		.where({ uid: user._id })
		.orderBy('created_at', 'desc')
		.limit(20)
		.get();
	const orders = (res.data || []).map(function (o) {
		return {
			orderNo: o.order_no,
			meal: o.meal || 'lunch',
			status: o.status,
			total: o.total,
			items: o.items || [],
			createdAt: o.created_at,
			menuDate: o.menu_date
		};
	});
	return ok({ orders: orders });
}

// user 模块分发
async function userHandle(p) {
	if (p.action === 'login') {
		return await userLogin(p);
	}
	if (p.action === 'getProfile') {
		return await userGetProfile(p);
	}
	if (p.action === 'saveProfile') {
		return await userSaveProfile(p);
	}
	if (p.action === 'myOrders') {
		return await userMyOrders(p);
	}
	return fail('不支持的操作');
}

module.exports = {
	userHandle: userHandle
};
