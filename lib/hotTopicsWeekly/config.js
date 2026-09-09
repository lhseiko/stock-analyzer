/**
 * 板块舆情热度周榜 · 配置（20260909m）
 * 默认值内置于此；用户可在 data/hotTopics/config.json 覆盖同名键（浅合并，按节覆盖）。
 * 全部权重/阈值人工可配置 —— 对应用户框架「权重、阈值、新手判定规则人工可配置」。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 五项指标权重（A 舆情曝光 / B 社区讨论 / D 舆情情感 / E 社区情感；C 只参与告警不进综合分）
  weights: { A: 0.4, B: 0.4, D: 0.1, E: 0.1 },
  // 股吧通道缺失时的降级权重（A+D 重新归一）
  degradeWeights: { A: 0.8, D: 0.2 },
  // 热度等级阈值
  levels: { hot: 72, warm: 60 },
  // 告警：C 归一化 ≥ cNorm 且综合分 ≥ score → ⚠️ 韭菜蜂拥
  alarm: { cNorm: 90, score: 70 },
  // 三路交叉验证修正（外部输入：行业5日涨幅 / 主力5日净占比 / 归一化A、B）
  crossCheck: {
    enabled: true,
    fundConfirm: { scoreMin: 60, netPctMin: 1.0, adj: 4 },    // 热度高+资金流入确认 +
    fundDiverge: { scoreMin: 60, netPctMax: -1.0, adj: -6 },  // 热度高+资金流出背离 −
    chaseOverheat: { scoreMin: 70, pctMin: 5.0, adj: -6 },    // 热度高+周涨幅过热（追高拥挤）−
    resonance: { aMin: 70, bMin: 70, adj: 4, gapMin: 50, gapAdj: -3 }, // 舆情/社区共振 + / 单源虚热 −
    maxAdjust: 8,                                              // 修正总量上限（每方向）
  },
  // 情绪标签阈值（按优先级自上而下命中一条即止）
  sentimentTags: {
    runAway: { scoreMin: 70, pctMax: -3 },        // 比谁跑得快：高热+周涨幅显著为负
    panic: { eMax: 25, scoreMin: 50 },            // 极度恐慌：社区看多占比极低
    crowded: { netPctMin: 3.0, scoreMin: 70 },    // 资金拥挤：主力大额流入+高热
    kolSwarm: { dMin: 85, eMin: 75, scoreMin: 60 }, // KOL蜂拥：舆情与社区一致强烈看多
    divergence: { dEGapMin: 35, scoreMin: 40 },   // 分化磨盘：舆情与社区情绪显著分歧
    numb: { scoreMin: 40, scoreMax: 60, netPctAbs: 1.0, pctAbs: 2.0 }, // 筹码钝化：温吞+资金平静
  },
  // 采集调度
  collect: { gubaIntervalSec: 1.2, staleMinutes: 30, pythonTimeoutMs: 300000 },
  // 榜单规模
  topN: 20,
};

function loadConfig(dataDir) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const p = path.join(dataDir, 'config.json');
    if (fs.existsSync(p)) {
      const user = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const k of Object.keys(user)) {
        if (user[k] && typeof user[k] === 'object' && !Array.isArray(user[k]) && cfg[k] && typeof cfg[k] === 'object') {
          Object.assign(cfg[k], user[k]);
        } else {
          cfg[k] = user[k];
        }
      }
    }
  } catch (e) { /* 配置文件损坏 → 用默认值 */ }
  return cfg;
}

module.exports = { DEFAULTS, loadConfig };
