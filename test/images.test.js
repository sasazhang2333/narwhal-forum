/**
 * 图片评论测试（零后端改动方案：上传拿 URL → markdown 内联）。
 *
 * 三层都测：纯函数（multipart / 内联拼接）、client + mock 论坛、CLI 与 MCP 工具。
 * 重点是草稿带图的「批准 A 发布 B」防护：图片改了 sha256 就必须在发布前失败，且 token 不浪费。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockForum, ACCESS_TOKEN } from './mock-forum.js';
import { ForumClient } from '../src/client.js';
import { approveDraft, readDraft, listDrafts } from '../src/draft.js';
import { TOOL_MAP } from '../src/mcp/tools.js';
import {
  describeImage,
  resolveImageList,
  buildMultipart,
  contentWithImages,
  imageMarkdown,
  pickUploadedUrl,
  absoluteImageUrl,
  verifyDraftImages,
  ImageError,
  MAX_IMAGES,
} from '../src/images.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'narwhal-forum.js');

/** 最小合法 PNG 头（内容只要能算 sha256 就行，mock 不校验图片本身）。 */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('narwhal-forum-image-fixture-'.repeat(4)),
]);

let mock;
let home;
let work;

test.before(async () => {
  mock = await startMockForum();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-img-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'narwhal-forum-imgfiles-'));
  process.env.NARWHAL_FORUM_HOME = home;
});

test.after(async () => {
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test.beforeEach(() => {
  mock.reset();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NARWHAL_FORUM_') && key !== 'NARWHAL_FORUM_HOME') delete process.env[key];
  }
});

function png(name = 'shot.png') {
  const file = path.join(work, name);
  fs.writeFileSync(file, PNG_BYTES);
  return file;
}

function authed() {
  return new ForumClient({ baseUrl: mock.baseUrl, persist: false, token: ACCESS_TOKEN });
}

function run(args, extraEnv = {}) {
  const env = { ...process.env, NARWHAL_FORUM_HOME: home, NARWHAL_FORUM_BASE_URL: mock.baseUrl };
  delete env.NARWHAL_FORUM_TOKEN;
  delete env.NARWHAL_FORUM_REFRESH_TOKEN;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout, stderr });
    });
  });
}

test('describeImage 校验扩展名 / 大小 / 存在性', () => {
  const file = png();
  const info = describeImage(file);
  assert.equal(info.name, 'shot.png');
  assert.equal(info.mime, 'image/png');
  assert.equal(info.bytes, PNG_BYTES.length);
  assert.equal(info.sha256.length, 64);

  const bad = path.join(work, 'note.txt');
  fs.writeFileSync(bad, 'hi');
  assert.throws(() => describeImage(bad), (err) => err instanceof ImageError && err.code === 'E_IMAGE_TYPE');
  assert.throws(() => describeImage(path.join(work, 'nope.png')), (err) => err.code === 'E_IMAGE_NOT_FOUND');
  const empty = path.join(work, 'empty.png');
  fs.writeFileSync(empty, '');
  assert.throws(() => describeImage(empty), (err) => err.code === 'E_IMAGE_EMPTY');
});

test('buildMultipart 拼出标准 multipart（字段名 file）', () => {
  const info = describeImage(png('a.png'));
  const { body, boundary } = buildMultipart(info);
  const text = body.toString('latin1');
  assert.ok(text.startsWith('--' + boundary));
  assert.match(text, /Content-Disposition: form-data; name="file"; filename="a\.png"/);
  assert.match(text, /Content-Type: image\/png/);
  assert.ok(text.endsWith('--' + boundary + '--\r\n'));
  assert.ok(body.includes(PNG_BYTES), '原始字节必须原样嵌入');
});

test('contentWithImages 把图片追加到正文末尾（正文可空）', () => {
  assert.equal(contentWithImages('正文', ['https://x/1.png']), '正文\n\n![](https://x/1.png)');
  assert.equal(contentWithImages('正文', []), '正文');
  assert.equal(contentWithImages('', ['https://x/1.png']), '![](https://x/1.png)');
  assert.equal(imageMarkdown(['a', 'b']), '![](a)\n![](b)');
});

