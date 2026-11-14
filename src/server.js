#!/usr/bin/env node
// dsh-pet-mcp：让任意 MCP 客户端（agent）遥控 dsh-pet 桌宠的零依赖 stdio 服务器。
//
// 为什么零依赖：MCP 的 stdio 传输就是「一行一个 JSON-RPC 消息」，一个工具型服务器
// 不值得为此拉一棵依赖树 —— 不装包就不会有装包失败，也没有供应链噪音，
// 审代码的人几分钟能读完（见 README 的「实现说明」）。
//
// 协议面：initialize / tools/list / tools/call / ping，以及 notifications/initialized。
// 产物只走 stdout（严格一行一个 JSON），日志一律走 stderr —— 混进 stdout 会直接毒死协议。
import process from 'node:process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createQueue, handleMessage } from './rpc.js';
import { DEFAULT_BASE_URL, resolveConfig } from './pet.js';

const PKG = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

const USAGE = `dsh-pet-mcp ${PKG.version}

用法：
  node src/server.js [--base-url <url>] [--pet <id>]

环境变量：
  DSH_PET_BASE_URL   DSH web 服务的地址（默认 ${DEFAULT_BASE_URL}）
  DSH_PET_ID         默认宠物 id（默认取第一只）

说明：这是一个 MCP stdio 服务器，正常由 MCP 客户端（如 DeepSeek Harness）spawn，
不需要手动运行；手动跑只会看到它在等 stdin。
`;

/** 从 argv 里取 --key value / --key=value。 */
function argValue(argv, name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(USAGE);
  process.exit(0);
}

// 命令行优先于环境变量：同一份服务器配置可以被不同客户端指向不同 DSH。
const config = resolveConfig({
  ...process.env,
  ...(argValue(argv, 'base-url') ? { DSH_PET_BASE_URL: argValue(argv, 'base-url') } : {}),
  ...(argValue(argv, 'pet') ? { DSH_PET_ID: argValue(argv, 'pet') } : {}),
});

const enqueue = createQueue();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write(`[dsh-pet-mcp] 丢弃非 JSON 行：${text.slice(0, 120)}\n`);
    return;
  }
  enqueue(() => handleMessage(message, {
    config,
    version: PKG.version,
    send: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
  }));
});

// stdin 关闭 = 客户端走了：把队列冲干净再退出，避免最后一条响应被吞。
rl.on('close', () => {
  enqueue(() => process.exit(0));
});

process.stderr.write(`[dsh-pet-mcp] ready，目标 DSH ${config.baseUrl}\n`);