// JSON-RPC 处理逻辑（不含 stdio 传输）。
//
// 单独拆出来是为了**可测**：测试可以给它一个假的 send 和一个假配置，
// 直接喂消息、断结果，不需要 spawn 子进程（Windows 沙箱里 spawn 常被拦）。
import { catalog, playAnimation, say, status } from './pet.js';

const PET_HINT = '（桌宠：dsh-pet 插件。它必须已经装在同一个 DSH 实例里且正在运行。）';

export const TOOLS = [
  {
    name: 'pet_say',
    description:
      `让桌宠说一句指定的话（气泡），可选配一张表情包。${PET_HINT} `
      + '返回 ok 表示已经写进气泡，不等于用户看见了。表情包名不用背，写几个字就行，会模糊匹配；'
      + '匹配不到会把候选列出来，挑一个再调。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话，短一点，一句就好（超长会截断）' },
        image: { type: 'string', description: '可选表情包名（模糊匹配配置里的 memes）' },
        pet: { type: 'string', description: '可选宠物 id，省略则用默认那只' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'pet_anim',
    description:
      `让桌宠播一个动画。${PET_HINT} `
      + '动画名是素材文件名，写几个字（如「吃白饭」「跳舞」「吐泡泡」）会自动匹配；'
      + '匹配到多个或匹配不到时会返回候选名单，挑一个再调一次。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '动画名，可只写几个字（模糊匹配）' },
        pet: { type: 'string', description: '可选宠物 id' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'pet_status',
    description:
      `读桌宠当前状态（有哪些宠物、最后说的话、最后的表情包、最后播的动画）。${PET_HINT} `
      + '只读，用来确认上一步有没有生效，或者看清现在有几只宠物。',
    inputSchema: {
      type: 'object',
      properties: { pet: { type: 'string', description: '可选宠物 id' } },
      additionalProperties: false,
    },
  },
  {
    name: 'pet_catalog',
    description:
      `列出桌宠能播的动画和能配的表情包（可按关键词过滤）。${PET_HINT} `
      + '只在不确定有什么、或者 pet_anim 反复匹配不上时用；平时直接写动作名更省事。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选关键词，按名字做子串过滤' },
        pet: { type: 'string', description: '可选宠物 id' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** 文本化：字符串直出，对象走 JSON（模型读结构化内容比读自然语言更稳）。 */
function format(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function callTool(config, name, args = {}) {
  switch (name) {
    case 'pet_say': {
      const r = await say(config, args);
      return ok(`说出来了（${r.pet}）：${r.text}${r.image ? `（配图「${r.image}」）` : ''}`);
    }
    case 'pet_anim': {
      const r = await playAnimation(config, args);
      return ok(`动了（${r.pet}）：${r.name}`);
    }
    case 'pet_status':
      return ok(format(await status(config, args)));
    case 'pet_catalog': {
      const r = await catalog(config, args);
      return ok(format({
        pet: r.pet,
        动画总数: r.totalAnimations,
        动画: r.animations.slice(0, 40),
        表情包: r.memes.slice(0, 20),
        ...(r.animations.length > 40 ? { 说明: '动画只列了前 40 个，用 query 过滤' } : {}),
      }));
    }
    default:
      return fail(`未知工具：${name}`);
  }
}

/**
 * 处理一条 JSON-RPC 消息；通知（无 id）不回包。
 *
 * @param {object} message 已解析的 JSON-RPC 消息
 * @param {{ config: {baseUrl: string, petId: string}, send: (msg: object) => void, version: string }} deps
 */
export async function handleMessage(message, { config, send, version = '0.0.0' }) {
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize': {
        // 回客户端要求的版本；现代 MCP 客户端都在这里做版本协商。
        const protocolVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
        if (isRequest) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'dsh-pet-mcp', version },
            },
          });
        }
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return; // 通知，不回包
      case 'ping':
        if (isRequest) send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        if (isRequest) send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        if (!isRequest) return;
        const name = String(params?.name ?? '');
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          send({ jsonrpc: '2.0', id, result: await callTool(config, name, args) });
        } catch (error) {
          // 业务失败（连不上 DSH、名字没匹配、桌宠拒收）走 isError，而不是协议错误 ——
          // 协议错误只会让客户端认为「服务器坏了」，模型也拿不到可读原因。
          send({ jsonrpc: '2.0', id, result: fail(String(error?.message ?? error)) });
        }
        return;
      }
      default:
        if (isRequest) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
        }
    }
  } catch (error) {
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
}

/** 串行队列：请求必须按到达顺序处理完，否则 initialize 还没回就可能被 tools/call 超车。 */
export function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    tail = tail.then(fn).catch((error) => {
      process.stderr.write(`[dsh-pet-mcp] 处理失败：${error?.stack ?? error}\n`);
    });
    return tail;
  };
}