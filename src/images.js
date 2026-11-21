/**
 * 图片评论支持（零后端改动方案 A：先上传拿 URL，再把 markdown 图片内联进正文）。
 *
 * 为什么不需要改后端：
 *  - 上传接口 POST /api/upload/image-upload 已存在（UploadController，@PreAuthorize("isAuthenticated()")），
 *    登录即可用，压缩 / 水印 / 图片内容审核都在上传时完成。
 *  - 评论正文是普通 String，前端 BbsMarkdown.vue 用 marked + DOMPurify 渲染（img 默认放行），
 *    所以正文里写 ![](url) 就会渲染成图片。
 *
 * 因此本模块只做三件事：校验本地文件 → 拼 multipart 请求体 → 生成内联 markdown。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 后端 UploadController 接受的图片扩展名（按扩展名推断 Content-Type）。 */
export const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** 单张图片上限 10MB（后端也有自己的上限，这里先挡一层，免得白传）。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 一条评论/帖子最多带几张图：9 张（markdown 里再多也没有阅读价值）。 */
export const MAX_IMAGES = 9;

export class ImageError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ImageError';
    this.code = extra.code || 'E_IMAGE';
    this.path = extra.path;
    this.hint = extra.hint;
  }
}

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 计算文件 sha256（草稿把指纹一起存下来，发布时重新校验，防止「批准 A 发布 B」）。 */
export function sha256File(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验并描述一个本地图片文件。
 * @returns {{path:string,name:string,mime:string,bytes:number,sha256:string}}
 */
export function describeImage(input, opts = {}) {
  const raw = typeof input === 'string' ? input : input && input.path;
  if (!raw) throw new ImageError('缺少图片路径', { code: 'E_IMAGE_PATH' });
  const file = path.resolve(String(raw).replace(/^file:\/\//, ''));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ImageError('图片文件不存在：' + file, { code: 'E_IMAGE_NOT_FOUND', path: file });
  }
  if (!stat.isFile()) throw new ImageError('不是普通文件：' + file, { code: 'E_IMAGE_NOT_FILE', path: file });
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new ImageError('不支持的图片格式 ' + (ext || '(无扩展名)') + '，可用：' + Object.keys(IMAGE_MIME).join(' '), {
      code: 'E_IMAGE_TYPE',
      path: file,
      hint: '先转成 png / jpg / webp / gif 再上传。',
    });
  }
  const max = opts.maxBytes || MAX_IMAGE_BYTES;
  if (stat.size > max) {
    throw new ImageError('图片太大：' + formatBytes(stat.size) + '（上限 ' + formatBytes(max) + '）', {
      code: 'E_IMAGE_TOO_LARGE',
      path: file,
    });
  }
  if (stat.size === 0) throw new ImageError('图片是空文件：' + file, { code: 'E_IMAGE_EMPTY', path: file });
  return { path: file, name: path.basename(file), mime, bytes: stat.size, sha256: sha256File(file) };
}

/** 把 --image a.png --image b.png / images: [...] 统一成数组并逐一校验。 */
export function resolveImageList(values, opts = {}) {
  const list = Array.isArray(values) ? values : values === undefined || values === null || values === '' ? [] : [values];
  const flat = [];
  for (const item of list) {
    if (typeof item === 'string' && item.includes(',')) flat.push(...item.split(',').map((s) => s.trim()).filter(Boolean));
    else if (item !== undefined && item !== null && item !== '') flat.push(item);
  }
  if (!flat.length) return [];
  if (flat.length > MAX_IMAGES) {
    throw new ImageError('一次最多带 ' + MAX_IMAGES + ' 张图，收到 ' + flat.length + ' 张', { code: 'E_IMAGE_TOO_MANY' });
  }
  return flat.map((item) => (typeof item === 'string' ? describeImage(item, opts) : item));
}

/** 拼 multipart/form-data 请求体（字段名固定 file，与前端 usePasteImage 一致）。 */
export function buildMultipart(image, boundary) {
  const id = boundary || '----narwhalforum' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(
    '--' + id + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + image.name.replace(/"/g, '') + '"\r\n' +
    'Content-Type: ' + image.mime + '\r\n\r\n',
    'utf8'
  );
  const tail = Buffer.from('\r\n--' + id + '--\r\n', 'utf8');
  const body = Buffer.concat([head, fs.readFileSync(image.path), tail]);
  return { body, boundary: id };
}

/** 后端返回的 url 可能是相对路径（/uploads/...），补成绝对地址。 */
export function absoluteImageUrl(baseUrl, url) {
  const raw = String(url || '');
  if (!raw) return raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, String(baseUrl || '').replace(/\/?$/, '/')).toString();
  } catch {
    return raw;
  }
}

/** 从上传响应里抠出图片 URL（后端可能返回 url / webpUrl / originalUrl，或直接返回字符串）。 */
export function pickUploadedUrl(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const candidates = [result.url, result.webpUrl, result.webp_url, result.originalUrl, result.src, result.path];
  if (result.result && typeof result.result === 'object') candidates.push(result.result.url, result.result.webpUrl);
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

/** 图片 markdown：一行一张，方便人复核时逐张看。 */
export function imageMarkdown(urls) {
  return (urls || []).filter(Boolean).map((u) => '![](' + u + ')').join('\n');
}

/** 把图片 markdown 追加到正文末尾（正文为空时只留图片）。 */
export function contentWithImages(content, urls) {
  const body = String(content === undefined || content === null ? '' : content).replace(/\s+$/, '');
  const markdown = imageMarkdown(urls);
  if (!markdown) return body;
  return body ? body + '\n\n' + markdown : markdown;
}

/** 草稿里的人类可读图片清单。 */
export function summarizeImages(images) {
  const list = Array.isArray(images) ? images : [];
  return list.map((img, i) => (i + 1) + '. ' + (img.name || path.basename(String(img.path || ''))) + '（' + formatBytes(img.bytes) + '，sha256 ' + String(img.sha256 || '').slice(0, 12) + '...）');
}

/** 发布前校验：文件还在、内容没被换过（sha256 一致）。返回可直接上传的描述数组。 */
export function verifyDraftImages(images) {
  const list = Array.isArray(images) ? images : [];
  return list.map((img) => {
    const file = path.resolve(String(img && img.path ? img.path : ''));
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new ImageError('草稿里的图片不见了：' + file, {
        code: 'E_IMAGE_MISSING',
        path: file,
        hint: '批准时草稿里记录的是本机路径；文件被移动或删除后无法发布。把图放回原路径，或删除草稿重来。',
      });
    }
    const sha = sha256File(file);
    if (img.sha256 && sha !== img.sha256) {
      throw new ImageError('草稿里的图片在批准后被修改过：' + file, {
        code: 'E_IMAGE_CHANGED',
        path: file,
        hint: '内容指纹对不上，发布会把未经批准的内容发出去。请重新建草稿并重新批准。',
      });
    }
    return {
      path: file,
      name: img.name || path.basename(file),
      mime: img.mime || IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      bytes: stat.size,
      sha256: sha,
      url: img.url || null,
    };
  });
}
