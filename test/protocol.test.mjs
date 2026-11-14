#!/usr/bin/env node
// 协议 + 接线测试：用一个假的 dsh-pet HTTP 服务，把 JSON-RPC 消息喂给 handleMessage。
//
// 不 spawn 子进程、不联网（只连本机随机端口），因此在任何环境都能跑；
// 它验证的是「协议形状」＋「请求真的打到了正确的端点上」，而不是 dsh-pet 本身的行为。
import assert from 'node:assert/strict';
import http from 'node:http';

import { handleMessage } from '../src/rpc.js';

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      console.error(`  FAIL ${name}\n       ${error.message}`);
      process.exitCode = 1;
    });
}

// ── 假的 dsh-pet ────────────────────────────────────────────────────────────
const STATE = {
  sections: {},
  pets: {
    main: {
      say: { counter: 1, data: { text: '先前的碎碎念', image: null } },
      anim: { counter: 2, data: { name: '待机呼吸休闲' } },
    },
  },
};
const CONFIG = {
  main: {
    pets: [{ id: 'main', name: '示例宠物' }],
    animations: {
      idle: ['待机呼吸休闲'],
      categories: [{ id: '吃什么', actions: ['吃白饭', '吃西瓜'] }, { id: '玩耍', actions: ['轻快摇摆舞', '可爱宅舞'] }],
    },
    memes: { 吃白饭的鱼: '躺平扒白饭', 大的要来啦: '举喇叭大喊预警' },
  },
};

const calls = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    calls.push({ method: req.method, path: url.pathname, query: url.search, body });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/dsh-pet-7340/state') return json(200, STATE);
    if (url.pathname === '/dsh-pet-7340/config') return json(200, CONFIG);
    if (url.pathname === '/dsh-pet-7340/broadcast') {
      return json(200, { ok: true });
    }
    if (url.pathname === '/dsh-pet-7340/anim') {
      const name = JSON.parse(body || '{}').name;
      const valid = new Set(['待机呼吸休闲', '吃白饭', '吃西瓜', '轻快摇摆舞', '可爱宅舞']);
      return json(200, valid.has(name) ? { ok: true } : { ok: false, reason: 'bad-request', message: '名字不存在' });
    }
    return json(404, { error: 'not found' });
  });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const { port } = fake.address();
const config = { baseUrl: `http://127.0.0.1:${port}`, petId: '' };

/** 发一条消息，收集服务器回的所有包。 */
async function send(message) {
  const out = [];
  await handleMessage(message, { config, version: '0.1.0', send: (m) => out.push(m) });
  return out;
}

const call = (name, args) => send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } });
const textOf = (reply) => reply.result?.content?.[0]?.text ?? '';

// ── 协议面 ──────────────────────────────────────────────────────────────────
await check('initialize 回客户端请求的版本 + 工具能力', async () => {
  const [reply] = await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  });
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  assert.equal(reply.result.serverInfo.name, 'dsh-pet-mcp');
  assert.ok(reply.result.capabilities.tools);
});

await check('notifications/initialized 不回包', async () => {
  const out = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out.length, 0);
});

await check('ping 回空对象', async () => {
  const [reply] = await send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(reply.result, {});
});

await check('tools/list 给出 4 个工具且都带 inputSchema', async () => {
  const [reply] = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = reply.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['pet_anim', 'pet_catalog', 'pet_say', 'pet_status']);
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20);
  }
});

await check('未知方法回 -32601', async () => {
  const [reply] = await send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(reply.error.code, -32601);
});

// ── 工具面（打真请求到假服务）──────────────────────────────────────────────
await check('pet_status 读出宠物与最后一次说话', async () => {
  const [reply] = await call('pet_status', {});
  const data = JSON.parse(textOf(reply));
  assert.equal(data.pet, 'main');
  assert.deepEqual(data.pets, ['main']);
  assert.equal(data.lastText, '先前的碎碎念');
  assert.equal(data.lastAnimation, '待机呼吸休闲');
});

await check('pet_say 打到 /broadcast 且带 text', async () => {
  calls.length = 0;
  const [reply] = await call('pet_say', { text: '你好呀' });
  assert.ok(!reply.result.isError, textOf(reply));
  const hit = calls.find((c) => c.path === '/dsh-pet-7340/broadcast');
  assert.equal(hit.method, 'POST');
  assert.equal(JSON.parse(hit.body).text, '你好呀');
  assert.ok(hit.query.includes('pet=main'));
});

await check('pet_say 带表情包：模糊匹配后写入 image', async () => {
  calls.length = 0;
  const [reply] = await call('pet_say', { text: '吃了吗', image: '吃白饭的鱼' });
  assert.ok(!reply.result.isError, textOf(reply));
  const hit = calls.find((c) => c.path === '/dsh-pet-7340/broadcast');
  assert.equal(JSON.parse(hit.body).image, '吃白饭的鱼');
});

await check('pet_say 表情包匹配不上 ⇒ isError 且列出候选', async () => {
  const [reply] = await call('pet_say', { text: 'x', image: '完全不存在' });
  assert.ok(reply.result.isError);
  assert.ok(!/配置里没有表情包/.test(textOf(reply)), '有表情包时不该说「没有表情包」');
});

await check('pet_say 空文本 ⇒ isError', async () => {
  const [reply] = await call('pet_say', { text: '   ' });
  assert.ok(reply.result.isError);
});

await check('pet_anim 精确名字 ⇒ 打到 /anim', async () => {
  calls.length = 0;
  const [reply] = await call('pet_anim', { name: '吃白饭' });
  assert.ok(!reply.result.isError, textOf(reply));
  const hit = calls.find((c) => c.path === '/dsh-pet-7340/anim');
  assert.equal(JSON.parse(hit.body).name, '吃白饭');
});

await check('pet_anim 名字只对一半 ⇒ isError 且回候选（不硬猜）', async () => {
  const [reply] = await call('pet_anim', { name: '跳舞' });
  assert.ok(reply.result.isError);
  assert.ok(/轻快摇摆舞|可爱宅舞/.test(textOf(reply)), textOf(reply));
});

await check('pet_catalog 可按关键词过滤', async () => {
  const [reply] = await call('pet_catalog', { query: '舞' });
  const data = JSON.parse(textOf(reply));
  assert.ok(data.动画.includes('轻快摇摆舞'));
  assert.ok(!data.动画.includes('吃白饭'));
});

await check('未知工具名 ⇒ isError 而不是崩', async () => {
  const [reply] = await call('pet_nope', {});
  assert.ok(reply.result.isError);
});

await check('连不上 DSH ⇒ isError 里说清是连不上', async () => {
  const out = [];
  await handleMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pet_status', arguments: {} } },
    { config: { baseUrl: 'http://127.0.0.1:9', petId: '' }, version: '0.1.0', send: (m) => out.push(m) },
  );
  assert.ok(out[0].result.isError);
  assert.match(textOf(out[0]), /连不上 DSH/);
});

fake.close();
console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`);