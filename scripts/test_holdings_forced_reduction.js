// 20260922h 验证：股东被动减持/司法强制执行 第④子模块 + 父因子困境溢价
// 运行：node scripts/test_holdings_forced_reduction.js
const { factorHoldings } = require('../lib/sameDayJudgment');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }

// 确定性的前十大股东：10 户各持 100 万股；3 户减持共 -30 万股，0 增持
// → magnitudeSignal = -0.03/0.03 = -1；directionSignal = (0-3)/10 = -0.3
// → 基线父信号 = 0.55*(-0.3) + 0.45*(-1) = -0.615
function buildHolders() {
  const arr = [];
  for (let i = 0; i < 10; i++) arr.push({ name: '股东' + i, holdAmount: 1000000, changeAmount: 0, endDate: '2026-06-30' });
  arr[0].name = '陈文义'; // 二股东
  arr[0].changeAmount = -100000;
  arr[1].changeAmount = -100000;
  arr[2].changeAmount = -100000;
  return { topShareholders: arr };
}
const NO_BUYBACK = { ok: false, count: 0 };

// 基线：无公告 → ④ 中性，父因子 = -0.615
const base = factorHoldings(buildHolders(), NO_BUYBACK, { announcements: [], news: [], companyName: '圣湘生物' });
const baseSignal = base.signal;
const baseSub4 = base.subFactors.find(s => s.name === '股东被动减持');
ok('无事件时父因子信号 = -0.615', approx(baseSignal, -0.615, 1e-9), baseSignal);
ok('无事件时第④子模块为中性(0)', baseSub4 && baseSub4.signal === 0, baseSub4 && baseSub4.signal);
ok('无事件时 caption 无雷点', base.caption.indexOf('⚠') === -1, base.caption);

// 已发生被动减持（公告命中股东姓名）
const annConfirmed = [{ title: '持股5%以上股东陈文义因司法强制执行被动减持公司股份', date: '2026-09-15' }];
const f1 = factorHoldings(buildHolders(), NO_BUYBACK, { announcements: annConfirmed, news: [], companyName: '圣湘生物' });
const s1 = f1.signal;
const sub4a = f1.subFactors.find(s => s.name === '股东被动减持');
ok('已发生被动减持：父因子比基线更负', s1 < baseSignal, { base: baseSignal, got: s1 });
ok('已发生被动减持：第④信号 = -0.8', approx(sub4a.signal, -0.8, 1e-9), sub4a.signal);
ok('已发生被动减持：第④ confirmed=true(stage=司法执行)', sub4a && sub4a.stage === '司法执行', sub4a && sub4a.stage);
ok('已发生被动减持：caption 含雷点 ⚠', f1.caption.indexOf('⚠') !== -1, f1.caption);
ok('已发生被动减持：value 标注「被动减持」', sub4a && /被动减持/.test(sub4a.value), sub4a && sub4a.value);

// 司法冻结/拍卖预告（未确认已减持）→ -0.6
const annRisk = [{ title: '第二大股东陈文义所持股份被司法冻结，存在司法拍卖风险', date: '2026-09-10' }];
const f2 = factorHoldings(buildHolders(), NO_BUYBACK, { announcements: annRisk, news: [], companyName: '圣湘生物' });
const sub4b = f2.subFactors.find(s => s.name === '股东被动减持');
ok('司法冻结预告：第④信号 = -0.6', approx(sub4b.signal, -0.6, 1e-9), sub4b.signal);
ok('司法冻结预告：第④ confirmed=false(stage=司法风险)', sub4b && sub4b.stage === '司法风险', sub4b && sub4b.stage);

// 别家公司公告不应误抓（标题无本股股东姓名/角色+公司名）
const annOther = [{ title: '某某科技 股东 司法强制执行被动减持', date: '2026-09-12' }];
const f3 = factorHoldings(buildHolders(), NO_BUYBACK, { announcements: annOther, news: [], companyName: '圣湘生物' });
const sub4c = f3.subFactors.find(s => s.name === '股东被动减持');
ok('别家公司公告不误抓（第④中性）', sub4c && sub4c.signal === 0, sub4c && sub4c.signal);

// 旧 2 参调用（无 opts）向后兼容：不崩溃、第④中性
const legacy = factorHoldings(buildHolders(), NO_BUYBACK);
ok('旧 2 参调用不崩溃且第④中性', legacy.subFactors.find(s => s.name === '股东被动减持').signal === 0);

