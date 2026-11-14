#!/usr/bin/env node
// 纯函数测试：名字匹配与配置解析。不联网、不读盘。
import assert from 'node:assert/strict';
import {
  animationNames,
  matchByName,
  memesOf,
  normName,
  petConfigEntry,
  petIds,
  pickPet,
  resolveConfig,
  MAX_SAY_CHARS,
} from '../src/pet.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

// 与真实 dsh-pet 配置同形状的样本（截取 /dsh-pet-7340/config 的一段）
const entry = {
  pets: [{ id: 'main', name: '示例宠物' }],
  animations: {
    idle: ['待机呼吸休闲'],
    turn: ['东张西望'],
    drag: ['被鼠标拖拽悬空反馈'],
    clicks: ['点击回应-开心跃动', '点击回应-傲娇生气'],
    moves: { actions: [{ name: '螃蟹走路' }, { name: '原地左转奔跑' }] },
    categories: [
      { id: '吃什么', actions: ['吃白饭', '大口吃零食', '吃西瓜'] },
      { id: '玩耍', actions: ['鲸鱼吐泡泡特效', '轻快摇摆舞', '可爱宅舞'] },
    ],
    events: { balance: ['余额-钱袋满溢'], whisper: ['碎碎念-擦桌碎碎念'] },
  },
  memes: {
    吃白饭的鱼: '躺平扒白饭，适合被吐槽偷懒',
    大的要来啦: '举喇叭大喊预警',
  },
};

check('normName 去空白与中英文标点', () => {
  assert.equal(normName(' 吃 白饭 '), '吃白饭');
  assert.equal(normName('“鲸鱼吐泡泡特效”'), '鲸鱼吐泡泡特效');
});

check('全等优先命中', () => {
  assert.equal(matchByName('吃白饭', ['吃白饭', '吃西瓜']).best, '吃白饭');
});

check('唯一包含关系命中（少写几个字）', () => {
  assert.equal(matchByName('吐泡泡', ['鲸鱼吐泡泡特效', '吃白饭']).best, '鲸鱼吐泡泡特效');
});

check('包含关系不唯一 ⇒ 回候选，不瞎猜', () => {
  const r = matchByName('吃', ['吃白饭', '吃西瓜']);
  assert.equal(r.best, null);
  assert.deepEqual(r.options.sort(), ['吃白饭', '吃西瓜'].sort());
});

check('只对上一半字 ⇒ 只当候选，不自动播', () => {
  const r = matchByName('跳舞', ['轻快摇摆舞', '可爱宅舞', '吃白饭']);
  assert.equal(r.best, null);
  assert.ok(r.options.includes('轻快摇摆舞'));
});

check('字序不同但字重合 ⇒ 自动命中', () => {
  assert.equal(matchByName('泡泡鲸鱼', ['鲸鱼吐泡泡特效']).best, '鲸鱼吐泡泡特效');
});

check('完全不相关 ⇒ 空结果，不硬凑', () => {
  const r = matchByName('开飞机', ['吃白饭', '东张西望']);
  assert.equal(r.best, null);
  assert.deepEqual(r.options, []);
});

check('空输入 / 非数组候选不崩', () => {
  assert.equal(matchByName('', ['a']).best, null);
  assert.equal(matchByName(null, null).best, null);
});

check('animationNames 覆盖 idle/turn/drag/clicks/moves/categories/events 且去空去重', () => {
  const names = animationNames(entry);
  for (const expected of [
    '待机呼吸休闲', '东张西望', '被鼠标拖拽悬空反馈', '点击回应-开心跃动',
    '螃蟹走路', '吃白饭', '鲸鱼吐泡泡特效', '余额-钱袋满溢', '碎碎念-擦桌碎碎念',
  ]) {
    assert.ok(names.includes(expected), `缺 ${expected}`);
  }
  assert.ok(!names.includes(''));
  assert.equal(new Set(names).size, names.length);
});

check('memesOf 把 {名字:说明} 摊成数组', () => {
  const memes = memesOf(entry);
  assert.equal(memes.length, 2);
  assert.equal(memes[0].name, '吃白饭的鱼');
  assert.ok(memes[0].desc.includes('偷懒'));
  assert.deepEqual(memesOf(null), []);
});

check('petConfigEntry 按宠物 id 找条目', () => {
  assert.equal(petConfigEntry({ main: entry }, 'main'), entry);
  assert.equal(petConfigEntry({ main: entry }, 'nope'), null);
  assert.equal(petConfigEntry(null, 'main'), null);
});

check('pickPet：默认第一只 / 指定 / 不存在报错', () => {
  const state = { pets: { main: {}, second: {} } };
  assert.deepEqual(petIds(state), ['main', 'second']);
  assert.equal(pickPet(state, '', ''), 'main');
  assert.equal(pickPet(state, 'second', ''), 'second');
  assert.equal(pickPet(state, '', 'second'), 'second');
  assert.throws(() => pickPet(state, 'ghost', ''), /没有 id=ghost 的宠物/);
  assert.throws(() => pickPet({ pets: {} }, '', ''), /没有宠物/);
});

check('resolveConfig：默认值 / 环境变量 / 去尾斜杠', () => {
  assert.equal(resolveConfig({}).baseUrl, 'http://127.0.0.1:43129');
  const c = resolveConfig({ DSH_PET_BASE_URL: 'http://127.0.0.1:5000/', DSH_PET_ID: ' second ' });
  assert.equal(c.baseUrl, 'http://127.0.0.1:5000');
  assert.equal(c.petId, 'second');
});

check('MAX_SAY_CHARS 是个合理的正数（气泡不该无限长）', () => {
  assert.ok(Number.isInteger(MAX_SAY_CHARS) && MAX_SAY_CHARS > 0 && MAX_SAY_CHARS <= 500);
});

console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`);