test('pickUploadedUrl 兼容 url / webpUrl / result.url', () => {
  assert.equal(pickUploadedUrl({ url: '/u/a.png' }), '/u/a.png');
  assert.equal(pickUploadedUrl({ webpUrl: '/u/b.webp' }), '/u/b.webp');
  assert.equal(pickUploadedUrl({ result: { url: '/u/c.png' } }), '/u/c.png');
  assert.equal(pickUploadedUrl({}), '');
  assert.equal(absoluteImageUrl("https://forum.example.test", "/u/c.png"), "https://forum.example.test/u/c.png");
  assert.equal(absoluteImageUrl("https://forum.example.test", "https://cdn.example.test/x.png"), "https://cdn.example.test/x.png");
});

test('resolveImageList 支持多值、逗号分隔与上限', () => {
  const a = png('m1.png');
  const b = png('m2.png');
  assert.equal(resolveImageList([a, b]).length, 2);
  assert.equal(resolveImageList(a + ',' + b).length, 2);
  assert.equal(resolveImageList([]).length, 0);
  const many = [];
  for (let i = 0; i < MAX_IMAGES + 1; i += 1) many.push(png('many-' + i + '.png'));
  assert.throws(() => resolveImageList(many), (err) => err.code === 'E_IMAGE_TOO_MANY');
});

test('client.uploadImage 打真实 multipart 到 mock，返回绝对 URL', async () => {
  const client = authed();
  const r = await client.uploadImage({ path: png('up.png'), scene: 'chat' });
  assert.ok(r.url.startsWith(mock.baseUrl), 'URL 应补成绝对地址: ' + r.url);
  assert.match(r.url, /up\.png$/);
  assert.equal(r.bytes, PNG_BYTES.length);
  assert.equal(mock.state.uploads.length, 1);
  assert.equal(mock.state.uploads[0].filename, 'up.png');
  assert.equal(mock.state.uploads[0].contentType, 'image/png');
  assert.equal(mock.state.uploads[0].scene, 'chat');
});

test('client.uploadImages 按顺序上传多张', async () => {
  const client = authed();
  const urls = await client.uploadImages([png('s1.png'), png('s2.png')]);
  assert.equal(urls.length, 2);
  assert.deepEqual(mock.state.uploads.map((u) => u.filename), ['s1.png', 's2.png']);
});

test('createComment 带 images：先上传再内联 markdown', async () => {
  const client = authed();
  const r = await client.createComment({ postId: 1, content: '看图说话', images: [png('c.png')] });
  assert.ok(r.id, '应返回评论 id');
  const stored = mock.state.comments.find((c) => c.id === r.id);
  assert.equal(stored.content, '看图说话\n\n![](' + mock.baseUrl + mock.state.uploads[0].url + ')');
  assert.equal(mock.state.uploads.length, 1);
});

test('createComment 未登录带图：先被鉴权挡住', async () => {
  const anon = new ForumClient({ baseUrl: mock.baseUrl, persist: false });
  await assert.rejects(() => anon.createComment({ postId: 1, content: 'x', images: [png('anon.png')] }), /登录/);
});

