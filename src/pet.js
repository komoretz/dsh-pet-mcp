// 与 dsh-pet 通信的全部实现：HTTP 客户端 + 名字匹配。
//
// dsh-pet 是 DeepSeek Harness 的桌宠插件（https://github.com/PC2005-cloud/dsh-pet）。
// 它在 DSH 的 web server 上注册了一组给第三方用的只读/动作端点（源码见其
// src/host/index.ts 的 handlePetRoute）：
//
//   GET  /dsh-pet-7340/state                当前状态（每只宠物的「刚说的话」「刚播的动画」）
//   GET  /dsh-pet-7340/config               成品配置（宠物列表、动画池、表情包表）
//   POST /dsh-pet-7340/broadcast?pet=<id>   {text, image?}  把外部文本写进气泡
//   POST /dsh-pet-7340/anim?pet=<id>        {name}          点播一个动画
//
// 本模块只做「拼请求 + 解析」和纯函数的名字匹配，不做任何本地读写。

/** DSH 的 web 服务地址。默认值来自 DSH Desktop 的常见监听端口，可用环境变量覆盖。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:43129';

/** 单次请求超时：桌宠是本地服务，8 秒还没回就说明它没在跑（而不是慢）。 */
const REQUEST_TIMEOUT_MS = 8000;

/** 气泡文本上限。dsh-pet 本身不限长，但一段几十字的气泡会糊住整只宠物。 */
export const MAX_SAY_CHARS = 200;

/** 路由前缀，来自 dsh-pet 的常量 ROUTE_PREFIX。 */
export const ROUTE_PREFIX = '/dsh-pet-7340';

export function resolveConfig(env = process.env) {
  const baseUrl = String(env.DSH_PET_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const petId = String(env.DSH_PET_ID || '').trim();
  return { baseUrl, petId };
}

/**
 * 发一次请求并解析 JSON。
 * 非 2xx 直接抛错（带状态码与 dsh-pet 的 error 字段），让上层能说出「是没装还是端口不对」。
 */
async function petRequest(config, path, init = {}) {
  const url = `${config.baseUrl}${ROUTE_PREFIX}${path}`;
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  let res;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // 连接被拒 / 超时：最常见的原因是 DSH 没开、端口换了，或者 dsh-pet 没装。
    throw new Error(`连不上 DSH（${config.baseUrl}）：${error?.message ?? error}`);
  }
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(`dsh-pet 返回 HTTP ${res.status}${body?.error ? `：${body.error}` : ''}`);
  }
  return body;
}

export const getState = (config) => petRequest(config, '/state');
export const getConfig = (config) => petRequest(config, '/config');

