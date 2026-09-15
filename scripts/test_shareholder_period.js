/**
 * 离线单测（20260913g）：股东「最新报告期」选取
 * ------------------------------------------------------------------
 * 背景：东财 RPT_F10_EH_HOLDERS 的 END_DATE 有三类——①季度末（标准10行）
 * ②非季度末的权益变动/临时披露（东财也给完整10行，如海天味业 2026-07-03）
 * ③残缺临时行（仅1行，如长江电力 2026-08-22）。
 * 旧逻辑「只认季度末」会丢掉 ②，表现为「东财已有7月数据、工作台仍显示6-30」。
 * 本测试锁定修复后的行为：优先取「最新一个满10行的完整披露日」。
 * 无网络依赖：直接对纯函数喂合成数据。
 */
const { _pickLatestDisclosure, _isQuarterEnd } = require('../lib/shareholderData');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('[PASS]', name); }
  else { fail++; console.log('[FAIL]', name, extra); }
};

// 构造合成行：map = { 'YYYY-MM-DD': 行数 }
const rowsFrom = (map) => {
  const out = [];
  for (const [d, n] of Object.entries(map)) {
    for (let i = 0; i < n; i++) out.push({ END_DATE: `${d} 00:00:00`, HOLDER_NAME: `股东${i + 1}` });
  }
  return out;
};

console.log('===== 1) 非季度末的完整披露（海天味业 2026-07-03）=====');
{
  const rows = rowsFrom({ '2026-03-31': 10, '2026-06-30': 10, '2026-07-03': 10 });
  const p = _pickLatestDisclosure(rows);
  check('取最新满10行的完整披露日 = 2026-07-03', p.date === '2026-07-03', p.date);
  check('kind = 最新披露（权益变动/临时公告）', p.kind === '最新披露（权益变动/临时公告）', p.kind);
}

console.log('\n===== 2) 残缺临时行（长江电力 2026-08-22 仅1行）必须被排除 =====');
{
  const rows = rowsFrom({ '2025-12-31': 10, '2026-03-31': 10, '2026-06-30': 10, '2026-08-22': 1 });
  const p = _pickLatestDisclosure(rows);
  check('仍取最近的满10行季度末 = 2026-06-30', p.date === '2026-06-30', p.date);
  check('kind = 季度末报告期', p.kind === '季度末报告期', p.kind);
}

console.log('\n===== 3) 一个满10行的日期都没有 → 退回最近季度末 =====');
{
  const p = _pickLatestDisclosure(rowsFrom({ '2026-03-31': 7, '2026-07-08': 5 }));
  check('退回最近季度末 2026-03-31（不用残缺的非季度末）', p.date === '2026-03-31', p.date);
}

console.log('\n===== 4) 边界：空输入 / 无END_DATE =====');
{
  check('空数组 → date 为空', _pickLatestDisclosure([]).date === '');
  check('全部无 END_DATE → date 为空', _pickLatestDisclosure([{ HOLDER_NAME: 'x' }]).date === '');
}

console.log('\n===== 5) isQuarterEnd 判定 =====');
check('2026-06-30 → 季度末', _isQuarterEnd('2026-06-30') === true);
check('2026-07-03 → 非季度末', _isQuarterEnd('2026-07-03') === false);
check('带时间戳仍可判定（2026-12-31 00:00:00）', _isQuarterEnd('2026-12-31 00:00:00') === true);

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