test('CLI upload-image 输出 URL（--json 可程序消费）', async () => {
  const file = png('cli.png');
  const r = await run(['upload-image', file, '--token', ACCESS_TOKEN, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.ok(data.url.startsWith(mock.baseUrl));
  assert.equal(data.name, 'cli.png');
});

test('CLI upload-image 遇到非图片退出码 2', async () => {
  const bad = path.join(work, 'cli.txt');
  fs.writeFileSync(bad, 'x');
  const r = await run(['upload-image', bad, '--token', ACCESS_TOKEN]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不支持的图片格式/);
});

test('CLI new-comment --image 内联图片并可见', async () => {
  const r = await run(['new-comment', '1', '--content', 'CLI 带图', '--image', png('cli-c.png'), '--token', ACCESS_TOKEN]);
  assert.equal(r.code, 0, r.stderr);
  const list = await run(['comments', '1']);
  assert.match(list.stdout, /CLI 带图/);
  assert.match(list.stdout, /!\[\]\(http[^)]*cli-c\.png\)/);
});

test('草稿带图：批准后图片被改必须发布前失败，且 token 未消费', async () => {
  const file = png('draft.png');
  const created = await run(['draft', 'new-comment', '1', '--content', '带图草稿', '--image', file, '--token', ACCESS_TOKEN, '--json']);
  assert.equal(created.code, 0, created.stderr);
  const record = JSON.parse(created.stdout);
  assert.equal(record.payload.images.length, 1);
  assert.equal(record.payload.images[0].sha256.length, 64);

  const shown = await run(['draft', 'show', record.id]);
  assert.match(shown.stdout, /图片/);
  assert.equal(run.length >= 0, true);

  // 未批准就发布：拒绝
  const tooEarly = await run(['draft', 'publish', record.id, '--token', 'nfap_bogus.0.0.0.x.0.0', '--token', ACCESS_TOKEN]);
  assert.equal(tooEarly.code, 2, tooEarly.stderr);

  // 人审批准（真终端里的那一步由 approveDraft 代跑）
  const { token } = approveDraft(record.id, { reviewer: 'test-human' });
  assert.match(token, /^nfap_/);

  // 批准之后把图片换掉 → sha256 不一致，必须在发布前拦住
  fs.writeFileSync(file, Buffer.concat([PNG_BYTES, Buffer.from('tampered')]));
  const tampered = await run(['draft', 'publish', record.id, '--token', token], { NARWHAL_FORUM_TOKEN: ACCESS_TOKEN });
  assert.equal(tampered.code, 2, tampered.stdout + tampered.stderr);
  assert.match(tampered.stderr, /图片|sha256|改/);
  assert.equal(listDrafts({ status: 'approved' }).length, 1, 'token 未消费，草稿仍是 approved');
  assert.equal(mock.state.uploads.length, 0, '校验失败时不应有任何上传');

  // 恢复原图后发布成功
  fs.writeFileSync(file, PNG_BYTES);
  const ok = await run(['draft', 'publish', record.id, '--token', token], { NARWHAL_FORUM_TOKEN: ACCESS_TOKEN });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /已发布/);
  assert.equal(mock.state.uploads.length, 1);
  const stored = mock.state.comments.find((c) => String(c.content).includes('带图草稿'));
  assert.ok(stored, '评论应已落库');
  assert.match(stored.content, /!\[\]\(http[^)]*draft\.png\)/);
  assert.equal(readDraft(record.id).status, 'published');
});

test('MCP 工具层：upload_image 与 create_comment(images) 直接可用', async () => {
  const client = authed();
  const up = TOOL_MAP.get('upload_image');
  const out = await up.handler({ client }, { path: png('mcp.png') });
  assert.ok(out.data.url.startsWith(mock.baseUrl));

  const cc = TOOL_MAP.get('create_comment');
  const r = await cc.handler({ client }, { postId: 1, content: 'MCP 带图', images: [png('mcp2.png')] });
  assert.ok(r.data.id);
  const stored = mock.state.comments.find((c) => c.id === r.data.id);
  assert.match(stored.content, /!\[\]\(http[^)]*mcp2\.png\)/);

  // 工具声明里必须有 images 参数，否则 dsh / Claude Code 看不到这个能力
  const props = cc.inputSchema.properties;
  assert.equal(props.images.type, 'array');
  assert.equal(props.images.maxItems, MAX_IMAGES);
});

test('verifyDraftImages 对缺文件给 E_IMAGE_MISSING', () => {
  const file = png('gone.png');
  const images = resolveImageList([file]);
  fs.rmSync(file);
  assert.throws(() => verifyDraftImages(images), (err) => err.code === 'E_IMAGE_MISSING');
});
