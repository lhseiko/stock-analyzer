/**
 * scripts/test_manual_zone_reversal.js — 20261105b 守卫
 * ==========================================================
 * 用户报障（2026-11-03）：「手动设定的阻力和支撑区间，也要遵守模块本身的有效性检验，
 * 而且阻力已经被突破，为什么还保持显示」。
 *
 * 根因：手动区间走了标准1（无放量轻松突破→无效），但「放量有效突破→角色反转」模块
 * 此前明确跳过 isManual——放量突破的手动阻力既不判无效也不反转，一直挂在清单里。
 *
 * 本守卫锁定修复后的行为：
 *   §1 纯函数：createRecordFromZone（手动 extra）/ loadRecords 字段保留 / purgeByManualId
 *   §2 attach 集成：手动阻力放量突破 → 原条目移出清单 + 反转支撑注入 + meta.reversed；
 *      无放量突破 → 标准1 判无效不反转；突破后回落 → 保留原区间
 *   §3 删除联动：删除手动区间 → 其反转记录清除
 *   §4 接线守卫：priceActionHub 顺序（手动先于反转）/ 反转模块不再跳过 isManual /
 *      server 删除路由联动 purge / 前端徽标与 CSS / 版本断言
 *
 * IO 隔离：使用不存在的测试代码 999001（data/manual-zones/999001.json、
 * data/zone-reversals/999001.json），测试结束后删除，不触碰真实标的。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const manualZones = require(path.join(ROOT, 'lib/manualZones'));
const zoneReversal = require(path.join(ROOT, 'lib/zoneReversal'));
const priceActionHub = require(path.join(ROOT, 'lib/priceActionHub'));
const { assessZone, finalizedBars } = require(path.join(ROOT, 'lib/zoneValidity'));

const SYM = '999001';
const MZ_FILE = path.join(ROOT, 'data', 'manual-zones', SYM + '.json');
const ZR_FILE = path.join(ROOT, 'data', 'zone-reversals', SYM + '.json');
const _mzAdd = manualZones.addZone, _mzRemove = manualZones.removeZone;
const _load = zoneReversal.loadRecords, _save = zoneReversal.saveRecords;

function cleanup() {
  try { fs.unlinkSync(MZ_FILE); } catch (e) {}
  try { fs.unlinkSync(ZR_FILE); } catch (e) {}
}

/** 构造日K：base 天横盘（vol=10000, close=10.0），再按剧本覆盖 */
function makeBars(scene) {
  const bars = [];
  let d = new Date('2026-09-01T00:00:00Z');
  let n = 0;
  while (bars.length < 60) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const iso = d.toISOString().slice(0, 10);
      bars.push({ date: iso, open: 10, high: 10.2, low: 9.8, close: 10, volume: 10000 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
    n++;
  }
  // 剧本（默认：放量突破）
  const last = bars.length;
  const s = Object.assign({ breakVol: 15000, breakClose: 10.8, lastClose: 10.9 }, scene || {});
  if (s.breakDay !== 0) {
    const i = last - (s.lastClose != null ? 2 : 1);
    bars[i] = Object.assign({}, bars[i], { close: s.breakClose, volume: s.breakVol });
  }
  if (s.lastClose != null) {
    bars[last - 1] = Object.assign({}, bars[last - 1], { close: s.lastClose, volume: 10000 });
  } else {
    bars.pop();   // 末根=突破日（finalizedBars 只会丢「今天」的根，这里日期不是今天，保留）
  }
  return bars;
}

async function main() {
  cleanup();

  // ── §1 纯函数 ──────────────────────────────────────────────
  console.log('\n§1 纯函数（createRecordFromZone / loadRecords / purgeByManualId）');
  {
    const bars = makeBars({});
    const zone = { low: 10, high: 10.5, zoneCheck: { lastBreakDate: bars[bars.length - 2].date, lastBreakVr: 1.5, breakCount: 1 } };
    const recM = zoneReversal.createRecordFromZone(zone, 'resistance', bars, { origin: 'manual', manualId: 'mz_x1' });
    ok(recM && recM.side === 'support', '手动阻力放量突破 → 反转记录 side=support');
    ok(recM.origin === 'manual' && recM.manualId === 'mz_x1', '反转记录带 origin=manual + manualId 链接');
    const recModel = zoneReversal.createRecordFromZone(zone, 'resistance', bars, null);
    ok(recModel && !recModel.origin && !recModel.manualId, '模型区间反转记录 origin/manualId 为空（不变）');
    // 无放量突破 → 不创建
    const ckLow = Object.assign({}, zone, { zoneCheck: { lastBreakDate: bars[bars.length - 2].date, lastBreakVr: 1.0, breakCount: 1 } });
    ok(zoneReversal.createRecordFromZone(ckLow, 'resistance', bars, null) === null, '无放量突破（vr=1.0）不创建反转记录');
    // 突破后回落 → 不创建
    const barsBack = makeBars({ lastClose: 10.2 });
    ok(zoneReversal.createRecordFromZone(zone, 'resistance', barsBack, null) === null, '突破后回落进区间（非仍在外侧）不创建反转记录');

    // 落盘→读取 字段保留
    zoneReversal.saveRecords(SYM, [recM]);
    const loaded = zoneReversal.loadRecords(SYM);
    ok(loaded.records.length === 1 && loaded.records[0].origin === 'manual' && loaded.records[0].manualId === 'mz_x1', 'loadRecords 保留 origin/manualId 字段');

    // purgeByManualId：只删匹配 manualId 的记录
    zoneReversal.saveRecords(SYM, [recM, recModel]);
    const p = zoneReversal.purgeByManualId(SYM, 'mz_x1');
    ok(p.ok && p.removed === 1, 'purgeByManualId 删除 1 条手动来源记录');
    const after = zoneReversal.loadRecords(SYM);
    ok(after.records.length === 1 && after.records[0].manualId == null, '模型来源记录保留，手动来源记录已清除');
    ok(zoneReversal.purgeByManualId(SYM, '').ok === false, '空 manualId 直接拒绝');
  }

  // ── §2 attach 集成 ─────────────────────────────────────────
  console.log('\n§2 attach 集成（手动并入 → 反转接入 → meta.reversed）');
  {
    // 用例A：手动阻力被放量突破且仍在外侧 → 反转
    cleanup();
    const add = _mzAdd(SYM, { side: 'resistance', low: 10, high: 10.5, note: '测试阻力' });
    ok(add.ok && add.zone, '手动阻力 10~10.5 添加成功');
    const bars = makeBars({});   // 突破日 close=10.8 vol=15000（vr=1.5），末根 close=10.9 仍在外侧
    const data = { shortTerm: { resistances: [], supports: [] } };
    priceActionHub.attachManualZones(data, finalizedBars(bars), SYM);
    const mzIn = data.shortTerm.resistances.find(z => z.isManual);
    ok(!!mzIn && mzIn.valid === true && !!mzIn.zoneCheck, '手动区间并入清单且通过标准1（放量突破不判无效）');
    zoneReversal.attachReversedZones(data, finalizedBars(bars), SYM);
    const gone = data.shortTerm.resistances.some(z => z.isManual);
    ok(gone === false, '被反转取代的原始手动条目已移出阻力清单');
    const rev = data.shortTerm.supports.find(z => z.isReversed);
    ok(!!rev && rev.low === 10 && rev.high === 10.5, '反转后的支撑区间出现在支撑清单（同几何）');
    ok(rev && rev.originManual === true && rev.source === '手动区间·放量突破反转', '反转区间标明手动来源（source/originManual）');
    const mrev = (data.manualZonesMeta || {}).reversed || [];
    ok(mrev.length === 1 && mrev[0].manualId === add.zone.id && mrev[0].to === 'support', 'manualZonesMeta.reversed 记录反转事件（manualId/to）');
    ok(data.manualZonesMeta.total === 1 && data.manualZonesMeta.valid === 0, 'manualZonesMeta 重算：被反转条目不再计入 valid');
    const persisted = zoneReversal.loadRecords(SYM);
    ok(persisted.records.length === 1 && persisted.records[0].origin === 'manual', '反转记录已落盘（origin=manual）');

    // 用例B：无放量突破 → 标准1 判无效，不反转、不创建记录
    cleanup();
    const addB = _mzAdd(SYM, { side: 'resistance', low: 10, high: 10.5, note: '无量突破' });
    const barsB = makeBars({ breakVol: 8000, breakClose: 10.8, lastClose: 10.9 });   // vr=0.8
    const dataB = { shortTerm: { resistances: [], supports: [] } };
    priceActionHub.attachManualZones(dataB, finalizedBars(barsB), SYM);
    const mzB = dataB.shortTerm.resistances.find(z => z.isManual);
    ok(mzB && mzB.valid === false && /无放量轻松穿越/.test((mzB.invalidReasons || []).join('')), '无放量突破 → 标准1 判无效并注明原因');
    zoneReversal.attachReversedZones(dataB, finalizedBars(barsB), SYM);
    ok(zoneReversal.loadRecords(SYM).records.length === 0, '无放量突破不创建反转记录');
    ok(dataB.shortTerm.resistances.some(z => z.isManual), '无效手动条目仍留在数据中（由前端按 valid===false 过滤不展示）');
    _mzRemove(SYM, addB.zone.id);
    zoneReversal.purgeByManualId(SYM, addB.zone.id);

    // 用例C：突破后回落到区间内 → 保留原区间、不反转
    cleanup();
    const addC = _mzAdd(SYM, { side: 'resistance', low: 10, high: 10.5, note: '冲高回落' });
    const barsC = makeBars({ breakVol: 15000, breakClose: 10.8, lastClose: 10.2 });
    const dataC = { shortTerm: { resistances: [], supports: [] } };
    priceActionHub.attachManualZones(dataC, finalizedBars(barsC), SYM);
    zoneReversal.attachReversedZones(dataC, finalizedBars(barsC), SYM);
    ok(dataC.shortTerm.resistances.some(z => z.isManual && z.valid !== false), '突破后回落（未站上外侧）→ 原手动阻力保留');
    ok(!(dataC.shortTerm.supports || []).some(z => z.isReversed), '未注入反转区间');
    ok(zoneReversal.loadRecords(SYM).records.length === 0, '回落场景无反转记录落盘');
    _mzRemove(SYM, addC.zone.id);
    zoneReversal.purgeByManualId(SYM, addC.zone.id);
  }

  // ── §3 删除联动 ────────────────────────────────────────────
  console.log('\n§3 删除联动（removeZone + purgeByManualId）');
  {
    cleanup();
    const add = _mzAdd(SYM, { side: 'resistance', low: 10, high: 10.5, note: '联动删除' });
    const bars = makeBars({});
    const zone = { low: 10, high: 10.5, zoneCheck: { lastBreakDate: bars[bars.length - 2].date, lastBreakVr: 1.5, breakCount: 1 } };
    const rec = zoneReversal.createRecordFromZone(zone, 'resistance', bars, { origin: 'manual', manualId: add.zone.id });
    zoneReversal.saveRecords(SYM, [rec]);
    ok(zoneReversal.loadRecords(SYM).records.length === 1, '前置：反转记录已落盘');
    _mzRemove(SYM, add.zone.id);
    zoneReversal.purgeByManualId(SYM, add.zone.id);
    ok(zoneReversal.loadRecords(SYM).records.length === 0, '删除手动区间后，其反转记录已联动清除（不会残留对侧区间）');
  }

  // ── §4 接线守卫 ────────────────────────────────────────────
  console.log('\n§4 接线守卫（顺序 / 路由 / 前端 / 版本）');
  {
    const hub = fs.readFileSync(path.join(ROOT, 'lib/priceActionHub.js'), 'utf8');
    const iM = hub.indexOf('attachManualZones(data, finalBars, symbol)');
    const iR = hub.indexOf('attachReversedZones(data, finalBars, symbol)');
    ok(iM >= 0 && iR > iM, 'priceActionHub：手动区间并入先于反转模块（20261105b 顺序）');
    const zr = fs.readFileSync(path.join(ROOT, 'lib/zoneReversal.js'), 'utf8');
    ok(!/\|\| z\.isManual/.test(zr), 'zoneReversal：不再跳过 isManual（手动区间接入反转）');
    ok(zr.indexOf('purgeByManualId') >= 0 && zr.indexOf("origin === 'manual'") >= 0, 'zoneReversal：purgeByManualId 与手动来源标注齐备');
    ok(zr.indexOf('manualZonesMeta.reversed') >= 0, 'zoneReversal：反转事件写入 manualZonesMeta.reversed');
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/purgeByManualId\(r\.data\.symbol, req\.params\.id\)/.test(server), 'server.js：删除路由联动 purgeByManualId');
    ok(/const APP_VERSION = '20261106p'/.test(server), "APP_VERSION = '20261106p'");
    const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    ok(app.indexOf('manualZonesMeta || {}).reversed') >= 0 || app.indexOf('manualZonesMeta).reversed') >= 0 || app.indexOf('revMap[r.manualId]') >= 0, 'app.js：手动页签消费 reversed 事件');
    ok(app.indexOf('pa-mz-badge reversed') >= 0, 'app.js：「已反转」徽标');
    ok(app.indexOf('originManual') >= 0, 'app.js：反转详情区分手动来源');
    const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
    ok(css.indexOf('.pa-mz-badge.reversed') >= 0, 'style.css：.pa-mz-badge.reversed 样式');
    const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const acc = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');
    ok(idx.indexOf('?v=20261106p') >= 0 && acc.indexOf('?v=20261106p') >= 0, 'index/accuracy 页面版本戳已对齐 20261106p');
  }

  cleanup();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); cleanup(); process.exit(1); });