/** 去掉空白/中英文标点再比较，避免「吃 白饭」「“吃白饭”」这类手滑。 */
export function normName(value) {
  return String(value ?? '')
    .replace(/[\s·、,，.。;；:：!！?？"'“”‘’「」『』()（）]/g, '')
    .toLowerCase();
}

/**
 * 人话 → 真实名字（动画名 / 表情包名都是**文件名**，传错就 404、表现为「点了没反应」）。
 *
 * 三级：全等 → 互相包含（唯一才算命中）→ 字符重合度打分。
 * 阈值分两档是刻意的：>= 0.75 才敢自动播（「泡泡鲸鱼」→「鲸鱼吐泡泡特效」这种字序不同的）；
 * 0.5~0.75 只当候选回给模型（「跳舞」→ 轻快摇摆舞 / 可爱宅舞），一半字对得上很可能是猜错。
 *
 * @returns {{ best: string|null, options: string[] }}
 */
export function matchByName(input, candidates) {
  const q = normName(input);
  const names = (Array.isArray(candidates) ? candidates : []).filter((n) => typeof n === 'string' && n);
  if (!q) return { best: null, options: names.slice(0, 8) };
  const exact = names.find((n) => normName(n) === q);
  if (exact) return { best: exact, options: [] };
  const contains = names.filter((n) => normName(n).includes(q) || q.includes(normName(n)));
  if (contains.length === 1) return { best: contains[0], options: [] };
  if (contains.length > 1) return { best: null, options: contains.slice(0, 8) };
  const chars = new Set(q.split(''));
  const scored = names
    .map((name) => {
      const key = normName(name);
      let common = 0;
      for (const ch of chars) if (key.includes(ch)) common += 1;
      return { name, score: common / Math.max(chars.size, 1) };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { best: scored[0].name, options: [] };
  if (scored.length && scored[0].score >= 0.75) return { best: scored[0].name, options: [] };
  return { best: null, options: scored.slice(0, 8).map((x) => x.name) };
}

/**
 * 找某只宠物所在的配置条目：dsh-pet 的成品配置是 { <配置段>: { pets:[...], animations, memes } }，
 * 动画池与表情包都在**条目层**（同一条目下的多只宠物共用一份），不在单只宠物对象里。
 */
export function petConfigEntry(allConfig, petId) {
  const id = String(petId ?? '');
  for (const value of Object.values(allConfig ?? {})) {
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value.pets) && value.pets.some((p) => String(p?.id ?? '') === id)) return value;
  }
  return null;
}

/** 把配置条目里能点播的动画名摊平（idle / turn / drag / clicks / moves / categories / events）。 */
export function animationNames(entry) {
  const a = entry?.animations ?? {};
  const names = new Set();
  for (const field of ['idle', 'turn', 'drag', 'clicks']) {
    for (const n of a[field] ?? []) names.add(String(n));
  }
  for (const m of a.moves?.actions ?? []) names.add(String(m?.name ?? ''));
  for (const c of a.categories ?? []) for (const n of c?.actions ?? []) names.add(String(n));
  for (const list of Object.values(a.events ?? {})) for (const n of list ?? []) names.add(String(n));
  names.delete('');
  return [...names];
}

/** 表情包表：名字 → 说明（配置里 memes 是 { 名字: 说明 }）。 */
export function memesOf(entry) {
  const memes = entry?.memes;
  if (!memes || typeof memes !== 'object') return [];
  return Object.entries(memes).map(([name, desc]) => ({ name, desc: String(desc ?? '') }));
}

/** 当前在线的宠物 id 列表（来自 /state）。 */
export function petIds(state) {
  return Object.keys(state?.pets ?? {});
}

/** 选宠物：显式指定的优先，没指定就用第一只；指定了不存在就报错。 */
export function pickPet(state, requested, fallback) {
  const ids = petIds(state);
  if (!ids.length) throw new Error('dsh-pet 里现在没有宠物。');
  const wanted = String(requested ?? '').trim() || String(fallback ?? '').trim();
  if (!wanted) return ids[0];
  if (!ids.includes(wanted)) throw new Error(`没有 id=${wanted} 的宠物；现有：${ids.join(' / ')}`);
  return wanted;
}

/** 组装一次「让桌宠说话」。 */
export async function say(config, { text, image, pet }) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('text 不能为空');
  const clipped = clean.length > MAX_SAY_CHARS ? `${clean.slice(0, MAX_SAY_CHARS)}…` : clean;

  const state = await getState(config);
  const petId = pickPet(state, pet, config.petId);
  const entry = petConfigEntry(await getConfig(config), petId);

  let memeName = null;
  if (image) {
    const memes = memesOf(entry).map((m) => m.name);
    const matched = matchByName(image, memes);
    if (!matched.best) {
      const options = matched.options.length ? matched.options : memes.slice(0, 8);
      throw new Error(
        `没找到叫「${image}」的表情包${options.length ? `，现成的有：${options.join(' / ')}` : '（配置里没有表情包）'}；也可以不带 image 直接说。`,
      );
    }
    memeName = matched.best;
  }

  const body = memeName ? { text: clipped, image: memeName } : { text: clipped };
  const result = await petRequest(config, `/broadcast?pet=${encodeURIComponent(petId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!result?.ok) throw new Error(`桌宠没接这句话：${result?.reason ?? '未知原因'}${result?.message ? `（${result.message}）` : ''}`);
  return { pet: petId, text: clipped, image: memeName };
}

/** 组装一次「让桌宠播动画」。 */
export async function playAnimation(config, { name, pet }) {
  const raw = String(name ?? '').trim();
  if (!raw) throw new Error('name 不能为空');

  const state = await getState(config);
  const petId = pickPet(state, pet, config.petId);
  const entry = petConfigEntry(await getConfig(config), petId);
  const names = animationNames(entry);
  if (!names.length) throw new Error('这只宠物没有可点播的动画（配置里 animations 是空的）。');

  const matched = matchByName(raw, names);
  if (!matched.best) {
    const options = matched.options.length ? matched.options : names.slice(0, 12);
    throw new Error(
      `没有叫「${raw}」的动画${options.length ? `，相近/现成的有：${options.join(' / ')}` : ''}（一共 ${names.length} 个）；换个名字再试。`,
    );
  }

  const result = await petRequest(config, `/anim?pet=${encodeURIComponent(petId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: matched.best }),
  });
  if (!result?.ok) throw new Error(`动画没播成：${result?.reason ?? '未知原因'}${result?.message ? `（${result.message}）` : ''}`);
  return { pet: petId, name: matched.best };
}

/** 读状态：宠物列表 + 最后说的话 / 表情包 / 动画。 */
export async function status(config, { pet } = {}) {
  const state = await getState(config);
  const petId = pickPet(state, pet, config.petId);
  const current = state.pets[petId] ?? {};
  return {
    baseUrl: config.baseUrl,
    pets: petIds(state),
    pet: petId,
    lastText: current?.say?.data?.text ?? null,
    lastImage: current?.say?.data?.image ?? null,
    lastAnimation: current?.anim?.data?.name ?? null,
  };
}

/** 列动画/表情包（给模型「先看有什么再挑」用），query 做子串过滤。 */
export async function catalog(config, { query, pet } = {}) {
  const state = await getState(config);
  const petId = pickPet(state, pet, config.petId);
  const entry = petConfigEntry(await getConfig(config), petId);
  const q = normName(query);
  const animations = animationNames(entry).filter((n) => !q || normName(n).includes(q));
  const memes = memesOf(entry).filter((m) => !q || normName(m.name).includes(q));
  return { pet: petId, totalAnimations: animationNames(entry).length, animations, memes };
}