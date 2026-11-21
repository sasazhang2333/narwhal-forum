/**
 * 雪花 ID 回归测试（真实环境实测踩到的坑）。
 *
 * 后端主键是 Snowflake（约 1e17 > 2^53）。工具 schema 一旦声明成 integer，
 * JSON-RPC 那一层先把 id 变成 Number，101589601795420674 → 101589601795420670，
 * 请求照发、后端 404，看起来像「后端有问题」。所以：
 *   ① 所有雪花 ID 入参的 schema 必须是 string；
 *   ② 真传进来一个超出安全范围的数字时，必须抛出人能看懂的错误，而不是静默查错 id。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/mcp/tools.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const SNOWFLAKE = '101589601795420674';

test('所有 snowflake ID 入参声明为 string', () => {
  for (const name of ['get_post', 'list_comments', 'create_comment', 'react_post', 'draft_create']) {
    const props = byName[name].inputSchema.properties;
    assert.equal(props.postId.type, 'string', name + '.postId 必须是 string');
  }
  assert.equal(byName.create_comment.inputSchema.properties.parentId.type, 'string');
  assert.equal(byName.create_comment.inputSchema.properties.replyUserId.type, 'string');
  assert.equal(byName.draft_create.inputSchema.properties.parentId.type, 'string');
});

test('字符串 ID 原样传给后端（不经过 Number）', async () => {
  const seen = [];
  const client = { async react(args) { seen.push(args.postId); return { toggled: 'on' }; } };
  await byName.react_post.handler({ client }, { postId: SNOWFLAKE, emoji: '👍' });
  assert.deepEqual(seen, [SNOWFLAKE]);
});

test('超出安全整数范围的数字 ID 报错，不静默发出去', async () => {
  const client = { async getPost() { throw new Error('不该走到这里'); } };
  await assert.rejects(
    () => byName.get_post.handler({ client }, { postId: 101589601795420674 }),
    /必须是字符串/
  );
});

test('create_comment 在后端不回 id 时，用 my_comments 兜底拿新评论 id', async () => {
  const client = {
    async createComment() { return null; },
    async listMyComments() { return { items: [{ id: '101589690432598529', postId: SNOWFLAKE }] }; },
  };
  const out = await byName.create_comment.handler({ client }, { postId: SNOWFLAKE, content: '兜底测试' });
  assert.equal(out.data.id, '101589690432598529');
  assert.match(out.text, /101589690432598529/);
});
