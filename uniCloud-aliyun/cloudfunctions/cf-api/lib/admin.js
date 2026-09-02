'use strict';
/**
 * mod = 'admin'：厨房端管理（原 cf-admin，需口令）
 * 口令校验后 action: summary / updateStatus / getMenu / saveMenu / genDishImage
 */

const { ADMIN_PASSWORD, IMG_API_BASE, IMG_API_KEY, IMG_MODEL } = require('./config.js');
const { bjNow, bjDateStr } = require('./util.js');
const { buildDaySummary } = require('./order.js');

// dishes 表记录 -> 前端菜单项（camelCase）
function toMenuDish(d) {
	return {
		id: d.id,
		category: d.category || '荤素搭配',
		name: d.name,
		desc: d.desc || '',
		basePrice: d.base_price,
		canCustomPrice: !!d.can_custom_price,
		image: d.image || '/static/dishes/mix1.png',
		soldOut: !!d.sold_out,
		sort: typeof d.sort === 'number' ? d.sort : 0
	};
}

// action='getMenu'：读某日菜单（is_template=false，只认最新发布批次）+ 菜品模板列表（前端"按模板生成草稿"用）
function latestBatchDocs(docs) {
	// 只保留最新发布批次（batch 缺失的老数据视为 0，仅当全是老数据时原样返回）
	let latest = 0;
	docs.forEach(function (d) { const b = typeof d.batch === 'number' ? d.batch : 0; if (b > latest) latest = b; });
	if (latest === 0) return docs;
	return docs.filter(function (d) { return (typeof d.batch === 'number' ? d.batch : 0) === latest; });
}

async function adminGetMenu(db, date) {
	const dayRes = await db.collection('dishes').where({ menu_date: date, is_template: false }).get();
	const tplRes = await db.collection('dishes').where({ is_template: true }).get();
	const bySort = function (a, b) { return (a.sort || 0) - (b.sort || 0); };
	return {
		ok: true,
		data: {
			date: date,
			dishes: latestBatchDocs(dayRes.data || []).sort(bySort).map(toMenuDish),
			templates: (tplRes.data || []).sort(bySort).map(toMenuDish)
		}
	};
}

// action='saveMenu'：整表替换某日菜单；syncTemplate=true 时把菜单同步回模板（以后每天播种用）
async function adminSaveMenu(db, date, dishes, syncTemplate) {
	if (!Array.isArray(dishes)) {
		return { ok: false, err: '菜单数据格式错误' };
	}
	if (dishes.length === 0) {
		return { ok: false, err: '菜单不能为空，至少要有一道菜' };
	}
	if (dishes.length > 40) {
		return { ok: false, err: '菜品太多啦（上限 40 道）' };
	}

	const seenIds = {};
	const docs = [];
	for (let i = 0; i < dishes.length; i++) {
		const d = dishes[i] || {};
		const name = typeof d.name === 'string' ? d.name.trim() : '';
		if (!name) {
			return { ok: false, err: '第 ' + (i + 1) + ' 个菜品缺少菜名' };
		}
		const price = Number(d.basePrice);
		if (isNaN(price) || price < 0 || price > 9999) {
			return { ok: false, err: '菜品「' + name + '」价格不合法' };
		}
		let id = typeof d.id === 'string' ? d.id : '';
		if (!id || seenIds[id]) {
			id = 'dish' + Date.now().toString(36) + ('' + Math.floor(Math.random() * 1296));
		}
		seenIds[id] = true;
		docs.push({
			id: id,
			category: typeof d.category === 'string' && d.category.trim() ? d.category.trim() : '荤素搭配',
			name: name,
			desc: typeof d.desc === 'string' ? d.desc.trim() : '',
			base_price: Math.round(price * 100) / 100,
			can_custom_price: d.canCustomPrice === true,
			image: typeof d.image === 'string' && d.image ? d.image : '/static/dishes/mix1.png',
			sold_out: d.soldOut === true,
			sort: i,
			is_template: false,
			menu_date: date,
			created_at: Date.now()
		});
	}

	// 两阶段发布：先写入新批次（带 batch 时间戳），成功后再清旧批次。
	// 读取端（getToday / getMenu）只认最大 batch，发布中途失败用户最多看到旧菜单，
	// 不会出现"先删后写"失败导致的空菜单窗口
	const dbCmd = db.command;
	const batch = Date.now();
	docs.forEach(function (d) { d.batch = batch; });
	await db.collection('dishes').add(docs);
	await db.collection('dishes').where({ menu_date: date, is_template: false, batch: dbCmd.lt(batch) }).remove();
	await db.collection('dishes').where({ menu_date: date, is_template: false, batch: dbCmd.exists(false) }).remove();

	if (syncTemplate === true) {
		const tplRes = await db.collection('dishes').where({ is_template: true }).get();
		const tplIds = {};
		(tplRes.data || []).forEach(function (t) { tplIds[t.id] = true; });
		const now = Date.now();
		for (let i = 0; i < docs.length; i++) {
			const doc = docs[i];
			const patch = {
				category: doc.category,
				name: doc.name,
				desc: doc.desc,
				base_price: doc.base_price,
				can_custom_price: doc.can_custom_price,
				image: doc.image,
				sort: i
			};
			if (tplIds[doc.id]) {
				await db.collection('dishes').where({ id: doc.id, is_template: true }).update(patch);
			} else {
				// 新菜：补一条模板记录，以后每天自动播种会带上
				const tplDoc = Object.assign({}, patch, {
					id: doc.id,
					sold_out: false,
					is_template: true,
					menu_date: '',
					created_at: now
				});
				await db.collection('dishes').add(tplDoc);
			}
		}
	}

	return { ok: true, data: { date: date, count: docs.length, synced: syncTemplate === true } };
}

