'use strict';
/**
 * 通用工具：响应包装、北京时间日期工具、订单号当日序号。
 *
 * 数据库使用约定（全项目统一）：各业务模块在函数入口自建 uniCloud.database()；
 * 需要数据库的通用函数（如 nextSeq）由调用方把 db / dbCmd 通过参数传入。
 */

// ---------- 响应包装 ----------

function ok(data) {
	return { ok: true, data: data };
}

function fail(err) {
	return { ok: false, err: err };
}

// ---------- 北京时间工具 ----------

// 北京时间的"墙上钟"：把当前时刻平移到北京时间后，用 getUTC* 系列方法读取
function bjNow() {
	return new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000);
}

// 北京时间日期字符串 YYYY-MM-DD
function bjDateStr(d) {
	return d.getUTCFullYear() + '-' +
		String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
		String(d.getUTCDate()).padStart(2, '0');
}

// 某个北京日期当天指定时刻（'HH:MM'，24 小时制）的 epoch 毫秒；北京时刻 = UTC 时刻减 8 小时
function tsOfHM(dateStr, hm) {
	const p = dateStr.split('-');
	const hmP = hm.split(':');
	return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(hmP[0]), Number(hmP[1]), 0) - 480 * 60000;
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

// ---------- 订单号当日序号 ----------

// 先 where({key}).update({count: dbCmd.inc(1)})，updated===0 说明记录不存在，
// 则 doc(key).set({key, count:1})（并发下可能冲突，包 try/catch 重试，最多 3 次），
// 成功后读回 count 作为当日序号。
async function nextSeq(db, dbCmd, key) {
	const col = db.collection('counters');
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const upd = await col.where({ key: key }).update({ count: dbCmd.inc(1) });
			if (!upd.updated) {
				// 记录不存在，初始化为 0；若与其他请求冲突，交给下一轮重试（下一轮 inc 即可成功）
				// 注意必须初始化为 0：continue 后下一轮会先 inc(1)，初始化 1 会导致首单序号变成 2
				await col.doc(key).set({ key: key, count: 0 });
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

module.exports = {
	ok: ok,
	fail: fail,
	bjNow: bjNow,
	bjDateStr: bjDateStr,
	tsOfHM: tsOfHM,
	pad2: pad2,
	pad3: pad3,
	round2: round2,
	nextSeq: nextSeq
};
