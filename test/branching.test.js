'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditBranching } = require('../src/bisimulation');
const { samples } = require('../src/samples');

// 对任意分支保持审计结果，校验证据不变量：
//  - 每条被拒挑战边（ALL_CANDIDATES_REJECTED）的每个候选都至少含一个
//    “严格更早轮次淘汰”的锚点节点（同批淘汰节点在 R_{k-1} 中仍存活，
//    单独不足以构成拒绝）；
//  - 标记 alive 的节点确实在最终关系中；
//  - 同轮违约节点与本对同一轮淘汰；eliminated 节点严格更早；
//  - 候选按 idle、静默前缀字典序、落点稳定排序；淘汰对按轮次、状态对排序。
function assertEvidenceInvariants(r) {
  const aliveSet = new Set(r.finalRelation.map((p) => p.join(' ')));
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (t.reason !== 'ALL_CANDIDATES_REJECTED') continue;
      assert.ok(t.candidates.length > 0, '被拒边应列出静默前缀候选');
      let prev = null;
      for (const c of t.candidates) {
        if (prev) assert.ok(cmpCandidatesForTest(prev, c) <= 0, '候选须稳定排序');
        prev = c;
        const nodes = [
          ['landing', c.landing, c.landingPair],
          ...(c.prefixPairs || []).map((pp) => ['prefix', pp, pp.pair]),
        ];
        let hasEarlierAnchor = false;
        for (const [, n, pair] of nodes) {
          if (n.status === 'eliminated') {
            assert.ok(n.eliminatedRound < ep.round, `淘汰依据须来自更早轮次：${JSON.stringify(n)} in ${ep.round}`);
            hasEarlierAnchor = true;
          } else if (n.status === 'same-round') {
            // 同轮关系违约：不引用淘汰轮次字段
            assert.ok(!('eliminatedRound' in n));
          } else if (n.status === 'later-round') {
            // 本轮判定时尚存活、更晚轮次才淘汰：仅信息性，不是违约理由
            assert.ok(n.eliminatedRound > ep.round);
          } else if (n.status === 'alive') {
            assert.ok(aliveSet.has(pair.join(' ')), `标存活的节点应在最终关系中：${pair}`);
          }
        }
        assert.ok(hasEarlierAnchor,
          `候选须含更早轮次淘汰锚点：${ep.pair} R${ep.round} ${JSON.stringify(c)}`);
      }
    }
  }
  const keys = r.eliminatedPairs.map((e) => `${e.round}|${e.pair.join(',')}`);
  assert.deepEqual(keys, [...keys].sort());
}