// 生图网关返回的下载地址先做 SSRF 防护：只允许 https 公网地址，
// 拒绝 localhost / 内网 IP 段 / 裸 IP / 无点域名，再发起下载
function isSafeImageUrl(raw) {
	if (typeof raw !== 'string' || raw === '') return false;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:') return false;
		const h = u.hostname.toLowerCase();
		if (h === '' || h.indexOf('.') < 0) return false;
		if (h === 'localhost' || h.indexOf('.localhost') >= 0 || h.indexOf('.local') >= 0 || h.indexOf('.internal') >= 0) return false;
		if (h.charAt(0) === '[') return false; // IPv6 字面量一律拒绝
		if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
			const p = h.split('.').map(Number);
			if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
			if (p[0] === 192 && p[1] === 168) return false;
			if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
			if (p[0] === 169 && p[1] === 254) return false;
		}
		return true;
	} catch (e) {
		return false;
	}
}

// action='genDishImage'：按菜名生成菜品实拍风配图，上传云存储后返回 https 地址
async function genDishImage(name, category, desc) {
	const cleanName = typeof name === 'string' ? name.trim().substring(0, 20) : '';
	if (!cleanName) {
		return { ok: false, err: '先填菜名，再生成配图' };
	}
	const cat = typeof category === 'string' ? category.trim().substring(0, 10) : '';
	const d = typeof desc === 'string' ? desc.trim().substring(0, 40) : '';
	const prompt = '中式家常菜美食实拍照片：' + cleanName +
		(cat ? ('（' + cat + '）') : '') +
		(d ? ('，' + d) : '') +
		'。盛在白色圆盘中，木纹餐桌背景，45度俯拍视角，自然柔光，色泽诱人，热气腾腾，真实食物质感，画面干净，无文字，无水印，无logo';

	// 生图（gpt-image-2 单次可能要 1~4 分钟；中转网关偶发 502 快速失败时自动重试，
	// 但慢失败（超时耗尽）后不再重试，避免超出云函数 360s 时限）
	const genStarted = Date.now();
	let b64 = '';
	let lastErr = '';
	for (let attempt = 0; attempt < 3 && b64 === ''; attempt++) {
		if (attempt > 0 && Date.now() - genStarted > 15000) {
			break;
		}
		try {
			const res = await uniCloud.httpclient.request(IMG_API_BASE + '/images/generations', {
				method: 'POST',
				data: { model: IMG_MODEL, prompt: prompt, n: 1, size: '1024x1024' },
				headers: {
					'Authorization': 'Bearer ' + IMG_API_KEY,
					'Content-Type': 'application/json'
				},
				contentType: 'json',
				dataType: 'json',
				timeout: 260000
			});
			const item = (res.status === 200 && res.data && Array.isArray(res.data.data) && res.data.data.length > 0)
				? res.data.data[0] : null;
			if (item !== null) {
				if (typeof item.b64_json === 'string' && item.b64_json.length > 100) {
					b64 = item.b64_json.indexOf('base64,') >= 0 ? item.b64_json.split('base64,')[1] : item.b64_json;
				} else if (typeof item.url === 'string' && item.url) {
					// 网关返回图片链接时，先过 SSRF 校验再下载成二进制转 base64
					if (!isSafeImageUrl(item.url)) {
						lastErr = '图片链接不安全，已拦截';
					} else {
						const dl = await uniCloud.httpclient.request(item.url, { method: 'GET', timeout: 30000 });
						if (dl.status === 200 && dl.data && dl.data.length > 1000 && dl.data.length < 20 * 1024 * 1024) {
							b64 = Buffer.from(dl.data).toString('base64');
						} else {
							lastErr = '图片下载失败(status ' + dl.status + ')';
						}
					}
				}
			}
			if (b64 === '' && lastErr === '') {
				lastErr = '接口返回异常(status ' + res.status + ')';
			}
		} catch (e) {
			lastErr = (e && e.message) ? e.message : '请求生图接口失败';
		}
	}
	if (b64 === '') {
		return { ok: false, err: '生成失败（' + lastErr + '），请稍后重试' };
	}

	// 上传 uniCloud 云存储，拿可长期使用的 https 地址
	try {
		const up = await uniCloud.uploadFile({
			cloudPath: 'dish-images/gen-' + Date.now().toString(36) + '.png',
			fileContent: Buffer.from(b64, 'base64')
		});
		let url = '';
		if (up.fileID) {
			const tfu = await uniCloud.getTempFileURL({ fileList: [up.fileID] });
			if (tfu.fileList && tfu.fileList.length > 0 && tfu.fileList[0].tempFileURL) {
				url = tfu.fileList[0].tempFileURL;
			}
		}
		if (url === '') {
			return { ok: false, err: '图片已生成，但获取地址失败，请重试' };
		}
		return { ok: true, data: { url: url } };
	} catch (e2) {
		return { ok: false, err: '图片已生成，但上传存储失败，请重试' };
	}
}

