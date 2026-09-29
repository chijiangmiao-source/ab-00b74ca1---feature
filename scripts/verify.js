#!/usr/bin/env node
'use strict';

// Compose verify 服务入口：
//   1) 构建检查：全部源码/脚本语法检查（node --check）
//   2) 代码测试：node --test
//   3) 接口 / HTTP 冒烟：健康路径、页面、审计接口
//      - 静默环等价规程：审计必须判定等价，关系含两个初始状态对
//      - 缺失匹配动作规程：审计必须判定不等价，且失败依据只引用更早轮次
//      - 静默分叉规程：普通模式判等价；分支保持复核判不等价，
//        初始对的静默前缀候选引用更早轮次淘汰对并可标出同轮违约
//      - 普通审计接口（不带 mode）响应与结论不随分支保持功能改变
//      - 无效输入：一次返回全部问题并清除旧结论
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

async function postAudit(body) {
  const res = await fetch(`${BASE}/api/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `审计接口 HTTP 状态应为 200，实际 ${res.status}`);
  return res.json();
}

function assertBranchingEvidence(j) {
  // 证据不变量：被拒候选至少含一个严格更早轮次淘汰锚点；候选稳定排序
  for (const ep of j.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (t.reason !== 'ALL_CANDIDATES_REJECTED') continue;
      assert.ok(Array.isArray(t.candidates) && t.candidates.length > 0, '被拒边须列出静默前缀候选');
      for (const c of t.candidates) {
        const nodes = [c.landing, ...(c.prefixPairs || [])];
        assert.ok(
          nodes.some((n) => n.status === 'eliminated' && n.eliminatedRound < ep.round),
          `候选必须引用严格更早轮次淘汰对：${JSON.stringify(c)} in round ${ep.round}`,
        );
        const prefixInRelation = nodes.filter((n) => n.status === 'same-round');
        // same-round 节点不携带 eliminatedRound
        for (const n of prefixInRelation) assert.ok(!('eliminatedRound' in n));
      }
    }
  }
}

(async () => {
  await astep('服务健康检查就绪 GET /healthz', async () => {
    await waitReady(BASE);
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'ok');
  });

  await astep('页面 GET / 返回 HTML', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('弱互模拟审计'));
  });

  await astep('示例接口 GET /api/samples 包含等价与缺失规程', async () => {
    const res = await fetch(`${BASE}/api/samples`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.equivalent && j.missing);
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

  await astep('静默分叉规程：普通弱互模拟判等价，且普通响应不含 mode 字段', async () => {
    const j = await postAudit(samples.branching);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, true, JSON.stringify(j.eliminatedPairs));
    assert.equal('mode' in j, false, '普通审计接口结构不得改变');
    assert.ok(j.initialAlive.every(Boolean));
    // 未知 mode 取值回退到普通弱互模拟
    const j2 = await postAudit({ ...samples.branching, mode: 'unknown' });
    assert.equal(j2.equivalent, true);
    assert.equal('mode' in j2, false);
  });

  await astep('静默分叉规程：分支保持复核判不等价（弱等价 / 分支保持不等价的 HTTP 场景）', async () => {
    const j = await postAudit({ ...samples.branching, mode: 'branching' });
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'branching');
    assert.equal(j.equivalent, false, '该静默分叉应被分支保持复核拒绝');
    assert.equal(j.initialAlive[0], false);
    assert.deepEqual(j.initialPairs, [['s0', 'q0'], ['q0', 's0']]);

    // 初始对 (s0,q0) 第 2 轮淘汰，首个失败动作为 a（A 方挑战）
    const init = j.eliminatedPairs.find((p) => p.pair[0] === 's0' && p.pair[1] === 'q0');
    assert.ok(init, '初始对应出现在淘汰列表中');
    assert.equal(init.round, 2);
    assert.equal(init.action, 'a');
    assert.equal(init.challenger, 'A');

    // 首个淘汰状态对为 (s0,q1)（q1 在静默后不能 c）
    assert.deepEqual(j.firstEliminated.pair, ['s0', 'q1']);
    assert.equal(j.firstEliminated.round, 1);
    assert.equal(j.firstEliminated.action, 'c');

    // 初始对失败边 s0 -a-> s2 的静默前缀候选：经 q1 承接
    const edge = init.transitions.find((t) => t.source === 's0' && t.target === 's2');
    assert.equal(edge.reason, 'ALL_CANDIDATES_REJECTED');
    assert.ok(edge.candidates.length >= 1);
    const c = edge.candidates[0];
    assert.deepEqual(c.prefix, ['q1']);
    assert.equal(c.target, 'q2');
    // 前缀状态对 (s0,q1) 第 1 轮淘汰——静默步骤悄然丢失了 q1 不能 c 的另一侧承诺
    const pp = c.prefixPairs.find((p) => p.state === 'q1');
    assert.ok(pp);
    assert.deepEqual(pp.pair, ['s0', 'q1']);
    assert.equal(pp.status, 'eliminated');
    assert.equal(pp.eliminatedRound, 1);
    // 落点对仍存活：弱模式不关心前缀，分支模式因前缀违约而拒绝——两种模式差异点
    assert.equal(c.landing.status, 'alive');

    assertBranchingEvidence(j);
  });

  await astep('分支保持证据可标注“本轮同批淘汰”的同轮关系违约节点', async () => {
    const procA = {
      states: [{ name: 's0' }, { name: 's1' }],
      initial: 's0',
      transitions: [
        { id: 'st0', from: 's1', action: 'tau', to: 's0' },
        { id: 'st1', from: 's0', action: 'b', to: 's1' },
        { id: 'st2', from: 's1', action: 'a', to: 's1' },
      ],
    };
    const procB = {
      states: [{ name: 'q0' }, { name: 'q1' }, { name: 'q2' }, { name: 'q3' }],
      initial: 'q0',
      transitions: [
        { id: 'qt0', from: 'q3', action: 'tau', to: 'q1' },
        { id: 'qt1', from: 'q2', action: 'b', to: 'q1' },
        { id: 'qt2', from: 'q2', action: 'a', to: 'q3' },
        { id: 'qt3', from: 'q2', action: 'tau', to: 'q3' },
        { id: 'qt4', from: 'q3', action: 'tau', to: 'q0' },
        { id: 'qt5', from: 'q2', action: 'b', to: 'q2' },
        { id: 'qt6', from: 'q1', action: 'tau', to: 'q1' },
        { id: 'qt7', from: 'q1', action: 'tau', to: 'q2' },
        { id: 'qt8', from: 'q0', action: 'b', to: 'q2' },
      ],
    };
    const weak = await postAudit({ procA, procB });
    assert.equal(weak.equivalent, true);
    const j = await postAudit({ procA, procB, mode: 'branching' });
    assert.equal(j.equivalent, false);
    let sawSameRound = false;
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        for (const c of (t.candidates || [])) {
          for (const n of [c.landing, ...(c.prefixPairs || [])]) {
            if (n.status === 'same-round') sawSameRound = true;
          }
        }
      }
    }
    assert.ok(sawSameRound, '证据中应出现同轮关系违约节点');
    assertBranchingEvidence(j);
  });

  await astep('分支保持模式下输入无效：一次返回全部问题并清除旧结论', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [{ id: 't1', from: 's', action: '', to: 'x' }] },
      procB: { states: [], initial: '', transitions: [] },
      mode: 'branching',
    };
    const j = await postAudit(bad);
    assert.equal(j.ok, false);
    assert.equal(j.mode, 'branching');
    assert.equal(j.equivalent, null);
    assert.ok(j.errors.length >= 4);
    assert.deepEqual(j.rounds, []);
    assert.deepEqual(j.eliminatedPairs, []);
    assert.equal(j.firstEliminated, null);
  });

  await astep('页面包含分支保持复核入口与静默分叉示例', async () => {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    assert.ok(html.includes('分支保持'));
    assert.ok(html.includes('普通弱互模拟'));
    const samplesRes = await fetch(`${BASE}/api/samples`);
    const all = await samplesRes.json();
    assert.ok(all.branching, '内置示例须含静默分叉案例');
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

  console.log(failures === 0 ? '\nVERIFY RESULT: PASS' : `\nVERIFY RESULT: FAIL（${failures} 项）`);
  process.exit(failures === 0 ? 0 : 1);
})();