// 圣湘真实口径回归锚点：报告期 2026-06-30、增0/减3/净变动 -347.70万股(占 -1.17%) 且无被动减持公告时，
// 父因子应 = 纯 0.55×方向 + 0.45×力度 基线（与 20260922 实盘 -0.3401 同量级），证明新增模块零副作用
function shengxiangHolders() {
  const arr = [];
  for (let i = 0; i < 10; i++) arr.push({ name: '股东' + i, holdAmount: 29700000, changeAmount: 0, endDate: '2026-06-30' });
  arr[0].name = '陈文义'; arr[0].changeAmount = -1159000; // 减
  arr[1].changeAmount = -1159000; arr[2].changeAmount = -1159000; // 共减 347.70 万股 = 3477000
  return { topShareholders: arr };
}
const sx = factorHoldings(shengxiangHolders(), NO_BUYBACK, { announcements: [], news: [], companyName: '圣湘生物' });
const sxRatio = -3477000 / 297000000; // 与上方 shengxiangHolders 净变动一致，避免魔数漂移
const sxMag = Math.max(-1, Math.min(1, sxRatio / 0.03));
const sxBase = 0.55 * (-0.3) + 0.45 * sxMag;
ok('圣湘回归锚点：无被动减持公告时第④子模块中性', sx.subFactors.find(s => s.name === '股东被动减持').signal === 0);
ok('圣湘回归锚点：父因子 = 纯0.55/0.45基线（零副作用）', approx(sx.signal, sxBase, 1e-6), sx.signal);

// ===== 20260922i：真实公告措辞（东财 np-anotice /ann 实际返回标题，修复「漏抓公告」）=====
// 真实标题来自东财接口，含「公司名:」前缀。验证第④子模块在真实口径下能命中。
const REAL_EXECUTED = '圣湘生物:圣湘生物科技股份有限公司关于原持股5%以上股东部分股份执行完成的结果公告'; // 2026-09-19 已执行
const REAL_PREVIEW = '圣湘生物:圣湘生物科技股份有限公司关于原持股5%以上股东部分股份拟被司法强制执行的提示性公告'; // 2026-08-11 预告
const REAL_EXCLUDE = '圣湘生物:圣湘生物科技股份有限公司关于大股东增持计划执行完成的公告'; // 利好语境，应被排除

// 直接用 detectForcedReduction 验证检测逻辑（真实标题无股东姓名，靠「角色词+公司名」命中）
const { detectForcedReduction } = require('../lib/sameDayJudgment');
const sxNames = shengxiangHolders().topShareholders.map(h => h.name);
const detExec = detectForcedReduction([{ title: REAL_EXECUTED, date: '2026-09-19' }], [], sxNames, '圣湘生物');
ok('真实标题·执行完成的结果公告 → 命中(confirmed)', detExec.events.length === 1 && detExec.confirmed === true, detExec);
ok('真实标题·执行完成的结果公告 → signal=-0.8', approx(detExec.signal, -0.8, 1e-9), detExec.signal);

const detPrev = detectForcedReduction([{ title: REAL_PREVIEW, date: '2026-08-11' }], [], sxNames, '圣湘生物');
ok('真实标题·拟被司法强制执行 → 命中(预览)', detPrev.events.length === 1 && detPrev.confirmed === false, detPrev);
ok('真实标题·拟被司法强制执行 → signal=-0.6', approx(detPrev.signal, -0.6, 1e-9), detPrev.signal);

const detExcl = detectForcedReduction([{ title: REAL_EXCLUDE, date: '2026-09-01' }], [], sxNames, '圣湘生物');
ok('真实标题·增持计划执行完成 → 被排除(中性)', detExcl.events.length === 0 && detExcl.signal === 0, detExcl);

// 经 factorHoldings 整链路：真实「执行完成」公告应使父因子更负并点亮 ⚠
const fReal = factorHoldings(shengxiangHolders(), NO_BUYBACK, { announcements: [{ title: REAL_EXECUTED, date: '2026-09-19' }], news: [], companyName: '圣湘生物' });
const sub4r = fReal.subFactors.find(s => s.name === '股东被动减持');
ok('真实·执行完成：第④子模块=-0.8', approx(sub4r.signal, -0.8, 1e-9), sub4r.signal);
ok('真实·执行完成：父因子比基线 (-0.3401) 更负', fReal.signal < sxBase - 1e-9, { base: sxBase, got: fReal.signal });
ok('真实·执行完成：caption 含 ⚠ 雷点', fReal.caption.indexOf('⚠') !== -1, fReal.caption);

console.log(`\n[test_holdings_forced_reduction] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
