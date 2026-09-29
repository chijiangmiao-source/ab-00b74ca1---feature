'use strict';

// 页面内置示例：
//  1. equivalent —— 仅差一个可观察上不可见的 tau 自环（状态重命名），应判定等价
//  2. missing    —— 一侧可观察动作另一侧无法承接，应判定不等价
//  3. cascade    —— 多轮淘汰：初始对在第 2 轮因引用第 1 轮淘汰结果而失败
//  4. branching  —— 静默分叉（两侧均含 tau）：
//                   P: s0 =tau=> s1 -a-> s4，且 s0 -a-> s2、s0 -c-> s3
//                   Q: q0 =tau=> q1 -a-> q2，且 q0 -c-> q3
//                   普通弱互模拟判等价（s0 的 a 挑战由 q0 经静默前缀 q1
//                   承接，落点死态对相关即可）；
//                   分支保持复核判不等价：该静默前缀经过 q1，而 q1 不能
//                   做 c，前缀状态对 (s0,q1) 在第 1 轮淘汰，初始对
//                   (s0,q0) 第 2 轮因 a 挑战的前缀违约被淘汰。

const samples = {
  equivalent: {
    label: 'tau 自环 + 重命名（应等价）',
    procA: {
      states: [{ name: 'S0' }, { name: 'S1' }],
      initial: 'S0',
      transitions: [
        { id: 'a-tau-loop', from: 'S0', action: 'tau', to: 'S0' },
        { id: 'a-x', from: 'S0', action: 'x', to: 'S1' },
      ],
    },
    procB: {
      states: [{ name: 'P0' }, { name: 'P1' }],
      initial: 'P0',
      transitions: [{ id: 'b-x', from: 'P0', action: 'x', to: 'P1' }],
    },
  },
  missing: {
    label: '缺失匹配动作（应不等价）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }],
      initial: 'a0',
      transitions: [{ id: 'ax', from: 'a0', action: 'x', to: 'a1' }],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'by', from: 'b0', action: 'y', to: 'b1' }],
    },
  },
  cascade: {
    label: '多轮级联淘汰（初始对第 2 轮失败）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }, { name: 'a2' }],
      initial: 'a0',
      transitions: [
        { id: 'ax', from: 'a0', action: 'x', to: 'a1' },
        { id: 'ay', from: 'a1', action: 'y', to: 'a2' },
      ],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'bx', from: 'b0', action: 'x', to: 'b1' }],
    },
  },
  branching: {
    label: '静默分叉（弱等价 · 分支保持不等价）',
    procA: {
      // P：s0 可直接 a、c，并可静默到 s1 后 a
      states: [{ name: 's0' }, { name: 's1' }, { name: 's2' }, { name: 's3' }, { name: 's4' }],
      initial: 's0',
      transitions: [
        { id: 'p-tau', from: 's0', action: 'tau', to: 's1' },
        { id: 'p-a1', from: 's0', action: 'a', to: 's2' },
        { id: 'p-a2', from: 's1', action: 'a', to: 's4' },
        { id: 'p-c', from: 's0', action: 'c', to: 's3' },
      ],
    },
    procB: {
      // Q：q0 可 c，并静默到 q1 后 a；q1 已不能 c
      states: [{ name: 'q0' }, { name: 'q1' }, { name: 'q2' }, { name: 'q3' }],
      initial: 'q0',
      transitions: [
        { id: 'q-tau', from: 'q0', action: 'tau', to: 'q1' },
        { id: 'q-a', from: 'q1', action: 'a', to: 'q2' },
        { id: 'q-c', from: 'q0', action: 'c', to: 'q3' },
      ],
    },
  },
};

module.exports = { samples };
