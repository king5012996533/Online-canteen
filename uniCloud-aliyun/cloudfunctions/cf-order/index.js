'use strict';
/**
 * 富记线上饭堂 - 订单云函数（小程序前端调用）
 *
 * 响应格式（前端按此解析）：
 *   成功：{"ok":true,"data":{...}}
 *   失败：{"ok":false,"err":"中文错误信息"}
 *
 * 时区约定：云函数默认 UTC，北京时间 = UTC+8。
 *   统一用“平移后的日期对象”读北京时间墙上钟：
 *     const bj = new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000)
 *   然后一律用 bj.getUTCFullYear()/getUTCMonth()/getUTCDate()/getUTCHours()/getUTCDay()。
 *   截单时刻 = 当天北京 11:00。
 *
 * 集合：dishes（今日菜单，下划线字段名）、orders（订单）、counters（自增计数器）
 */

const MIN_ORDER_TOTAL = 16;  // 起送金额（元）
const MAX_QTY_PER_ITEM = 20; // 单个菜品最大数量
const CUTOFF_HOUR = 11;      // 北京时间截单时刻：11:00
// 【测试开关】true = 暂时解除截单限制，随时可下测试单（订单会带 test_order:true 标记）。
// 正式上线前必须改回 false 并重新上传部署！
const BYPASS_CUTOFF = true;

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
	return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), CUTOFF_HOUR, 0, 0) - 480 * 60000;
}

function pad2(n) {
	return String(n).padStart(2, '0');
}

function pad3(n) {
	return String(n).padStart(3, '0');
}

// 金额只保留两位小数，避免浮点累加出现 21.999999...
function round2(n) {
	return Math.round(n * 100) / 100;
}

// ---------- 响应包装 ----------

function ok(data) {
	return { ok: true, data: data };
}

function fail(err) {
	return { ok: false, err: err };
}

// ---------- 自增序号（counters 集合） ----------

// 先 where({key}).update({count: dbCmd.inc(1)})，updated===0 说明记录不存在，
// 则 doc(key).set({key, count:1})（并发下可能冲突，包 try/catch 重试，最多 3 次），
// 成功后读回 count 作为当日序号。
async function nextSeq(db, dbCmd, key) {
	const col = db.collection('counters');
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const upd = await col.where({ key: key }).update({ count: dbCmd.inc(1) });
			if (!upd.updated) {
				// 记录不存在，尝试初始化；若与其他请求冲突，交给下一轮重试（下一轮 inc 即可成功）
				await col.doc(key).set({ key: key, count: 1 });
				continue;
			}
			const read = await col.where({ key: key }).limit(1).get();
			const count = read.data && read.data[0] && read.data[0].count;
			if (typeof count === 'number' && count > 0) {
				return count;
			}
		} catch (e) {
			// 初始化冲突或瞬时错误：重试
		}
	}
	throw new Error('订单号生成失败');
}

// ---------- 业务逻辑 ----------