function cmpCandidatesForTest(a, b) {
  const rank = (c) => (c.kind === 'idle' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const n = Math.min(a.prefix.length, b.prefix.length);
  for (let i = 0; i < n; i += 1) {
    if (a.prefix[i] < b.prefix[i]) return -1;
    if (a.prefix[i] > b.prefix[i]) return 1;
  }
  if (a.prefix.length !== b.prefix.length) return a.prefix.length - b.prefix.length;
  return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
}

test('分支保持示例：普通弱互模拟等价，但分支保持复核不等价', () => {
  const s = samples.branching;
  const w = audit(s.procA, s.procB);
  const b = auditBranching(s.procA, s.procB);

  assert.equal(w.ok, true);
  assert.equal(w.equivalent, true, '普通弱互模拟应判等价');
  assert.equal(b.ok, true);
  assert.equal(b.mode, 'branching');
  assert.equal(b.equivalent, false, '分支保持应判不等价');

  // 初始对 (s0,q0)：普通模式存活，分支保持模式第 2 轮淘汰
  assert.ok(!w.eliminatedPairs.some((p) => p.pair[0] === 's0' && p.pair[1] === 'q0'));
  const init = b.eliminatedPairs.find((p) => p.pair[0] === 's0' && p.pair[1] === 'q0');
  assert.equal(init.round, 2);
  assert.equal(init.action, 'a');
  assert.equal(init.challenger, 'A');

  // 首个淘汰对为 (s0,q1)：q1 已不能 c
  assert.deepEqual(b.firstEliminated.pair, ['s0', 'q1']);
  assert.equal(b.firstEliminated.round, 1);
  assert.equal(b.firstEliminated.action, 'c');

  // 初始对失败边 s0 -a-> s2：唯一静默前缀候选经 q1，
  // 前缀状态对 (s0,q1) 第 1 轮淘汰（静默前缀违约），落点 (s2,q2) 仍存活
  const edge = init.transitions.find((t) => t.source === 's0' && t.target === 's2');
  assert.equal(edge.reason, 'ALL_CANDIDATES_REJECTED');
  assert.equal(edge.candidates.length, 1);
  const c = edge.candidates[0];
  assert.equal(c.kind, 'path');
  assert.deepEqual(c.prefix, ['q1']);
  assert.equal(c.target, 'q2');
  assert.deepEqual(c.landingPair, ['s2', 'q2']);
  assert.equal(c.landing.status, 'alive');
  assert.deepEqual(c.prefixPairs[0].pair, ['s0', 'q1']);
  assert.equal(c.prefixPairs[0].status, 'eliminated');
  assert.equal(c.prefixPairs[0].eliminatedRound, 1);

  assertEvidenceInvariants(b);
});

test('分支保持复核：静默前缀落点对可构成本轮同批淘汰的同轮关系违约', () => {
  // 随机搜索得到的小型反例：弱等价但分支保持不等价，且第 2 轮候选同时
  // 含“更早轮次淘汰”的前缀节点与“同轮违约”的落点节点。
  const A = {
    states: [{ name: 's0' }, { name: 's1' }],
    initial: 's0',
    transitions: [
      { id: 'st0', from: 's1', action: 'tau', to: 's0' },
      { id: 'st1', from: 's0', action: 'b', to: 's1' },
      { id: 'st2', from: 's1', action: 'a', to: 's1' },
    ],
  };
  const B = {
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
  const w = audit(A, B);
  const b = auditBranching(A, B);
  assert.equal(w.equivalent, true);
  assert.equal(b.equivalent, false);

  let sawSameRound = false;
  for (const ep of b.eliminatedPairs) {
    for (const t of ep.transitions) {
      for (const c of (t.candidates || [])) {
        for (const n of [c.landing, ...(c.prefixPairs || [])]) {
          if (n.status === 'same-round') sawSameRound = true;
        }
      }
    }
  }
  assert.ok(sawSameRound, '证据中应出现同轮关系违约节点');
  assertEvidenceInvariants(b);
});

test('分支保持等价：tau 自环与“静默步后行为不变”的规程不产生差异', () => {
  const A = {
    states: [{ name: 's0' }, { name: 's1' }, { name: 's2' }],
    initial: 's0',
    transitions: [
      { id: 't0', from: 's0', action: 'tau', to: 's0' }, // tau 自环
      { id: 't1', from: 's0', action: 'tau', to: 's1' }, // 静默步后仍可 a
      { id: 'a0', from: 's0', action: 'a', to: 's2' },
      { id: 'a1', from: 's1', action: 'a', to: 's2' },
    ],
  };
  const B = {
    states: [{ name: 'q0' }, { name: 'q2' }],
    initial: 'q0',
    transitions: [{ id: 'a', from: 'q0', action: 'a', to: 'q2' }],
  };
  const b = auditBranching(A, B);
  assert.equal(b.equivalent, true);
  // 行为不同的跨侧配对（如死态与可动作态）被淘汰属正常；初始对存活即等价
  assert.ok(!b.eliminatedPairs.some((p) => p.pair[0] === 's0' && p.pair[1] === 'q0'));
  assert.ok(b.initialAlive.every(Boolean));
  assert.deepEqual(b.initialPairs, [['s0', 'q0'], ['q0', 's0']]);
});

test('分支保持对缺失动作同样判不等价，原输入约束与上限不变', () => {
  const b = auditBranching(samples.missing.procA, samples.missing.procB);
  assert.equal(b.ok, true);
  assert.equal(b.mode, 'branching');
  assert.equal(b.equivalent, false);
  assert.ok(b.firstEliminated.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));

  const bad = {
    states: [{ name: 'x' }, { name: 'x' }],
    initial: 'ghost',
    transitions: [{ id: 't', from: 'x', action: '', to: 'nope' }],
  };
  const r = auditBranching(bad, { states: [], initial: '', transitions: [] });
  assert.equal(r.ok, false);
  assert.equal(r.equivalent, null);
  assert.equal(r.mode, 'branching');
  assert.equal(r.rounds.length, 0);
  assert.equal(r.eliminatedPairs.length, 0);
  assert.equal(r.firstEliminated, null);
  assert.ok(r.errors.length >= 3);
});

test('普通弱互模拟接口与结论不受分支保持模式影响', () => {
  const s = samples.branching;
  const w1 = audit(s.procA, s.procB);
  const w2 = audit(s.procA, s.procB);
  assert.deepEqual(w1, w2);
  assert.equal(w1.mode, undefined); // 普通模式响应不携带 mode 字段
});
