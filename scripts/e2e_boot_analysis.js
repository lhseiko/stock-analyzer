#!/usr/bin/env node
/**
 * E2E 引导包装器（测试脚手架 · 非测试文件，run_all_tests 不会执行）
 * =====================================================================
 * 被 scripts/test_analysis_*_e2e.js 四个 E2E 经 harness 以子进程方式拉起，
 * 职责三件事（全部零运行时改动——server.js / lib 不动）：
 *
 * 1) 吞掉 app.listen 的启动回调：server.js 所有启动副作用（runAutoReview 结算、
 *    ensureAllTrackedJudgments 自动判定、每日复盘/结算调度器、分析预热、
 *    .server-ready 标记）全部注册在 listen 回调里；包装器把回调换成空函数后，
 *    服务器仍正常监听 127.0.0.1:PORT 并服务请求，但上述副作用永不执行——
 *    测试进程不写生产结算/判定数据、不触调度网络调用。
 *
 *    ⚠️ 此前提已固化（2026-11-12）：本包装器的安全性完全依赖「server.js 启动副作用
 *    全部挂在 app.listen 回调」这一代码结构。若未来 server.js 重构把任何副作用
 *    移到顶层（require 时刻即执行），本包装器不会拦截，测试将静默触碰真实 data/——
 *    重构 server.js 启动序列时必须同步检查本前提，否则先停用四组 E2E。
 *
 * 2) 原地替换 require 缓存里的桩函数（server.js 解构发生在 require 时刻，
 *    先改 module.exports 再 require server 即可生效）：
 *      - lib/stockData.getQuote / getHistory → 按 symbol 的确定性零网络桩；
 *      - lib/shareholderData.getCompanyProfile → 静态桩。
 *    stockData 其余导出（detectMarket 等）保持真实实现（纯本地逻辑）。
 *
 * 3) 失败注入（按 symbol 计数器，供 C3/A4 用）：
 *      - 601008：getQuote 持续失败、history 正常 → 部分降级（quote=null）路径；
 *      - 601009：getQuote/getHistory 各自首次失败、之后正常 → 404 后恢复路径；
 *      - 601077：getQuote 延迟 400ms → D3 客户端中途断开（aborted）场景。
 *
 * 未知 symbol 一律抛错/返回空，绝不回退真实网络（@test-scope: local 声明即责任）。
 */
'use strict';
const http = require('http');

// ---- 1) 吞启动回调 ----
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'function') args[i] = function e2eSwallowedStartCb() { /* 测试进程不执行任何启动副作用 */ };
  }
  return origListen.apply(this, args);
};

// ---- 2) 确定性桩 ----
const FIX = {
  '601001': { name: '测试股甲', base: 10, trend: 0.05 },
  '601002': { name: '测试股乙', base: 20, trend: -0.04 },
  '601003': { name: '测试股丙', base: 30, trend: 0.01 },
  '601005': { name: '测试股丁', base: 40, trend: 0.02 },
  '601008': { name: '测试股戊', base: 50, trend: -0.02 },
  '601009': { name: '测试股己', base: 60, trend: 0.03 },
  '601077': { name: '测试股慢', base: 70, trend: 0.01 },
};
const BAR_COUNT = 320;
const END_DATE = '2026-11-12'; // 固定截止日：桩数据与时间无关，重跑零漂移
const quoteCalls = Object.create(null);
const histCalls = Object.create(null);

function bars(symbol) {
  const f = FIX[symbol];
  const end = new Date(END_DATE + 'T00:00:00Z');
  const out = [];
  for (let i = BAR_COUNT - 1; i >= 0; i--) {
    const step = BAR_COUNT - 1 - i;
    const close = +(f.base * (1 + f.trend * step / 100) * (1 + 0.01 * Math.sin(step + f.base))).toFixed(2);
    const day = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
    out.push({
      date: day,
      open: +(close * 0.995).toFixed(2),
      close,
      high: +(close * 1.01).toFixed(2),
      low: +(close * 0.99).toFixed(2),
      volume: 100000 + step * 500,
    });
  }
  return out;
}

function quoteFor(symbol) {
  const f = FIX[symbol];
  const last = bars(symbol)[BAR_COUNT - 1].close;
  return {
    name: f.name, code: symbol, price: last, prevClose: +(last * 0.99).toFixed(2),
    date: END_DATE, time: '', dateFallback: false,
    open: +(last * 0.995).toFixed(2), high: +(last * 1.01).toFixed(2), low: +(last * 0.99).toFixed(2),
    change: +(last * 0.01).toFixed(2), changePct: 1.0,
    volume: 40808900, amount: 2171550000, turnover: 0.38, volumeRatio: 0.83,
    pe: 9.8, pb: 0.92, amplitude: 2.0, circulationValue: 1000, totalValue: 1200,
    bid: last, ask: last, market: 'tencent',
    fundamentals: {
      pe: 9.8, pb: 0.92, roe: 11.5, roeTtm: 11.5, grossMargin: 30, grossMarginTtm: 30,
      netMargin: 12, netMarginTtm: 12, revenueYoy: 5,
      totalValue: 1200, circulationValue: 1000, totalShares: 10000000000,
      industryName: '', // 空 → buildFundamentalComparison 走兜底分支（axios 被死代理拒连，catch 降级）
      valuationHistory: [
        { date: END_DATE, pe: 9.8, pb: 0.92, ps: 1.9 },
        { date: '2026-11-11', pe: 9.7, pb: 0.91, ps: 1.88 },
      ],
      reportDate: '', // 不匹配日期正则 → 跳过 opProfit 网络取数（E2E 零外网）
    },
  };
}

const stockData = require('../lib/stockData');
stockData.getQuote = async (symbol) => {
  quoteCalls[symbol] = (quoteCalls[symbol] || 0) + 1;
  if (symbol === '601008') throw new Error('E2E 桩：上游行情持续失败');
  if (symbol === '601009' && quoteCalls[symbol] === 1) throw new Error('E2E 桩：上游行情首次失败');
  if (symbol === '601077') await new Promise(r => setTimeout(r, 400)); // D3 aborted 场景
  // [② 健康指标 E2E ④] 10 并发全 miss 需确定性：无延迟时首请求可同步算完 setCached，
  // 后续并发变 hit（runner 负载下实证 hits=2/misses=10 间歇失败）。
  // ⚠️ 400ms 是经验值：本断言依赖桩延迟保证「10 个请求全部先进入处理器再完成」的并发窗口，
  // 机器极慢时仍可能抖动；若未来复现，优先加大本延迟（如 800ms）而非放宽断言（禁止改 hits/misses 精确断言）。
  if (symbol === '601002') await new Promise(r => setTimeout(r, 400));
  if (!FIX[symbol]) throw new Error('E2E 桩：未知标的 ' + symbol + '（桩只覆盖 FIX 表内 symbol）');
  return quoteFor(symbol);
};
stockData.getHistory = async (symbol) => {
  histCalls[symbol] = (histCalls[symbol] || 0) + 1;
  if (symbol === '601009' && histCalls[symbol] === 1) throw new Error('E2E 桩：上游日K首次失败');
  if (!FIX[symbol]) return [];
  return bars(symbol);
};

const shareholderData = require('../lib/shareholderData');
shareholderData.getCompanyProfile = async (symbol) => ({
  companyName: (FIX[symbol] ? FIX[symbol].name : symbol) + '股份有限公司',
  ownership: '民营（测试桩）',
  industry: '测试行业',
  mainBusiness: 'E2E 零网络桩数据',
});

// ---- 3) 启动 server（PORT 由 harness 注入；listen 回调已被吞掉） ----
require('../server');
