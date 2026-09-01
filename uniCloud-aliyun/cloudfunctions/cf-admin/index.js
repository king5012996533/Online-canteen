'use strict';
/**
 * 富记线上饭堂 - 管理端云函数（小程序厨房端 / H5 后台，走 HTTP URL 化调用）
 *
 * 阿里云 URL 化的 event 形如：
 *   {path, httpMethod, headers, queryStringParameters, body, isBase64Encoded}
 * body 一般是 JSON 字符串（isBase64Encoded=true 时为 base64），也可能直接是对象（做兼容）。
 *
 * 返回值格式（固定信封）：
 *   { mpserverlessComposedResponse: true, statusCode, headers, body: JSON.stringify(payload) }
 * payload 与小程序云函数一致：成功 {"ok":true,"data":{...}}；失败 {"ok":false,"err":"中文错误信息"}
 *
 * 时区约定：云函数默认 UTC，北京时间 = UTC+8。
 *   统一用“平移后的日期对象”读北京时间墙上钟：
 *     const bj = new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000)
 *   然后一律用 bj.getUTCFullYear()/getUTCMonth()/getUTCDate()/getUTCHours()/getUTCDay()。
 *   截单时刻 = 当天北京 11:00。
 *
 * 说明：与 cf-order 的汇总 / 改状态逻辑采用“复制实现”——阿里云版每个云函数
 * 独立打包部署，跨函数目录 require('../cf-order/index.js') 上线后不可靠。
 */

const ADMIN_PASSWORD = 'xk2026'; // 上线前务必修改！

// CORS 说明：uniCloud 阿里云网关会自动回显 Access-Control-Allow-Origin，
// 函数里再手动加会与网关重复，触发 Chrome 的 MultipleAllowOriginValues 拦截，
// 所以这里只保留 Content-Type，跨域全部交给网关处理。
const CORS_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8'
};

// ---------- 北京时间工具 ----------

// 北京时间的“墙上钟”：把当前时刻平移到北京时间后，用 getUTC* 系列方法读取
function bjNow() {
	return new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000);
}

// 北京时间日期字符串 YYYY-MM-DD
function bjDateStr(d) {
	return d.getUTCFullYear() + '-' +
		String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
		String(d.getUTCDate()).padStart(2, '0');
}

// 某个北京日期当天 11:00（截单时刻）的 epoch 毫秒；北京 11:00 = UTC 时间减 8 小时
function cutoffTsOf(dateStr) {
	const p = dateStr.split('-');
	return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 11, 0, 0) - 480 * 60000;
}

// 金额只保留两位小数，避免浮点累加误差
function round2(n) {
	return Math.round(n * 100) / 100;
}

// ---------- HTTP 信封 ----------

function http(payload, statusCode) {
	return {
		mpserverlessComposedResponse: true,
		statusCode: statusCode || 200,
		headers: CORS_HEADERS,
		body: JSON.stringify(payload)
	};
}

// ---------- 入参解析（兼容 query / JSON 字符串 / base64 / 对象） ----------

