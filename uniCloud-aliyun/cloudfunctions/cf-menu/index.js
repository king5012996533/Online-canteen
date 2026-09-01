'use strict';
/**
 * 富记线上饭堂 - 菜单云函数（小程序前端调用）
 *
 * 响应格式（前端按此解析）：
 *   成功：{"ok":true,"data":{...}}
 *   失败：{"ok":false,"err":"中文错误信息"}
 *
 * 时区约定：云函数默认 UTC，北京时间 = UTC+8。
 *   统一用“平移后的日期对象”读北京时间墙上钟：
 *     const bj = new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000)
 *   然后一律用 bj.getUTCFullYear()/getUTCMonth()/getUTCDate()/getUTCHours()/getUTCDay()。
 *
 * 集合：dishes（is_template=true 的记录为菜品模板，用于每天播种今日菜单）
 */

// getUTCDay() -> 周X
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 内置菜品模板兜底数据：若 dishes 表中没有任何 is_template=true 的记录，
// 则在播种今日菜单前先用这份内置数据补种模板（sort 按下标 0-7）。
const TEMPLATE_SEED = [
	{ id: 'veg1', category: '素菜', name: '清炒时令青菜', desc: '当天档口青菜 · 可加价', basePrice: 3, canCustomPrice: true, image: '/static/dishes/veg1.png' },
	{ id: 'veg2', category: '素菜', name: '虎皮青椒', desc: '微辣，可加价加肉', basePrice: 3, canCustomPrice: true, image: '/static/dishes/veg2.png' },
	{ id: 'veg3', category: '素菜', name: '酸辣土豆', desc: '今日售罄', basePrice: 3, canCustomPrice: true, image: '/static/dishes/veg3.png' },
	{ id: 'mix1', category: '荤素搭配', name: '茄子肉末', desc: '时令茄子 + 猪肉末 · 可加价', basePrice: 6, canCustomPrice: true, image: '/static/dishes/mix1.png' },
	{ id: 'mix2', category: '荤素搭配', name: '青椒牛柳', desc: '固定价', basePrice: 6, canCustomPrice: false, image: '/static/dishes/mix2.png' },
	{ id: 'mix3', category: '荤素搭配', name: '香菇滑鸡', desc: '固定价', basePrice: 6, canCustomPrice: false, image: '/static/dishes/mix3.png' },
	{ id: 'meat1', category: '纯荤', name: '糖醋里脊', desc: '固定价，避免亏损', basePrice: 9, canCustomPrice: false, image: '/static/dishes/meat1.png' },
	{ id: 'meat2', category: '纯荤', name: '红烧肉', desc: '固定价', basePrice: 9, canCustomPrice: false, image: '/static/dishes/meat2.png' }
];

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

// ---------- 响应包装 ----------

function ok(data) {
	return { ok: true, data: data };
}

function fail(err) {
	return { ok: false, err: err };
}

// ---------- 业务逻辑 ----------

// 今日菜单为空时，从模板（is_template=true）复制播种今日菜单
async function seedTodayMenu(dishesCol, today) {
	let tplRes = await dishesCol.where({ is_template: true }).get();
	let templates = tplRes.data || [];

	if (templates.length === 0) {
		// 兜底：库里没有模板，先用内置数据补种模板记录（menu_date 留空串，不参与按日查询）
		const now = Date.now();
		const seedDocs = TEMPLATE_SEED.map(function (t, i) {
			return {
				id: t.id,
				category: t.category,
				name: t.name,
				desc: t.desc,
				base_price: t.basePrice,
				can_custom_price: t.canCustomPrice,
				image: t.image,
				sold_out: false,
				sort: i,
				is_template: true,
				menu_date: '',
				created_at: now
			};
		});
		await dishesCol.add(seedDocs);
		tplRes = await dishesCol.where({ is_template: true }).get();
		templates = tplRes.data || [];
	}

	const docs = templates
		.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
		.map(function (t) {
			return {
				id: t.id,
				category: t.category,
				name: t.name,
				desc: t.desc,
				base_price: t.base_price,
				can_custom_price: !!t.can_custom_price,
				image: t.image,
				sold_out: false,
				sort: typeof t.sort === 'number' ? t.sort : 0,
				is_template: false, // 复制播种时去掉模板标记
				menu_date: today,
				created_at: Date.now()
			};
		});
	if (docs.length > 0) {
		await dishesCol.add(docs);
	}
}

// action='getToday'
async function getToday() {
	const db = uniCloud.database();
	const dishesCol = db.collection('dishes');

	const bj = bjNow();
	const today = bjDateStr(bj);

	let res = await dishesCol.where({ menu_date: today }).get();
	if (!res.data || res.data.length === 0) {
		await seedTodayMenu(dishesCol, today);
		res = await dishesCol.where({ menu_date: today }).get();
	}

	// 按 sort 升序输出；同一 id 若因并发播种出现重复，只保留第一条
	const seen = {};
	const dishes = (res.data || [])
		.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
		.filter(function (d) {
			if (seen[d.id]) return false;
			seen[d.id] = true;
			return true;
		})
		.map(function (d) {
			return {
				id: d.id,
				category: d.category,
				name: d.name,
				desc: d.desc,
				basePrice: d.base_price,
				canCustomPrice: !!d.can_custom_price,
				image: d.image,
				soldOut: !!d.sold_out
			};
		});

	const m = bj.getUTCMonth() + 1;
	const day = bj.getUTCDate();
	return ok({
		date: today,
		dateLabel: m + '月' + day + '日 · ' + WEEKDAYS[bj.getUTCDay()],
		cutoffTs: cutoffTsOf(today),
		dishes: dishes
	});
}

// ---------- HTTP URL 化支持（信封与 cf-admin 一致） ----------

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

// ---------- 入口 ----------

exports.main = async function (event) {
	const e = event || {};
	const httpMode = isHttpEvent(e);
	try {
		if (httpMode) {
			// 浏览器跨域预检直接放行
			if (String(e.httpMethod || 'POST').toUpperCase() === 'OPTIONS') {
				return http(ok({ ping: 'pong' }));
			}
			const parsed = parseParams(e);
			if (parsed.err !== undefined) {
				return http(fail(parsed.err), 400);
			}
			const p = parsed.params || {};
			if (p.action === 'getToday') {
				return http(await getToday());
			}
			return http(fail('不支持的操作'), 400);
		}
		// 小程序 callFunction 调用（保留兼容）
		if (e.action === 'getToday') {
			return await getToday();
		}
		return fail('不支持的操作');
	} catch (err) {
		console.error('cf-menu error:', err);
		const payload = fail('服务器开小差了，请稍后再试');
		return httpMode ? http(payload, 500) : payload;
	}
};
