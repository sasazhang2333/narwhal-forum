/**
 * 与 narwhal-cms 前端一致的登录加密（Node 内置 crypto，零依赖）。
 *
 * 前端流程（NarwhalAuth 相关 composable）：
 *   1. GET /api/cms/auth/narwhal/code 拿到 RSA 公钥（publicKey）与 captchaEnabled
 *   2. 本地生成 32 字符 AES key（uuid v4 去掉横线，正好 32 个 ASCII 字符 → AES-256-ECB）
 *   3. 用 AES-ECB/PKCS7 加密 { username, password, ... } → base64 作为请求体
 *   4. 用 RSA(PKCS1 v1.5) 加密 base64(aesKey 的 UTF-8 字节) → base64 放进 encrypt-key 头
 */
import crypto from 'node:crypto';

/** 生成 32 字符 AES key（与浏览器 uuid 去横线等价）。 */
export function randomAesKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

/** AES-ECB/PKCS7 加密，返回 base64。key 以 UTF-8 字节解释，长度必须是 16/24/32。 */
export function aesEncrypt(plaintext, keyString) {
  const key = Buffer.from(String(keyString), 'utf8');
  if (![16, 24, 32].includes(key.length)) {
    throw new Error('AES key 长度非法：' + key.length + ' 字节（应为 16/24/32）');
  }
  const cipher = crypto.createCipheriv('aes-' + key.length * 8 + '-ecb', key, null);
  cipher.setAutoPadding(true);
  const out = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  return out.toString('base64');
}

/** 把后端返回的公钥（PEM 或裸 base64 DER）统一成 PEM。 */
export function normalizePublicKey(publicKey) {
  const raw = String(publicKey || '').trim().replace(/\\n/g, '\n');
  if (!raw) throw new Error('缺少 RSA 公钥（GET /api/cms/auth/narwhal/code 未返回 publicKey）');
  if (raw.includes('-----BEGIN')) return raw.endsWith('\n') ? raw : raw + '\n';
  const body = raw.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) || [body];
  // 假设后端给的是 X.509 SubjectPublicKeyInfo（Java getPublicKey / JSEncrypt 的常见形态）。
  // 若是 PKCS#1（BEGIN RSA PUBLIC KEY），需要改为对应 header —— 见 DESIGN.md「待确认」。
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n';
}

/** RSA/PKCS1 v1.5 加密，返回 base64。 */
export function rsaEncryptBase64(data, publicKey) {
  const pem = normalizePublicKey(publicKey);
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch (err) {
    throw new Error('RSA 公钥解析失败：' + err.message + '（可尝试在 NARWHAL_FORUM_RSA_FORMAT=pkcs1 下重试）');
  }
  const out = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(data), 'utf8'));
  return out.toString('base64');
}

/**
 * 生成登录请求体与 encrypt-key 头。
 * @returns {{body:string, encryptKey:string, aesKeyLength:number}}
 */
export function buildEncryptedLogin(payload, publicKey) {
  const aesKey = randomAesKey();
  const json = JSON.stringify(payload);
  const body = aesEncrypt(json, aesKey);
  const encryptKey = rsaEncryptBase64(Buffer.from(aesKey, 'utf8').toString('base64'), publicKey);
  return { body, encryptKey, aesKeyLength: aesKey.length };
}