function parseParams(event) {
	const params = {};

	// queryStringParameters（GET 风格），body 里的同名键优先
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

// ---------- 业务逻辑（与 cf-order 保持一致） ----------

// 按日期汇总：date 形如 '2026-08-29'。orders 返回全部（含 canceled，状态由前端显示）；
// dishLines / totalGmv / customExtra / orderCount 排除 canceled。
async function buildDaySummary(db, date) {
	const res = await db.collection('orders')
		.where({ menu_date: date })
		.orderBy('created_at', 'desc')
		.limit(500)
		.get();
	const all = res.data || [];
	const active = all.filter(function (o) { return o.status !== 'canceled'; });

	const lineMap = {};
	let totalGmv = 0;
	let customExtra = 0;
	active.forEach(function (o) {
		totalGmv += o.total || 0;
		customExtra += o.custom_extra || 0;
		(o.items || []).forEach(function (it) {
			const key = it.name;
			if (!lineMap[key]) lineMap[key] = { name: it.name, qty: 0, amount: 0 };
			lineMap[key].qty += it.qty || 0;
			lineMap[key].amount += (it.pay || 0) * (it.qty || 0);
		});
	});

	const dishLines = Object.keys(lineMap)
		.map(function (k) {
			return {
				name: lineMap[k].name,
				qty: lineMap[k].qty,
				amount: round2(lineMap[k].amount)
			};
		})
		.sort(function (a, b) { return b.amount - a.amount; }); // 按金额降序

	return {
		date: date,
		cutoffPassed: Date.now() >= cutoffTsOf(date),
		dishLines: dishLines,
		totalGmv: round2(totalGmv),
		customExtra: round2(customExtra),
		orderCount: active.length,
		orders: all.map(function (o) {
			return {
				orderNo: o.order_no,
				status: o.status,
				total: o.total,
				customer: o.customer || { name: '', location: '', phone: '', note: '' },
				items: (o.items || []).map(function (it) {
					return { name: it.name, pay: it.pay, qty: it.qty };
				}),
				createdAt: o.created_at // created_at 原样放 createdAt
			};
		})
	};
}

// ---------- 菜单发布 ----------

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

// action='getMenu'：读某日菜单（is_template=false）+ 菜品模板列表（前端“按模板生成草稿”用）
async function getMenu(db, date) {
	const dayRes = await db.collection('dishes').where({ menu_date: date, is_template: false }).get();
	const tplRes = await db.collection('dishes').where({ is_template: true }).get();
	const bySort = function (a, b) { return (a.sort || 0) - (b.sort || 0); };
	return {
		ok: true,
		data: {
			date: date,
			dishes: (dayRes.data || []).sort(bySort).map(toMenuDish),
			templates: (tplRes.data || []).sort(bySort).map(toMenuDish)
		}
	};
}

// action='saveMenu'：整表替换某日菜单；syncTemplate=true 时把菜单同步回模板（以后每天播种用）
async function saveMenu(db, date, dishes, syncTemplate) {
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

	// 整表替换该日菜品（只动 is_template=false 的当日记录，不碰模板）
	await db.collection('dishes').where({ menu_date: date, is_template: false }).remove();
	await db.collection('dishes').add(docs);

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

// ---------- AI 菜品配图 ----------
// 复用本机电商生图技能同款 OpenAI 兼容接口（gpt-image-2）；
// key 是用户自己的，跑在用户自己的云函数里。
const IMG_API_BASE = 'https://www.ggwk1.online/v1';
const IMG_API_KEY = 'sk-RhCNZ9afpFdNlqZyth53Cq37MrFmNAWP7wawmr5Pk1GSLvqs';
const IMG_MODEL = 'gpt-image-2';

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
					// 网关返回图片链接时，下载成二进制再转 base64
					const dl = await uniCloud.httpclient.request(item.url, { method: 'GET', timeout: 30000 });
					if (dl.status === 200 && dl.data && dl.data.length > 1000) {
						b64 = Buffer.from(dl.data).toString('base64');
					} else {
						lastErr = '图片下载失败(status ' + dl.status + ')';
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

// 口令校验通过后的业务分发
async function handle(params) {
	if (params.password !== ADMIN_PASSWORD) {
		return { ok: false, err: '口令错误' };
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
		const res = await db.collection('orders').where({ order_no: orderNo }).update({ status: status });
		if (!res.updated) {
			return { ok: false, err: '订单不存在' };
		}
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
		return await getMenu(db, mDate);
	}

	if (params.action === 'saveMenu') {
		let mDate = typeof params.date === 'string' ? params.date.trim() : '';
		if (!mDate) {
			mDate = bjDateStr(bjNow());
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(mDate)) {
			return { ok: false, err: '日期格式应为 YYYY-MM-DD' };
		}
		return await saveMenu(db, mDate, params.dishes, params.syncTemplate === true);
	}

	if (params.action === 'genDishImage') {
		return await genDishImage(params.name, params.category, params.desc);
	}

	return { ok: false, err: '不支持的操作' };
}

// ---------- 入口 ----------

exports.main = async function (event) {
	const e = event || {};
	try {
		// 预检请求：直接放行
		if (String(e.httpMethod || '').toUpperCase() === 'OPTIONS') {
			return {
				mpserverlessComposedResponse: true,
				statusCode: 204,
				headers: CORS_HEADERS,
				body: ''
			};
		}

		const parsed = parseParams(e);
		if (parsed.err) {
			return http({ ok: false, err: parsed.err }, 200);
		}

		const payload = await handle(parsed.params);
		return http(payload, 200); // 口令错误也返回 200，错误信息放在 payload.err
	} catch (err) {
		console.error('cf-admin error:', err);
		return http({ ok: false, err: '服务器开小差了，请稍后再试' }, 200);
	}
};
