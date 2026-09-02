'use strict';
/**
 * mod = 'order'：下单 / 订单查询 / 改状态（原 cf-order）
 * action: create / getTodayOrders / updateStatus
 */

const { BYPASS_CUTOFF, MIN_ORDER_TOTAL, MAX_QTY_PER_ITEM, MEALS } = require('./config.js');
const { ok, fail, bjNow, bjDateStr, tsOfHM, pad2, pad3, round2, nextSeq } = require('./util.js');

// action='create'：入参 items=[{id,qty,pay}]、customer={name,location,phone,note}
// 服务端逐项校验，绝不信任客户端。
async function orderCreate(event) {
	const db = uniCloud.database();
	const dbCmd = db.command;

	const bj = bjNow();
	const today = bjDateStr(bj);

	// 0. 餐次校验：一单一餐，meal 必填且只能是 lunch / dinner
	const meal = event.meal;
	if (!MEALS[meal]) {
		return fail('请选择午餐或晚餐');
	}

	// 1. 截单校验：北京时间当前 >= 当天该餐次截单时刻拒单（BYPASS_CUTOFF=true 时全局跳过，仅用于联调测试）
	if (!BYPASS_CUTOFF && Date.now() >= tsOfHM(today, MEALS[meal].orderClose)) {
		return fail('今日' + MEALS[meal].label + '已截单');
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

	// 5. 生成订单号：'FJ-' + MMDD + '-' + 餐次字母 + pad3(当日该餐次序号)，counters key = 'order_' + 餐次字母 + '_' + YYYYMMDD
	const ymd = bj.getUTCFullYear() + pad2(bj.getUTCMonth() + 1) + pad2(bj.getUTCDate());
	const mmdd = ymd.slice(4);
	const seqN = await nextSeq(db, dbCmd, 'order_' + MEALS[meal].seq + '_' + ymd);
	const orderNo = 'FJ-' + mmdd + '-' + MEALS[meal].seq + pad3(seqN);

	// 关联下单用户：前端 http 层自动注入 token，按 token 反查 users；
	// 查得到取 users._id 作 uid，查不到 / 未登录不拦截下单，uid 存空串（兼容老流程）
	let uid = '';
	let userDoc = null;
	const userToken = typeof event.token === 'string' ? event.token.trim() : '';
	if (userToken) {
		try {
			const uRes = await db.collection('users').where({ token: userToken }).limit(1).get();
			if (uRes.data && uRes.data.length > 0) {
				userDoc = uRes.data[0];
				uid = userDoc._id || '';
			}
		} catch (e) {
			// users 集合异常（如还没建）也不能阻断下单
		}
	}

	// 6. 写入 orders（测试期标记 test_order，便于事后清理）
	await db.collection('orders').add({
		order_no: orderNo,
		menu_date: today,
		meal: meal,
		status: 'pending',
		items: orderItems,
		total: total,
		custom_extra: customExtra,
		customer: { name: name, location: location, phone: phone, note: note },
		uid: uid,
		test_order: BYPASS_CUTOFF === true,
		created_at: Date.now()
	});

	// 7. 下单即回存常用信息：姓名/取餐位置按"最近一次"覆盖，手机号本次没填就保留旧值；
	// 回存失败不影响下单结果
	if (userDoc && userDoc._id) {
		try {
			const oldProfile = userDoc.profile || {};
			await db.collection('users').doc(userDoc._id).update({
				profile: {
					name: name,
					location: location,
					phone: phone || (typeof oldProfile.phone === 'string' ? oldProfile.phone : '')
				}
			});
		} catch (e) {
			// 档案回存失败静默，订单已成立
		}
	}

	// 8. 返回
	return ok({ orderNo: orderNo, total: total });
}

// 按日期汇总（order getTodayOrders 与 admin summary 共用）
// date 形如 '2026-08-29'。meals 按餐次（lunch/dinner）分别聚合：dishLines / totalGmv /
// customExtra / orderCount 排除 canceled，cutoffPassed 按各餐 orderClose 判；
// orders 返回全部（含 canceled，状态由前端显示），按 created_at desc。
// 老订单可能没有 meal 字段，统一归入 lunch。
async function buildDaySummary(db, date) {
	const res = await db.collection('orders')
		.where({ menu_date: date })
		.orderBy('created_at', 'desc')
		.limit(500)
		.get();
	const all = res.data || [];
	const active = all.filter(function (o) { return o.status !== 'canceled'; });

	// 老订单无 meal 字段视为午餐；非法值同样兜底到 lunch
	const mealOf = function (o) {
		return MEALS[o.meal] ? o.meal : 'lunch';
	};

	const mealKeys = Object.keys(MEALS);
	const meals = {};
	mealKeys.forEach(function (key) {
		meals[key] = {
			cutoffPassed: Date.now() >= tsOfHM(date, MEALS[key].orderClose),
			dishLines: [],
			totalGmv: 0,
			customExtra: 0,
			orderCount: 0
		};
	});

	const lineMaps = {};
	active.forEach(function (o) {
		const mk = mealOf(o);
		meals[mk].totalGmv += o.total || 0;
		meals[mk].customExtra += o.custom_extra || 0;
		meals[mk].orderCount += 1;
		if (!lineMaps[mk]) lineMaps[mk] = {};
		const lineMap = lineMaps[mk];
		(o.items || []).forEach(function (it) {
			if (!lineMap[it.name]) lineMap[it.name] = { name: it.name, qty: 0, amount: 0 };
			lineMap[it.name].qty += it.qty || 0;
			lineMap[it.name].amount += (it.pay || 0) * (it.qty || 0);
		});
	});

	mealKeys.forEach(function (mk) {
		meals[mk].totalGmv = round2(meals[mk].totalGmv);
		meals[mk].customExtra = round2(meals[mk].customExtra);
		meals[mk].dishLines = Object.keys(lineMaps[mk] || {})
			.map(function (k) {
				return {
					name: lineMaps[mk][k].name,
					qty: lineMaps[mk][k].qty,
					amount: round2(lineMaps[mk][k].amount)
				};
			})
			.sort(function (a, b) { return b.amount - a.amount; }); // 按金额降序
	});

	return {
		date: date,
		meals: meals,
		orders: all.map(function (o) {
			return {
				orderNo: o.order_no,
				meal: mealOf(o),
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

// action='getTodayOrders'：查今天全部订单 + 聚合
async function orderGetTodayOrders() {
	const db = uniCloud.database();
	const today = bjDateStr(bjNow());
	return ok(await buildDaySummary(db, today));
}

// action='updateStatus'：入参 {orderNo, status}
async function orderUpdateStatus(event) {
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

// order 模块分发
async function orderHandle(p) {
	if (p.action === 'create') {
		return await orderCreate(p);
	}
	if (p.action === 'getTodayOrders') {
		return await orderGetTodayOrders();
	}
	if (p.action === 'updateStatus') {
		return await orderUpdateStatus(p);
	}
	return fail('不支持的操作');
}

module.exports = {
	orderHandle: orderHandle,
	buildDaySummary: buildDaySummary // admin 的 summary 复用，实现在本模块
};