// action='create'：入参 event.items=[{id,qty,pay}]、event.customer={name,location,phone,note}
// 服务端逐项校验，绝不信任客户端。
async function create(event) {
	const db = uniCloud.database();
	const dbCmd = db.command;

	const bj = bjNow();
	const today = bjDateStr(bj);

	// 1. 截单校验：北京时间当前 >= 当天 11:00 拒单（BYPASS_CUTOFF=true 时跳过，仅用于联调测试）
	if (!BYPASS_CUTOFF && Date.now() >= cutoffTsOf(today)) {
		return fail('今日已截单，明天上午再来');
	}

	// 2. items 校验
	const items = event.items;
	if (!Array.isArray(items) || items.length === 0) {
		return fail('请先选择菜品');
	}

	const menuRes = await db.collection('dishes').where({ menu_date: today }).get();
	const menuMap = {};
	(menuRes.data || []).forEach(function (d) {
		if (!menuMap[d.id]) menuMap[d.id] = d; // 并发播种重复时取第一条
	});

	const orderItems = [];
	let total = 0;
	let customExtra = 0;

	for (let i = 0; i < items.length; i++) {
		const it = items[i] || {};
		const dish = menuMap[it.id];
		if (!dish || dish.sold_out) {
			return fail('“' + (dish && dish.name ? dish.name : it.id || '该菜品') + '”今日未上架或已售罄，请刷新菜单');
		}
		const qty = it.qty;
		if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
			return fail('“' + dish.name + '”数量需为 1-' + MAX_QTY_PER_ITEM + ' 的整数');
		}
		let pay = it.pay;
		if (!dish.can_custom_price) {
			pay = dish.base_price; // 固定价菜品，强制按底价，不信任客户端传值
		} else {
			if (typeof pay !== 'number' || !isFinite(pay) || pay < dish.base_price) {
				return fail('价格不能低于起价');
			}
			pay = round2(pay);
		}
		orderItems.push({ id: dish.id, name: dish.name, pay: pay, qty: qty }); // name 存下单时的菜品名快照
		total += pay * qty;
		customExtra += (pay - dish.base_price) * qty;
	}

	// 3. 起送金额
	total = round2(total);
	if (total < MIN_ORDER_TOTAL) {
		return fail('未达 ¥16 起送');
	}
	customExtra = round2(customExtra);

	// 4. 顾客信息
	const c = event.customer || {};
	const name = typeof c.name === 'string' ? c.name.trim() : '';
	const location = typeof c.location === 'string' ? c.location.trim() : '';
	const phone = typeof c.phone === 'string' ? c.phone.trim() : '';
	const note = typeof c.note === 'string' ? c.note.trim() : '';
	if (!name || !location) {
		return fail('请填写姓名和部门 / 楼层');
	}

	// 5. 生成订单号：'FJ-' + MMDD + '-' + pad3(当日序号)，counters key = 'order_' + YYYYMMDD
	const ymd = bj.getUTCFullYear() + pad2(bj.getUTCMonth() + 1) + pad2(bj.getUTCDate());
	const mmdd = ymd.slice(4);
	const seq = await nextSeq(db, dbCmd, 'order_' + ymd);
	const orderNo = 'FJ-' + mmdd + '-' + pad3(seq);

	// 6. 写入 orders（测试期标记 test_order，便于事后清理）
	await db.collection('orders').add({
		order_no: orderNo,
		menu_date: today,
		status: 'pending',
		items: orderItems,
		total: total,
		custom_extra: customExtra,
		customer: { name: name, location: location, phone: phone, note: note },
		test_order: BYPASS_CUTOFF === true,
		created_at: Date.now()
	});

	// 7. 返回
	return ok({ orderNo: orderNo, total: total });
}

// 按日期汇总（getTodayOrders / cf-admin summary 共用的数据结构）
// date 形如 '2026-08-29'。orders 返回全部（含 canceled，状态由前端显示）；
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

// action='getTodayOrders'（管理端用）：查今天全部订单 + 聚合
async function getTodayOrders() {
	const db = uniCloud.database();
	const today = bjDateStr(bjNow());
	return ok(await buildDaySummary(db, today));
}

// action='updateStatus'：入参 {orderNo, status}
async function updateStatus(event) {
	const status = event.status;
	if (status !== 'cooking' && status !== 'ready' && status !== 'canceled') {
		return fail('非法状态');
	}
	const orderNo = event.orderNo;
	if (typeof orderNo !== 'string' || !orderNo) {
		return fail('缺少订单号');
	}
	const db = uniCloud.database();
	const res = await db.collection('orders').where({ order_no: orderNo }).update({ status: status });
	if (!res.updated) {
		return fail('订单不存在');
	}
	return ok({ orderNo: orderNo, status: status });
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
			if (p.action === 'create') {
				return http(await create(p));
			}
			if (p.action === 'getTodayOrders') {
				return http(await getTodayOrders());
			}
			if (p.action === 'updateStatus') {
				return http(await updateStatus(p));
			}
			return http(fail('不支持的操作'), 400);
		}
		// 小程序 callFunction 调用（保留兼容）
		if (e.action === 'create') {
			return await create(e);
		}
		if (e.action === 'getTodayOrders') {
			return await getTodayOrders();
		}
		if (e.action === 'updateStatus') {
			return await updateStatus(e);
		}
		return fail('不支持的操作');
	} catch (err) {
		console.error('cf-order error:', err);
		const payload = fail('服务器开小差了，请稍后再试');
		return httpMode ? http(payload, 500) : payload;
	}
};
