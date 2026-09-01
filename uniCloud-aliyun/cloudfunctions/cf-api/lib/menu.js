'use strict';
/**
 * mod = 'menu'：今日菜单（原 cf-menu），action: getToday
 */

const { ok, bjNow, bjDateStr, cutoffTsOf } = require('./util.js');

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
async function menuGetToday() {
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

	const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
	const m = bj.getUTCMonth() + 1;
	const day = bj.getUTCDate();
	return ok({
		date: today,
		dateLabel: m + '月' + day + '日 · ' + WEEKDAYS[bj.getUTCDay()],
		cutoffTs: cutoffTsOf(today),
		dishes: dishes
	});
}

module.exports = {
	menuGetToday: menuGetToday
};
