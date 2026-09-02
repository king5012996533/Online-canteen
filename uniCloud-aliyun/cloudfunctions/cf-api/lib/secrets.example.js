'use strict';
/**
 * 机密配置模板：复制本文件为同目录 secrets.js 并填入真实值。
 * secrets.js 已被 .gitignore 忽略，永不入库。
 */

module.exports = {
	ADMIN_PASSWORD: '__FILL_ADMIN_PASSWORD__',
	IMG_API_KEY: '__FILL_IMG_API_KEY__',
	IMG_MODEL: 'gpt-image-2',
	WX_APP_SECRET: '__FILL_WX_APP_SECRET__',
	// ---- 微信支付 V3（商户平台 pay.weixin.qq.com → 账户中心 → API 安全）----
	MCH_ID: '__FILL_MCH_ID__',            // 商户号（纯数字）
	MCH_SERIAL_NO: '__FILL_CERT_SERIAL__', // 商户API证书序列号
	APIV3_KEY: '__FILL_APIV3_KEY__'        // APIv3 密钥（32 位）
};
// 另需将商户私钥 apiclient_key.pem 复制为本目录 apiclient_key.pem（同样不入 Git）。