// 口令试错限流（按 IP，实例内存级：多数攻击场景已够用；实例重启清零）
const adminFails = new Map(); // ip -> { count, until }

// 口令校验通过后的业务分发
async function adminHandle(params, clientIP) {
	const now = Date.now();
	const rec = clientIP ? adminFails.get(clientIP) : null;
	if (rec && rec.until > now) {
		return { ok: false, err: '口令尝试过多，请10分钟后再试' };
	}
	if (params.password !== ADMIN_PASSWORD) {
		if (clientIP) {
			const r = adminFails.get(clientIP) || { count: 0, until: 0 };
			r.count += 1;
			if (r.count >= 5) { r.count = 0; r.until = now + 10 * 60 * 1000; }
			adminFails.set(clientIP, r);
		}
		return { ok: false, err: '口令错误' };
	}
	if (clientIP) {
		adminFails.delete(clientIP);
	}

	const db = uniCloud.database();

	if (params.action === 'summary') {
		// date 缺省 = 今天（北京时间）
		let date = typeof params.date === 'string' ? params.date.trim() : '';
		if (!date) {
			date = bjDateStr(bjNow());
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			return { ok: false, err: '日期格式应为 YYYY-MM-DD' };
		}
		return { ok: true, data: await buildDaySummary(db, date) };
	}

	if (params.action === 'updateStatus') {
		const status = params.status;
		if (status !== 'cooking' && status !== 'ready' && status !== 'canceled') {
			return { ok: false, err: '非法状态' };
		}
		const orderNo = params.orderNo;
		if (typeof orderNo !== 'string' || !orderNo) {
			return { ok: false, err: '缺少订单号' };
		}
		// 状态机校验：pending→cooking|canceled；cooking→ready|canceled；ready→canceled；canceled 终态
		const orderRes = await db.collection('orders').where({ order_no: orderNo }).limit(1).get();
		if (!orderRes.data || orderRes.data.length === 0) {
			return { ok: false, err: '订单不存在' };
		}
		const cur = orderRes.data[0].status;
		const TRANSITIONS = { pending: ['cooking', 'canceled'], cooking: ['ready', 'canceled'], ready: ['canceled'], canceled: [] };
		const allowed = TRANSITIONS[cur] || [];
		if (allowed.indexOf(status) < 0) {
			return { ok: false, err: '当前状态不能改为该状态' };
		}
		await db.collection('orders').where({ order_no: orderNo }).update({ status: status });
		return { ok: true, data: { orderNo: orderNo, status: status } };
	}

	if (params.action === 'getMenu') {
		let mDate = typeof params.date === 'string' ? params.date.trim() : '';
		if (!mDate) {
			mDate = bjDateStr(bjNow());
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(mDate)) {
			return { ok: false, err: '日期格式应为 YYYY-MM-DD' };
		}
		return await adminGetMenu(db, mDate);
	}

	if (params.action === 'saveMenu') {
		let mDate = typeof params.date === 'string' ? params.date.trim() : '';
		if (!mDate) {
			mDate = bjDateStr(bjNow());
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(mDate)) {
			return { ok: false, err: '日期格式应为 YYYY-MM-DD' };
		}
		return await adminSaveMenu(db, mDate, params.dishes, params.syncTemplate === true);
	}

	if (params.action === 'genDishImage') {
		return await genDishImage(params.name, params.category, params.desc);
	}

	return { ok: false, err: '不支持的操作' };
}

module.exports = {
	adminHandle: adminHandle
};
