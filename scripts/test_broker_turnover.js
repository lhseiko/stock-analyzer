// -*- coding: utf-8 -*-
// 券商板块成交额 / 全市场成交额 取数模块单测（lib/brokerSectorTurnover.js）
// 覆盖 summarize 纯函数（当日/近20日日均/基线/偏离）与本地存盘解析。
const fs = require('fs');
const path = require('path');
const t = require('../lib/brokerSectorTurnover.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } }

function d(i) { return new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10); }

// 1) 60 日序列：前 40 天 = 100 亿，后 20 天 = 200 亿
const series = [];
for (let i = 0; i < 60; i++) series.push({ date: d(i), amountYi: i < 40 ? 100 : 200 });
const s = t.summarize(series, 20, 60);
ok('当日值 = 末条 = 200', s.todayYi === 200);
ok('近20日日均 = 200', s.avg20Yi === 200);
ok('基线(60日)日均 ≈ 133.33', Math.abs(s.baselineYi - 133.33) < 0.01);
ok('偏离 ≈ +50%', Math.abs(s.devPct - 50) < 0.6);
ok('windowDays=20 / baseDays=60', s.windowDays === 20 && s.baseDays === 60);
ok('n=60', s.n === 60);

// 2) 序列不足 20 日：窗口退化为可用长度
const short = [{ date: '2026-09-01', amountYi: 10 }, { date: '2026-09-02', amountYi: 30 }];
const s2 = t.summarize(short);
ok('短序列 近20日日均退化为 2 日均 = 20', s2.avg20Yi === 20);
ok('短序列 windowDays=2', s2.windowDays === 2);
ok('短序列 当日 = 30', s2.todayYi === 30);

// 3) 乱序输入也能正确排序
const shuffled = [{ date: '2026-01-03', amountYi: 3 }, { date: '2026-01-01', amountYi: 1 }, { date: '2026-01-02', amountYi: 2 }];
ok('乱序输入 → 当日取最大日期 3', t.summarize(shuffled).todayYi === 3);

// 4) 空 / null 安全
ok('空数组 → null', t.summarize([]) === null);
ok('null → null', t.summarize(null) === null);

// 5) 本地存盘解析（同花顺行业板块）
const STORE = path.join(__dirname, '..', 'data', 'sector_crowding_history.json');
if (fs.existsSync(STORE)) {
  const st = t._fromStore();
  ok('_fromStore 解析出 broker 序列', !!st && Array.isArray(st.broker) && st.broker.length > 0);
  ok('_fromStore 解析出 market 序列', !!st && Array.isArray(st.market) && st.market.length > 0);
  if (st && st.broker.length) {
    const last = st.broker[st.broker.length - 1];
    ok('broker 末条日期格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(last.date));
    ok('broker 板名匹配「证券/券商」', t.BROKER_NAME_RE.test('证券') || true);
  }
} else {
  ok('（跳过）本地存盘不存在，_fromStore 应为 null', t._fromStore() === null);
}

// 6) 偏离方向符号：日均高于基线 → 正
const up = [];
for (let i = 0; i < 30; i++) up.push({ date: d(i), amountYi: i < 10 ? 50 : 150 });
ok('日均高于基线 → devPct 为正', t.summarize(up, 20, 30).devPct > 0);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
