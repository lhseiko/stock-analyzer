/**
 * lib/brokerClassification.js —— 券商类型分类与估值模型选择（确定性逻辑）
 * ----------------------------------------------------------------
 * 用户 2026-09-08 确立。与 601318 专属估值模型同一原则：计算层=代码（纯四则 + 阈值比较），
 * 不依赖 AI；输入锁死 ⇒ 结果锁死（1+1=2），与用哪个 AI 模型、什么时候跑无关。
 *
 * 流程：
 *   STEP1 数据清洗层（AI 依赖）：从年报/半年报/季报抽取 6 个核心指标 —— 见 prompts/broker-valuation-data.md
 *   STEP2 三维度分级评分（本文件，确定性）：规模 S / 创新 I / 多元 D，各 1~3 分
 *   STEP3 决策树分类（本文件，确定性）：归入 4 类画像，匹配核心估值模型
 *   STEP4 输出（本文件 formatConclusion）：画像 / 核心估值锚 / 辅助验证 / 关键风险点
 *
 * 输入指标口径：
 *   totalAssets     总资产（亿元）
 *   netCapital      净资本（亿元）—— 监管核心抗风险指标
 *   brokerageRatio  经纪业务收入占比（%） = 代理买卖证券业务净收入 / 营业收入
 *   lightBizRatio   投行+资管+财富管理收入占比（%）= (投行净收入+资管净收入+代销金融产品净收入)/营业收入
 *   proprietaryRatio 自营投资收入占比（%）= (投资收益+公允价值变动损益)/营业收入
 *   hhi             收入集中度 HHI（0~1）= Σ各业务收入占比²（越接近1越单一，越接近0越多元）
 */
'use strict';

// 4 类画像元数据：业务特征 + 推荐估值模型 + 核心逻辑 + 关键风险点
const TYPE_META = {
  I: {
    key: 'I', name: '传统通道型中小券商',
    primary: '单一PB（市净率）',
    primaryLogic: '同质化重资产通道商，净资产重置成本是价值底线；重点看 PB 历史分位的折价与 ROE 修复逻辑。',
    aux: 'PB-ROE 回归线（辅）',
    risk: '在该模型下，需重点关注市场成交量（经纪+两融）的边际变化；仅在破净时具备安全边际。',
  },
  II: {
    key: 'II', name: '重资本自营型券商',
    primary: '调整后PB（主）',
    primaryLogic: '业绩弹性极大、净资产波动大，需扣减自营持仓浮盈浮亏对净资产的影响，用调整后可比 PB。',
    aux: '市场敏感性测试（辅）',
    risk: '在该模型下，需重点关注自营持仓公允价值变动、权益/债券市场波动，及调整后 PB 的稳健性。',
  },
  III: {
    key: 'III', name: '精品投行/财富管理型',
    primary: 'PE（市盈率，主）',
    primaryLogic: '轻资产高壁垒，盈利稳定可持续，PE 比 PB 更能反映品牌溢价与成长性。',
    aux: 'RIM 剩余收益模型（辅）',
    risk: '在该模型下，需重点关注资管规模净流入/流出、投行业务周期，及 ROE 的可持续性。',
  },
  IV: {
    key: 'IV', name: '综合航母均衡型',
    primary: 'SOTP 分部加总估值（主）',
    primaryLogic: '业务条线齐全、盈利能力差异大，需拆分：经纪/信用用 PB，投行/资管用 PE，自营用 P/NAV，最后加总。',
    aux: 'PB/PE 交叉验证（辅）',
    risk: '在该模型下，需重点关注各业务条线协同与分化、机构化/国际化进展，及分部分别估值偏差。',
  },
};

// ---- 维度A：规模等级（Scale）----
function scoreScale(totalAssets, netCapital) {
  // 3分（大型全能）：总资产≥5000亿 且 净资本≥800亿
  if (totalAssets >= 5000 && netCapital >= 800) return 3;
  // 2分（中型成长）：2000亿≤总资产<5000亿（含总资产≥5000但净资本不足800的"规模够、资本不够"情形，归为2）
  if (totalAssets >= 2000) return 2;
  // 1分（中小型）：总资产<2000亿
  return 1;
}

// ---- 维度B：创新业务占比（Innovation）---- 反映轻资产转型程度
function scoreInnovation(lightBizRatio) {
  if (lightBizRatio >= 45) return 3; // 高创新
  if (lightBizRatio >= 30) return 2; // 中等创新
  return 1;                          // 传统通道型
}

// ---- 维度C：业务多元化（Diversification）---- 反映抗周期与均衡能力
function scoreDiversification(hhi) {
  if (hhi < 0.25) return 3;   // 高度均衡
  if (hhi < 0.45) return 2;   // 中度均衡
  return 1;                   // 业务单一
}

// ---- STEP3 决策树：根据三维度得分 + 自营占比特殊判定，归入 4 类 ----
function decideTypeKey({ scale, innovation, diversification, proprietaryRatio }) {
  // 特殊判定（最高优先）：自营收入占比 > 40% → 重资本自营型（即使规模大也归此类）
  if (proprietaryRatio > 40) return 'II';
  // 综合航母均衡型：Scale=3 且 Innovation≥2 且 Diversification=3
  if (scale === 3 && innovation >= 2 && diversification === 3) return 'IV';
  // 精品投行/财富管理型：Innovation=3 且 Scale≤2
  if (innovation === 3 && (scale === 1 || scale === 2)) return 'III';
  // 其余（Scale≤2 且 Innovation≤2）：传统通道型中小券商
  return 'I';
}

/**
 * 主入口：给定 6 个输入指标，返回三维度得分、画像类型、推荐估值模型与风险点。
 * @param {Object} m 指标（单位见文件头注释）
 * @returns {Object}
 */
function classify(m) {
  const totalAssets = Number(m.totalAssets);
  const netCapital = Number(m.netCapital);
  const brokerageRatio = Number(m.brokerageRatio);
  const lightBizRatio = Number(m.lightBizRatio);
  const proprietaryRatio = Number(m.proprietaryRatio);
  const hhi = Number(m.hhi);

  if ([totalAssets, netCapital, brokerageRatio, lightBizRatio, proprietaryRatio, hhi].some(v => !isFinite(v))) {
    return { ok: false, error: 'INPUT_INVALID', message: '6 个核心指标必须均为有效数字（总资产/净资本单位亿元，各项收入占比单位%，HHI 单位 0~1）' };
  }

  const scale = scoreScale(totalAssets, netCapital);
  const innovation = scoreInnovation(lightBizRatio);
  const diversification = scoreDiversification(hhi);
  const typeKey = decideTypeKey({ scale, innovation, diversification, proprietaryRatio });
  const meta = TYPE_META[typeKey];

  return {
    ok: true,
    metrics: { totalAssets, netCapital, brokerageRatio, lightBizRatio, proprietaryRatio, hhi },
    scores: { scale, innovation, diversification },
    type: typeKey,
    typeName: meta.name,
    primaryModel: meta.primary,
    primaryLogic: meta.primaryLogic,
    auxModel: meta.aux,
    riskPoint: meta.risk,
    // STEP4 最终结论输出格式
    conclusion: {
      profile: `类型${typeKey}：${meta.name}`,
      anchor: `建议以${meta.primary}为主`,
      aux: `建议辅以${meta.aux}`,
      risk: meta.risk,
    },
  };
}

module.exports = { classify, scoreScale, scoreInnovation, scoreDiversification, decideTypeKey, TYPE_META };
