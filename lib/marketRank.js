/**
 * 首页「基金重仓行业配置矩阵」
 * --------------------------------------------------------------
 * 数据说明：
 *   公募基金主动权益基金重仓股的申万一级行业配置比例（重仓股口径），
 *   按季度末（9/30、12/31、3/31、6/30）展示各行业占比。
 *
 * 数据源现状：
 *   东方财富 datacenter-web 所有基金/机构行业配置聚合报表（RPT_FUND_*_INDUSTRY 等）
 *   经大量探针实测均返回「报表配置不存在」，免费公开结构化接口未覆盖该聚合数据。
 *   因此后端先保留真实探测逻辑（getRealtimeMatrix），失败时回退到本地缓存文件；
 *   本地缓存文件初始用用户提供的截图示例值填充，并明确标注为「示例数据/来源待确认」。
 *   用户可通过 POST /api/market-rank 导入自己的 CSV/JSON 数据替换示例值。
 *
 * 数据使用原则：
 *   - 不编造数据：所有展示百分比必须能追溯到真实来源或用户导入。
 *   - 来源必标注：卡片头部、表格下方均展示 source 与 updatedAt。
 *   - 投资有风险：本模块仅展示机构持仓结构，不构成投资建议。
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DC_HOST = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const DATA_DIR = path.join(__dirname, '..', 'data');
const MATRIX_FILE = path.join(DATA_DIR, 'sector-matrix.json');

// 示例数据：来自用户截图，作为初始占位；source 标记为待确认
const SEED_MATRIX = {
  title: '主动权益基金重仓行业配置比例（重仓股口径）',
  source: '用户提供截图（示例数据，来源待确认）',
  sourceUrl: '',
  reportDate: '截至 2026-06-30',
  updatedAt: new Date().toISOString(),
  available: true,
  isSample: true,
  quarters: ['2025/9/30', '2025/12/31', '2026/3/31', '2026/6/30'],
  sectors: [
    { name: '电子', values: [25.60, 23.76, 21.68, 43.31] },
    { name: '通信', values: [9.29, 11.14, 13.06, 16.91] },
    { name: '电力设备', values: [12.33, 11.51, 12.30, 7.35] },
    { name: '机械设备', values: [4.08, 4.77, 4.98, 6.13] },
    { name: '医药生物', values: [9.68, 8.07, 8.50, 5.49] },
    { name: '有色金属', values: [5.90, 8.06, 6.95, 3.59] },
    { name: '基础化工', values: [2.41, 3.19, 4.40, 2.23] },
    { name: '汽车', values: [4.89, 5.08, 4.14, 1.94] },
    { name: '建筑材料', values: [0.61, 0.72, 0.91, 1.78] },
    { name: '国防军工', values: [3.00, 2.63, 2.51, 1.54] },
    { name: '其他合计', values: [22.21, 21.06, 20.07, 9.74] }
  ]
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLocalMatrix() {
  ensureDataDir();
  if (!fs.existsSync(MATRIX_FILE)) {
    fs.writeFileSync(MATRIX_FILE, JSON.stringify(SEED_MATRIX, null, 2), 'utf8');
    return SEED_MATRIX;
  }
  try {
    const raw = fs.readFileSync(MATRIX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sectors) || !Array.isArray(parsed.quarters)) {
      throw new Error('本地矩阵文件格式异常');
    }
    return parsed;
  } catch (e) {
    console.error('readLocalMatrix error:', e.message);
    return SEED_MATRIX;
  }
}

function writeLocalMatrix(data) {
  ensureDataDir();
  const payload = {
    ...data,
    updatedAt: new Date().toISOString(),
    isSample: false
  };
  fs.writeFileSync(MATRIX_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

// 尝试从东方财富数据中心获取聚合行业配置（当前未覆盖，保留探测能力）
async function getRealtimeMatrix() {
  const reportNames = [
    'RPT_FUND_HOLD_INDUSTRY',
    'RPT_FUND_INDUSTRY_ALLOCATION',
    'RPT_FUND_INDUSTRY_DISTRIBUTION',
    'RPT_FUND_POSITION_INDUSTRY',
    'RPT_FUND_SECTOR_ALLOCATION',
    'RPT_PUBLIC_FUND_INDUSTRY',
    'RPT_FUND_HEAVY_INDUSTRY'
  ];
  for (const name of reportNames) {
    const url = `${DC_HOST}?reportName=${encodeURIComponent(name)}&columns=ALL&pageSize=20&pageNumber=1&source=WEB&client=WEB`;
    try {
      const r = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' }, timeout: 8000 });
      const data = r.data;
      if (data && data.result && Array.isArray(data.result.data) && data.result.data.length > 0) {
        console.log('marketRank realtime hit:', name);
        return { hit: true, reportName: name, raw: data.result.data };
      }
    } catch (e) {
      // 继续试下一个
    }
  }
  return { hit: false };
}

function getMatrix(force = false) {
  const local = readLocalMatrix();
  // 若要求刷新且本地是示例数据，尝试实时源；即使失败也返回本地数据
  if (force) {
    getRealtimeMatrix().then(res => {
      if (res.hit) {
        // 未来若接口恢复，可在此解析 raw 并写入本地文件
        console.log('Real-time matrix source available:', res.reportName);
      }
    }).catch(() => {});
  }
  return local;
}

// 后端归一化校验：把各种导入格式转成统一结构
function normalizeMatrix(input) {
  if (!input) throw new Error('导入内容为空');

  let payload;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      payload = JSON.parse(trimmed);
    } else {
      // CSV 解析：首行是季度，第一列是行业名
      const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const header = lines[0].split(',').map(s => s.trim());
      const quarters = header.slice(1);
      const sectors = lines.slice(1).map(line => {
        const cells = line.split(',').map(s => s.trim());
        const values = cells.slice(1).map(v => {
          const n = parseFloat(v.replace(/%/g, ''));
          return isNaN(n) ? 0 : n;
        });
        return { name: cells[0], values };
      });
      payload = { quarters, sectors };
    }
  } else {
    payload = input;
  }

  if (!Array.isArray(payload.quarters) || payload.quarters.length < 2) {
    throw new Error('季度列至少需要 2 列');
  }
  if (!Array.isArray(payload.sectors) || payload.sectors.length < 1) {
    throw new Error('行业行至少需要 1 行');
  }
  for (const s of payload.sectors) {
    if (!s.name || !Array.isArray(s.values)) {
      throw new Error('每条行业记录必须包含 name 和 values 数组');
    }
    if (s.values.length !== payload.quarters.length) {
      throw new Error(`行业「${s.name}」的数值列数与季度列数不一致`);
    }
  }

  return {
    title: payload.title || SEED_MATRIX.title,
    source: payload.source || '用户导入',
    sourceUrl: payload.sourceUrl || '',
    reportDate: payload.reportDate || `截至 ${payload.quarters[payload.quarters.length - 1]}`,
    available: true,
    isSample: false,
    quarters: payload.quarters,
    sectors: payload.sectors
  };
}

module.exports = {
  getMarketRank: async ({ force = false } = {}) => {
    const data = getMatrix(force);
    return {
      ...data,
      updated: data.updatedAt || new Date().toISOString(),
      note: '本矩阵展示主动权益基金重仓股的申万一级行业配置比例。当前免费公开接口未覆盖该聚合数据，默认填充用户截图示例值；可通过「导入数据」替换为 Wind/Choice/iFinD 等真实数据。'
    };
  },
  updateMarketRank: (input) => {
    const normalized = normalizeMatrix(input);
    return writeLocalMatrix(normalized);
  },
  // 暴露供测试/调试
  _MATRIX_FILE: MATRIX_FILE
};
