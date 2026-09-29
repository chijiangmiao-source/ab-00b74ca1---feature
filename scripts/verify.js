#!/usr/bin/env node
'use strict';

// Compose verify 服务入口：
//   1) 构建检查：全部源码/脚本语法检查（node --check）
//   2) 代码测试：node --test
//   3) 接口 / HTTP 冒烟：健康路径、页面、审计接口
//      - 静默环等价规程：审计必须判定等价，关系含两个初始状态对
//      - 缺失匹配动作规程：审计必须判定不等价，且失败依据只引用更早轮次
//      - 无效输入：一次返回全部问题并清除旧结论
//      - 静默分叉规程：普通弱互模拟判等价、分支保持复核判不等价，
//        可展开首个淘汰状态对、挑战动作、静默前缀候选及其同轮关系违约
// 完成后退出：全部通过 0，任一失败 1。

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { samples } = require('../src/samples');

const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:8080';
const ROOT = path.join(__dirname, '..');

let failures = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
async function astep(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listJs(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

// ---------- 1) 构建检查 ----------
console.log('[1/3] 构建检查（node --check）');
for (const file of [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts')), ...listJs(path.join(ROOT, 'test'))]) {
  step(`语法检查 ${path.relative(ROOT, file)}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || 'node --check 失败');
  });
}

// ---------- 2) 代码测试 ----------
console.log('[2/3] 代码测试（node --test）');
step('node --test 全部通过', () => {
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stdout || '').split('\n').slice(-25).join('\n');
    throw new Error(`测试失败（退出码 ${r.status}）:\n${tail}`);
  }
});

// ---------- 3) 接口 / HTTP 冒烟 ----------
console.log(`[3/3] 接口 / HTTP 冒烟（${BASE}）`);

async function waitReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastErr && lastErr.message}`);
}

async function postAudit(body, mode) {
  const suffix = mode === 'branching' ? '?mode=branching' : '';
  const res = await fetch(`${BASE}/api/audit${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `审计接口 HTTP 状态应为 200，实际 ${res.status}`);
  return res.json();
}

(async () => {
  await astep('服务健康检查就绪 GET /healthz', async () => {
    await waitReady(BASE);
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'ok');
  });

  await astep('页面 GET / 返回 HTML 且含分支保持复核入口', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('弱互模拟审计'));
    assert.ok(html.includes('分支保持复核'));
  });

  await astep('示例接口 GET /api/samples 包含等价、缺失与静默分叉规程', async () => {
    const res = await fetch(`${BASE}/api/samples`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.equivalent && j.missing && j.branching);
  });

  await astep('静默环等价规程：判定等价且关系含两个初始状态对', async () => {
    const j = await postAudit(samples.equivalent);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, true, JSON.stringify(j.eliminatedPairs));
    assert.equal(j.initialPairs.length, 2);
    assert.deepEqual(j.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
    assert.ok(j.initialAlive.every(Boolean));
  });

  await astep('缺失匹配动作规程：判定不等价，首个失败动作为 x', async () => {
    const j = await postAudit(samples.missing);
    assert.equal(j.equivalent, false);
    assert.ok(j.firstEliminated, '应给出首个淘汰状态对');
    assert.equal(j.firstEliminated.action, 'x');
    assert.ok(j.firstEliminated.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
    assert.equal(j.initialAlive[0], false);
  });

  await astep('多轮级联规程：失败义务只引用更早轮次淘汰结果且按轮次递减', async () => {
    const j = await postAudit(samples.cascade);
    assert.equal(j.equivalent, false);
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
          for (const w of t.responses) {
            assert.ok(Number.isInteger(w.eliminatedRound) && w.eliminatedRound < ep.round);
          }
          const rounds = t.responses.map((w) => w.eliminatedRound);
          assert.deepEqual(rounds, [...rounds].sort((a, b) => b - a), '依据应按轮次递减');
        }
      }
    }
  });

  await astep('无效输入：一次返回全部问题并清除旧结论', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [{ id: 't1', from: 's', action: '', to: 'x' }] },
      procB: { states: [], initial: '', transitions: [] },
    };
    const j = await postAudit(bad);
    assert.equal(j.ok, false);
    assert.equal(j.equivalent, null);
    assert.ok(j.errors.length >= 4, () => `应一次报告所有问题，实际 ${j.errors.length}`);
    assert.deepEqual(j.rounds, []);
    assert.deepEqual(j.eliminatedPairs, []);
    assert.equal(j.firstEliminated, null);
  });

  await astep('非 JSON 请求体返回 400', async () => {
    const res = await fetch(`${BASE}/api/audit`, { method: 'POST', body: 'not-json' });
    assert.equal(res.status, 400);
  });

  await astep('静默分叉：普通弱互模拟判等价（原有接口结构不变）', async () => {
    const j = await postAudit(samples.branching);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, true, JSON.stringify(j.eliminatedPairs));
    assert.equal(j.mode, undefined, '普通模式响应不得出现 mode 等分支字段');
    assert.equal(j.weak, undefined);
    assert.deepEqual(j.initialPairs, [['a0', 'b0'], ['b0', 'a0']]);
    assert.ok(j.initialAlive.every(Boolean));
    assert.ok(j.finalRelation.some((p) => p[0] === 'a0' && p[1] === 'b0'));
  });

  await astep('静默分叉：分支保持复核判不等价并与普通结论并列返回', async () => {
    const j = await postAudit(samples.branching, 'branching');
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'branching');
    assert.equal(j.equivalent, false);
    assert.ok(j.weak && j.weak.ok, '必须并列返回普通弱互模拟结论');
    assert.equal(j.weak.equivalent, true, '同一输入普通弱互模拟应判等价');
    assert.equal(j.weak.mode, undefined);
    assert.equal(j.initialAlive[0], false);
    assert.ok(j.weak.initialAlive[0] === true);

    // 首个淘汰状态对、挑战动作
    const f = j.firstEliminated;
    assert.ok(f, '应给出首个淘汰状态对');
    // 初始对 (a0,b0) 第 2 轮因 B 的直接 a 挑战失败
    const init = j.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
    assert.equal(init.round, 2);
    assert.equal(init.action, 'a');
    assert.equal(init.challenger, 'B');

    const fail = init.transitions.find((t) => t.source === 'bz');
    assert.equal(fail.reason, 'NO_VALID_PREFIX');
    assert.ok(Array.isArray(fail.candidates) && fail.candidates.length >= 1);

    // 静默前缀候选及其同轮关系违约
    const cand = fail.candidates[0];
    assert.deepEqual(cand.prefix, ['a0', 'aa']);
    assert.equal(cand.action, 'a');
    assert.equal(cand.target, 'az');
    assert.equal(cand.ok, false);
    const v0 = cand.violations[0];
    assert.equal(v0.kind, 'PREFIX_PAIR');
    assert.equal(v0.state, 'aa');
    assert.deepEqual(v0.pair, ['b0', 'aa']);
    assert.equal(v0.eliminatedRound, 1);

    // 候选按状态、动作与候选稳定排序：前缀序列字典序 + 落点序
    const key = (c) => `${c.target} ${c.prefix.length} ${c.prefix.join('/')}`;
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (!t.candidates) continue;
        const keys = t.candidates.map(key);
        assert.deepEqual(keys, [...keys].sort(), '静默前缀候选应稳定排序');
        // 同轮关系违约只引用更早轮次淘汰结果
        for (const c of t.candidates) for (const v of c.violations) {
          assert.ok(Number.isInteger(v.eliminatedRound) && v.eliminatedRound < ep.round);
        }
      }
    }
  });

  await astep('分支保持模式：无效输入一次返回全部问题且两种模式结论均为空', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [{ id: 't1', from: 's', action: '', to: 'x' }] },
      procB: { states: [], initial: '', transitions: [] },
    };
    const j = await postAudit(bad, 'branching');
    assert.equal(j.ok, false);
    assert.equal(j.mode, 'branching');
    assert.equal(j.equivalent, null);
    assert.ok(j.errors.length >= 4);
    assert.deepEqual(j.rounds, []);
    assert.equal(j.firstEliminated, null);
    assert.ok(j.weak && j.weak.equivalent === null && j.weak.rounds.length === 0);
  });

  console.log(failures === 0 ? '\nVERIFY RESULT: PASS' : `\nVERIFY RESULT: FAIL（${failures} 项）`);
  process.exit(failures === 0 ? 0 : 1);
})();
