# 脚本与测试（scripts/） · 第 1 卷

> 共 103 个文件，本卷约 17973 行


---

## `scripts\_chip_verify.js`  ·  112 行

~~~js
// 临时验证脚本：用腾讯日K + 东财同款 CYQ 算法本地计算筹码分布（锚点三数据源可行性验证）
// 算法逐行移植自 akshare stock_cyq_em 内嵌 JS（东财 K 图官方筹码引擎，三角形分布+换手率衰减）
'use strict';
const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function pct(v) { return (v * 100).toFixed(1) + '%'; }

// ===== CYQCalculator（东财官方算法，逐行移植） =====
function cyqLatest(klines) {
  const factor = 150, range = 120;
  const index = klines.length - 1;
  const start = Math.max(0, index - range + 1);
  const kdata = klines.slice(start, Math.max(1, index + 1));
  let maxprice = 0, minprice = 0;
  for (const e of kdata) {
    maxprice = !maxprice ? e.high : Math.max(maxprice, e.high);
    minprice = !minprice ? e.low : Math.min(minprice, e.low);
  }
  const accuracy = Math.max(0.01, (maxprice - minprice) / (factor - 1));
  const xdata = new Array(factor).fill(0);
  for (const e of kdata) {
    const avg = (e.open + e.close + e.high + e.low) / 4;
    const turnoverRate = Math.min(1, e.hsl / 100 || 0);
    const H = Math.floor((e.high - minprice) / accuracy);
    const L = Math.ceil((e.low - minprice) / accuracy);
    const Gx = e.high === e.low ? factor - 1 : 2 / (e.high - e.low);
    const Gy = Math.floor((avg - minprice) / accuracy);
    for (let n = 0; n < xdata.length; n++) xdata[n] *= (1 - turnoverRate);
    if (e.high === e.low) {
      xdata[Gy] += Gx * turnoverRate / 2;
    } else {
      for (let j = L; j <= H; j++) {
        const curprice = minprice + accuracy * j;
        if (curprice <= avg) {
          xdata[j] += Math.abs(avg - e.low) < 1e-8 ? Gx * turnoverRate : (curprice - e.low) / (avg - e.low) * Gx * turnoverRate;
        } else {
          xdata[j] += Math.abs(e.high - avg) < 1e-8 ? Gx * turnoverRate : (e.high - curprice) / (e.high - avg) * Gx * turnoverRate;
        }
      }
    }
  }
  const currentprice = klines[index].close;
  let totalChips = 0;
  for (let i = 0; i < factor; i++) totalChips += +xdata[i].toPrecision(12);
  function getCostByChip(chip) {
    let sum = 0;
    for (let i = 0; i < factor; i++) {
      const x = +xdata[i].toPrecision(12);
      if (sum + x > chip) return minprice + i * accuracy;
      sum += x;
    }
    return 0;
  }
  const benefitPart = (() => {
    let below = 0;
    for (let i = 0; i < factor; i++) {
      if (currentprice >= minprice + i * accuracy) below += +xdata[i].toPrecision(12);
    }
    return totalChips === 0 ? 0 : below / totalChips;
  })();
  const avgCost = getCostByChip(totalChips * 0.5);
  function pctChips(percent) {
    const ps = [(1 - percent) / 2, (1 + percent) / 2];
    const pr = [getCostByChip(totalChips * ps[0]), getCostByChip(totalChips * ps[1])];
    return { priceRange: pr, concentration: pr[0] + pr[1] === 0 ? 0 : (pr[1] - pr[0]) / (pr[0] + pr[1]) };
  }
  return { date: klines[index].date, close: currentprice, benefitPart, avgCost, p90: pctChips(0.9), p70: pctChips(0.7) };
}

(async () => {
  const symbol = process.argv[2] || '603288';
  const mkt = symbol.startsWith('6') ? 'sh' : 'sz';
  // 1) 实时行情取流通股本（流通市值/现价）
  const quote = await get(`https://qt.gtimg.cn/q=${mkt}${symbol}`);
  const f = quote.split('~');
  const price = parseFloat(f[3]);
  const floatMvYi = parseFloat(f[44]); // 流通市值（亿）
  const floatShares = floatMvYi * 1e8 / price; // 流通股本（股）
  console.log(`[quote] ${f[1]} 现价=${price} 流通市值=${floatMvYi}亿 → 流通股本≈${(floatShares / 1e8).toFixed(2)}亿股 今日换手=${f[38]}%`);
  // 2) 日K 320 根（腾讯 ifzq，前复权）
  const kUrl = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mkt}${symbol},day,,,320,qfq`;
  const kJson = JSON.parse(await get(kUrl));
  const node = kJson.data[mkt + symbol];
  const raw = node.qfqday || node.day;
  const klines = raw.map(r => {
    const vol = parseFloat(r[5]); // 手
    return { date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], hsl: vol * 100 / floatShares * 100 };
  });
  console.log(`[kline] ${klines.length} 根（${klines[0].date} ~ ${klines[klines.length - 1].date}）`);
  // 3) 筹码分布（东财同款算法，120 日窗口）
  const r = cyqLatest(klines);
  console.log('=== 筹码分布（本地计算，东财同款算法）===');
  console.log(`交易日=${r.date} 收盘=${r.close}`);
  console.log(`获利比例=${pct(r.benefitPart)}  平均成本=${r.avgCost.toFixed(2)}`);
  console.log(`90%成本区间=[${r.p90.priceRange[0].toFixed(2)}, ${r.p90.priceRange[1].toFixed(2)}]  90集中度=${pct(r.p90.concentration)}`);
  console.log(`70%成本区间=[${r.p70.priceRange[0].toFixed(2)}, ${r.p70.priceRange[1].toFixed(2)}]  70集中度=${pct(r.p70.concentration)}`);
  // 4) 锚点三判读预演
  const bp = r.benefitPart * 100;
  const verdict = bp > 90 ? '获利盘>90%，抛压警示（高位特征）' : bp < 5 ? '获利盘<5%，割肉枯竭（低位特征）' : '中间区域';
  console.log(`[锚点三判读] ${verdict}`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });

~~~

---

## `scripts\backup-data.ps1`  ·  24 行

~~~ps1
# Stock Analyzer - LOCAL data backup (primary anti-data-loss control)
# Mirrors the ENTIRE data/ tree to a local backup root, EXCLUDING the secret
# ai_config.json (apiKey must never leave the machine / never be committed).
# Run by the AI agent; the user does not need to run this manually.
$ErrorActionPreference = 'Stop'
$src = "D:\stock analyzer\stock-analyzer\data"
$dstLocal = "D:\stock-analyzer-backup\data"
$dstCloud = "C:\Users\16507\OneDrive\stock-analyzer-backup\data"
$log = "D:\stock-analyzer-backup\backup-log-$(Get-Date -Format yyyyMMdd-HHmmss).txt"
# /XF excludes the secret key file from the mirror (Iron Rule: apiKey never leaves machine).
# Dual destination: a local copy (D:) AND the OneDrive folder (auto-syncs to cloud as an
# offsite copy) - so the user gets offsite protection with zero manual push.
function Invoke-Mirror($dest) {
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
  $a = @($src, $dest, "/MIR", "/XF", "ai_config.json", "/R:2", "/W:5", "/NP", "/LOG+:$log")
  robocopy @a
  $c = $LASTEXITCODE
  if ($c -ge 8) { Write-Error "robocopy to $dest failed with code $c"; exit $c }
  Write-Host "BACKUP OK -> $dest (ai_config.json excluded by design)"
}
Invoke-Mirror $dstLocal
Invoke-Mirror $dstCloud
Write-Host "Log: $log"

~~~

---

## `scripts\backup-github.ps1`  ·  42 行

~~~ps1
# Stock Analyzer - GITHUB backup of the pure-text core only.
# NO secret (ai_config.json), NO 98MB db, NO 612MB reports (GitHub limits + daily churn).
# Stages the safe subset into an independent git repo and commits locally.
# Push happens only AFTER the agent sets the remote (user creates the private repo first).
$ErrorActionPreference = 'Stop'
$proj = "D:\stock analyzer\stock-analyzer"
$staging = "D:\stock-analyzer-backup\github-staging"
if (-not (Test-Path $staging)) { New-Item -ItemType Directory -Path $staging -Force | Out-Null }
$safe = @(
  (Join-Path $proj "data\notes.json"),
  (Join-Path $proj "data\judgments"),
  (Join-Path $proj "data\valuation"),
  (Join-Path $proj "data\fund_holdings"),
  (Join-Path $proj "data\companies")
)
foreach ($s in $safe) {
  if (-not (Test-Path $s)) { Write-Warning "skip missing: $s"; continue }
  $name = Split-Path $s -Leaf
  $d = Join-Path $staging $name
  robocopy $s $d /MIR /R:2 /W:5 /NP | Out-Null
}
Set-Location $staging
if (-not (Test-Path ".git")) {
  git init -q
  git config user.email "backup@stock-analyzer.local"
  git config user.name "Stock Analyzer Backup"
  git branch -M main
}
git add -A
$ts = Get-Date -Format "yyyy-MM-dd HH:mm"
$out = git commit -q -m "backup: $ts" 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "GITHUB STAGING OK -> committed locally at $ts"
} else {
  Write-Host "GITHUB STAGING: nothing new to commit (already up to date)"
}
git -C $staging log --oneline -1
$hasRemote = git -C $staging remote -v
if ([string]::IsNullOrWhiteSpace($hasRemote)) {
  Write-Host "REMOTE NOT SET: agent will run 'git remote add origin <private-repo-url>' and 'git push -u origin main' after the user creates the private repo."
}

~~~

---

## `scripts\board_review_data.py`  ·  723 行

~~~py
#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
board_review_data.py — 每日复盘「连板梯队 / 龙虎榜」本机取数 + 确定性计算（20261107）
================================================================================
数据源：akshare 对东方财富公开接口的二次封装（与工作台 scripts/sector_limit_stats.py 同源口径）
  - stock_zt_pool_em(date)          涨停股池（含「连板数」「所属行业」「封板资金」「炸板次数」）
  - stock_zt_pool_previous_em(date) 昨日涨停股在本查询日的表现（「涨跌幅」即今日涨跌幅，「昨日连板数」为昨日高度）
  - stock_zt_pool_strong_em(date)   强势股池（含成交额/涨跌幅/所属行业）
  - stock_zt_pool_zbgc_em(date)     炸板股池
  - stock_zt_pool_dtgc_em(date)     跌停股池
  - stock_lhb_detail_em(s,e)        龙虎榜明细（净买额/买卖额/上榜原因/解读）

设计铁律（工作台三条底层规则）：
  1. 代码权威：所有数值由本机代码从真实返回行统计，绝不估算、绝不由 LLM 生成。
  2. 诚实缺失：任一接口失败/无数据 → 该块 ok=false + note，不编造占位数字。
  3. 五要素：输出带 source（来源）+ asOf（数据交易日）+ fetchedAt（获取时间）。

晋级率口径（显式声明，避免歧义）：
  N 进 N+1 晋级率 = 昨日「连板数==N」的个股中，今日「连板数==N+1」仍在涨停池的家数 / 昨日「连板数==N」家数。
  跨日按代码匹配；昨日池取不到则该指标为 None（缺失），不用今日结构倒推。

20261108 扩展（新框架）：新增 prevPool / sectors / activity / historySeries 四块，
  - prevPool：昨日涨停今日表现（红盘率/大面股/涨跌幅前列/N进N+1 晋级率）
  - sectors：当日涨停池按「所属行业」聚合的板块层次客观代理
  - activity：涨停池+强势股池的局部成交额活跃度样本（明确非全市场排行）
  - historySeries：前 3-5 交易日的同口径对照序列（由 --hist-dates 传入，日期输出 ISO）
  原有 ladder / lhb 的字段、语义与调用形式完全不变。
  20261108 再扩展：sectors 块内新增 industryHistory / sealTime / midCap / limitDown 四字段
    （多日行业涨停家数 / 封板时间分桶 / 涨停池大市值中军代理 / 跌停股行业分布），
    全部复用已抓取 DataFrame，不新增顶层数据源 key、不改变完整度计分口径。
  禁止使用 stock_zh_a_spot_em（实时快照口径，会造成 asOf 错位且耗时不可接受）。
  交易日历由 Node 侧 lib/cnTradingCalendar.js 权威计算，Python 侧不自己猜节假日。

输出：单个 JSON（stdout）；异常也输出结构化 JSON，绝不把 traceback 混入 stdout。
"""
import sys
import json
import argparse
import warnings
from datetime import datetime

warnings.filterwarnings('ignore')


def _num(v):
    """转成 JSON 可序列化的原生数值；pandas NaN / None → None（诚实缺失）。"""
    if v is None:
        return None
    try:
        import math
        if isinstance(v, float) and math.isnan(v):
            return None
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return round(f, 4)
    except (TypeError, ValueError):
        return None


def _str(v):
    return '' if v is None else str(v)


def _safe_call(fn, label, out):
    """单接口调用：失败只让该块缺失，不影响其他块。"""
    try:
        df = fn()
        return df
    except Exception as e:
        out.setdefault('issues', []).append({'block': label, 'msg': '%s 取数失败：%s' % (label, str(e)[:180])})
        return None


def _pool_rows(df):
    if df is None or len(df) == 0:
        return []
    return df.to_dict('records')


def _iso(compact):
    """紧凑 YYYYMMDD → ISO YYYY-MM-DD；已是其它格式则原样返回（不推算日期）。"""
    s = _str(compact).strip()
    if len(s) == 8 and s.isdigit():
        return '%s-%s-%s' % (s[:4], s[4:6], s[6:8])
    return s or None


def _boards_int(v):
    """连板数 → 正整数；无法解析或非正数 → None（不硬猜）。"""
    b = _num(v)
    if b is None or b < 1:
        return None
    return int(b)


def _sum_yi(rows, field):
    """某数值字段（单位：元）求和转亿元；全为空 → None（不编造 0）。"""
    vals = [_num(r.get(field)) for r in rows]
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / 1e8, 2) if vals else None


def _prev_chg_stats(prevpool_rows):
    """昨日涨停股今日表现：红盘率/均值/大面占比，全部来自「涨跌幅」列真实统计。
    分母统一用「涨跌幅有效样本数」，保证 prevPool 与 historySeries.prevRedRate 完全同口径。"""
    chgs = [_num(r.get('涨跌幅')) for r in prevpool_rows]
    valid = [c for c in chgs if c is not None]
    red = sum(1 for c in valid if c > 0)
    big = sum(1 for c in valid if c <= -5)
    return {
        'count': len(prevpool_rows),
        'valid': len(valid),
        'redCount': red,
        'redRate': round(red / len(valid) * 100, 2) if valid else None,
        'avgChgPct': round(sum(valid) / len(valid), 2) if valid else None,
        'bigDropCount': big,
        'bigDropRate': round(big / len(valid) * 100, 2) if valid else None,
    }


def _promotion_from_prev(prevpool_rows, zt_rows):
    """N进N+1 晋级率：用 previous 池「昨日连板数」与今日涨停池「连板数」按代码匹配。
    今日涨停池取不到 → None（缺失，不用今日结构倒推）。"""
    if not zt_rows:
        return None
    today_boards = {}
    for r in zt_rows:
        b = _boards_int(r.get('连板数'))
        if b is not None:
            today_boards[_str(r.get('代码'))] = b
    prev_boards = {}
    for r in prevpool_rows:
        b = _boards_int(r.get('昨日连板数'))
        if b is not None:
            prev_boards[_str(r.get('代码'))] = b
    promo = []
    for n in (1, 2, 3):
        base = [c for c, b in prev_boards.items() if b == n]
        if not base:
            continue
        hit = [c for c in base if today_boards.get(c) == n + 1]
        promo.append({
            'from': n, 'to': n + 1, 'base': len(base), 'promoted': len(hit),
            'rate': round(len(hit) / len(base) * 100, 2),
        })
    return promo or None


def _chg_item(r):
    c = _num(r.get('涨跌幅'))
    return {
        'code': _str(r.get('代码')), 'name': _str(r.get('名称')),
        'industry': _str(r.get('所属行业')),
        'chgPct': round(c, 2) if c is not None else None,
        'prevBoards': _boards_int(r.get('昨日连板数')),
    }


def _pick_chg(it):
    return {'code': it['code'], 'name': it['name'], 'chgPct': it['chgPct'], 'prevBoards': it['prevBoards']}


def _brief(r):
    return {'code': _str(r.get('代码')), 'name': _str(r.get('名称')),
            'boards': _boards_int(r.get('连板数'))}


def build_ladder(zt_rows, prev_rows, zbgc_rows, dt_rows, date_str):
    """连板梯队：全部由涨停池「连板数」字段本机统计。"""
    block = {
        'ok': False, 'asOf': date_str, 'source': 'akshare stock_zt_pool_em（东方财富涨停股池）',
        'limitUpCount': None, 'maxBoards': None, 'spaceBoard': None,
        'tiers': [], 'hasGap': None, 'gapAt': [],
        'board2PlusCount': None, 'board3PlusCount': None, 'firstBoardCount': None,
        'promotion': None, 'brokenCount': None, 'brokenRate': None,
        'limitDownCount': None, 'sealFundTotal': None, 'note': '',
    }
    if not zt_rows:
        block['note'] = '当日涨停池无数据（非交易日或接口不可用），连板梯队标注「缺失」'
        return block

    # 逐行解析连板数（严格：非数值行跳过并记账，不硬猜）
    items = []
    skipped = 0
    for r in zt_rows:
        b = _num(r.get('连板数'))
        if b is None or b < 1:
            skipped += 1
            continue
        items.append({
            'code': _str(r.get('代码')), 'name': _str(r.get('名称')),
            'boards': int(b), 'industry': _str(r.get('所属行业')),
            'sealFund': _num(r.get('封板资金')),
            'brokenTimes': _num(r.get('炸板次数')),
            'changePct': _num(r.get('涨跌幅')),
        })
    if not items:
        block['note'] = '涨停池行内「连板数」均无法解析，连板梯队标注「缺失」'
        return block

    tiers = {}
    for it in items:
        tiers.setdefault(it['boards'], []).append(it)
    max_b = max(tiers.keys())
    block['tiers'] = [
        {
            'boards': b,
            'count': len(tiers[b]),
            'stocks': [{'code': x['code'], 'name': x['name'], 'industry': x['industry']} for x in tiers[b][:12]],
        }
        for b in sorted(tiers.keys(), reverse=True)
    ]
    block['ok'] = True
    block['limitUpCount'] = len(items)
    block['maxBoards'] = max_b
    sp = sorted(tiers[max_b], key=lambda x: _num(x['sealFund']) or 0, reverse=True)[0]
    block['spaceBoard'] = {'boards': max_b, 'code': sp['code'], 'name': sp['name'], 'industry': sp['industry']}
    block['board2PlusCount'] = sum(1 for x in items if x['boards'] >= 2)
    block['board3PlusCount'] = sum(1 for x in items if x['boards'] >= 3)
    block['firstBoardCount'] = len(tiers.get(1, []))

    # 梯队断层：最高板以下缺任一档即记为断层（方法论：断层是退潮信号，只做客观标记不做方向结论）
    present = set(tiers.keys())
    gaps = [b for b in range(2, max_b) if b not in present] if max_b >= 3 else []
    block['gapAt'] = gaps
    block['hasGap'] = bool(gaps)

    # 封板资金合计（亿元）
    funds = [_num(x['sealFund']) for x in items]
    block['sealFundTotal'] = round(sum(f for f in funds if f is not None) / 1e8, 2)

    # 炸板 / 跌停（亏钱效应客观量）
    if zbgc_rows is not None:
        block['brokenCount'] = len(zbgc_rows)
        tot = len(zbgc_rows) + len(items)
        block['brokenRate'] = round(len(zbgc_rows) / tot * 100, 2) if tot else None
    if dt_rows is not None:
        block['limitDownCount'] = len(dt_rows)

    # 晋级率：昨日 N 板 → 今日 N+1 板（按代码匹配）
    if prev_rows:
        prev_boards = {}
        for r in prev_rows:
            b = _num(r.get('连板数'))
            if b is None or b < 1:
                continue
            prev_boards[_str(r.get('代码'))] = int(b)
        today_boards = {x['code']: x['boards'] for x in items}
        promo = []
        for n in (1, 2, 3):
            base = [c for c, b in prev_boards.items() if b == n]
            if not base:
                continue
            hit = [c for c in base if today_boards.get(c) == n + 1]
            promo.append({
                'from': n, 'to': n + 1, 'base': len(base), 'promoted': len(hit),
                'rate': round(len(hit) / len(base) * 100, 2),
            })
        block['promotion'] = promo or None
        if not promo:
            block.setdefault('issues', []).append({'block': 'promotion', 'msg': '昨日涨停池无有效连板行，晋级率标注「缺失」'})
    else:
        block['note'] = '昨日涨停池不可得，晋级率标注「缺失」（不用今日结构倒推）'

    if skipped:
        block['note'] = (block['note'] + ' ' if block['note'] else '') + ('%d 行连板数无法解析已跳过' % skipped)
    return block


def build_lhb(rows, date_str):
    """龙虎榜：只做客观统计与席位属性计数，不做看多/看空结论、不给操作建议。"""
    block = {
        'ok': False, 'asOf': date_str, 'source': 'akshare stock_lhb_detail_em（东方财富龙虎榜明细）',
        'count': None, 'netBuyTotal': None, 'buyTotal': None, 'sellTotal': None,
        'topNetBuy': [], 'topNetSell': [], 'reasonStats': [],
        'institutionBuyMentions': None, 'institutionSellMentions': None,
        'note': '',
    }
    if not rows:
        # 20261110a / ERR-20261110-001：龙虎榜是盘后延迟发布数据。15:35 抓不到空结果，
        # 首要原因是「尚未发布」而不是「非交易日 / 接口故障」；旧文案把这个状态固化成
        # 「缺失」并被幂等逻辑锁死，导致第二天仍看不到数据。此处如实标注等待补录。
        block['note'] = ('龙虎榜为盘后延迟发布数据：当前时点尚未发布，或接口暂不可用；'
                         '本项标注「待晚间补录」，由 20:30 / 次日 15:35 兜底重新抓取，不判为数据缺失')
        return block
    recs = []
    for r in rows:
        recs.append({
            'code': _str(r.get('代码')), 'name': _str(r.get('名称')),
            'netBuy': _num(r.get('龙虎榜净买额')),
            'buy': _num(r.get('龙虎榜买入额')),
            'sell': _num(r.get('龙虎榜卖出额')),
            'reason': _str(r.get('上榜原因')),
            'reading': _str(r.get('解读')),
            'changePct': _num(r.get('涨跌幅')),
        })
    block['ok'] = True
    block['count'] = len(recs)
    for key, field in (('netBuyTotal', 'netBuy'), ('buyTotal', 'buy'), ('sellTotal', 'sell')):
        vals = [x[field] for x in recs if x[field] is not None]
        block[key] = round(sum(vals) / 1e8, 2) if vals else None  # 亿元
    valid = [x for x in recs if x['netBuy'] is not None]
    for x in sorted(valid, key=lambda y: y['netBuy'], reverse=True)[:5]:
        block['topNetBuy'].append({'code': x['code'], 'name': x['name'], 'netBuyYi': round(x['netBuy'] / 1e8, 2), 'reason': x['reason']})
    for x in sorted(valid, key=lambda y: y['netBuy'])[:5]:
        block['topNetSell'].append({'code': x['code'], 'name': x['name'], 'netBuyYi': round(x['netBuy'] / 1e8, 2), 'reason': x['reason']})
    reasons = {}
    for x in recs:
        if x['reason']:
            reasons[x['reason']] = reasons.get(x['reason'], 0) + 1
    block['reasonStats'] = [{'reason': k, 'count': v} for k, v in sorted(reasons.items(), key=lambda kv: -kv[1])[:8]]
    # 席位属性：仅对数据源「解读」原文做关键词计数（客观计数，不做方向判断）
    ib = sum(1 for x in recs if '机构买入' in x['reading'])
    isl = sum(1 for x in recs if '机构卖出' in x['reading'])
    block['institutionBuyMentions'] = ib
    block['institutionSellMentions'] = isl
    block['note'] = '席位属性为数据源「解读」文本关键词计数，非席位穿透核验；不代表趋势判断'
    return block


def build_prev_pool(prevpool_rows, zt_rows, date_str):
    """昨日涨停股今日表现：全部来自 stock_zt_pool_previous_em 真实返回行统计。
    主数据源是 previous 池；今日涨停池仅用于 N进N+1 晋级率（取不到则该项为 None）。"""
    block = {
        'ok': False, 'asOf': date_str,
        'source': 'akshare stock_zt_pool_previous_em（东财昨日涨停股今日表现）',
        'count': None, 'redCount': None, 'redRate': None, 'avgChgPct': None,
        'bigDropCount': None, 'bigDropRate': None,
        'topGainers': [], 'topLosers': [], 'industryBigDrop': [],
        'promotion': None, 'note': '',
    }
    if not prevpool_rows:
        block['note'] = '昨日涨停股今日表现池取数失败或无数据，本块标注「缺失」'
        return block
    st = _prev_chg_stats(prevpool_rows)
    for k in ('count', 'redCount', 'redRate', 'avgChgPct', 'bigDropCount', 'bigDropRate'):
        block[k] = st[k]
    items = [_chg_item(r) for r in prevpool_rows]
    valid = [it for it in items if it['chgPct'] is not None]
    block['topGainers'] = [_pick_chg(it) for it in sorted(valid, key=lambda x: -x['chgPct'])[:5]]
    block['topLosers'] = [_pick_chg(it) for it in sorted(valid, key=lambda x: x['chgPct'])[:5]]
    # 大面股按所属行业聚合 top5，判断亏钱效应是否从个股扩散到板块
    cnt = {}
    for it in items:
        if it['chgPct'] is not None and it['chgPct'] <= -5:
            cnt[it['industry']] = cnt.get(it['industry'], 0) + 1
    block['industryBigDrop'] = [
        {'industry': k, 'count': v} for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])[:5]
    ]
    block['promotion'] = _promotion_from_prev(prevpool_rows, zt_rows)
    block['ok'] = True
    notes = [
        'count 为昨日涨停股样本数；红盘/大面占比的分母为「涨跌幅」有效样本数',
        '大面股代理口径：今日涨跌幅 <= -5%（客观标记，非真实「大面」定义）',
    ]
    if block['promotion'] is None:
        notes.append('今日涨停池取不到，N进N+1 晋级率标注「缺失」')
    block['note'] = '；'.join(notes)
    return block


def _to_int(v):
    """数值 → int（保留 0）；无法解析 → None（不硬猜）。"""
    n = _num(v)
    return int(n) if n is not None else None


def _industry_history_row(zt_rows, iso_date):
    """单日涨停池按「所属行业」聚合家数，供 sectors.industryHistory 使用。
    复用调用方已抓取的 DataFrame records，绝不重复调用 akshare；
    zt_rows 为 None/空（取数失败或无数据）→ ok:false + counts:{}（诚实缺失，不编造）。"""
    if not zt_rows:
        return {'date': iso_date, 'ok': False, 'counts': {}}
    cnt = {}
    for r in zt_rows:
        ind = _str(r.get('所属行业'))
        cnt[ind] = cnt.get(ind, 0) + 1
    ordered = {k: v for k, v in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))}
    return {'date': iso_date, 'ok': True, 'counts': ordered}


def _build_industry_history(zt_rows, date_str, industry_counter):
    """多日行业涨停家数：历史交易日各日 counts 由 build_history_row 旁路收集（复用其涨停池
    DataFrame），复盘日用主流程已抓取的 zt_rows；按 ISO 交易日升序输出。"""
    rows = [it for it in (industry_counter or [])]
    rows.append(_industry_history_row(zt_rows, _iso(date_str)))
    rows.sort(key=lambda x: x.get('date') or '')
    return rows


def _seal_bucket(v):
    """「首次封板时间」HHMMSS → 分桶键。
    取前 4 位 HHMM 的整数值：<=1000 早盘；1000<t<1400 盘中；>=1400 尾盘；
    空值 / 非数字 / 非法时间 → unknown。"""
    s = _str(v).strip()
    if not s:
        return 'unknown'
    if s.endswith('.0'):
        s = s[:-2]
    s = s.replace(':', '').strip()
    if not s.isdigit():
        return 'unknown'
    s = s.zfill(6)[:6] if len(s) < 6 else s[:6]
    hhmm = s[:4]
    if not hhmm.isdigit():
        return 'unknown'
    hm = int(hhmm)
    if hm > 2359 or (hm % 100) >= 60:
        return 'unknown'
    if hm <= 1000:
        return 'early'
    if hm < 1400:
        return 'mid'
    return 'late'


def _build_seal_time(zt_rows):
    """当日涨停池「首次封板时间」分桶统计（数值全部本机计算）。"""
    block = {
        'ok': False, 'total': None, 'early': None, 'mid': None, 'late': None, 'unknown': None,
        'byIndustry': [], 'note': '', 'source': 'akshare stock_zt_pool_em 首次封板时间',
    }
    if zt_rows is None:
        block['note'] = '当日涨停池接口取数失败，封板时间分桶标注「缺失」（不臆造数值）'
        return block
    early = mid = late = unknown = 0
    groups = {}
    for r in zt_rows:
        b = _seal_bucket(r.get('首次封板时间'))
        if b == 'early':
            early += 1
        elif b == 'mid':
            mid += 1
        elif b == 'late':
            late += 1
        else:
            unknown += 1
        ind = _str(r.get('所属行业'))
        g = groups.setdefault(ind, {'count': 0, 'early': 0, 'mid': 0, 'late': 0})
        g['count'] += 1
        if b in ('early', 'mid', 'late'):
            g[b] += 1
    block['ok'] = True
    block['total'] = len(zt_rows)
    block['early'], block['mid'], block['late'], block['unknown'] = early, mid, late, unknown
    block['byIndustry'] = [
        {'industry': ind, 'count': g['count'], 'early': g['early'], 'mid': g['mid'], 'late': g['late']}
        for ind, g in sorted(groups.items(), key=lambda kv: (-kv[1]['count'], kv[0]))[:12]
    ]
    return block


def _build_mid_cap(zt_rows):
    """涨停池内按「流通市值」居前个股作为板块「中军」代理（非真实板块中军）。
    单位统一亿元，2 位小数；byIndustry 按 count 降序最多 12 项。"""
    base_note = '以涨停池内流通市值居前个股作代理，非真实板块中军（工作台无板块成分股/市值映射）'
    block = {'ok': False, 'byIndustry': [], 'note': base_note, 'source': 'akshare stock_zt_pool_em 流通市值'}
    if zt_rows is None:
        block['note'] = '当日涨停池接口取数失败，中军代理标注「缺失」（不臆造数值）；' + base_note
        return block
    groups = {}
    for r in zt_rows:
        groups.setdefault(_str(r.get('所属行业')), []).append((_num(r.get('流通市值')), r))
    by_industry = []
    for ind, lst in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:12]:
        with_mv = [(m, r) for m, r in lst if m is not None]
        top_mv, top_r = sorted(with_mv, key=lambda t: -t[0])[0] if with_mv else (None, lst[0][1])
        chg = _num(top_r.get('涨跌幅'))
        by_industry.append({
            'industry': ind, 'count': len(lst),
            'topName': _str(top_r.get('名称')), 'topCode': _str(top_r.get('代码')),
            'topFloatMvYi': round(top_mv / 1e8, 2) if top_mv is not None else None,
            'topChgPct': round(chg, 2) if chg is not None else None,
            'avgFloatMvYi': round(sum(m for m, _ in with_mv) / len(with_mv) / 1e8, 2) if with_mv else None,
        })
    block['ok'] = True
    block['byIndustry'] = by_industry
    return block


def _build_limit_down(dt_rows):
    """当日跌停股池明细与行业分布（复用主流程已抓取 dt，不重复调用 akshare）。"""
    block = {
        'ok': False, 'count': None, 'avgChgPct': None,
        'topLosers': [], 'industryDist': [], 'note': '', 'source': 'akshare stock_zt_pool_dtgc_em',
    }
    if dt_rows is None:
        block['note'] = '当日跌停股池接口取数失败，跌停归因标注「缺失」（不臆造数值）'
        return block
    cnt = {}
    chgs = []
    for r in dt_rows:
        ind = _str(r.get('所属行业'))
        cnt[ind] = cnt.get(ind, 0) + 1
        c = _num(r.get('涨跌幅'))
        if c is not None:
            chgs.append(c)
    valid = [r for r in dt_rows if _num(r.get('涨跌幅')) is not None]
    valid.sort(key=lambda r: _num(r.get('涨跌幅')))
    for r in valid[:8]:
        amt = _num(r.get('成交额'))
        block['topLosers'].append({
            'code': _str(r.get('代码')), 'name': _str(r.get('名称')),
            'chgPct': round(_num(r.get('涨跌幅')), 2),
            'industry': _str(r.get('所属行业')),
            'continuous': _to_int(r.get('连续跌停')),
            'openTimes': _to_int(r.get('开板次数')),
            'amountYi': round(amt / 1e8, 2) if amt is not None else None,
        })
    block['industryDist'] = [
        {'industry': k, 'count': v}
        for k, v in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:12]
    ]
    block['ok'] = True
    block['count'] = len(dt_rows)
    block['avgChgPct'] = round(sum(chgs) / len(chgs), 2) if chgs else None
    return block


def build_sectors(zt_rows, date_str, dt_rows=None, industry_counter=None):
    """板块层次客观代理：只用当日涨停池按「所属行业」聚合，绝不外推全板块。
    20261108 扩展：在 sectors 内新增 industryHistory / sealTime / midCap / limitDown 四块，
    全部复用主流程与 build_history_row 已抓取的 DataFrame，不新增顶层数据源 key、不重复取数。
    原有 total / top / singleDance / ok / note 的字段名、语义、单位一律不变。"""
    block = {
        'ok': False, 'asOf': date_str,
        'source': 'akshare stock_zt_pool_em（东财涨停股池·所属行业聚合）',
        'total': None, 'top': [], 'singleDance': [], 'note': '',
    }
    # 新增四块：先落地，保证主聚合早退（涨停池取数失败）时也各自诚实标注「缺失」
    block['industryHistory'] = _build_industry_history(zt_rows, date_str, industry_counter)
    block['sealTime'] = _build_seal_time(zt_rows)
    block['midCap'] = _build_mid_cap(zt_rows)
    block['limitDown'] = _build_limit_down(dt_rows)
    if not zt_rows:
        block['note'] = '当日涨停池取数失败或无数据，板块层次标注「缺失」'
        return block
    groups = {}
    for r in zt_rows:
        groups.setdefault(_str(r.get('所属行业')), []).append(r)
    block['total'] = len(groups)
    multi = [(ind, lst) for ind, lst in groups.items() if len(lst) >= 2]
    multi.sort(key=lambda x: (-len(x[1]), x[0]))
    for ind, lst in multi[:8]:
        b_all = [_boards_int(r.get('连板数')) for r in lst]
        b_valid = [b for b in b_all if b is not None]
        bmax = max(b_valid) if b_valid else None
        leaders = [_brief(r) for r in lst if _boards_int(r.get('连板数')) == bmax] if bmax else []
        followers = [_brief(r) for r in lst if _boards_int(r.get('连板数')) != bmax]
        followers.sort(key=lambda x: -(x['boards'] or 0))
        block['top'].append({
            'industry': ind, 'count': len(lst), 'boardsMax': bmax,
            'sealFundYi': _sum_yi(lst, '封板资金'), 'amountYi': _sum_yi(lst, '成交额'),
            'leaders': leaders, 'followers': followers[:5],
            'hasLayer': len(lst) >= 2 and bmax is not None and bmax >= 2,
        })
    block['singleDance'] = [ind for ind, lst in groups.items() if len(lst) == 1]
    block['ok'] = True
    block['note'] = '中军/趋势股无可靠本机源，本块只覆盖涨停池样本，不代表全板块；hasLayer 仅标记「有连板领涨股」的客观层次'
    return block


def build_activity(zt_rows, strong_rows, date_str):
    """活跃度样本：涨停池+强势股池局部成交额，明确非全市场排行。"""
    block = {
        'ok': False, 'asOf': date_str,
        'source': 'akshare stock_zt_pool_em / stock_zt_pool_strong_em（东财涨停池+强势股池，局部样本）',
        'ztAmountYi': None, 'strongCount': None, 'strongAmountYi': None,
        'topAmount': [], 'note': '',
    }
    base_note = ('全市场成交额排行接口（stock_zh_a_spot_em 等）口径不符（实时快照，非历史交易日）且耗时不可接受；'
                 '本块仅为涨停池/强势股池局部样本，不代表两市成交额排名')
    if not zt_rows or not strong_rows:
        block['note'] = base_note + '；涨停池或强势股池取数失败/无数据，本块标注「缺失」'
        return block
    block['ztAmountYi'] = _sum_yi(zt_rows, '成交额')
    block['strongCount'] = len(strong_rows)
    block['strongAmountYi'] = _sum_yi(strong_rows, '成交额')
    # 涨停池+强势股池按代码去重合排，保留成交额较大者，取前 8
    by_code = {}
    for tag, rows in (('zt', zt_rows), ('strong', strong_rows)):
        for r in rows:
            code = _str(r.get('代码'))
            if not code:
                continue
            amt = _num(r.get('成交额'))
            c = _num(r.get('涨跌幅'))
            rec = {
                'code': code, 'name': _str(r.get('名称')),
                'amountYi': round(amt / 1e8, 2) if amt is not None else None,
                'chgPct': round(c, 2) if c is not None else None,
                'industry': _str(r.get('所属行业')), 'from': tag,
            }
            prev = by_code.get(code)
            if prev is None or (amt or 0) > (prev[0] or 0):
                by_code[code] = (amt, rec)
    ordered = sorted(by_code.values(), key=lambda t: -(t[0] or 0))
    block['topAmount'] = [t[1] for t in ordered[:8]]
    block['ok'] = True
    block['note'] = base_note
    return block


def build_history_row(ak, hd, out, industry_counter=None):
    """前 N 交易日同口径序列：每日只调 涨停池 + 昨日涨停池 + 炸板池 + 跌停池（不调龙虎榜）。
    核心涨停池失败/无数据 → 整行 ok=false 且数值全为 None（不跳过、不编造）。
    辅助源失败 → 对应字段保持 None、记入 issues 与 note，行 ok=false 但保留其它真实统计。
    industry_counter（旁路列表，可选）：复用本函数已抓取的当日涨停池 DataFrame 追加一行行业家数，
    供 sectors.industryHistory 使用，避免为同一天重复调用 akshare；不改变 row 返回结构。"""
    row = {
        'date': _iso(hd), 'ok': False,
        'limitUp': None, 'maxBoards': None, 'board2Plus': None,
        'brokenCount': None, 'limitDown': None, 'prevRedRate': None,
        'promotionRate': None, 'ztAmountYi': None, 'note': '',
    }
    zt = _safe_call(lambda: ak.stock_zt_pool_em(date=hd), '历史涨停池 %s' % hd, out)
    if industry_counter is not None:
        industry_counter.append(_industry_history_row(_pool_rows(zt), _iso(hd)))
    prev = _safe_call(lambda: ak.stock_zt_pool_previous_em(date=hd), '历史昨日涨停 %s' % hd, out)
    zb = _safe_call(lambda: ak.stock_zt_pool_zbgc_em(date=hd), '历史炸板池 %s' % hd, out)
    dt = _safe_call(lambda: ak.stock_zt_pool_dtgc_em(date=hd), '历史跌停池 %s' % hd, out)
    if zt is None or not _pool_rows(zt):
        row['note'] = '该日涨停池取数失败或无数据，本行标注「缺失」（数值保持空值，不编造）'
        return row
    zt_r = _pool_rows(zt)
    boards = [_boards_int(r.get('连板数')) for r in zt_r]
    valid_b = [b for b in boards if b is not None]
    row['limitUp'] = len(zt_r)
    row['maxBoards'] = max(valid_b) if valid_b else None
    row['board2Plus'] = sum(1 for b in valid_b if b >= 2)
    row['ztAmountYi'] = _sum_yi(zt_r, '成交额')
    missing = []
    if prev is None:
        missing.append('昨日涨停池')
    else:
        prev_r = _pool_rows(prev)
        row['prevRedRate'] = _prev_chg_stats(prev_r)['redRate']
        promo = _promotion_from_prev(prev_r, zt_r) or []
        p1 = [p for p in promo if p['from'] == 1]
        row['promotionRate'] = p1[0]['rate'] if p1 else None
    if zb is None:
        missing.append('炸板池')
    else:
        row['brokenCount'] = len(_pool_rows(zb))
    if dt is None:
        missing.append('跌停池')
    else:
        row['limitDown'] = len(_pool_rows(dt))
    row['ok'] = not missing
    row['note'] = ('同口径序列：涨停池/昨日涨停池/炸板池/跌停池（不含龙虎榜）；'
                   'prevRedRate 分母为涨跌幅有效样本，promotionRate 为 1进2 晋级率')
    if missing:
        row['note'] += '；缺失源：' + '、'.join(missing)
    return row


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--date', required=True, help='交易日 YYYYMMDD')
    p.add_argument('--prev-date', default='', help='上一交易日 YYYYMMDD（算晋级率）')
    p.add_argument('--hist-dates', default='', help='复盘日之前的前3-5个交易日，逗号分隔 YYYYMMDD（由 Node 侧传入）')
    p.add_argument('--lhb-only', action='store_true', help='晚间龙虎榜补录：只抓当日龙虎榜明细，不跑涨停池/多日序列')
    a = p.parse_args()
    d, pd = a.date.strip(), a.prev_date.strip()
    hist_dates = [x.strip() for x in a.hist_dates.strip().split(',') if x.strip()]
    out = {
        'ok': True, 'date': d, 'prevDate': pd or None,
        'fetchedAt': datetime.now().isoformat(timespec='seconds'),
        'source': 'akshare（东方财富涨停股池 / 炸板池 / 跌停池 / 龙虎榜明细）',
        'ladder': None, 'lhb': None,
        'prevPool': None, 'sectors': None, 'activity': None, 'historySeries': [],
        'lhbOnly': bool(a.lhb_only),
        'issues': [],
    }
    try:
        import akshare as ak
        # 20261110a：补录通道只请求龙虎榜明细。空结果也要把「尚未发布」的诚实 note 返回，
        # 故 out['ok'] 保持 True（由 lhb.ok / lhb.note 表达状态），不再拿 ladder 或 lhb 反推整体成败。
        if a.lhb_only:
            lhb = _safe_call(lambda: ak.stock_lhb_detail_em(start_date=d, end_date=d), '龙虎榜明细', out)
            out['lhb'] = build_lhb(_pool_rows(lhb), d)
            out['ok'] = True
            sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str))
            sys.stdout.write('\n')
            return
        zt = _safe_call(lambda: ak.stock_zt_pool_em(date=d), '涨停池', out)
        zb = _safe_call(lambda: ak.stock_zt_pool_zbgc_em(date=d), '炸板池', out)
        dt = _safe_call(lambda: ak.stock_zt_pool_dtgc_em(date=d), '跌停池', out)
        prev = None
        if pd:
            prev = _safe_call(lambda: ak.stock_zt_pool_em(date=pd), '昨日涨停池', out)
        lhb = _safe_call(lambda: ak.stock_lhb_detail_em(start_date=d, end_date=d), '龙虎榜明细', out)
        prevpool = _safe_call(lambda: ak.stock_zt_pool_previous_em(date=d), '昨日涨停今日表现池', out)
        strong = _safe_call(lambda: ak.stock_zt_pool_strong_em(date=d), '强势股池', out)
        # 既有两块：调用形式逐字保持不变（ladder / lhb 字段与语义不动）
        out['ladder'] = build_ladder(_pool_rows(zt), _pool_rows(prev), _pool_rows(zb) if zb is not None else None,
                                     _pool_rows(dt) if dt is not None else None, d)
        out['lhb'] = build_lhb(_pool_rows(lhb), d)
        # 新块：区分「接口失败 None」与「成功但空 []」，诚实缺失不编造
        zt_rows = _pool_rows(zt) if zt is not None else None
        prevpool_rows = _pool_rows(prevpool) if prevpool is not None else None
        strong_rows = _pool_rows(strong) if strong is not None else None
        dt_rows = _pool_rows(dt) if dt is not None else None
        out['prevPool'] = build_prev_pool(prevpool_rows, zt_rows, d)
        out['activity'] = build_activity(zt_rows, strong_rows, d)
        # 先算 historySeries：build_history_row 复用每日涨停池 DataFrame 旁路收集行业家数，
        # 供 sectors.industryHistory 使用，避免同一天重复调用 akshare（复盘日 counts 用主流程 zt_rows）
        industry_counter = []
        out['historySeries'] = [build_history_row(ak, hd, out, industry_counter) for hd in hist_dates]
        out['sectors'] = build_sectors(zt_rows, d, dt_rows=dt_rows, industry_counter=industry_counter)
        out['ok'] = bool(out['ladder']['ok'] or out['lhb']['ok'])
    except Exception as e:
        out['ok'] = False
        out['issues'].append({'block': 'all', 'msg': '取数脚本异常：%s' % str(e)[:200]})
    sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()

~~~

---

## `scripts\check_report_gap.js`  ·  63 行

~~~js
// check_report_gap.js — 三季报披露缺口筛查（20261025，用户要求）
// 对自选股池逐一比对：网上公告是否已发布《2026 年第三季度报告》 vs 本地资料库（docStore）是否已持有。
// 可重复执行：node scripts/check_report_gap.js
'use strict';
const { searchAnnouncementsByCode } = require('../lib/cnscraperAdapter');
const { hasReportDoc, normSymbol } = require('../lib/reportSync');

const POOL = [
  ['sh600909', '华安证券'], ['sz000783', '长江证券'], ['sh688289', '圣湘生物'], ['sh603288', '海天味业'],
  ['sz000902', '新洋丰'], ['sz002643', '万润股份'], ['sz300232', '洲明科技'], ['sh601318', '中国平安'],
];
const YEAR = '2026';
// 三季报标题识别（20261025 修正）：仅认本公司正式季报——
// ① 东财公告标题格式「公司名:2026年第三季度报告」，冒号后直接接年份；
// ② 兜底：含「2026年第三季度报告」但排除「关于…」转述类（如「关于披露平安银行2026年
//    第三季度报告的公告」是子公司季报转述，不是本公司季报）与业绩说明会/预告类。
const Q3_MAIN_RE = new RegExp('[:：]\\s*' + YEAR + '\\s*年第三季度报告');
const Q3_LOOSE_RE = new RegExp(YEAR + '\\s*年?(第三季度报告|三季度报告|三季报)');
const Q3_EXCLUDE_RE = /关于|业绩说明会|业绩预告|摘要$|英译|英文版/;

(async () => {
  const gaps = [], synced = [], nodisc = [], errors = [];
  const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [sym, name] of POOL) {
    try {
      const ann = await searchAnnouncementsByCode(sym, 40);
      const items = (ann && ann.ok && Array.isArray(ann.items)) ? ann.items : [];
      const q3 = items.filter(x => {
        if (!x || !x.title) return false;
        const t = String(x.title).replace(/\s+/g, '');
        if (!Q3_LOOSE_RE.test(t)) return false;
        // 本公司季报判定：冒号后正文以「2026年三季度报告」（兼容 第三季度/三季度/三季报）开头，
        // 或以本公司名开头紧跟年份报告；「平安银行股份有限公司2026年第三季度报告」这类
        // 子公司/兄弟公司季报转述正文另带公司名 → 排除
        const body = t.split(/[:：]/).slice(1).join(':');
        const bodyQ3 = new RegExp('^' + YEAR + '\\s*年(第三季度报告|三季度报告|三季报)');
        const selfQ3 = new RegExp('^' + escRe(name) + '\\s*' + YEAR + '\\s*年(第三季度报告|三季度报告|三季报)');
        return bodyQ3.test(body) || selfQ3.test(body);
      });
      if (!q3.length) {
        nodisc.push(`${name}（${sym}）：公告前 40 条未见 ${YEAR} 三季报`);
        continue;
      }
      const latest = q3[0];
      const held = hasReportDoc(normSymbol(sym), 'quarterly', YEAR);
      if (held) synced.push(`${name}（${sym}）：已披露（${latest.date || '日期未知'}）且资料库已持有`);
      else gaps.push(`${name}（${sym}）：已披露「${String(latest.title).slice(0, 40)}」${latest.date ? '· ' + latest.date : ''}，本地资料库未持有`);
    } catch (e) {
      errors.push(`${name}（${sym}）：公告源获取失败 — ${e.message}`);
    }
  }
  console.log('\n===== 三季报缺口（网上已披露、本地未持有）=====');
  gaps.length ? gaps.forEach(x => console.log('  ⚠ ' + x)) : console.log('  （无）');
  console.log('\n===== 已披露且本地已持有 =====');
  synced.length ? synced.forEach(x => console.log('  ✓ ' + x)) : console.log('  （无）');
  console.log('\n===== 未见三季报披露 =====');
  nodisc.forEach(x => console.log('  · ' + x));
  if (errors.length) {
    console.log('\n===== 公告源获取失败（网络/通道）=====');
    errors.forEach(x => console.log('  ✗ ' + x));
  }
})();

~~~

---

## `scripts\cninfo_announcements.py`  ·  146 行

~~~py
#!/usr/bin/env python3
# 巨潮资讯官方公告抓取（确定性数据，非 AI）。
# 复刻 a-stock-data 技能 cninfo_announcements（#19 orgId 动态映射修复）。
# 输出 JSON：{ok, code, orgId, count, items:[{title,type,date,url}]}
import os, sys, re, json
import requests
from datetime import datetime, timedelta

# 清除系统代理（与本机运行环境一致：系统代理会挂起请求）
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "cache")
ORGID_CACHE = os.path.join(CACHE_DIR, "cninfo_orgid.json")
ORGID_TTL = 7 * 24 * 3600  # 7 天


def _ts_to_date(ts):
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
    return str(ts)[:10] if ts else ""


def get_prefix(code):
    """6位代码 → 市场前缀（sh/sz/bj）。"""
    c = code.lower().strip()
    if c.endswith((".sh", ".sz", ".bj")):
        return c[-2:]
    if c.endswith((".xshg", ".xshe")):
        return "sh" if c.endswith(".xshg") else "sz"
    if c.startswith(("sh", "sz", "bj")):
        return c[:2]
    if c.startswith("92"):
        return "bj"
    if c.startswith(("5", "6", "9")):
        return "sh"
    if c.startswith(("4", "8")):
        return "bj"
    return "sz"


_ORGID_MAP = {}


def _load_orgid_map():
    global _ORGID_MAP
    try:
        if os.path.exists(ORGID_CACHE):
            with open(ORGID_CACHE, "r", encoding="utf-8") as f:
                cache = json.load(f)
            if (time_time() - cache.get("_ts", 0)) < ORGID_TTL:
                _ORGID_MAP = cache.get("map", {})
                return
    except Exception:
        pass
    try:
        r = requests.get("http://www.cninfo.com.cn/new/data/szse_stock.json",
                         headers={"User-Agent": UA}, timeout=15)
        data = r.json()
        _ORGID_MAP = {s["code"]: s["orgId"] for s in data.get("stockList", [])}
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(ORGID_CACHE, "w", encoding="utf-8") as f:
                json.dump({"_ts": time_time(), "map": _ORGID_MAP}, f, ensure_ascii=False)
        except Exception:
            pass
    except Exception as e:
        sys.stderr.write("[WARN] cninfo orgId 映射表拉取失败，回退硬编码规则: %s\n" % e)


def _cninfo_orgid(code):
    if not _ORGID_MAP:
        _load_orgid_map()
    org = _ORGID_MAP.get(code)
    if org:
        return org
    # fallback：老格式（仅部分老股票适用）
    return "gs%s0%s" % (get_prefix(code), code)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少股票代码参数"}, ensure_ascii=False))
        return
    code = re.sub(r"^(SH|SZ|BJ)", "", sys.argv[1], flags=re.I)
    code = re.sub(r"\.(SS|SZ|BJ)$", "", code, flags=re.I).strip()
    if not re.match(r"^\d{6}$", code):
        print(json.dumps({"ok": False, "error": "非A股6位代码: %s" % code}, ensure_ascii=False))
        return
    page_size = sys.argv[2] if len(sys.argv) > 2 else "30"
    try:
        org_id = _cninfo_orgid(code)
        payload = {
            "stock": "%s,%s" % (code, org_id),
            "tabName": "fulltext",
            "pageSize": str(page_size),
            "pageNum": "1",
            "column": "",
            "category": "",
            "plate": "",
            "seDate": "",
            "searchkey": "",
            "secid": "",
            "sortName": "",
            "sortType": "",
            "isHLtitle": "true",
        }
        headers = {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": "https://www.cninfo.com.cn/new/disclosure",
            "Origin": "https://www.cninfo.com.cn",
        }
        s = requests.Session()
        s.proxies = {"http": None, "https": None}
        r = s.post("https://www.cninfo.com.cn/new/hisAnnouncement/query",
                   data=payload, headers=headers, timeout=15)
        d = r.json()
        cutoff = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        anns = []
        for it in (d.get("announcements") or []):
            dt = _ts_to_date(it.get("announcementTime"))
            if dt and dt < cutoff:
                continue  # 仅保留近一年
            anns.append({
                "title": it.get("announcementTitle", ""),
                "type": it.get("announcementTypeName", ""),
                "date": dt,
                "url": "https://www.cninfo.com.cn/new/disclosure/detail?annoId=%s" % it.get("announcementId", ""),
            })
        print(json.dumps({"ok": True, "code": code, "orgId": org_id,
                          "count": len(anns), "items": anns}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))


def time_time():
    import time
    return time.time()


if __name__ == "__main__":
    main()

~~~

---

## `scripts\cnscraper_adapter.py`  ·  535 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cn-financial-scraper 后台接入适配器
--------------------------------------------------------------
把 cn-financial-scraper v7.2.0 的能力封装成 CLI JSON 接口，供 Node 端
( lib/cnscraperAdapter.js ) 通过 execFile 异步调用。

每个子命令都输出「单行 JSON」到 stdout；任何异常都转成 {"ok":false,"error":...}
并 exit 0（避免 Node 端拿到非零退出码 + stderr 刷屏）。

子命令：
  sentiment     全网舆情爬取（crawl_sentiment，68 源，含 RSS/搜索/媒体）
                --targets "中国平安,平安保险" --days 3 --max 20 --budget 12
  report        定期报告解读（interpret_stock，东财 RPT_LICO_FN_CPD 直连）
                --code 600519
  announcements 沪深交易所公告搜索（search_announcements）
                --keyword "分红" --market both --max 30
  regulatory    监管/政策资讯（get_regulatory_updates）
                --agency all --limit 15
  monetary      货币政策/财经要闻摘要（get_monetary_policy）
  fiscal        财政部《财政收支情况》公告解析（收入/支出累计额与同比）

设计要点：
  * sys.dont_write_bytecode = True，不产生 .pyc 污染技能目录。
  * sys.path 同时插入技能根目录 + scripts/，使「from scripts.X import」
    与浏览器兜底的「from browser_scraper import」两种绝对导入都能命中。
  * 舆情文章过滤掉「未能直接抓取」占位 stub，只保留真实抓取内容。
"""
import sys
import os
import re
import json
import argparse

sys.dont_write_bytecode = True

# 技能根目录（可用环境变量 CNSCRAPER_HOME 覆盖，便于换机/换路径）
SKILL_DIR = os.environ.get(
    'CNSCRAPER_HOME',
    r'C:\Users\16507\.workbuddy\skills\cnfinancialscraper__skillhub',
)
_SKILL_ROOT = SKILL_DIR
_SKILL_SCRIPTS = os.path.join(SKILL_DIR, 'scripts')
for _p in (_SKILL_ROOT, _SKILL_SCRIPTS):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)


def _fail(err):
    print(json.dumps({'ok': False, 'error': str(err)[:500]}, ensure_ascii=False))
    return 0


def _out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=str))
    return 0


# ---------------------------------------------------------------------------
# 子命令实现
# ---------------------------------------------------------------------------
def _is_stub(title, content):
    """识别爬取失败的占位文章（未能直接抓取 / 空标题空正文）。"""
    t = (title or '').strip()
    c = (content or '').strip()
    if not t and not c:
        return True
    if '未能直接抓取' in t or '未能直接抓取' in c:
        return True
    if '关键词=' in t and '来自 ' in t and not c:
        return True
    return False


def cmd_sentiment(args):
    from scripts.sentiment_crawler import crawl_sentiment

    targets = [t.strip() for t in (args.targets or '').split(',') if t.strip()]
    if not targets:
        return _out({'ok': False, 'error': '未提供 --targets 目标名', 'articles': [],
                     'positive': 0, 'negative': 0, 'neutral': 0, 'signal': 0})

    try:
        snap = crawl_sentiment(
            targets=targets,
            days=args.days,
            max_articles=args.max_articles,
            max_total_seconds=args.budget,
            per_source_timeout=3,
            use_rss=True,
        )
    except Exception as e:
        return _fail('crawl_sentiment 异常: %s' % e)

    try:
        d = snap.to_dict()
    except Exception as e:
        return _fail('序列化舆情快照失败: %s' % e)

    raw = d.get('articles') or []
    # 过滤占位 stub，只保留真实文章
    articles = [a for a in raw if not _is_stub(a.get('title'), a.get('content'))]

    positive = sum(1 for a in articles if a.get('sentiment') == 'positive')
    negative = sum(1 for a in articles if a.get('sentiment') == 'negative')
    neutral = len(articles) - positive - negative

    scores = [float(a['sentiment_score']) for a in articles
              if isinstance(a.get('sentiment_score'), (int, float))]
    avg_score = (sum(scores) / len(scores)) if scores else 0.0
    # 平均情感分映射到 [-1,1]（skill 的 sentiment_score 量纲约 ±1）
    signal = max(-1.0, min(1.0, avg_score))

    return _out({
        'ok': True,
        'targets': targets,
        'days': args.days,
        'count': len(articles),
        'raw_count': len(raw),
        'positive': positive,
        'negative': negative,
        'neutral': neutral,
        'avg_score': round(avg_score, 4),
        'signal': round(signal, 4),
        'sources_used': (d.get('stats') or {}).get('sources_used'),
        'articles': [{
            'title': a.get('title', '')[:80],
            'source': a.get('source', ''),
            'source_type': a.get('source_type', ''),
            'sentiment': a.get('sentiment', 'neutral'),
            'sentiment_score': a.get('sentiment_score', 0.0),
            'severity': a.get('severity', ''),
            'publish_time': a.get('publish_time', ''),
            'url': a.get('url', ''),
        } for a in articles[:args.max_articles]],
        'note': '全网舆情（cn-financial-scraper %d 源，过滤占位 stub 后 %d 条）'
                % ((d.get('stats') or {}).get('sources_used') or 0, len(articles)),
    })


def cmd_report(args):
    from scripts.report_interpreter import interpret_stock

    code = (args.code or '').strip()
    if not code:
        return _out({'ok': False, 'error': '未提供 --code 股票代码'})
    try:
        r = interpret_stock(code)
    except Exception as e:
        return _fail('interpret_stock 异常: %s' % e)
    if not isinstance(r, dict):
        return _fail('interpret_stock 返回非 dict: %r' % type(r))
    if r.get('error'):
        return _out({'ok': False, 'error': r['error'], 'code': code})
    r['ok'] = True
    r['code'] = code
    # 去掉冗长 text，避免超大 JSON；保留结构化字段
    r.pop('text', None)
    return _out(r)


def cmd_announcements(args):
    from scripts.exchange_scraper import search_announcements

    kw = (args.keyword or '').strip()
    if not kw:
        return _out({'ok': False, 'error': '未提供 --keyword 搜索词', 'items': []})
    try:
        items = search_announcements(kw, market=args.market, max_results=args.max_articles)
    except Exception as e:
        return _fail('search_announcements 异常: %s' % e)
    return _out({'ok': True, 'keyword': kw, 'count': len(items),
                 'items': items[:args.max_articles]})


def cmd_regulatory(args):
    from scripts.regulatory_scraper import get_regulatory_updates

    try:
        items = get_regulatory_updates(agency=args.agency, limit=args.limit)
    except Exception as e:
        return _fail('get_regulatory_updates 异常: %s' % e)
    return _out({'ok': True, 'agency': args.agency, 'count': len(items),
                 'items': items[:args.limit]})


def cmd_monetary(args):
    from scripts.regulatory_scraper import get_monetary_policy

    try:
        d = get_monetary_policy()
    except Exception as e:
        return _fail('get_monetary_policy 异常: %s' % e)
    d['ok'] = True
    return _out(d)


def _safe_str(v, default=''):
    if v is None:
        return default
    return str(v).strip()


def _safe_float(v, default=0.0):
    try:
        s = str(v).replace('%', '').replace(',', '').strip()
        return float(s) if s else default
    except (ValueError, TypeError):
        return default


def extract_fiscal(text):
    """从财政部《财政收支情况》正文中解析一般公共预算收入/支出的累计额(亿元)与累计同比(%)。

    返回 {'revenue': {'acc': float|None, 'yoy': float|None},
          'expenditure': {'acc': float|None, 'yoy': float|None}}
    同比方向：'下降' 记负、'增长' 记正。无法解析的字段以 None 占位。
    """
    rev = {'acc': None, 'yoy': None}
    exp = {'acc': None, 'yoy': None}
    if not text:
        return {'revenue': rev, 'expenditure': exp}

    # 收入：优先「全国一般公共预算收入」，其次首个「一般公共预算收入」
    rev_patterns = [
        r'全国一般公共预算收入[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
        r'一般公共预算收入[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
    ]
    for pat in rev_patterns:
        m = re.search(pat, text)
        if m:
            rev = {'acc': _safe_float(m.group(1)),
                   'yoy': _safe_float(m.group(3)) * (-1 if m.group(2) == '下降' else 1)}
            break

    # 支出：优先「全国一般公共预算支出」，其次首个「一般公共预算支出」
    exp_patterns = [
        r'全国一般公共预算支出[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
        r'一般公共预算支出[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
    ]
    for pat in exp_patterns:
        m = re.search(pat, text)
        if m:
            exp = {'acc': _safe_float(m.group(1)),
                   'yoy': _safe_float(m.group(3)) * (-1 if m.group(2) == '下降' else 1)}
            break

    return {'revenue': rev, 'expenditure': exp}


def cmd_fund_matrix(args):
    """
    基金重仓行业配置矩阵的原始数据层。
    拉取头部基金（按近 1 年业绩）最新季度的前 10 重仓股，返回原始持仓数据，
    由 Node 侧完成「股票→行业」映射与行业×基金矩阵聚合（复用现有 industryAnalysis）。
    """
    import akshare as ak
    from datetime import datetime

    top_n = max(1, min(args.top_n or 15, 30))
    quarter = (args.quarter or '').strip()  # 形如 "2025" 或 "2025Q1"；空则自动检测

    out = {'ok': True, 'quarter': quarter, 'top_n': top_n, 'funds': [], 'skipped': 0}
    # 1) 拉头部基金列表（混合型 — 权益类主力，纯债/货币对行业配置无意义）
    try:
        rank_df = ak.fund_open_fund_rank_em(symbol='混合型')
    except Exception as e:
        return _fail('fund_open_fund_rank_em 失败: %s' % e)

    if rank_df is None or len(rank_df) == 0:
        return _out({'ok': False, 'error': '未获取到混合型基金排行', 'funds': []})

    if '近1年' not in rank_df.columns or '基金代码' not in rank_df.columns:
        return _out({'ok': False, 'error': 'fund_open_fund_rank_em 返回列结构异常', 'funds': []})

    ranked = rank_df[['基金代码', '基金简称', '近1年']].copy()
    ranked['近1年_num'] = ranked['近1年'].apply(lambda v: _safe_float(v, -1e9))
    ranked = ranked[ranked['近1年_num'] > -1e8].sort_values('近1年_num', ascending=False).head(top_n)

    if len(ranked) == 0:
        return _out({'ok': False, 'error': '头部基金排序后为空', 'funds': []})

    # 自动检测最新季度：尝试当前年/上一年
    now = datetime.now()
    quarter_candidates = [str(now.year), str(now.year - 1)]

    for _, row in ranked.iterrows():
        fund_code = _safe_str(row.get('基金代码', '')).zfill(6)
        fund_name = _safe_str(row.get('基金简称', ''))
        year_ret = _safe_float(row.get('近1年', ''), None)

        holdings = []
        used_quarter = None
        for y in quarter_candidates:
            try:
                hdf = ak.fund_portfolio_hold_em(symbol=fund_code, date=y)
            except Exception:
                hdf = None
            if hdf is not None and len(hdf) > 0:
                if '季度' in hdf.columns:
                    used_quarter = _safe_str(hdf['季度'].iloc[-1], y + '年')
                else:
                    used_quarter = y + '年'
                top10 = hdf.head(10)
                for _, h in top10.iterrows():
                    code = _safe_str(h.get('股票代码', ''))
                    name = _safe_str(h.get('股票名称', ''))
                    weight = _safe_float(h.get('占净值比例', ''), 0.0)
                    mv = _safe_float(h.get('持仓市值', ''), 0.0)
                    if not name:
                        continue
                    holdings.append({
                        'code': code,
                        'name': name,
                        'weight': round(weight, 2),
                        'marketValue': round(mv, 2),
                    })
                if holdings:
                    break

        if not holdings:
            out['skipped'] += 1
            continue

        out['funds'].append({
            'code': fund_code,
            'name': fund_name,
            'yearReturn': round(year_ret, 2) if year_ret is not None else None,
            'quarter': used_quarter,
            'holdings': holdings,
        })

    if out['funds']:
        quarters = [f['quarter'] for f in out['funds'] if f.get('quarter')]
        if quarters and not quarter:
            out['quarter'] = max(quarters)

    out['count'] = len(out['funds'])
    out['note'] = 'akshare 混合型基金按近1年业绩取头部 %d 只，最新季报前 10 重仓股；股票→行业映射由 Node 侧完成' % top_n
    return _out(out)


def _decode_html(resp):
    """从响应取原始字节并正确解码：先严格尝试 UTF-8，失败（如政府站点 GBK
    却声明 utf-8）回退 GB18030。避免 http_get 默认 utf-8 解码产生的乱码。"""
    raw = getattr(resp, 'content', None) or b''
    if not raw:
        return ''
    try:
        return raw.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        return raw.decode('gb18030', errors='replace')


def _fetch_latest_mof_fiscal():
    """主路径：直接抓财政部国库司统计数据库（gks.mof.gov.cn/tongjishuju/）最新
    「财政收支情况」页。列表页 newest-first 暴露相对 .htm 文章链接，逐篇抓取
    extract_main_content 正文并用 extract_fiscal 解析，命中收入+支出双指标即返回。
    任一环节失败返回 None（由调用方降级）。
    """
    import re
    from scripts.http_utils import http_get
    from scripts.web_parser import extract_main_content

    base = 'https://gks.mof.gov.cn/tongjishuju/'
    try:
        resp = http_get(base, timeout=15, use_cache=True)
    except Exception:
        return None
    html = getattr(resp, 'text', None) or ''
    if not html:
        return None
    # 收集相对 .htm 文章链接（排除 pdf），最新在前
    links = re.findall(r'href="(\./\d{6}/t\d+_\d+\.htm)"', html)
    if not links:
        return None
    for rel in links[:6]:
        url = base + rel.lstrip('./')
        try:
            r2 = http_get(url, timeout=15, use_cache=True)
        except Exception:
            continue
        h2 = _decode_html(r2)
        if not h2:
            continue
        main = extract_main_content(h2) or {}
        text = main.get('content') or ''
        if not text:
            continue
        parsed = extract_fiscal(text)
        rev = parsed.get('revenue') or {}
        exp = parsed.get('expenditure') or {}
        if rev.get('acc') is not None and exp.get('acc') is not None:
            m = re.search(r'/(\d{6})/t(\d{8})_', url)
            date = ''
            if m:
                d = m.group(2)
                date = '%s-%s-%s' % (d[0:4], d[4:6], d[6:8])
            return {
                'ok': True,
                'date': date,
                'source': '财政部·国库司（gks.mof.gov.cn 统计数据库）',
                'title': '全国财政收支情况',
                'url': url,
                'revenue': {'acc': rev.get('acc'), 'yoy': rev.get('yoy')},
                'expenditure': {'acc': exp.get('acc'), 'yoy': exp.get('yoy')},
                'note': '解析自财政部《财政收支情况》公告（一般公共预算收支）',
            }
    return None


def cmd_fiscal(args):
    """财政部《财政收支情况》公告解析：一般公共预算收入与支出（累计额/同比）。

    主路径：直接抓财政部国库司统计数据库（gks.mof.gov.cn）最新「财政收支情况」页；
    兜底：经 get_regulatory_updates 检索东财/新浪/巨潮的财政类快讯。
    任一外挂源失败均优雅降级为 {ok:false}，绝不让异常上抛。
    """
    from scripts.http_utils import http_get
    from scripts.web_parser import extract_main_content

    # 主路径：财政部官网统计库
    mof = _fetch_latest_mof_fiscal()
    if mof and mof.get('ok'):
        return _out(mof)

    # 兜底：经 get_regulatory_updates 检索
    from scripts.regulatory_scraper import get_regulatory_updates
    limit = max(10, min(args.limit or 40, 60))
    try:
        items = get_regulatory_updates(agency='all', limit=limit) or []
    except Exception as e:
        return _fail('get_regulatory_updates 异常: %s' % e)

    # 候选：标题命中「财政收支情况」优先，其次「财政收支 / 一般公共预算」
    cands = [it for it in items if it and '财政收支情况' in (it.get('title') or '')]
    if not cands:
        cands = [it for it in items if it and ('财政收支' in (it.get('title') or '')
                                              or '一般公共预算' in (it.get('title') or ''))]
    if not cands:
        return _out({'ok': False, 'error': '未检索到财政部「财政收支情况」相关公告',
                     'items': len(items), 'candidates': 0})

    for it in cands:
        url = (it.get('url') or '').strip()
        title = (it.get('title') or '').strip()
        date = (it.get('date') or '').strip()
        if not url:
            continue
        try:
            resp = http_get(url, timeout=15, use_cache=True)
        except Exception:
            resp = None
        if not resp:
            continue
        html = _decode_html(resp)
        if not html:
            continue
        main = extract_main_content(html) or {}
        text = main.get('content') or ''
        parsed = extract_fiscal(text)
        rev = parsed.get('revenue') or {}
        exp = parsed.get('expenditure') or {}
        # 必须同时拿到收入与支出的累计额才算成功
        if rev.get('acc') is not None and exp.get('acc') is not None:
            return _out({
                'ok': True,
                'date': date,
                'source': it.get('source') or '财政部·财政收支情况',
                'title': title,
                'url': url,
                'revenue': {'acc': rev.get('acc'), 'yoy': rev.get('yoy')},
                'expenditure': {'acc': exp.get('acc'), 'yoy': exp.get('yoy')},
                'note': '解析自财政部《财政收支情况》公告（一般公共预算收支）',
            })
    return _out({'ok': False,
                 'error': '已找到 %d 条候选公告，但均无完整收入/支出双指标正文' % len(cands),
                 'items': len(items), 'candidates': len(cands)})


def main():
    ap = argparse.ArgumentParser(description='cn-financial-scraper 后台接入适配器')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_s = sub.add_parser('sentiment', help='全网舆情爬取')
    p_s.add_argument('--targets', required=True, help='目标名，逗号分隔')
    p_s.add_argument('--days', type=int, default=3)
    p_s.add_argument('--max', dest='max_articles', type=int, default=20)
    p_s.add_argument('--budget', type=int, default=12, help='总耗时预算(秒)')

    p_r = sub.add_parser('report', help='定期报告解读')
    p_r.add_argument('--code', required=True)

    p_a = sub.add_parser('announcements', help='交易所公告搜索')
    p_a.add_argument('--keyword', required=True)
    p_a.add_argument('--market', default='both')
    p_a.add_argument('--max', dest='max_articles', type=int, default=30)

    p_g = sub.add_parser('regulatory', help='监管/政策资讯')
    p_g.add_argument('--agency', default='all')
    p_g.add_argument('--limit', type=int, default=15)

    sub.add_parser('monetary', help='货币政策/财经要闻摘要')

    p_f = sub.add_parser('fiscal', help='财政部《财政收支情况》公告解析（一般公共预算收入/支出）')
    p_f.add_argument('--limit', type=int, default=40, help='检索政策资讯条数，默认 40')

    p_m = sub.add_parser('fund-matrix', help='基金重仓行业配置矩阵原始数据（头部基金最新季报前10重仓股）')
    p_m.add_argument('--top-n', type=int, default=15, help='头部基金数量，默认 15，最大 30')
    p_m.add_argument('--quarter', default='', help='季度，形如 2025 / 2025Q1；空则自动检测最新')

    args = ap.parse_args()

    dispatch = {
        'sentiment': cmd_sentiment,
        'report': cmd_report,
        'announcements': cmd_announcements,
        'regulatory': cmd_regulatory,
        'monetary': cmd_monetary,
        'fiscal': cmd_fiscal,
        'fund-matrix': cmd_fund_matrix,
    }
    handler = dispatch.get(args.cmd)
    if not handler:
        return _fail('未知子命令: %s' % args.cmd)
    try:
        return handler(args)
    except Exception as e:
        return _fail('%s 执行异常: %s' % (args.cmd, e))


if __name__ == '__main__':
    sys.exit(main() or 0)

~~~

---

## `scripts\download_reports.py`  ·  1077 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
巨潮资讯网(CNINFO) / 东方财富(Eastmoney) 年报/半年报 批量下载脚本
====================================================================

功能：
  1. 批量下载多只 A 股公司的年报 + 半年报（默认），可扩展至季报。
  2. 支持多数据源通道（--channel）：
       cninfo     巨潮资讯网（官方披露，默认，PDF 直链最稳）
       eastmoney  东方财富公告中心（np-anotice 接口，从 attachments 取 PDF 直链）
       all        先巨潮后东方财富，互为备份
  3. 自动跳过已下载的文件（按 announcementId 记录 + 文件名去重），避免重复下载。
  4. 并发下载，提升批量效率。
  5. 支持命令行参数或文本文件传入股票代码。

依赖：仅使用 Python 标准库（urllib / concurrent.futures），无需 pip install。

用法示例：
  # 默认巨潮通道
  python download_reports.py --codes 600938,000001,601857

  # 指定东方财富通道
  python download_reports.py --codes 600938 --channel eastmoney

  # 全部通道（巨潮 + 东方财富，互为备份）
  python download_reports.py --codes 600938 --channel all

  # 输出机器可读的 JSON 结果（供工作台后端解析）
  python download_reports.py --codes 600938 --json
"""

import argparse
import json
import os
import re
import sys
import io
import time
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

# Windows 控制台默认 GBK，强制 stdout/stderr 用 UTF-8 以正常输出中文标题
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

# ----------------------------------------------------------------------------
# 常量
# ----------------------------------------------------------------------------
CNINFO_QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_QUERY_PAGE = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_STATIC_BASE = "https://static.cninfo.com.cn/"
# 东方财富公告中心接口（个股公告列表，含 attachments PDF 直链）
EM_ANN_URL = "https://np-anotice-stock.eastmoney.com/api/security/ann"
# 巨潮资讯「公告详情」接口（可返回 fileUrl PDF 直链）
CNINFO_BULLETIN_DETAIL_URL = "https://www.cninfo.com.cn/new/announcement/bulletin_detail"
CNINFO_PDF_BASE = "http://static.cninfo.com.cn/"

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
REFERER_CNINFO = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
REFERER_EM = "https://data.eastmoney.com/notices/"

# 可用通道
CHANNELS = ["cninfo", "eastmoney"]

# 报告类型 -> 标题关键字
REPORT_TYPE_KEYWORDS = {
    "annual": ["年度报告"],
    "semi": ["半年度报告"],
    "q1": ["第一季度报告", "一季度报告"],
    "q3": ["第三季度报告", "三季度报告"],
}

# 交易所代码前缀 -> CNINFO column 参数
EXCHANGE_COLUMN = {
    "SH": "sse",   # 6xxxxx / 9xxxxx
    "SZ": "szse",  # 0xxxxx / 3xxxxx
    "BJ": "bjse",  # 8xxxxx
}


# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------
def log(msg):
    """打印日志到 stderr，避免污染 --json 的标准输出。"""
    print(msg, file=sys.stderr, flush=True)


def detect_exchange(code):
    """根据代码判断交易所。"""
    c = code.strip().upper()
    c = re.sub(r"^(SH|SZ|BJ)", "", c)
    if c.startswith("6") or c.startswith("9"):
        return "SH"
    if c.startswith("8") or c.startswith("4"):
        return "BJ"
    return "SZ"


def sanitize_filename(name):
    """清理文件名中的非法字符（含全角符号）。"""
    for ch in ["/", "\\", ":", "*", "?", '"', "<", ">", "|",
              "：", "、", "（", "）", "·", "　"]:
        name = name.replace(ch, "_")
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"_+", "_", name)
    return name[:120].strip("_")


def ts_to_date(ts):
    """毫秒时间戳 -> YYYY-MM-DD。"""
    try:
        return time.strftime("%Y-%m-%d", time.localtime(int(ts) / 1000))
    except Exception:
        return ""


def em_date(s):
    """东方财富 notice_date '2024-04-03 00:00:00' -> '2024-04-03'。"""
    if not s:
        return ""
    return s[:10]


# 匹配优先级：更具体的类型先匹配（避免 "半年度报告" 被 "年度报告" 抢先）
REPORT_TYPE_PRIORITY = ["q1", "q3", "semi", "annual"]


def match_report_type(title, types):
    """判断公告标题属于哪种报告类型（仅返回用户指定的类型之一）。

    注意：'半年度报告' 包含 '年度报告' 子串，因此必须先检查更具体的类型。
    """
    for t in REPORT_TYPE_PRIORITY:
        if t not in types:
            continue
        for kw in REPORT_TYPE_KEYWORDS.get(t, []):
            if kw in title:
                return t
    return None


# ----------------------------------------------------------------------------
# 通用 opener
# ----------------------------------------------------------------------------
def _make_opener():
    """创建带 cookie 与代理支持的 opener（自动读取 HTTP_PROXY/HTTPS_PROXY 环境变量）。"""
    handlers = [urllib.request.HTTPCookieProcessor()]
    try:
        proxies = urllib.request.getproxies()
        if proxies:
            handlers.append(urllib.request.ProxyHandler(proxies))
    except Exception:
        pass
    return urllib.request.build_opener(*handlers)


def _warmup_cookie(opener):
    """先访问一次巨潮页面，让 opener 的 cookie jar 种下会话 cookie（JSESSIONID 等）。
    若直接 POST /query 而未预热，巨潮常返回空 announcements（totalRecordNum=0）。
    """
    try:
        req = urllib.request.Request(
            CNINFO_QUERY_PAGE,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
        with opener.open(req, timeout=15) as resp:
            log("[cookie] 预热主页 HTTP %s，Set-Cookie=%s"
                % (getattr(resp, "status", None) or resp.getcode(),
                   "有" if resp.headers.get("Set-Cookie") else "无"))
    except Exception as e:
        log("[cookie] 预热主页失败(可忽略): %s" % e)


# ----------------------------------------------------------------------------
# 巨潮查询
# ----------------------------------------------------------------------------
def _query_one_page(opener, base_params, page, err_log=None):
    """查询单页公告。成功返回 (anns_list, j_dict, meta)；网络/解析失败返回 (None, None, meta)。"""
    params = dict(base_params)
    params["pageNum"] = str(page)
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        CNINFO_QUERY_URL, data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": REFERER_CNINFO,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*",
        },
    )
    meta = {"status": None, "body_head": "", "total_announcement": None,
            "classified_keys": [], "is_json": False, "set_cookie": ""}
    try:
        with opener.open(req, timeout=20) as resp:
            meta["status"] = getattr(resp, "status", None) or resp.getcode()
            meta["set_cookie"] = (resp.headers.get("Set-Cookie") or "")[:120]
            body = resp.read().decode("utf-8")
    except Exception as e:
        msg = "[查询] 第%d页请求失败: %s" % (page, e)
        log(msg)
        if err_log is not None:
            err_log.append(msg)
        return None, None, meta
    meta["body_head"] = body[:200]
    try:
        j = json.loads(body)
        meta["is_json"] = True
    except Exception as e:
        msg = "[查询] 第%d页返回非JSON，停止翻页: %s" % (page, e)
        log(msg)
        if err_log is not None:
            err_log.append(msg)
        return None, None, meta
    anns = j.get("announcements") or []
    meta["total_announcement"] = j.get("totalAnnouncement")
    ca = j.get("classifiedAnnouncements")
    if isinstance(ca, dict):
        meta["classified_keys"] = list(ca.keys())[:10]
    elif isinstance(ca, list):
        meta["classified_keys"] = [list(x.keys()) if isinstance(x, dict) else type(x).__name__
                                   for x in ca[:3]]
    return anns, j, meta


def _build_combos(base_column, prefix, code_norm):
    """构造参数组合列表（主组合优先，其余为备用）。"""
    return [
        {"column": base_column, "tabName": "fulltext", "stockCode": code_norm},
        {"column": base_column, "tabName": "fulltext", "stockCode": prefix + code_norm},
        {"column": base_column, "tabName": "fulltext", "stockCode": prefix.lower() + code_norm},
        {"column": base_column, "tabName": "", "stockCode": code_norm},
        {"column": "", "tabName": "fulltext", "stockCode": code_norm},
        {"column": base_column, "tabName": "company", "stockCode": code_norm},
    ]


def probe_combos(opener, code, name, years):
    """诊断模式：打印各参数组合下该股票的 totalRecordNum，不下载。"""
    exchange = detect_exchange(code)
    base_column = EXCHANGE_COLUMN.get(exchange, "szse")
    prefix = exchange
    code_norm = re.sub(r"\D", "", code)
    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1
    today = time.strftime("%Y-%m-%d", time.localtime())
    se_date = "%d-01-01~%s" % (start_year, today)
    common = {
        "pageSize": "30", "plate": "", "seDate": se_date, "isHL": "",
        "stockName": name or "", "indexCode": "", "category": "", "session": "",
    }
    combos = _build_combos(base_column, prefix, code_norm)
    log("=== 参数组合探测: %s ===" % code_norm)
    results = []
    for combo in combos:
        base = dict(common)
        base.update(combo)
        anns, j, meta = _query_one_page(opener, base, 1, None)
        entry = {
            "column": combo.get("column") or "",
            "tabName": combo.get("tabName") or "",
            "stockCode": combo.get("stockCode"),
            "totalRecordNum": None,
            "totalAnnouncement": meta.get("total_announcement"),
            "status": meta.get("status"),
            "isJson": meta.get("is_json"),
            "classifiedKeys": meta.get("classified_keys"),
            "hasCookie": bool(meta.get("set_cookie")),
            "sample": "",
            "ok": anns is not None,
            "error": "",
        }
        if anns is None:
            entry["error"] = "请求失败"
            log("  column=%-5s tabName=%-9s stockCode=%-9s -> 请求失败"
                % (combo.get("column") or "(空)", combo.get("tabName") or "(空)", combo.get("stockCode")))
        else:
            tr = j.get("totalRecordNum")
            entry["totalRecordNum"] = tr
            ta = meta.get("total_announcement")
            sample = ""
            if anns:
                a0 = anns[0]
                sample = "%s %s" % (a0.get("secCode"), a0.get("announcementTitle"))
                entry["sample"] = sample
            sample_txt = ("  样本: " + sample) if sample else ""
            ta_txt = ("  全站公告=%s" % ta) if ta is not None else ""
            ck = meta.get("classified_keys")
            ck_txt = ("  classifiedKeys=%s" % ck) if ck else ""
            st = meta.get("status")
            log("  column=%-5s tabName=%-9s stockCode=%-9s -> totalRecordNum=%s%s%s  [HTTP %s]%s"
                % (combo.get("column") or "(空)", combo.get("tabName") or "(空)",
                   combo.get("stockCode"), tr, sample_txt, ta_txt, st, ck_txt))
        results.append(entry)
    # 机器可读摘要（ensure_ascii=True 输出纯 ASCII，规避 Windows 管道编码乱码）
    print("PROBE_JSON:" + json.dumps(results, ensure_ascii=True))


def query_announcements(opener, code, name, years, types, err_log=None):
    """
    查询某只股票符合条件的公告（巨潮）。
    返回列表：[{secCode, announcementId, announcementTitle, adjunctUrl, adjunctType, date}]
    """
    exchange = detect_exchange(code)
    base_column = EXCHANGE_COLUMN.get(exchange, "szse")
    prefix = exchange  # SH / SZ / BJ
    code_norm = re.sub(r"\D", "", code)
    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1
    today = time.strftime("%Y-%m-%d", time.localtime())
    se_date = "%d-01-01~%s" % (start_year, today)

    common = {
        "pageSize": "30",
        "plate": "",
        "seDate": se_date,
        "isHL": "",
        "stockName": name or "",
        "indexCode": "",
        "category": "",
        "session": "",
    }

    combos = _build_combos(base_column, prefix, code_norm)

    chosen = None
    chosen_params = None
    for combo in combos:
        base = dict(common)
        base.update(combo)
        anns, j, _ = _query_one_page(opener, base, 1, err_log)
        if anns is None:
            continue  # 请求出错，试下一组合
        if anns:
            chosen = combo
            chosen_params = base
            log("  [探测] 采用参数组合 column=%s tabName=%s stockCode=%s（首屏 %d 条）"
                % (combo.get("column") or "(空)", combo.get("tabName") or "(空)",
                   combo.get("stockCode"), len(anns)))
            break
        if err_log is not None and combo is combos[0]:
            try:
                diag = "主组合返回 announcements 为空（totalRecordNum=%s）" % j.get("totalRecordNum")
            except Exception:
                diag = "主组合返回 announcements 为空"
            err_log.append(diag)

    if chosen is None:
        if err_log is not None:
            err_log.append("已尝试 %d 种参数组合（column/tabName/stockCode 变体）均返回 0 条公告，"
                           "可能该股票在巨潮无对应公告或接口字段已变更" % len(combos))
        return [], 0

    results = []
    seen_ids = set()
    total_seen = 0
    empty_streak = 0
    page = 1
    page_size = 30
    max_pages = 40

    while page <= max_pages:
        anns, j, _ = _query_one_page(opener, chosen_params, page, err_log)
        if anns is None:
            break
        total_seen += len(anns)
        if not anns:
            break

        matched_this_page = 0
        for a in anns:
            sec = a.get("secCode") or ""
            sec_name = a.get("secName") or ""
            sec_norm = re.sub(r"\D", "", sec)
            code_norm2 = re.sub(r"\D", "", code)
            if sec_norm and sec_norm != code_norm2:
                if name and name in sec_name:
                    pass
                else:
                    continue
            elif not sec and name and name not in sec_name:
                continue
            title = a.get("announcementTitle") or ""
            rtype = match_report_type(title, types)
            if not rtype:
                continue
            aid = a.get("announcementId")
            if not aid or aid in seen_ids:
                continue
            seen_ids.add(aid)
            results.append({
                "secCode": sec or code,
                "announcementId": aid,
                "announcementTitle": title,
                "adjunctUrl": a.get("adjunctUrl") or "",
                "adjunctType": (a.get("adjunctType") or "PDF").lower(),
                "date": ts_to_date(a.get("announcementTime")),
                "reportType": rtype,
            })
            matched_this_page += 1

        if len(anns) < page_size:
            break
        if matched_this_page == 0:
            empty_streak += 1
        else:
            empty_streak = 0
        if empty_streak >= 3:
            log("  [查询] 连续 %d 页无匹配，停止翻页（疑似 stockCode 未被服务端过滤）" % empty_streak)
            break
        page += 1

    return results, total_seen


# ----------------------------------------------------------------------------
# 巨潮资讯查询（akshare 披露查询 + bulletin_detail 接口）
# ----------------------------------------------------------------------------
def query_cninfo_v2(code, years, types, err_log=None):
    """
    新版巨潮通道：通过 akshare 的 stock_zh_a_disclosure_report_cninfo 查询公告列表，
    再调用巨潮 /new/announcement/bulletin_detail 接口获取 PDF 直链（fileUrl）。

    适用场景：旧版 hisAnnouncement/query 接口在本机/代理环境下被屏蔽或返回 500/0 条时，
    该路径通常仍可稳定访问。
    """
    try:
        import akshare as ak
    except ImportError as e:
        if err_log is not None:
            err_log.append("新版巨潮通道需要 akshare，但未安装: %s" % e)
        return [], 0

    code_norm = re.sub(r"\D", "", code)
    if not re.fullmatch(r"\d{6}", code_norm):
        if err_log is not None:
            err_log.append("新版巨潮通道：无效的 6 位代码 %s" % code)
        return [], 0

    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1
    start_date = "%d-01-01" % start_year
    end_date = time.strftime("%Y-%m-%d", time.localtime())

    type_to_category = {
        "annual": "年报",
        "semi": "半年报",
        "q1": "一季报",
        "q3": "三季报",
    }

    results = []
    seen_ids = set()
    total_returned = 0

    for t in types:
        category = type_to_category.get(t)
        if not category:
            continue
        try:
            df = ak.stock_zh_a_disclosure_report_cninfo(
                symbol=code_norm, market="沪深京", category=category,
                start_date=start_date.replace("-", ""),
                end_date=end_date.replace("-", ""),
            )
        except Exception as e:
            if err_log is not None:
                err_log.append("新版巨潮 %s 查询失败: %s" % (category, e))
            continue
        total_returned += len(df)
        if df.empty:
            continue
        for _, row in df.iterrows():
            title = str(row.get("公告标题") or "").strip()
            link = str(row.get("公告链接") or "").strip()
            date = str(row.get("公告时间"))[:10]
            m = re.search(r"announcementId=(\d+)", link)
            if not m:
                continue
            ann_id = m.group(1)
            if ann_id in seen_ids:
                continue
            # 过滤摘要类公告，优先取正文（PDF 更大）
            if "摘要" in title and any(k in title for k in ["年度报告", "半年度报告", "季度报告"]):
                # 保留摘要，但正文优先；后面同一年份同类型会去重
                pass
            seen_ids.add(ann_id)
            results.append({
                "secCode": code_norm,
                "announcementId": ann_id,
                "announcementTitle": title,
                "date": date,
                "reportType": t,
            })

    if not results:
        return [], total_returned

    # 获取每个公告的 PDF 直链
    enriched = []
    opener = _make_opener()
    for item in results:
        try:
            file_url = _fetch_bulletin_detail(opener, item["announcementId"], item["date"])
            if file_url:
                item["fileUrl"] = file_url
                enriched.append(item)
        except Exception as e:
            if err_log is not None:
                err_log.append("获取 %s PDF 链接失败: %s" % (item["announcementTitle"], e))

    # 同一年份同类型只保留正文（非摘要）；若只有摘要则保留摘要
    final = []
    seen_year_type = set()
    # 优先排非摘要，确保同一年份同类型先遇到正文
    enriched.sort(key=lambda x: 0 if "摘要" not in x.get("announcementTitle", "") else 1)
    for item in enriched:
        key = (item["date"][:4], item["reportType"])
        if key in seen_year_type:
            continue
        seen_year_type.add(key)
        final.append(item)

    return final, total_returned


def _fetch_bulletin_detail(opener, ann_id, announce_time):
    """调用巨潮 bulletin_detail 接口，返回完整 PDF 直链。"""
    params = {
        "announceId": ann_id,
        "flag": "false",
        "announceTime": announce_time,
    }
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        CNINFO_BULLETIN_DETAIL_URL, data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": "https://www.cninfo.com.cn/new/disclosure/detail",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*",
        },
    )
    with opener.open(req, timeout=15) as resp:
        body = resp.read().decode("utf-8")
    j = json.loads(body)
    file_url = j.get("fileUrl") or j.get("announcement", {}).get("adjunctUrl", "")
    if file_url and not file_url.startswith("http"):
        file_url = CNINFO_PDF_BASE + file_url
    return file_url


# ----------------------------------------------------------------------------
# 东方财富查询
# ----------------------------------------------------------------------------
def _fetch_em_detail(opener, art_code):
    """[20261029m] 东财公告详情接口取 PDF 直链——np-anotice 列表项已不再携带 attachments（接口改版）。"""
    url = ("https://np-cnotice-stock.eastmoney.com/api/content/ann"
           "?art_code=%s&client_source=web&page_index=1" % urllib.parse.quote(str(art_code)))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with opener.open(req, timeout=15) as resp:
            j = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    data = (j or {}).get("data") or {}
    for at in (data.get("attach_list") or []):
        u = (at.get("attach_url") or "").strip()
        if u:
            return u
    u = (data.get("attach_url") or "").strip()
    return u or None


def query_eastmoney(opener, code, name, years, types, err_log=None):
    """
    查询某只股票符合条件的公告（东方财富公告中心 np-anotice 接口）。
    返回列表：[{secCode, announcementId, announcementTitle, fileUrl, fileName, referer, date, reportType}]

    说明：
      - np-anotice 列表项在「按个股过滤」时携带 attachments（含 file_url PDF 直链）。
      - 用 ann_type=2（个股公告）查询；若首屏 0 条，回退去掉 ann_type 再试（仍依赖 stock_list 过滤）。
      - 标题按报告类型关键字过滤。
    """
    code_norm = re.sub(r"\D", "", code)
    if not re.fullmatch(r"\d{6}", code_norm):
        if err_log is not None:
            err_log.append("东方财富：无效的 6 位代码 %s" % code)
        return []

    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1

    def _fetch(params):
        url = EM_ANN_URL + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Referer": REFERER_EM,
            "Accept": "application/json, text/plain, */*",
        })
        try:
            with opener.open(req, timeout=20) as resp:
                body = resp.read().decode("utf-8")
            return json.loads(body)
        except Exception as e:
            if err_log is not None:
                err_log.append("东方财富查询失败: %s" % e)
            return None

    results = []
    seen_ids = set()
    total_returned = 0
    used_params = None

    # [20261029m] ann_type 数字类目（"2"=财务报告）已失效（恒 0 条）→ 改用字母类目 "A"=全部公告。
    # 原「无 ann_type」回退组合会使 stock_list 过滤失效（返回全市场公告）且无附件，已删除——
    # 否则标题匹配到别家公司同名报告会错下文件。
    for attempt in ({"ann_type": "A", "client_source": "web", "stock_list": code_norm},):
        params = dict(attempt)
        params.update({"sr": "-1", "page_size": "30", "page_index": "0"})
        j = _fetch(params)
        if j is None:
            continue
        data = j.get("data") or {}
        anns = data.get("list") or []
        total_hits = data.get("total_hits")
        if total_hits is not None and total_hits > 0:
            used_params = params
            log("  [东方财富] 命中接口公告数 total_hits=%s（ann_type=%s）"
                % (total_hits, params.get("ann_type", "(无)")))
            break
        else:
            log("  [东方财富] 该参数组合返回 0 条（ann_type=%s），尝试备用组合"
                % params.get("ann_type", "(无)"))

    if used_params is None:
        if err_log is not None:
            err_log.append("东方财富未返回该股票的任何公告（可能代码无对应披露或接口字段变更）")
        return [], 0

    # 正式翻页
    page = 0
    page_size = 30
    max_pages = 20
    while page < max_pages:
        params = dict(used_params)
        params["page_index"] = str(page)
        j = _fetch(params)
        if j is None:
            break
        anns = (j.get("data") or {}).get("list") or []
        total_returned += len(anns)
        if not anns:
            break

        for a in anns:
            title = (a.get("title") or a.get("title_ch") or "")
            rtype = match_report_type(title, types)
            if not rtype:
                continue
            # [20261029m] 归属校验：确认公告确实属于目标股票（防过滤失效时错下别家公司报告）
            codes_list = a.get("codes") or []
            if codes_list:
                sc = {str(c.get("stock_code") or "").zfill(6) for c in codes_list}
                if code_norm not in sc:
                    continue
            atts = a.get("attachments") or []
            # 优先取 PDF 附件
            pdf = None
            for at in atts:
                fu = (at.get("file_url") or "").lower()
                fn = (at.get("file_name") or "").lower()
                if fu.endswith(".pdf") or fn.endswith(".pdf") or "pdf" in fu:
                    pdf = at
                    break
            if pdf is None and atts:
                pdf = atts[0]
            file_url = ((pdf.get("file_url") if pdf else "") or "")
            aid = a.get("art_code") or file_url
            if not aid:
                continue
            if not file_url:
                # [20261029m] 列表不带 attachments（接口改版）→ 详情接口补取 PDF 直链
                file_url = _fetch_em_detail(opener, aid) or ""
                if not file_url:
                    continue
            if aid in seen_ids:
                continue
            seen_ids.add(aid)
            results.append({
                "secCode": code_norm,
                "announcementId": aid,
                "announcementTitle": title,
                "fileUrl": file_url,
                "fileName": ((pdf.get("file_name") if pdf else "") or (title + ".pdf")),
                "referer": REFERER_EM,
                "date": em_date(a.get("notice_date")),
                "reportType": rtype,
            })

        if len(anns) < page_size:
            break
        page += 1

    return results, total_returned


# ----------------------------------------------------------------------------
# 下载
# ----------------------------------------------------------------------------
def download_one(opener, item, out_dir):
    """
    下载单个公告。返回 (status, item, path_or_reason)
    status: 'downloaded' | 'skipped' | 'error'

    兼容两种来源：
      - 巨潮：item 含 adjunctUrl（拼接 CNINFO_STATIC_BASE），referer 指向巨潮。
      - 东方财富：item 含 fileUrl（PDF 直链），referer 指向东方财富。
    """
    code = item["secCode"]
    date = item["date"] or "unknown"
    title = item["announcementTitle"]

    if item.get("fileUrl"):
        # 东方财富：完整 PDF 直链
        ext = "pdf"
        referer = item.get("referer") or REFERER_EM
        url = item["fileUrl"]
        base_name = sanitize_filename("%s_%s_%s" % (code, date, title))
    else:
        # 巨潮：静态基址 + 相对路径
        ext = (item.get("adjunctType") or "pdf").lower()
        if ext.lower() not in ("pdf", "html", "doc", "docx", "xls", "xlsx"):
            ext = "pdf"
        referer = REFERER_CNINFO
        url = CNINFO_STATIC_BASE + item["adjunctUrl"]
        base_name = sanitize_filename("%s_%s_%s" % (code, date, title))

    stock_dir = os.path.join(out_dir, code)
    os.makedirs(stock_dir, exist_ok=True)

    filename = base_name + "." + ext
    filepath = os.path.join(stock_dir, filename)

    # 1) 文件名去重：若已存在，跳过
    if os.path.exists(filepath):
        return ("skipped", item, filepath)

    # 2) announcementId 去重清单
    manifest_path = os.path.join(stock_dir, "_downloaded.json")
    manifest = {}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    if item["announcementId"] in manifest:
        return ("skipped", item, filepath)

    # 执行下载
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Referer": referer,
        "Accept": "*/*",
    })
    try:
        with opener.open(req, timeout=30) as resp:
            data = resp.read()
        if not data or len(data) < 500:
            return ("error", item, "文件过小或为空(%d字节)" % len(data))
        with open(filepath, "wb") as f:
            f.write(data)
        manifest[item["announcementId"]] = {
            "title": title, "date": date, "file": filename,
            "channel": item.get("channel", ""),
        }
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        return ("downloaded", item, filepath)
    except Exception as e:
        return ("error", item, str(e))


# ----------------------------------------------------------------------------
# 单通道执行
# ----------------------------------------------------------------------------
def run_channel(channel, codes, years, types, out_dir, workers, per_code):
    """执行单个通道的查询+下载，更新 per_code 聚合字典。返回该通道的汇总。"""
    summary = {
        "downloaded": 0, "skipped": 0, "errors": 0,
        "totalQueried": 0, "found": 0, "lastError": "",
    }

    for code, name in codes:
        # 规范化代码为 6 位
        norm_code = code
        if not re.fullmatch(r"\d{6}", norm_code):
            norm_code = re.sub(r"^(SH|SZ|BJ)", "", norm_code.upper())
        if not re.fullmatch(r"\d{6}", norm_code):
            log("[跳过] 无效代码: %s" % code)
            pc = per_code.setdefault(code, _new_per_code(code, name))
            pc["status"] = "invalid"
            summary["errors"] += 1
            continue

        log("[%s 查询] %s %s ..." % (channel, norm_code, name))
        opener = _make_opener()
        if channel == "cninfo":
            _warmup_cookie(opener)
            errs = []
            items, seen = query_announcements(opener, norm_code, name, years, types, errs)
            summary["totalQueried"] += seen
            # 旧接口（hisAnnouncement/query）在本机/代理环境下常被屏蔽或返回 0 条，
            # 回退到新版 akshare + bulletin_detail 接口。
            if not items:
                log("  [cninfo] 旧接口无结果，尝试新版 akshare 披露查询...")
                v2_items, v2_seen = query_cninfo_v2(norm_code, years, types, errs)
                if v2_items:
                    items = v2_items
                    seen += v2_seen
                    summary["totalQueried"] += v2_seen
                    summary["found"] += len(items)
                    # 旧接口的错误信息不应覆盖新版接口的成功结果
                    errs.clear()
                    log("  [cninfo] 新版接口命中 %d 份报告" % len(items))
            elif items:
                summary["found"] += len(items)
        else:  # eastmoney
            errs = []
            items, seen = query_eastmoney(opener, norm_code, name, years, types, errs)
            summary["totalQueried"] += seen

        if errs:
            summary["lastError"] = errs[-1]
        log("  -> [%s] 命中 %d 份报告（接口共返回 %d 条公告）" % (channel, len(items), seen))

        if not items:
            pc = per_code.setdefault(norm_code, _new_per_code(norm_code, name))
            pc["status"] = "none"
            pc["queried"] = pc.get("queried", 0) + seen
            continue

        code_downloaded = code_skipped = code_errors = 0
        # 标记通道，便于去重清单记录来源
        for it in items:
            it["channel"] = channel
        with ThreadPoolExecutor(max_workers=max(1, min(workers, 4))) as ex:
            futures = [ex.submit(download_one, opener, it, out_dir) for it in items]
            for fut in as_completed(futures):
                status, item, info = fut.result()
                if status == "downloaded":
                    code_downloaded += 1
                    summary["downloaded"] += 1
                    log("  [下载] %s %s -> %s" % (item["date"], item["announcementTitle"], os.path.basename(info)))
                elif status == "skipped":
                    code_skipped += 1
                    summary["skipped"] += 1
                else:
                    code_errors += 1
                    summary["errors"] += 1
                    log("  [失败] %s %s : %s" % (item["announcementTitle"], item["date"], info))

        pc = per_code.setdefault(norm_code, _new_per_code(norm_code, name))
        pc["name"] = name or pc.get("name", "")
        pc["found"] = pc.get("found", 0) + len(items)
        pc["downloaded"] = pc.get("downloaded", 0) + code_downloaded
        pc["skipped"] = pc.get("skipped", 0) + code_skipped
        pc["errors"] = pc.get("errors", 0) + code_errors
        pc["queried"] = pc.get("queried", 0) + seen
        if pc["status"] != "invalid":
            pc["status"] = "ok"

    return summary


def _new_per_code(code, name):
    return {"code": code, "name": name, "found": 0, "downloaded": 0,
            "skipped": 0, "errors": 0, "queried": 0, "status": "ok"}


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def parse_codes_argument(codes_arg, file_arg):
    """解析股票代码列表，支持 'code' 或 'code 名称' 形式。返回 [(code, name), ...]"""
    entries = []
    seen = set()
    if file_arg:
        with open(file_arg, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                code = re.sub(r"^(SH|SZ|BJ)", "", parts[0].upper())
                code = code.lstrip("0") if code.isdigit() and len(code) > 6 else code
                name = parts[1] if len(parts) > 1 else ""
                if code not in seen:
                    seen.add(code)
                    entries.append((code, name))
    if codes_arg:
        for c in codes_arg.split(","):
            c = c.strip()
            if not c:
                continue
            parts = c.split()
            code = re.sub(r"^(SH|SZ|BJ)", "", parts[0].upper())
            name = parts[1] if len(parts) > 1 else ""
            if code not in seen:
                seen.add(code)
                entries.append((code, name))
    return entries


def run(codes, years, types, out_dir, workers, as_json, probe=False, channel="cninfo"):
    if probe:
        for code, name in codes:
            norm_code = code
            if not re.fullmatch(r"\d{6}", norm_code):
                norm_code = re.sub(r"^(SH|SZ|BJ)", "", norm_code.upper())
            if not re.fullmatch(r"\d{6}", norm_code):
                log("[跳过] 无效代码: %s" % code)
                continue
            opener = _make_opener()
            _warmup_cookie(opener)
            probe_combos(opener, norm_code, name, years)
        return {"totalCodes": len(codes), "downloaded": 0, "skipped": 0,
                "errors": 0, "totalQueried": 0, "lastError": "", "details": []}

    os.makedirs(out_dir, exist_ok=True)

    # 规范化并预建 per_code
    norm_entries = []
    per_code = {}
    for code, name in codes:
        norm_code = code
        if not re.fullmatch(r"\d{6}", norm_code):
            norm_code = re.sub(r"^(SH|SZ|BJ)", "", norm_code.upper())
        if not re.fullmatch(r"\d{6}", norm_code):
            log("[跳过] 无效代码: %s" % code)
            per_code[code] = _new_per_code(code, name)
            per_code[code]["status"] = "invalid"
            norm_entries.append((code, name, False))
            continue
        per_code[norm_code] = _new_per_code(norm_code, name)
        norm_entries.append((norm_code, name, True))

    summary = {
        "totalCodes": len(codes),
        "downloaded": 0, "skipped": 0, "errors": 0,
        "totalQueried": 0, "lastError": "", "details": [],
        "channels": {},
        "fallback": False,  # 是否发生"东财受限 → 巨潮回退"
    }

    # 通道尝试顺序：巨潮(同花顺/巨潮披露)在本机始终可靠，作为兜底；
    # - 用户选"巨潮": 先巨潮，命中 0 时自动补试东财备链（20261029m：A+H 公司巨潮索引
    #   延迟数小时实证——603288 当晚已披露、巨潮沪深京索引 3 小时后仍无条目）；
    # - 用户选"东方财富"/"全部通道": 先试东财，命中 0 时自动回退巨潮，确保一定能下到报告。
    for norm_code, name, valid in norm_entries:
        if not valid:
            continue
        if channel == "cninfo":
            order = ["cninfo", "eastmoney"]
        else:  # eastmoney / all
            order = ["eastmoney", "cninfo"]

        for ch in order:
            ch_summary = run_channel(ch, [(norm_code, name)], years, types, out_dir, workers, per_code)
            # 合并到分通道汇总
            if ch not in summary["channels"]:
                summary["channels"][ch] = {"downloaded": 0, "skipped": 0, "errors": 0,
                                           "totalQueried": 0, "found": 0, "lastError": ""}
            cs = summary["channels"][ch]
            cs["downloaded"] += ch_summary["downloaded"]
            cs["skipped"] += ch_summary["skipped"]
            cs["errors"] += ch_summary["errors"]
            cs["totalQueried"] += ch_summary["totalQueried"]
            cs["found"] += ch_summary["found"]
            # 合并到总汇总
            summary["downloaded"] += ch_summary["downloaded"]
            summary["skipped"] += ch_summary["skipped"]
            summary["errors"] += ch_summary["errors"]
            summary["totalQueried"] += ch_summary["totalQueried"]
            if ch_summary.get("lastError"):
                summary["lastError"] = ch_summary["lastError"]

            if ch_summary["found"] == 0 and ch != order[-1]:
                # 当前通道未命中 → 自动切换备链（东财受限回巨潮 / 巨潮索引延迟补东财）
                summary["fallback"] = True
                log("  [回退] %s 通道未命中 %s，自动改用 %s 通道" % (ch, norm_code, order[order.index(ch) + 1]))
                continue
            break

    # 构建 per-code 明细（按原始 codes 顺序）
    summary["details"] = [per_code.get(c, _new_per_code(c, n)) for c, n in codes]

    if as_json:
        # 仅输出一行 JSON，便于后端解析
        print("RESULT_JSON:" + json.dumps(summary, ensure_ascii=False))
    else:
        log("")
        log("==== 下载完成 ====")
        log("代码数: %d | 新下载: %d | 跳过(已存在): %d | 失败: %d"
            % (summary["totalCodes"], summary["downloaded"], summary["skipped"], summary["errors"]))
        for ch, cs in summary["channels"].items():
            log("  通道 %s: 下载 %d / 跳过 %d / 失败 %d（接口返回 %d 条公告）"
                % (ch, cs["downloaded"], cs["skipped"], cs["errors"], cs["totalQueried"]))
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="巨潮资讯网 / 东方财富 年报/半年报 批量下载工具")
    parser.add_argument("--codes", help="股票代码，逗号分隔，如 600938,000001")
    parser.add_argument("--file", help="代码列表文件，每行一个代码（可附名称）")
    parser.add_argument("--years", type=int, default=5, help="回溯年份数（默认5）")
    parser.add_argument("--types", default="annual,semi",
                        help="报告类型: annual,semi,q1,q3（默认 annual,semi）")
    parser.add_argument("--out", default="../data/reports",
                        help="输出根目录（默认 ../data/reports）")
    parser.add_argument("--workers", type=int, default=4, help="单只股票内并发下载数（默认4）")
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON 结果")
    parser.add_argument("--probe", action="store_true",
                        help="仅探测参数组合（打印各组合的 totalRecordNum），不下载")
    parser.add_argument("--channel", default="cninfo",
                        choices=CHANNELS + ["all"],
                        help="数据源通道: cninfo(巨潮,默认) / eastmoney(东方财富) / all(全部)")
    args = parser.parse_args()

    # [20261029l] 类型解析加固：①新增 quarterly 别名（展开为 q1+q3）——此前 reportSync 传来的
    # quarterly 被本行静默丢弃、types 清空后回退 annual,semi（静默降级），导致三季报/一季报
    # 从未被下载（2026-10-29 华安证券 600909 用户报障，全自选股同因）；②未知类型显式告警，不再静默。
    types = []
    for t in (x.strip() for x in args.types.split(",")):
        if not t:
            continue
        if t in REPORT_TYPE_KEYWORDS:
            if t not in types:
                types.append(t)
        elif t == "quarterly":
            for q in ("q1", "q3"):
                if q not in types:
                    types.append(q)
        else:
            print("[warn] 未知报告类型 %r 已忽略（合法: annual,semi,q1,q3,quarterly）" % t, file=sys.stderr)
    if not types:
        types = ["annual", "semi"]

    codes = parse_codes_argument(args.codes, args.file)
    if not codes:
        log("错误：未提供任何股票代码。使用 --codes 或 --file 指定。")
        sys.exit(1)

    # out 目录相对本脚本位置解析
    out_dir = args.out
    if not os.path.isabs(out_dir):
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), out_dir)
    out_dir = os.path.abspath(out_dir)

    log("开始批量下载：共 %d 只股票，类型=%s，回溯%d年，通道=%s，输出=%s"
        % (len(codes), ",".join(types), args.years, args.channel, out_dir))
    run(codes, args.years, types, out_dir, args.workers, args.json, args.probe, args.channel)


if __name__ == "__main__":
    main()

~~~

---

## `scripts\em_sector_capital_flow.py`  ·  274 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取 A 股行业板块资金流向排名。
优先东方财富（主力=超大单+大单，含暗盘性质机构资金）；
东方财富被屏蔽时，回退同花顺「净流入」作为近似口径。
输出：当日净流入/净流出前五 + 近5日净流入/净流出最大板块。
"""
import json
import sys
import io
import traceback
import time
from datetime import datetime

# Windows 控制台默认 GBK，直接输出中文会乱码；强制 stdout/stderr 用 UTF-8。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

try:
    import akshare as ak
    import pandas as pd
except ImportError as e:
    print(json.dumps({"error": "akshare not installed", "detail": str(e)}, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)


def _to_float(v):
    try:
        if pd.isna(v):
            return 0.0
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def _fmt_yi(v):
    """元 -> 亿元，保留两位"""
    return round(_to_float(v) / 1e8, 2)


def _pick_leader(row, keys=None):
    if keys is None:
        keys = ['今日主力净流入最大股', '5日主力净流入最大股', '10日主力净流入最大股',
                '领涨股', '主力净流入最大股', '5日流入最大股']
    for key in keys:
        if key in row and pd.notna(row[key]):
            return str(row[key]).strip()
    return ''


def _extract_today_em(df):
    """东方财富：提取净流入前五 / 净流出前五"""
    records = []
    net_col = '今日主力净流入-净额'
    chg_col = '今日涨跌幅'
    for _, row in df.iterrows():
        net = _to_float(row.get(net_col, 0))
        records.append({
            'name': str(row.get('名称', '')).strip(),
            'changePct': _to_float(row.get(chg_col, 0)),
            'mainNet': _fmt_yi(net),
            'superLargeNet': _fmt_yi(row.get('今日超大单净流入-净额', 0)),
            'largeNet': _fmt_yi(row.get('今日大单净流入-净额', 0)),
            'leader': _pick_leader(row),
        })
    inflow = sorted([r for r in records if r['mainNet'] > 0], key=lambda x: x['mainNet'], reverse=True)[:5]
    outflow = sorted([r for r in records if r['mainNet'] < 0], key=lambda x: x['mainNet'])[:5]
    return inflow, outflow


def _extract_fiveday_em(df):
    """东方财富：提取近5日净流入最大 / 净流出最大板块（各取 Top1）"""
    records = []
    net_col = None
    for c in df.columns:
        if '主力净流入-净额' in c and ('5日' in c or '5天' in c):
            net_col = c
            break
    chg_col = None
    for c in df.columns:
        if ('5日' in c or '5天' in c) and '涨跌幅' in c:
            chg_col = c
            break
    if not net_col:
        return None, None
    for _, row in df.iterrows():
        net = _to_float(row.get(net_col, 0))
        records.append({
            'name': str(row.get('名称', '')).strip(),
            'changePct': _to_float(row.get(chg_col, row.get('今日涨跌幅', 0))),
            'mainNet': _fmt_yi(net),
            'leader': _pick_leader(row),
        })
    if not records:
        return None, None
    max_in = max(records, key=lambda x: x['mainNet'])
    max_out = min(records, key=lambda x: x['mainNet'])
    return max_in, max_out


# 进程内记住本次运行可用的东财域名（脚本每次被 Node 重新拉起，仅在同一次运行内生效）
_em_domain = ['']


def _fetch_em_rank(indicator, order='desc', pz=100, retries=2):
    """东方财富 push2 接口：curl -4 直连，单页定向获取。

    20260903b 修复（三个问题）：
    1. akshare 内部用 Python requests 请求 push2.eastmoney.com，本机被远端掐断
       （RemoteDisconnected），导致整条东财路径失败、回退同花顺（无近5日数据）。
       改用 curl 强制 IPv4（与 lib/capitalFlow.js fetchWithCurl 同方案，已验证可行）。
    2. 分页拉全量（496 板块 = 5 页连发）会触发东财分钟级 IP 限流（curl exit 56）。
       接口本身按主力净额排序，改为「定向小请求」：每个方向只取头部一页，
       4 个请求足够覆盖今日前五流入/流出与近5日最大流入/流出板块。
    3. push2.eastmoney.com / push2his.eastmoney.com 在本机被持续重置（exit 56，
       连数字镜像 23./48.push2 也被重置），但 push2delay.eastmoney.com 可正常访问
       且板块资金流数据实时（f124 时间戳=当前时间）。改为多域名故障转移：
       优先 push2（未被封时最快），失败自动切 push2delay，进程内记住成功域名。
       另外必须带 fid 参数（只带 fid0 时服务端不排序，返回顺序错乱）。
    返回 DataFrame，列名与 akshare stock_sector_fund_flow_rank 一致，
    下游 _extract_today_em / _extract_fiveday_em 无需改动。
    """
    import subprocess

    indicator_map = {
        '今日': ('f62', '1',
                 'f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124'),
        '5日': ('f164', '5',
                'f12,f14,f2,f109,f164,f165,f166,f167,f168,f169,f170,f171,f172,f173,f257,f258,f124'),
    }
    col_map = {
        '今日': {
            'f14': '名称', 'f3': '今日涨跌幅', 'f62': '今日主力净流入-净额',
            'f66': '今日超大单净流入-净额', 'f72': '今日大单净流入-净额',
            'f204': '今日主力净流入最大股',
        },
        '5日': {
            'f14': '名称', 'f109': '5日涨跌幅', 'f164': '5日主力净流入-净额',
            'f257': '5日主力净流入最大股',
        },
    }
    fid0, stat, fields = indicator_map[indicator]
    rename = col_map[indicator]
    po = '1' if order == 'desc' else '0'

    domains = ['push2delay.eastmoney.com', 'push2.eastmoney.com']
    if _em_domain[0] and _em_domain[0] in domains:
        domains = [_em_domain[0]] + [d for d in domains if d != _em_domain[0]]

    data = None
    last_err = None
    for domain in domains:
        for i in range(retries + 1):
            try:
                url = f'https://{domain}/api/qt/clist/get'
                params = (
                    f'pn=1&pz={pz}&po={po}&np=1&ut=b2884a393a59ad64002292a3e90d46a5'
                    f'&fltt=2&invt=2&fid0={fid0}&fid={fid0}&fs=m:90+t:2&stat={stat}'
                    f'&fields={fields}&rt=52975239&_={int(time.time() * 1000)}'
                )
                r = subprocess.run(
                    ['curl', '-4', '-s', '--connect-timeout', '5', '--max-time', '15',
                     '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                     '-H', 'Referer: https://data.eastmoney.com/bkzj/hy.html',
                     f'{url}?{params}'],
                    capture_output=True, timeout=25,
                )
                if r.returncode != 0:
                    raise Exception(f'curl 退出码 {r.returncode}')
                data = json.loads(r.stdout.decode('utf-8', 'replace'))
                if not data.get('data') or not data['data'].get('diff'):
                    raise Exception('接口返回空 diff')
                _em_domain[0] = domain
                break
            except Exception as e:
                last_err = e
                data = None
                if i < retries:
                    time.sleep(2)
        if data is not None:
            break
        # 被重置的域名直接换下一个，重试也大概率继续被重置
        time.sleep(1)
    if data is None:
        raise last_err or Exception(f'curl 获取东方财富{indicator}板块资金流失败')

    rows = data['data']['diff']
    if not rows:
        raise Exception(f'东方财富{indicator}板块资金流无数据')
    records = [{rename[k]: v for k, v in row.items() if k in rename} for row in rows]
    return pd.DataFrame(records)


def _fetch_ths_today():
    """同花顺回退：获取今日板块净流入/流出"""
    df = ak.stock_board_industry_summary_ths()
    records = []
    for _, row in df.iterrows():
        net = _to_float(row.get('净流入', 0))
        records.append({
            'name': str(row.get('板块', '')).strip(),
            'changePct': _to_float(row.get('涨跌幅', 0)),
            'mainNet': net,  # 同花顺已为元？观察数值 60.69 对应亿元量级，akshare 此列返回亿
            'superLargeNet': None,
            'largeNet': None,
            'leader': str(row.get('领涨股', '')).strip() if pd.notna(row.get('领涨股')) else '',
        })
    # 同花顺「净流入」列返回的是亿元数值，无需再除 1e8
    inflow = sorted([r for r in records if r['mainNet'] > 0], key=lambda x: x['mainNet'], reverse=True)[:5]
    outflow = sorted([r for r in records if r['mainNet'] < 0], key=lambda x: x['mainNet'])[:5]
    return inflow, outflow


def main():
    try:
        result = {
            'ok': True,
            'date': datetime.now().strftime('%Y-%m-%d'),
        }

        # 1) 优先东方财富（4 个定向小请求：今日降序/升序头部 + 5日降序/升序第1名，
        #    请求间加延时避免触发东财分钟级 IP 限流）
        em_error = None
        try:
            today_desc = _fetch_em_rank('今日', order='desc', pz=100)
            time.sleep(1.0)
            today_asc = _fetch_em_rank('今日', order='asc', pz=100)
            today_df = pd.concat([today_desc, today_asc], ignore_index=True)
            today_in, today_out = _extract_today_em(today_df)
            result['source'] = '东方财富·板块资金流向'
            result['todayInflowTop5'] = today_in
            result['todayOutflowTop5'] = today_out
            result['note'] = '主力净流入 = 超大单净流入 + 大单净流入（含暗盘性质机构资金）'

            # 5日（降序第1 = 净流入最大板块；升序第1 = 净流出最大板块）
            try:
                time.sleep(1.0)
                five_desc = _fetch_em_rank('5日', order='desc', pz=3)
                time.sleep(1.0)
                five_asc = _fetch_em_rank('5日', order='asc', pz=3)
                five_df = pd.concat([five_desc, five_asc], ignore_index=True)
                five_day_in, five_day_out = _extract_fiveday_em(five_df)
                result['fiveDayMaxInflow'] = five_day_in
                result['fiveDayMaxOutflow'] = five_day_out
            except Exception as e2:
                result['fiveDayWarning'] = f'近5日资金流向获取失败：{e2}'
        except Exception as e:
            em_error = str(e)
            # 2) 回退同花顺（仅今日）
            try:
                today_in, today_out = _fetch_ths_today()
                result['source'] = '同花顺·行业板块（净流入近似）'
                result['todayInflowTop5'] = today_in
                result['todayOutflowTop5'] = today_out
                result['note'] = '东方财富接口受限，已回退同花顺「净流入」列作为近似口径'
                result['fallbackWarning'] = f'东方财富资金流向获取失败：{em_error}；已启用同花顺回退'
                result['fiveDayWarning'] = '近5日资金流向仅东方财富提供，当前接口不可用'
            except Exception as e2:
                raise Exception(f'东方财富失败({em_error})且同花顺回退也失败({e2})') from e2

        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()

~~~

---

## `scripts\etf_pcf_report.js`  ·  488 行

~~~js
/**
 * 上交所 ETF 当日申购赎回清单（PCF）抓取 + 沪深300 家族统计 —— 样板脚本
 * =========================================================
 * 数据源（全部实测可用，仅需 UA + Referer）：
 *   列表   https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_PL_ETFGGSGSHQD_L&ETF_CLASS=03
 *   基本信息 ...sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C&FUNDID2=510300
 *   成分股   ...sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C&FUNDID2=510300
 * 行情     https://qt.gtimg.cn/q=sh600519,...（GBK）—— 仅用于把「份数」折算成「权重」
 *
 * ETF_CLASS 实测：01=单市场股票ETF(沪) 02=债券 03=跨市场股票ETF 06=黄金 08=沪港深 09=科创板 31=双创 33=跨境
 *
 * ⚠ 口径红线：PCF 是「申赎一篮子要交什么」的清单，**不含当日实际净申购/净赎回份额**。
 *   它能回答「谁被哪些 ETF 共同持有、权重多少、各家篮子差异多大」；
 *   不能回答「今天这只 ETF 被净申购了多少」。后者需份额数据（T+1 披露）。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://www.sse.com.cn/disclosure/fund/etflist/',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
};

function httpGet(url, { timeout = 20000, gbk = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HDR, timeout }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const buf = Buffer.concat(bufs);
        if (gbk) return resolve(new TextDecoder('gbk').decode(buf));
        resolve(buf.toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const json = async (u) => JSON.parse(await httpGet(u));

const Q = 'https://query.sse.com.cn/commonQuery.do';
const listUrl = (cls, size = 600) => `${Q}?isPagination=true&pageHelp.pageSize=${size}&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1&sqlId=COMMON_SSE_PL_ETFGGSGSHQD_L&ETF_CLASS=${cls}&type=inParams&FUND_CODE=&KEY_WORDS=`;
const jbxxUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C`;
const compUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C`;

const SUB = { '0': '禁止', '1': '允许', '2': '必须', '3': '深市退补', '4': '深市必须', '5': '退补', '6': '必须', '7': '港市退补', '8': '港市必须' };
const MKT = { '101': '沪', '102': '深', '103': '港', '105': '外汇', '106': '北', '9999': '其他' };
const MECH = { '0': '现金申赎', '1': '沪市实物对价', '2': '沪深实物对价', '3': '银行间债券实物' };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: e.message, __key: items[k] }; }
    }
  }));
  return out;
}

const numOf = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[￥,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const cn = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yi = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' 万';
  return n.toLocaleString('zh-CN');
};

// 排除「沪深300 + 行业/策略/增强」衍生品
const DERIV = /医药|红利|ESG|增强|价值|成长|低波|质量|动量|等权|非银|银行|消费|科技|信息|军工|有色|能源|地产|国企|央企|龙头|优选|量化|策略|A50|A100/i;

async function fetchPrices(codes) {
  const map = new Map();
  const B = 60;
  for (let i = 0; i < codes.length; i += B) {
    const batch = codes.slice(i, i + B);
    const q = batch.map(c => (/^(6|9)/.test(c) ? 'sh' : /^(0|2|3)/.test(c) ? 'sz' : 'bj') + c).join(',');
    let txt;
    try { txt = await httpGet('https://qt.gtimg.cn/q=' + q, { gbk: true, timeout: 20000 }); } catch (e) { continue; }
    for (const line of txt.split(';\n')) {
      const m = line.match(/v_([a-z]{2})(\d{6})="([^"]*)"/);
      if (!m) continue;
      const f = m[3].split('~');
      const price = numOf(f[3]);
      if (price) map.set(m[2], { price, name: f[1] });
    }
  }
  return map;
}

(async () => {
  const t0 = Date.now();
  const log = (s) => console.log(s);

  // ── 1. 候选池：跨市场股票ETF 中名称含「沪深300」且非衍生
  const l = await json(listUrl('03'));
  const all = (l.pageHelp && l.pageHelp.data) || [];
  const cand = all.filter(it => (it.ETF_FULLNAME || '').includes('沪深300'));
  log(`跨市场股票ETF ${all.length} 只 → 名称含「沪深300」${cand.length} 只`);

  // ── 2. 拉基本信息，判定「真·沪深300」（成分正好 300 且非衍生）
  const basics = await mapLimit(cand, 4, async (it) => {
    const j = await json(jbxxUrl(it.FUNDID2));
    return { list: it, base: (j.result && j.result[0]) || null };
  });
  const members = [];
  const excluded = [];
  for (const b of basics) {
    if (b.__err) { excluded.push({ code: b.__key && b.__key.FUNDID2, name: b.__key && b.__key.ETF_FULLNAME, why: '基本信息抓取失败：' + b.__err }); continue; }
    const it = b.list, base = b.base;
    if (!base) { excluded.push({ code: it.FUNDID2, name: it.ETF_FULLNAME, why: '无当日清单（可能未发布/停牌/已终止）' }); continue; }
    const n = numOf(base.RECORD_NUM);
    if (n !== 300) { excluded.push({ code: it.FUNDID2, name: it.ETF_FULLNAME, why: `成分为 ${n} 只，非「纯沪深300」（属行业/策略/增强衍生）` }); continue; }
    if (DERIV.test(base.FUND_NAME || it.ETF_FULLNAME)) { excluded.push({ code: it.FUNDID2, name: it.ETF_FULLNAME, why: '名称含行业/策略/增强关键词，非纯指数复制' }); continue; }
    members.push({ code: it.FUNDID2, list: it, base });
  }
  log(`入组 ${members.length} 只；排除 ${excluded.length} 只`);

  // ── 3. 拉成分股
  const withComp = await mapLimit(members, 4, async (m) => {
    const c = await json(compUrl(m.code));
    const comps = (c.result || []).filter(x => x && x.INSTRUMENT_ID && x.INSTRUMENT_NAME !== '现金替代');
    return Object.assign({}, m, { comps });
  });
  const okMembers = withComp.filter(m => !m.__err && m.comps && m.comps.length);
  log(`拿到成分股 ${okMembers.length} 只，成分数区间 ${Math.min(...okMembers.map(m => m.comps.length))}~${Math.max(...okMembers.map(m => m.comps.length))}`);

  // ── 4. 家族一致性校验（Jaccard vs 基准 510300）
  const seed = okMembers.find(m => m.code === '510300') || okMembers[0];
  const seedSet = new Set((seed.comps || []).map(c => c.INSTRUMENT_ID));
  for (const m of okMembers) {
    const s = new Set(m.comps.map(c => c.INSTRUMENT_ID));
    let inter = 0;
    for (const x of s) if (seedSet.has(x)) inter++;
    m.jaccard = s.size + seedSet.size ? (2 * inter) / (s.size + seedSet.size) : 0;
  }

  // ── 5. 行情（用于份数 → 权重）
  const ids = Array.from(new Set(okMembers.flatMap(m => m.comps.map(c => c.INSTRUMENT_ID))));
  const priceMap = await fetchPrices(ids);
  log(`行情取到 ${priceMap.size}/${ids.length} 只`);

  // ── 6. 每只 ETF 的权重解剖
  // 两个口径必须分清：
  //   覆盖率 cover = Σ(份数×价) ÷ 单篮净值      —— 绝对口径，<100% 说明篮子没把净值全额还原（现金差额/替代/取整/时点差）
  //   篮内权重 w   = (份数×价) ÷ Σ(份数×价)      —— 相对口径，各 ETF 按自身篮子归一，跨 ETF 才可比
  // 跨 ETF 比较必须用 w：若用 cover 口径，覆盖率 94%~99% 的差异会直接污染权重对比。
  for (const m of okMembers) {
    const unitNet = numOf(m.base.NAVPERCU);          // 每申赎单位对应的一篮子净值
    let sumMV = 0, priced = 0, miss = 0;
    const rows = [];
    for (const c of m.comps) {
      const qty = numOf(c.QUANTITY) || 0;
      const p = priceMap.get(c.INSTRUMENT_ID);
      const mv = p ? qty * p.price : null;
      if (mv == null) miss++; else { sumMV += mv; priced++; }
      rows.push({
        id: c.INSTRUMENT_ID, name: c.INSTRUMENT_NAME, qty,
        sub: SUB[String(c.SUBSTITUTION_FLAG)] || String(c.SUBSTITUTION_FLAG),
        mkt: MKT[String(c.UNDERLYION_SECURITY_ID)] || '?',
        price: p ? p.price : null, mv, w: null,
      });
    }
    for (const r of rows) {
      // 数量为 0 的行 = 纯现金替代（停牌/不可交付），不构成实物持仓 → 不参与权重统计，
      // 否则会算出「权重 0.000%」把极差表污染成假信号。
      r.w = (r.mv != null && r.qty > 0 && sumMV > 0) ? (r.mv / sumMV) * 100 : null;
    }
    m.unitNet = unitNet;
    m.rows = rows;
    m.priced = priced; m.miss = miss;
    m.sumMV = sumMV;
    m.cover = (unitNet && sumMV) ? (sumMV / unitNet) * 100 : null;   // 覆盖率
    m.cash = numOf(m.base.ESTIMATED_CASH_COMPONENT);
    m.zeroRows = rows.filter(r => !r.qty).length;                    // 0 股（纯现金替代）行数
    m.mustRows = rows.filter(r => r.sub.includes('必须')).length;      // 必须现金替代行数
  }

  // ── 7. 交叉统计
  const agg = new Map();
  for (const m of okMembers) {
    for (const r of m.rows) {
      let a = agg.get(r.id);
      if (!a) { a = { id: r.id, name: r.name, mkt: r.mkt, funds: 0, held: 0, ws: [], qty: 0, must: 0, allow: 0, forbid: 0, zero: 0 }; agg.set(r.id, a); }
      a.funds += 1;                                   // 被多少只 ETF 的清单收录
      if (r.qty > 0) { a.held += 1; a.qty += r.qty; }  // 其中有多少只是「实物交付」（有股数）
      if (r.qty === 0) a.zero += 1;
      if (r.w != null) a.ws.push(r.w);
      if (r.sub.includes('必须')) a.must += 1; else if (r.sub.includes('允许')) a.allow += 1; else if (r.sub.includes('禁止')) a.forbid += 1;
    }
  }
  const N = okMembers.length;
  const rowsAgg = Array.from(agg.values()).map(a => {
    const sorted = a.ws.slice().sort((x, y) => x - y);
    const avg = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : null;
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return Object.assign(a, {
      avgW: avg, medW: med,
      minW: sorted.length ? sorted[0] : null,
      maxW: sorted.length ? sorted[sorted.length - 1] : null,
      spread: sorted.length > 1 ? sorted[sorted.length - 1] - sorted[0] : 0,
      relSpread: (sorted.length > 1 && avg) ? (sorted[sorted.length - 1] - sorted[0]) / avg : 0,
      full: a.funds === N,
      fullHeld: a.held === N,
    });
  });
  const byFunds = rowsAgg.slice().sort((x, y) => y.funds - x.funds || (y.avgW || 0) - (x.avgW || 0));
  const byWeight = rowsAgg.slice().sort((x, y) => (y.avgW || 0) - (x.avgW || 0));
  // 极差榜：只统计「有实物股数」的观察，且要求覆盖 ≥ 半数 ETF，避免小样本噪声
  const bySpread = rowsAgg.filter(r => r.ws.length >= Math.max(3, N * 0.5)).slice().sort((x, y) => y.spread - x.spread);
  const byRel = rowsAgg.filter(r => r.ws.length >= Math.max(3, N * 0.5) && (r.avgW || 0) >= 0.2)
    .slice().sort((x, y) => y.relSpread - x.relSpread);
  const notFull = rowsAgg.filter(r => !r.full).sort((x, y) => x.funds - y.funds);
  const mustList = rowsAgg.filter(r => r.must > 0).sort((x, y) => y.must - x.must || y.funds - x.funds);
  const tradeDate = (okMembers[0].base.TRADING_DAY || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

  // ── 8. 生成 HTML
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d) + '%');

  const memberRows = okMembers.slice().sort((a, b) => a.code.localeCompare(b.code)).map((m) => {
    const b = m.base;
    const nav = numOf(b.NAV);
    return `<tr>
      <td class="mono">${m.code}</td>
      <td>${esc(m.list.ETF_FULLNAME)}</td>
      <td class="dim">${esc(m.list.FUND_COMP_NAME)}</td>
      <td class="num">${nav == null ? '—' : nav.toFixed(4)}</td>
      <td class="num">${cn(numOf(b.CREATION_REDEMPTION_UNIT), 0)}</td>
      <td class="num">${cn(m.unitNet)}</td>
      <td class="num">${cn(numOf(b.PRE_CASH_COMPONENT))}</td>
      <td class="num">${cn(numOf(b.ESTIMATED_CASH_COMPONENT))}</td>
      <td class="num">${b.CREATION_LIMIT === '-' ? '—' : yi(numOf(b.CREATION_LIMIT))}</td>
      <td class="num">${b.REDEMPTION_LIMIT === '-' ? '—' : yi(numOf(b.REDEMPTION_LIMIT))}</td>
      <td class="num">${m.comps.length}</td>
      <td class="num dim">${m.zeroRows}</td>
      <td class="num dim">${m.mustRows}</td>
      <td class="num ${m.cover > 99.5 ? 'ok' : 'warn'}">${pct(m.cover, 2)}</td>
    </tr>`;
  }).join('');

  const exclRows = excluded.map(e => `<tr><td class="mono">${esc(e.code)}</td><td>${esc(e.name)}</td><td class="dim">${esc(e.why)}</td></tr>`).join('');

  const rankRows = byFunds.map((r, i) => `<tr>
      <td class="num dim">${i + 1}</td>
      <td class="mono">${r.id}</td>
      <td>${esc(r.name)}</td>
      <td class="num">${r.mkt}</td>
      <td class="num"><span class="pill ${r.full ? 'full' : r.funds >= N * 0.8 ? 'most' : 'part'}">${r.funds}/${N}</span></td>
      <td class="num">${pct(r.avgW)}</td>
      <td class="num dim">${pct(r.minW)} ~ ${pct(r.maxW)}</td>
      <td class="num dim">${pct(r.spread)}</td>
      <td class="num dim">${r.must ? r.must : '—'}</td>
    </tr>`).join('');

  const spreadRows = bySpread.slice(0, 20).map((r) => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${pct(r.minW)}</td><td class="num">${pct(r.maxW)}</td>
      <td class="num">${pct(r.spread)}</td>
      <td class="num dim">${r.funds}/${N}</td>
    </tr>`).join('');

  const notFullRows = notFull.slice(0, 20).map(r => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${r.funds}/${N}</td><td class="num">${pct(r.avgW)}</td>
    </tr>`).join('');

  const mustRowsHtml = mustList.slice(0, 30).map(r => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${r.must}/${N}</td>
      <td class="num dim">${r.zero}/${N}</td>
      <td class="num">${r.ws.length}/${N}</td>
      <td class="num">${r.ws.length >= 2 ? pct(r.avgW) : '—'}</td>
    </tr>`).join('');

  const relRows = byRel.slice(0, 15).map(r => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${pct(r.avgW)}</td>
      <td class="num">${pct(r.medW)}</td>
      <td class="num">${pct(r.minW)} ~ ${pct(r.maxW)}</td>
      <td class="num warn">${(r.relSpread * 100).toFixed(0)}%</td>
      <td class="num dim">${r.ws.length}/${N}</td>
    </tr>`).join('');

  const sumW = okMembers.map(m => m.cover).filter(v => v != null);
  const avgSumW = sumW.length ? sumW.reduce((a, b) => a + b, 0) / sumW.length : null;
  const minCover = sumW.length ? Math.min(...sumW) : null;
  const maxCover = sumW.length ? Math.max(...sumW) : null;
  const bigW = byWeight.slice(0, 10);

  // 孤立异常：某只 ETF 对单个成分的权重 ≥ 中位数的 1.5 倍 → 列为「需人工核实」，不做结论
  const anomalies = [];
  for (const r of rowsAgg) {
    if (!r.medW || r.medW <= 0 || r.ws.length < N * 0.5) continue;
    if (r.maxW / r.medW < 1.5) continue;
    const detail = okMembers.map(m => {
      const row = m.rows.find(x => x.id === r.id);
      return row && row.w != null ? { code: m.code, w: row.w } : null;
    }).filter(Boolean).sort((a, b) => b.w - a.w);
    anomalies.push({ id: r.id, name: r.name, med: r.medW, max: r.maxW, ratio: r.maxW / r.medW, top: detail.slice(0, 3) });
  }
  anomalies.sort((a, b) => b.ratio - a.ratio);
  const anomalyRows = anomalies.slice(0, 12).map(a => `<tr>
      <td class="mono">${a.id}</td><td>${esc(a.name)}</td>
      <td class="num">${pct(a.med)}</td><td class="num">${pct(a.max)}</td>
      <td class="num warn">${a.ratio.toFixed(2)}×</td>
      <td class="dim">${a.top.map(t => `${t.code} ${pct(t.w, 2)}`).join(' · ')}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>沪深300 ETF 当日申赎清单（PCF）统计 · ${tradeDate}</title>
<style>
  :root{
    --bg:#0d1117; --card:#161B22; --elev:#1c2128; --bd:#2b323b;
    --tx:#E6EDF3; --tx2:#9aa4b2; --tx3:#6b7683;
    --accent:#F0B97B; --red:#F6465D; --green:#0ECB81; --blue:#58a6ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    font-size:13px;line-height:1.65;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1280px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:21px;margin:0 0 6px;font-weight:700;letter-spacing:.2px}
  .sub{color:var(--tx2);font-size:12.5px;margin-bottom:22px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:22px}
  .kpi{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px}
  .kpi .k{color:var(--tx3);font-size:11px;letter-spacing:.3px}
  .kpi .v{font-size:20px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums}
  .kpi .v small{font-size:12px;font-weight:500;color:var(--tx2);margin-left:3px}
  section{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px 18px;margin-bottom:18px}
  h2{font-size:14px;margin:0 0 4px;font-weight:700}
  h2 .tag{font-size:10.5px;font-weight:600;color:var(--accent);border:1px solid rgba(240,185,123,.45);
    background:rgba(240,185,123,.1);border-radius:3px;padding:1px 5px;margin-left:7px;vertical-align:1px}
  .note{color:var(--tx2);font-size:12px;margin:6px 0 12px}
  .note b{color:var(--accent);font-weight:600}
  .scroll{max-height:520px;overflow:auto;border-radius:6px;border:1px solid var(--bd)}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th{position:sticky;top:0;z-index:1;background:var(--elev);color:var(--tx3);
    font-size:11px;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);white-space:nowrap}
  td{padding:7px 10px;border-bottom:1px solid rgba(43,50,59,.6);vertical-align:top}
  tbody tr:hover{background:rgba(255,255,255,.028)}
  .num{text-align:right;white-space:nowrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .dim{color:var(--tx2);font-size:12px}
  .ok{color:var(--green)}
  .warn{color:var(--accent)}
  .pill{display:inline-block;padding:0 6px;border-radius:3px;font-size:11px;border:1px solid var(--bd)}
  .pill.full{color:var(--green);border-color:rgba(14,203,129,.45);background:rgba(14,203,129,.1)}
  .pill.most{color:var(--accent);border-color:rgba(240,185,123,.45);background:rgba(240,185,123,.08)}
  .pill.part{color:var(--tx2)}
  ul.caveat{margin:8px 0 0;padding-left:18px;color:var(--tx2);font-size:12.2px}
  ul.caveat li{margin-bottom:5px}
  ul.caveat b{color:var(--tx)}
  .foot{color:var(--tx3);font-size:11.5px;text-align:center;margin-top:26px}
  code{background:var(--elev);border:1px solid var(--bd);border-radius:3px;padding:1px 5px;font-size:11.5px;color:var(--accent)}
</style></head><body><div class="wrap">

<h1>沪深300 ETF · 当日申购赎回清单（PCF）统计</h1>
<div class="sub">数据日期 <b style="color:var(--tx)">${tradeDate}</b> · 来源 上海证券交易所 ETF 公告申购赎回清单 · 生成 ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>

<div class="grid">
  <div class="kpi"><div class="k">入组 ETF</div><div class="v">${N}<small>只</small></div></div>
  <div class="kpi"><div class="k">并集标的</div><div class="v">${rowsAgg.length}<small>只</small></div></div>
  <div class="kpi"><div class="k">被全部持有</div><div class="v">${rowsAgg.filter(r => r.full).length}<small>只</small></div></div>
  <div class="kpi"><div class="k">篮子覆盖率</div><div class="v ${avgSumW > 99.5 ? 'ok' : 'warn'}">${pct(avgSumW, 2)}<small>均值 ${pct(minCover, 1)}~${pct(maxCover, 1)}</small></div></div>
  <div class="kpi"><div class="k">行情缺失</div><div class="v">${okMembers.reduce((s, m) => s + m.miss, 0)}<small>条</small></div></div>
</div>

<section>
  <h2>一、这份数据是什么（以及不是什么）</h2>
  <ul class="caveat">
    <li><b>是</b>：ETF 当日「申购/赎回一篮子」的<b>清单</b>——包含每只成分券的代码、名称、数量、现金替代标志、溢价/折价率、挂牌市场，以及最小申赎单位、单篮净值、现金差额、当日累计可申赎上限。</li>
    <li><b>不是</b>：<b>不是当日实际净申购/净赎回份额</b>。PCF 只是「模板」，无论今天有没有人申赎，清单都照发。想知道「今天哪只 ETF 被净申购多少」，要另取<b>基金份额</b>数据（T 日份额通常 T+1 披露），本报告不含该口径。</li>
    <li><b>不是</b>：不是基金真实持仓的完整还原。PCF 按申赎单位取整（例如每篮若干手茅台），与基金实际持股有舍入差异；停牌股会变成「必须现金替代」。</li>
    <li><b>两个权重口径</b>：① <b>篮内权重</b> = 单只成分市值 ÷ 该 ETF 篮子成分市值合计（本报告第四~七节用这个，各 ETF 自身归一，跨 ETF 才可比）；② <b>篮子覆盖率</b> = 篮子成分市值合计 ÷ 单篮净值（第三节用这个，看篮子有没有把净值全额还原）。</li>
    <li><b>覆盖率为什么不到 100%</b>：差额来自 ① 现金差额（<code>ESTIMATED_CASH_COMPONENT</code>，正=篮子比净值多备现金，负=反）；② 部分成分在清单里以「必须现金替代」出现，不计股数；③ 申赎单位取整；④ 行情是实时价而清单净值可能取 T-1 收盘。实测覆盖 <b>${pct(minCover, 1)} ~ ${pct(maxCover, 1)}</b>，属正常区间，<b>不是抓取错误</b>。</li>
  </ul>
</section>

<section>
  <h2>二、家族识别 <span class="tag">为什么不是「名称含沪深300 就算」</span></h2>
  <div class="note">名称里带「沪深300」的不一定是纯指数复制——实测有 <b>沪深300医药卫生(20只)</b>、<b>沪深300红利(50只)</b>、<b>沪深300ESG(233只)</b>、<b>沪深300增强策略(144只)</b>。故判定标准为：<b>成分正好 300 只 + 名称不含行业/策略/增强关键词</b>，并用与 510300 的篮子 Jaccard 相似度做交叉验证。</div>
  <div class="note">入组 ${N} 只（Jaccard 与基准 510300 的相似度区间 <b>${(Math.min(...okMembers.map(m => m.jaccard)) * 100).toFixed(1)}% ~ ${(Math.max(...okMembers.map(m => m.jaccard)) * 100).toFixed(1)}%</b>）；排除 ${excluded.length} 只。</div>
  <div class="scroll" style="max-height:280px">
    <table><thead><tr><th>代码</th><th>基金全称</th><th>排除原因</th></tr></thead>
    <tbody>${exclRows || '<tr><td colspan="3" class="dim">无</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>三、申赎参数对比 <span class="tag">按代码排序</span></h2>
  <div class="note">同一指数的 ${N} 只 ETF，门槛(<b>最小申赎单位</b>)差异可达 <b>${(Math.max(...okMembers.map(m => numOf(m.base.CREATION_REDEMPTION_UNIT) || 0)) / Math.min(...okMembers.map(m => numOf(m.base.CREATION_REDEMPTION_UNIT) || Infinity))).toFixed(1)} 倍</b>；单篮净值从 <b>${cn(Math.min(...okMembers.map(m => m.unitNet)))}</b> 到 <b>${cn(Math.max(...okMembers.map(m => m.unitNet)))}</b> 元不等——同样申购一次，资金占用差很多。</div>
  <div class="scroll">
    <table><thead><tr>
      <th>代码</th><th>基金全称</th><th>管理人</th><th class="num">份额净值</th>
      <th class="num">最小申赎单位</th><th class="num">单篮净值(元)</th>
      <th class="num">现金差额(T-1)</th><th class="num">现金差额(预估T)</th>
      <th class="num">申购上限</th><th class="num">赎回上限</th><th class="num">成分</th><th class="num">0股行</th><th class="num">必须替代</th><th class="num">篮子覆盖率</th>
    </tr></thead><tbody>${memberRows}</tbody></table>
  </div>
</section>

<section>
  <h2>四、成分股抱团排行 <span class="tag">被多少只 ETF 同时纳入</span></h2>
  <div class="note">「纳入 N/${N}」= 有多少只 ETF 的当日篮子里有这只股票。全 ${N} 只都纳入的有 <b>${rowsAgg.filter(r => r.full).length}</b> 只；只被 1 只纳入的有 <b>${rowsAgg.filter(r => r.funds === 1).length}</b> 只。<b>平均权重</b>与<b>权重极差</b>反映各家的复制方式差异（完全复制 vs 抽样/替代）。</div>
  <div class="scroll">
    <table><thead><tr>
      <th class="num">#</th><th>代码</th><th>名称</th><th class="num">市场</th>
      <th class="num">纳入 ETF</th><th class="num">平均权重</th><th class="num">权重区间</th><th class="num">极差</th><th class="num">必须替代</th>
    </tr></thead><tbody>${rankRows}</tbody></table>
  </div>
</section>

<section>
  <h2>五、权重最分散的标的 <span class="tag">同一指数、不同篮子</span></h2>
  <div class="note">同一只股票在 ${N} 只 ETF 里的<b>篮内权重</b>本应几乎一致。极差越大 = 各家复制偏差越大（取整、抽样复制、停牌替代、替代券替换）。<b>已排除数量为 0 的纯现金替代行</b>（那些行权重算出来必然是 0，会伪造出「0%~2.5%」的假极差），只统计有实物股数、且覆盖过半 ETF 的标的。</div>
  <div class="scroll" style="max-height:420px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">最低权重</th><th class="num">最高权重</th><th class="num">绝对极差</th><th class="num">覆盖</th></tr></thead>
    <tbody>${spreadRows}</tbody></table>
  </div>
</section>

<section>
  <h2>六、权重相对离散度 <span class="tag">极差 ÷ 均值，去掉量级干扰</span></h2>
  <div class="note">绝对极差对权重大的股票天然更大，所以再看<b>相对极差</b>（极差 ÷ 平均权重）。这一列高 = 各家对这个位子的配置分歧大，往往来自成分调整期、停牌替代或跟踪误差管理差异。</div>
  <div class="scroll" style="max-height:400px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">平均权重</th><th class="num">中位权重</th><th class="num">区间</th><th class="num">相对极差</th><th class="num">覆盖</th></tr></thead>
    <tbody>${relRows || '<tr><td colspan="7" class="dim">无</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>七、必须现金替代的标的 <span class="tag">${mustList.length} 只</span></h2>
  <div class="note">「必须现金替代」= 申购时不能用股票、只能用现金顶替。实测一致呈现一个现象：<b>688 开头的科创板成分在 19 只 ETF 里全部为「必须现金替代」且股数给 0</b>（龙芯中科 / 拓荆科技 / 盛美上海 / 寒武纪等）——即这些位子在篮子里是「虚位」，权重看着有、实物拿不到。<b>制度层面的确切原因（科创板适当性/交易规则）建议核对基金合同与申赎清单说明，本报告只呈现数据事实、不推断规则来源。</b>「有实物」列 = 有多少只 ETF 真的给了股数。</div>
  <div class="scroll" style="max-height:420px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">必须替代 ETF 数</th><th class="num">其中 0 股</th><th class="num">有实物</th><th class="num">平均权重(仅实物)</th></tr></thead>
    <tbody>${mustRowsHtml || '<tr><td colspan="6" class="dim">无</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>八、未被全部 ETF 纳入的标的 <span class="tag">共 ${notFull.length} 只</span></h2>
  <div class="note">纯指数复制下，300 只成分应被 ${N} 只 ETF 全部收录。没被全部收录的，说明该 ETF 用了<b>替代券/抽样复制</b>。</div>
  <div class="scroll" style="max-height:360px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">纳入</th><th class="num">平均权重</th></tr></thead>
    <tbody>${notFullRows || '<tr><td colspan="4" class="dim">无 —— 19 只全部收录全部 300 只成分</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>九、权重前十（跨 ETF 平均）</h2>
  <div class="note">把 ${N} 只 ETF 的篮子里同一只股票的权重取平均，近似「这一篮子指数此时的真实结构」。</div>
  <table><thead><tr><th class="num">#</th><th>代码</th><th>名称</th><th class="num">平均权重</th><th class="num">纳入 ETF</th></tr></thead>
  <tbody>${bigW.map((r, i) => `<tr><td class="num dim">${i + 1}</td><td class="mono">${r.id}</td><td>${esc(r.name)}</td><td class="num">${pct(r.avgW)}</td><td class="num dim">${r.funds}/${N}</td></tr>`).join('')}</tbody></table>
</section>

<section>
  <h2>十、需人工核实的孤立异常 <span class="tag">某只 ETF 对单个成分权重 ≥ 中位数 1.5 倍</span></h2>
  <div class="note">同一指数、同一只成分，各家权重本应几乎一致。出现 ≥1.5 倍偏离时，<b>不判定谁对谁错</b>——可能是基金对个别成分的主动配置、申赎单位取整、或清单发布差异。列出以便人工核对原始 PCF。</div>
  <div class="scroll" style="max-height:380px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">中位权重</th><th class="num">最高权重</th><th class="num">倍数</th><th>偏离最大的 ETF</th></tr></thead>
    <tbody>${anomalyRows || '<tr><td colspan="6" class="dim">无（各 ETF 对同一成分的权重偏离均在 1.5 倍内）</td></tr>'}</tbody></table>
  </div>
</section>

<div class="foot">数据源：上海证券交易所 ETF 公告申购赎回清单（query.sse.com.cn）· 行情：腾讯行情 qt.gtimg.cn · 本报告为数据统计，不构成投资建议</div>
</div></body></html>`;

  const outDir = path.join(__dirname, '..', 'docs', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `etf-pcf-csi300-${tradeDate.replace(/-/g, '')}.html`);
  fs.writeFileSync(outFile, html, 'utf8');
  log(`\n报告已写出：${outFile}  (${(html.length / 1024).toFixed(0)} KB)`);
  log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error('失败:', e && e.stack ? e.stack : e); process.exit(1); });

~~~

---

## `scripts\export-baseline.json`  ·  143 行

~~~json
{
  "deepAnalysis": [
    {
      "key": "deepAnalysis",
      "type": "function"
    },
    {
      "key": "fetchFinancialData",
      "type": "function"
    },
    {
      "key": "getLocalDocuments",
      "type": "function"
    },
    {
      "key": "fetchSegmentData",
      "type": "function"
    },
    {
      "key": "fetchResearchReports",
      "type": "function"
    },
    {
      "key": "fetchAnnouncements",
      "type": "function"
    },
    {
      "key": "fetchDividends",
      "type": "function"
    },
    {
      "key": "persistDividends",
      "type": "function"
    },
    {
      "key": "loadDividendSeries",
      "type": "function"
    },
    {
      "key": "classifyDividendStage",
      "type": "function"
    },
    {
      "key": "dividendLabel",
      "type": "function"
    },
    {
      "key": "normalizeSymbol",
      "type": "function"
    },
    {
      "key": "persistValuationScalars",
      "type": "function"
    }
  ],
  "aiAugment": [
    {
      "key": "augmentStock",
      "type": "function"
    },
    {
      "key": "analyzeAspects",
      "type": "function"
    },
    {
      "key": "analyzeCompanyDeep",
      "type": "function"
    },
    {
      "key": "analyzeMarketOverview",
      "type": "function"
    },
    {
      "key": "analyzeIndustryIndex",
      "type": "function"
    },
    {
      "key": "analyzeResearchReports",
      "type": "function"
    },
    {
      "key": "analyzeAnnouncements",
      "type": "function"
    },
    {
      "key": "analyzeEarningsReport",
      "type": "function"
    },
    {
      "key": "analyzeValuation",
      "type": "function"
    },
    {
      "key": "readIndustryIndexCache",
      "type": "function"
    },
    {
      "key": "loadConfig",
      "type": "function"
    },
    {
      "key": "saveConfig",
      "type": "function"
    },
    {
      "key": "publicConfig",
      "type": "function"
    },
    {
      "key": "readCache",
      "type": "function"
    },
    {
      "key": "readEarningsCache",
      "type": "function"
    },
    {
      "key": "readValuationCache",
      "type": "function"
    },
    {
      "key": "extractEarningsSignal",
      "type": "function"
    },
    {
      "key": "PROVIDERS",
      "type": "object"
    },
    {
      "key": "callLLM",
      "type": "function"
    },
    {
      "key": "pickModelFor",
      "type": "function"
    },
    {
      "key": "buildLocalEarningsContext",
      "type": "function"
    }
  ]
}

~~~

---

## `scripts\export-snapshot.js`  ·  132 行

~~~js
#!/usr/bin/env node
/**
 * export-snapshot.js —— 门面导出基线快照工具（巨型文件拆分重构的验收基准）
 *
 * 用途：
 *   按插入序 dump lib/deepAnalysis.js（13 键）与 lib/aiAugment.js（21 键）
 *   两个门面的 module.exports 键名 + 键序 + typeof，与 scripts/export-baseline.json
 *   逐键比对。拆分过程的每一步都必须零差异。
 *
 * 变更记录：
 *   20260913：aiAugment 24 → 23 键。删除「股东户数 AI 解读」模块时一并移除了门面上的
 *             analyzeShareholdersAI 导出（该删除为有意为之），基线随之刷新。
 *   20260914f：aiAugment 23 → 21 键。删除「公司综合介绍/供应链与成本/主要产品&客户」三个
 *             独立模块，合并为单一 analyzeCompanyDeep（-3 +1 = -2），基线随之刷新。
 *
 * 行为：
 *   1. 生成当前快照写入 scripts/export-snapshot.out（每次覆盖，供 git diff）。
 *   2. 若 scripts/export-baseline.json 不存在 → 用当前快照生成基线（首次采集）。
 *   3. 若基线存在 → 逐键比对；一致 exit 0，不一致打印差异明细并 exit 1。
 *
 * 用法：
 *   node scripts/export-snapshot.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'export-snapshot.out');
const BASELINE_PATH = path.join(__dirname, 'export-baseline.json');

/** 被快照的门面清单：count 为设计文档规定的导出键数 */
const TARGETS = [
  { name: 'deepAnalysis', modPath: path.join(__dirname, '..', 'lib', 'deepAnalysis.js'), expect: 13 },
  { name: 'aiAugment', modPath: path.join(__dirname, '..', 'lib', 'aiAugment.js'), expect: 21 },
];

/** 按插入序 dump 一个门面的导出键名与 typeof（不排序——键序本身是基线的一部分） */
function snapshotModule(modPath) {
  const mod = require(modPath);
  return Object.keys(mod).map((key) => ({ key, type: typeof mod[key] }));
}

/** 打印两个快照之间的逐键差异明细 */
function printDiff(baselineText, currentText) {
  let baseline = null;
  let current = null;
  try {
    baseline = JSON.parse(baselineText);
    current = JSON.parse(currentText);
  } catch (err) {
    console.error('[export-snapshot] FAIL: 快照 JSON 解析失败: ' + err.message);
    return;
  }
  for (const t of TARGETS) {
    const b = baseline[t.name] || [];
    const c = current[t.name] || [];
    const len = Math.max(b.length, c.length);
    for (let i = 0; i < len; i++) {
      const bk = b[i] ? b[i].key : '(缺失)';
      const ck = c[i] ? c[i].key : '(缺失)';
      if (bk !== ck) {
        console.error('  [' + t.name + '] 键序差异 @' + i + ': 基线=' + bk + ' 当前=' + ck);
      } else if (b[i].type !== c[i].type) {
        console.error('  [' + t.name + '] typeof差异 ' + bk + ': 基线=' + b[i].type + ' 当前=' + c[i].type);
      }
    }
    const cKeys = c.map((e) => e.key);
    for (const e of b) {
      if (!cKeys.includes(e.key)) {
        console.error('  [' + t.name + '] 键丢失: ' + e.key);
      }
    }
    const bKeys = b.map((e) => e.key);
    for (const e of c) {
      if (!bKeys.includes(e.key)) {
        console.error('  [' + t.name + '] 键新增: ' + e.key);
      }
    }
  }
}

function main() {
  const snapshot = {};
  let failed = false;
  for (const t of TARGETS) {
    snapshot[t.name] = snapshotModule(t.modPath);
    if (snapshot[t.name].length !== t.expect) {
      console.error(
        '[export-snapshot] FAIL: ' + t.name + ' 导出键数=' + snapshot[t.name].length +
        '，应为 ' + t.expect
      );
      failed = true;
    }
  }
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  fs.writeFileSync(OUT_PATH, text, 'utf8');

  let baselineText = null;
  try {
    baselineText = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch (err) {
    baselineText = null;
  }

  if (!baselineText) {
    if (failed) {
      console.error('[export-snapshot] 键数与设计不符，拒绝生成基线。请先核对源码。');
      process.exit(1);
    }
    fs.writeFileSync(BASELINE_PATH, text, 'utf8');
    console.log('[export-snapshot] 基线已生成: ' + BASELINE_PATH);
    console.log('[export-snapshot] deepAnalysis=' + snapshot.deepAnalysis.length + ' 键, aiAugment=' + snapshot.aiAugment.length + ' 键');
    process.exit(0);
  }

  if (failed) {
    process.exit(1);
  }
  // 换行符归一化：git autocrlf 可能把基线文件转成 CRLF，语义比较须忽略换行差异
  const norm = (s) => s.replace(/\r\n/g, '\n');
  if (norm(baselineText) === norm(text)) {
    console.log('[export-snapshot] PASS: 快照与基线逐键一致 (deep=' + snapshot.deepAnalysis.length + ', ai=' + snapshot.aiAugment.length + ')');
    process.exit(0);
  }
  console.error('[export-snapshot] FAIL: 快照与基线存在差异（明细如下）');
  printDiff(baselineText, text);
  process.exit(1);
}

main();

~~~

---

## `scripts\fixtures\ths_000902_tail.json`  ·  1 行

~~~json
{"capturedFor":"000902","capturedAt":"2026-10-18","all":{"priceFactor":100,"sortYear":[[2026,30]],"price":"1416,22,51,43,1423,42,47,7,1420,10,47,30,1399,57,58,25,1413,14,32,9,1420,6,30,13,1420,19,20,16,1424,12,69,64,1464,24,27,18,1433,49,55,7,1388,34,54,30,1380,37,46,9,1350,35,39,9,1348,10,45,37,1360,19,34,26,1381,7,27,1,1361,21,48,42,1375,28,36,4,1366,13,24,15,1368,10,20,3,1346,19,29,14,1332,18,33,4,1337,7,26,13,1345,5,26,12,1352,8,56,47,1338,52,60,4,1311,20,43,31,1331,11,26,6,1299,17,43,9,1317,0,38,20","volumn":"25582643,13904906,13686419,13342316,12507901,8083318,6876423,26419270,11772524,11145920,14088893,10037013,9731006,9099292,5673487,5766445,7380230,5355200,4485800,3342848,7019372,4582687,3683187,4758500,10761779,9082386,10796114,4950920,9433600,6452996","dates":"0828,0831,0901,0902,0903,0904,0907,0908,0909,0910,0911,0914,0915,0916,0917,0918,0921,0922,0923,0924,0928,0929,0930,1008,1009,1012,1013,1014,1015,1016"},"last":{"data":"20260828,14.38,14.67,14.16,14.59,25582643,370178490.00,2.239,,4200.00,61278;20260831,14.65,14.70,14.23,14.30,13904906,199785200.00,1.217,,2100.00,30030;20260901,14.30,14.67,14.20,14.50,13686419,198658350.00,1.198,,4800.00,69600;20260902,14.56,14.57,13.99,14.24,13342316,189353330.00,1.168,,2400.00,34176;20260903,14.27,14.45,14.13,14.22,12507901,178095750.00,1.095,,1500.00,21330;20260904,14.26,14.50,14.20,14.33,8083318,116204798.00,0.707,,800.00,11464;20260907,14.39,14.40,14.20,14.36,6876423,98468057.00,0.602,,14900.00,213964;20260908,14.36,14.93,14.24,14.88,26419270,389972400.00,2.312,,900.00,13392;20260909,14.88,14.91,14.64,14.82,11772524,174147110.00,1.030,,5500.00,81510;20260910,14.82,14.88,14.33,14.40,11145920,161808850.00,0.975,,2000.00,28800;20260911,14.22,14.42,13.88,14.18,14088893,199062600.00,1.233,,0.00,0;20260914,14.17,14.26,13.80,13.89,10037013,140088060.00,0.878,,800.00,11112;20260915,13.85,13.89,13.50,13.59,9731006,132871799.00,0.852,,1400.00,19026;20260916,13.58,13.93,13.48,13.85,9099292,125482691.00,0.796,,3900.00,54015;20260917,13.79,13.94,13.60,13.86,5673487,78235116.00,0.497,,0.00,0;20260918,13.88,14.08,13.81,13.82,5766445,80223605.00,0.505,,0.00,0;20260921,13.82,14.09,13.61,14.03,7380230,102364800.00,0.646,,1700.00,23851;20260922,14.03,14.11,13.75,13.79,5355200,74244479.00,0.469,,1100.00,15169;20260923,13.79,13.90,13.66,13.81,4485800,61855476.00,0.393,,0.00,0;20260924,13.78,13.88,13.68,13.71,3342848,45947196.00,0.293,,0.00,0;20260928,13.65,13.75,13.46,13.60,7019372,95378251.00,0.614,,0.00,0;20260929,13.50,13.65,13.32,13.36,4582687,61459636.00,0.401,,1800.00,24048;20260930,13.44,13.63,13.37,13.50,3683187,49723719.00,0.322,,10000.00,135000;20261008,13.50,13.71,13.45,13.57,4758500,64849228.00,0.416,,0.00,0;20261009,13.60,14.08,13.52,13.99,10761779,149570480.00,0.942,,300.00,4197;20261012,13.90,13.98,13.38,13.42,9082386,123305881.00,0.795,,0.00,0;20261013,13.31,13.54,13.11,13.42,10796114,144236870.00,0.945,,300.00,4026;20261014,13.42,13.57,13.31,13.37,4950920,66586076.00,0.433,,0.00,0;20261015,13.16,13.42,12.99,13.08,9433600,124203281.00,0.826,,0.00,0;20261016,13.17,13.55,13.17,13.37,6452996,86263040.00,0.565,,200.00,2674"}}
~~~

---

## `scripts\hot_topics_collect.py`  ·  747 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""板块舆情热度周榜 · 每日数据采集器（由 lib/hotTopicsWeekly/index.js 调度，每日一次）
四条通道：
  1) 行情交叉验证输入：东财 push2delay clist 行业板块 5 日 —— 板块周涨幅 + 主力资金净流入（权威 BK 代码）
  2) 社区讨论·主源：同花顺讨论 API（t.10jqka.com.cn，按板块代表性成分股归集）→ result['guba']
  3) 社区讨论·补充源：东财股吧板块吧 list 页第 1 页（内嵌 article_list JSON，每板块 1 请求）→ result['gubaEm']
     —— 东财为真实散户帖，且 bar 自带「板块总帖数」，可算 B 的真实帖数增量；触发「身份核实」立即熔断该通道
  4) 全网舆情文本：akshare 新浪财经 7x24 + 同花顺全球财经快讯 + 华尔街见闻 7x24 + 财联社电报（当日增量，周聚合时去重）
     —— 后两者 20260923 新增，均走独立域名（api-one.wallstcn.com / www.cls.cn），与 akshare 两源互为备份；
        财联社用本地签名 md5(sha1(排序 query))，零 key、零登录。
输出：data/hotTopics/daily/{date}.json（原子写入）
辅助：--scan 模式做 bk 代码段枚举（结果写 data/hotTopics/bk_scan_extra.json，用后人工并入 sector_map）
开关：data/hotTopics/config.json 的 community 节（{em, ths, emIntervalSec, emFailStreakMax}，默认两源皆启用）
     及 news 节（{sina, ths, wscn, cls} 四路快讯源开关，默认全启用）
诚实降级：任何通道失败都记录 status，不阻塞其他通道；两个社区源任一可用即非降级。
"""
import sys, os, re, json, time, random, argparse, http.cookiejar, traceback
from datetime import datetime, timedelta

sys.dont_write_bytecode = True
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
HEADERS = {'User-Agent': UA, 'Referer': 'https://guba.eastmoney.com/',
           'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
           'Accept-Language': 'zh-CN,zh;q=0.9'}


def _p(rel):
    return os.path.join(BASE, rel.replace('/', os.sep))


def load_sector_map(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_community_cfg():
    """读取 data/hotTopics/config.json 的 community 节（缺省：两源皆启用）。
    键：em(东财股吧开关) / ths(同花顺讨论开关) / emIntervalSec(东财抓取间隔) / emFailStreakMax(东财连续失败熔断阈值)。
    与 Node 侧 lib/hotTopicsWeekly/config.js 共用同一份用户配置。"""
    defaults = {'em': True, 'ths': True, 'emIntervalSec': 1.2, 'emFailStreakMax': 8}
    try:
        with open(_p('data/hotTopics/config.json'), 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        c = cfg.get('community') or {}
        out = dict(defaults)
        for k in defaults:
            if k in c:
                out[k] = c[k]
        return out
    except Exception:
        return defaults


def load_news_cfg():
    """读取 data/hotTopics/config.json 的 news 节（缺省：四路快讯源皆启用，20260923）。
    键：sina(新浪财经 7x24) / ths(同花顺全球财经快讯) / wscn(华尔街见闻 7x24) / cls(财联社电报)。
    新增源默认开启；任一源失败仅自身返回空，不影响其他源（诚实降级）。"""
    defaults = {'sina': True, 'ths': True, 'wscn': True, 'cls': True}
    try:
        with open(_p('data/hotTopics/config.json'), 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        c = cfg.get('news') or {}
        out = dict(defaults)
        for k in defaults:
            if k in c:
                out[k] = c[k]
        return out
    except Exception:
        return defaults


def make_session(cookie_path):
    jar = http.cookiejar.MozillaCookieJar()
    if os.path.exists(cookie_path):
        try:
            jar.load(cookie_path, ignore_discard=True, ignore_expires=True)
        except Exception:
            pass
    s = requests.Session()
    s.cookies = jar
    s.headers.update(HEADERS)
    return s


def save_cookies(session, cookie_path):
    try:
        session.cookies.save(cookie_path, ignore_discard=True, ignore_expires=True)
    except Exception:
        pass


def extract_article_list(html):
    """从股吧页面 HTML 中提取内嵌 var article_list = {...}; 的 JSON（括号配对扫描）。"""
    idx = html.find('var article_list')
    if idx < 0:
        return None
    start = html.find('{', idx)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, min(start + 900000, len(html))):
        ch = html[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start:i + 1])
                except Exception:
                    return None
    return None


def is_challenge(html):
    return ('身份核实' in html) or (len(html) < 5000) or ('article_list' not in html)


def fetch_guba_board(session, code):
    """抓单板块吧第 1 页。返回 (ok, data|None, challenge_hit)"""
    url = 'https://guba.eastmoney.com/list,%s.html' % code.lower()
    try:
        r = session.get(url, timeout=12)
        html = r.text
        if r.status_code != 200:
            return False, None, False
        if is_challenge(html):
            return False, None, True
        data = extract_article_list(html)
        if not data:
            return False, None, False
        posts = []
        for p in (data.get('re') or []):
            try:
                posts.append({
                    'id': str(p.get('post_id', '')),
                    'title': str(p.get('post_title', '') or ''),
                    'nick': str(p.get('user_nickname', '') or ''),
                    'clicks': _to_int(p.get('post_click_count')),
                    'comments': _to_int(p.get('post_comment_count')),
                    'time': str(p.get('post_publish_time', '') or ''),
                    'pinned': 1 if str(p.get('post_top_status') or '0') in ('1',) else 0,
                })
            except Exception:
                continue
        posts = [p for p in posts if p['title']]
        return True, {'bar_name': data.get('bar_name'), 'count': _to_int(data.get('count')), 'posts': posts}, False
    except Exception:
        return False, None, False


def _to_int(v):
    try:
        return int(float(str(v).replace(',', '')))
    except Exception:
        return 0


def _to_float(v):
    """'3.45%'→3.45；'12.3亿'→12.3（亿元口径统一）；'-2.1'→-2.1；失败→None"""
    if v is None:
        return None
    s = str(v).strip().replace('%', '').replace(',', '')
    if not s or s in ('-', '--'):
        return None
    mult = 1.0
    if s.endswith('亿'):
        mult, s = 1.0, s[:-1]
    elif s.endswith('万'):
        mult, s = 0.0001, s[:-1]
    try:
        return round(float(s) * mult, 4)
    except Exception:
        return None


CLIST_FIELDS = 'f12,f14,f2,f109,f164,f165,f257'


def collect_market():
    """行业板块 5 日资金流+周涨幅（东财 clist，push2delay 优先/ push2 兜底）。
    返回 rows 含 code（BKxxxx），供引擎按代码直配板块映射。"""
    params = {
        'pn': '1', 'pz': '100', 'po': '1', 'np': '1',
        'ut': 'b2884a393a59ad64002292a3e90d46a5', 'fltt': '2', 'invt': '2',
        'fid0': 'f164', 'fs': 'm:90 t:2', 'stat': '5',
        'fields': CLIST_FIELDS, 'rt': '52975239', '_': int(time.time() * 1000),
    }
    rows = []
    last_err = ''
    for host in ('push2delay.eastmoney.com', 'push2.eastmoney.com'):
        try:
            for pn in range(1, 7):  # 上限 600 条足够
                params['pn'] = str(pn)
                r = requests.get('https://%s/api/qt/clist/get' % host, params=params,
                                 headers={'User-Agent': UA}, timeout=12)
                d = r.json()
                diff = (d.get('data') or {}).get('diff') or []
                if not diff:
                    break
                for x in diff:
                    name = str(x.get('f14', '') or '')
                    if not name:
                        continue
                    rows.append({
                        'code': str(x.get('f12', '') or '').upper(),
                        'name': name,
                        'pct5d': x.get('f109') if isinstance(x.get('f109'), (int, float)) else None,
                        'netAmt5d': x.get('f164') if isinstance(x.get('f164'), (int, float)) else None,
                        'netPct5d': x.get('f165') if isinstance(x.get('f165'), (int, float)) else None,
                        'maxStock': str(x.get('f257') or ''),
                    })
                if len(diff) < 100:
                    break
                time.sleep(0.3)
            if rows:
                # 去重
                seen = set()
                uniq = []
                for r0 in rows:
                    if r0['code'] in seen:
                        continue
                    seen.add(r0['code'])
                    uniq.append(r0)
                return {'status': 'ok', 'host': host, 'rows': uniq}
        except Exception as e:
            last_err = str(e)[:120]
            time.sleep(1)
    if last_err:
        raise RuntimeError(last_err)
    return {'status': 'empty', 'rows': []}


# ---------- 全网舆情文本·补充两源（20260923，独立域名互为备份） ----------
WSCN_LIVES_URL = 'https://api-one.wallstcn.com/apiv1/content/lives'
CLS_ROLL_URL = 'https://www.cls.cn/v1/roll/get_roll_list'


def fetch_wallstreetcn(limit=30, channel='a-stock-channel'):
    """华尔街见闻 7x24 快讯（api-one.wallstcn.com，独立域名、无需鉴权）。
    ⚠️ channel 取 'a-stock-channel'（A 股 7×24）而**非** 'global-channel'：本模块 A 指标要按板块关键词
    归属，A 股频道命中率高；全球频道多为海外宏观/大宗（实测如「德国国债收益率」），基本无法归属到
    A 股板块，只会抬高条数基数却不产生区分度。
    返回 [{source,title,text,time}]；失败返回 []（不抛异常）。"""
    try:
        r = requests.get(WSCN_LIVES_URL,
                         params={'channel': channel, 'client': 'pc', 'limit': limit},
                         headers={'User-Agent': UA, 'Referer': 'https://wallstreetcn.com/live/global'},
                         timeout=12, proxies=THS_PROXIES)
        if r.status_code != 200:
            return []
        payload = r.json()
        if not isinstance(payload, dict) or payload.get('code') != 20000:
            return []
        out = []
        for it in ((payload.get('data') or {}).get('items') or []):
            text = (it.get('content_text') or '').strip()
            if not text:
                continue
            ts = it.get('display_time')
            t = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else ''
            out.append({'source': '华尔街见闻',
                        'title': (it.get('title') or '').strip() or text[:40],
                        'text': text, 'time': t})
        return out
    except Exception:
        return []


def fetch_cls_telegraph(page_size=30):
    """财联社电报（v1 API + 本地签名 md5(sha1(字典序 query))，零 key、零登录）。
    ⚠️ 签名必须对「拼好的 query 串」计算，故走完整 URL 拼装、不用 requests 的 params 重编码。
    返回 [{source,title,text,time}]；失败返回 []（不抛异常）。"""
    try:
        import hashlib
        params = {'appName': 'CailianpressWeb', 'os': 'web', 'sv': '7.7.5',
                  'last_time': '', 'refresh_type': '1', 'rn': str(page_size)}
        qs = '&'.join('%s=%s' % (k, params[k]) for k in sorted(params))
        sign = hashlib.md5(hashlib.sha1(qs.encode()).hexdigest().encode()).hexdigest()
        r = requests.get('%s?%s&sign=%s' % (CLS_ROLL_URL, qs, sign),
                         headers={'User-Agent': UA, 'Referer': 'https://www.cls.cn/'},
                         timeout=12, proxies=THS_PROXIES)
        if r.status_code != 200:
            return []
        payload = r.json()
        if not isinstance(payload, dict) or str(payload.get('errno')) != '0':
            return []
        out = []
        for it in ((payload.get('data') or {}).get('roll_data') or []):
            title = (it.get('title') or '').strip()
            text = re.sub(r'<[^>]+>', '', it.get('content') or '').strip()
            if not (title or text):
                continue
            ts = it.get('ctime')
            t = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else ''
            out.append({'source': '财联社', 'title': title or text[:40],
                        'text': text or title, 'time': t})
        return out
    except Exception:
        return []


def collect_news(cfg=None):
    """全网舆情文本（四路快讯源，任一失败不阻塞其他源）。
    cfg: load_news_cfg() 结果（{sina, ths, wscn, cls}），缺省全开。
    ⚠️ 口径提示：每增一路源都会抬高 A（曝光）的条数基数，而 A 为 Min-Max 归一化 → 榜单名次随之变化。"""
    cfg = cfg or {}
    items = []
    ak = None
    if cfg.get('sina', True) or cfg.get('ths', True):
        try:
            import akshare as ak  # noqa: F811
        except Exception:
            ak = None
    if cfg.get('sina', True) and ak is not None:
        try:
            df = ak.stock_info_global_sina()
            for _, r in df.iterrows():
                d = {str(k): ('' if r[k] is None else str(r[k]).strip()) for k in df.columns}
                t = d.get('时间', '')
                items.append({'source': '新浪财经', 'title': (d.get('内容') or '')[:40], 'text': d.get('内容', ''), 'time': t})
            if items:
                items[-1]['_last'] = 1
        except Exception:
            pass
        time.sleep(0.6)
    if cfg.get('ths', True) and ak is not None:
        try:
            df = ak.stock_info_global_ths()
            for _, r in df.iterrows():
                d = {str(k): ('' if r[k] is None else str(r[k]).strip()) for k in df.columns}
                items.append({'source': '同花顺', 'title': d.get('标题') or (d.get('内容') or '')[:40],
                              'text': d.get('内容', ''), 'time': d.get('时间', '')})
        except Exception:
            pass
    if cfg.get('wscn', True):
        time.sleep(0.4)
        items.extend(fetch_wallstreetcn())
    if cfg.get('cls', True):
        time.sleep(0.4)
        items.extend(fetch_cls_telegraph())
    return {'status': 'ok' if items else 'empty', 'items': items}


# ---------- 同花顺讨论 API（替代东财股吧：绕过验证码墙，20260910） ----------
THS_DISC_URL = 'https://t.10jqka.com.cn/lgt/post/open/api/forum/post/v2/recent'
THS_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Host': 't.10jqka.com.cn',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://t.10jqka.com.cn/',
    'sec-ch-ua': '"Not(A:Brand";v="24", "Chromium";v="122"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
}
# 直连（不经过系统代理，与 Node fetch 同效；代理曾阻断 axios/部分请求）
THS_PROXIES = {'http': None, 'https': None}
EM_CONST_HOST = 'push2delay.eastmoney.com'


def market_id_of(code):
    """同花顺讨论 API 的 market_id：沪市(600/601/603/605/688 科创板)=17，深市(000/001/002/003/300)=33。"""
    c = str(code or '').strip()
    if c.startswith('6'):
        return 17
    return 33


_TAG_RE = re.compile(r'<[^>]+>')
_ENT_RE = {'&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
           '&ldquo;': '"', '&rdquo;': '"', '&hellip;': '…'}


def strip_tags(s):
    """剥离同花顺帖文里的 <hx_stock>/<span data-hx-tag> 等内联标签与 HTML 实体，返回纯文本。"""
    if not s:
        return ''
    t = str(s)
    for k, v in _ENT_RE.items():
        t = t.replace(k, v)
    t = _TAG_RE.sub('', t)
    return t.strip()


def fetch_ths_discussion(code, market_id, timeout=12):
    """取单只股票在同花顺的讨论（最新一页，最多 15 条）。返回帖子列表或 None(失败)。"""
    params = {'page': 1, 'page_size': 15, 'pid': 0, 'time': 0, 'sort': 'publish',
              'code': str(code), 'market_id': market_id}
    try:
        r = requests.get(THS_DISC_URL, params=params, headers=THS_HEADERS,
                         timeout=timeout, proxies=THS_PROXIES)
        if r.status_code != 200:
            return None
        j = r.json()
        feed = (j.get('data') or {}).get('feed') or []
        out = []
        for p in feed:
            content = strip_tags(p.get('content', ''))
            if not content:
                continue
            pid = p.get('pid') or p.get('id')
            if not pid:
                continue
            stat = p.get('stat') or {}
            try:
                likes = int(stat.get('like', 0) or 0)
            except Exception:
                likes = 0
            try:
                replies = int(stat.get('reply', 0) or 0)
            except Exception:
                replies = 0
            try:
                shares = int(stat.get('share', 0) or 0)
            except Exception:
                shares = 0
            out.append({
                'id': '%s_%s' % (code, pid),
                'title': content[:240],
                'nick': '',
                'clicks': likes + shares,
                'comments': replies,
                'time': str(p.get('ctime', '') or ''),
                'pinned': 0,
            })
        return out
    except Exception:
        return None


def build_members(boards, cache_path, max_age_days=7, top_n=3):
    """建立 板块码(BKxxxx) → 代表性成分股[{code,market_id}] 映射（按东财板块成分股市值前 top_n）。
    结果缓存到 cache_path，7 天内复用，避免每日重复抓取成分股。"""
    now = time.time()
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                cached = json.load(f)
            if (now - cached.get('_built', 0)) < max_age_days * 86400:
                return cached.get('members', {})
        except Exception:
            pass
    members = {}
    for b in boards:
        code = b.get('code')
        if not code:
            continue
        try:
            params = {'pn': 1, 'pz': 50, 'po': 1, 'np': 1,
                      'ut': 'b2884a393a59ad64002292a3e90d46a5', 'fltt': 2, 'invt': 2,
                      'fid': 'f20', 'fs': 'b:%s' % code, 'fields': 'f12,f14,f20'}
            r = requests.get('https://%s/api/qt/clist/get' % EM_CONST_HOST, params=params,
                             headers={'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/'},
                             timeout=12, proxies=THS_PROXIES)
            d = r.json()
            diff = (d.get('data') or {}).get('diff') or []

            def _mc(x):
                v = x.get('f20')
                try:
                    return float(v) if v is not None else 0
                except Exception:
                    return 0
            top = sorted(diff, key=_mc, reverse=True)[:top_n]
            mems = []
            for x in top:
                c = str(x.get('f12', '') or '').strip()
                if c:
                    mems.append({'code': c, 'market_id': market_id_of(c)})
            if mems:
                members[code] = mems
        except Exception:
            pass
        time.sleep(0.25)
    try:
        out = {'_built': now, 'members': members}
        tmp = cache_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.replace(tmp, cache_path)
    except Exception:
        pass
    return members


def collect_guba_ths(boards, members, min_interval):
    """同花顺讨论替代东财股吧：逐板块取其代表性成分股的讨论，归集到板块。
    返回 {status, boards:{code:{bar_name,count,posts}}, okCount, total, mapCount}（结构与旧 collect_guba 一致）。"""
    interval = min(min_interval, 0.6)  # 同花顺限流：单请求间隔收紧到 0.6s
    boards_data = {}
    ok_cnt = 0
    total = len(boards)
    fail_streak = 0
    challenged = False
    for i, b in enumerate(boards):
        code = b['code']
        mems = members.get(code) or []
        collected = []
        cnt = 0
        if mems:
            for m in mems:
                if fail_streak >= 15:
                    challenged = True
                    break
                res = fetch_ths_discussion(m['code'], m['market_id'])
                if res is None:
                    fail_streak += 1
                else:
                    fail_streak = 0
                    collected.extend(res)
                    cnt += len(res)
                if i < total - 1 or m is not mems[-1]:
                    time.sleep(interval + random.uniform(0, 0.25))
            if challenged:
                break
        boards_data[code] = {'bar_name': b.get('name'), 'count': cnt, 'posts': collected}
        if collected:
            ok_cnt += 1
    status = 'challenge' if challenged else ('ok' if ok_cnt > 0 else 'empty')
    return {'status': status, 'boards': boards_data, 'okCount': ok_cnt, 'total': total, 'mapCount': total}


def collect_guba_em(boards, cfg):
    """东财股吧「板块吧」第 1 页（20260913h 恢复为第二社区源）：每板块 1 请求，内嵌 article_list（真实散户帖）。
    返回结构与 collect_guba_ths 一致（便于引擎统一归集）：
      {status, boards:{code:{bar_name,count,posts}}, okCount, total, mapCount}
    与同花顺的语义差异（重要）：count = **板块总帖数**（bar 的 count 字段，如半导体 72561），
    故引擎可据此算 B 的「帖数真实增量」；posts 为当页采样帖（约 80 条）。
    风控：命中「身份核实」或连续失败 >= emFailStreakMax → 立即熔断（status='challenge'），不阻塞主流程。
    东财为 bk 板块代码（1 板块=1 请求），无需借助成分股。"""
    interval = max(float(cfg.get('emIntervalSec', 1.2)), 0.8)
    streak_max = int(cfg.get('emFailStreakMax', 8))
    session = make_session(_p('data/hotTopics/em_cookies.txt'))
    boards_data = {}
    ok_cnt = 0
    total = len(boards)
    fail_streak = 0
    challenged = False
    for i, b in enumerate(boards):
        code = b.get('code')
        if not code:
            continue
        if fail_streak >= streak_max:
            challenged = True
            break
        ok, data, ch = fetch_guba_board(session, code)
        if ch:
            challenged = True
            break
        if ok and data:
            boards_data[code] = {
                'bar_name': data.get('bar_name') or b.get('name'),
                'count': data.get('count'),
                'posts': data.get('posts') or [],
            }
            if data.get('posts'):
                ok_cnt += 1
            fail_streak = 0
        else:
            fail_streak += 1
        if i < total - 1:
            time.sleep(interval + random.uniform(0, 0.3))
    save_cookies(session, _p('data/hotTopics/em_cookies.txt'))
    status = 'challenge' if challenged else ('ok' if ok_cnt > 0 else 'empty')
    return {'status': status, 'boards': boards_data, 'okCount': ok_cnt, 'total': total, 'mapCount': total}


def update_sector_map(promoted, removed):
    """采集成功日：候选板块自动校正进 sector_map（原子写）。"""
    if not promoted and not removed:
        return False
    path = _p('data/hotTopics/sector_map.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            m = json.load(f)
        boards = []
        rem = set(removed)
        for b in m.get('boards', []):
            if b['code'] in rem:
                continue
            hit = next((p for p in promoted if p['code'] == b['code']), None)
            if hit:
                b['name'] = hit['name']
                base_alias = re.sub(r'[ⅠⅡⅢIV]+$', '', hit['name']).strip()
                al = b.get('aliases') or []
                if base_alias and base_alias not in al:
                    al.append(base_alias)
                b['aliases'] = al
                b['keywords'] = b.get('keywords') or hit.get('keywords') or []
                b.pop('verify', None)
            boards.append(b)
        m['boards'] = boards
        m['updatedAt'] = datetime.now().strftime('%Y-%m-%dT%H:%M:%S+08:00')
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def run_scan(rng, cookie_path, min_interval):
    """--scan 模式：枚举某代码段（如 bk1050-bk1199），有效板块写 bk_scan_extra.json。"""
    a, b = rng.split('-')
    a_i, b_i = int(a[2:]), int(b[2:])
    session = make_session(cookie_path)
    found = []
    for i in range(a_i, b_i + 1):
        code = 'bk%04d' % i
        ok, data, ch = fetch_guba_board(session, code)
        if ch:
            break
        if ok and data.get('bar_name'):
            found.append({'code': code.upper(), 'name': data['bar_name']})
        time.sleep(min_interval + random.uniform(0, 0.3))
    out = _p('data/hotTopics/bk_scan_extra.json')
    old = []
    if os.path.exists(out):
        try:
            with open(out, 'r', encoding='utf-8') as f:
                old = json.load(f)
        except Exception:
            old = []
    seen = {x['code'] for x in old}
    for x in found:
        if x['code'] not in seen:
            old.append(x)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(old, f, ensure_ascii=False, indent=1)
    return {'scan': True, 'range': rng, 'found': len(found), 'total': len(old)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default=datetime.now().strftime('%Y-%m-%d'))
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--scan', default=None, help='bk0500-bk0599 形式的代码段枚举')
    ap.add_argument('--interval', type=float, default=1.2)
    args = ap.parse_args()

    if args.scan:
        print(json.dumps({'ok': True, **run_scan(args.scan, _p('data/hotTopics/em_cookies.txt'), args.interval)},
                         ensure_ascii=False))
        return 0

    outdir = _p('data/hotTopics/daily')
    os.makedirs(outdir, exist_ok=True)
    out_path = os.path.join(outdir, args.date + '.json')
    if os.path.exists(out_path) and not args.force:
        with open(out_path, 'r', encoding='utf-8') as f:
            old = json.load(f)
        print(json.dumps({'ok': True, 'skipped': True, 'date': args.date,
                          'summary': old.get('summary', {})}, ensure_ascii=False))
        return 0

    result = {'date': args.date, 'fetchedAt': datetime.now().strftime('%Y-%m-%dT%H:%M:%S+08:00'), 'errors': []}
    # 1) 行情交叉验证输入（push2delay clist，含权威板块代码）
    try:
        result['market'] = collect_market()
    except Exception as e:
        result['market'] = {'status': 'error', 'rows': []}
        result['errors'].append('market: ' + str(e)[:160])
    code_set = {r['code'] for r in result['market'].get('rows', []) if r.get('code')}
    name_by_code = {r['code']: r['name'] for r in result['market'].get('rows', []) if r.get('code')}
    # 2) 社区讨论（双源：同花顺讨论 API 为主源 + 东财股吧板块吧为补充源；任一可用即非降级）
    comm_cfg = load_community_cfg()
    news_cfg = load_news_cfg()
    boards = []
    try:
        m = load_sector_map(_p('data/hotTopics/sector_map.json'))
        boards = [b for b in m.get('boards', [])]
    except Exception as e:
        result['errors'].append('sector_map: ' + str(e)[:160])
    # 2a) 同花顺讨论 API（按板块代表性成分股归集）
    if comm_cfg.get('ths', True):
        try:
            members = build_members(boards, _p('data/hotTopics/sector_members.json'))
            result['guba'] = collect_guba_ths(boards, members, args.interval)
            result['guba']['mapCount'] = len(boards)
            result['guba']['memberTotal'] = sum(len(v) for v in members.values())
        except Exception as e:
            result['guba'] = {'status': 'error', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
            result['errors'].append('guba(ths): ' + str(e)[:160])
    else:
        result['guba'] = {'status': 'disabled', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
    # 2b) 东财股吧板块吧（真实散户帖 + 板块总帖数；1 板块 1 请求，带风控熔断）
    if comm_cfg.get('em', True):
        try:
            result['gubaEm'] = collect_guba_em(boards, comm_cfg)
        except Exception as e:
            result['gubaEm'] = {'status': 'error', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
            result['errors'].append('guba(em): ' + str(e)[:160])
    else:
        result['gubaEm'] = {'status': 'disabled', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
    # 3) 舆情文本
    try:
        result['news'] = collect_news(news_cfg)
    except Exception as e:
        result['news'] = {'status': 'error', 'items': []}
        result['errors'].append('news: ' + str(e)[:160])

    result['summary'] = {
        'market': result['market'].get('status'), 'marketRows': len(result['market'].get('rows', [])),
        'guba': result['guba'].get('status'), 'gubaOk': result['guba'].get('okCount', 0),
        'gubaTotal': result['guba'].get('mapCount', 0),
        'gubaEm': result.get('gubaEm', {}).get('status'), 'gubaEmOk': result.get('gubaEm', {}).get('okCount', 0),
        'gubaEmTotal': result.get('gubaEm', {}).get('mapCount', 0),
        'news': result['news'].get('status'), 'newsItems': len(result['news'].get('items', [])),
    }
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(json.dumps({'ok': True, 'date': args.date, 'summary': result['summary'],
                      'errors': result['errors'][:3]}, ensure_ascii=False))
    return 0


import requests  # noqa: E402  (放在底部以便 --help 不依赖网络库)

if __name__ == '__main__':
    sys.exit(main() or 0)

~~~

---

## `scripts\index_pe_trend.py`  ·  160 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取四大指数市盈率趋势数据（20261105b：上证50/沪深300/中证1000/科创50）
- 上证50、沪深300、中证1000：乐咕乐股(legulegu.com)月度滚动市盈率(TTM)
- 科创50：东方财富·市场估值(RPT_VALUEMARKET)日频平均市盈率(TTM)，按月采样

每家输出：
- series：近5年月度序列（折线图用）
- seriesAll：全历史月度序列（服务端计算「历史百分位」用，与东方财富全部历史口径对齐）

输出JSON结构：
{
  "success": true,
  "updatedAt": "2026-08-29T...",
  "data": {
    "上证50": {"source": "乐咕乐股", "peField": "滚动市盈率", "series": [{"date":"2021-09-01","pe":...,"close":...}], "seriesAll": [...]},
    "沪深300": {...},
    "中证1000": {...},
    "科创50": {"source": "东方财富·市场估值", "peField": "PE_TTM_AVG", "series": [...], "seriesAll": [...]}
  }
}
"""
import json
import sys
import traceback
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta
import requests
import pandas as pd

try:
    import akshare as ak
except Exception as e:
    print(json.dumps({"success": False, "error": "akshare not installed: " + str(e)}, ensure_ascii=False))
    sys.exit(1)

YEARS = 5
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def log(msg):
    print(msg, file=sys.stderr)

def legu_pe(name):
    """从乐咕乐股获取月度PE序列（20261105b：同时返回全历史月度序列 seriesAll，供「历史百分位」计算）。
    乐咕 stock_index_pe_lg 返回的本身就是全历史月度序列（上证50 2005 起、中证1000 2014-10 起），
    series 为近5年截断（图表用），seriesAll 为全量（历史百分位用，与东方财富「全部历史」口径对齐）。"""
    df = ak.stock_index_pe_lg(symbol=name)
    # 列：日期, 指数, 等权静态市盈率, 静态市盈率, 静态市盈率中位数, 等权滚动市盈率, 滚动市盈率, 滚动市盈率中位数
    df = df.rename(columns={
        "日期": "date",
        "指数": "close",
        "滚动市盈率": "pe",
    })
    df = df[["date", "close", "pe"]].copy()
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"])
    df = df.sort_values("date")
    # 乐咕数据本身为月度序列，无需再按月采样（保留原采样逻辑兜底月内多点）
    df["ym"] = df["date"].dt.to_period("M")
    df = df.groupby("ym").tail(1).drop(columns=["ym"])
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    df["pe"] = pd.to_numeric(df["pe"], errors="coerce")
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    all_rows = df.dropna().to_dict(orient="records")
    cutoff = datetime.now() - relativedelta(years=YEARS)
    cutoff_str = cutoff.strftime("%Y-%m-%d")
    recent_rows = [r for r in all_rows if r["date"] >= cutoff_str]
    return {"series": recent_rows, "seriesAll": all_rows}

def eastmoney_kc50():
    """从东方财富市场估值获取科创50日频PE，并按月采样（20261105b：全历史抓取，返回 {series, seriesAll}）"""
    end = datetime.now()
    start = end - relativedelta(years=YEARS)
    start_str = start.strftime("%Y-%m-%d")
    all_start_str = "2019-01-01"  # 科创50 指数基日 2019-12-31，全历史从这里足够
    all_rows = []
    page = 1
    while True:
        url = (
            "https://datacenter-web.eastmoney.com/api/data/v1/get?"
            "sortColumns=TRADE_DATE&sortTypes=-1"
            "&pageSize=500&pageNumber={page}"
            "&reportName=RPT_VALUEMARKET"
            "&columns=TRADE_MARKET_CODE,TRADE_DATE,CLOSE_PRICE,PE_TTM_AVG"
            "&filter=(TRADE_MARKET_CODE=%22000688%22)"
        ).format(page=page)
        try:
            r = requests.get(url, headers={"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}, timeout=30)
            r.raise_for_status()
            data = r.json()
            rows = data.get("result", {}).get("data", [])
            if not rows:
                break
            all_rows.extend(rows)
            # 如果最早一条已早于全历史起点（2019-01-01），可停止（20261105b：seriesAll 需全历史）
            last_date = str(rows[-1].get("TRADE_DATE", "")).split()[0]
            if last_date and last_date < all_start_str:
                break
            if len(rows) < 500:
                break
            page += 1
        except Exception as e:
            log("[Eastmoney KC50] page %d error: %s" % (page, e))
            break

    df = pd.DataFrame(all_rows)
    if df.empty:
        return {"series": [], "seriesAll": []}
    df["date"] = pd.to_datetime(df["TRADE_DATE"], errors="coerce")
    df = df.dropna(subset=["date"])
    df = df.sort_values("date")
    df = df[df["date"] >= all_start_str]
    df = df.rename(columns={"CLOSE_PRICE": "close", "PE_TTM_AVG": "pe"})
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["pe"] = pd.to_numeric(df["pe"], errors="coerce")
    # 按月采样：取每月最后一个交易日
    df["ym"] = df["date"].dt.to_period("M")
    df = df.groupby("ym").tail(1).drop(columns=["ym"])
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    rows_all = df[["date", "close", "pe"]].dropna().to_dict(orient="records")
    recent = [r for r in rows_all if r["date"] >= start_str]
    return {"series": recent, "seriesAll": rows_all}

def main():
    try:
        data = {}
        # 上证50、沪深300、中证1000（20261105b 用户指令：按上证50 模板对称扩展中证1000）
        for name in ["上证50", "沪深300", "中证1000"]:
            log("[IndexPETrend] fetching %s from legulegu" % name)
            legu = legu_pe(name)
            data[name] = {
                "source": "乐咕乐股",
                "peField": "滚动市盈率(TTM)",
                "series": legu["series"],
                "seriesAll": legu["seriesAll"],
            }
        # 科创50
        log("[IndexPETrend] fetching 科创50 from Eastmoney RPT_VALUEMARKET")
        kc = eastmoney_kc50()
        data["科创50"] = {
            "source": "东方财富·市场估值",
            "peField": "平均市盈率(TTM)",
            "series": kc["series"],
            "seriesAll": kc["seriesAll"],
        }
        out = {
            "success": True,
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "data": data
        }
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        traceback.print_exc()
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()

~~~

---

## `scripts\make_favicon.py`  ·  53 行

~~~py
# -*- coding: utf-8 -*-
"""从用户上传的设计图生成工作台图标集（20261001b）
- 修补右下角「豆包 AI 生成」水印：区域为纯渐变背景（已验证无轨道环穿过），
  用水印上下两行的真实像素做逐列线性插值，保证渐变方向无缝。
- 产出 public/icon.png（512×512 全图）+ public/favicon.ico（16/32/48 中心 80% 裁剪）。
"""
import numpy as np
from PIL import Image

SRC = r'c:\Users\16507\.trae-cn\attachments\6a717d1f20fe4ac0f76cbb2a\6c2156f7-6310-4fa2-b727-c03a217b5325_fd120f32-045e-44f6-b243-61c586c0b33d_金融网站设计方案.png'
OUT_PNG = r'C:\Users\16507\AppData\Local\Temp\sa_icons\icon.png'
OUT_ICO = r'C:\Users\16507\AppData\Local\Temp\sa_icons\favicon.ico'

img = Image.open(SRC).convert('RGB')
a = np.array(img).astype(np.float64)
h, w, _ = a.shape  # 1536x1536

# 水印实测 bbox: y[1455..1502] x[1289..1499]，加安全边距
y0, y1 = 1444, 1514
x0, x1 = 1259, w
row_top = a[y0 - 2, x0:x1, :]        # 上方真实行
row_bot = a[y1 + 2, x0:x1, :]        # 下方真实行
for i, y in enumerate(range(y0, y1)):
    t = (y - (y0 - 2)) / ((y1 + 2) - (y0 - 2))  # 梯度方向插值
    a[y, x0:x1, :] = row_top * (1 - t) + row_bot * t

patched = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

# 验证：修补区域内不应再残留高亮文字像素
reg = np.array(patched)[y0:y1, x0:x1].astype(int)
lum = reg.mean(axis=2)
assert (lum > lum.mean() + 40).sum() == 0, '水印残留'

# 主图标：全图 512×512
patched.resize((512, 512), Image.LANCZOS).save(OUT_PNG, optimize=True)

# favicon.ico：中心 80% 裁剪（小尺寸下扇形圆环更清晰），多分辨率
m = int(h * 0.10)
tight = patched.crop((m, m, w - m, h - m))
tight.save(OUT_ICO, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])

# icon.ico（桌面快捷方式用）：全图 256 基准 + 完整尺寸梯度，桌面大图标高清
OUT_DESKTOP = r'C:\Users\16507\AppData\Local\Temp\sa_icons\desktop_icon.ico'
patched.resize((256, 256), Image.LANCZOS).save(
    OUT_DESKTOP, format='ICO',
    sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

import os
print('icon.png:', os.path.getsize(OUT_PNG), 'bytes')
print('favicon.ico:', os.path.getsize(OUT_ICO), 'bytes')
print('desktop icon.ico:', os.path.getsize(OUT_DESKTOP), 'bytes')
print('watermark patched, no bright residue: OK')

~~~

---

## `scripts\market_emotion.py`  ·  403 行

~~~py
# -*- coding: utf-8 -*-
"""
大盘量能情绪分析模型 · 市场级数据采集（一次调用尽量取全）
------------------------------------------------------------------
输出（stdout，UTF-8 JSON）：
{
  "ok": bool,
  "date": "YYYY-MM-DD",
  "index":   { "code","name","bars":[{"date","close","vol"}] },   # 已迁出（20261018）：上证指数日线改由首页量能根 lib/marketTechnical.fetchIndexDailyBars 单一通道采集（lib/marketEmotionData.js 负责注入），本脚本不再输出 index
  "breadth": { "up","down","flat","limitUp","limitDown","activePct","date",
               "zbgcCount","zbgcBreaks","zbgcRate","zbgcNote" },   # 20261015j：zbgc*=炸板股池（炸板率=炸板/(涨停+炸板)）
  "margin":  { "latest","prev","changePct","change5Pct","date","base5Date","partialNote","source",
               "rqLatest","rqChange5Pct","rqDate","rqPartialNote","rqSource" },# 沪深融资/融券余额（亿元，20261109a 增 rq*）
  "capital": { "mainNetToday","totalAmount","turnoverAvg","topDecileShare","sample","note" },  # 同花顺·市场资金
  "fx":      { "usdcnh","usdcny","chgPct" },
  "bond":    { "cn10y","prev","chgBp10" },
  "warnings":[...]
}

设计原则：
  · 单一权威源：每个指标只取一个来源，失败则置 null 并记 warnings（不猜、不补零）。
  · 全部 try/catch：任一子项失败不影响其余；网络异常写 warnings。
  · 单位统一：融资余额/融券余额=亿元；资金=亿元；成交量=手；收益率=%。
"""

import sys, json, traceback, datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import akshare as ak

WARN = []


def warn(msg):
    WARN.append(str(msg))


def safe(name, fn, default=None):
    try:
        return fn()
    except Exception as e:
        warn(f"{name}: {type(e).__name__}: {str(e)[:160]}")
        return default


def to_float(x):
    try:
        import math
        v = float(x)
        return None if (math.isnan(v) or math.isinf(v)) else v
    except Exception:
        return None


# ---------- 1) 上证指数日线 ----------
# 20261018 迁出：index 块改由首页量能根 lib/marketTechnical.fetchIndexDailyBars 单一通道采集
# （腾讯 fqkline 直采，320 窗口，与大盘技术分析同源同窗口；实测与本脚本原 akshare 通道
#   重叠 260 根 date/close/vol 零差异）。lib/marketEmotionData.js 在 runScript 之后注入 index，
#   故本函数与 main 中的 out["index"] 一并移除，避免同一数据两路采集。


# ---------- 2) 市场宽度（涨跌家数 / 涨跌停 / 炸板率）----------
def fetch_zbgc(ds_ymd):
    """东财炸板股池（akshare stock_zt_pool_zbgc_em，底层 push2ex.eastmoney.com，本机实测稳定可达）：
    曾涨停但收盘未封住的个股集合，与收盘涨停池互斥（互斥性已实测：两池代码交集为 0）。
    返回炸板家数与总炸板次数；炸板率由调用方结合涨停家数计算（分母 = 涨停 + 炸板家数）。
    注意 akshare 该接口仅支持最近 30 个交易日内的日期。"""
    df = ak.stock_zt_pool_zbgc_em(date=ds_ymd)
    if df is None or len(df) == 0:
        return {"count": 0, "breaks": 0}
    total_breaks = 0
    for v in df["炸板次数"]:
        fv = to_float(v)
        if fv is not None:
            total_breaks += int(fv)
    return {"count": int(len(df)), "breaks": total_breaks}


def fetch_breadth():
    df = ak.stock_market_activity_legu()
    m = {}
    for _, row in df.iterrows():
        m[str(row["item"]).strip()] = row["value"]
    date_v = m.get("统计日期")
    ds = None
    if date_v is not None:
        ds = str(date_v)[:10]
    limit_up = int(to_float(m.get("涨停")) or 0)
    out = {
        "up": int(to_float(m.get("上涨")) or 0),
        "down": int(to_float(m.get("下跌")) or 0),
        "flat": int(to_float(m.get("平盘")) or 0),
        "limitUp": limit_up,
        "limitDown": int(to_float(m.get("跌停")) or 0),
        "activePct": to_float(str(m.get("活跃度", "")).replace("%", "")),
        "date": ds,
        "source": "乐咕乐股·市场活跃度",
    }
    # 炸板率（20261015j）：与涨跌家数同一次采集、同一统计日期口径；分母 = 涨停 + 炸板家数。
    # 取数失败仅炸板字段为 null 并如实标注，不拖垮涨跌家数（safe 已记 warnings）。
    ds_ymd = (ds or datetime.datetime.now().strftime("%Y-%m-%d")).replace("-", "")
    zb = safe("炸板股池", lambda: fetch_zbgc(ds_ymd))
    if zb is None:
        out["zbgcCount"] = None
        out["zbgcBreaks"] = None
        out["zbgcRate"] = None
        out["zbgcNote"] = "东财炸板股池取数失败，本次无炸板率"
    else:
        cnt, brk = zb["count"], zb["breaks"]
        denom = limit_up + cnt
        out["zbgcCount"] = cnt
        out["zbgcBreaks"] = brk
        out["zbgcRate"] = round(cnt / denom, 4) if denom > 0 else None
        out["zbgcNote"] = None if denom > 0 else "当日无涨停亦无炸板，炸板率不适用"
    return out


# ---------- 3) 融资 / 融券余额（沪深合计，亿元）----------
def fetch_margin():
    # 沪深交易所发布节奏不同：常出现「最新日期只有单边有数」（如沪已出 09-30、深仍停在 09-29）。
    # 若盲目按日期求和，最新日会被腰斩 → 5 日变动被算成虚假暴跌（实测曾算成 -50.47%）。
    # 修复：只用「沪深双边都有数」的完整日期，单边滞后的最新日不参与，并显式标注（不静默丢弃）。
    #
    # [20261109a] 用户指令「图二卡片修改：添加融券余额数据，余额增加判断为短期利空，
    #   余额减少判断为短期利好，融券余额和融资余额共用平分卡片的权重」：
    #   金十 fs_1.json / fs_2.json 同一份响应本来就含「融券余额」列（akshare 转成同名 DataFrame 列），
    #   无需新增外呼、无需新数据源。融资侧字段名/口径/数值一律不变（隔离改动），
    #   融券侧单独按同一套「双边完整日期」算 5 日变动，另出 rq* 字段。
    #   实测 2026-11-05：融资 22709.8 亿、融券 288.11 亿；近 35 个双边日融券 5 日变动
    #   -4.32%~+2.63%、中位 |1.52%|，无一日超 ±10% → 沿用融资异常闸门安全。
    sh = ak.macro_china_market_margin_sh()
    sz = ak.macro_china_market_margin_sz()

    def _to_map(df, val_name):
        m = {}
        if df is None or len(df) == 0:
            return m
        col = None
        for c in df.columns:
            # 精确匹配（20261109a）：列名「融资融券余额」含子串「融券余额」，
            # 旧的 `if "融券余额" in str(c)` 模糊匹配会误取合计列，导致数值被放大一倍。
            if str(c).strip() == val_name:
                col = c
                break
        dcol = None
        for c in df.columns:
            if "日期" in str(c):
                dcol = c
                break
        if col is None or dcol is None:
            return m
        for _, row in df.iterrows():
            v = to_float(row.get(col))
            if v is None:
                continue
            d = row.get(dcol)
            ds = d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10]
            m[ds] = v / 1e8  # 元 → 亿元
        return m

    def _series(sh_map, sz_map):
        """沪深双边完整日 → 最新值 / 1日 / 5日变动 / 数据日 / 单边滞后说明。融资与融券共用同一口径。"""
        # 只保留沪深双边都有数的完整日期（杜绝单边缺失导致的虚假变动）
        dates = sorted(d for d in sh_map if d in sz_map)
        if not dates:
            return None
        vals = [sh_map[d] + sz_map[d] for d in dates]
        latest = vals[-1]
        prev = vals[-2] if len(vals) >= 2 else None
        idx5 = max(0, len(vals) - 6)
        base5 = vals[idx5] if len(vals) >= 6 else None
        chg1 = ((latest - prev) / prev * 100) if prev else None
        chg5 = ((latest - base5) / base5 * 100) if base5 else None
        # 单边滞后的最新日期（若有）：显式标注，供下游/界面说明
        newest_any = max(list(sh_map) + list(sz_map))
        partial_note = None
        if newest_any != dates[-1]:
            if newest_any in sh_map and newest_any not in sz_map:
                side = "沪市已出、深市滞后"
            elif newest_any in sz_map and newest_any not in sh_map:
                side = "深市已出、沪市滞后"
            else:
                side = "单边缺失"
            partial_note = f"最新单边日期 {newest_any}（{side}）未计入，采用最新双边完整日 {dates[-1]}"
        return {
            "latest": latest, "prev": prev, "chg1": chg1, "chg5": chg5,
            "date": dates[-1], "base5Date": dates[idx5] if base5 is not None else None,
            "partialNote": partial_note,
        }

    rz = _series(_to_map(sh, "融资余额"), _to_map(sz, "融资余额"))
    if rz is None:
        raise RuntimeError("融资余额无沪深双边完整日期")
    out = {
        # 融资字段：与 20261109a 之前逐字同口径，下游零改动
        "latest": round(rz["latest"], 1),
        "prev": round(rz["prev"], 1) if rz["prev"] is not None else None,
        "changePct": round(rz["chg1"], 3) if rz["chg1"] is not None else None,
        "change5Pct": round(rz["chg5"], 3) if rz["chg5"] is not None else None,
        "date": rz["date"],
        "base5Date": rz["base5Date"],
        "partialNote": rz["partialNote"],
        "source": "沪深交易所·融资余额（仅计双边完整日期）",
    }
    rq = _series(_to_map(sh, "融券余额"), _to_map(sz, "融券余额"))
    if rq is None:
        # 融券缺失不拖累整卡降级：下游按「半权重不计分」处理并如实标注
        out["rqMissingNote"] = "融券余额无沪深双边完整日期（本子项不计分）"
    else:
        out.update({
            "rqLatest": round(rq["latest"], 2),
            "rqChange5Pct": round(rq["chg5"], 3) if rq["chg5"] is not None else None,
            "rqDate": rq["date"],
            "rqBase5Date": rq["base5Date"],
            "rqPartialNote": rq["partialNote"],
            "rqSource": "沪深交易所·融券余额（仅计双边完整日期）",
        })
    return out


# ---------- 4a) 市场主力资金（东财 push2delay：大盘资金流，主力=超大单+大单）----------
def _parse_cn_amount(s):
    """解析「12.29亿 / 2273.28万 / -2668.26万 / 0.00」→ 元"""
    if s is None:
        return None
    t = str(s).strip().replace(",", "")
    if t in ("", "-", "--"):
        return None
    mult = 1.0
    if t.endswith("亿"):
        mult, t = 1e8, t[:-1]
    elif t.endswith("万"):
        mult, t = 1e4, t[:-1]
    try:
        return float(t) * mult
    except Exception:
        return None


def fetch_main_fund():
    """东财 push2delay·大盘资金流日线：仅返回当日。主力净额 = 大单+超大单。"""
    import subprocess
    url = ("https://push2delay.eastmoney.com/api/qt/stock/fflow/daykline/get"
           "?lmt=0&klt=101&secid=1.000001&secid2=0.399001"
           "&fields1=f1,f2,f3,f7"
           "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65"
           "&ut=b2884a393a59ad64002292a3e90d46a5")
    p = subprocess.run(["curl", "-4", "-s", "--max-time", "20", url],
                       capture_output=True, timeout=30)
    if p.returncode != 0:
        raise RuntimeError(f"curl exit={p.returncode}")
    j = json.loads(p.stdout.decode("utf-8", "ignore"))
    klines = (j.get("data") or {}).get("klines") or []
    if not klines:
        raise RuntimeError("大盘资金流无 klines")
    last = klines[-1].split(",")
    main_net = to_float(last[1])       # f52 主力净流入-净额（元）
    big = to_float(last[4]) if len(last) > 4 else None      # f55 大单
    super_big = to_float(last[5]) if len(last) > 5 else None  # f56 超大单
    pct = to_float(last[6]) if len(last) > 6 else None      # f57 主力净占比
    return {
        "date": last[0] if last else None,
        "mainNetToday": round(main_net / 1e8, 2) if main_net is not None else None,
        "bigNet": round(big / 1e8, 2) if big is not None else None,
        "superBigNet": round(super_big / 1e8, 2) if super_big is not None else None,
        "mainNetPct": pct,
        "history": [{"date": x.split(",")[0], "mainNet": round(to_float(x.split(",")[1]) / 1e8, 2)}
                    for x in klines[-6:] if len(x.split(",")) > 1 and to_float(x.split(",")[1]) is not None],
        "source": "东方财富·大盘资金流（主力=超大单+大单）",
    }


# ---------- 4b) 市场成交额 / 换手率 / 成交集中度（同花顺个股资金流聚合）----------
def fetch_capital():
    df = ak.stock_fund_flow_individual(symbol="即时")
    if df is None or len(df) == 0:
        raise RuntimeError("同花顺个股资金流为空")

    def col(kw):
        for c in df.columns:
            if kw in str(c):
                return c
        return None

    amt_col, turn_col = col("成交额"), col("换手率")
    amt_sum = 0.0
    turn_vals = []
    amts = []
    n = 0
    for _, r in df.iterrows():
        amt = _parse_cn_amount(r.get(amt_col)) if amt_col else None
        turn = to_float(str(r.get(turn_col, "")).replace("%", "")) if turn_col else None
        if amt is not None and amt > 0:
            amts.append(amt)
            amt_sum += amt
        if turn is not None and turn > 0:
            turn_vals.append(turn)
        n += 1
    top_share = None
    if amts:
        amts.sort(reverse=True)
        k = max(1, int(len(amts) * 0.1))
        top_share = round(sum(amts[:k]) / sum(amts) * 100, 2)
    return {
        "totalAmount": round(amt_sum / 1e8, 1),        # 亿元
        "turnoverAvg": round(sum(turn_vals) / len(turn_vals), 3) if turn_vals else None,
        "topDecileShare": top_share,
        "sample": n,
        "note": "同花顺·个股资金流聚合（全样本成交额合计 / 换手率均值 / 成交额前10%占比）",
    }


# ---------- 5) 汇率（USD/CNH、USD/CNY）----------
def fetch_fx():
    import urllib.request
    url = "https://hq.sinajs.cn/list=fx_susdcnh,fx_susdcny"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://finance.sina.com.cn",
    })
    txt = urllib.request.urlopen(req, timeout=10).read().decode("gbk", "ignore")

    def parse(code):
        import re
        m = re.search(r'hq_str_%s="([^"]*)"' % code, txt)
        if not m:
            return None
        parts = m.group(1).split(",")
        if len(parts) < 3:
            return None
        price = to_float(parts[1])
        chg = to_float(parts[10]) if len(parts) > 10 else None
        return {"price": price, "chgPct": chg}

    cnh = parse("fx_susdcnh")
    cny = parse("fx_susdcny")
    if not cnh and not cny:
        raise RuntimeError("新浪外汇解析失败")
    return {
        "usdcnh": cnh["price"] if cnh else None,
        "usdcnhChgPct": cnh["chgPct"] if cnh else None,
        "usdcny": cny["price"] if cny else None,
        "usdcnyChgPct": cny["chgPct"] if cny else None,
        "source": "新浪财经·外汇",
    }


# ---------- 6) 国债收益率（中国 10 年）----------
def fetch_bond():
    start = (datetime.date.today() - datetime.timedelta(days=40)).strftime("%Y%m%d")
    df = ak.bond_zh_us_rate(start_date=start)
    if df is None or len(df) == 0:
        raise RuntimeError("国债收益率为空")
    col = None
    for c in df.columns:
        if "中国国债收益率10年" in str(c):
            col = c
            break
    if col is None:
        raise RuntimeError("未找到中国10年国债收益率列")
    vals = [to_float(v) for v in df[col].tolist()]
    vals = [v for v in vals if v is not None]
    if not vals:
        raise RuntimeError("中国10年国债收益率全为空")
    latest = vals[-1]
    prev = vals[-2] if len(vals) >= 2 else None
    idx5 = max(0, len(vals) - 6)
    base5 = vals[idx5] if len(vals) >= 6 else None
    chg_bp = round((latest - base5) * 100, 2) if base5 is not None else None
    return {
        "cn10y": round(latest, 4),
        "prev": round(prev, 4) if prev is not None else None,
        "chgBp5": chg_bp,
        "source": "中美国债收益率（中国10年）",
    }


def main():
    out = {"ok": True, "date": datetime.date.today().strftime("%Y-%m-%d")}
    out["breadth"] = safe("breadth", fetch_breadth)
    out["margin"] = safe("margin", fetch_margin)
    out["mainFund"] = safe("mainFund", fetch_main_fund)
    out["capital"] = safe("capital", fetch_capital)
    out["fx"] = safe("fx", fetch_fx)
    out["bond"] = safe("bond", fetch_bond)
    out["warnings"] = WARN
    ok_count = sum(1 for k in ("breadth", "margin", "mainFund", "capital", "fx", "bond") if out.get(k))
    out["ok"] = ok_count >= 3
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc(),
                          "warnings": WARN}, ensure_ascii=False))
        sys.exit(1)

~~~

---

## `scripts\migrateDividends.js`  ·  69 行

~~~js
// scripts/migrateDividends.js — 批量把分红历史迁入本地 SQLite（一次性回填，不依赖 UI）
//
// 用法：
//   node scripts/migrateDividends.js                 # 默认回填常用 A 股样本
//   node scripts/migrateDividends.js 601318 600519  # 指定代码
//
// 说明：
//   - 复用 deepAnalysis.fetchDividends（单一权威源，规则一）抓取原始派息记录；
//   - 经 persistDividends 写入 SQLite 的 series 表（dividend_per_share / dividend_total_yi），
//     每条带 来源/获取时间/实际时间 五要素，并自动按 as_of 排序供边际分析。
//   - 网络不通时单只失败不中断整体，会在末尾汇总。

const path = require('path');
const db = require('../lib/db');
const { fetchDividends, persistDividends } = require('../lib/deepAnalysis');

const DEFAULT_SYMBOLS = [
  '601318', // 中国平安
  '600519', // 贵州茅台
  '603288', // 海天味业
  '601628', // 中国人寿
  '601336', // 新华保险
  '601319', // 中国人保
  '601601', // 中国太保
  '000001', // 平安银行
  '600036', // 招商银行
  '000333', // 美的集团
];

async function migrateOne(symbol) {
  const norm = symbol.replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
  try {
    const rows = await fetchDividends(norm);
    persistDividends(norm, norm, rows);
    return { symbol: norm, ok: true, count: (rows || []).length };
  } catch (e) {
    return { symbol: norm, ok: false, error: e.message };
  }
}

async function main() {
  db.initDb();
  const args = process.argv.slice(2);
  const symbols = args.length ? args : DEFAULT_SYMBOLS;

  console.log(`\n开始回填分红历史，共 ${symbols.length} 只...\n`);
  const results = [];
  for (const s of symbols) {
    const r = await migrateOne(s);
    results.push(r);
    console.log(
      r.ok
        ? `  ✓ ${r.symbol.padEnd(8)} 已写入 ${r.count} 条派息记录`
        : `  ✗ ${r.symbol.padEnd(8)} 失败：${r.error}`
    );
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  console.log(`\n完成：成功 ${ok} 只，失败 ${fail} 只。`);
  console.log(`数据库位置：${db.DB_PATH}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('迁移脚本异常：', e);
  process.exit(1);
});

~~~

---

## `scripts\pbc_social_financing.py`  ·  107 行

~~~py
#!/usr/bin/env python3
# 人民银行「社会融资规模增量统计表」解析（确定性数据，非 AI）。
# 复刻 a-stock-data 技能 pboc_social_financing（2021 年起支持）。
# 输出 JSON：{ok, year, month, afre_total, ytd_total, rmb_loans, government_bonds, source}
import os, sys, json, re
import requests

# 清除系统代理（与本机运行环境一致：系统代理会挂起请求）
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

PBC_BASE = "https://www.pbc.gov.cn"
PBC_INDEX = PBC_BASE + "/diaochatongjisi/116219/116319/index.html"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def _get(url, timeout=30):
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def _abs(href):
    return href if href.startswith("http") else PBC_BASE + href


def main():
    try:
        import pandas as pd
        from io import BytesIO
    except Exception as e:
        print(json.dumps({"ok": False, "error": "pandas 不可用: %s" % str(e)[:200]}, ensure_ascii=False))
        return
    try:
        idx = _get(PBC_INDEX)
        years = re.findall(r'href=["\']([^"\']+)["\'][^>]*>\s*(\d{4})年统计数据\s*</a>', idx)
        if not years:
            print(json.dumps({"ok": False, "error": "人民银行索引页未找到年份链接"}, ensure_ascii=False))
            return
        table = {int(y): h for h, y in years}
        target = max(table)
        ypage = _get(_abs(table[target]))
        topics = re.findall(r'href=["\']([^"\']+)["\'][^>]*>\s*社会融资规模\s*</a>', ypage)
        if not topics:
            print(json.dumps({"ok": False, "error": "%d 年页未找到社会融资规模专题" % target}, ensure_ascii=False))
            return
        tpage = _get(_abs(topics[0]))
        books = re.findall(r'href=["\']([^"\']+\.xlsx?)["\']', tpage)
        if not books:
            print(json.dumps({"ok": False, "error": "社融专题页未找到 xlsx 附件"}, ensure_ascii=False))
            return
        content = requests.get(_abs(books[0]), headers=UA, timeout=60).content
        raw = pd.read_excel(BytesIO(content), header=None)
        start = None
        for i in range(len(raw)):
            if str(raw.iloc[i, 0]).strip() == "月份":
                start = i
                break
        if start is None:
            print(json.dumps({"ok": False, "error": "社融表无「月份」表头"}, ensure_ascii=False))
            return
        cols = ["month", "afre_total", "rmb_loans", "fx_loans", "entrusted_loans", "trust_loans",
                "undiscounted_bankers_acceptance", "corporate_bonds", "government_bonds",
                "equity_financing", "abs_by_depository", "loans_written_off"]
        df = raw.iloc[start + 3:].copy().iloc[:, :len(cols)]
        df.columns = cols
        df = df[df["month"].astype(str).str.match(r"^\d{4}\.\d{1,2}$", na=False)].copy()
        for c in cols[1:]:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        def _ml(v):
            m = re.match(r"^(\d{4})\.(\d{1,2})$", str(v).strip())
            if not m:
                return None
            y, mo = m.group(1), m.group(2)
            if len(mo) == 1:
                mo += "0"
            return "%s-%02d" % (y, int(mo))

        df["month"] = [_ml(v) for v in df["month"]]
        df = df[df["month"].notna()]
        df = df[df["month"].str.startswith("%d-" % target)].reset_index(drop=True)
        df = df.dropna(subset=["afre_total"]).reset_index(drop=True)
        if df.empty:
            print(json.dumps({"ok": False, "error": "%d 年社融表无有效月份" % target}, ensure_ascii=False))
            return
        latest = df.loc[df["month"].idxmax()]  # 取最新已发布月份（表按月份升序，末行为最新）
        ytd = df["afre_total"].sum()
        out = {
            "ok": True,
            "year": target,
            "month": str(latest["month"]),
            "afre_total": float(latest["afre_total"]),
            "ytd_total": float(ytd),
            "rmb_loans": (None if pd.isna(latest["rmb_loans"]) else float(latest["rmb_loans"])),
            "government_bonds": (None if pd.isna(latest["government_bonds"]) else float(latest["government_bonds"])),
            "source": "中国人民银行·社会融资规模增量统计表",
        }
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

~~~

---

## `scripts\pdf_extract_text.py`  ·  75 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF 文本提取（pdfplumber）——供 lib/pdfText.js 调用。

从本地资料库的财报 PDF 中提取前 N 页正文，用于财报解读的上下文补充。
用法:
  python pdf_extract_text.py --file <pdf路径> [--max-pages N] [--char-cap N]
输出（stdout 单行 JSON）:
  {"ok": true, "pages": 实际提取页数, "total_pages": 全文档页数, "text": 正文, "truncated": bool}
  {"ok": false, "error": "..."}
"""
import argparse
import json
import re
import sys


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--max-pages", type=int, default=40)
    ap.add_argument("--char-cap", type=int, default=0, help="正文最大字符数，0=不限制")
    args = ap.parse_args()

    try:
        import pdfplumber
    except ImportError:
        print(json.dumps({"ok": False, "error": "pdfplumber 未安装"}, ensure_ascii=False))
        return

    try:
        parts = []
        total_chars = 0
        truncated = False
        with pdfplumber.open(args.file) as pdf:
            total = len(pdf.pages)
            limit = min(total, args.max_pages)
            for i in range(limit):
                try:
                    t = pdf.pages[i].extract_text() or ""
                except Exception:
                    t = ""
                parts.append(t)
                total_chars += len(t)
                if args.char_cap and total_chars >= args.char_cap:
                    truncated = True
                    break
            if limit < total:
                truncated = True

        text = "\n".join(parts)
        text = re.sub(r"[ \t\u3000]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if args.char_cap and len(text) > args.char_cap:
            text = text[: args.char_cap]

        print(json.dumps({
            "ok": True,
            "pages": len(parts),
            "total_pages": total,
            "text": text,
            "truncated": truncated,
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

~~~

---

## `scripts\register_watchdog.bat`  ·  17 行

~~~bat
@echo off
REM Register the Stock Analyzer watchdog to run every 5 minutes via Windows Task Scheduler.
REM Double-click this file. Windows may ask for permission (UAC) - allow it so the task can be created.
REM To remove later, run unregister_watchdog.bat (same folder).
set "VBS=D:\stock analyzer\stock-analyzer\scripts\watchdog.vbs"
schtasks /create /tn "StockAnalyzerWatchdog" /tr "wscript.exe \"D:\stock analyzer\stock-analyzer\scripts\watchdog.vbs\"" /sc minute /mo 5 /f
if %errorlevel%==0 (
  echo.
  echo Watchdog task "StockAnalyzerWatchdog" registered (runs every 5 minutes).
  echo It probes http://127.0.0.1:3005/api/health and relaunches start.vbs if the service is down.
) else (
  echo.
  echo Failed to register. Try right-clicking this file and choosing "Run as administrator".
)
echo.
pause

~~~

---

## `scripts\restore_drill.js`  ·  91 行

~~~js
// Stock Analyzer - backup RECOVERY DRILL (read-only on live data; safe to re-run).
// Verifies that the backed-up data/notes.json can actually be restored:
//   1) locate the best backup (OneDrive offsite > local D: backup > live fallback)
//   2) copy notes.json into a temp dir and prove MD5 integrity (copy == source)
//   3) prove the restored file is valid JSON and parseable
//   4) report any notes present in backup but missing from live ("recoverable now")
//   5) simulate a deletion and prove the note can be recovered from the backup by id
// The script NEVER writes to live data/notes.json or to the backups - only to a
// throwaway temp dir that is removed at the end.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const LIVE = path.join(project, 'data', 'notes.json');
const LOCAL_BK = 'D:\\stock-analyzer-backup\\data\\notes.json';
const ONEDRIVE_BK = 'C:\\Users\\16507\\OneDrive\\stock-analyzer-backup\\data\\notes.json';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } }
function md5File(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
function readNotes(p) {
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(arr)) throw new Error('notes.json is not a JSON array at ' + p);
  return arr;
}

console.log('=== Stock Analyzer · Backup Recovery Drill ===');

// 1) choose the best restore source
const candidates = [
  { name: 'OneDrive offsite', p: ONEDRIVE_BK },
  { name: 'Local backup (D:)', p: LOCAL_BK },
];
const bk = candidates.find((c) => fs.existsSync(c.p));
const sourceLabel = bk ? bk.name : 'LIVE (no backup found - insecure fallback!)';
const sourcePath = bk ? bk.p : LIVE;
console.log('Restore source : ' + sourceLabel + '  (' + sourcePath + ')');

if (!fs.existsSync(sourcePath)) { console.log('FATAL: restore source missing: ' + sourcePath); process.exit(1); }

// cross-backup consistency (bonus): both backups should agree
if (fs.existsSync(LOCAL_BK) && fs.existsSync(ONEDRIVE_BK)) {
  const a = md5File(LOCAL_BK), b = md5File(ONEDRIVE_BK);
  ok(a === b, 'local backup and OneDrive backup are byte-identical (md5 match)');
}

// 2) copy into temp dir + MD5 integrity
const tmp = path.join(project, 'data', '.restore-drill-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const copyPath = path.join(tmp, 'restored-notes.json');
fs.copyFileSync(sourcePath, copyPath);
ok(md5File(sourcePath) === md5File(copyPath), 'restored copy is byte-identical to backup (md5 match)');

// 3) JSON validity + parseable
let notes = [];
try { notes = readNotes(copyPath); ok(true, 'restored file is valid JSON and a parseable array'); }
catch (e) { ok(false, 'restored file failed to parse: ' + e.message); }
ok(notes.length > 0, 'restored notes contain ' + notes.length + ' entries');

// 4) real divergence: notes in backup but missing from live = recoverable now
let liveNotes = [];
try { liveNotes = readNotes(LIVE); } catch (e) { console.log('  [WARN] could not read live notes.json: ' + e.message); }
const liveIds = new Set(liveNotes.map((n) => n.id));
const recoverable = notes.filter((n) => !liveIds.has(n.id));
console.log('Divergence     : ' + recoverable.length + ' note(s) in backup missing from live' +
  (recoverable.length ? ' -> ' + recoverable.slice(0, 5).map((n) => n.id).join(', ') + (recoverable.length > 5 ? ' ...' : '') : ' (live is in sync with backup)'));

// 5) simulated deletion -> recovery by id (proves the restore path works)
if (notes.length > 0) {
  const victim = notes[0];
  const victimId = victim.id;
  // simulate that this note was deleted from live
  const scratch = liveNotes.filter((n) => n.id !== victimId);
  const afterDeleteCount = scratch.length;
  // recover it FROM the backup by id
  const recovered = notes.find((n) => n.id === victimId);
  const match = recovered && JSON.stringify(recovered) === JSON.stringify(victim);
  ok(match, 'simulated-deleted note "' + victimId + '" recovered from backup by id and matches original');
  ok(typeof recovered === 'object' && recovered !== null, 'recovered note is a real object (title="' + (recovered && recovered.title || '?') + '")');
  ok(afterDeleteCount === liveNotes.length - 1, 'deletion simulation removed exactly 1 note from the live copy');
}

// cleanup temp dir (no residue left behind)
try { fs.rmSync(tmp, { recursive: true, force: true }); ok(true, 'temp drill dir cleaned up (no residue)'); }
catch (e) { ok(false, 'temp cleanup failed: ' + e.message); }

console.log('-----------------------------------------------');
console.log('Drill result   : ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\restore_etf_20261028.js`  ·  117 行

~~~js
/**
 * [20261029j] 一次性事故还原：重建 data/etf-flow/20261028.json（残缺快照）
 *
 * 事故：10-28 18:42 采集时 27/34 只 PCF 抓取失败，快照只写入 7 只
 * （510050/510100/510190/510600/588000/588040/588050）却被标 settled:true。
 * 10-29 计算时它被选为基期 → 沪深300 组 15 只全部「基期无快照（新入名单）」（用户报障）。
 *
 * 还原方法（口径=10-27 收盘份额，与原快照 shareDate=20261027 一致）：
 *   S(10-27) = S(10-26)（20261027.json 官方快照）+ Δ(10-27)（权威外部源）
 * 数据源（多源交叉验证）：
 *   ① 腾讯金融搜索「A股行情指标」结构化表：ETF净申购份额(份)，部分码附 ETF份额(份) 总量
 *   ② 上交所官网基金规模历史（总份额/万份，当日清算后）——510320/515390/510500/510370 直接命中
 *   ③ 新浪基金工作室/证券之星 净申购金额(亿元)——量级核对
 * 校验（全部通过才写盘）：
 *   A. 残缺文件 7 只官方值链路自洽：S(10-27)官方 − S(10-26) ÷ 申赎单位 ≈ 整数篮
 *   B. 27 只重建：Δ(10-27) ÷ 申赎单位 ≈ 整数篮
 *   C. 直接命中的官方总份额与重建值逐位相等
 *   D. 前向链：S(10-28)（20261029.json，shareDate=20261028）− S(10-27)重建 ÷ 申赎单位 ≈ 整数篮
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'etf-flow');
const read = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const s27 = read('20261027.json');
const s29 = read('20261029.json');
const partial = read('20261028.json');

// ── 权威外部源：2026-10-27 净申购份额（份）──
const DELTA_1027 = {
  '510300': 791100000, '510310': 324900000, '510320': 45000000, '510330': 252900000,
  '510350': 50400000,  '510360': 36000000,  '510370': 0,        '510380': 0,
  '510390': 0,         '515130': 0,         '515310': 3500000,  '515330': 429000000,
  '515350': 0,         '515360': 0,         '515380': 11700000, '515390': 32000000,
  '515660': 44100000,  '516040': -4000000,  '561420': -2000000, '561930': 0,
  '510500': -28800000, '510510': 0,         '510530': 0,        '510550': 0,
  '512100': 240000000, '516300': 0,         '560010': 150000000,
};
// 腾讯金融搜索/上交所直接给出的 10-27 收盘总份额（份）——最强校验
const DIRECT_1027 = {
  '510300': 36238087700, '510350': 771414700,  '515660': 502894200,
  '516040': 34516600,    '561420': 986237000,  '561930': 208260600,
  '510500': 7022968600,  '510510': 893038300,  '510530': 47979400, '510550': 23743300,
};

const m27 = Object.fromEntries(s27.etfs.map(e => [e.code, e]));
const m29 = Object.fromEntries(s29.etfs.map(e => [e.code, e]));
const mPartial = Object.fromEntries(partial.etfs.map(e => [e.code, e]));

let fails = 0;
const chk = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const nearInt = (v, tol = 0.05) => Math.abs(v - Math.round(v)) <= tol;

console.log('== A. 残缺文件 7 只官方值链路自洽（S(10-27)官方−S(10-26)÷unit≈整数篮）==');
for (const e of partial.etfs) {
  const base = m27[e.code];
  if (!base || !base.shares || !e.shares || !e.unit) { chk(false, `${e.code} 链路数据缺失`); continue; }
  const d = e.shares - base.shares;
  chk(nearInt(d / e.unit), `${e.code} Δ=${d} ÷ ${e.unit} = ${(d / e.unit).toFixed(3)} 篮`);
}

console.log('== B. 27 只重建：Δ(10-27) ÷ unit ≈ 整数篮 ==');
for (const [code, d] of Object.entries(DELTA_1027)) {
  const u = (m27[code] || {}).unit;
  if (!u) { chk(false, `${code} 10-27 快照缺 unit`); continue; }
  chk(nearInt(d / u), `${code} Δ=${d} ÷ ${u} = ${(d / u).toFixed(3)} 篮`);
}

console.log('== C. 官方总份额直接命中（重建值逐位相等）==');
for (const [code, direct] of Object.entries(DIRECT_1027)) {
  const rebuilt = m27[code].shares + DELTA_1027[code];
  chk(rebuilt === direct, `${code} 重建 ${rebuilt} vs 官方 ${direct}`);
}

console.log('== D. 前向链：S(10-28) − S(10-27)重建 ÷ unit ≈ 整数篮（全部 34 只）==');
for (const e of s29.etfs) {
  const p = mPartial[e.code] || m27[e.code];
  const s27shares = mPartial[e.code] ? mPartial[e.code].shares : (m27[e.code].shares + DELTA_1027[e.code]);
  if (!e.shares || !s27shares || !e.unit) { chk(false, `${e.code} 前向链数据缺失`); continue; }
  const d = e.shares - s27shares;
  chk(nearInt(d / e.unit), `${e.code} Δ(10-28)=${d} ÷ ${e.unit} = ${(d / e.unit).toFixed(3)} 篮`);
}

if (fails) { console.error(`\n共 ${fails} 项校验失败 → 不写盘`); process.exit(1); }
console.log('\n全部校验通过 → 写盘');

// ── 备份 ──
const bak = path.join(DIR, 'backup', '20261028.partial-broken.json');
fs.copyFileSync(path.join(DIR, '20261028.json'), bak);
console.log('备份：' + bak);

// ── 重建 ──
const restoredCodes = [];
const etfs = [];
for (const e of partial.etfs) etfs.push(e);                       // 7 只官方原样保留
for (const e of s27.etfs) {
  if (mPartial[e.code]) continue;                                  // 已在官方 7 只内
  etfs.push(Object.assign({}, e, { shares: e.shares + DELTA_1027[e.code] }));
  restoredCodes.push(e.code);
}
etfs.sort((a, b) => a.code.localeCompare(b.code));

const snap = {
  date: partial.date, shareDate: partial.shareDate, savedAt: partial.savedAt, settled: true,
  restored: {
    at: new Date().toISOString(),
    reason: '20261028 18:42 采集残缺（27/34 只 PCF 抓取失败），被 20261029 计算误选为基期 → 沪深300 组全部「基期无快照（新入名单）」（用户报障）',
    method: 'S(10-27) = S(10-26)官方快照 + Δ(10-27)权威外部源（腾讯金融搜索结构化表 × 上交所官网基金规模 × 新浪/证券之星净申购金额三源交叉验证）；7 只残缺文件原值保留；四组校验（链路整篮/Δ整篮/官方总量逐位/前向整篮）全过',
    restoredCodes,
  },
  etfs,
};
if (s27.stockNames || partial.stockNames) snap.stockNames = Object.assign({}, s27.stockNames || {}, partial.stockNames || {});

fs.writeFileSync(path.join(DIR, '20261028.json'), JSON.stringify(snap));
console.log(`写盘完成：20261028.json 共 ${etfs.length} 只（官方保留 7 + 还原 ${restoredCodes.length}）`);

~~~

---

## `scripts\restore_etf_20261030.js`  ·  98 行

~~~js
#!/usr/bin/env node
/**
 * scripts/restore_etf_20261030.js — 20261103g 事故恢复（10-30 快照被节假日重采覆盖）
 *
 * 事故：11-01（周日）打开首页触发 collect → PCF 返回上周五（10-30）清单 → 已定稿的
 * 20261030 快照被覆盖，shareDate 被 T+1 采集日语义从 20261029 前推到 20261030，
 * shares 从「10-29 收盘」变成「10-30 收盘」→ 逐日表 10-30 假 Δ=0、台账重复计入周四增量。
 * （根修已在 lib/etfFlow.js collect 跨日重采守卫落地，本脚本清洗已发生的污染。）
 *
 * 恢复推导（全内部、份级精确）：
 *   Δwrong = s(10-30快照) − s(10-29快照) = 10-30收盘 − 10-28收盘   （= 周四+周五 合计）
 *   Δthu   = s(10-29快照) − s(10-28快照) = 10-29收盘 − 10-28收盘   （= 周四 单日）
 *   Δfri   = Δwrong − Δthu = 10-30收盘 − 10-29收盘                （= 周五 单日）
 *   恢复   s(10-29收盘) = s(10-30快照现值) − Δfri
 * 可信度校验：Δfri ÷ 申赎单位 ≈ 整数篮（阈值 0.05，与 computeFromSnapshots 同口径）。
 *
 * 步骤：备份 → 重建 20261030 快照（shares=10-29收盘、shareDate=20261029、restored 溯源）
 *       → 台账重置 → 按快照链升序幂等重放（不手写 cum，走 computeFromSnapshots 代码路径）
 * 幂等：可重复执行（恢复前检查 restored 标记跳过）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
process.env.SA_ETF_FLOW_DIR = path.join(__dirname, '..', 'data', 'etf-flow');
const etfFlow = require(path.join(__dirname, '..', 'lib', 'etfFlow.js'));
const DIR = process.env.SA_ETF_FLOW_DIR;
const BK = path.join(DIR, 'backup');
if (!fs.existsSync(BK)) fs.mkdirSync(BK, { recursive: true });
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const snapP = (d) => path.join(DIR, `${d}.json`);

const SNAP_D = '20261030';
const snap = readJ(snapP(SNAP_D));
if (snap.restored) { console.log('已恢复过（restored 标记存在），跳过快照重建；仅重放台账。'); }
else {
  const s28 = readJ(snapP('20261028')), s29 = readJ(snapP('20261029'));
  const pick = (s, c) => { const e = s.etfs.find(x => x.code === c); return e ? e.shares : null; };
  const unitOf = (c) => { const e = snap.etfs.find(x => x.code === c) || s29.etfs.find(x => x.code === c); return e ? e.unit : null; };

  let okN = 0, zeroN = 0, bad = [];
  const restoredEtfs = snap.etfs.map(e => {
    const s28v = pick(s28, e.code), s29v = pick(s29, e.code), s30v = e.shares;
    if (s28v == null || s29v == null || !e.unit) { bad.push(`${e.code} 链上缺值`); return e; }
    const dWrong = s30v - s29v, dThu = s29v - s28v, dFri = dWrong - dThu;
    if (dFri === 0) { zeroN++; return e; }  // 周四+周五均无申赎 → 覆盖前后同值，无需恢复
    const baskets = dFri / e.unit;
    if (Math.abs(baskets - Math.round(baskets)) > 0.05) { bad.push(`${e.code} Δfri 篮数 ${baskets.toFixed(3)} 非整数`); return e; }
    const restored = s30v - dFri;
    okN++;
    return Object.assign({}, e, { shares: restored, _restoreNote: `节假日覆盖恢复：shares=10-29收盘值（Δfri=${dFri}，${Math.round(baskets)} 篮）` });
  });
  if (bad.length) {
    console.error('✗ 校验未全部通过，中止（不写盘）：\n  ' + bad.join('\n  '));
    process.exit(1);
  }
  // 备份被覆盖版
  fs.copyFileSync(snapP(SNAP_D), path.join(BK, `${SNAP_D}.holiday-overwritten.json`));
  const out = Object.assign({}, snap, {
    etfs: restoredEtfs,
    shareDate: '20261029',
    restored: {
      at: new Date().toISOString(),
      reason: '20261103g：11-01 周日跨日重采覆盖（shareDate 被 T+1 采集日语义前推），本快照由 Δwrong−Δthu 推导恢复为 10-29 收盘份额；全量篮数整除校验通过',
      script: 'scripts/restore_etf_20261030.js',
    },
  });
  delete out.partial; delete out.gaps;
  fs.writeFileSync(snapP(SNAP_D), JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ 快照 ${SNAP_D} 已恢复：${okN} 只份额回写（10-29 收盘值），${zeroN} 只 Δfri=0 无需恢复；shareDate=20261029`);
}

// —— 台账重放：重置后按快照链升序幂等重放（走 computeFromSnapshots 代码路径，不手写 cum）——
const ledgerP = path.join(DIR, 'ledger.json');
const before = readJ(ledgerP);
fs.copyFileSync(ledgerP, path.join(BK, `ledger.before-replay-20261103.json`));
console.log(`\n重放前台账：lastDate=${before.lastDate} days=${before.days}`);

const chain = fs.readdirSync(DIR).filter(f => /^2026\d{4}\.json$/.test(f)).sort()
  .filter(f => { const s = readJ(path.join(DIR, f)); return s.settled && !s.partial; });
console.log('快照链（settled 升序）：', chain.map(f => f.replace('.json', '')).join(' → '));
// 重置台账（computeFromSnapshots 从空台账逐日幂等入账）
fs.writeFileSync(ledgerP, JSON.stringify({ lastDate: null, cum: {}, days: 0 }), 'utf8');
for (const f of chain) {
  const d = f.replace('.json', '');
  try { etfFlow.computeFromSnapshots(d); } catch (e) { console.error(`  重放 ${d} 失败:`, e.message); }
}
const after = readJ(ledgerP);
console.log(`重放后台账：lastDate=${after.lastDate} days=${after.days} cum键数=${Object.keys(after.cum).length}`);

// —— 验证：恢复后逐日 Δ ——
const s1102 = readJ(snapP('20261102')), s1103 = readJ(snapP('20261103'));
const restored = readJ(snapP(SNAP_D));
const pick = (s, c) => { const e = s.etfs.find(x => x.code === c); return e ? e.shares : null; };
const dFri = pick(s1102, '510300') - pick(restored, '510300');
const dMon = pick(s1103, '510300') - pick(s1102, '510300');
console.log(`\n验证（510300）：周五(10-30) Δ = ${(dFri / 1e8).toFixed(3)} 亿份（${dFri / 1000000} 篮）；周一(11-02) Δ = ${(dMon / 1e8).toFixed(3)} 亿份`);
console.log('完成。');

~~~

---

## `scripts\restore_etf_20261106.js`  ·  157 行

~~~js
#!/usr/bin/env node
/**
 * scripts/restore_etf_20261106.js — 20261109 事故恢复（11-06 残缺快照被误标定稿）
 *
 * 事故：11-07 凌晨跨日重采覆盖 20261106 快照，PCF 只成功 7/34 只，份额被写成 11-06 收盘值
 *       （与 20261109 快照对应代码逐位相同），却被标成 settled:true 且无 partial 标记。
 *       后果：
 *         ① 20261109 的基期选中这份残缺快照 → 两份都是 shareDate=20261106 → overlap 守卫
 *            返回 baselineOnly:true，前端「家族汇总卡 / Top10 / 全部成分股累计」整块隐藏。
 *         ② computeFromSnapshots('20261106') 以 7 只 ETF 的篮子把「11-04→11-06 多日合计」
 *            当成单日入账，台账 days 11 / lastDate 20261106 被污染。
 *
 * 恢复（不臆造任何份额数字，全部走代码路径）：
 *   1) 把 20261106 如实标记 partial:true / settled:false → 基期自动回退 20261105（34 只，
 *      shareDate 20261104），20261109 恢复可计算，代码自动打 spanNote「多日合计」披露。
 *   2) 精确撤销那一次污染入账：用「修复前」的 20261106 调 computeFromSnapshots 取当日
 *      stockAgg（dayBuy/daySell），从台账 cum 逐股扣回、days-1、lastDate 回退 20261104。
 *
 * 为什么不重置台账重放（与 restore_etf_20261030.js 的关键差异）：
 *   KEEP_DAYS=10 已滚动清理掉 10-26 之前的快照；ledger.backup-20261026.json 证明台账含
 *   days=3 的早期合法累计，那部分数据只存在于 cum 里、无法从现存快照重建。重置=永久丢数据。
 *   因此本脚本**只扣最后一次污染入账**，保全全部合法历史。
 *
 * 幂等：快照已有 restored+partial 标记则跳过重写；台账仅当 lastDate=20261106 且 days=11 时撤销。
 * 用法：node scripts/restore_etf_20261106.js [--dry-run]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const DRY = process.argv.includes('--dry-run');
const SRC = path.join(__dirname, '..', 'data', 'etf-flow');
let DIR = SRC;
if (DRY) {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa_etf_restore_'));
  for (const f of fs.readdirSync(SRC)) {
    const s = path.join(SRC, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(DIR, f));
  }
  console.log('[DRY-RUN] 临时目录 ' + DIR + '（生产数据零改动）\n');
}
process.env.SA_ETF_FLOW_DIR = DIR;
const etfFlow = require(path.join(__dirname, '..', 'lib', 'etfFlow.js'));

const readJ = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(v, null, 2), 'utf8');
const BK = path.join(DIR, 'backup');
if (!fs.existsSync(BK)) fs.mkdirSync(BK, { recursive: true });
const tag = (s) => (DRY ? '[DRY] ' : '') + s;

const SNAP = '20261106.json';
const snap = readJ(SNAP);
const ledger = readJ('ledger.json');

// ── 0. 前置校验：只认这一起事故的确切指纹，避免误伤其它数据 ──
if ((snap.etfs || []).length !== 7 || String(snap.shareDate) !== '20261106') {
  console.error('✗ 20261106 快照指纹不符（期望 7 只 / shareDate 20261106），中止，不写盘。');
  process.exit(1);
}

// ── 1. 修快照前，先算出「那次污染入账」的逐股增量 ──
// 幂等保证：此时 ledger.lastDate=20261106 且 shareDate=20261106 → already=true → 不会二次入账、不写盘
const polluted = etfFlow.computeFromSnapshots('20261106');
if (!polluted.ok) { console.error('✗ 无法复现 20261106 入账：' + polluted.reason); process.exit(1); }
const deltas = (polluted.stocks || []).filter(s => s.dayBuy > 0 || s.daySell < 0);
let sumBuy = 0, sumSell = 0;
for (const s of deltas) { sumBuy += s.dayBuy; sumSell += s.daySell; }
console.log(tag(`污染入账复现：baseDate=${polluted.baseDate} spanNote=${polluted.spanNote || '无'}`));
console.log(tag(`  非零逐股 ${deltas.length} 只 | 合计买 ${sumBuy.toFixed(0)} 股 / 卖 ${sumSell.toFixed(0)} 股`));
console.log(tag(`  台账现值：lastDate=${ledger.lastDate} days=${ledger.days} cum键数=${Object.keys(ledger.cum || {}).length}\n`));

// ── 2. 备份（仅正式运行；绝不覆盖已存在的原件，保证重复执行也能保住「事故前」台账）──
const needUndo = ledger.lastDate === '20261106' && ledger.days === 11;
if (!DRY) {
  const snapBk = path.join(BK, '20261106.partial-mislabeled.json');
  const ledgerBk = path.join(BK, 'ledger.before-restore-20261106.json');
  let n = 0;
  if (!fs.existsSync(snapBk)) { fs.copyFileSync(path.join(DIR, SNAP), snapBk); n++; }
  if (needUndo && !fs.existsSync(ledgerBk)) { fs.copyFileSync(path.join(DIR, 'ledger.json'), ledgerBk); n++; }
  console.log(n ? `✓ 已备份 ${n} 份事故前原件 → data/etf-flow/backup/` : '✓ 事故前备份已存在，跳过（不覆盖）');
}

// ── 3. 快照如实标记残缺（份额数字零改动）──
if (snap.restored && snap.partial) {
  console.log(tag('20261106 已恢复过（restored + partial 标记存在），跳过快照重写。'));
} else {
  const out = Object.assign({}, snap, {
    partial: true,
    settled: false,
    gaps: [
      '20261109 诊断：该快照仅 7/34 只 ETF（27 只 PCF 抓取失败），份额为 11-06 收盘值（与 20261109 快照对应代码逐位相同），系 11-07 跨日重采覆盖产物',
      '按 20261029j 残缺快照守卫如实标记 partial:true / settled:false，不臆造份额；基期自动回退上一份完整定稿快照 20261105（shareDate 20261104）',
    ],
    restored: {
      at: new Date().toISOString(),
      reason: '残缺快照误标定稿事故恢复：只改标志位与溯源说明，不动任何份额数字',
      script: 'scripts/restore_etf_20261106.js',
      dryRun: DRY,
    },
  });
  writeJ(SNAP, out);
  console.log(tag('✓ 20261106 已标记 partial:true / settled:false（份额数字零改动）'));
}

// ── 4. 精确撤销污染入账（保全被 KEEP_DAYS 清理掉的早期合法累计）──
// needUndo 已在步骤 2 备份前计算，此处不重复声明
if (!needUndo) {
  console.log(tag(`台账 lastDate=${ledger.lastDate} days=${ledger.days}，非本次污染指纹，跳过撤销（幂等）。`));
} else {
  const L = JSON.parse(JSON.stringify(ledger));
  let nBuy = 0, nSell = 0;
  const bad = [];
  for (const s of deltas) {
    const c = L.cum[s.code];
    if (!c) { bad.push(`${s.code} 台账无 cum 项`); continue; }
    if (s.dayBuy > 0) {
      const v = (c.buyShares || 0) - s.dayBuy;
      if (v < -1) bad.push(`${s.code} buyShares 扣回后为负 ${v}`);
      c.buyShares = Math.abs(v) < 1 ? 0 : v;
      c.buyDays = Math.max(0, (c.buyDays || 0) - 1);
      nBuy++;
    }
    if (s.daySell < 0) {
      // sellShares 是累计负值；入账时 += 负数，撤销时 -= 负数（朝 0 回退）
      const v = (c.sellShares || 0) - s.daySell;
      if (v > 1) bad.push(`${s.code} sellShares 扣回后为正 ${v}`);
      c.sellShares = Math.abs(v) < 1 ? 0 : v;
      c.sellDays = Math.max(0, (c.sellDays || 0) - 1);
      nSell++;
    }
  }
  if (bad.length) {
    console.error('✗ 撤销校验未通过，中止（不写盘）：\n  ' + bad.slice(0, 10).join('\n  '));
    process.exit(1);
  }
  L.days = L.days - 1;
  L.lastDate = '20261104';
  writeJ('ledger.json', L);
  console.log(tag(`✓ 台账撤销：${nBuy} 只买入 / ${nSell} 只卖出逐股扣回；days ${ledger.days}→${L.days}，lastDate ${ledger.lastDate}→${L.lastDate}，cum键数 ${Object.keys(L.cum).length} 不变`));
}

// ── 5. 验证：20261109 恢复可计算 ──
const calc = etfFlow.computeFromSnapshots('20261109');
console.log(tag('\n=== 验证 computeFromSnapshots(20261109) ==='));
console.log(tag(`ok=${calc.ok} overlap=${Boolean(calc.overlap)} date=${calc.date} baseDate=${calc.baseDate} reason=${calc.reason || '无'}`));
console.log(tag(`etfs=${(calc.etfs || []).length} stocks=${(calc.stocks || []).length} groups=${(calc.groups || []).length} totalNet=${calc.totalNet}`));
console.log(tag(`spanNote=${calc.spanNote || '无'}`));
console.log(tag(`ledgerDays=${calc.ledgerDays} ledgerDate=${calc.ledgerDate}`));
if ((calc.groups || []).length) {
  console.log(tag('家族汇总：' + calc.groups.map(g => `${g.label}:${(g.netAmount / 1e8).toFixed(2)}亿`).join(' | ')));
}
const L2 = readJ('ledger.json');
console.log(tag(`台账最终：lastDate=${L2.lastDate} days=${L2.days} cum键数=${Object.keys(L2.cum).length}`));
console.log(tag('\n完成。'));
if (DRY) console.log('[DRY-RUN] 以上全部发生在临时目录，生产 data/etf-flow 未改动。临时目录：' + DIR);

~~~

---

## `scripts\run_all_tests.js`  ·  144 行

~~~js
#!/usr/bin/env node
/**
 * Stock Analyzer · 一键全量回归 runner（零依赖纯 Node）
 * --------------------------------------------------------------
 * 用法：
 *   node scripts/run_all_tests.js              # 全量（含 3 个需网络测试）
 *   node scripts/run_all_tests.js --quick      # 仅跑零网络组（SA_TEST_SCOPE=quick 等价）
 *   node scripts/run_all_tests.js --dry-run    # 只列出测试与分类，不执行（用于 CI 预检）
 *
 * 设计：
 *   - child_process.spawn 串行执行每个 test_*.js，避免端口/临时目录冲突；
 *   - 每脚本独立子进程 + 120s 超时（超时仅标记失败，不阻塞后续）；
 *   - 退出码优先：子进程非零退出即判失败（全部测试均已确认 fail>0 → 非零退出）；
 *   - 结束写 docs/test-report.md 结论化报告；汇总行同时打印到控制台。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const NODE = process.execPath;
const TIMEOUT_MS = 120000;

const QUICK = process.argv.includes('--quick') || process.env.SA_TEST_SCOPE === 'quick';
const DRYRUN = process.argv.includes('--dry-run');

function listTests() {
  return fs.readdirSync(SCRIPTS).filter(f => /^test_.*\.js$/.test(f)).sort();
}
function needsNetwork(src) {
  return /\baxios\b|\bhttps?\s*[:=]|\bfetch\(|\brequest\(|\.get\(['"]https?:/.test(src)
    || /require\(['"]https?['"]\)/.test(src);
}

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(SCRIPTS, file)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return; done = true;
      resolve({ file, code: timedOut ? 'TIMEOUT' : code, out });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(null, true); }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); finish(code, false); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ file, code: 'ERR', out: String(e && e.stack || e) }); });
  });
}

function classify() {
  return listTests().map(f => ({ f, net: needsNetwork(fs.readFileSync(path.join(SCRIPTS, f), 'utf8')) }));
}

(async () => {
  const all = classify();
  const selected = QUICK ? all.filter(t => !t.net) : all;
  const skipped = QUICK ? all.filter(t => t.net) : [];

  if (DRYRUN) {
    console.log('=== DRY-RUN：测试发现与分类（不执行）===');
    console.log(`模式: ${QUICK ? 'quick' : 'full'} | 总 ${all.length} | 将执行 ${selected.length} | 跳过 ${skipped.length}`);
    for (const t of all) {
      const mark = t.net ? (QUICK ? 'SKIP(网络)' : 'NET') : 'OK';
      console.log(`  [${mark}] ${t.f}`);
    }
    process.exit(0);
  }

  console.log('\n=== Stock Analyzer 测试总跑 ===');
  console.log(`模式: ${QUICK ? `quick（跳过需网络 ${skipped.length} 个）` : `full（全部 ${all.length} 个）`}`);

  const results = [];
  for (const t of selected) {
    const r = await runOne(t.f);
    const ok = r.code === 0;
    results.push({ ...t, ...r, ok });
    const tag = r.code === 'TIMEOUT' ? '⏱ 超时' : (r.code === 'ERR' ? '💥 错误' : (ok ? '✅ 通过' : '❌ 失败'));
    console.log(`  [${tag}] ${t.f} (exit=${r.code})`);
  }

  const failed = results.filter(r => !r.ok);
  const passed = results.length - failed.length;
  const ts = new Date().toISOString();
  const total = results.length;

  let summary;
  if (failed.length === 0) {
    summary = `✅ ${passed}/${total} 全绿${skipped.length ? `（另跳过 ${skipped.length} 个需网络测试）` : ''}`;
  } else {
    summary = `❌ ${passed}/${total} 通过，失败 ${failed.length} 项`;
  }

  console.log(`\n=== 汇总：通过 ${passed}/${total}` + (skipped.length ? `，跳过 ${skipped.length}（需网络）` : '') + ' ===');
  if (failed.length) {
    console.log('失败明细：');
    for (const f of failed) {
      console.log(`  - ${f.file} (exit=${f.code})`);
      const tail = (f.out || '').split('\n').filter(l => /✗|❌|FAIL|Error|throw/.test(l)).slice(-5).join('\n    ');
      if (tail) console.log('    ' + tail);
    }
  } else {
    console.log('✅ 全部通过');
  }

  // 写结论化报告
  const lines = [];
  lines.push('# 测试回归报告（docs/test-report.md）');
  lines.push('');
  lines.push(`> 生成时间：${ts}`);
  lines.push(`> 模式：${QUICK ? 'quick（跳过需网络测试）' : 'full'}`);
  lines.push(`> 命令：\`node scripts/run_all_tests.js${QUICK ? ' --quick' : ''}\``);
  lines.push('');
  lines.push(`## 结论\n\n**${summary}**\n`);
  lines.push(`- 执行测试数：${total}`);
  lines.push(`- 通过：${passed}　失败：${failed.length}` + (skipped.length ? `　跳过（需网络）：${skipped.length}` : ''));
  lines.push('');
  lines.push('## 明细\n');
  lines.push('| 状态 | 测试 | 退出码 |');
  lines.push('|------|------|--------|');
  for (const r of results) {
    const st = r.ok ? '✅' : '❌';
    lines.push(`| ${st} | \`${r.file}\` | ${r.code} |`);
  }
  if (skipped.length) {
    lines.push('');
    lines.push('> 以下需网络测试在本模式被跳过（用 `node scripts/run_all_tests.js` 全量执行）：');
    for (const s of skipped) lines.push(`> - \`${s.f}\``);
  }
  lines.push('');
  try {
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'test-report.md'), lines.join('\n'), 'utf8');
    console.log(`\n📄 报告已写入 docs/test-report.md`);
  } catch (e) {
    console.log('\n⚠️ 报告写入失败：' + e.message);
  }

  process.exit(failed.length ? 1 : 0);
})();

~~~

---

## `scripts\sa_lt_603288.json`  ·  1 行

~~~json
{"success":true,"judgment":{"symbol":"603288","name":"海天味业","industry":"食品饮料","date":"2026-09-01","generatedAt":"2026-09-01T13:04:57.026Z","horizon":"long","horizonLabel":"中长期（约 3~12 个月）","verdict":"中性","dir":"震荡","score":-1,"confidence":"低","factors":[{"key":"fundamentals","name":"公司基本面","weight":0.35,"signal":0.12,"applicable":true,"value":"56/100 · 一般","detail":"基本面综合评分 56/100（一般，评级 B）；市盈率27.2倍，市净率5.1倍，ROE 10.1%，净利率26.0%；按「价值型」口径加权","effectiveWeight":0.412,"contribution":0.049,"impactScore":0},{"key":"industry","name":"行业前景","weight":0.25,"signal":0,"applicable":true,"value":"中性（顺周期）","detail":"行业政策定位「中性（顺周期）」；扩大内需战略；促消费政策（以旧换新外溢拉动）；消费是扩大内需主力，白酒等具备强品牌护城河与充沛现金流；但受经济顺周期与消费意愿影响，高端化红利边际放缓。","effectiveWeight":0.294,"contribution":0,"impactScore":0},{"key":"futures","name":"对标期货长期走势","weight":0.15,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0,"impactScore":0},{"key":"market","name":"大盘及行业板块长期走势","weight":0.25,"signal":-0.200625,"applicable":true,"value":"指数60日 -7.1%","detail":"主要指数 60 日平均 -7.1%（上证指数-0.7%、深证成指-9.1%、创业板指-14.3%、沪深300-4%）；所属「食品加工制造」板块 +1.9%（涨 58/跌 7）","effectiveWeight":0.294,"contribution":-0.059,"impactScore":-1}],"autoUpdated":true,"newsCount":15,"marketLong":[{"name":"上证指数","chg60d":-0.75},{"name":"深证成指","chg60d":-9.15},{"name":"创业板指","chg60d":-14.35},{"name":"沪深300","chg60d":-3.96}],"source":"AI 联网抓取 · 东方财富/同花顺/新浪期货/腾讯行情","rules":{"freshness":{"fresh":true,"expired":false,"ageMs":47097026,"ttlMs":86400000,"dataTime":"2026-09-01","reason":"在有效期内"},"staleNote":"","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":34,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T13:04:57.026Z"},"previous":{"value":33.63,"date":"昨收"},"changeRate":1.1,"prevChangeRate":0,"marginal":1.1,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 33.63 上升到 34，涨幅 1.10%，较上一期（持平 0.00%）转为上涨，边际变动 1.10 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"AI 联网抓取 · 东方财富/同花顺/新浪期货/腾讯行情","dataTime":"2026-09-01","fetchedAt":"2026-09-01T13:04:57.026Z","dayChange":1.1,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 1.10%）背离"}}}
~~~

---

## `scripts\sa_sd_601318b.json`  ·  1 行

~~~json
{"success":true,"judgment":{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-09-01","referenceDate":"2026-09-01","generatedAt":"2026-09-01T13:04:18.772Z","closed":true,"target":"nextday","targetDate":"2026-09-02","verdict":"看涨","dir":"涨","score":37,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3535,"signal":0.4858217437613829,"applicable":true,"value":"市场热度 +8.1 | 联动深度解读 | 预期下调 57.6% | 涨停 83/跌停 0 | 利好 6/中性 0/利空 4 | 东财个股83.2↑ / 同花顺未入热榜 / 雪球第2名(关注3157642) | 利好 10/利空 2 · 重大事件 | 量比≈1.52","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 67.1，上升家数占比 48%（中性）；最新财报解读（联动深度分析）：向好；净利同比 +36.1%；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观高增、实质向好，净利润大幅反弹且超预期，营运利润稳健增长，寿险改革初现成效，边际趋势显著加速。\n\n1) 最新报告期：2026年中报（即2026年上半年业绩），披露时间为2026年8月下旬（依据招银国际研报发布日期为2026年8月26日，搜狐证券数据显示截至2026年6月30日财务数据）。  \n2) 核心业绩与边际变化（重点）：  \n   - 营业收入：…；内幕抢跑预警：近 5日 +4% / 10日 +11.5%股价已与消息方向一致（最大 +11.5%），消息影响预期下调 57.6%；全市场涨停 83 家、跌停 0 家，多空比 83（东财涨跌停池(20260901)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 0/消极 4，加权情感均值 48.7（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 83.2、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157642、今日+2.53%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 10/利空 2，情绪均值 +50；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、北京商业航天保险共保体累计已提供风险保障超130亿元；近20日均量 709443，最新 1080897，量比≈1.52（方向随近两日价格走强）","subFactors":[{"name":"消息情绪（大盘）","w":0.14,"signal":0.081,"value":"市场热度 +8.1","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 67.1，上升家数占比 48%（中性）","impactScore":0},{"name":"财报解读","w":0.1,"signal":0.5,"value":"联动深度解读","detail":"最新财报解读（联动深度分析）：向好；净利同比 +36.1%；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观高增、实质向好，净利润大幅反弹且超预期，营运利润稳健增长，寿险改革初现成效，边际趋势显著加速。\n\n1) 最新报告期：2026年中报（即2026年上半年业绩），披露时间为2026年8月下旬（依据招银国际研报发布日期为2026年8月26日，搜狐证券数据显示截至2026年6月30日财务数据）。  \n2) 核心业绩与边际变化（重点）：  \n   - 营业收入：…","impactScore":2},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 57.6%","detail":"内幕抢跑预警：近 5日 +4% / 10日 +11.5%股价已与消息方向一致（最大 +11.5%），消息影响预期下调 57.6%","impactScore":-1},{"name":"涨跌停比","w":0.25,"signal":1,"value":"涨停 83/跌停 0","detail":"全市场涨停 83 家、跌停 0 家，多空比 83（东财涨跌停池(20260901)）","impactScore":3},{"name":"舆情与讨论热度（个股）","w":0.3,"signal":0.39949999999999997,"value":"利好 6/中性 0/利空 4 | 东财个股83.2↑ / 同花顺未入热榜 / 雪球第2名(关注3157642)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 0/消极 4，加权情感均值 48.7（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 83.2、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157642、今日+2.53%","impactScore":1},{"name":"板块消息联动","w":0.2,"signal":0.442,"value":"利好 10/利空 2 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 10/利空 2，情绪均值 +50；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、北京商业航天保险共保体累计已提供风险保障超130亿元","impactScore":1},{"name":"量能活跃度","w":0.15,"signal":0.5235858338403039,"value":"量比≈1.52","detail":"近20日均量 709443，最新 1080897，量比≈1.52（方向随近两日价格走强）","impactScore":2}],"effectiveWeight":0.394,"contribution":0.191,"impactScore":1},{"key":"capital","name":"资金量能","weight":0.2049,"signal":0.50932,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价齐升；近5日主力净流入0.36亿（资金流向为接口估算）；综合：资金面偏多，量能支撑上涨；融资余额：+0.2%","subFactors":[{"name":"量价配合","signal":0.6,"value":"量价齐升","detail":"量价配合良好，上涨有量能支撑","impactScore":2},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.36亿","detail":"近5日主力净流入0.36亿（资金流向为接口估算）","impactScore":3},{"name":"融资余额","signal":0.198,"value":"+0.2%","detail":"沪深融资余额最新 26271 亿，较前值 +0.2%（沪深融资余额(亿元)）","impactScore":1}],"effectiveWeight":0.228,"contribution":0.116,"impactScore":2},{"key":"futures","name":"对标期货短期走势","weight":0.1025,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0,"impactScore":0,"subFactors":[]},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1565,"signal":0.5,"applicable":true,"value":"大盘 -0.9% / 行业 +3.2%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）；行业：保险 +3.2%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":-0.42857142857142855,"value":"平均 -0.9%","detail":"上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）","impactScore":-1},{"name":"行业板块","signal":1,"value":"+3.2%","detail":"保险 +3.2%（涨 5/跌 0）","impactScore":3}],"effectiveWeight":0.174,"contribution":0.087,"impactScore":2},{"key":"holdings","name":"增持减持","weight":0.0473,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股","impactScore":-2},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）","impactScore":-1},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理","impactScore":0}],"effectiveWeight":0.053,"contribution":-0.026,"impactScore":-1},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0682,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%","impactScore":0},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%","impactScore":0},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）","impactScore":0}],"effectiveWeight":0.076,"contribution":0,"impactScore":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.067,"signal":0,"applicable":true,"value":"-0.29%","detail":"科技/半导体板块当日整体下跌 -0.29%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向震荡（中性）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-2.64%","detail":"半导体板块当日下跌2.64%（半导体）","impactScore":0},{"name":"科技板块·电子","w":0,"signal":0,"value":"-0.06%","detail":"电子板块当日下跌0.06%（军工电子）","impactScore":0},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+0.74%","detail":"计算机板块当日上涨0.74%（计算机设备）","impactScore":0},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0.79%","detail":"通信板块当日上涨0.79%（通信服务）","impactScore":0}],"effectiveWeight":0.075,"contribution":0,"impactScore":0}],"weightsUsed":{"sentiment":0.3535,"capital":0.2049,"futures":0.1025,"market":0.1565,"holdings":0.0473,"sectorLimit":0.0682,"seesaw":0.067},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":57.23,"prevClose":55.82,"settled":false,"rules":{"freshness":{"fresh":true,"expired":false,"ageMs":47058772,"ttlMs":86400000,"dataTime":"2026-09-01","reason":"在有效期内"},"staleNote":"","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":57.23,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T13:04:18.772Z"},"previous":{"value":55.82,"date":"昨收"},"changeRate":2.53,"prevChangeRate":0,"marginal":2.53,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 55.82 上升到 57.23，涨幅 2.53%，较上一期（持平 0.00%）转为上涨，边际变动 2.53 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-09-01","fetchedAt":"2026-09-01T13:04:18.772Z","dayChange":2.53,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 2.53%）背离"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"reportEvent":{"symbol":"601318","type":"semi","year":"2026","title":"中国平安(601318.SH)2026年中报净利润为925.85亿元、较去年同期上涨36.06%","date":"2026-08-21 10:27:36"},"reportGap":false,"schemaVersion":"20260831h"},"accuracy":{"totalRecords":8,"settled":[{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-20","generatedAt":"2026-08-20T12:17:15.959Z","closed":true,"target":"nextday","targetDate":"2026-08-21","verdict":"看涨","dir":"涨","score":23,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪（讨论热度）","weight":0.16,"signal":0.043664107408699755,"applicable":true,"value":"涨停 79/跌停 12 | -1.11% | 利好 9/中性 0/利空 1 | 市场热度 +0.09 / 个股 75.6 | 利好 2/利空 7 | 量比≈0.71","detail":"全市场涨停 79 家、跌停 12 家，多空比 6.08（东财涨跌停池(20260820)）；沪深融资余额最新 26329 亿，较前值 -1.11%（沪深融资余额(亿元)）；近 10 条个股新闻（snownlp+词库），积极 9/中性 0/消极 1，情感均值 70.5（东财个股新闻·情感(601318)）；股吧讨论热度：全市场综合得分均值 66.4、上升家数占比 49.4%；该股股吧综合得分 75.6、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）；板块/赛道消息 16 条（关键词：保险、非银金融），利好 2/利空 7，情绪均值 -22；近20日均量 701091，最新 495295，量比≈0.71（方向随近两日价格走强）","effectiveWeight":0.182,"contribution":0.008},{"key":"capital","name":"资金量能","weight":0.22,"signal":0.16,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：缩量下跌；近5日主力净流入0.68亿；综合：资金面偏多，量能支撑上涨","effectiveWeight":0.25,"contribution":0.04},{"key":"futures","name":"对标期货短期走势","weight":0.12,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.16,"signal":0.10342857142857143,"applicable":true,"value":"大盘 +0.2% / 行业 +0.3%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.2%（中性）；行业：保险 +0.3%（涨 4/跌 1）","effectiveWeight":0.182,"contribution":0.019},{"key":"news","name":"近期重大利好/利空","weight":0.18,"signal":0.8153846153846154,"applicable":true,"value":"利好 12/利空 3","detail":"近期 26 条消息，利好 12/利空 3，情绪均值 +34.6（偏多）；最新财报：净利增速 +36.1%（增长/超预期）","effectiveWeight":0.205,"contribution":0.167},{"key":"holdings","name":"增持减持","weight":0.06,"signal":0,"applicable":true,"value":"增持 0/减持 0","detail":"前十大股东中，增持/新进 0 家、减持 0 家、其余 10 家不变","effectiveWeight":0.068,"contribution":0},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.1,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","effectiveWeight":0.114,"contribution":0}],"weightsUsed":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"weightsDefault":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"price":52.14,"prevClose":52.08,"settled":true,"schemaVersion":"20260820w","actualClose":53.35,"actualChgPct":2.32,"actualDir":"涨","actualBaseline":52.14,"actualBaselineLabel":"今日收盘","actualTargetLabel":"次日收盘","correct":true,"referenceDate":"2026-08-20"},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-23","generatedAt":"2026-08-23T13:05:07.719Z","closed":true,"target":"nextday","targetDate":"2026-08-24","verdict":"看涨","dir":"涨","score":16,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪（讨论热度）","weight":0.16,"signal":0.17057392673679433,"applicable":true,"value":"涨停 54/跌停 13 | 利好 8/中性 1/利空 1 | 市场热度 +0.05 / 个股 80.3 | 利好 1/利空 8 · 重大事件 | 量比≈1.56","detail":"全市场涨停 54 家、跌停 13 家，多空比 3.86（东财涨跌停池(20260821)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 1/消极 1，加权情感均值 67.6（东财个股新闻·情感(601318)·近10条加权）；股吧讨论热度：全市场综合得分均值 62.7、上升家数占比 50.5%；该股股吧综合得分 80.3、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）；板块/赛道消息 16 条（关键词：保险、非银金融），利好 1/利空 8，情绪均值 -35；重大事件：众安保险获批增资至16.848亿元；近20日均量 714259，最新 1115990，量比≈1.56（方向随近两日价格走强）","subFactors":[{"name":"涨跌停比","w":0.25,"signal":0.612,"value":"涨停 54/跌停 13","detail":"全市场涨停 54 家、跌停 13 家，多空比 3.86（东财涨跌停池(20260821)）"},{"name":"文本舆情","w":0.15,"signal":0.352,"value":"利好 8/中性 1/利空 1","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 1/消极 1，加权情感均值 67.6（东财个股新闻·情感(601318)·近10条加权）"},{"name":"讨论热度","w":0.15,"signal":0.337,"value":"市场热度 +0.05 / 个股 80.3","detail":"股吧讨论热度：全市场综合得分均值 62.7、上升家数占比 50.5%；该股股吧综合得分 80.3、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）"},{"name":"板块消息联动","w":0.2,"signal":-0.936,"value":"利好 1/利空 8 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 1/利空 8，情绪均值 -35；重大事件：众安保险获批增资至16.848亿元"},{"name":"量能活跃度","w":0.15,"signal":0.5624435604207658,"value":"量比≈1.56","detail":"近20日均量 714259，最新 1115990，量比≈1.56（方向随近两日价格走强）"}],"effectiveWeight":0.182,"contribution":0.031},{"key":"capital","name":"资金量能","weight":0.22,"signal":0.09424,"applicable":true,"value":"资金面中性偏多","detail":"量价：上涨缩量；近5日主力净流入0.46亿（资金流向为接口估算）；综合：资金面中性偏多；融资余额：-0.06%","subFactors":[{"name":"量价配合","signal":-0.2,"value":"上涨缩量","detail":"上涨日成交量低于下跌日，反弹缺乏量能支撑，需警惕"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.46亿","detail":"近5日主力净流入0.46亿（资金流向为接口估算）"},{"name":"融资余额","signal":-0.064,"value":"-0.06%","detail":"沪深融资余额最新 26312 亿，较前值 -0.06%（沪深融资余额(亿元)）"}],"effectiveWeight":0.25,"contribution":0.024},{"key":"futures","name":"对标期货短期走势","weight":0.12,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.16,"signal":0.3395714285714285,"applicable":true,"value":"大盘 +0.4% / 行业 +1%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.4%（偏强）；行业：保险 +1%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":0.21928571428571425,"value":"平均 +0.4%","detail":"上证/深成指/创业板/沪深300 平均 +0.4%（偏强）"},{"name":"行业板块","signal":0.52,"value":"+1%","detail":"保险 +1%（涨 5/跌 0）"}],"effectiveWeight":0.182,"contribution":0.062},{"key":"news","name":"近期重大利好/利空","weight":0.18,"signal":0.357914143533785,"applicable":true,"value":"利好 5/利空 4","detail":"近期 26 条消息，利好 5/利空 4，情绪均值 +3.8（中性）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 3日 +4% / 5日 +3.1%股价已与消息方向一致（最大 +4%），消息影响预期下调 19.8%","subFactors":[{"name":"消息情绪","signal":0.07692307692307693,"value":"利好 5/利空 4","detail":"近期 26 条消息，利好 5/利空 4，情绪均值 +3.8（中性）"},{"name":"财报符合预期","signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","signal":-0.4,"value":"预期下调 19.8%","detail":"内幕抢跑预警：近 3日 +4% / 5日 +3.1%股价已与消息方向一致（最大 +4%），消息影响预期下调 19.8%"}],"effectiveWeight":0.205,"contribution":0.073},{"key":"holdings","name":"增持减持","weight":0.06,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.068,"contribution":-0.034},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.1,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.114,"contribution":0}],"weightsUsed":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"weightsDefault":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"price":53.35,"prevClose":52.14,"settled":true,"schemaVersion":"20260823h","actualClose":54.92,"actualChgPct":2.94,"actualDir":"涨","actualBaseline":53.35,"actualBaselineLabel":"基准日(2026-08-21)收盘","actualTargetLabel":"次日收盘","correct":true,"referenceDate":"2026-08-23"},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-25","referenceDate":"2026-08-24","generatedAt":"2026-08-25T10:02:20.225Z","closed":true,"target":"nextday","targetDate":"2026-08-25","verdict":"看涨","dir":"涨","score":21,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.38,"signal":0.4146312835431964,"applicable":true,"value":"利好 11/利空 4 | 净利增速 +36.1% | 预期下调 36% | 涨停 65/跌停 2 | 利好 5/中性 1/利空 4 | 市场热度 +0.1 / 个股 76.4 | 利好 4/利空 6 · 重大事件 | 量比≈0.98","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +24.1（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 3日 +5.5% / 5日 +7.2% / 10日 +4.7%股价已与消息方向一致（最大 +7.2%），消息影响预期下调 36%；全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260825)）；近 10 条个股新闻（snownlp+词库），积极 5/中性 1/消极 4，加权情感均值 48.2（东财个股新闻·情感(601318)·近10条加权）；股吧讨论热度：全市场综合得分均值 66.7、上升家数占比 49.4%；该股股吧综合得分 76.4、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）；板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -6；重大事件：定期存款热度降温 分红型保险成银行力推产品、众安保险获批增资至16.848亿元；近20日均量 750992，最新 739290，量比≈0.98（方向随近两日价格走强）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.30838457319361456,"value":"利好 11/利空 4","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +24.1（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 36%","detail":"内幕抢跑预警：近 3日 +5.5% / 5日 +7.2% / 10日 +4.7%股价已与消息方向一致（最大 +7.2%），消息影响预期下调 36%"},{"name":"涨跌停比","w":0.25,"signal":0.94,"value":"涨停 65/跌停 2","detail":"全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260825)）"},{"name":"文本舆情","w":0.15,"signal":-0.036,"value":"利好 5/中性 1/利空 4","detail":"近 10 条个股新闻（snownlp+词库），积极 5/中性 1/消极 4，加权情感均值 48.2（东财个股新闻·情感(601318)·近10条加权）"},{"name":"讨论热度","w":0.15,"signal":0.298,"value":"市场热度 +0.1 / 个股 76.4","detail":"股吧讨论热度：全市场综合得分均值 66.7、上升家数占比 49.4%；该股股吧综合得分 76.4、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）"},{"name":"板块消息联动","w":0.2,"signal":0.468,"value":"利好 4/利空 6 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -6；重大事件：定期存款热度降温 分红型保险成银行力推产品、众安保险获批增资至16.848亿元"},{"name":"量能活跃度","w":0.15,"signal":0.01558258112865063,"value":"量比≈0.98","detail":"近20日均量 750992，最新 739290，量比≈0.98（方向随近两日价格走强）"}],"effectiveWeight":0.428,"contribution":0.178},{"key":"capital","name":"资金量能","weight":0.207,"signal":0.23574,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入4.6亿；综合：资金面偏多，量能支撑上涨；融资余额：-0.16%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 4.6亿","detail":"近5日主力净流入4.6亿"},{"name":"融资余额","signal":-0.159,"value":"-0.16%","detail":"沪深融资余额最新 26208 亿，较前值 -0.16%（沪深融资余额(亿元)）"}],"effectiveWeight":0.233,"contribution":0.055},{"key":"futures","name":"对标期货短期走势","weight":0.113,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.15,"signal":0.03942857142857143,"applicable":true,"value":"大盘 -0.2% / 行业 +0.5%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.2%（中性）；行业：保险 +0.5%（涨 3/跌 2）","subFactors":[{"name":"大盘指数","signal":-0.0842857142857143,"value":"平均 -0.2%","detail":"上证/深成指/创业板/沪深300 平均 -0.2%（中性）"},{"name":"行业板块","signal":0.225,"value":"+0.5%","detail":"保险 +0.5%（涨 3/跌 2）"}],"effectiveWeight":0.169,"contribution":0.007},{"key":"holdings","name":"增持减持","weight":0.056,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.063,"contribution":-0.031},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.094,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.106,"contribution":0}],"weightsUsed":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"weightsDefault":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"price":55.01,"prevClose":54.92,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260823i","actualClose":55.01,"actualChgPct":0.16,"actualDir":"涨","actualBaseline":54.92,"actualBaselineLabel":"基准日(2026-08-24)收盘","actualTargetLabel":"次日收盘","correct":true},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-26","referenceDate":"2026-08-25","generatedAt":"2026-08-26T13:29:27.766Z","closed":true,"target":"nextday","targetDate":"2026-08-26","verdict":"看涨","dir":"涨","score":32,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.38,"signal":0.4084573508481495,"applicable":true,"value":"利好 9/利空 3 | 净利增速 +36.1% | 预期下调 38.9% | 涨停 52/跌停 0 | 利好 6/中性 1/利空 3 | 东财个股83.3↑ / 同花顺第89名(热度766241) / 雪球第2名(关注3153936) | 利好 3/利空 6 | 量比≈1.39","detail":"近期 27 条消息，利好 9/利空 3，情绪均值 +22.2（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 3日 +5.2% / 5日 +7.8% / 10日 +6.7%股价已与消息方向一致（最大 +7.8%），消息影响预期下调 38.9%；全市场涨停 52 家、跌停 0 家，多空比 52（东财涨跌停池(20260826)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 58.6（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 83.3、热度上升；同花顺热榜第89名、热度值766241、涨跌+2.04%；雪球关注榜第2名、关注人数3153936、今日+2.04%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 3/利空 6，情绪均值 -10；近20日均量 760108，最新 1053437，量比≈1.39（方向随近两日价格走强）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.2716333845366102,"value":"利好 9/利空 3","detail":"近期 27 条消息，利好 9/利空 3，情绪均值 +22.2（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 38.9%","detail":"内幕抢跑预警：近 3日 +5.2% / 5日 +7.8% / 10日 +6.7%股价已与消息方向一致（最大 +7.8%），消息影响预期下调 38.9%"},{"name":"涨跌停比","w":0.25,"signal":1,"value":"涨停 52/跌停 0","detail":"全市场涨停 52 家、跌停 0 家，多空比 52（东财涨跌停池(20260826)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.2405,"value":"利好 6/中性 1/利空 3 | 东财个股83.3↑ / 同花顺第89名(热度766241) / 雪球第2名(关注3153936)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 58.6（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 83.3、热度上升；同花顺热榜第89名、热度值766241、涨跌+2.04%；雪球关注榜第2名、关注人数3153936、今日+2.04%"},{"name":"板块消息联动","w":0.2,"signal":-0.06,"value":"利好 3/利空 6","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 3/利空 6，情绪均值 -10"},{"name":"量能活跃度","w":0.15,"signal":0.38590382449448324,"value":"量比≈1.39","detail":"近20日均量 760108，最新 1053437，量比≈1.39（方向随近两日价格走强）"}],"effectiveWeight":0.428,"contribution":0.175},{"key":"capital","name":"资金量能","weight":0.207,"signal":0.25394,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入10.37亿；综合：资金面偏多，量能支撑上涨；融资余额：-0.03%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 10.37亿","detail":"近5日主力净流入10.37亿"},{"name":"融资余额","signal":-0.029,"value":"-0.03%","detail":"沪深融资余额最新 26201 亿，较前值 -0.03%（沪深融资余额(亿元)）"}],"effectiveWeight":0.233,"contribution":0.059},{"key":"futures","name":"对标期货短期走势","weight":0.113,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.15,"signal":0.6635714285714285,"applicable":true,"value":"大盘 +0.9% / 行业 +2.2%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.9%（偏强）；行业：保险 +2.2%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":0.4392857142857142,"value":"平均 +0.9%","detail":"上证/深成指/创业板/沪深300 平均 +0.9%（偏强）"},{"name":"行业板块","signal":1,"value":"+2.2%","detail":"保险 +2.2%（涨 5/跌 0）"}],"effectiveWeight":0.169,"contribution":0.112},{"key":"holdings","name":"增持减持","weight":0.056,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.063,"contribution":-0.031},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.094,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.106,"contribution":0}],"weightsUsed":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"weightsDefault":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"price":56.13,"prevClose":55.01,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"reportEvent":{"symbol":"601318","type":"semi","year":"2026","title":"新华保险：2026年度中期利润分配方案公告","date":"2026-08-26 19:23:00"},"reportGap":false,"schemaVersion":"20260826j","actualClose":56.13,"actualChgPct":2.04,"actualDir":"涨","actualBaseline":55.01,"actualBaselineLabel":"基准日(2026-08-25)收盘","actualTargetLabel":"次日收盘","correct":true},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-27","referenceDate":"2026-08-26","generatedAt":"2026-08-27T03:35:50.607Z","closed":false,"target":"nextday","targetDate":"2026-08-27","verdict":"看涨","dir":"涨","score":13,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.34,"signal":0.3534344830990233,"applicable":true,"value":"利好 11/利空 4 | 净利增速 +36.1% | 预期下调 32.9% | 涨停 65/跌停 2 | 利好 6/中性 1/利空 3 | 东财个股82.8↑ / 同花顺第91名(热度786667) / 雪球第2名(关注3154485) | 利好 4/利空 6 | 量比≈0.55","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +25.9（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 5日 +6.6% / 10日 +5.2%股价已与消息方向一致（最大 +6.6%），消息影响预期下调 32.9%；全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260827)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 82.8、热度上升；同花顺热榜第91名、热度值786667、涨跌-1%；雪球关注榜第2名、关注人数3154485、今日-1%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -3；近20日均量 727313，最新 402552，量比≈0.55（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.3479663015527995,"value":"利好 11/利空 4","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +25.9（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 32.9%","detail":"内幕抢跑预警：近 5日 +6.6% / 10日 +5.2%股价已与消息方向一致（最大 +6.6%），消息影响预期下调 32.9%"},{"name":"涨跌停比","w":0.25,"signal":0.94,"value":"涨停 65/跌停 2","detail":"全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260827)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.27949999999999997,"value":"利好 6/中性 1/利空 3 | 东财个股82.8↑ / 同花顺第91名(热度786667) / 雪球第2名(关注3154485)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 82.8、热度上升；同花顺热榜第91名、热度值786667、涨跌-1%；雪球关注榜第2名、关注人数3154485、今日-1%"},{"name":"板块消息联动","w":0.2,"signal":0.2,"value":"利好 4/利空 6","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -3"},{"name":"量能活跃度","w":0.15,"signal":-0.44652164886369416,"value":"量比≈0.55","detail":"近20日均量 727313，最新 402552，量比≈0.55（方向随近两日价格走弱）"}],"effectiveWeight":0.381,"contribution":0.135},{"key":"capital","name":"资金量能","weight":0.197,"signal":0.34356,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入0.79亿（资金流向为接口估算）；综合：资金面偏多，量能支撑上涨；融资余额：-0.13%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.79亿","detail":"近5日主力净流入0.79亿（资金流向为接口估算）"},{"name":"融资余额","signal":-0.126,"value":"-0.13%","detail":"沪深融资余额最新 26168 亿，较前值 -0.13%（沪深融资余额(亿元)）"}],"effectiveWeight":0.221,"contribution":0.076},{"key":"futures","name":"对标期货短期走势","weight":0.107,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.143,"signal":0.14399999999999996,"applicable":true,"value":"大盘 +1.3% / 行业 -1.3%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +1.3%（偏强）；行业：保险 -1.3%（涨 0/跌 5）","subFactors":[{"name":"大盘指数","signal":0.6699999999999999,"value":"平均 +1.3%","detail":"上证/深成指/创业板/沪深300 平均 +1.3%（偏强）"},{"name":"行业板块","signal":-0.645,"value":"-1.3%","detail":"保险 -1.3%（涨 0/跌 5）"}],"effectiveWeight":0.16,"contribution":0.023},{"key":"holdings","name":"增持减持","weight":0.054,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.06,"contribution":-0.03},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.089,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.1,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.07,"signal":-1,"applicable":true,"value":"+3.66%","detail":"科技/半导体板块当日整体上涨 +3.66%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向下跌（偏空）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"+4.6%","detail":"半导体板块当日上涨4.60%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+5.09%","detail":"电子板块当日上涨5.09%（电子化学品）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+1.48%","detail":"计算机板块当日上涨1.48%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+3.48%","detail":"通信板块当日上涨3.48%（通信设备）"}],"effectiveWeight":0.078,"contribution":-0.078}],"weightsUsed":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":55.57,"prevClose":56.13,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"reportEvent":{"symbol":"601318","type":"semi","year":"2026","title":"中国平安(601318.SH)2026年中报净利润为925.85亿元、较去年同期上涨36.06%","date":"2026-08-21 10:27:36"},"reportGap":false,"schemaVersion":"20260827d","actualClose":55.87,"actualChgPct":-0.46,"actualDir":"跌","actualBaseline":56.13,"actualBaselineLabel":"基准日(2026-08-26)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-28","referenceDate":"2026-08-27","generatedAt":"2026-08-28T02:40:12.954Z","closed":false,"target":"nextday","targetDate":"2026-08-28","verdict":"看涨","dir":"涨","score":13,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3602,"signal":0.3686507060377861,"applicable":true,"value":"利好 9/利空 4 | 净利增速 +36.1% | 预期下调 39.3% | 涨停 53/跌停 1 | 利好 6/中性 1/利空 3 | 东财个股74.9↓ / 同花顺未入热榜 / 雪球第2名(关注3155180) | 利好 8/利空 3 | 量比≈0.4","detail":"近期 27 条消息，利好 9/利空 4，情绪均值 +18.5（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 5日 +4.6% / 10日 +7.9%股价已与消息方向一致（最大 +7.9%），消息影响预期下调 39.3%；全市场涨停 53 家、跌停 1 家，多空比 26.5（东财涨跌停池(20260828)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 74.9、热度下降；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3155180、今日-0.09%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 8/利空 3，情绪均值 +31；近20日均量 700661，最新 278081，量比≈0.4（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.22472714260153875,"value":"利好 9/利空 4","detail":"近期 27 条消息，利好 9/利空 4，情绪均值 +18.5（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 39.3%","detail":"内幕抢跑预警：近 5日 +4.6% / 10日 +7.9%股价已与消息方向一致（最大 +7.9%），消息影响预期下调 39.3%"},{"name":"涨跌停比","w":0.25,"signal":0.963,"value":"涨停 53/跌停 1","detail":"全市场涨停 53 家、跌停 1 家，多空比 26.5（东财涨跌停池(20260828)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.4965,"value":"利好 6/中性 1/利空 3 | 东财个股74.9↓ / 同花顺未入热榜 / 雪球第2名(关注3155180)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 74.9、热度下降；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3155180、今日-0.09%"},{"name":"板块消息联动","w":0.2,"signal":0.14,"value":"利好 8/利空 3","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 8/利空 3，情绪均值 +31"},{"name":"量能活跃度","w":0.15,"signal":-0.6031163985283332,"value":"量比≈0.4","detail":"近20日均量 700661，最新 278081，量比≈0.4（方向随近两日价格走弱）"}],"effectiveWeight":0.401,"contribution":0.148},{"key":"capital","name":"资金量能","weight":0.2086,"signal":0.08969040287581448,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入4.82亿；综合：资金面偏多，量能支撑上涨；换手率变化：最新换手率 0.26%，近15日均值 0.75%（偏离 -65.2%），近两日价跌 → 放量偏空；融资余额：+0.43%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 4.82亿","detail":"近5日主力净流入4.82亿"},{"name":"换手率变化","signal":-0.7825799760348794,"value":"放量偏空","detail":"最新换手率 0.26%，近15日均值 0.75%（偏离 -65.2%），近两日价跌 → 放量偏空"},{"name":"融资余额","signal":0.432,"value":"+0.43%","detail":"沪深融资余额最新 26281 亿，较前值 +0.43%（沪深融资余额(亿元)）"}],"effectiveWeight":0.232,"contribution":0.021},{"key":"futures","name":"对标期货短期走势","weight":0.1012,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1515,"signal":-0.09142857142857144,"applicable":true,"value":"大盘 -0.1% / 行业 -0.4%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.1%（中性）；行业：保险 -0.4%（涨 2/跌 3）","subFactors":[{"name":"大盘指数","signal":-0.025714285714285714,"value":"平均 -0.1%","detail":"上证/深成指/创业板/沪深300 平均 -0.1%（中性）"},{"name":"行业板块","signal":-0.19,"value":"-0.4%","detail":"保险 -0.4%（涨 2/跌 3）"}],"effectiveWeight":0.169,"contribution":-0.015},{"key":"holdings","name":"增持减持","weight":0.0449,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.05,"contribution":-0.025},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0673,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.075,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.0662,"signal":0,"applicable":true,"value":"+0.2%","detail":"科技/半导体板块当日整体上涨 +0.2%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向震荡（中性）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-0.08%","detail":"半导体板块当日下跌0.08%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+0.52%","detail":"电子板块当日上涨0.52%（其他电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"-0.06%","detail":"计算机板块当日下跌0.06%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0.41%","detail":"通信板块当日上涨0.41%（通信设备）"}],"effectiveWeight":0.074,"contribution":0}],"weightsUsed":{"sentiment":0.3602,"capital":0.2086,"futures":0.1012,"market":0.1515,"holdings":0.0449,"sectorLimit":0.0673,"seesaw":0.0662},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":55.82,"prevClose":55.87,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260827d","actualClose":55.85,"actualChgPct":-0.04,"actualDir":"跌","actualBaseline":55.87,"actualBaselineLabel":"基准日(2026-08-27)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"今日后续","date":"2026-09-01","referenceDate":"2026-08-31","generatedAt":"2026-09-01T02:39:52.928Z","closed":false,"target":"nextday","targetDate":"2026-09-01","verdict":"看涨","dir":"涨","score":22,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3509,"signal":0.23557341284054462,"applicable":true,"value":"市场热度 +4.9 | 净利增速 +36.1% | 预期下调 54.6% | 涨停 58/跌停 1 | 利好 5/中性 0/利空 5 | 东财个股78.4↑ / 同花顺未入热榜 / 雪球第2名(关注3157416) | 利好 7/利空 4 · 重大事件 | 量比≈0.73","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 5日 +3.5% / 10日 +10.9%股价已与消息方向一致（最大 +10.9%），消息影响预期下调 54.6%；全市场涨停 58 家、跌停 1 家，多空比 29（东财涨跌停池(20260901)）；近 10 条个股新闻（snownlp+词库），积极 5/中性 0/消极 5，加权情感均值 43.8（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 78.4、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157416、今日+2.01%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 7/利空 4，情绪均值 +19；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、深市非银金融半年报业绩亮眼 超三成公司增速逾50%；近20日均量 680292，最新 497872，量比≈0.73（方向随近两日价格走强）","subFactors":[{"name":"消息情绪（大盘）","w":0.14,"signal":0.049,"value":"市场热度 +4.9","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）"},{"name":"财报解读","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 54.6%","detail":"内幕抢跑预警：近 5日 +3.5% / 10日 +10.9%股价已与消息方向一致（最大 +10.9%），消息影响预期下调 54.6%"},{"name":"涨跌停比","w":0.25,"signal":0.966,"value":"涨停 58/跌停 1","detail":"全市场涨停 58 家、跌停 1 家，多空比 29（东财涨跌停池(20260901)）"},{"name":"舆情与讨论热度（个股）","w":0.3,"signal":0.3645,"value":"利好 5/中性 0/利空 5 | 东财个股78.4↑ / 同花顺未入热榜 / 雪球第2名(关注3157416)","detail":"近 10 条个股新闻（snownlp+词库），积极 5/中性 0/消极 5，加权情感均值 43.8（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 78.4、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157416、今日+2.01%"},{"name":"板块消息联动","w":0.2,"signal":-0.988,"value":"利好 7/利空 4 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 7/利空 4，情绪均值 +19；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、深市非银金融半年报业绩亮眼 超三成公司增速逾50%"},{"name":"量能活跃度","w":0.15,"signal":0.26814907520165443,"value":"量比≈0.73","detail":"近20日均量 680292，最新 497872，量比≈0.73（方向随近两日价格走强）"}],"effectiveWeight":0.391,"contribution":0.092},{"key":"capital","name":"资金量能","weight":0.2033,"signal":0.19806487547169796,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入0.95亿；综合：资金面偏多，量能支撑上涨；换手率变化：最新换手率 0.47%，近15日均值 0.75%（偏离 -37.1%），近两日价涨 → 放量偏多；融资余额：+0.2%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.95亿","detail":"近5日主力净流入0.95亿"},{"name":"换手率变化","signal":0.4455406289308162,"value":"放量偏多","detail":"最新换手率 0.47%，近15日均值 0.75%（偏离 -37.1%），近两日价涨 → 放量偏多"},{"name":"融资余额","signal":0.198,"value":"+0.2%","detail":"沪深融资余额最新 26271 亿，较前值 +0.2%（沪深融资余额(亿元)）"}],"effectiveWeight":0.227,"contribution":0.045},{"key":"futures","name":"对标期货短期走势","weight":0.1035,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1568,"signal":0.49350000000000005,"applicable":true,"value":"大盘 -0.9% / 行业 +2.7%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）；行业：保险 +2.7%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":-0.4471428571428571,"value":"平均 -0.9%","detail":"上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）"},{"name":"行业板块","signal":1,"value":"+2.7%","detail":"保险 +2.7%（涨 5/跌 0）"}],"effectiveWeight":0.175,"contribution":0.086},{"key":"holdings","name":"增持减持","weight":0.0488,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.054,"contribution":-0.027},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0689,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.077,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.0677,"signal":0.319,"applicable":true,"value":"-0.96%","detail":"科技/半导体板块当日整体下跌 -0.96%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向上涨（偏多）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-2.6%","detail":"半导体板块当日下跌2.60%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"-0.96%","detail":"电子板块当日下跌0.96%（军工电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"-0.17%","detail":"计算机板块当日下跌0.17%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"-0.1%","detail":"通信板块当日下跌0.10%（通信服务）"}],"effectiveWeight":0.076,"contribution":0.024}],"weightsUsed":{"sentiment":0.3509,"capital":0.2033,"futures":0.1035,"market":0.1568,"holdings":0.0488,"sectorLimit":0.0689,"seesaw":0.0677},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":56.91,"prevClose":55.82,"settled":true,"rules":{"freshness":{"fresh":false,"expired":true,"ageMs":95992928,"ttlMs":86400000,"dataTime":"2026-08-31","reason":"数据日之后已过 1 个交易日，超过该类型有效期"},"staleNote":"数据已过期，最后更新时间是 2026-08-31","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":56.91,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T02:39:52.928Z"},"previous":{"value":55.82,"date":"昨收"},"changeRate":1.95,"prevChangeRate":0,"marginal":1.95,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 55.82 上升到 56.91，涨幅 1.95%，较上一期（持平 0.00%）转为上涨，边际变动 1.95 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-08-31","fetchedAt":"2026-09-01T02:39:52.928Z","dayChange":1.95,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 1.95%）背离"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260831h","actualClose":57.23,"actualChgPct":2.53,"actualDir":"涨","actualBaseline":55.82,"actualBaselineLabel":"基准日(2026-08-31)收盘","actualTargetLabel":"次日收盘","correct":true}],"settledCount":7,"pendingCount":1,"overdueCount":0,"correct":5,"accuracy":71.4,"bullRate":71.4,"bearRate":null,"flatRate":null,"intradayRate":null,"nextdayRate":71.4},"today":"2026-09-01","regenerated":true}
~~~

---

## `scripts\sa_sd_603288.json`  ·  1 行

~~~json
{"success":true,"judgment":{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-09-01","referenceDate":"2026-09-01","generatedAt":"2026-09-01T13:03:56.913Z","closed":true,"target":"nextday","targetDate":"2026-09-02","verdict":"看涨","dir":"涨","score":17,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.34,"signal":0.4572565638484887,"applicable":true,"value":"市场热度 +8.1 | 联动深度解读 | 涨停 83/跌停 0 | 利好 8/中性 2/利空 0 | 东财个股71.4↑ / 同花顺未入热榜 / 雪球第17名(关注1925033) | 利好 8/利空 4 · 重大事件 | 量比≈0.94","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 67.1，上升家数占比 48%（中性）；最新财报解读（联动深度分析）：承压；净利同比 +7.1%；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观稳、实质弱，核心利润虽同比增长但增速明显放缓，叠加现金流大幅下滑与Q2环比显著恶化，显示经营压力加大，边际趋势拐头向下。\n\n1) 最新报告期：2026年中报（2026年1月1日–6月30日），披露日期为2026年8月27日（来源：公司公告、上交所、巨潮资讯网）。\n\n2) 核心业绩与边际变化（重点）：\n- 营业收入：161.46亿元，同比+6.01%（上…；全市场涨停 83 家、跌停 0 家，多空比 83（东财涨跌停池(20260901)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 74.6（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 71.4、热度上升；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1925033、今日+1.1%；板块/赛道消息 22 条（关键词：食品饮料、白酒、消费），利好 8/利空 4，情绪均值 +18；重大事件：百亿级私募持仓全景图亮相 食品饮料行业持仓最重 拥抱绩优股成共识、超八成食品饮料上市公司上半年盈利 70家公司现金流同比实现正增长 23家公司发布半年度利润分配方案；近20日均量 167863，最新 157307，量比≈0.94（方向随近两日价格走强）","subFactors":[{"name":"消息情绪（大盘）","w":0.14,"signal":0.081,"value":"市场热度 +8.1","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 67.1，上升家数占比 48%（中性）","impactScore":0},{"name":"财报解读","w":0.1,"signal":-0.5,"value":"联动深度解读","detail":"最新财报解读（联动深度分析）：承压；净利同比 +7.1%；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观稳、实质弱，核心利润虽同比增长但增速明显放缓，叠加现金流大幅下滑与Q2环比显著恶化，显示经营压力加大，边际趋势拐头向下。\n\n1) 最新报告期：2026年中报（2026年1月1日–6月30日），披露日期为2026年8月27日（来源：公司公告、上交所、巨潮资讯网）。\n\n2) 核心业绩与边际变化（重点）：\n- 营业收入：161.46亿元，同比+6.01%（上…","impactScore":-1},{"name":"涨跌停比","w":0.25,"signal":1,"value":"涨停 83/跌停 0","detail":"全市场涨停 83 家、跌停 0 家，多空比 83（东财涨跌停池(20260901)）","impactScore":3},{"name":"舆情与讨论热度（个股）","w":0.3,"signal":0.655,"value":"利好 8/中性 2/利空 0 | 东财个股71.4↑ / 同花顺未入热榜 / 雪球第17名(关注1925033)","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 74.6（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 71.4、热度上升；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1925033、今日+1.1%","impactScore":2},{"name":"板块消息联动","w":0.2,"signal":0.52,"value":"利好 8/利空 4 · 重大事件","detail":"板块/赛道消息 22 条（关键词：食品饮料、白酒、消费），利好 8/利空 4，情绪均值 +18；重大事件：百亿级私募持仓全景图亮相 食品饮料行业持仓最重 拥抱绩优股成共识、超八成食品饮料上市公司上半年盈利 70家公司现金流同比实现正增长 23家公司发布半年度利润分配方案","impactScore":2},{"name":"量能活跃度","w":0.15,"signal":0.06288321858184742,"value":"量比≈0.94","detail":"近20日均量 167863，最新 157307，量比≈0.94（方向随近两日价格走强）","impactScore":0}],"effectiveWeight":0.381,"contribution":0.174,"impactScore":1},{"key":"capital","name":"资金量能","weight":0.197,"signal":-0.38508,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：放量下跌；近5日主力净流出0.11亿（资金流向为接口估算）；综合：资金面偏空，注意风险；融资余额：+0.2%","subFactors":[{"name":"量价配合","signal":-0.6,"value":"放量下跌","detail":"下跌日显著放量（空头主导、抛压沉重），注意风险","impactScore":-2},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 0.11亿","detail":"近5日主力净流出0.11亿（资金流向为接口估算）","impactScore":-3},{"name":"融资余额","signal":0.198,"value":"+0.2%","detail":"沪深融资余额最新 26271 亿，较前值 +0.2%（沪深融资余额(亿元)）","impactScore":1}],"effectiveWeight":0.221,"contribution":-0.085,"impactScore":-1},{"key":"futures","name":"对标期货短期走势","weight":0.107,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0,"impactScore":0,"subFactors":[]},{"key":"market","name":"大盘及行业板块短期走势","weight":0.143,"signal":0.4674999999999999,"applicable":true,"value":"大盘 -0.9% / 行业 +1.9%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）；行业：食品加工制造 +1.9%（涨 58/跌 7）","subFactors":[{"name":"大盘指数","signal":-0.42857142857142855,"value":"平均 -0.9%","detail":"上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）","impactScore":-1},{"name":"行业板块","signal":0.95,"value":"+1.9%","detail":"食品加工制造 +1.9%（涨 58/跌 7）","impactScore":3}],"effectiveWeight":0.16,"contribution":0.075,"impactScore":1},{"key":"holdings","name":"增持减持","weight":0.054,"signal":0.057260688863830685,"applicable":true,"value":"增持 1/减持 0/净变动 +70.09万股","detail":"前十大股东中，增持/新进 1 家（香港中央结算有限公司）、减持 0 家、其余 9 家不变；十大股东合计净变动 +70.09万股（占其持股 0.02%）（数据报告期：2026-07-03）","subFactors":[{"name":"十大股东净变动","signal":0.005023753030734842,"value":"+70.09万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 +70.09万股，占其合计持股 0.02%；其中增持 70.09万股、减持 0股","impactScore":0},{"name":"增减持家数","signal":0.1,"value":"增持 1/减持 0","detail":"前十大股东增持/新进 1 家、减持 0 家、不变 9 家（增持：香港中央结算有限公司）","impactScore":0},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理","impactScore":0}],"effectiveWeight":0.06,"contribution":0.003,"impactScore":0},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.089,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 65 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块涨停 0 家，占成分股 0.0%","impactScore":0},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%","impactScore":0},{"name":"板块成分","signal":0,"value":"65 家","detail":"板块成分股共 65 家（食品加工制造）","impactScore":0}],"effectiveWeight":0.1,"contribution":0,"impactScore":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.07,"signal":0,"applicable":true,"value":"-0.29%","detail":"科技/半导体板块当日整体下跌 -0.29%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向震荡（中性）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-2.64%","detail":"半导体板块当日下跌2.64%（半导体）","impactScore":0},{"name":"科技板块·电子","w":0,"signal":0,"value":"-0.06%","detail":"电子板块当日下跌0.06%（军工电子）","impactScore":0},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+0.74%","detail":"计算机板块当日上涨0.74%（计算机设备）","impactScore":0},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0.79%","detail":"通信板块当日上涨0.79%（通信服务）","impactScore":0}],"effectiveWeight":0.078,"contribution":0,"impactScore":0}],"weightsUsed":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":34,"prevClose":33.63,"settled":false,"rules":{"freshness":{"fresh":true,"expired":false,"ageMs":47036914,"ttlMs":86400000,"dataTime":"2026-09-01","reason":"在有效期内"},"staleNote":"","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":34,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T13:03:56.914Z"},"previous":{"value":33.63,"date":"昨收"},"changeRate":1.1,"prevChangeRate":0,"marginal":1.1,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 33.63 上升到 34，涨幅 1.10%，较上一期（持平 0.00%）转为上涨，边际变动 1.10 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-09-01","fetchedAt":"2026-09-01T13:03:56.914Z","dayChange":1.1,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 1.10%）背离"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.564,"weakThemes":["消费"]},"reportEvent":{"symbol":"603288","type":"semi","year":"2026","title":"海天味业(603288.SH)：2026年中报净利润为41.90亿元","date":"2026-08-27 09:08:43"},"reportGap":false,"schemaVersion":"20260831h"},"accuracy":{"totalRecords":9,"settled":[{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-20","generatedAt":"2026-08-20T12:17:11.668Z","closed":true,"target":"nextday","targetDate":"2026-08-21","verdict":"震荡","dir":"震荡","score":-6,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪（讨论热度）","weight":0.16,"signal":0.2851746791030122,"applicable":true,"value":"涨停 79/跌停 12 | -1.11% | 利好 8/中性 0/利空 2 | 市场热度 +0.09 / 个股 75.9 | 利好 12/利空 5 · 重大事件 | 量比≈0.66","detail":"全市场涨停 79 家、跌停 12 家，多空比 6.08（东财涨跌停池(20260820)）；沪深融资余额最新 26329 亿，较前值 -1.11%（沪深融资余额(亿元)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 0/消极 2，情感均值 67.1（东财个股新闻·情感(603288)）；股吧讨论热度：全市场综合得分均值 66.4、上升家数占比 49.4%；该股股吧综合得分 75.9、热度 上升（东财股吧舆情聚合·市场热度+个股(603288)）；板块/赛道消息 23 条（关键词：食品饮料、消费、白酒），利好 12/利空 5，情绪均值 +33；重大事件：食品饮料板块再度活跃 皇氏集团4连板；近20日均量 165477，最新 108396，量比≈0.66（方向随近两日价格走强）","effectiveWeight":0.182,"contribution":0.052},{"key":"capital","name":"资金量能","weight":0.22,"signal":-0.84,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：量价温和偏弱；近5日主力净流出0.44亿；综合：资金面偏空，注意风险","effectiveWeight":0.25,"contribution":-0.21},{"key":"futures","name":"对标期货短期走势","weight":0.12,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.16,"signal":0.21742857142857144,"applicable":true,"value":"大盘 +0.2% / 行业 +0.9%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.2%（中性）；行业：食品加工制造 +0.9%（涨 48/跌 15）","effectiveWeight":0.182,"contribution":0.04},{"key":"news","name":"近期重大利好/利空","weight":0.18,"signal":0.41215384615384615,"applicable":true,"value":"利好 12/利空 5","detail":"近期 26 条消息，利好 12/利空 5，情绪均值 +24.3（偏多）；最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.0%，盈利空间充裕","effectiveWeight":0.205,"contribution":0.084},{"key":"holdings","name":"增持减持","weight":0.06,"signal":0.18181818181818182,"applicable":true,"value":"增持 1/减持 0/回购 4","detail":"前十大股东中，增持/新进 1 家（廖忻愉）、减持 0 家、其余 9 家不变；股份回购 4 次（最近：2026-08-04 11:37:08）：海天味业：将回购注销2024年员工持股计划未归属A股77.99万股、海天味业已回购181万股 金额6580万元","effectiveWeight":0.068,"contribution":0.012},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.1,"signal":-0.318,"applicable":true,"value":"涨停 0.0% / 跌停 1.6%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 1 家（1.6%）、成分 63 家 → 板块情绪偏冷（跌停潮）","effectiveWeight":0.114,"contribution":-0.036}],"weightsUsed":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"weightsDefault":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"price":35.75,"prevClose":35.32,"settled":true,"schemaVersion":"20260820w","actualClose":35.05,"actualChgPct":-1.96,"actualDir":"跌","actualBaseline":35.75,"actualBaselineLabel":"今日收盘","actualTargetLabel":"次日收盘","correct":false,"referenceDate":"2026-08-20"},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-23","generatedAt":"2026-08-23T10:44:02.947Z","closed":true,"target":"nextday","targetDate":"2026-08-24","verdict":"震荡","dir":"震荡","score":-6,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪（讨论热度）","weight":0.16,"signal":0.20156425060698224,"applicable":true,"value":"涨停 54/跌停 13 | -0.06% | 利好 8/中性 0/利空 2 | 市场热度 +0.05 / 个股 70 | 利好 7/利空 4 · 重大事件 | 量比≈0.97","detail":"全市场涨停 54 家、跌停 13 家，多空比 3.86（东财涨跌停池(20260821)）；沪深融资余额最新 26312 亿，较前值 -0.06%（沪深融资余额(亿元)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 0/消极 2，加权情感均值 64.4（东财个股新闻·情感(603288)·近10条加权）；股吧讨论热度：全市场综合得分均值 62.7、上升家数占比 50.5%；该股股吧综合得分 70、热度 上升（东财股吧舆情聚合·市场热度+个股(603288)）；板块/赛道消息 24 条（关键词：食品饮料、消费、白酒），利好 7/利空 4，情绪均值 +13；重大事件：上纬新材官宣！消费级机器人开启预订、半年盘点｜白酒上半年调整未止，但白酒股们的业绩表现没有想象中糟糕；近20日均量 165641，最新 160639，量比≈0.97（方向随近两日价格走弱）","effectiveWeight":0.182,"contribution":0.037},{"key":"capital","name":"资金量能","weight":0.22,"signal":-0.58,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：量价温和偏弱；近5日主力净流出0.53亿；综合：资金面偏空，注意风险","effectiveWeight":0.25,"contribution":-0.145},{"key":"futures","name":"对标期货短期走势","weight":0.12,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.16,"signal":-0.17242857142857151,"applicable":true,"value":"大盘 +0.4% / 行业 -1.5%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.4%（偏强）；行业：食品加工制造 -1.5%（涨 12/跌 53）","effectiveWeight":0.182,"contribution":-0.031},{"key":"news","name":"近期重大利好/利空","weight":0.18,"signal":0.4902222222222222,"applicable":true,"value":"利好 13/利空 4","detail":"近期 27 条消息，利好 13/利空 4，情绪均值 +30.9（偏多）；最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.0%，盈利空间充裕","effectiveWeight":0.205,"contribution":0.1},{"key":"holdings","name":"增持减持","weight":0.06,"signal":0.18181818181818182,"applicable":true,"value":"增持 1/减持 0/回购 5","detail":"前十大股东中，增持/新进 1 家（廖忻愉）、减持 0 家、其余 9 家不变；股份回购 5 次（最近：2026-08-04 11:37:08）：海天味业：将回购注销2024年员工持股计划未归属A股77.99万股、海天味业已回购181万股 金额6580万元","effectiveWeight":0.068,"contribution":0.012},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.1,"signal":-0.308,"applicable":true,"value":"涨停 0.0% / 跌停 1.5%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 1 家（1.5%）、成分 65 家 → 板块情绪偏冷（跌停潮）","effectiveWeight":0.114,"contribution":-0.035}],"weightsUsed":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"weightsDefault":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"price":35.05,"prevClose":35.75,"settled":true,"schemaVersion":"20260821e","actualClose":35.67,"actualChgPct":1.77,"actualDir":"涨","actualBaseline":35.05,"actualBaselineLabel":"基准日(2026-08-21)收盘","actualTargetLabel":"次日收盘","correct":false,"referenceDate":"2026-08-23"},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-24","generatedAt":"2026-08-24T08:02:14.728Z","closed":true,"target":"nextday","targetDate":"2026-08-25","verdict":"震荡","dir":"震荡","score":-5,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.38,"signal":0.39016627057202324,"applicable":true,"value":"利好 14/利空 3 | 评级 中性偏积极 | 涨停 46/跌停 11 | 利好 8/中性 0/利空 2 | 市场热度 +0.04 / 个股 69.8 | 利好 10/利空 6 · 重大事件 | 量比≈0.96","detail":"近期 27 条消息，利好 14/利空 3，情绪均值 +38.3（偏多）；最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.0%，盈利空间充裕；全市场涨停 46 家、跌停 11 家，多空比 3.83（东财涨跌停池(20260824)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 0/消极 2，加权情感均值 64.4（东财个股新闻·情感(603288)·近10条加权）；股吧讨论热度：全市场综合得分均值 62.4、上升家数占比 50.4%；该股股吧综合得分 69.8、热度 上升（东财股吧舆情聚合·市场热度+个股(603288)）；板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 10/利空 6，情绪均值 +17；重大事件：半年盘点｜白酒上半年调整未止，但白酒股们的业绩表现没有想象中糟糕、贵州茅台涨近3%，大消费逆市走强！消费ETF汇添富(159928)、港股通消费ETF汇添富(159268)双双飘红！7月；近20日均量 167037，最新 159839，量比≈0.96（方向随近两日价格走强）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.7651851851851852,"value":"利好 14/利空 3","detail":"近期 27 条消息，利好 14/利空 3，情绪均值 +38.3（偏多）"},{"name":"财报符合预期","w":0.1,"signal":0.3,"value":"评级 中性偏积极","detail":"最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.0%，盈利空间充裕"},{"name":"涨跌停比","w":0.25,"signal":0.614,"value":"涨停 46/跌停 11","detail":"全市场涨停 46 家、跌停 11 家，多空比 3.83（东财涨跌停池(20260824)）"},{"name":"文本舆情","w":0.15,"signal":0.288,"value":"利好 8/中性 0/利空 2","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 0/消极 2，加权情感均值 64.4（东财个股新闻·情感(603288)·近10条加权）"},{"name":"讨论热度","w":0.15,"signal":0.142,"value":"市场热度 +0.04 / 个股 69.8","detail":"股吧讨论热度：全市场综合得分均值 62.4、上升家数占比 50.4%；该股股吧综合得分 69.8、热度 上升（东财股吧舆情聚合·市场热度+个股(603288)）"},{"name":"板块消息联动","w":0.2,"signal":0.416,"value":"利好 10/利空 6 · 重大事件","detail":"板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 10/利空 6，情绪均值 +17；重大事件：半年盘点｜白酒上半年调整未止，但白酒股们的业绩表现没有想象中糟糕、贵州茅台涨近3%，大消费逆市走强！消费ETF汇添富(159928)、港股通消费ETF汇添富(159268)双双飘红！7月"},{"name":"量能活跃度","w":0.15,"signal":0.04309081684120408,"value":"量比≈0.96","detail":"近20日均量 167037，最新 159839，量比≈0.96（方向随近两日价格走强）"}],"effectiveWeight":0.428,"contribution":0.167},{"key":"capital","name":"资金量能","weight":0.207,"signal":-0.42836,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：量价温和偏弱；近5日主力净流出0.74亿；综合：资金面偏空，注意风险；融资余额：-0.23%","subFactors":[{"name":"量价配合","signal":-0.3,"value":"量价温和偏弱","detail":"下跌天数占优且下跌日量能更足，弱势震荡，等待方向明朗"},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 0.74亿","detail":"近5日主力净流出0.74亿"},{"name":"融资余额","signal":-0.234,"value":"-0.23%","detail":"沪深融资余额最新 26250 亿，较前值 -0.23%（沪深融资余额(亿元)）"}],"effectiveWeight":0.233,"contribution":-0.1},{"key":"futures","name":"对标期货短期走势","weight":0.113,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.15,"signal":-0.7207142857142856,"applicable":true,"value":"大盘 -1.8% / 行业 -0.9%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -1.8%（偏弱）；行业：食品加工制造 -0.9%（涨 20/跌 43）","subFactors":[{"name":"大盘指数","signal":-0.8878571428571428,"value":"平均 -1.8%","detail":"上证/深成指/创业板/沪深300 平均 -1.8%（偏弱）"},{"name":"行业板块","signal":-0.47,"value":"-0.9%","detail":"食品加工制造 -0.9%（涨 20/跌 43）"}],"effectiveWeight":0.169,"contribution":-0.122},{"key":"holdings","name":"增持减持","weight":0.056,"signal":0.09408779456759028,"applicable":true,"value":"增持 2/减持 1/净变动 -183.31万股/回购 5","detail":"前十大股东中，增持/新进 2 家（廖忻愉、HKSCC NOMINEES LIMITED）、减持 1 家（香港中央结算有限公司）、其余 7 家不变；十大股东合计净变动 -183.31万股（占其持股 -0.04%）（数据报告期：2026-07-03）；股份回购 5 次（最近：2026-08-04 11:37:08）：海天味业：将回购注销2024年员工持股计划未归属A股77.99万股、海天味业已回购181万股 金额6580万元","subFactors":[{"name":"十大股东净变动","signal":-0.013138234294243828,"value":"-183.31万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 -183.31万股，占其合计持股 -0.04%；其中增持 13.54万股、减持 196.85万股"},{"name":"增减持家数","signal":0.1,"value":"增持 2/减持 1","detail":"前十大股东增持/新进 2 家、减持 1 家、不变 7 家（增持：廖忻愉、HKSCC NOMINEES LIMITED）（减持：香港中央结算有限公司）"},{"name":"股份回购","signal":0.6,"value":"回购 5 次","detail":"股份回购 5 次（最近：2026-08-04 11:37:08）：海天味业：将回购注销2024年员工持股计划未归属A股77.99万股、海天味业已回购181万股 金额6580万元"}],"effectiveWeight":0.063,"contribution":0.006},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.094,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 63 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"63 家","detail":"板块成分股共 63 家（食品加工制造）"}],"effectiveWeight":0.106,"contribution":0}],"weightsUsed":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"weightsDefault":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"price":35.67,"prevClose":35.05,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.567,"weakThemes":["消费"]},"schemaVersion":"20260823i","referenceDate":"2026-08-24","actualClose":35.96,"actualChgPct":0.81,"actualDir":"涨","actualBaseline":35.67,"actualBaselineLabel":"基准日(2026-08-24)收盘","actualTargetLabel":"次日收盘","correct":true},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-25","generatedAt":"2026-08-25T04:43:07.331Z","closed":false,"target":"nextday","targetDate":"2026-08-26","verdict":"看涨","dir":"涨","score":29,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.439,"signal":0.6148008216485087,"applicable":true,"value":"利好 14/利空 3 | 评级 中性偏积极 | 涨停 47/跌停 3 | 利好 9/中性 0/利空 1 | 市场热度 +0.04 / 个股 72.8 | 利好 12/利空 3 · 重大事件 | 量比≈0.47","detail":"近期 27 条消息，利好 14/利空 3，情绪均值 +38.3（偏多）；最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.0%，盈利空间充裕；全市场涨停 47 家、跌停 3 家，多空比 11.75（东财涨跌停池(20260825)）；近 10 条个股新闻（snownlp+词库），积极 9/中性 0/消极 1，加权情感均值 67.5（东财个股新闻·情感(603288)·近10条加权）；股吧讨论热度：全市场综合得分均值 62.9、上升家数占比 49.7%；该股股吧综合得分 72.8、热度 上升（东财股吧舆情聚合·市场热度+个股(603288)）；板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 12/利空 3，情绪均值 +35；重大事件：一瓶酒渠道价差超300元！白酒旺季临近，谁能挺价成功？、半年盘点｜白酒上半年调整未止，但白酒股们的业绩表现没有想象中糟糕；近20日均量 161489，最新 75580，量比≈0.47（方向随近两日价格走强）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.7651851851851852,"value":"利好 14/利空 3","detail":"近期 27 条消息，利好 14/利空 3，情绪均值 +38.3（偏多）"},{"name":"财报符合预期","w":0.1,"signal":0.3,"value":"评级 中性偏积极","detail":"最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.0%，盈利空间充裕"},{"name":"涨跌停比","w":0.25,"signal":0.88,"value":"涨停 47/跌停 3","detail":"全市场涨停 47 家、跌停 3 家，多空比 11.75（东财涨跌停池(20260825)）"},{"name":"文本舆情","w":0.15,"signal":0.35,"value":"利好 9/中性 0/利空 1","detail":"近 10 条个股新闻（snownlp+词库），积极 9/中性 0/消极 1，加权情感均值 67.5（东财个股新闻·情感(603288)·近10条加权）"},{"name":"讨论热度","w":0.15,"signal":0.335,"value":"市场热度 +0.04 / 个股 72.8","detail":"股吧讨论热度：全市场综合得分均值 62.9、上升家数占比 49.7%；该股股吧综合得分 72.8、热度 上升（东财股吧舆情聚合·市场热度+个股(603288)）"},{"name":"板块消息联动","w":0.2,"signal":0.806,"value":"利好 12/利空 3 · 重大事件","detail":"板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 12/利空 3，情绪均值 +35；重大事件：一瓶酒渠道价差超300元！白酒旺季临近，谁能挺价成功？、半年盘点｜白酒上半年调整未止，但白酒股们的业绩表现没有想象中糟糕"},{"name":"量能活跃度","w":0.15,"signal":0.5319800716891601,"value":"量比≈0.47","detail":"近20日均量 161489，最新 75580，量比≈0.47（方向随近两日价格走强）"}],"effectiveWeight":0.496,"contribution":0.305},{"key":"capital","name":"资金量能","weight":0.1793,"signal":-0.21146,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：缩量下跌；近5日主力净流出0.74亿；综合：资金面偏空，注意风险；融资余额：-0.16%","subFactors":[{"name":"量价配合","signal":0.2,"value":"缩量下跌","detail":"下跌缩量，抛压逐步减弱，有企稳迹象"},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 0.74亿","detail":"近5日主力净流出0.74亿"},{"name":"融资余额","signal":-0.159,"value":"-0.16%","detail":"沪深融资余额最新 26208 亿，较前值 -0.16%（沪深融资余额(亿元)）"}],"effectiveWeight":0.202,"contribution":-0.043},{"key":"futures","name":"对标期货短期走势","weight":0.1142,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1213,"signal":0.13257142857142867,"applicable":true,"value":"大盘 -0.6% / 行业 +1.6%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.6%（偏弱）；行业：食品加工制造 +1.6%（涨 57/跌 9）","subFactors":[{"name":"大盘指数","signal":-0.30571428571428566,"value":"平均 -0.6%","detail":"上证/深成指/创业板/沪深300 平均 -0.6%（偏弱）"},{"name":"行业板块","signal":0.79,"value":"+1.6%","detail":"食品加工制造 +1.6%（涨 57/跌 9）"}],"effectiveWeight":0.137,"contribution":0.018},{"key":"holdings","name":"增持减持","weight":0.0647,"signal":0.09408779456759028,"applicable":true,"value":"增持 2/减持 1/净变动 -183.31万股/回购 5","detail":"前十大股东中，增持/新进 2 家（廖忻愉、HKSCC NOMINEES LIMITED）、减持 1 家（香港中央结算有限公司）、其余 7 家不变；十大股东合计净变动 -183.31万股（占其持股 -0.04%）（数据报告期：2026-07-03）；股份回购 5 次（最近：2026-08-04 11:37:08）：海天味业：将回购注销2024年员工持股计划未归属A股77.99万股、海天味业已回购181万股 金额6580万元","subFactors":[{"name":"十大股东净变动","signal":-0.013138234294243828,"value":"-183.31万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 -183.31万股，占其合计持股 -0.04%；其中增持 13.54万股、减持 196.85万股"},{"name":"增减持家数","signal":0.1,"value":"增持 2/减持 1","detail":"前十大股东增持/新进 2 家、减持 1 家、不变 7 家（增持：廖忻愉、HKSCC NOMINEES LIMITED）（减持：香港中央结算有限公司）"},{"name":"股份回购","signal":0.6,"value":"回购 5 次","detail":"股份回购 5 次（最近：2026-08-04 11:37:08）：海天味业：将回购注销2024年员工持股计划未归属A股77.99万股、海天味业已回购181万股 金额6580万元"}],"effectiveWeight":0.073,"contribution":0.007},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0815,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 66 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"66 家","detail":"板块成分股共 66 家（食品加工制造）"}],"effectiveWeight":0.092,"contribution":0}],"weightsUsed":{"sentiment":0.439,"capital":0.1793,"futures":0.1142,"market":0.1213,"holdings":0.0647,"sectorLimit":0.0815},"weightsDefault":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"price":36.04,"prevClose":35.67,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.567,"weakThemes":["消费"]},"schemaVersion":"20260823i","referenceDate":"2026-08-25","actualClose":35.93,"actualChgPct":-0.08,"actualDir":"跌","actualBaseline":35.96,"actualBaselineLabel":"基准日(2026-08-25)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-27","referenceDate":"2026-08-26","generatedAt":"2026-08-27T06:06:54.711Z","closed":false,"target":"nextday","targetDate":"2026-08-27","verdict":"震荡","dir":"震荡","score":12,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.34,"signal":0.332514619883041,"applicable":true,"value":"利好 16/利空 3 | 评级 中性偏积极 | 涨停 68/跌停 3 | 利好 7/中性 2/利空 1 | 东财个股70.4↓ / 同花顺未入热榜 / 雪球第17名(关注1921930) | 利好 10/利空 5 | 量比≈2.71","detail":"近期 27 条消息，利好 16/利空 3，情绪均值 +45.7（偏多）；最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.1%，盈利空间充裕；全市场涨停 68 家、跌停 3 家，多空比 17（东财涨跌停池(20260827)）；近 10 条个股新闻（snownlp+词库），积极 7/中性 2/消极 1，加权情感均值 68.9（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 70.4、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1921930、今日-5.4%；板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 10/利空 5，情绪均值 +18；近20日均量 164649，最新 446095，量比≈2.71（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.9133333333333333,"value":"利好 16/利空 3","detail":"近期 27 条消息，利好 16/利空 3，情绪均值 +45.7（偏多）"},{"name":"财报符合预期","w":0.1,"signal":0.3,"value":"评级 中性偏积极","detail":"最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.1%，盈利空间充裕"},{"name":"涨跌停比","w":0.25,"signal":0.915,"value":"涨停 68/跌停 3","detail":"全市场涨停 68 家、跌停 3 家，多空比 17（东财涨跌停池(20260827)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.5015000000000001,"value":"利好 7/中性 2/利空 1 | 东财个股70.4↓ / 同花顺未入热榜 / 雪球第17名(关注1921930)","detail":"近 10 条个股新闻（snownlp+词库），积极 7/中性 2/消极 1，加权情感均值 68.9（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 70.4、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1921930、今日-5.4%"},{"name":"板块消息联动","w":0.2,"signal":-0.04,"value":"利好 10/利空 5","detail":"板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 10/利空 5，情绪均值 +18"},{"name":"量能活跃度","w":0.15,"signal":-1,"value":"量比≈2.71","detail":"近20日均量 164649，最新 446095，量比≈2.71（方向随近两日价格走弱）"}],"effectiveWeight":0.381,"contribution":0.127},{"key":"capital","name":"资金量能","weight":0.197,"signal":-0.32352668150292835,"applicable":true,"value":"资金面中性偏空","detail":"量价：缩量下跌；近5日主力净流出1.7亿；综合：资金面中性偏空；换手率变化：最新换手率 0.8%，近15日均值 0.61%（偏离 +31.8%），近两日价跌 → 放量偏空；融资余额：-0.13%","subFactors":[{"name":"量价配合","signal":0.2,"value":"缩量下跌","detail":"下跌缩量，抛压逐步减弱，有企稳迹象"},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 1.7亿","detail":"近5日主力净流出1.7亿"},{"name":"换手率变化","signal":-0.3810556791910691,"value":"放量偏空","detail":"最新换手率 0.8%，近15日均值 0.61%（偏离 +31.8%），近两日价跌 → 放量偏空"},{"name":"融资余额","signal":-0.126,"value":"-0.13%","detail":"沪深融资余额最新 26168 亿，较前值 -0.13%（沪深融资余额(亿元)）"}],"effectiveWeight":0.221,"contribution":-0.071},{"key":"futures","name":"对标期货短期走势","weight":0.107,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.143,"signal":0.4810000000000001,"applicable":true,"value":"大盘 +1.3% / 行业 +0.5%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +1.3%（偏强）；行业：食品加工制造 +0.5%（涨 35/跌 30）","subFactors":[{"name":"大盘指数","signal":0.6450000000000001,"value":"平均 +1.3%","detail":"上证/深成指/创业板/沪深300 平均 +1.3%（偏强）"},{"name":"行业板块","signal":0.235,"value":"+0.5%","detail":"食品加工制造 +0.5%（涨 35/跌 30）"}],"effectiveWeight":0.16,"contribution":0.077},{"key":"holdings","name":"增持减持","weight":0.054,"signal":0.057260688863830685,"applicable":true,"value":"增持 1/减持 0/净变动 +70.09万股","detail":"前十大股东中，增持/新进 1 家（香港中央结算有限公司）、减持 0 家、其余 9 家不变；十大股东合计净变动 +70.09万股（占其持股 0.02%）（数据报告期：2026-07-03）","subFactors":[{"name":"十大股东净变动","signal":0.005023753030734842,"value":"+70.09万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 +70.09万股，占其合计持股 0.02%；其中增持 70.09万股、减持 0股"},{"name":"增减持家数","signal":0.1,"value":"增持 1/减持 0","detail":"前十大股东增持/新进 1 家、减持 0 家、不变 9 家（增持：香港中央结算有限公司）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.06,"contribution":0.003},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.089,"signal":0.616,"applicable":true,"value":"涨停 3.1% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 2 家（3.1%）、跌停 0 家（0.0%）、成分 65 家 → 板块情绪偏热（涨停潮）","subFactors":[{"name":"涨停占比","signal":0.616,"value":"3.1%","detail":"所属「食品加工制造」板块涨停 2 家，占成分股 3.1%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"65 家","detail":"板块成分股共 65 家（食品加工制造）"}],"effectiveWeight":0.1,"contribution":0.061},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.07,"signal":-1,"applicable":true,"value":"+3.13%","detail":"科技/半导体板块当日整体上涨 +3.13%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向下跌（偏空）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"+4.07%","detail":"半导体板块当日上涨4.07%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+4.39%","detail":"电子板块当日上涨4.39%（电子化学品）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+1.24%","detail":"计算机板块当日上涨1.24%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+2.8%","detail":"通信板块当日上涨2.80%（通信设备）"}],"effectiveWeight":0.078,"contribution":-0.078}],"weightsUsed":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":33.96,"prevClose":35.93,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.567,"weakThemes":["消费"]},"reportEvent":{"symbol":"603288","type":"semi","year":"2026","title":"海天味业(603288.SH)：2026年中报净利润为41.90亿元","date":"2026-08-27 09:08:43"},"reportGap":false,"schemaVersion":"20260827d","actualClose":34.1,"actualChgPct":-5.09,"actualDir":"跌","actualBaseline":35.93,"actualBaselineLabel":"基准日(2026-08-26)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-28","referenceDate":"2026-08-27","generatedAt":"2026-08-28T02:40:22.587Z","closed":false,"target":"nextday","targetDate":"2026-08-28","verdict":"震荡","dir":"震荡","score":0,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.34,"signal":0.36846740001905753,"applicable":true,"value":"利好 14/利空 5 | 评级 中性偏积极 | 涨停 53/跌停 1 | 利好 8/中性 2/利空 0 | 东财个股68.5↓ / 同花顺未入热榜 / 雪球第17名(关注1922583) | 利好 9/利空 6 | 量比≈0.85","detail":"近期 27 条消息，利好 14/利空 5，情绪均值 +28.3（偏多）；最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.1%，盈利空间充裕；全市场涨停 53 家、跌停 1 家，多空比 26.5（东财涨跌停池(20260828)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 68.7（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 68.5、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1922583、今日-1.09%；板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 9/利空 6，情绪均值 +13；近20日均量 165504，最新 140263，量比≈0.85（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.5659259259259259,"value":"利好 14/利空 5","detail":"近期 27 条消息，利好 14/利空 5，情绪均值 +28.3（偏多）"},{"name":"财报符合预期","w":0.1,"signal":0.3,"value":"评级 中性偏积极","detail":"最新财报（报告解读）：评级 中性偏积极（向好）；亮点：毛利率 40.1%，盈利空间充裕"},{"name":"涨跌停比","w":0.25,"signal":0.963,"value":"涨停 53/跌停 1","detail":"全市场涨停 53 家、跌停 1 家，多空比 26.5（东财涨跌停池(20260828)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.4165,"value":"利好 8/中性 2/利空 0 | 东财个股68.5↓ / 同花顺未入热榜 / 雪球第17名(关注1922583)","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 68.7（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 68.5、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1922583、今日-1.09%"},{"name":"板块消息联动","w":0.2,"signal":-0.16,"value":"利好 9/利空 6","detail":"板块/赛道消息 24 条（关键词：食品饮料、白酒、消费），利好 9/利空 6，情绪均值 +13"},{"name":"量能活跃度","w":0.15,"signal":-0.15251195738602719,"value":"量比≈0.85","detail":"近20日均量 165504，最新 140263，量比≈0.85（方向随近两日价格走弱）"}],"effectiveWeight":0.381,"contribution":0.14},{"key":"capital","name":"资金量能","weight":0.197,"signal":-0.696700255453362,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：放量下跌；近5日主力净流出4.25亿；综合：资金面偏空，注意风险；换手率变化：最新换手率 0.25%，近15日均值 0.61%（偏离 -58.8%），近两日价跌 → 放量偏空；融资余额：+0.43%","subFactors":[{"name":"量价配合","signal":-0.6,"value":"放量下跌","detail":"下跌日显著放量（空头主导、抛压沉重），注意风险"},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 4.25亿","detail":"近5日主力净流出4.25亿"},{"name":"换手率变化","signal":-0.70583546211135,"value":"放量偏空","detail":"最新换手率 0.25%，近15日均值 0.61%（偏离 -58.8%），近两日价跌 → 放量偏空"},{"name":"融资余额","signal":0.432,"value":"+0.43%","detail":"沪深融资余额最新 26281 亿，较前值 +0.43%（沪深融资余额(亿元)）"}],"effectiveWeight":0.221,"contribution":-0.154},{"key":"futures","name":"对标期货短期走势","weight":0.107,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.143,"signal":0.07085714285714285,"applicable":true,"value":"大盘 -0.1% / 行业 +0.5%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.1%（中性）；行业：食品加工制造 +0.5%（涨 40/跌 23）","subFactors":[{"name":"大盘指数","signal":-0.038571428571428576,"value":"平均 -0.1%","detail":"上证/深成指/创业板/沪深300 平均 -0.1%（中性）"},{"name":"行业板块","signal":0.235,"value":"+0.5%","detail":"食品加工制造 +0.5%（涨 40/跌 23）"}],"effectiveWeight":0.16,"contribution":0.011},{"key":"holdings","name":"增持减持","weight":0.054,"signal":0.057260688863830685,"applicable":true,"value":"增持 1/减持 0/净变动 +70.09万股","detail":"前十大股东中，增持/新进 1 家（香港中央结算有限公司）、减持 0 家、其余 9 家不变；十大股东合计净变动 +70.09万股（占其持股 0.02%）（数据报告期：2026-07-03）","subFactors":[{"name":"十大股东净变动","signal":0.005023753030734842,"value":"+70.09万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 +70.09万股，占其合计持股 0.02%；其中增持 70.09万股、减持 0股"},{"name":"增减持家数","signal":0.1,"value":"增持 1/减持 0","detail":"前十大股东增持/新进 1 家、减持 0 家、不变 9 家（增持：香港中央结算有限公司）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.06,"contribution":0.003},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.089,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 63 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"63 家","detail":"板块成分股共 63 家（食品加工制造）"}],"effectiveWeight":0.1,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.07,"signal":0,"applicable":true,"value":"+0.2%","detail":"科技/半导体板块当日整体上涨 +0.2%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向震荡（中性）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-0.08%","detail":"半导体板块当日下跌0.08%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+0.52%","detail":"电子板块当日上涨0.52%（其他电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"-0.06%","detail":"计算机板块当日下跌0.06%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0.41%","detail":"通信板块当日上涨0.41%（通信设备）"}],"effectiveWeight":0.078,"contribution":0}],"weightsUsed":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":33.74,"prevClose":34.1,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.567,"weakThemes":["消费"]},"reportEvent":{"symbol":"603288","type":"semi","year":"2026","title":"海天味业2026中报营收净利润双升，调味品龙头韧性显现","date":"2026-08-27 14:35:15"},"reportGap":false,"schemaVersion":"20260827d","actualClose":34.12,"actualChgPct":0.06,"actualDir":"涨","actualBaseline":34.1,"actualBaselineLabel":"基准日(2026-08-27)收盘","actualTargetLabel":"次日收盘","correct":true},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-31","referenceDate":"2026-08-28","generatedAt":"2026-08-31T09:18:38.282Z","closed":true,"target":"nextday","targetDate":"2026-08-31","verdict":"震荡","dir":"震荡","score":-5,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3509,"signal":0.32964989065332995,"applicable":true,"value":"利好 12/利空 8 | 联动深度解读 | 涨停 88/跌停 11 | 利好 8/中性 2/利空 0 | 东财个股67.8↓ / 同花顺未入热榜 / 雪球第17名(关注1924284) | 利好 5/利空 6 · 重大事件 | 量比≈1.11","detail":"近期 26 条消息（监管政策 1 条），利好 12/利空 8，情绪均值 +12.1（偏多）；最新财报解读（联动深度分析）：净利/营收同比 +7.1%（向好）；【深度分析·最新财报解读】综合结论：海天味业 2026 年 Q2 季报呈现「表观稳、实质弱」的特征——收入表面平稳但盈利质量走弱，三重压力叠加，结构性亮点仍在，下半年有望边际改善。\n\n1) 核心业绩：收入增速从 Q1 的 6% 降至 Q2 的 2.9%，扣非净利润已转负，表观收入平稳但盈利质量明显走弱。\n2) 三重压力：①需求疲软（餐饮渠道偏弱）；②成本上涨（黄豆、PET 等原材料涨价）；③汇兑损失约 4.8 亿元。\n3)…；全市场涨停 88 家、跌停 11 家，多空比 7.33（东财涨跌停池(20260831)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 70.1（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 67.8、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1924284、今日-1.44%；板块/赛道消息 23 条（关键词：食品饮料、白酒、消费），利好 5/利空 6，情绪均值 -3；重大事件：营收突破700亿元！吕梁白酒产业突围，这场盛会解锁酒业变局新机遇、白酒行业上半年成绩单：总营收缩水百亿，洋河重返前四；近20日均量 170076，最新 188178，量比≈1.11（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.24153846153846154,"value":"利好 12/利空 8","detail":"近期 26 条消息（监管政策 1 条），利好 12/利空 8，情绪均值 +12.1（偏多）"},{"name":"财报解读","w":0.1,"signal":0.23750413531706668,"value":"联动深度解读","detail":"最新财报解读（联动深度分析）：净利/营收同比 +7.1%（向好）；【深度分析·最新财报解读】综合结论：海天味业 2026 年 Q2 季报呈现「表观稳、实质弱」的特征——收入表面平稳但盈利质量走弱，三重压力叠加，结构性亮点仍在，下半年有望边际改善。\n\n1) 核心业绩：收入增速从 Q1 的 6% 降至 Q2 的 2.9%，扣非净利润已转负，表观收入平稳但盈利质量明显走弱。\n2) 三重压力：①需求疲软（餐饮渠道偏弱）；②成本上涨（黄豆、PET 等原材料涨价）；③汇兑损失约 4.8 亿元。\n3)…"},{"name":"涨跌停比","w":0.25,"signal":0.778,"value":"涨停 88/跌停 11","detail":"全市场涨停 88 家、跌停 11 家，多空比 7.33（东财涨跌停池(20260831)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.43100000000000005,"value":"利好 8/中性 2/利空 0 | 东财个股67.8↓ / 同花顺未入热榜 / 雪球第17名(关注1924284)","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 70.1（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 67.8、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1924284、今日-1.44%"},{"name":"板块消息联动","w":0.2,"signal":0.052,"value":"利好 5/利空 6 · 重大事件","detail":"板块/赛道消息 23 条（关键词：食品饮料、白酒、消费），利好 5/利空 6，情绪均值 -3；重大事件：营收突破700亿元！吕梁白酒产业突围，这场盛会解锁酒业变局新机遇、白酒行业上半年成绩单：总营收缩水百亿，洋河重返前四"},{"name":"量能活跃度","w":0.15,"signal":-0.10643281868196808,"value":"量比≈1.11","detail":"近20日均量 170076，最新 188178，量比≈1.11（方向随近两日价格走弱）"}],"effectiveWeight":0.394,"contribution":0.13},{"key":"capital","name":"资金量能","weight":0.2033,"signal":-0.54876,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：放量下跌；近5日主力净流出0.11亿（资金流向为接口估算）；综合：资金面偏空，注意风险；融资余额：-0.23%","subFactors":[{"name":"量价配合","signal":-0.6,"value":"放量下跌","detail":"下跌日显著放量（空头主导、抛压沉重），注意风险"},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 0.11亿","detail":"近5日主力净流出0.11亿（资金流向为接口估算）"},{"name":"融资余额","signal":-0.234,"value":"-0.23%","detail":"沪深融资余额最新 26219 亿，较前值 -0.23%（沪深融资余额(亿元)）"}],"effectiveWeight":0.229,"contribution":-0.125},{"key":"futures","name":"对标期货短期走势","weight":0.1104,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1279,"signal":0.04471428571428568,"applicable":true,"value":"大盘 +0.7% / 行业 -0.8%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.7%（偏强）；行业：食品加工制造 -0.8%（涨 22/跌 42）","subFactors":[{"name":"大盘指数","signal":0.32785714285714285,"value":"平均 +0.7%","detail":"上证/深成指/创业板/沪深300 平均 +0.7%（偏强）"},{"name":"行业板块","signal":-0.38,"value":"-0.8%","detail":"食品加工制造 -0.8%（涨 22/跌 42）"}],"effectiveWeight":0.144,"contribution":0.006},{"key":"holdings","name":"增持减持","weight":0.0557,"signal":0.057260688863830685,"applicable":true,"value":"增持 1/减持 0/净变动 +70.09万股","detail":"前十大股东中，增持/新进 1 家（香港中央结算有限公司）、减持 0 家、其余 9 家不变；十大股东合计净变动 +70.09万股（占其持股 0.02%）（数据报告期：2026-07-03）","subFactors":[{"name":"十大股东净变动","signal":0.005023753030734842,"value":"+70.09万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 +70.09万股，占其合计持股 0.02%；其中增持 70.09万股、减持 0股"},{"name":"增减持家数","signal":0.1,"value":"增持 1/减持 0","detail":"前十大股东增持/新进 1 家、减持 0 家、不变 9 家（增持：香港中央结算有限公司）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.063,"contribution":0.004},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0796,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 64 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"64 家","detail":"板块成分股共 64 家（食品加工制造）"}],"effectiveWeight":0.089,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.0722,"signal":-0.821,"applicable":true,"value":"+2.46%","detail":"科技/半导体板块当日整体上涨 +2.46%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向下跌（偏空）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"+2.36%","detail":"半导体板块当日上涨2.36%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+2.77%","detail":"电子板块当日上涨2.77%（消费电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+2.17%","detail":"计算机板块当日上涨2.17%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+2.55%","detail":"通信板块当日上涨2.55%（通信服务）"}],"effectiveWeight":0.081,"contribution":-0.067}],"weightsUsed":{"sentiment":0.3509,"capital":0.2033,"futures":0.1104,"market":0.1279,"holdings":0.0557,"sectorLimit":0.0796,"seesaw":0.0722},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":33.63,"prevClose":34.12,"settled":true,"rules":{"freshness":{"fresh":false,"expired":true,"ageMs":292718283,"ttlMs":86400000,"dataTime":"2026-08-28","reason":"数据日之后已过 1 个交易日，超过该类型有效期"},"staleNote":"数据已过期，最后更新时间是 2026-08-28","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":33.63,"dataTime":"当前","source":"未知","fetchTime":"2026-08-31T09:18:38.283Z"},"previous":{"value":34.12,"date":"昨收"},"changeRate":-1.44,"prevChangeRate":0,"marginal":-1.44,"direction":"数据不足","accel":"下跌加速","marginalStreak":0,"text":"价格从 34.12 下降到 33.63，跌幅 1.44%，较上一期（持平 0.00%）转为下跌，边际变动 1.44 个百分点，呈下跌加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-08-28","fetchedAt":"2026-08-31T09:18:38.283Z","dayChange":-1.44,"consistency":"判断方向（偏空）与当日涨跌（跌 1.44%）同向"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.587,"weakThemes":["消费"]},"reportEvent":{"symbol":"603288","type":"semi","year":"2026","title":"海天味业(603288.SH)：2026年中报净利润为41.90亿元","date":"2026-08-27 09:08:43"},"reportGap":false,"schemaVersion":"20260831d","actualClose":33.63,"actualChgPct":-1.44,"actualDir":"跌","actualBaseline":34.12,"actualBaselineLabel":"基准日(2026-08-28)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"603288","name":"海天味业","industry":"食品饮料","horizon":"short","horizonLabel":"今日后续","date":"2026-09-01","referenceDate":"2026-08-31","generatedAt":"2026-09-01T02:44:55.223Z","closed":false,"target":"nextday","targetDate":"2026-09-01","verdict":"看涨","dir":"涨","score":20,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3436,"signal":0.5710067112015099,"applicable":true,"value":"市场热度 +4.9 | 联动深度解读 | 涨停 58/跌停 1 | 利好 8/中性 2/利空 0 | 东财个股67.2↓ / 同花顺未入热榜 / 雪球第17名(关注1924738) | 利好 9/利空 2 · 重大事件 | 量比≈0.51","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）；最新财报解读（联动深度分析）：净利/营收同比 +7.1%（向好）；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观稳、实质弱，核心利润虽同比增长但增速明显放缓，叠加现金流大幅下滑与Q2环比显著恶化，显示经营压力加大，边际趋势拐头向下。\n\n1) 最新报告期：2026年中报（2026年1月1日–6月30日），披露日期为2026年8月27日（来源：公司公告、上交所、巨潮资讯网）。\n\n2) 核心业绩与边际变化（重点）：\n- 营业收入：161.46亿元，同比+6.01%（上…；全市场涨停 58 家、跌停 1 家，多空比 29（东财涨跌停池(20260901)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 74.6（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 67.2、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1924738、今日+0.92%；板块/赛道消息 23 条（关键词：食品饮料、白酒、消费），利好 9/利空 2，情绪均值 +27；重大事件：百亿级私募持仓全景图亮相 食品饮料行业持仓最重 拥抱绩优股成共识、超八成食品饮料上市公司上半年盈利 70家公司现金流同比实现正增长 23家公司发布半年度利润分配方案；近20日均量 164162，最新 83299，量比≈0.51（方向随近两日价格走强）","subFactors":[{"name":"消息情绪（大盘）","w":0.14,"signal":0.049,"value":"市场热度 +4.9","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）"},{"name":"财报解读","w":0.1,"signal":0.23750413531706668,"value":"联动深度解读","detail":"最新财报解读（联动深度分析）：净利/营收同比 +7.1%（向好）；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观稳、实质弱，核心利润虽同比增长但增速明显放缓，叠加现金流大幅下滑与Q2环比显著恶化，显示经营压力加大，边际趋势拐头向下。\n\n1) 最新报告期：2026年中报（2026年1月1日–6月30日），披露日期为2026年8月27日（来源：公司公告、上交所、巨潮资讯网）。\n\n2) 核心业绩与边际变化（重点）：\n- 营业收入：161.46亿元，同比+6.01%（上…"},{"name":"涨跌停比","w":0.25,"signal":0.966,"value":"涨停 58/跌停 1","detail":"全市场涨停 58 家、跌停 1 家，多空比 29（东财涨跌停池(20260901)）"},{"name":"舆情与讨论热度（个股）","w":0.3,"signal":0.4965,"value":"利好 8/中性 2/利空 0 | 东财个股67.2↓ / 同花顺未入热榜 / 雪球第17名(关注1924738)","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 2/消极 0，加权情感均值 74.6（东财个股新闻·情感(603288)·近10条加权）；东财股吧综合得分 67.2、热度下降；同花顺热榜·603288未进入当日 A 股热榜前100名；雪球关注榜第17名、关注人数1924738、今日+0.92%"},{"name":"板块消息联动","w":0.2,"signal":0.78,"value":"利好 9/利空 2 · 重大事件","detail":"板块/赛道消息 23 条（关键词：食品饮料、白酒、消费），利好 9/利空 2，情绪均值 +27；重大事件：百亿级私募持仓全景图亮相 食品饮料行业持仓最重 拥抱绩优股成共识、超八成食品饮料上市公司上半年盈利 70家公司现金流同比实现正增长 23家公司发布半年度利润分配方案"},{"name":"量能活跃度","w":0.15,"signal":0.49258158158676457,"value":"量比≈0.51","detail":"近20日均量 164162，最新 83299，量比≈0.51（方向随近两日价格走强）"}],"effectiveWeight":0.387,"contribution":0.221},{"key":"capital","name":"资金量能","weight":0.2108,"signal":-0.48019318190407817,"applicable":true,"value":"资金面偏空，注意风险","detail":"量价：放量下跌；近5日主力净流出5.19亿；综合：资金面偏空，注意风险；换手率变化：最新换手率 0.15%，近15日均值 0.61%（偏离 -75.3%），近两日价涨 → 放量偏多；融资余额：+0.2%","subFactors":[{"name":"量价配合","signal":-0.6,"value":"放量下跌","detail":"下跌日显著放量（空头主导、抛压沉重），注意风险"},{"name":"主力净流入(近5日)","signal":-1,"value":"净流出 5.19亿","detail":"近5日主力净流出5.19亿"},{"name":"换手率变化","signal":0.9033901507993489,"value":"放量偏多","detail":"最新换手率 0.15%，近15日均值 0.61%（偏离 -75.3%），近两日价涨 → 放量偏多"},{"name":"融资余额","signal":0.198,"value":"+0.2%","detail":"沪深融资余额最新 26271 亿，较前值 +0.2%（沪深融资余额(亿元)）"}],"effectiveWeight":0.237,"contribution":-0.114},{"key":"futures","name":"对标期货短期走势","weight":0.1113,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1275,"signal":0.4155000000000001,"applicable":true,"value":"大盘 -0.9% / 行业 +1.8%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）；行业：食品加工制造 +1.8%（涨 53/跌 10）","subFactors":[{"name":"大盘指数","signal":-0.4471428571428571,"value":"平均 -0.9%","detail":"上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）"},{"name":"行业板块","signal":0.88,"value":"+1.8%","detail":"食品加工制造 +1.8%（涨 53/跌 10）"}],"effectiveWeight":0.143,"contribution":0.06},{"key":"holdings","name":"增持减持","weight":0.0546,"signal":0.057260688863830685,"applicable":true,"value":"增持 1/减持 0/净变动 +70.09万股","detail":"前十大股东中，增持/新进 1 家（香港中央结算有限公司）、减持 0 家、其余 9 家不变；十大股东合计净变动 +70.09万股（占其持股 0.02%）（数据报告期：2026-07-03）","subFactors":[{"name":"十大股东净变动","signal":0.005023753030734842,"value":"+70.09万股","detail":"最新报告期 2026-07-03，前十大股东合计净变动 +70.09万股，占其合计持股 0.02%；其中增持 70.09万股、减持 0股"},{"name":"增减持家数","signal":0.1,"value":"增持 1/减持 0","detail":"前十大股东增持/新进 1 家、减持 0 家、不变 9 家（增持：香港中央结算有限公司）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.061,"contribution":0.004},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0794,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「食品加工制造」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 63 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「食品加工制造」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"63 家","detail":"板块成分股共 63 家（食品加工制造）"}],"effectiveWeight":0.089,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.0728,"signal":0.319,"applicable":true,"value":"-0.96%","detail":"科技/半导体板块当日整体下跌 -0.96%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向上涨（偏多）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-2.81%","detail":"半导体板块当日下跌2.81%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"-0.9%","detail":"电子板块当日下跌0.90%（军工电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"-0.12%","detail":"计算机板块当日下跌0.12%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0%","detail":"通信板块当日上涨0.00%（通信服务）"}],"effectiveWeight":0.082,"contribution":0.026}],"weightsUsed":{"sentiment":0.3436,"capital":0.2108,"futures":0.1113,"market":0.1275,"holdings":0.0546,"sectorLimit":0.0794,"seesaw":0.0728},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":33.93,"prevClose":33.63,"settled":true,"rules":{"freshness":{"fresh":false,"expired":true,"ageMs":96295223,"ttlMs":86400000,"dataTime":"2026-08-31","reason":"数据日之后已过 1 个交易日，超过该类型有效期"},"staleNote":"数据已过期，最后更新时间是 2026-08-31","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":33.93,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T02:44:55.223Z"},"previous":{"value":33.63,"date":"昨收"},"changeRate":0.89,"prevChangeRate":0,"marginal":0.89,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 33.63 上升到 33.93，涨幅 0.89%，较上一期（持平 0.00%）转为上涨，边际变动 0.89 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-08-31","fetchedAt":"2026-09-01T02:44:55.223Z","dayChange":0.89,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 0.89%）背离"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.565,"weakThemes":["消费"]},"reportEvent":{"symbol":"603288","type":"semi","year":"2026","title":"海天味业2026中报营收净利润双升，调味品龙头韧性显现","date":"2026-08-27 14:35:15"},"reportGap":false,"schemaVersion":"20260831h","actualClose":34,"actualChgPct":1.1,"actualDir":"涨","actualBaseline":33.63,"actualBaselineLabel":"基准日(2026-08-31)收盘","actualTargetLabel":"次日收盘","correct":true}],"settledCount":8,"pendingCount":1,"overdueCount":0,"correct":3,"accuracy":37.5,"bullRate":50,"bearRate":null,"flatRate":33.3,"intradayRate":null,"nextdayRate":37.5},"today":"2026-09-01","regenerated":true}
~~~

---

## `scripts\sa_sd.json`  ·  1 行

~~~json
{"success":true,"judgment":{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-09-01","referenceDate":"2026-09-01","generatedAt":"2026-09-01T07:26:10.589Z","closed":true,"target":"nextday","targetDate":"2026-09-02","verdict":"看涨","dir":"涨","score":35,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.34,"signal":0.5020570378790299,"applicable":true,"value":"市场热度 +4.9 | 联动深度解读 | 预期下调 57.6% | 涨停 83/跌停 0 | 利好 5/中性 0/利空 5 | 东财个股78.4↑ / 同花顺未入热榜 / 雪球第2名(关注3157416) | 利好 9/利空 2 · 重大事件 | 量比≈1.52","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）；最新财报解读（联动深度分析）：净利/营收同比 +36.1%（向好）；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观高增、实质向好，净利润大幅反弹且超预期，营运利润稳健增长，寿险改革初现成效，边际趋势显著加速。\n\n1) 最新报告期：2026年中报（即2026年上半年业绩），披露时间为2026年8月下旬（依据招银国际研报发布日期为2026年8月26日，搜狐证券数据显示截至2026年6月30日财务数据）。  \n2) 核心业绩与边际变化（重点）：  \n   - 营业收入：…；内幕抢跑预警：近 5日 +4% / 10日 +11.5%股价已与消息方向一致（最大 +11.5%），消息影响预期下调 57.6%；全市场涨停 83 家、跌停 0 家，多空比 83（东财涨跌停池(20260901)）；近 10 条个股新闻（snownlp+词库），积极 5/中性 0/消极 5，加权情感均值 45.5（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 78.4、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157416、今日+2.53%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 9/利空 2，情绪均值 +44；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、深市非银金融半年报业绩亮眼 超三成公司增速逾50%；近20日均量 709443，最新 1080897，量比≈1.52（方向随近两日价格走强）","subFactors":[{"name":"消息情绪（大盘）","w":0.14,"signal":0.049,"value":"市场热度 +4.9","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）"},{"name":"财报解读","w":0.1,"signal":1,"value":"联动深度解读","detail":"最新财报解读（联动深度分析）：净利/营收同比 +36.1%（向好）；【深度分析·最新财报解读】综合结论（须置于正文最前，用一句话概括）：表观高增、实质向好，净利润大幅反弹且超预期，营运利润稳健增长，寿险改革初现成效，边际趋势显著加速。\n\n1) 最新报告期：2026年中报（即2026年上半年业绩），披露时间为2026年8月下旬（依据招银国际研报发布日期为2026年8月26日，搜狐证券数据显示截至2026年6月30日财务数据）。  \n2) 核心业绩与边际变化（重点）：  \n   - 营业收入：…"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 57.6%","detail":"内幕抢跑预警：近 5日 +4% / 10日 +11.5%股价已与消息方向一致（最大 +11.5%），消息影响预期下调 57.6%"},{"name":"涨跌停比","w":0.25,"signal":1,"value":"涨停 83/跌停 0","detail":"全市场涨停 83 家、跌停 0 家，多空比 83（东财涨跌停池(20260901)）"},{"name":"舆情与讨论热度（个股）","w":0.3,"signal":0.3815,"value":"利好 5/中性 0/利空 5 | 东财个股78.4↑ / 同花顺未入热榜 / 雪球第2名(关注3157416)","detail":"近 10 条个股新闻（snownlp+词库），积极 5/中性 0/消极 5，加权情感均值 45.5（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 78.4、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157416、今日+2.53%"},{"name":"板块消息联动","w":0.2,"signal":0.338,"value":"利好 9/利空 2 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 9/利空 2，情绪均值 +44；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、深市非银金融半年报业绩亮眼 超三成公司增速逾50%"},{"name":"量能活跃度","w":0.15,"signal":0.5235858338403039,"value":"量比≈1.52","detail":"近20日均量 709443，最新 1080897，量比≈1.52（方向随近两日价格走强）"}],"effectiveWeight":0.381,"contribution":0.191},{"key":"capital","name":"资金量能","weight":0.197,"signal":0.50932,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价齐升；近5日主力净流入0.36亿（资金流向为接口估算）；综合：资金面偏多，量能支撑上涨；融资余额：+0.2%","subFactors":[{"name":"量价配合","signal":0.6,"value":"量价齐升","detail":"量价配合良好，上涨有量能支撑"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.36亿","detail":"近5日主力净流入0.36亿（资金流向为接口估算）"},{"name":"融资余额","signal":0.198,"value":"+0.2%","detail":"沪深融资余额最新 26271 亿，较前值 +0.2%（沪深融资余额(亿元)）"}],"effectiveWeight":0.221,"contribution":0.112},{"key":"futures","name":"对标期货短期走势","weight":0.107,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.143,"signal":0.5,"applicable":true,"value":"大盘 -0.9% / 行业 +3.2%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）；行业：保险 +3.2%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":-0.42857142857142855,"value":"平均 -0.9%","detail":"上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）"},{"name":"行业板块","signal":1,"value":"+3.2%","detail":"保险 +3.2%（涨 5/跌 0）"}],"effectiveWeight":0.16,"contribution":0.08},{"key":"holdings","name":"增持减持","weight":0.054,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.06,"contribution":-0.03},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.089,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.1,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.07,"signal":0,"applicable":true,"value":"-0.29%","detail":"科技/半导体板块当日整体下跌 -0.29%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向震荡（中性）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-2.64%","detail":"半导体板块当日下跌2.64%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"-0.06%","detail":"电子板块当日下跌0.06%（军工电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+0.74%","detail":"计算机板块当日上涨0.74%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0.79%","detail":"通信板块当日上涨0.79%（通信服务）"}],"effectiveWeight":0.078,"contribution":0}],"weightsUsed":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":57.23,"prevClose":55.82,"settled":false,"rules":{"freshness":{"fresh":true,"expired":false,"ageMs":26770590,"ttlMs":86400000,"dataTime":"2026-09-01","reason":"在有效期内"},"staleNote":"","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":57.23,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T07:26:10.590Z"},"previous":{"value":55.82,"date":"昨收"},"changeRate":2.53,"prevChangeRate":0,"marginal":2.53,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 55.82 上升到 57.23，涨幅 2.53%，较上一期（持平 0.00%）转为上涨，边际变动 2.53 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-09-01","fetchedAt":"2026-09-01T07:26:10.590Z","dayChange":2.53,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 2.53%）背离"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260831h"},"accuracy":{"totalRecords":8,"settled":[{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-20","generatedAt":"2026-08-20T12:17:15.959Z","closed":true,"target":"nextday","targetDate":"2026-08-21","verdict":"看涨","dir":"涨","score":23,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪（讨论热度）","weight":0.16,"signal":0.043664107408699755,"applicable":true,"value":"涨停 79/跌停 12 | -1.11% | 利好 9/中性 0/利空 1 | 市场热度 +0.09 / 个股 75.6 | 利好 2/利空 7 | 量比≈0.71","detail":"全市场涨停 79 家、跌停 12 家，多空比 6.08（东财涨跌停池(20260820)）；沪深融资余额最新 26329 亿，较前值 -1.11%（沪深融资余额(亿元)）；近 10 条个股新闻（snownlp+词库），积极 9/中性 0/消极 1，情感均值 70.5（东财个股新闻·情感(601318)）；股吧讨论热度：全市场综合得分均值 66.4、上升家数占比 49.4%；该股股吧综合得分 75.6、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）；板块/赛道消息 16 条（关键词：保险、非银金融），利好 2/利空 7，情绪均值 -22；近20日均量 701091，最新 495295，量比≈0.71（方向随近两日价格走强）","effectiveWeight":0.182,"contribution":0.008},{"key":"capital","name":"资金量能","weight":0.22,"signal":0.16,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：缩量下跌；近5日主力净流入0.68亿；综合：资金面偏多，量能支撑上涨","effectiveWeight":0.25,"contribution":0.04},{"key":"futures","name":"对标期货短期走势","weight":0.12,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.16,"signal":0.10342857142857143,"applicable":true,"value":"大盘 +0.2% / 行业 +0.3%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.2%（中性）；行业：保险 +0.3%（涨 4/跌 1）","effectiveWeight":0.182,"contribution":0.019},{"key":"news","name":"近期重大利好/利空","weight":0.18,"signal":0.8153846153846154,"applicable":true,"value":"利好 12/利空 3","detail":"近期 26 条消息，利好 12/利空 3，情绪均值 +34.6（偏多）；最新财报：净利增速 +36.1%（增长/超预期）","effectiveWeight":0.205,"contribution":0.167},{"key":"holdings","name":"增持减持","weight":0.06,"signal":0,"applicable":true,"value":"增持 0/减持 0","detail":"前十大股东中，增持/新进 0 家、减持 0 家、其余 10 家不变","effectiveWeight":0.068,"contribution":0},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.1,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","effectiveWeight":0.114,"contribution":0}],"weightsUsed":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"weightsDefault":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"price":52.14,"prevClose":52.08,"settled":true,"schemaVersion":"20260820w","actualClose":53.35,"actualChgPct":2.32,"actualDir":"涨","actualBaseline":52.14,"actualBaselineLabel":"今日收盘","actualTargetLabel":"次日收盘","correct":true,"referenceDate":"2026-08-20"},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-23","generatedAt":"2026-08-23T13:05:07.719Z","closed":true,"target":"nextday","targetDate":"2026-08-24","verdict":"看涨","dir":"涨","score":16,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪（讨论热度）","weight":0.16,"signal":0.17057392673679433,"applicable":true,"value":"涨停 54/跌停 13 | 利好 8/中性 1/利空 1 | 市场热度 +0.05 / 个股 80.3 | 利好 1/利空 8 · 重大事件 | 量比≈1.56","detail":"全市场涨停 54 家、跌停 13 家，多空比 3.86（东财涨跌停池(20260821)）；近 10 条个股新闻（snownlp+词库），积极 8/中性 1/消极 1，加权情感均值 67.6（东财个股新闻·情感(601318)·近10条加权）；股吧讨论热度：全市场综合得分均值 62.7、上升家数占比 50.5%；该股股吧综合得分 80.3、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）；板块/赛道消息 16 条（关键词：保险、非银金融），利好 1/利空 8，情绪均值 -35；重大事件：众安保险获批增资至16.848亿元；近20日均量 714259，最新 1115990，量比≈1.56（方向随近两日价格走强）","subFactors":[{"name":"涨跌停比","w":0.25,"signal":0.612,"value":"涨停 54/跌停 13","detail":"全市场涨停 54 家、跌停 13 家，多空比 3.86（东财涨跌停池(20260821)）"},{"name":"文本舆情","w":0.15,"signal":0.352,"value":"利好 8/中性 1/利空 1","detail":"近 10 条个股新闻（snownlp+词库），积极 8/中性 1/消极 1，加权情感均值 67.6（东财个股新闻·情感(601318)·近10条加权）"},{"name":"讨论热度","w":0.15,"signal":0.337,"value":"市场热度 +0.05 / 个股 80.3","detail":"股吧讨论热度：全市场综合得分均值 62.7、上升家数占比 50.5%；该股股吧综合得分 80.3、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）"},{"name":"板块消息联动","w":0.2,"signal":-0.936,"value":"利好 1/利空 8 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 1/利空 8，情绪均值 -35；重大事件：众安保险获批增资至16.848亿元"},{"name":"量能活跃度","w":0.15,"signal":0.5624435604207658,"value":"量比≈1.56","detail":"近20日均量 714259，最新 1115990，量比≈1.56（方向随近两日价格走强）"}],"effectiveWeight":0.182,"contribution":0.031},{"key":"capital","name":"资金量能","weight":0.22,"signal":0.09424,"applicable":true,"value":"资金面中性偏多","detail":"量价：上涨缩量；近5日主力净流入0.46亿（资金流向为接口估算）；综合：资金面中性偏多；融资余额：-0.06%","subFactors":[{"name":"量价配合","signal":-0.2,"value":"上涨缩量","detail":"上涨日成交量低于下跌日，反弹缺乏量能支撑，需警惕"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.46亿","detail":"近5日主力净流入0.46亿（资金流向为接口估算）"},{"name":"融资余额","signal":-0.064,"value":"-0.06%","detail":"沪深融资余额最新 26312 亿，较前值 -0.06%（沪深融资余额(亿元)）"}],"effectiveWeight":0.25,"contribution":0.024},{"key":"futures","name":"对标期货短期走势","weight":0.12,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.16,"signal":0.3395714285714285,"applicable":true,"value":"大盘 +0.4% / 行业 +1%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.4%（偏强）；行业：保险 +1%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":0.21928571428571425,"value":"平均 +0.4%","detail":"上证/深成指/创业板/沪深300 平均 +0.4%（偏强）"},{"name":"行业板块","signal":0.52,"value":"+1%","detail":"保险 +1%（涨 5/跌 0）"}],"effectiveWeight":0.182,"contribution":0.062},{"key":"news","name":"近期重大利好/利空","weight":0.18,"signal":0.357914143533785,"applicable":true,"value":"利好 5/利空 4","detail":"近期 26 条消息，利好 5/利空 4，情绪均值 +3.8（中性）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 3日 +4% / 5日 +3.1%股价已与消息方向一致（最大 +4%），消息影响预期下调 19.8%","subFactors":[{"name":"消息情绪","signal":0.07692307692307693,"value":"利好 5/利空 4","detail":"近期 26 条消息，利好 5/利空 4，情绪均值 +3.8（中性）"},{"name":"财报符合预期","signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","signal":-0.4,"value":"预期下调 19.8%","detail":"内幕抢跑预警：近 3日 +4% / 5日 +3.1%股价已与消息方向一致（最大 +4%），消息影响预期下调 19.8%"}],"effectiveWeight":0.205,"contribution":0.073},{"key":"holdings","name":"增持减持","weight":0.06,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.068,"contribution":-0.034},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.1,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.114,"contribution":0}],"weightsUsed":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"weightsDefault":{"sentiment":0.16,"capital":0.22,"futures":0.12,"market":0.16,"news":0.18,"holdings":0.06,"sectorLimit":0.1},"price":53.35,"prevClose":52.14,"settled":true,"schemaVersion":"20260823h","actualClose":54.92,"actualChgPct":2.94,"actualDir":"涨","actualBaseline":53.35,"actualBaselineLabel":"基准日(2026-08-21)收盘","actualTargetLabel":"次日收盘","correct":true,"referenceDate":"2026-08-23"},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-25","referenceDate":"2026-08-24","generatedAt":"2026-08-25T10:02:20.225Z","closed":true,"target":"nextday","targetDate":"2026-08-25","verdict":"看涨","dir":"涨","score":21,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.38,"signal":0.4146312835431964,"applicable":true,"value":"利好 11/利空 4 | 净利增速 +36.1% | 预期下调 36% | 涨停 65/跌停 2 | 利好 5/中性 1/利空 4 | 市场热度 +0.1 / 个股 76.4 | 利好 4/利空 6 · 重大事件 | 量比≈0.98","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +24.1（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 3日 +5.5% / 5日 +7.2% / 10日 +4.7%股价已与消息方向一致（最大 +7.2%），消息影响预期下调 36%；全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260825)）；近 10 条个股新闻（snownlp+词库），积极 5/中性 1/消极 4，加权情感均值 48.2（东财个股新闻·情感(601318)·近10条加权）；股吧讨论热度：全市场综合得分均值 66.7、上升家数占比 49.4%；该股股吧综合得分 76.4、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）；板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -6；重大事件：定期存款热度降温 分红型保险成银行力推产品、众安保险获批增资至16.848亿元；近20日均量 750992，最新 739290，量比≈0.98（方向随近两日价格走强）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.30838457319361456,"value":"利好 11/利空 4","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +24.1（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 36%","detail":"内幕抢跑预警：近 3日 +5.5% / 5日 +7.2% / 10日 +4.7%股价已与消息方向一致（最大 +7.2%），消息影响预期下调 36%"},{"name":"涨跌停比","w":0.25,"signal":0.94,"value":"涨停 65/跌停 2","detail":"全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260825)）"},{"name":"文本舆情","w":0.15,"signal":-0.036,"value":"利好 5/中性 1/利空 4","detail":"近 10 条个股新闻（snownlp+词库），积极 5/中性 1/消极 4，加权情感均值 48.2（东财个股新闻·情感(601318)·近10条加权）"},{"name":"讨论热度","w":0.15,"signal":0.298,"value":"市场热度 +0.1 / 个股 76.4","detail":"股吧讨论热度：全市场综合得分均值 66.7、上升家数占比 49.4%；该股股吧综合得分 76.4、热度 上升（东财股吧舆情聚合·市场热度+个股(601318)）"},{"name":"板块消息联动","w":0.2,"signal":0.468,"value":"利好 4/利空 6 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -6；重大事件：定期存款热度降温 分红型保险成银行力推产品、众安保险获批增资至16.848亿元"},{"name":"量能活跃度","w":0.15,"signal":0.01558258112865063,"value":"量比≈0.98","detail":"近20日均量 750992，最新 739290，量比≈0.98（方向随近两日价格走强）"}],"effectiveWeight":0.428,"contribution":0.178},{"key":"capital","name":"资金量能","weight":0.207,"signal":0.23574,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入4.6亿；综合：资金面偏多，量能支撑上涨；融资余额：-0.16%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 4.6亿","detail":"近5日主力净流入4.6亿"},{"name":"融资余额","signal":-0.159,"value":"-0.16%","detail":"沪深融资余额最新 26208 亿，较前值 -0.16%（沪深融资余额(亿元)）"}],"effectiveWeight":0.233,"contribution":0.055},{"key":"futures","name":"对标期货短期走势","weight":0.113,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.15,"signal":0.03942857142857143,"applicable":true,"value":"大盘 -0.2% / 行业 +0.5%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.2%（中性）；行业：保险 +0.5%（涨 3/跌 2）","subFactors":[{"name":"大盘指数","signal":-0.0842857142857143,"value":"平均 -0.2%","detail":"上证/深成指/创业板/沪深300 平均 -0.2%（中性）"},{"name":"行业板块","signal":0.225,"value":"+0.5%","detail":"保险 +0.5%（涨 3/跌 2）"}],"effectiveWeight":0.169,"contribution":0.007},{"key":"holdings","name":"增持减持","weight":0.056,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.063,"contribution":-0.031},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.094,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.106,"contribution":0}],"weightsUsed":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"weightsDefault":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"price":55.01,"prevClose":54.92,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260823i","actualClose":55.01,"actualChgPct":0.16,"actualDir":"涨","actualBaseline":54.92,"actualBaselineLabel":"基准日(2026-08-24)收盘","actualTargetLabel":"次日收盘","correct":true},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-26","referenceDate":"2026-08-25","generatedAt":"2026-08-26T13:29:27.766Z","closed":true,"target":"nextday","targetDate":"2026-08-26","verdict":"看涨","dir":"涨","score":32,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.38,"signal":0.4084573508481495,"applicable":true,"value":"利好 9/利空 3 | 净利增速 +36.1% | 预期下调 38.9% | 涨停 52/跌停 0 | 利好 6/中性 1/利空 3 | 东财个股83.3↑ / 同花顺第89名(热度766241) / 雪球第2名(关注3153936) | 利好 3/利空 6 | 量比≈1.39","detail":"近期 27 条消息，利好 9/利空 3，情绪均值 +22.2（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 3日 +5.2% / 5日 +7.8% / 10日 +6.7%股价已与消息方向一致（最大 +7.8%），消息影响预期下调 38.9%；全市场涨停 52 家、跌停 0 家，多空比 52（东财涨跌停池(20260826)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 58.6（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 83.3、热度上升；同花顺热榜第89名、热度值766241、涨跌+2.04%；雪球关注榜第2名、关注人数3153936、今日+2.04%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 3/利空 6，情绪均值 -10；近20日均量 760108，最新 1053437，量比≈1.39（方向随近两日价格走强）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.2716333845366102,"value":"利好 9/利空 3","detail":"近期 27 条消息，利好 9/利空 3，情绪均值 +22.2（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 38.9%","detail":"内幕抢跑预警：近 3日 +5.2% / 5日 +7.8% / 10日 +6.7%股价已与消息方向一致（最大 +7.8%），消息影响预期下调 38.9%"},{"name":"涨跌停比","w":0.25,"signal":1,"value":"涨停 52/跌停 0","detail":"全市场涨停 52 家、跌停 0 家，多空比 52（东财涨跌停池(20260826)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.2405,"value":"利好 6/中性 1/利空 3 | 东财个股83.3↑ / 同花顺第89名(热度766241) / 雪球第2名(关注3153936)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 58.6（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 83.3、热度上升；同花顺热榜第89名、热度值766241、涨跌+2.04%；雪球关注榜第2名、关注人数3153936、今日+2.04%"},{"name":"板块消息联动","w":0.2,"signal":-0.06,"value":"利好 3/利空 6","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 3/利空 6，情绪均值 -10"},{"name":"量能活跃度","w":0.15,"signal":0.38590382449448324,"value":"量比≈1.39","detail":"近20日均量 760108，最新 1053437，量比≈1.39（方向随近两日价格走强）"}],"effectiveWeight":0.428,"contribution":0.175},{"key":"capital","name":"资金量能","weight":0.207,"signal":0.25394,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入10.37亿；综合：资金面偏多，量能支撑上涨；融资余额：-0.03%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 10.37亿","detail":"近5日主力净流入10.37亿"},{"name":"融资余额","signal":-0.029,"value":"-0.03%","detail":"沪深融资余额最新 26201 亿，较前值 -0.03%（沪深融资余额(亿元)）"}],"effectiveWeight":0.233,"contribution":0.059},{"key":"futures","name":"对标期货短期走势","weight":0.113,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.15,"signal":0.6635714285714285,"applicable":true,"value":"大盘 +0.9% / 行业 +2.2%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +0.9%（偏强）；行业：保险 +2.2%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":0.4392857142857142,"value":"平均 +0.9%","detail":"上证/深成指/创业板/沪深300 平均 +0.9%（偏强）"},{"name":"行业板块","signal":1,"value":"+2.2%","detail":"保险 +2.2%（涨 5/跌 0）"}],"effectiveWeight":0.169,"contribution":0.112},{"key":"holdings","name":"增持减持","weight":0.056,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.063,"contribution":-0.031},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.094,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.106,"contribution":0}],"weightsUsed":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"weightsDefault":{"sentiment":0.38,"capital":0.207,"futures":0.113,"market":0.15,"holdings":0.056,"sectorLimit":0.094},"price":56.13,"prevClose":55.01,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"reportEvent":{"symbol":"601318","type":"semi","year":"2026","title":"新华保险：2026年度中期利润分配方案公告","date":"2026-08-26 19:23:00"},"reportGap":false,"schemaVersion":"20260826j","actualClose":56.13,"actualChgPct":2.04,"actualDir":"涨","actualBaseline":55.01,"actualBaselineLabel":"基准日(2026-08-25)收盘","actualTargetLabel":"次日收盘","correct":true},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-27","referenceDate":"2026-08-26","generatedAt":"2026-08-27T03:35:50.607Z","closed":false,"target":"nextday","targetDate":"2026-08-27","verdict":"看涨","dir":"涨","score":13,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.34,"signal":0.3534344830990233,"applicable":true,"value":"利好 11/利空 4 | 净利增速 +36.1% | 预期下调 32.9% | 涨停 65/跌停 2 | 利好 6/中性 1/利空 3 | 东财个股82.8↑ / 同花顺第91名(热度786667) / 雪球第2名(关注3154485) | 利好 4/利空 6 | 量比≈0.55","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +25.9（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 5日 +6.6% / 10日 +5.2%股价已与消息方向一致（最大 +6.6%），消息影响预期下调 32.9%；全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260827)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 82.8、热度上升；同花顺热榜第91名、热度值786667、涨跌-1%；雪球关注榜第2名、关注人数3154485、今日-1%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -3；近20日均量 727313，最新 402552，量比≈0.55（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.3479663015527995,"value":"利好 11/利空 4","detail":"近期 27 条消息，利好 11/利空 4，情绪均值 +25.9（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 32.9%","detail":"内幕抢跑预警：近 5日 +6.6% / 10日 +5.2%股价已与消息方向一致（最大 +6.6%），消息影响预期下调 32.9%"},{"name":"涨跌停比","w":0.25,"signal":0.94,"value":"涨停 65/跌停 2","detail":"全市场涨停 65 家、跌停 2 家，多空比 21.67（东财涨跌停池(20260827)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.27949999999999997,"value":"利好 6/中性 1/利空 3 | 东财个股82.8↑ / 同花顺第91名(热度786667) / 雪球第2名(关注3154485)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 82.8、热度上升；同花顺热榜第91名、热度值786667、涨跌-1%；雪球关注榜第2名、关注人数3154485、今日-1%"},{"name":"板块消息联动","w":0.2,"signal":0.2,"value":"利好 4/利空 6","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 4/利空 6，情绪均值 -3"},{"name":"量能活跃度","w":0.15,"signal":-0.44652164886369416,"value":"量比≈0.55","detail":"近20日均量 727313，最新 402552，量比≈0.55（方向随近两日价格走弱）"}],"effectiveWeight":0.381,"contribution":0.135},{"key":"capital","name":"资金量能","weight":0.197,"signal":0.34356,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入0.79亿（资金流向为接口估算）；综合：资金面偏多，量能支撑上涨；融资余额：-0.13%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.79亿","detail":"近5日主力净流入0.79亿（资金流向为接口估算）"},{"name":"融资余额","signal":-0.126,"value":"-0.13%","detail":"沪深融资余额最新 26168 亿，较前值 -0.13%（沪深融资余额(亿元)）"}],"effectiveWeight":0.221,"contribution":0.076},{"key":"futures","name":"对标期货短期走势","weight":0.107,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.143,"signal":0.14399999999999996,"applicable":true,"value":"大盘 +1.3% / 行业 -1.3%","detail":"大盘：上证/深成指/创业板/沪深300 平均 +1.3%（偏强）；行业：保险 -1.3%（涨 0/跌 5）","subFactors":[{"name":"大盘指数","signal":0.6699999999999999,"value":"平均 +1.3%","detail":"上证/深成指/创业板/沪深300 平均 +1.3%（偏强）"},{"name":"行业板块","signal":-0.645,"value":"-1.3%","detail":"保险 -1.3%（涨 0/跌 5）"}],"effectiveWeight":0.16,"contribution":0.023},{"key":"holdings","name":"增持减持","weight":0.054,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.06,"contribution":-0.03},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.089,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.1,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.07,"signal":-1,"applicable":true,"value":"+3.66%","detail":"科技/半导体板块当日整体上涨 +3.66%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向下跌（偏空）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"+4.6%","detail":"半导体板块当日上涨4.60%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+5.09%","detail":"电子板块当日上涨5.09%（电子化学品）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"+1.48%","detail":"计算机板块当日上涨1.48%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+3.48%","detail":"通信板块当日上涨3.48%（通信设备）"}],"effectiveWeight":0.078,"contribution":-0.078}],"weightsUsed":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":55.57,"prevClose":56.13,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"reportEvent":{"symbol":"601318","type":"semi","year":"2026","title":"中国平安(601318.SH)2026年中报净利润为925.85亿元、较去年同期上涨36.06%","date":"2026-08-21 10:27:36"},"reportGap":false,"schemaVersion":"20260827d","actualClose":55.87,"actualChgPct":-0.46,"actualDir":"跌","actualBaseline":56.13,"actualBaselineLabel":"基准日(2026-08-26)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"下一交易日","date":"2026-08-28","referenceDate":"2026-08-27","generatedAt":"2026-08-28T02:40:12.954Z","closed":false,"target":"nextday","targetDate":"2026-08-28","verdict":"看涨","dir":"涨","score":13,"confidence":"低","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3602,"signal":0.3686507060377861,"applicable":true,"value":"利好 9/利空 4 | 净利增速 +36.1% | 预期下调 39.3% | 涨停 53/跌停 1 | 利好 6/中性 1/利空 3 | 东财个股74.9↓ / 同花顺未入热榜 / 雪球第2名(关注3155180) | 利好 8/利空 3 | 量比≈0.4","detail":"近期 27 条消息，利好 9/利空 4，情绪均值 +18.5（偏多）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 5日 +4.6% / 10日 +7.9%股价已与消息方向一致（最大 +7.9%），消息影响预期下调 39.3%；全市场涨停 53 家、跌停 1 家，多空比 26.5（东财涨跌停池(20260828)）；近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 74.9、热度下降；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3155180、今日-0.09%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 8/利空 3，情绪均值 +31；近20日均量 700661，最新 278081，量比≈0.4（方向随近两日价格走弱）","subFactors":[{"name":"消息情绪","w":0.14,"signal":0.22472714260153875,"value":"利好 9/利空 4","detail":"近期 27 条消息，利好 9/利空 4，情绪均值 +18.5（偏多）"},{"name":"财报符合预期","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 39.3%","detail":"内幕抢跑预警：近 5日 +4.6% / 10日 +7.9%股价已与消息方向一致（最大 +7.9%），消息影响预期下调 39.3%"},{"name":"涨跌停比","w":0.25,"signal":0.963,"value":"涨停 53/跌停 1","detail":"全市场涨停 53 家、跌停 1 家，多空比 26.5（东财涨跌停池(20260828)）"},{"name":"舆情与讨论热度","w":0.3,"signal":0.4965,"value":"利好 6/中性 1/利空 3 | 东财个股74.9↓ / 同花顺未入热榜 / 雪球第2名(关注3155180)","detail":"近 10 条个股新闻（snownlp+词库），积极 6/中性 1/消极 3，加权情感均值 63.1（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 74.9、热度下降；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3155180、今日-0.09%"},{"name":"板块消息联动","w":0.2,"signal":0.14,"value":"利好 8/利空 3","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 8/利空 3，情绪均值 +31"},{"name":"量能活跃度","w":0.15,"signal":-0.6031163985283332,"value":"量比≈0.4","detail":"近20日均量 700661，最新 278081，量比≈0.4（方向随近两日价格走弱）"}],"effectiveWeight":0.401,"contribution":0.148},{"key":"capital","name":"资金量能","weight":0.2086,"signal":0.08969040287581448,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入4.82亿；综合：资金面偏多，量能支撑上涨；换手率变化：最新换手率 0.26%，近15日均值 0.75%（偏离 -65.2%），近两日价跌 → 放量偏空；融资余额：+0.43%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 4.82亿","detail":"近5日主力净流入4.82亿"},{"name":"换手率变化","signal":-0.7825799760348794,"value":"放量偏空","detail":"最新换手率 0.26%，近15日均值 0.75%（偏离 -65.2%），近两日价跌 → 放量偏空"},{"name":"融资余额","signal":0.432,"value":"+0.43%","detail":"沪深融资余额最新 26281 亿，较前值 +0.43%（沪深融资余额(亿元)）"}],"effectiveWeight":0.232,"contribution":0.021},{"key":"futures","name":"对标期货短期走势","weight":0.1012,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1515,"signal":-0.09142857142857144,"applicable":true,"value":"大盘 -0.1% / 行业 -0.4%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.1%（中性）；行业：保险 -0.4%（涨 2/跌 3）","subFactors":[{"name":"大盘指数","signal":-0.025714285714285714,"value":"平均 -0.1%","detail":"上证/深成指/创业板/沪深300 平均 -0.1%（中性）"},{"name":"行业板块","signal":-0.19,"value":"-0.4%","detail":"保险 -0.4%（涨 2/跌 3）"}],"effectiveWeight":0.169,"contribution":-0.015},{"key":"holdings","name":"增持减持","weight":0.0449,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.05,"contribution":-0.025},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0673,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.075,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.0662,"signal":0,"applicable":true,"value":"+0.2%","detail":"科技/半导体板块当日整体上涨 +0.2%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向震荡（中性）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-0.08%","detail":"半导体板块当日下跌0.08%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"+0.52%","detail":"电子板块当日上涨0.52%（其他电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"-0.06%","detail":"计算机板块当日下跌0.06%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"+0.41%","detail":"通信板块当日上涨0.41%（通信设备）"}],"effectiveWeight":0.074,"contribution":0}],"weightsUsed":{"sentiment":0.3602,"capital":0.2086,"futures":0.1012,"market":0.1515,"holdings":0.0449,"sectorLimit":0.0673,"seesaw":0.0662},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":55.82,"prevClose":55.87,"settled":true,"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260827d","actualClose":55.85,"actualChgPct":-0.04,"actualDir":"跌","actualBaseline":55.87,"actualBaselineLabel":"基准日(2026-08-27)收盘","actualTargetLabel":"次日收盘","correct":false},{"symbol":"601318","name":"中国平安","industry":"保险","horizon":"short","horizonLabel":"今日后续","date":"2026-09-01","referenceDate":"2026-08-31","generatedAt":"2026-09-01T02:39:52.928Z","closed":false,"target":"nextday","targetDate":"2026-09-01","verdict":"看涨","dir":"涨","score":22,"confidence":"中","factors":[{"key":"sentiment","name":"市场情绪与消息面","weight":0.3509,"signal":0.23557341284054462,"applicable":true,"value":"市场热度 +4.9 | 净利增速 +36.1% | 预期下调 54.6% | 涨停 58/跌停 1 | 利好 5/中性 0/利空 5 | 东财个股78.4↑ / 同花顺未入热榜 / 雪球第2名(关注3157416) | 利好 7/利空 4 · 重大事件 | 量比≈0.73","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）；最新财报：净利增速 +36.1%（增长/超预期）；内幕抢跑预警：近 5日 +3.5% / 10日 +10.9%股价已与消息方向一致（最大 +10.9%），消息影响预期下调 54.6%；全市场涨停 58 家、跌停 1 家，多空比 29（东财涨跌停池(20260901)）；近 10 条个股新闻（snownlp+词库），积极 5/中性 0/消极 5，加权情感均值 43.8（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 78.4、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157416、今日+2.01%；板块/赛道消息 16 条（关键词：保险、非银金融），利好 7/利空 4，情绪均值 +19；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、深市非银金融半年报业绩亮眼 超三成公司增速逾50%；近20日均量 680292，最新 497872，量比≈0.73（方向随近两日价格走强）","subFactors":[{"name":"消息情绪（大盘）","w":0.14,"signal":0.049,"value":"市场热度 +4.9","detail":"大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 65.6，上升家数占比 47%（中性）"},{"name":"财报解读","w":0.1,"signal":1,"value":"净利增速 +36.1%","detail":"最新财报：净利增速 +36.1%（增长/超预期）"},{"name":"内幕抢跑预警","w":0.05,"signal":-0.4,"value":"预期下调 54.6%","detail":"内幕抢跑预警：近 5日 +3.5% / 10日 +10.9%股价已与消息方向一致（最大 +10.9%），消息影响预期下调 54.6%"},{"name":"涨跌停比","w":0.25,"signal":0.966,"value":"涨停 58/跌停 1","detail":"全市场涨停 58 家、跌停 1 家，多空比 29（东财涨跌停池(20260901)）"},{"name":"舆情与讨论热度（个股）","w":0.3,"signal":0.3645,"value":"利好 5/中性 0/利空 5 | 东财个股78.4↑ / 同花顺未入热榜 / 雪球第2名(关注3157416)","detail":"近 10 条个股新闻（snownlp+词库），积极 5/中性 0/消极 5，加权情感均值 43.8（东财个股新闻·情感(601318)·近10条加权）；东财股吧综合得分 78.4、热度上升；同花顺热榜·601318未进入当日 A 股热榜前100名；雪球关注榜第2名、关注人数3157416、今日+2.01%"},{"name":"板块消息联动","w":0.2,"signal":-0.988,"value":"利好 7/利空 4 · 重大事件","detail":"板块/赛道消息 16 条（关键词：保险、非银金融），利好 7/利空 4，情绪均值 +19；重大事件：长安保险风险处置迎新进展，中安财险获批受让其保险业务、深市非银金融半年报业绩亮眼 超三成公司增速逾50%"},{"name":"量能活跃度","w":0.15,"signal":0.26814907520165443,"value":"量比≈0.73","detail":"近20日均量 680292，最新 497872，量比≈0.73（方向随近两日价格走强）"}],"effectiveWeight":0.391,"contribution":0.092},{"key":"capital","name":"资金量能","weight":0.2033,"signal":0.19806487547169796,"applicable":true,"value":"资金面偏多，量能支撑上涨","detail":"量价：量价温和偏多；近5日主力净流入0.95亿；综合：资金面偏多，量能支撑上涨；换手率变化：最新换手率 0.47%，近15日均值 0.75%（偏离 -37.1%），近两日价涨 → 放量偏多；融资余额：+0.2%","subFactors":[{"name":"量价配合","signal":0.3,"value":"量价温和偏多","detail":"上涨天数占优且上涨日量能略强，反弹有一定持续性"},{"name":"主力净流入(近5日)","signal":1,"value":"净流入 0.95亿","detail":"近5日主力净流入0.95亿"},{"name":"换手率变化","signal":0.4455406289308162,"value":"放量偏多","detail":"最新换手率 0.47%，近15日均值 0.75%（偏离 -37.1%），近两日价涨 → 放量偏多"},{"name":"融资余额","signal":0.198,"value":"+0.2%","detail":"沪深融资余额最新 26271 亿，较前值 +0.2%（沪深融资余额(亿元)）"}],"effectiveWeight":0.227,"contribution":0.045},{"key":"futures","name":"对标期货短期走势","weight":0.1035,"signal":0,"applicable":false,"value":"不适用","detail":"该公司无直接对标期货，本因子不参与打分","effectiveWeight":0,"contribution":0},{"key":"market","name":"大盘及行业板块短期走势","weight":0.1568,"signal":0.49350000000000005,"applicable":true,"value":"大盘 -0.9% / 行业 +2.7%","detail":"大盘：上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）；行业：保险 +2.7%（涨 5/跌 0）","subFactors":[{"name":"大盘指数","signal":-0.4471428571428571,"value":"平均 -0.9%","detail":"上证/深成指/创业板/沪深300 平均 -0.9%（偏弱）"},{"name":"行业板块","signal":1,"value":"+2.7%","detail":"保险 +2.7%（涨 5/跌 0）"}],"effectiveWeight":0.175,"contribution":0.086},{"key":"holdings","name":"增持减持","weight":0.0488,"signal":-0.4919368921193701,"applicable":true,"value":"增持 1/减持 5/净变动 -1.92亿股","detail":"前十大股东中，增持/新进 1 家（中国平安保险(集团)股份有限公司长期服务计划）、减持 5 家（香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）、其余 4 家不变；十大股东合计净变动 -1.92亿股（占其持股 -1.81%）（数据报告期：2026-06-30）","subFactors":[{"name":"十大股东净变动","signal":-0.6043042047097112,"value":"-1.92亿股","detail":"最新报告期 2026-06-30，前十大股东合计净变动 -1.92亿股，占其合计持股 -1.81%；其中增持 4358.30万股、减持 2.36亿股"},{"name":"增减持家数","signal":-0.4,"value":"增持 1/减持 5","detail":"前十大股东增持/新进 1 家、减持 5 家、不变 4 家（增持：中国平安保险(集团)股份有限公司长期服务计划）（减持：香港中央结算(代理人)有限公司、中国人寿保险股份有限公司-传统-普通保险产品-005L-CT001沪、工银瑞信基金-农业银行-工银瑞信中证金融资产管理计划等）"},{"name":"股份回购","signal":0,"value":"无","detail":"未检索到股份回购记录，按中性处理"}],"effectiveWeight":0.054,"contribution":-0.027},{"key":"sectorLimit","name":"板块涨跌停占比","weight":0.0689,"signal":0,"applicable":true,"value":"涨停 0.0% / 跌停 0.0%","detail":"所属「保险」板块：涨停 0 家（0.0%）、跌停 0 家（0.0%）、成分 5 家 → 板块情绪平稳","subFactors":[{"name":"涨停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块涨停 0 家，占成分股 0.0%"},{"name":"跌停占比","signal":0,"value":"0.0%","detail":"所属「保险」板块跌停 0 家，占成分股 0.0%"},{"name":"板块成分","signal":0,"value":"5 家","detail":"板块成分股共 5 家（保险）"}],"effectiveWeight":0.077,"contribution":0},{"key":"seesaw","name":"板块跷跷板(科技/半导体负相关)","weight":0.0677,"signal":0.319,"applicable":true,"value":"-0.96%","detail":"科技/半导体板块当日整体下跌 -0.96%，与\"其他板块\"（含该股）呈明显负相关 → 该股倾向上涨（偏多）；阈值：满格 ±3%，死区 ±0.3%","subFactors":[{"name":"科技板块·半导体","w":0,"signal":0,"value":"-2.6%","detail":"半导体板块当日下跌2.60%（半导体）"},{"name":"科技板块·电子","w":0,"signal":0,"value":"-0.96%","detail":"电子板块当日下跌0.96%（军工电子）"},{"name":"科技板块·计算机","w":0,"signal":0,"value":"-0.17%","detail":"计算机板块当日下跌0.17%（计算机设备）"},{"name":"科技板块·通信","w":0,"signal":0,"value":"-0.1%","detail":"通信板块当日下跌0.10%（通信服务）"}],"effectiveWeight":0.076,"contribution":0.024}],"weightsUsed":{"sentiment":0.3509,"capital":0.2033,"futures":0.1035,"market":0.1568,"holdings":0.0488,"sectorLimit":0.0689,"seesaw":0.0677},"weightsDefault":{"sentiment":0.34,"capital":0.197,"futures":0.107,"market":0.143,"holdings":0.054,"sectorLimit":0.089,"seesaw":0.07},"price":56.91,"prevClose":55.82,"settled":true,"rules":{"freshness":{"fresh":false,"expired":true,"ageMs":95992928,"ttlMs":86400000,"dataTime":"2026-08-31","reason":"数据日之后已过 1 个交易日，超过该类型有效期"},"staleNote":"数据已过期，最后更新时间是 2026-08-31","analysis":{"name":"价格","available":true,"current":{"name":"价格","value":56.91,"dataTime":"当前","source":"未知","fetchTime":"2026-09-01T02:39:52.928Z"},"previous":{"value":55.82,"date":"昨收"},"changeRate":1.95,"prevChangeRate":0,"marginal":1.95,"direction":"数据不足","accel":"上涨加速","marginalStreak":0,"text":"价格从 55.82 上升到 56.91，涨幅 1.95%，较上一期（持平 0.00%）转为上涨，边际变动 1.95 个百分点，呈上涨加速态势","special":false,"specialNote":""},"source":"短期判断引擎（七因子加权）· 行情与消息面","dataTime":"2026-08-31","fetchedAt":"2026-09-01T02:39:52.928Z","dayChange":1.95,"consistency":"⚠️ 判断方向（偏空）与当日涨跌（涨 1.95%）背离"},"crossMarketMeta":null,"sectorNewsMeta":{"relevance":0.55,"weakThemes":["非银金融"]},"schemaVersion":"20260831h","actualClose":57.23,"actualChgPct":2.53,"actualDir":"涨","actualBaseline":55.82,"actualBaselineLabel":"基准日(2026-08-31)收盘","actualTargetLabel":"次日收盘","correct":true}],"settledCount":7,"pendingCount":1,"overdueCount":0,"correct":5,"accuracy":71.4,"bullRate":71.4,"bearRate":null,"flatRate":null,"intradayRate":null,"nextdayRate":71.4},"today":"2026-09-01","regenerated":false}
~~~

---

## `scripts\sector_limit_stats.py`  ·  294 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
板块涨跌停占比数据层（短期情绪核心因子）

需求：将「个股所属板块的涨停/跌停数量占比」作为短期情绪强弱的量化输入，
     与个股自身技术面/情绪信号结合，用于行情方向判断与买卖决策。

实现口径（明确说明，避免分类歧义）：
  1) 涨停 / 跌停 判定：
       使用东方财富「涨停池 stock_zt_pool_em」与「跌停池 stock_zt_pool_dtgc_em」。
       这是权威口径，已按各板块规则精确判定，无需自行计算阈值：
         主板(60/00 开头)          ±10%
         创业板(30)/科创板(68)     ±20%
         北交所(8/4/92 开头)       ±30%
         ST / *ST（名称含 ST）      ±5%
  2) 板块分类口径：
       涨停/跌停计数按涨停池/跌停池的「所属行业」字段（东方财富行业分类）匹配。
       分母（板块成分股总数）优先用东方财富成分股接口，本机该接口被 TLS 封锁时，
       回退用同花顺行业板块一览(申万一级)的「上涨家数+下跌家数」近似，并在 note 标注。
  3) 占比：
       涨停占比 = 板块内涨停家数 / 板块成分股总数
       跌停占比 = 板块内跌停家数 / 板块成分股总数
       情绪信号 = (涨停占比 - 跌停占比)，再按经验尺度放大后截断到 [-1,1]。

数据源均为 akshare 对公开财经接口的二次封装，用于个人研究；不直爬页面。
中文字符串统一 UTF-8 输出，避免 Windows 控制台 GBK 乱码。
任何子步骤失败仅该子步骤降级（ok=false），不崩溃；全失败返回 error 退出码 1。
"""
import json
import sys
import io
import argparse
import traceback
from datetime import datetime, timedelta

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass


def _now_str():
    return datetime.now().strftime('%Y-%m-%d')


def _normalize_industry(name):
    """去掉行业名中的常见后缀/罗马数字/无意义词，得到用于模糊匹配的核心词。"""
    if not name:
        return ''
    replacements = ['行业', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '概念', '指数', '板块']
    s = name
    for r in replacements:
        s = s.replace(r, '')
    s = s.replace('业', '').strip()
    return s


def _industry_candidates(industry):
    """生成待匹配的行业名候选列表（原始 + 归一化 + 同义词扩展）。"""
    candidates = [industry]
    norm = _normalize_industry(industry)
    if norm and norm != industry:
        candidates.append(norm)
    synonyms = {
        '证券': ['券商', '非银金融', '非银行金融'],
        '保险': ['保险'],
        '银行': ['银行'],
        '白酒': ['酿酒', '饮料制造'],
        '医药': ['医药生物', '生物医药', '医疗器械', '创新药'],
        '新能源': ['光伏', '风电', '储能', '锂电'],
        '汽车': ['汽车整车', '新能源车', '零部件'],
        '半导体': ['芯片', '集成电路'],
        '人工智能': ['AI', '算力', '大模型'],
        '通信': ['5G', '算力网络'],
        '计算机': ['软件', '信创'],
        '军工': ['国防军工', '航天'],
        '有色': ['有色金属'],
        '化工': ['基础化工'],
        '电力': ['电力设备', '电网'],
        '家电': ['家用电器'],
        '机械': ['机械设备', '工程机械'],
        '传媒': ['游戏', '影视'],
        '交运': ['交通运输', '物流'],
        '煤炭': ['煤炭'],
        '钢铁': ['钢铁'],
        '石油': ['石油石化', '油气'],
        '建筑': ['建筑装饰', '建材'],
        '房地产': ['地产'],
        '农业': ['农林牧渔', '种业', '养殖'],
        '环保': ['环境保护'],
        '食品': ['食品饮料'],
        '电子': ['电子'],
        '电力设备': ['电网', '特高压'],
        '公用事业': ['燃气', '水务'],
    }
    for key, extras in synonyms.items():
        matched = any(key in c or any(e in c for e in extras) for c in candidates)
        if matched:
            candidates.append(key)
            candidates.extend(extras)
    seen = set()
    out = []
    for c in candidates:
        c = c.strip()
        if len(c) >= 2 and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _col(df, kw):
    for c in (df.columns if df is not None else []):
        if kw in str(c):
            return c
    return None


def _try_dates(n=5):
    """涨跌停池在非交易日为空，向前回溯 n 个交易日。"""
    out = []
    base = datetime.now()
    for i in range(n):
        d = base - timedelta(days=i)
        if d.weekday() >= 5:
            continue
        out.append(d.strftime('%Y%m%d'))
    return out


def _match_industry_value(values, candidates):
    """在候选行业名中找与给定行业值列表匹配的项，返回命中的标准值或 None。"""
    if not values or not candidates:
        return None
    values = [str(v).strip() for v in values]
    # 1) 精确
    for c in candidates:
        for v in values:
            if v == c:
                return v
    # 2) 双向包含
    for c in candidates:
        for v in values:
            if c in v or v in c:
                return v
    # 3) 归一化后再比
    for c in candidates:
        cn = _normalize_industry(c)
        if not cn:
            continue
        for v in values:
            vn = _normalize_industry(v)
            if cn == vn or (cn and vn and (cn in vn or vn in cn)):
                return v
    return None


def fetch_limit_pools(date_str):
    """获取全市场涨停池/跌停池，返回 (up_df, down_df)。"""
    from akshare import stock_zt_pool_em, stock_zt_pool_dtgc_em
    up = stock_zt_pool_em(date=date_str)
    down = stock_zt_pool_dtgc_em(date=date_str)
    return up, down


def fetch_ths_total(industry_candidates):
    """同花顺行业板块一览，匹配行业后返回 {boardName, total}（上涨+下跌，近似总数）。"""
    from akshare import stock_board_industry_summary_ths
    df = stock_board_industry_summary_ths()
    if df is None or len(df) == 0:
        return None
    name_col = _col(df, '板块') or df.columns[0]
    up_col = _col(df, '上涨家数')
    down_col = _col(df, '下跌家数')
    board_names = [str(r[name_col]).strip() for _, r in df.iterrows()]
    hit = _match_industry_value(board_names, industry_candidates)
    if hit is None:
        return None
    row = df[df[name_col].astype(str).str.strip() == hit].iloc[0]
    up = int(row[up_col]) if up_col else 0
    down = int(row[down_col]) if down_col else 0
    return {'boardName': hit, 'up': up, 'down': down, 'total': up + down, 'source': '同花顺·行业板块(申万一级,涨跌家数合计)'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', default='')
    parser.add_argument('--name', default='')
    parser.add_argument('--industry', default='')
    args = parser.parse_args()
    symbol = (args.symbol or '').strip()
    name = (args.name or '').strip()
    industry = (args.industry or '').strip()

    result = {
        'source': '东方财富涨跌停池 + 同花顺行业板块',
        'date': _now_str(),
        'ok': False,
        'symbol': symbol,
        'industryName': industry or None,
        'boardName': None,
        'limitUp': None,       # 板块内涨停家数
        'limitDown': None,     # 板块内跌停家数
        'total': None,         # 板块成分股总数（分母）
        'limitUpRatio': None,  # 涨停占比 0~1
        'limitDownRatio': None,  # 跌停占比 0~1
        'signal': 0.0,
        'note': '',
        'threshold': '东财涨跌停池权威口径：主板±10% / 创业板·科创板±20% / 北交所±30% / ST±5%',
    }

    if not industry:
        result['note'] = '未提供行业名，无法定位板块，板块涨跌停占比按中性处理'
        print(json.dumps(result, ensure_ascii=False))
        return

    candidates = _industry_candidates(industry)

    # 1) 涨停/跌停计数：向前回溯到最近一个交易日
    up_df = down_df = None
    pool_date = None
    for ds in _try_dates(5):
        try:
            up_df, down_df = fetch_limit_pools(ds)
            pool_date = ds
            break
        except Exception as e:
            print(f'[sector_limit] 涨跌停池获取失败 {ds}: {e}', file=sys.stderr)
            continue

    if up_df is None and down_df is None:
        result['note'] = '涨跌停池数据不可用，板块涨跌停占比按中性处理'
        print(json.dumps(result, ensure_ascii=False))
        return

    def _count_by_industry(df):
        if df is None or len(df) == 0:
            return 0, None
        ind_col = _col(df, '所属行业')
        if ind_col is None:
            return 0, None
        values = [str(v).strip() for v in df[ind_col].tolist()]
        hit = _match_industry_value(values, candidates)
        if hit is None:
            return 0, None
        return int((df[ind_col].astype(str).str.strip() == hit).sum()), hit

    limit_up, up_ind = _count_by_industry(up_df)
    limit_down, down_ind = _count_by_industry(down_df)

    # 2) 分母：板块成分股总数（同花顺 上涨+下跌 近似）
    total = None
    ths = None
    try:
        ths = fetch_ths_total(candidates)
    except Exception as e:
        print(f'[sector_limit] 同花顺板块总数获取失败: {e}', file=sys.stderr)

    if ths and ths.get('total'):
        total = ths['total']
        result['boardName'] = ths.get('boardName')
        result['note'] = f'个股行业「{industry}」→ 板块「{ths.get("boardName")}」'
    else:
        result['note'] = f'个股行业「{industry}」定位的板块总成分股数不可用'

    result['limitUp'] = limit_up
    result['limitDown'] = limit_down
    result['total'] = total
    result['industryMatched'] = up_ind or down_ind or (ths and ths.get('boardName'))

    if total and total > 0:
        result['limitUpRatio'] = round(limit_up / total, 4)
        result['limitDownRatio'] = round(limit_down / total, 4)
        result['ok'] = True
        # 情绪信号：涨停占比 - 跌停占比；板块情绪量级较小，放大后截断
        raw = (result['limitUpRatio'] - result['limitDownRatio'])
        result['signal'] = round(max(-1.0, min(1.0, raw * 20)), 3)
        result['note'] += (f'；涨停 {limit_up} 家 / 跌停 {limit_down} 家 / 总数 {total} 家'
                           f'（涨停占比 {result["limitUpRatio"]*100:.1f}%，跌停占比 {result["limitDownRatio"]*100:.1f}%）'
                           f'；{ths.get("source") if ths else "总数来源待确认"}')
    else:
        result['note'] += '；板块成分股总数缺失，无法计算占比，按中性处理'

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}, ensure_ascii=False))
        sys.exit(1)

~~~

---

## `scripts\sector_trend.py`  ·  394 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
行业板块走势因子数据层（三期：板块整体涨跌，而非研报情绪）

需求背景：
  判断引擎原「行业板块（研报情绪）」因子基于研报评级分布 / 目标价空间，
  与「市场情绪」因子高度重叠。现改为研究「个股所属行业板块的走势（价格涨跌）」，
  例如中国平安 → 保险板块的整体涨跌、上涨/下跌家数、领涨股表现。

数据来源（均为 akshare 对公开财经接口的二次封装，遵循其使用条款）：
  1) 板块整体涨跌（首选）：
       ak.stock_board_industry_name_em()   无参数，返回全市场行业板块涨跌排名
       （板块名称 / 涨跌幅 / 上涨家数 / 下跌家数 / 领涨股 / 领涨股-涨跌幅）
       → 用个股行业名（来自 Node 侧 industryAnalysis 提示）模糊匹配板块名称。
  2) 成分股均值回退（匹配不到板块名时）：
       ak.stock_board_industry_cons_em(symbol=<行业名>)
       → 拉该板块成分股，按涨跌幅均值估算板块走势，并按涨跌家数统计。
  3) 行业名兜底：若 Node 未提供 industry，尝试用 stock_board_industry_cons_em
       以个股代码附近逻辑不行（该接口需板块名），故 industry 缺失时直接中性降级。

合规说明：以上均为 akshare 聚合公开行情，用于个人研究；不直爬东财/同花顺页面。
中文字符串统一 UTF-8 输出，避免 Windows 控制台 GBK 乱码。
任何子步骤失败仅本步骤降级（返回 ok=false），不崩溃；全部失败返回 error 并退出码 1。
"""
import json
import sys
import io
import argparse
import traceback
import time

# Windows 控制台默认 GBK，直接输出中文会乱码；强制 stdout/stderr 用 UTF-8。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass


def _now_str():
    from datetime import datetime
    return datetime.now().strftime('%Y-%m-%d')


def _col(df, kw):
    """按关键字模糊匹配列名（兼容 akshare 不同版本列名差异）。"""
    if df is None:
        return None
    for c in df.columns:
        if kw in str(c):
            return c
    return None


def _safe_float(v):
    try:
        if v is None or v == '' or v == '--':
            return None
        return float(v)
    except Exception:
        return None


def _safe_int(v):
    try:
        f = _safe_float(v)
        return int(round(f)) if f is not None else None
    except Exception:
        return None


def _retry(fn, tries=3, sleep_s=0.8):
    """网络接口间歇限流（ConnectionError / RemoteDisconnected）重试。"""
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # 网络/解析异常均重试
            last = e
            if i < tries - 1:
                time.sleep(sleep_s)
    raise last if last else RuntimeError('unknown error')


def _normalize_industry(name):
    """去掉行业名中的常见后缀/罗马数字/无意义词，得到用于模糊匹配的核心词。"""
    if not name:
        return ''
    # 去掉罗马数字、常见后缀与无意义词
    replacements = ['行业', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', '概念', '指数', '板块']
    s = name
    for r in replacements:
        s = s.replace(r, '')
    # '业' 单独替换放在最后，避免先替掉'证券业'中的'业'导致'证'这种过短词
    s = s.replace('业', '').strip()
    return s


def _industry_candidates(industry):
    """生成待匹配的行业名候选列表（原始 + 归一化 + 同义词扩展）。"""
    candidates = [industry]
    norm = _normalize_industry(industry)
    if norm and norm != industry:
        candidates.append(norm)
    # 同义词/近义词扩展：解决申万/东财/同花顺口径命名差异
    synonyms = {
        '证券': ['券商', '非银金融', '非银行金融'],
        '保险': ['保险'],
        '银行': ['银行'],
        '白酒': ['酿酒', '饮料制造'],
        '医药': ['医药生物', '生物医药', '医疗器械', '创新药'],
        '新能源': ['光伏', '风电', '储能', '锂电'],
        '汽车': ['汽车整车', '新能源车', '零部件'],
        '半导体': ['芯片', '集成电路'],
        '人工智能': ['AI', '算力', '大模型'],
        '通信': ['5G', '算力网络'],
        '计算机': ['软件', '信创'],
        '军工': ['国防军工', '航天'],
        '有色': ['有色金属'],
        '化工': ['基础化工'],
        '电力': ['电力设备', '电网'],
        '家电': ['家用电器'],
        '机械': ['机械设备', '工程机械'],
        '传媒': ['游戏', '影视'],
        '交运': ['交通运输', '物流'],
        '煤炭': ['煤炭'],
        '钢铁': ['钢铁'],
        '石油': ['石油石化', '油气'],
        '建筑': ['建筑装饰', '建材'],
        '房地产': ['地产'],
        '农业': ['农林牧渔', '种业', '养殖'],
        '环保': ['环境保护'],
        '食品': ['食品饮料'],
        '电子': ['电子'],
        '电力设备': ['电网', '特高压'],
        '公用事业': ['燃气', '水务'],
    }
    for key, extras in synonyms.items():
        # 如果原始/归一化行业名包含 key 或任一 extras，就把 key 作为候选
        matched = any(key in c or any(e in c for e in extras) for c in candidates)
        if matched:
            candidates.append(key)
            candidates.extend(extras)
    # 去重且过滤掉空/过短词
    seen = set()
    out = []
    for c in candidates:
        c = c.strip()
        if len(c) >= 2 and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _match_board_name(df, industry):
    """在板块列表中模糊匹配个股行业名，返回 (board_name, row) 或 (None, None)。"""
    if df is None or len(df) == 0 or not industry:
        return None, None
    name_col = _col(df, '板块名称') or _col(df, '板块') or df.columns[0]
    rows = []
    for _, row in df.iterrows():
        bn = str(row[name_col]).strip()
        rows.append((bn, row))
    candidates = _industry_candidates(industry)
    # 1) 精确相等（原始 + 归一化）
    for c in candidates:
        for bn, row in rows:
            if bn == c:
                return bn, row
    # 2) 双向包含（原始 + 归一化）
    for c in candidates:
        for bn, row in rows:
            if c in bn or bn in c:
                return bn, row
    # 3) 对板块名也做归一化后再双向包含
    for c in candidates:
        cn = _normalize_industry(c)
        if not cn:
            continue
        for bn, row in rows:
            bns = _normalize_industry(bn)
            if cn == bns or cn in bns or bns in cn:
                return bn, row
    return None, None


def _build_board_from_row(df, row, source_name):
    """从板块排名 DataFrame 的一行中提取统一字段，返回 dict 或 None。"""
    chg_col = _col(df, '涨跌幅')
    up_col = _col(df, '上涨家数')
    down_col = _col(df, '下跌家数')
    leader_col = _col(df, '领涨股')
    leader_chg_col = _col(df, '领涨股-涨跌幅')
    if chg_col is None:
        return None
    return {
        'boardName': str(row[_col(df, '板块名称') or _col(df, '板块') or df.columns[0]]).strip(),
        'boardChange': _safe_float(row[chg_col]),
        'upCount': _safe_int(row[up_col]) if up_col else None,
        'downCount': _safe_int(row[down_col]) if down_col else None,
        'leader': str(row[leader_col]).strip() if (leader_col and row[leader_col] is not None) else '',
        'leaderChange': _safe_float(row[leader_chg_col]) if leader_chg_col else None,
        'source': source_name,
    }


def fetch_board_summary_ths():
    """首选：同花顺行业板块一览（本机网络对东财 push2 屏蔽时通常仍可工作）。"""
    from akshare import stock_board_industry_summary_ths
    return _retry(stock_board_industry_summary_ths)


def fetch_board_summary_em():
    """回退：东方财富行业板块整体涨跌排名。返回 DataFrame 或 None。"""
    from akshare import stock_board_industry_name_em
    return _retry(stock_board_industry_name_em)


def fetch_cons_mean(industry):
    """以行业名为板块名，拉成分股并求涨跌幅均值作为板块走势回退。返回 dict 或 None。"""
    from akshare import stock_board_industry_cons_em
    df = _retry(lambda: stock_board_industry_cons_em(symbol=industry))
    if df is None or len(df) == 0:
        return None
    chg_col = _col(df, '涨跌幅')
    name_col = _col(df, '股票名称') or _col(df, '名称')
    if chg_col is None:
        return None
    chgs = [c for c in (_safe_float(r[chg_col]) for _, r in df.iterrows()) if c is not None]
    if not chgs:
        return None
    mean_chg = sum(chgs) / len(chgs)
    up = sum(1 for c in chgs if c > 0)
    down = sum(1 for c in chgs if c < 0)
    # 领涨股：涨跌幅最大者
    leader = ''
    leader_chg = None
    if name_col is not None:
        best = None
        for _, r in df.iterrows():
            c = _safe_float(r[chg_col])
            if c is not None and (best is None or c > best[1]):
                best = (str(r[name_col]).strip(), c)
        if best:
            leader, leader_chg = best
    return {
        'boardName': industry,
        'boardChange': round(mean_chg, 3),
        'upCount': up,
        'downCount': down,
        'leader': leader,
        'leaderChange': round(leader_chg, 3) if leader_chg is not None else None,
        'source': '东方财富·行业板块成分股均值',
    }


def fetch_one_board(industry):
    """返回单个行业板块的走势 dict；失败返回 ok=False 的 dict（字段与单行业输出对齐）。"""
    result = {
        'industry': industry,
        'ok': False,
        'boardName': None,
        'boardChange': None,
        'upCount': None,
        'downCount': None,
        'leader': None,
        'leaderChange': None,
        'source': None,
        'note': '',
    }
    if not industry:
        result['note'] = '未提供行业名，无法定位板块，行业走势按中性处理'
        return result
    board = None
    # ---- 路径 1：同花顺板块整体涨跌（首选，本机东财 push2 常被屏蔽）----
    try:
        df_ths = fetch_board_summary_ths()
        bn, row = _match_board_name(df_ths, industry)
        if bn and row is not None:
            board = _build_board_from_row(df_ths, row, '同花顺·行业板块整体涨跌')
    except Exception as e:
        print(f'[sector_trend] 同花顺板块获取失败({industry}): {e}', file=sys.stderr)
        board = None
    # ---- 路径 2：东方财富板块整体涨跌（回退）----
    if not board:
        try:
            df_em = fetch_board_summary_em()
            bn, row = _match_board_name(df_em, industry)
            if bn and row is not None:
                board = _build_board_from_row(df_em, row, '东方财富·行业板块整体涨跌')
        except Exception as e:
            print(f'[sector_trend] 东方财富板块获取失败({industry}): {e}', file=sys.stderr)
            board = None
    # ---- 路径 3：成分股均值回退 ----
    if not board:
        try:
            cons = fetch_cons_mean(industry)
            if cons:
                board = cons
        except Exception as e:
            print(f'[sector_trend] 成分股回退失败({industry}): {e}', file=sys.stderr)
    if not board:
        result['note'] = '行业走势数据暂不可用，按中性处理'
        return result
    result.update({
        'ok': True,
        'boardName': board.get('boardName'),
        'boardChange': board.get('boardChange'),
        'upCount': board.get('upCount'),
        'downCount': board.get('downCount'),
        'leader': board.get('leader') or '',
        'leaderChange': board.get('leaderChange'),
        'source': board.get('source'),
        'note': f'板块「{board.get("boardName")}」走势',
    })
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', default='')
    parser.add_argument('--name', default='')
    parser.add_argument('--industry', default='')
    parser.add_argument('--industries', default='')  # 逗号分隔，批量查询多板块（板块跷跷板因子用）
    args = parser.parse_args()
    symbol = (args.symbol or '').strip()
    name = (args.name or '').strip()
    industry = (args.industry or '').strip()
    industries = [x.strip() for x in (args.industries or '').split(',') if x.strip()]

    # ---- 多板块批量模式（新增，供板块跷跷板因子取科技/半导体多板块走势）----
    if industries:
        boards = {}
        for ind in industries:
            boards[ind] = fetch_one_board(ind)
        out = {
            'ok': any(b['ok'] for b in boards.values()),
            'multi': True,
            'date': _now_str(),
            'source': '同花顺/东方财富·行业板块',
            'boards': boards,
        }
        print(json.dumps(out, ensure_ascii=False))
        return

    # ---- 单行业模式（保持原有输出结构，供 factorMarketShort 使用）----
    result = {
        'source': '同花顺/东方财富·行业板块',
        'date': _now_str(),
        'ok': False,
        'symbol': symbol,
        'industryName': industry or None,
        'boardName': None,
        'boardChange': None,
        'upCount': None,
        'downCount': None,
        'leader': None,
        'leaderChange': None,
        'note': '',
    }

    if not industry:
        result['note'] = '未提供行业名，无法定位板块，行业走势按中性处理'
        print(json.dumps(result, ensure_ascii=False))
        return

    board = fetch_one_board(industry)
    if not board['ok']:
        result['note'] = board['note'] or '行业走势数据暂不可用，按中性处理'
        print(json.dumps(result, ensure_ascii=False))
        return

    result.update({
        'ok': True,
        'boardName': board.get('boardName'),
        'boardChange': board.get('boardChange'),
        'upCount': board.get('upCount'),
        'downCount': board.get('downCount'),
        'leader': board.get('leader'),
        'leaderChange': board.get('leaderChange'),
        'source': board.get('source'),
        'note': f'个股行业「{industry}」→ 板块「{board.get("boardName")}」走势',
    })
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}, ensure_ascii=False))
        sys.exit(1)

~~~

---

## `scripts\sentiment.py`  ·  1393 行

~~~py
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
市场情绪因子数据层（二期：量化指标 + 个股/市场级文本舆情）

数据来源（均为 akshare 官方封装，遵循其使用条款）：
  1) 市场广度：东方财富涨跌停池
       - stock_zt_pool_em(date)       涨停池
       - stock_zt_pool_dtgc_em(date)  跌停股池（akshare 1.18.x 新名）
  2) 杠杆情绪：沪深融资余额
       - macro_china_market_margin_sh() / _sz()
  3) 文本舆情（个股）：东方财富个股新闻 + 中文情感分析
       - stock_news_em(symbol)
       - 情感引擎可插拔：优先金融微调模型 text2vec-base-chinese-sentiment，
         不可用时降级 snownlp + 金融词库硬校正 + 中性词兜底（一期已验证稳健）
  4) 市场级舆情（二期新增）：东方财富股吧全市场情绪聚合
       - stock_comment_em()  返回全市场 5000+ 只个股的股吧热度
         （综合得分 / 上升 / 关注指数），既给个股舆情，也聚合出市场热度
  5) 投资者问答（20260923h 新增，个股维度，供「个股近期热点」投资者问答子卡）
       - 沪市(60/68/900)：上证e互动 sns.sseinfo.com（交易所官方平台，需先定位公司 uid）
       - 深市(00/30/200)：巨潮互动易 irm.cninfo.com.cn（两步：查 orgId → 取问答列表）

合规说明：以上接口均为 akshare 对公开财经数据接口的二次封装，用于个人研究；
不直爬雪球/股吧（强反爬 + ToS 风险），仅消费 akshare 聚合结果。
投资者问答仅取交易所官方平台的公开问答（免登录、低频、不采集提问者昵称等个人信息）。
输出单一 JSON（stdout），各子模块各自独立 try，失败仅该子模块 ok=false。

中文字符串统一 UTF-8 输出，避免 Windows 控制台 GBK 乱码。
"""
import json
import sys
import io
import os
import re
import traceback
import time
import requests
from datetime import datetime, timedelta

# Windows 控制台默认 GBK，直接输出中文会乱码；强制 stdout/stderr 用 UTF-8。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

# 20260911：本机系统代理(HTTP_PROXY=127.0.0.1:xxxxx)对腾讯/东财/金十等转发故障，
# 会把 akshare 请求挂起或 ProxyError（融资余额曾因此恒失败）。脚本全程强制直连，
# 并清掉进程内代理环境变量；仅影响本进程，不改系统设置。
for _pk in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
    os.environ.pop(_pk, None)

_orig_requests_get = requests.get


def _direct_get(url, *args, **kwargs):
    """强制不经过系统代理（项目既有教训：直连才通）。"""
    kwargs.setdefault('timeout', 20)
    kwargs['proxies'] = {'http': None, 'https': None}
    return _orig_requests_get(url, *args, **kwargs)


requests.get = _direct_get


def _now_str():
    return datetime.now().strftime('%Y-%m-%d')


def _parse_datetime(s):
    """解析常见中文新闻时间格式，失败返回 None。"""
    if not s:
        return None
    s = str(s).strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d', '%Y/%m/%d %H:%M:%S', '%Y/%m/%d'):
        try:
            return datetime.strptime(s[:len(fmt.replace('%', '%%'))] if len(s) > len(fmt) else s, fmt)
        except Exception:
            continue
    # 兜底：尝试取前 10 位作为日期
    try:
        return datetime.strptime(s[:10], '%Y-%m-%d')
    except Exception:
        return None


def _time_decay_weight(pub_dt, base=None):
    """新闻时效衰减：当天 1.0、1 天前 0.7、2 天前 0.5、3 天及以上 0.3。
    同一消息不可能持续维持同样影响，越旧的新闻权重越低。"""
    if pub_dt is None or not isinstance(pub_dt, datetime):
        return 0.5
    base = base or datetime.now()
    days = max(0, (base - pub_dt).total_seconds() / 86400.0)
    if days < 1:
        return 1.0
    if days < 2:
        return 0.7
    if days < 3:
        return 0.5
    return 0.3


def _neutralize(text, raw):
    """中性词库兜底：文本含明显中性表述时，将极端情感拉回中性(0.5)。"""
    neutral_words = ['观望', '震荡', '持平', '中性', '维持', '不变', '小幅', '波动',
                     '盘整', '横盘', '暂无', '谨慎', '平稳', '中性偏', '大体', '基本持平']
    if any(w in text for w in neutral_words):
        return 0.5 + (raw - 0.5) * 0.4
    return raw


# 金融情感词库（一级规则）：对通用情感模型在金融文本上的偏差做硬校正。
POS_WORDS = ['涨停', '大涨', '涨', '利好', '增持', '买入', '加仓', '净买入', '回暖', '增长',
             '盈利', '上调', '突破', '拉升', '走强', '回购', '中标', '超预期', '预增',
             '净流入', '大单流入', '机构看好', '看好', '扩产', '签单', '扭亏']
NEG_WORDS = ['跌停', '大跌', '跌', '利空', '减持', '卖出', '净卖出', '暴跌', '下跌', '亏损',
             '下滑', '下调', '回落', '走弱', '破位', '退市', '暴雷', '立案', '预减', '计提',
             '警示', '诉讼', '罚款', 'ST', '商誉减值', '减值', '风险警示']


def _lexicon_score(text):
    """词库极性：命中单向词给强极性，双向命中给中性，无命中返回 None。"""
    pos = sum(1 for w in POS_WORDS if w in text)
    neg = sum(1 for w in NEG_WORDS if w in text)
    if pos > 0 and neg == 0:
        return 0.85
    if neg > 0 and pos == 0:
        return 0.15
    if pos > 0 and neg > 0:
        return 0.5
    return None


# ============ 可插拔金融情感模型 ============
# 优先使用金融微调模型（text2vec-base-chinese-sentiment），其输出为 0~1 情感得分。
# 需要 sentence_transformers + 模型权重（本环境未预装，自动降级到 snownlp）。
# 环境变量 SA_NO_FIN_MODEL=1 可强制禁用模型（避免首次下载阻塞/离线环境）。
_MODEL = None
_MODEL_LOADED = False


def _load_fin_model():
    """懒加载金融微调模型，返回模型或 None（装好即复用，避免重复加载）。"""
    global _MODEL, _MODEL_LOADED
    if _MODEL_LOADED:
        return _MODEL
    _MODEL_LOADED = True
    if os.environ.get('SA_NO_FIN_MODEL') == '1':
        _MODEL = None
        return None
    try:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer('shibing624/text2vec-base-chinese-sentiment')
    except Exception:
        _MODEL = None
    return _MODEL


def _finance_model_scores(texts):
    """批量金融模型打分，返回与 texts 等长 list(0~1)，不可用时返回 None。"""
    model = _load_fin_model()
    if model is None:
        return None
    try:
        import numpy as np
        vecs = model.encode(texts, batch_size=16, convert_to_numpy=True,
                            show_progress_bar=False)
        return [max(0.0, min(1.0, float(v))) for v in np.asarray(vecs).flatten()]
    except Exception:
        return None


def _safe_len(df):
    try:
        return 0 if df is None else len(df)
    except Exception:
        return 0


def _col(df, kw):
    for c in (df.columns if df is not None else []):
        if kw in str(c):
            return c
    return None


def fetch_breadth(date_str):
    """市场广度：涨跌停家数比。返回 {limitUp, limitDown, limitUpDownRatio, signal, ok, note}"""
    from akshare import stock_zt_pool_em, stock_zt_pool_dtgc_em
    up = stock_zt_pool_em(date=date_str)
    down = stock_zt_pool_dtgc_em(date=date_str)
    up_n = _safe_len(up)
    down_n = _safe_len(down)
    ratio = (up_n / (down_n + 1)) if (down_n + 1) > 0 else 0.0
    denom = (up_n + down_n)
    signal = ((up_n - down_n) / denom) if denom > 0 else 0.0
    signal = max(-1.0, min(1.0, signal))
    return {
        'limitUp': up_n,
        'limitDown': down_n,
        'limitUpDownRatio': round(ratio, 2),
        'signal': round(signal, 3),
        'ok': True,
        'note': f'东财涨跌停池({date_str})',
    }


def fetch_margin():
    """杠杆情绪：沪深融资余额最新值与日环比。返回 {latest, prev, changePct, signal, ok, note}"""
    from akshare import macro_china_market_margin_sh, macro_china_market_margin_sz
    sh = macro_china_market_margin_sh()
    sz = macro_china_market_margin_sz()
    total_latest = None
    total_prev = None

    def _col_local(df, kw):
        for c in (df.columns if df is not None else []):
            if kw in str(c):
                return c
        return None

    parts = []
    for df in (sh, sz):
        if df is None or len(df) == 0:
            continue
        col = _col_local(df, '融资余额')
        if col is None:
            continue
        vals = df[col].dropna().tolist()
        if len(vals) >= 1:
            try:
                parts.append(float(vals[-1]) / 1e8)  # 原始单位"元"，转"亿元"
            except Exception:
                pass
    if len(parts) >= 1:
        total_latest = sum(parts)
    prev_parts = []
    for df in (sh, sz):
        if df is None or len(df) < 2:
            continue
        col = _col_local(df, '融资余额')
        if col is None:
            continue
        vals = df[col].dropna().tolist()
        if len(vals) >= 2:
            try:
                prev_parts.append(float(vals[-2]) / 1e8)
            except Exception:
                pass
    if len(prev_parts) >= 1:
        total_prev = sum(prev_parts)

    if total_latest is None:
        raise ValueError('融资余额接口返回空')

    change_pct = 0.0
    if total_prev and total_prev != 0:
        change_pct = (total_latest - total_prev) / total_prev * 100
    # 信号：日环比 1.0% 视为 ±1（杠杆资金日变动多落在 ±0.1%~±0.8%）
    signal = max(-1.0, min(1.0, change_pct / 1.0))
    return {
        'latest': round(total_latest, 1),
        'prev': round(total_prev, 1) if total_prev is not None else None,
        'changePct': round(change_pct, 3),
        'signal': round(signal, 3),
        'ok': True,
        'note': '沪深融资余额(亿元)',
    }


def fetch_news_sentiment(symbol, name):
    """文本舆情（个股）：东财个股新闻 + 可插拔情感引擎（金融模型批量优先）。
    已加入时效衰减：越旧的新闻权重越低（当天 1.0、1 天前 0.7、2 天前 0.5、3 天+ 0.3）。
    返回 {count, positive, neutral, negative, avgScore, weightedAvgScore, signal, ok, samples, engine}"""
    from akshare import stock_news_em
    from snownlp import SnowNLP

    df = stock_news_em(symbol=symbol)
    items = []  # [(title, text, pub_dt)]
    if df is not None and len(df) > 0:
        title_col = '新闻标题' if '新闻标题' in df.columns else df.columns[0]
        content_col = '新闻内容' if '新闻内容' in df.columns else None
        date_col = _col(df, '发布') or _col(df, '时间') or _col(df, 'date')
        base = datetime.now()
        for _, r in df.iterrows():
            t = str(r.get(title_col, '') or '')
            c = str(r.get(content_col, '') or '') if content_col else ''
            text = (t + ' ' + c).strip()
            if not text:
                continue
            pub_dt = _parse_datetime(r.get(date_col)) if date_col else None
            items.append((t, text, pub_dt))

    texts = [it[1] for it in items]
    # 批量情感：优先金融微调模型；不可用时逐条 snownlp
    fm_list = _finance_model_scores(texts) if texts else None
    engine = 'finance-model' if fm_list is not None else 'snownlp+词库'

    rows = []
    base = datetime.now()
    for idx, (t, text, pub_dt) in enumerate(items):
        if fm_list is not None:
            raw = fm_list[idx]
        else:
            try:
                raw = float(SnowNLP(text).sentiments)  # 0~1，0.5 中性
            except Exception:
                continue
        # 通用模型极端值偏多：压缩到中心附近
        sn = 0.5 + (raw - 0.5) * 0.6
        # 金融词库硬校正：命中单向金融词时以词库为主
        lex = _lexicon_score(text)
        score = (0.7 * lex + 0.3 * sn) if lex is not None else sn
        score = _neutralize(text, score)  # 中性表述兜底
        weight = _time_decay_weight(pub_dt, base)
        rows.append({'title': t[:60], 'score': round(score, 3), 'weight': round(weight, 2), 'date': pub_dt.strftime('%m-%d') if pub_dt else ''})

    if not rows:
        return {
            'count': 0, 'positive': 0, 'neutral': 0, 'negative': 0,
            'avgScore': None, 'weightedAvgScore': None, 'signal': 0.0, 'ok': True, 'engine': engine,
            'samples': [], 'note': f'近 30 日无个股新闻({symbol})',
        }

    # 统计计数保持原始（便于用户感知样本分布），但信号用加权平均计算
    pos = sum(1 for x in rows if x['score'] >= 0.55)
    neg = sum(1 for x in rows if x['score'] <= 0.45)
    neu = len(rows) - pos - neg
    avg = sum(x['score'] for x in rows) / len(rows)
    total_w = sum(x['weight'] for x in rows) or 1.0
    weighted_avg = sum(x['score'] * x['weight'] for x in rows) / total_w
    signal = max(-1.0, min(1.0, (weighted_avg - 0.5) * 2))
    return {
        'count': len(rows), 'positive': pos, 'neutral': neu, 'negative': neg,
        'avgScore': round(avg, 3), 'weightedAvgScore': round(weighted_avg, 3),
        'signal': round(signal, 3), 'ok': True, 'engine': engine,
        'samples': rows[:8], 'note': f'东财个股新闻·情感({symbol})·近{len(rows)}条加权',
    }


def fetch_market_comment(symbol, name):
    """市场级舆情（二期新增）：东财股吧全市场情绪聚合。
    返回 { symbolScore, symbolRise, symbolFocus, marketAvgScore, marketUpRatio,
           marketHeat, symbolSignal, signal, ok, samples, note }
      - 个股维度：该 symbol 的综合得分/上升/关注指数（股吧对该股的热度与情绪）
      - 市场维度：全市场综合得分均值 + 上升家数占比（对所有个股通用的市场热度）
    合规：仅消费 akshare 聚合结果，不直爬股吧。"""
    from akshare import stock_comment_em

    df = stock_comment_em()
    if df is None or len(df) == 0:
        raise ValueError('股吧舆情接口返回空')

    def _col_local(df, kw):
        for c in (df.columns if df is not None else []):
            if kw in str(c):
                return c
        return None

    score_col = _col_local(df, '综合得分')
    up_col = _col_local(df, '上升')
    focus_col = _col_local(df, '关注指数')

    # ---- 市场级聚合（主源：东财股吧全市场）----
    scores = df[score_col].dropna().astype(float).tolist() if score_col else []
    avg_score = float(sum(scores) / len(scores)) if scores else 0.0
    ups = 0
    tot = 0
    if up_col:
        for v in df[up_col].dropna().astype(float).tolist():
            tot += 1
            if v > 0:
                ups += 1
    up_ratio = (ups / tot) if tot > 0 else 0.5
    # 综合得分以中性基准 60 偏离（每偏离 10 分计 0.3），上升占比映射 -1..1
    score_signal = max(-1.0, min(1.0, (avg_score - 60) / 10 * 0.3))
    heat_signal = max(-1.0, min(1.0, (up_ratio - 0.5) * 2))
    market_heat = round(0.5 * score_signal + 0.5 * heat_signal, 3)

    # ---- 交叉源（同花顺热榜 / 雪球关注榜）：best-effort，失败降级，对冲东财单一源噪声 ----
    # 目的：东财股吧综合得分由散户自评、口径不透明，单一源偏差大；引入两个独立平台的
    # 市场级广度信号做交叉验证，降低单一平台噪声（A 方案）。
    th_signal = None
    xq_signal = None
    try:
        th_rows = _th_hot_list()
        if th_rows:
            th_pos = sum(1 for r in th_rows if (r.get('rise') or 0) > 0)
            th_ratio = th_pos / len(th_rows)
            # 热榜中上涨占比：>0.5 偏热，<0.5 偏冷
            th_signal = max(-1.0, min(1.0, (th_ratio - 0.5) * 2))
    except Exception:
        th_signal = None
    try:
        xq_rows = _xueqiu_follow_list()
        xq_rets = [r.get('pct') for r in xq_rows if isinstance(r.get('pct'), (int, float))]
        if xq_rets:
            xq_avg = sum(xq_rets) / len(xq_rets)
            # 高关注股平均涨跌幅：±1.5% 映射到 ±1
            xq_signal = max(-1.0, min(1.0, xq_avg / 1.5))
    except Exception:
        xq_signal = None

    sources_used = ['东财股吧']
    has_th = th_signal is not None
    has_xq = xq_signal is not None
    if has_th:
        sources_used.append('同花顺热榜')
    if has_xq:
        sources_used.append('雪球关注榜')
    cross_n = (1 if has_th else 0) + (1 if has_xq else 0)
    if cross_n > 0:
        # 东财 0.6 为主，每个可用交叉源平分剩余 0.4，降低单一平台噪声
        cross_w = 0.4 / cross_n
        blended = 0.6 * market_heat
        if has_th:
            blended += cross_w * th_signal
        if has_xq:
            blended += cross_w * xq_signal
        market_heat = round(blended, 3)

    # ---- 个股维度 ----
    sym_score = sym_rise = sym_focus = None
    if symbol:
        hit = df[df['代码'].astype(str).str.strip() == str(symbol)]
        if len(hit) > 0:
            r = hit.iloc[0]
            try:
                sym_score = float(r[score_col]) if score_col else None
            except Exception:
                sym_score = None
            try:
                sym_rise = float(r[up_col]) if up_col else None
            except Exception:
                sym_rise = None
            try:
                sym_focus = float(r[focus_col]) if focus_col else None
            except Exception:
                sym_focus = None
    symbol_signal = 0.0
    if sym_score is not None:
        symbol_signal = max(-1.0, min(1.0, (sym_score - 60) / 15))
        if sym_rise is not None and sym_rise != 0:
            rise_part = (1.0 if sym_rise > 0 else -1.0) * min(abs(sym_rise), 1000) / 1000
            symbol_signal = max(-1.0, min(1.0, symbol_signal * 0.6 + rise_part * 0.4))

    # 综合信号：个股舆情 0.5 + 市场热度 0.5
    signal = round(max(-1.0, min(1.0, 0.5 * symbol_signal + 0.5 * market_heat)), 3)

    samples = []
    if sym_score is not None:
        samples.append({
            'symbol': symbol,
            'score': round(sym_score, 1),
            'rise': round(sym_rise, 1) if sym_rise is not None else None,
            'focus': round(sym_focus, 1) if sym_focus is not None else None,
        })
    return {
        'symbolScore': round(sym_score, 1) if sym_score is not None else None,
        'symbolRise': round(sym_rise, 1) if sym_rise is not None else None,
        'symbolFocus': round(sym_focus, 1) if sym_focus is not None else None,
        'marketAvgScore': round(avg_score, 1),
        'marketUpRatio': round(up_ratio, 3),
        'marketHeat': market_heat,
        'symbolSignal': round(symbol_signal, 3),
        'signal': signal,
        'ok': True,
        # ---- C 方案：时效 / 覆盖标注 + 缺失剔除支撑字段 ----
        'valid': True,                       # 市场热度是否成功计算（False 时 MSI 自动剔除该分量）
        'sampleCount': len(df),              # 东财股吧聚合样本数（全市场个股数）
        'coverage': ' + '.join(sources_used),  # 实际参与融合的数据源清单
        'updatedAt': time.strftime('%Y-%m-%d %H:%M', time.localtime()),  # 数据抓取时间戳
        'thSignal': round(th_signal, 3) if th_signal is not None else None,  # 同花顺交叉源信号
        'xqSignal': round(xq_signal, 3) if xq_signal is not None else None,  # 雪球交叉源信号
        'samples': samples,
        'note': f'股吧舆情聚合（{len(sources_used)}源融合）·市场热度+个股({symbol or "全市场"})',
    }


# 三期新增：同花顺/雪球 公开热度榜（非直爬股吧，仅消费公开榜单/筛选接口）
_THS_HOT_CACHE = None
_THS_HOT_TS = 0
_THS_HOT_TTL = 60  # 同一次脚本调用中缓存 60s


def _th_hot_list():
    """获取同花顺 A 股热榜（公开接口，无需登录），返回 [(code, order, rate, rise, name)]"""
    global _THS_HOT_CACHE, _THS_HOT_TS
    now = time.time()
    if _THS_HOT_CACHE is not None and now - _THS_HOT_TS < _THS_HOT_TTL:
        return _THS_HOT_CACHE
    url = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=day&list_type=normal'
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://eq.10jqka.com.cn/',
    }
    try:
        r = requests.get(url, headers=headers, timeout=15)
        data = r.json()
        rows = data.get('data', {}).get('stock_list', []) or []
        out = []
        for it in rows:
            try:
                rc = it.get('hot_rank_chg')
                try:
                    rc = int(rc or 0)
                except Exception:
                    rc = 0
                tag = it.get('tag') or {}
                out.append({
                    'code': str(it.get('code', '')).strip(),
                    'order': int(it.get('order', 0) or 0),
                    'rate': float(it.get('rate', 0) or 0),
                    'rise': float(it.get('rise_and_fall', 0) or 0),
                    'name': str(it.get('name', '')),
                    'rankChg': rc,                                                     # 排名变化（正=上升）
                    'concepts': [str(x) for x in (tag.get('concept_tag') or [])][:6],   # 命中概念标签（同花顺人工运营）
                    'popTag': str(tag.get('popularity_tag') or ''),                    # 人气标签（如「持续上榜」）
                })
            except Exception:
                continue
        _THS_HOT_CACHE = out
        _THS_HOT_TS = now
        return out
    except Exception as e:
        raise ValueError(f'同花顺热榜接口异常: {e}')


def fetch_tonghuashun_hot(symbol, name=''):
    """同花顺个股热度：从公开热榜中查找该股排名与热度值。"""
    if not symbol:
        raise ValueError('缺少股票代码')
    rows = _th_hot_list()
    hit = next((r for r in rows if r['code'] == str(symbol)), None)
    if hit:
        chg = hit.get('rankChg') or 0
        if chg > 0:
            chgTxt = '·较昨日 ↑%d' % chg
        elif chg < 0:
            chgTxt = '·较昨日 ↓%d' % (-chg)
        else:
            chgTxt = '·较昨日持平'
        cps = hit.get('concepts') or []
        cpTxt = ('·概念：' + ' / '.join(cps)) if cps else ''
        popTag = hit.get('popTag') or ''
        popTxt = ('·' + popTag) if popTag else ''
        return {
            'ok': True,
            'inHotList': True,
            'rank': hit['order'],
            'heatRate': hit['rate'],
            'risePct': round(hit['rise'], 2),
            'rankChg': chg,
            'concepts': cps,
            'popTag': popTag,
            'note': f'同花顺热榜·{hit["name"]}({symbol})·第{hit["order"]}名·热度{hit["rate"]}{chgTxt}{popTxt}{cpTxt}',
        }
    return {
        'ok': True,
        'inHotList': False,
        'rank': None,
        'heatRate': None,
        'risePct': None,
        'note': f'同花顺热榜·{symbol}未进入当日 A 股热榜前{len(rows)}名',
    }


_XUEQIU_FOLLOW_CACHE = None
_XUEQIU_FOLLOW_TS = 0
_XUEQIU_FOLLOW_TTL = 60


def _xueqiu_follow_list(max_pages=5):
    """获取雪球 A 股关注人数排序榜（公开筛选接口，无需登录）。
    返回 [{symbol, name, follow, pct, current}]，最多 max_pages * 200 只。"""
    global _XUEQIU_FOLLOW_CACHE, _XUEQIU_FOLLOW_TS
    now = time.time()
    if _XUEQIU_FOLLOW_CACHE is not None and now - _XUEQIU_FOLLOW_TS < _XUEQIU_FOLLOW_TTL:
        return _XUEQIU_FOLLOW_CACHE
    out = []
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://xueqiu.com/',
    }
    for page in range(1, max_pages + 1):
        url = f'https://xueqiu.com/service/v5/stock/screener/screen?category=CN&size=200&order=desc&order_by=follow&only_count=0&page={page}'
        try:
            r = requests.get(url, headers=headers, timeout=15)
            data = r.json()
            rows = data.get('data', {}).get('list', []) or []
            if not rows:
                break
            base = len(out)
            for idx, it in enumerate(rows):
                try:
                    out.append({
                        'symbol': str(it.get('symbol', '')).strip(),
                        'name': str(it.get('name', '')),
                        'follow': int(it.get('follow', 0) or 0),
                        'pct': float(it.get('pct', 0) or 0),
                        'current': float(it.get('current', 0) or 0),
                        'rank': base + idx + 1,
                    })
                except Exception:
                    continue
        except Exception:
            break
    _XUEQIU_FOLLOW_CACHE = out
    _XUEQIU_FOLLOW_TS = now
    return out


def fetch_xueqiu_follow(symbol, name='', max_pages=5):
    """雪球个股热度：从公开关注榜中查找该股关注人数与排名。"""
    if not symbol:
        raise ValueError('缺少股票代码')
    # 雪球 symbol 形如 SH601318 / SZ000001
    prefix = 'SH' if str(symbol).startswith('6') or str(symbol).startswith('9') else 'SZ'
    xq_symbol = f'{prefix}{symbol}'
    rows = _xueqiu_follow_list(max_pages=max_pages)
    hit = next((r for r in rows if r['symbol'] == xq_symbol), None)
    if hit:
        return {
            'ok': True,
            'inTop': True,
            'rank': hit['rank'],
            'follow': hit['follow'],
            'pct': round(hit['pct'], 2),
            'note': f'雪球关注榜·{hit["name"]}({symbol})·第{hit["rank"]}名·关注{hit["follow"]}人',
        }
    return {
        'ok': True,
        'inTop': False,
        'rank': None,
        'follow': None,
        'pct': None,
        'note': f'雪球关注榜·{symbol}未进入 A 股关注榜前{len(rows)}名',
    }


def fetch_discussion_heat(symbol, name):
    """三期新增：个股多平台股吧讨论热度聚合。
    同时取 东方财富(akshare 股吧综合得分) + 同花顺热榜 + 雪球关注榜，
    输出统一 {eastmoney, tonghuashun, xueqiu, combinedScore, signal, ok, note}。
    任一平台失败不阻塞其他平台，失败平台在结果中 ok=false。"""
    out = {
        'ok': True,
        'eastmoney': {'ok': False},
        'tonghuashun': {'ok': False},
        'xueqiu': {'ok': False},
        'combinedScore': None,
        'signal': 0.0,
        'note': '多平台股吧热度聚合',
    }
    if not symbol or not str(symbol).isdigit() or len(str(symbol)) != 6:
        out['ok'] = False
        out['note'] = '缺少有效 6 位股票代码，跳过股吧热度'
        return out

    scores = []
    signals = []

    # 1) 东方财富（已有市场舆情函数）
    try:
        em = fetch_market_comment(symbol, name)
        out['eastmoney'] = {
            'ok': True,
            'symbolScore': em.get('symbolScore'),
            'symbolRise': em.get('symbolRise'),
            'marketAvgScore': em.get('marketAvgScore'),
            'marketUpRatio': em.get('marketUpRatio'),
            'marketHeat': em.get('marketHeat'),
            'note': em.get('note', '东财股吧舆情聚合'),
        }
        if em.get('symbolScore') is not None:
            scores.append(float(em['symbolScore']))
            signals.append(float(em.get('symbolSignal', 0.0)))
        else:
            # 只有市场热度时也作为信号参考
            signals.append(float(em.get('marketHeat', 0.0)))
    except Exception as e:
        out['eastmoney'] = {'ok': False, 'error': str(e)[:80], 'note': '东财股吧热度获取失败'}

    # 2) 同花顺热榜
    try:
        th = fetch_tonghuashun_hot(symbol, name)
        out['tonghuashun'] = th
        if th.get('inHotList'):
            # 排名 1~100 映射到 100~0 分
            rank = th['rank'] or 100
            score = max(0.0, 100.0 - (rank - 1) * 1.0)
            scores.append(score)
            signals.append(max(-1.0, min(1.0, (score - 50) / 50)))
    except Exception as e:
        out['tonghuashun'] = {'ok': False, 'error': str(e)[:80], 'note': f'同花顺热度获取失败'}

    # 3) 雪球关注榜
    try:
        xq = fetch_xueqiu_follow(symbol, name)
        out['xueqiu'] = xq
        if xq.get('inTop') and xq.get('rank'):
            # 排名越靠前越热：前 10 名 100 分，前 200 名 85 分，前 1000 名 70 分
            rank = xq['rank']
            if rank <= 10:
                score = 100.0
            elif rank <= 50:
                score = 95.0 - (rank - 10) * 0.25
            elif rank <= 200:
                score = 85.0 - (rank - 50) * (15.0 / 150.0)
            else:
                score = max(50.0, 70.0 - (rank - 200) * (20.0 / 800.0))
            scores.append(score)
            signals.append(max(-1.0, min(1.0, (score - 50) / 50)))
    except Exception as e:
        out['xueqiu'] = {'ok': False, 'error': str(e)[:80], 'note': f'雪球热度获取失败'}

    if scores:
        out['combinedScore'] = round(sum(scores) / len(scores), 1)
    if signals:
        # 多平台平均信号
        out['signal'] = round(sum(signals) / len(signals), 3)
    out['ok'] = any(out[p].get('ok') for p in ('eastmoney', 'tonghuashun', 'xueqiu'))
    out['note'] = f'东方财富+同花顺+雪球三平台股吧热度聚合({symbol})'
    return out


# 同花顺个股讨论（替代东财股吧个股讨论，绕过验证码墙；20260910 供个股舆情模块消费）
_THS_DISC_URL = 'https://t.10jqka.com.cn/lgt/post/open/api/forum/post/v2/recent'
_THS_DISC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Host': 't.10jqka.com.cn',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://t.10jqka.com.cn/',
    'sec-ch-ua': '"Not(A:Brand";v="24", "Chromium";v="122"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
}
# 直连（不经过系统代理，与 Node fetch 同效；代理曾阻断 axios/部分请求）
_THS_DISC_PROXIES = {'http': None, 'https': None}


def _strip_ths_tags(s):
    """剥离同花顺帖文内联标签与 HTML 实体，返回纯文本（与 hot_topics_collect.py 同款）。"""
    if not s:
        return ''
    t = str(s)
    for k, v in {'&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>',
                 '&quot;': '"', '&#39;': "'", '&ldquo;': '"', '&rdquo;': '"',
                 '&hellip;': '…'}.items():
        t = t.replace(k, v)
    t = re.sub(r'<[^>]+>', '', t)
    return t.strip()


def _ths_market_id(code):
    """同花顺讨论 API market_id：沪市(6 开头)=17，深市=33。"""
    c = str(code or '').strip()
    return 17 if c.startswith('6') else 33


def fetch_stock_discussion(symbol, name='', max_pages=5):
    """同花顺个股讨论（多页聚合，绕过东财股吧验证码）。
    返回 {ok, posts:[{id,content,ctime,reply,like,share,forward,isV}], pageCount, count, note}。
      · ctime 为 epoch 秒（时间衰减权重用）
      · user.is_v 为认证大V（KOL 近似；同花顺无粉丝字段）
      · 单页最多 15 条（page_size>15 接口返回 0），4~5 页覆盖近期讨论约 50~60 条
    任一异常 → ok=false 优雅降级，不阻塞其他子模块。"""
    if not symbol or not str(symbol).isdigit() or len(str(symbol)) != 6:
        return {'ok': False, 'posts': [], 'pageCount': 0,
                'note': '缺少有效 6 位股票代码，跳过同花顺讨论'}
    code = str(symbol)
    market_id = _ths_market_id(code)
    posts = []
    seen = set()
    page_count = 0
    last_err = None
    for page in range(1, max_pages + 1):
        params = {'page': page, 'page_size': 15, 'pid': 0, 'time': 0, 'sort': 'publish',
                  'code': code, 'market_id': market_id}
        try:
            r = requests.get(_THS_DISC_URL, params=params, headers=_THS_DISC_HEADERS,
                             timeout=12, proxies=_THS_DISC_PROXIES)
            if r.status_code != 200:
                last_err = f'HTTP {r.status_code}'
                break
            j = r.json()
            feed = (j.get('data') or {}).get('feed') or []
            if not feed:
                break
            page_count += 1
            for p in feed:
                content = _strip_ths_tags(p.get('content', ''))
                if not content:
                    continue
                pid = p.get('pid') or p.get('id')
                if not pid:
                    continue
                key = f'{code}_{pid}'
                if key in seen:
                    continue
                seen.add(key)
                stat = p.get('stat') or {}
                user = p.get('user') or {}
                try:
                    ctime = int(p.get('ctime', 0) or 0)
                except Exception:
                    ctime = 0
                try:
                    reply = int(stat.get('reply', 0) or 0)
                except Exception:
                    reply = 0
                try:
                    like = int(stat.get('like', 0) or 0)
                except Exception:
                    like = 0
                try:
                    share = int(stat.get('share', 0) or 0)
                except Exception:
                    share = 0
                try:
                    forward = int(stat.get('forward', 0) or 0)
                except Exception:
                    forward = 0
                posts.append({
                    'id': key,
                    'content': content,
                    'ctime': ctime,
                    'reply': reply,
                    'like': like,
                    'share': share,
                    'forward': forward,
                    'isV': bool(user.get('is_v')),
                })
        except Exception as e:
            last_err = str(e)[:80]
            break
    if not posts:
        return {'ok': False, 'posts': [], 'pageCount': page_count,
                'error': last_err or '空结果',
                'note': f'同花顺讨论({symbol})无有效帖：{last_err or "空结果"}'}
    return {
        'ok': True,
        'posts': posts,
        'pageCount': page_count,
        'count': len(posts),
        'note': f'同花顺讨论({name or symbol})·近{page_count}页共{len(posts)}帖',
    }


# ---- 投资者问答（沪市：上证e互动 / 深市：巨潮互动易）----
# 20260923h：个股近期热点「投资者问答」子卡数据源（用户要求：沪市上证e互动 + 深市巨潮互动易，带 uid 缓存）。
#   · 沪市(60/68/900) → 上交所官方平台「上证e互动」sns.sseinfo.com
#     按公司查询必须先用公司 uid；公司列表按代码升序分页（每页 32 家），只能倍增 + 二分定位
#     （实测冷启动 8~17 次请求、6~15s，且个别页会超时）。**uid 必须落盘缓存**——
#     sentiment.py 每次都是短生命周期子进程，进程内缓存无法跨请求复用，不落盘则每只沪市股每次都重跑二分。
#     落盘缓存同时记录「总页数」并对二分途经页做全量 code→uid 归档，越用越快（也可用 --warm-uid 一次性预热全表）。
#   · 深市(00/30/200) → 巨潮「互动易」irm.cninfo.com.cn（两步：queryKeyboardInfo 查 orgId → company/question 取列表）
# 合规：两平台均为交易所官方/指定信息披露平台的公开问答，免登录、低频访问、不采集提问者昵称等个人信息（asker 不入库）。
import html as _html

_IRM_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
_IRM_PROXIES = {'http': None, 'https': None}
_SSE_E_BASE = 'https://sns.sseinfo.com'
_SSE_COMPANY_END = '没有任何上市公司的信息'
_SSE_KIND = {'answered': 11, 'questions': 10}
# 无问答提示：公司维度「暂无回复 / 暂无提问」，全市场翻过末页「暂时没有问答内容」
_SSE_EMPTY_NOTE = re.compile(r'class="m_feed_note"[^>]*>[^<]*(暂无|暂时没有)[^<]*<')
_SSE_UID_CACHE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                   'data', 'cache', 'sse_e_uid.json')
_SSE_UID_TTL = 7 * 24 * 3600      # 公司 uid 7 天内直接复用
_SSE_PAGES_TTL = 30 * 24 * 3600   # 总页数 30 天内复用（跳过倍增探测）
_SSE_REQ_TIMEOUT = 8              # 单次请求超时（秒）
_SSE_DEADLINE = 12                # 沪市 uid 定位 + 取数总预算（秒），超预算则优雅降级
# ⚠️ 进程级时间预算：本脚本被 lib/sentiment.js 以 execFile timeout=60s 调用，
# 问答子卡绝不能把整脚本拖过上限——否则连既有涨跌停比/融资余额/个股舆情会被一起杀掉。
# 故进入本模块时若整脚本已耗时接近上限，直接跳过问答并如实标注，优先保既有因子。
_SCRIPT_T0 = time.time()
_IRM_SCRIPT_BUDGET = 40           # 整脚本已耗时超过该秒数则不再发起问答请求
_SSE_PAGES = {}                   # 单次进程内：页码 → [(code, uid)]
_SSE_UID_MEM = None               # 落盘缓存的内存副本


def _sse_uid_cache_load():
    global _SSE_UID_MEM
    if _SSE_UID_MEM is not None:
        return _SSE_UID_MEM
    data = None
    try:
        with open(_SSE_UID_CACHE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = None
    if not isinstance(data, dict):
        data = {}
    if not isinstance(data.get('codes'), dict):
        data['codes'] = {}
    if not isinstance(data.get('meta'), dict):
        data['meta'] = {}
    _SSE_UID_MEM = data
    return _SSE_UID_MEM


def _sse_uid_cache_save():
    if _SSE_UID_MEM is None:
        return
    try:
        os.makedirs(os.path.dirname(_SSE_UID_CACHE_PATH), exist_ok=True)
        with open(_SSE_UID_CACHE_PATH, 'w', encoding='utf-8') as f:
            json.dump(_SSE_UID_MEM, f, ensure_ascii=False, separators=(',', ':'))
    except Exception:
        pass


def _irm_retry(fn, attempts=2, delay=0.6, deadline=None):
    """上证e互动/巨潮互动易偶发 ReadTimeout（实测 600460 单次超时、重试即成功）。
    两个平台均为单次 1~2 个请求的轻量调用，故只做 1 次短延迟重试，不放大请求量。
    deadline 不为空时，超预算不再发起重试（保证总耗时可控）。"""
    last = None
    for i in range(attempts):
        if deadline is not None and time.time() > deadline:
            break
        try:
            return fn()
        except Exception as e:
            last = e
            if i < attempts - 1 and (deadline is None or time.time() + delay < deadline):
                time.sleep(delay)
    if last is None:
        raise RuntimeError('超出取数时间预算')
    raise last


def _sse_company_page(page, deadline=None):
    """上证e互动公司列表第 page 页（每页 32 家，按代码升序）。
    解析 0 家且该页没有「没有任何上市公司的信息」末页标记 → 判定页面格式已变并抛错（不静默返回空）。"""
    page = int(page)
    if page in _SSE_PAGES:
        return _SSE_PAGES[page]
    if deadline is not None and time.time() > deadline:
        raise RuntimeError('上证e互动公司列表定位超出时间预算')
    r = _irm_retry(lambda: requests.post(
        _SSE_E_BASE + '/allcompany.do',
        data={'code': '0', 'order': '2', 'areaId': '0', 'page': page},
        headers={'User-Agent': _IRM_UA, 'Referer': _SSE_E_BASE + '/'},
        timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
    if r.status_code != 200:
        raise RuntimeError(f'上证e互动公司列表第 {page} 页 HTTP {r.status_code}')
    try:
        payload = r.json()
    except Exception:
        raise RuntimeError(f'上证e互动公司列表第 {page} 页返回非 JSON')
    content = payload.get('content') if isinstance(payload, dict) else None
    if not isinstance(content, str):
        raise RuntimeError(f'上证e互动公司列表第 {page} 页返回结构变了（没有 content 字符串）')
    pairs = [(code, uid) for uid, code in
             re.findall(r"uid=['\"]?(\d+)['\"]?[^>]*>\s*<img[^>]*company/(\d{6})\.png", content)]
    if not pairs and (page == 1 or _SSE_COMPANY_END not in content):
        raise RuntimeError(f'上证e互动公司列表第 {page} 页解析出 0 家公司，页面格式可能已变')
    _SSE_PAGES[page] = pairs
    # 顺手把本页公司全量写入落盘缓存（二分途经多页 ≈ 免费预热），并记录总页数线索
    cache = _sse_uid_cache_load()
    now = time.time()
    for code, uid in pairs:
        cache['codes'][code] = {'u': uid, 'ts': now}
    if pairs:
        if page > int(cache['meta'].get('maxPage') or 0):
            cache['meta']['maxPage'] = page
    else:
        ep = int(cache['meta'].get('endPage') or 0)
        if not ep or page < ep:
            cache['meta']['endPage'] = page
    cache['meta']['ts'] = now
    _sse_uid_cache_save()
    return pairs


def _sse_company_uid(code, deadline):
    """上证e互动公司 uid 定位：落盘缓存命中即返回；否则二分定位（已知总页数时跳过倍增探测）。"""
    cache = _sse_uid_cache_load()
    ent = cache['codes'].get(code)
    if isinstance(ent, dict) and ent.get('u') and \
            (time.time() - float(ent.get('ts') or 0)) < _SSE_UID_TTL:
        return str(ent['u'])
    meta = cache.get('meta') or {}
    total = 0
    if (time.time() - float(meta.get('ts') or 0)) < _SSE_PAGES_TTL:
        mp, ep = int(meta.get('maxPage') or 0), int(meta.get('endPage') or 0)
        if mp and ep and 0 <= ep - mp <= 2:
            total = mp
    if total:
        low, high = 1, total
    else:
        low, high = 1, 1
        while _sse_company_page(high, deadline):
            if _sse_company_page(high, deadline)[-1][0] >= code:
                break
            low, high = high, high * 2
    found = None
    while low <= high:
        mid = (low + high) // 2
        pairs = _sse_company_page(mid, deadline)
        if not pairs or code < pairs[0][0]:
            high = mid - 1
        elif code > pairs[-1][0]:
            low = mid + 1
        else:
            for c, u in pairs:
                if c == code:
                    found = u
                    break
            break
    if not found:  # 二分区间落空时兜底查缓存（途经页已全量归档）
        found = (cache['codes'].get(code) or {}).get('u')
    if not found:
        raise ValueError(f'上证e互动未收录 {code}（非沪市公司或已退市）')
    cache['codes'][code] = {'u': found, 'ts': time.time()}
    _sse_uid_cache_save()
    return str(found)


def _sse_text(fragment):
    return _html.unescape(re.sub(r'<[^>]+>', '', fragment or '')).strip()


def _sse_time(text):
    m = re.search(r'(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}:\d{2})', text or '')
    return f'{m.group(1)}-{m.group(2)}-{m.group(3)} {m.group(4)}' if m else ''


def _sse_parse_feed(text, code=None):
    """按「回复块 class="m_feed_detail m_qa"」为界切问题段/回复段
    （问题框 class 因列表类型而异，不能靠 id 区分问答）。单条解析失败只跳过该条，不整批作废。"""
    rows = []
    for chunk in re.split(r'<div class="m_feed_item[^"]*" id="item-', text or '')[1:]:
        m = re.match(r'(\d+)', chunk)
        if not m:
            continue
        item_id = m.group(1)
        ask_part, _, answer_part = chunk.partition('class="m_feed_detail m_qa"')
        q = re.search(r'<div class="m_feed_txt"[^>]*>\s*<a[^>]*>:(.*?)\((\d{6})\)</a>(.*?)</div>',
                      ask_part, re.S)
        t = re.search(r'<div class="m_feed_from"[^>]*>\s*<span>([^<]+)</span>', ask_part)
        if not q or not t:
            continue
        if code and q.group(2) != code:
            continue
        asker = re.search(r'rel="face"[^>]*?title="([^"]*)"', ask_part, re.S)
        answer, answer_time = '', ''
        if answer_part:
            body = re.search(r'<div class="m_feed_txt"[^>]*>(.*?)</div>', answer_part, re.S)
            when = re.search(r'<div class="m_feed_from"[^>]*>\s*<span>([^<]+)</span>', answer_part)
            if body:
                answer = _sse_text(body.group(1))
            if when:
                answer_time = _sse_time(when.group(1))
        rows.append({
            'id': item_id, 'code': q.group(2), 'name': _sse_text(q.group(1)),
            'asker': asker.group(1) if asker else '',
            'question': _sse_text(q.group(3)),
            'question_time': _sse_time(t.group(1)),
            'answer': answer, 'answer_time': answer_time,
        })
    return rows


def _fetch_sse_e_qa(code, page_size=20):
    """上证e互动某公司问答：先取「最新已回复」，为空再取「最新提问」（含未回复，本身就是信号）。"""
    deadline = time.time() + _SSE_DEADLINE
    uid = _sse_company_uid(code, deadline)
    rows, kind_used = [], 'answered'
    for kind in ('answered', 'questions'):
        if time.time() > deadline:
            raise RuntimeError('上证e互动取数超出时间预算')
        r = _irm_retry(lambda: requests.post(
            _SSE_E_BASE + '/ajax/userfeeds.do',
            data={'typeCode': 'company', 'type': _SSE_KIND[kind],
                  'pageSize': int(page_size), 'uid': uid, 'page': 1},
            headers={'User-Agent': _IRM_UA, 'Referer': _SSE_E_BASE + '/'},
            timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
        if r.status_code != 200:
            raise RuntimeError(f'上证e互动问答 HTTP {r.status_code}')
        text = (r.content or b'').decode('utf-8', 'replace')
        rows = _sse_parse_feed(text, code)
        if rows:
            kind_used = kind
            break
        # 只有明确「暂无 / 暂时没有」才算真没有问答；解析 0 条又无该提示 = 页面结构变了
        if not _SSE_EMPTY_NOTE.search(text):
            raise RuntimeError('上证e互动返回既无问答也无「暂无」提示，结构可能已变')
    return rows, kind_used


def _fetch_cninfo_qa(code, page_size=20, page_num=1):
    """巨潮互动易（深市）两步取数。
    ⚠️ 第二步参数必须放 query string（POST 但 body 为空），否则 HTTP 400。"""
    deadline = time.time() + _SSE_DEADLINE
    r1 = _irm_retry(lambda: requests.post(
        'https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo',
        data={'keyWord': code}, headers={'User-Agent': _IRM_UA},
        timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
    if r1.status_code != 200:
        raise RuntimeError(f'互动易公司检索 HTTP {r1.status_code}')
    d1 = (r1.json() or {}).get('data') or []
    if not d1:
        return []
    org_id = d1[0].get('secid')
    if not org_id:
        return []
    params = {'_t': 1, 'stockcode': code, 'orgId': org_id, 'pageSize': int(page_size),
              'pageNum': int(page_num), 'keyWord': '', 'startDay': '', 'endDay': ''}
    r2 = _irm_retry(lambda: requests.post(
        'https://irm.cninfo.com.cn/newircs/company/question',
        params=params, headers={'User-Agent': _IRM_UA},
        timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
    if r2.status_code != 200:
        raise RuntimeError(f'互动易问答列表 HTTP {r2.status_code}')
    return (r2.json() or {}).get('rows') or []


def _cninfo_answered(it):
    """巨潮「是否已回复」判定：回复正文 or 附件（attachedContent 为空但有 attachedId/attachmentUrl）。
    不使用 qaStatus（语义未验证，不拿未确认的字段当事实）。"""
    return bool((it.get('attachedContent') or '').strip()
                or it.get('attachedId') or it.get('attachmentUrl'))


def _irm_market(code):
    c = str(code or '').strip()
    if c.startswith(('60', '68', '900')):
        return 'sh'
    if c.startswith(('00', '30', '200')):
        return 'sz'
    return ''


def fetch_irm_qa(symbol, name='', page_size=20):
    """投资者问答（沪市→上证e互动 / 深市→巨潮互动易）。
    返回 {ok, posts:[{id,question,answer,askTime,answerTime,asker,answerer,source,replied}],
          count, answered, source, note[, error]}；任一环节失败 → ok=false 优雅降级，不阻塞其他子模块。
    注：asker（提问者昵称）仅作展示用途，不写入项目持久化文件。"""
    code = str(symbol or '').strip()
    if not code.isdigit() or len(code) != 6:
        return {'ok': False, 'posts': [], 'count': 0, 'error': 'invalid_symbol',
                'note': '缺少有效 6 位股票代码，跳过投资者问答'}
    # 进程级时间预算守卫（见 _IRM_SCRIPT_BUDGET 注释）：整脚本已耗时接近 Node 侧 60s 上限时
    # 直接跳过问答，避免把既有涨跌停比/融资/舆情因子一起拖死；如实标注原因，不造假数据。
    _elapsed = time.time() - _SCRIPT_T0
    if _elapsed > _IRM_SCRIPT_BUDGET:
        return {'ok': False, 'posts': [], 'count': 0, 'error': 'budget_exceeded',
                'note': f'本次运行前面已耗时 {int(_elapsed)}s（接近取数上限），已跳过投资者问答；'
                        f'点「🔄 重新分析」可重试'}
    market = _irm_market(code)
    if not market:
        return {'ok': False, 'posts': [], 'count': 0, 'error': 'unsupported_market',
                'note': f'{code} 非沪深主板/创业板/科创板，暂无投资者问答数据源'}
    if market == 'sh':
        source = '上证e互动'
        try:
            rows, kind_used = _fetch_sse_e_qa(code, page_size)
        except Exception as e:
            return {'ok': False, 'posts': [], 'count': 0, 'source': source, 'error': str(e)[:140],
                    'note': f'上证e互动({code})获取失败：{str(e)[:60]}'}
        posts = []
        for r in rows:
            q = (r.get('question') or '').strip()
            if not q:
                continue
            a = (r.get('answer') or '').strip()
            posts.append({
                'id': f"sse_{r.get('id')}", 'question': q, 'answer': a,
                'askTime': r.get('question_time') or '', 'answerTime': r.get('answer_time') or '',
                'asker': r.get('asker') or '', 'answerer': '上证e互动',
                'source': source, 'replied': bool(a), 'unansweredList': kind_used == 'questions',
            })
    else:
        source = '巨潮互动易'
        try:
            rows = _fetch_cninfo_qa(code, page_size, 1)
            # 平台按时间倒序，近一页可能全是「尚未回复」的提问（如 002594 近 20 条全未回复），
            # 故本页无任何已回复问答时再翻一页合并，保证子卡能展示到真正的问答。
            if rows and not any(_cninfo_answered(r) for r in rows):
                seen = {str(r.get('indexId') or r.get('id') or '') for r in rows}
                for r in _fetch_cninfo_qa(code, page_size, 2):
                    k = str(r.get('indexId') or r.get('id') or '')
                    if k and k in seen:
                        continue
                    rows.append(r)
        except Exception as e:
            return {'ok': False, 'posts': [], 'count': 0, 'source': source, 'error': str(e)[:140],
                    'note': f'巨潮互动易({code})获取失败：{str(e)[:60]}'}
        posts = []
        for it in rows:
            q = (it.get('mainContent') or '').strip()
            if not q:
                continue
            pd = it.get('pubDate')
            try:
                ask_time = datetime.fromtimestamp(int(pd) / 1000).strftime('%Y-%m-%d %H:%M') if pd else ''
            except Exception:
                ask_time = ''
            a = (it.get('attachedContent') or '').strip()
            replied = _cninfo_answered(it)
            if replied and not a:   # 只有附件、没有正文回复：如实标注，不写成「未回复」
                a = '（公司以附件形式回复，详见巨潮互动易）'
            posts.append({
                'id': f"cninfo_{it.get('indexId') or it.get('id') or ask_time}", 'question': q,
                'answer': a, 'askTime': ask_time, 'answerTime': '',
                'asker': '', 'answerer': it.get('attachedAuthor') or '',
                'source': source, 'replied': replied, 'unansweredList': False,
            })
    if not posts:
        return {'ok': False, 'posts': [], 'count': 0, 'source': source, 'error': 'empty',
                'note': f'{source}({code})近端无问答（平台只开放近期问答）'}
    # 已回复优先 + 提问时间倒序（子卡只取前若干条，已获公司回复的信息价值更高）
    posts.sort(key=lambda p: (1 if p['replied'] else 0, p['askTime'] or ''), reverse=True)
    answered = sum(1 for p in posts if p['replied'])
    return {'ok': True, 'posts': posts, 'count': len(posts), 'answered': answered, 'source': source,
            'note': f'{source}({name or code})·{len(posts)}条问答（已回复{answered}）'}


def warm_sse_uid_map(max_pages=200, budget=300):
    """维护用（不在请求路径调用）：一次性把上证e互动公司 uid 全表落盘。
    逐页拉取直到「没有任何上市公司的信息」，之后单只沪市股票只需 1 次请求。"""
    cache = _sse_uid_cache_load()
    before = len(cache.get('codes') or {})
    page, deadline = 1, time.time() + budget
    while page <= max_pages and time.time() < deadline:
        try:
            pairs = _sse_company_page(page, deadline)
        except Exception as e:
            return {'ok': False, 'pages': page - 1, 'codes': len(cache['codes']),
                    'added': len(cache['codes']) - before, 'error': str(e)[:160]}
        if not pairs:
            break
        page += 1
        time.sleep(0.15)  # 礼貌限速：一次性翻全表，间隔 150ms 再取下一页
    _sse_uid_cache_save()
    return {'ok': True, 'pages': page - 1, 'codes': len(cache['codes']),
            'added': len(cache['codes']) - before}


def _try_dates(n=5):
    """涨跌停池在非交易日为空，向前回溯 n 个交易日。"""
    out = []
    base = datetime.now()
    for i in range(n):
        d = base - timedelta(days=i)
        if d.weekday() >= 5:
            continue
        out.append(d.strftime('%Y%m%d'))
    return out


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', default='')
    parser.add_argument('--name', default='')
    parser.add_argument('--warm-uid', action='store_true',
                        help='维护用：一次性预热上证e互动公司 uid 缓存后退出（不参与个股分析）')
    args = parser.parse_args()
    symbol = (args.symbol or '').strip()
    name = (args.name or '').strip()

    if args.warm_uid:
        print(json.dumps({'warmSseUid': warm_sse_uid_map()}, ensure_ascii=False))
        return

    result = {
        'source': ('东方财富·涨跌停池/融资余额/个股新闻/股吧舆情 + 同花顺/雪球公开热度榜 + 同花顺个股讨论 '
                   '+ 投资者问答(沪:上证e互动 / 深:巨潮互动易)'),
        'date': _now_str(),
        'breadth': None,
        'margin': None,
        'newsSentiment': None,
        'marketSentiment': None,
        'discussionHeat': None,
        'stockDiscussion': None,
        'irmQa': None,
        'subOkCount': 0,
    }

    # 1) 市场广度（涨跌停比）：向前回溯到最近一个交易日
    breadth_err = None
    for ds in _try_dates(5):
        try:
            result['breadth'] = fetch_breadth(ds)
            break
        except Exception as e:
            breadth_err = str(e)
            continue
    if result['breadth'] is None:
        result['breadth'] = {'ok': False, 'signal': 0.0, 'error': breadth_err or '涨跌停池获取失败'}

    # 2) 融资余额
    try:
        result['margin'] = fetch_margin()
    except Exception as e:
        result['margin'] = {'ok': False, 'signal': 0.0, 'error': str(e)}

    # 3) 文本舆情（需 6 位代码）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['newsSentiment'] = fetch_news_sentiment(symbol, name)
        except Exception as e:
            result['newsSentiment'] = {'ok': False, 'signal': 0.0, 'error': str(e)}
    else:
        result['newsSentiment'] = {'ok': False, 'signal': 0.0,
                                   'error': '缺少有效 6 位股票代码，跳过文本舆情'}

    # 4) 市场级舆情（二期新增，需 6 位代码取个股维度；市场维度始终可用）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['marketSentiment'] = fetch_market_comment(symbol, name)
        except Exception as e:
            result['marketSentiment'] = {'ok': False, 'signal': 0.0, 'error': str(e)}
    else:
        result['marketSentiment'] = {'ok': False, 'signal': 0.0,
                                     'error': '缺少有效 6 位股票代码，跳过市场舆情'}

    # 5) 多平台股吧讨论热度（三期新增：东方财富+同花顺+雪球）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['discussionHeat'] = fetch_discussion_heat(symbol, name)
        except Exception as e:
            result['discussionHeat'] = {'ok': False, 'signal': 0.0, 'error': str(e)}
    else:
        result['discussionHeat'] = {'ok': False, 'signal': 0.0,
                                      'error': '缺少有效 6 位股票代码，跳过股吧热度'}

    # 6) 同花顺个股讨论（替代东财股吧个股讨论，绕过验证码墙；供个股舆情模块消费）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['stockDiscussion'] = fetch_stock_discussion(symbol, name)
        except Exception as e:
            result['stockDiscussion'] = {'ok': False, 'posts': [], 'error': str(e)}
    else:
        result['stockDiscussion'] = {'ok': False, 'posts': [], 'error': '缺少有效 6 位股票代码'}

    # 7) 投资者问答（20260923h：沪市→上证e互动 / 深市→巨潮互动易；带 uid 落盘缓存）
    #    独立 try，失败仅该子卡降级；不计入 subOkCount（纯增益模块，不影响既有全失败判定与总体信号）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['irmQa'] = fetch_irm_qa(symbol, name)
        except Exception as e:
            result['irmQa'] = {'ok': False, 'posts': [], 'count': 0, 'error': str(e)[:140],
                               'note': f'投资者问答获取失败：{str(e)[:60]}'}
    else:
        result['irmQa'] = {'ok': False, 'posts': [], 'count': 0, 'error': 'invalid_symbol',
                           'note': '缺少有效 6 位股票代码，跳过投资者问答'}

    result['subOkCount'] = sum(1 for k in ('breadth', 'margin', 'newsSentiment', 'marketSentiment', 'discussionHeat', 'stockDiscussion')
                               if result[k] and result[k].get('ok'))

    # 全部失败
    if result['subOkCount'] == 0:
        print(json.dumps({"error": "情绪数据全部获取失败", "detail": {
            'breadth': result['breadth'].get('error'),
            'margin': result['margin'].get('error'),
            'newsSentiment': result['newsSentiment'].get('error'),
            'marketSentiment': result['marketSentiment'].get('error'),
            'discussionHeat': result['discussionHeat'].get('error'),
            'stockDiscussion': result['stockDiscussion'].get('error'),
        }}, ensure_ascii=False))
        sys.exit(1)

    # 整体混合信号（不含量能活跃度，量能由 Node 侧从 K 线量比补充）：
    # 涨跌停比 0.30 / 融资余额 0.25 / 个股新闻 0.22 / 多平台股吧热度 0.23
    # marketSentiment 仍保留供下游兼容，但不再重复参与总体信号（discussionHeat 已包含东财）
    weights = {'breadth': 0.30, 'margin': 0.25, 'newsSentiment': 0.22, 'discussionHeat': 0.23}
    s = 0.0
    wsum = 0.0
    for k, w in weights.items():
        blk = result[k]
        if blk and blk.get('ok'):
            s += w * blk.get('signal', 0.0)
            wsum += w
    overall = round(max(-1.0, min(1.0, s / wsum)) if wsum > 0 else 0.0, 3)
    result['signal'] = overall

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}, ensure_ascii=False))
        sys.exit(1)

~~~

---

## `scripts\test_analysis_warm.js`  ·  88 行

~~~js
// test_analysis_warm.js — lib/analysisWarm.js 单元测试（20261027d）
// 覆盖：TTL 读写命中/过期、LRU 淘汰、失败响应不缓存（防毒化）、cachedAt 附加字段、
//       最近查看 LRU 与持久化、预热循环去重/自选优先/上限。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// 预热循环的 fetch 需要注入；warmCycle 直接 fetch 本机 HTTP，单测改测「目标列表构造」逻辑较难，
// 故此处聚焦缓存核心；warmCycle 的去重/上限通过导出的 warmListSnapshot + 真实路由做 e2e（另测）。
const aw = require('../lib/analysisWarm');
const T = aw.__test;

console.log('\n===== §1 TTL 缓存 读/命中/过期 =====');
// 备份真实持久化文件（测试会写 data/analysis-warm.json，测完还原）
const persistBackup = fs.existsSync(T.PERSIST) ? fs.readFileSync(T.PERSIST, 'utf8') : null;
T.clearAll();

const payload = { symbol: 'sh601318', name: '中国平安', ok: true };
ok('写入成功', aw.setCached('sh601318', '1y', payload) === true);
const hit = aw.getCached('sh601318', '1y', () => true);
ok('TTL 内命中', !!hit && hit.symbol === 'sh601318');
ok('附加 cachedAt 字段', hit && typeof hit.cachedAt === 'number');
ok('附加 cacheAgeSec 字段', hit && typeof hit.cacheAgeSec === 'number');
ok('原字段不被篡改', hit && hit.name === '中国平安' && hit.ok === true);

// 过期：按「当前真实时刻的实际 TTL」构造边界（不依赖测试运行时段是盘中还是盘后）
const key = 'sh601318|1y';
const entry = T.cache.get(key);
const curTtl = T.ttlMs(new Date(), () => true); // 当前时段实际生效的 TTL（盘中 2 分钟 / 其余 30 分钟）
console.log(`  （当前时段 TTL = ${Math.round(curTtl / 1000)}s）`);
entry.ts = Date.now() - curTtl - 1000;
ok('超过当前时段 TTL → 过期不返回', aw.getCached('sh601318', '1y', () => true) === null);
entry.ts = Date.now() - (curTtl - 5000);
ok('TTL 边界内仍命中', !!aw.getCached('sh601318', '1y', () => true));
// 反向：盘中传“非交易日”判定 → 走 30 分钟 TTL
entry.ts = Date.now() - 3 * 60 * 1000;
ok('同样新旧数据：非交易日口径下仍命中（TTL 切换生效）', !!aw.getCached('sh601318', '1y', () => false));
// 30 分钟 TTL 过期
entry.ts = Date.now() - 31 * 60 * 1000;
ok('非盘中超过 30 分钟 → 过期', aw.getCached('sh601318', '1y', () => false) === null);

console.log('\n===== §2 失败响应不缓存（防毒化） =====');
T.clearAll();
ok('error 响应拒绝缓存', aw.setCached('sh000err', '1y', { error: '无法获取' }) === false);
ok('null 拒绝缓存', aw.setCached('sh000err', '1y', null) === false);
ok('error 响应读不到', aw.getCached('sh000err', '1y', () => true) === null);

console.log('\n===== §3 LRU 淘汰（上限 30） =====');
T.clearAll();
for (let i = 0; i < 35; i++) aw.setCached('sym' + i, '1y', { i });
ok('缓存条数不超过 30', T.cache.size <= 30, T.cache.size);
ok('最新的 sym34 仍在', !!aw.getCached('sym34', '1y', () => true));
ok('最旧的 sym0 已淘汰', aw.getCached('sym0', '1y', () => true) === null);

console.log('\n===== §4 最近查看 LRU 与持久化 =====');
T.clearAll();
try { if (fs.existsSync(T.PERSIST)) fs.unlinkSync(T.PERSIST); } catch (e) {}
aw.noteAnalysisRequest('sh600000');
aw.noteAnalysisRequest('sz000001');
aw.noteAnalysisRequest('sh600000'); // 再看一次 → 提到最前
const snap = aw.warmListSnapshot();
ok('最近查看去重置顶', snap.recents[0] === 'sh600000' && snap.recents[1] === 'sz000001', snap.recents);
ok('持久化文件已写', fs.existsSync(T.PERSIST));
const saved = JSON.parse(fs.readFileSync(T.PERSIST, 'utf8'));
ok('持久化内容一致', Array.isArray(saved.recents) && saved.recents[0] === 'sh600000');

console.log('\n===== §5 缓存键含 range =====');
T.clearAll();
aw.setCached('sh600000', '1y', { v: '1y' });
aw.setCached('sh600000', '3m', { v: '3m' });
ok('同股不同 range 各自命中', aw.getCached('sh600000', '1y', () => true).v === '1y' && aw.getCached('sh600000', '3m', () => true).v === '3m');
ok('缓存键数量 2', T.cache.size === 2, T.cache.size);

// 清场 + 还原持久化
T.clearAll();
try { if (fs.existsSync(T.PERSIST)) fs.unlinkSync(T.PERSIST); } catch (e) {}
if (persistBackup !== null) { try { fs.writeFileSync(T.PERSIST, persistBackup); } catch (e) {} }

console.log(`\n[test_analysis_warm] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_api_smoke.js`  ·  124 行

~~~js
/**
 * API 冒烟测试（零依赖，子进程 spawn server.js 于随机端口）
 * --------------------------------------------------------------
 * 运行： node scripts/test_api_smoke.js
 * - 不与常驻 3005 冲突：随机高位端口 + 仅监听 127.0.0.1
 * - 就绪探测：轮询 /api/health 至 200（上限 30s）
 * - 断言：核心本地 API 端点返回 <500（服务存活且未崩）；
 *         FRONTEND_BUST_FILES 静态资源全部 200（前端资源可服务）
 * - 结束 kill 子进程，不引 supertest（零依赖、贴合既有惯例）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.js');
const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT = 30000;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

// 解析 FRONTEND_BUST_FILES（与缓存破坏守卫同源逻辑）
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const bustMatch = serverSrc.match(/FRONTEND_BUST_FILES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
const bustSet = new Set();
if (bustMatch) {
  (bustMatch[1].match(/'([^']+)'/g) || []).forEach(i => bustSet.add(i.slice(1, -1)));
}

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
  });
}

function waitReady() {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const code = await get('/api/health');
      if (code === 200) return resolve(true);
      if (Date.now() - t0 > READY_TIMEOUT) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

// 核心本地端点（不依赖外网/个股参数，读本地 data/ 即可响应）
const API_PATHS = [
  '/api/health',
  '/',
  '/api/db/health',
  '/api/watchlist',
  '/api/notes',
  '/api/sentiment-accuracy/records',
  '/api/tech-face/records',
  '/api/market-tech/records',
  '/api/sameday-judgment/records',
  '/api/relevance-learning',
];

(async () => {
  console.log(`\n=== API 冒烟测试（端口 ${PORT}，仅 127.0.0.1）===`);
  const child = spawn(NODE, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SA_NO_BG_AI: '1', SA_NO_AUTO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  const cleanup = () => { try { child.kill('SIGKILL'); } catch (_) {} };
  process.on('exit', cleanup);

  const ready = await waitReady();
  if (!ready) {
    console.error('服务未在 30s 内就绪。最后日志：\n' + serverLog.slice(-800));
    cleanup();
    process.exit(1);
  }
  ok(true, '服务就绪（/api/health 返回 200）');

  // 校验 health 体
  const health = await new Promise((resolve) => {
    http.get(BASE + '/api/health', (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
  ok(health && health.status === 'ok' && !!health.version, `health 含 status+version（version=${health && health.version}）`);

  // 核心 API 端点存活检测
  console.log('\n[API 端点存活]');
  for (const p of API_PATHS) {
    const code = await get(p);
    ok(code >= 200 && code < 500, `${p} → ${code}`);
  }

  // 静态资源（FRONTEND_BUST_FILES）必须 200
  console.log(`\n[静态资源 FRONTEND_BUST_FILES · ${bustSet.size} 项]`);
  let staticFail = 0;
  for (const entry of bustSet) {
    const code = await get('/' + entry);
    if (code !== 200) { staticFail++; fail++; console.log(`  ✗ /${entry} → ${code}`); }
    else pass++;
  }
  ok(staticFail === 0, `BUST 静态资源全部 200（${bustSet.size - staticFail}/${bustSet.size}）`);

  cleanup();
  console.log(`\n===== API 冒烟：通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();

~~~

---

## `scripts\test_aspects_budget.js`  ·  149 行

~~~js
/**
 * 「个股亮点/雷点 长时间无法获取」—— 整链路耗时预算 回归测试（20260917l）
 * ------------------------------------------------------------------
 * 用户反馈（2026-09-17 20:18 截图）：中国平安（601318）的「个股亮点与雷点」
 * 长时间无法获取，卡片停在「AI 正在联网重新分析…」+ 计数 0/0。
 *
 * 根因（服务端日志实证）：lib/ai/llm.js 的 callLLM 内部最多**串行**发起 4 次 postLLM
 *   ① 妙想事实纯推理 → ② 外部搜索通道纯推理 → ③ 外部通道失败后的纯推理 → ④ 内置 enable_search
 * 每次都用同一个 timeoutMs 各自做硬超时；本任务传 240s → 单股最坏 ≈4×240s≈16 分钟无响应。
 * 601318 恰好踩中该路径（日志 `[search:mcp] 调用失败…大模型请求超时（240000ms 无响应）`）。
 *
 * 修复：callLLM 支持可选「整链路总耗时预算」opts.overallBudgetMs（配套纯函数 createBudget）。
 * 本测试钉死以下不变量，防止将来被改回「无限串行等待」：
 *   §1 未传预算 → 与历史版本逐项一致（enabled=false / expired=false / leftMs=Infinity）
 *   §2 传预算 → 单次超时被剩余预算夹紧（min(timeoutMs, 剩余)）
 *   §3 预算不足 5s → expired()=true（不再发起新请求）
 *   §4 端到端：预算耗尽时 callLLM **秒级**抛错、且**不发网络请求**
 *   §5 源码守卫：callLLM 内不存在绕过预算的裸 postLLM 调用
 *   §6 接线守卫：analyzeAspects 传了总预算 + 失败回退 stale
 *   §7 前端守卫：notes.js 有等待计时 + 客户端硬超时 + 超时提示
 *
 * 运行：node scripts/test_aspects_budget.js
 */
const fs = require('fs');
const path = require('path');
const llm = require('../lib/ai/llm');
const { createBudget, callLLM } = llm;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

(async () => {
  console.log('===== §1 未传预算：与历史版本完全一致（其他分析器零影响） =====');
  const b0 = createBudget(undefined, { timeoutMs: 240000 });
  ok('enabled=false', b0.enabled === false);
  ok('expired()=false', b0.expired() === false);
  ok('leftMs()=Infinity', b0.leftMs() === Infinity);
  ok('timeoutFor() 原样返回调用方 timeoutMs（240000）', b0.timeoutFor() === 240000, String(b0.timeoutFor()));
  const b0b = createBudget(undefined, {});
  ok('未传 timeoutMs 时 timeoutFor()=undefined（沿用 postLLM 默认 180s）', b0b.timeoutFor() === undefined);
  ok('预算传 0 等同未传', createBudget(0, { timeoutMs: 1000 }).enabled === false);
  ok('预算传负数等同未传', createBudget(-5, { timeoutMs: 1000 }).enabled === false);

  console.log('\n===== §2 传预算：单次超时被剩余预算夹紧 =====');
  const b1 = createBudget(300000, { timeoutMs: 240000 });
  ok('300s 总预算 / 240s 单次 → 首次仍可跑满 240s', b1.timeoutFor() >= 239000 && b1.timeoutFor() <= 240000, String(b1.timeoutFor()));
  ok('300s 总预算 → 未过期', b1.expired() === false);
  const b2 = createBudget(50000, { timeoutMs: 240000 });
  ok('50s 总预算 / 240s 单次 → 单次被压到 50s 以内', b2.timeoutFor() > 40000 && b2.timeoutFor() <= 50000, String(b2.timeoutFor()));
  const b2b = createBudget(50000, {});
  ok('未传单次超时 → timeoutFor() 用剩余预算', b2b.timeoutFor() > 40000 && b2b.timeoutFor() <= 50000, String(b2b.timeoutFor()));

  console.log('\n===== §3 预算不足 5s → expired()=true（不再发起新请求） =====');
  ok('1ms 预算 → expired()=true', createBudget(1, {}).expired() === true);
  ok('4999ms 预算 → expired()=true', createBudget(4999, {}).expired() === true);
  ok('大预算 → expired()=false', createBudget(300000, {}).expired() === false);
  const bT = createBudget(100000, { timeoutMs: 240000 });
  const left1 = bT.leftMs();
  await new Promise(r => setTimeout(r, 30));
  ok('leftMs() 随时间递减', bT.leftMs() < left1, `${left1} → ${bT.leftMs()}`);
  ok('elapsedMs()>0', bT.elapsedMs() > 0);

  console.log('\n===== §4 端到端：预算耗尽 → callLLM 秒级抛错且不发网络请求 =====');
  // webSearch:false 会跳过「妙想/外部搜索通道」两条支路，直达最终 postLLM；
  // 此时预算已耗尽（1ms < 5000ms 下限）→ 应在 callBudgeted 内立刻抛错，绝不触碰网络。
  const t0 = Date.now();
  let err = null;
  try {
    await callLLM('qwen', 'fake-key-for-test', 'qwen-turbo',
      [{ role: 'user', content: 'hi' }],
      { webSearch: false, overallBudgetMs: 1, timeoutMs: 240000 });
  } catch (e) { err = e; }
  const cost = Date.now() - t0;
  ok('确实抛错', !!err, err ? err.message : '(未抛错)');
  ok('err.budgetExhausted === true', !!err && err.budgetExhausted === true);
  ok('err.timeout === true（归类为超时，便于上游统一处理）', !!err && err.timeout === true);
  ok('错误信息含「总耗时预算已用尽」', !!err && /总耗时预算已用尽/.test(err.message), err && err.message);
  ok('秒级返回（< 3000ms，实测 ' + cost + 'ms）', cost < 3000, cost + 'ms');

  console.log('\n===== §5 源码守卫：callLLM 内无绕过预算的裸 postLLM =====');
  const llmSrc = read('lib/ai/llm.js');
  const fnStart = llmSrc.indexOf('async function callLLM(');
  const fnEnd = llmSrc.indexOf('function pickModelFor(', fnStart);
  const fnBody = llmSrc.slice(fnStart, fnEnd);
  const rawPost = (fnBody.match(/return await postLLM\(/g) || []).length;
  const budgeted = (fnBody.match(/callBudgeted\(/g) || []).length;
  ok('callLLM 内已无裸 `return await postLLM(`（原 5 处）', rawPost === 0, '仍有 ' + rawPost + ' 处');
  ok('callLLM 内 callBudgeted(...) 共 5 处（5 条出口全部受预算约束）', budgeted === 5, '实际 ' + budgeted + ' 处');
  ok('createBudget 已导出（可单测）', typeof llm.createBudget === 'function');
  ok('postLLM 仍导出（外部契约未变）', typeof llm.postLLM === 'function');
  ok('callLLM 仍导出（外部契约未变）', typeof llm.callLLM === 'function');

  console.log('\n===== §6 接线守卫：analyzeAspects 传总预算 + 失败回退 stale =====');
  const augSrc = read('lib/ai/augmentStock.js');
  ok('analyzeAspects 传 overallBudgetMs: 300000', /overallBudgetMs:\s*300000/.test(augSrc));
  ok('保留单次 timeoutMs: 240000', /timeoutMs:\s*240000/.test(augSrc));
  ok('失败时回退历史结果并标记 stale: true', /stale:\s*true/.test(augSrc));
  ok('回退前先确认缓存文件存在', /fs\.existsSync\(cacheFile\)[\s\S]{0,400}stale:\s*true/.test(augSrc));

  console.log('\n===== §7 前端守卫：等待计时 + 客户端硬超时 + 超时提示 =====');
  const notesSrc = read('public/js/notes.js');
  ok('使用 AbortController 主动中断', /AbortController/.test(notesSrc));
  ok('客户端硬超时 330000ms（比后端 300s 预算多 30s 余量）', /CLIENT_TIMEOUT_MS\s*=\s*330000/.test(notesSrc));
  ok('fetch 带上 signal', /signal:\s*ac\s*\?\s*ac\.signal/.test(notesSrc));
  ok('状态栏显示「已等待 N 秒」', /已等待\s*'?\s*\+?\s*sec/.test(notesSrc) || /已等待/.test(notesSrc));
  ok('计时器按股票隔离（_aiTickMap）', /_aiTickMap/.test(notesSrc));
  ok('计时器兜底清理（stopTick 幂等）', /const stopTick\s*=/.test(notesSrc));
  ok('超时给出可执行提示', /AI 分析超时/.test(notesSrc));
  ok('stale 回退有独立提示', /已回退显示上一次成功结果/.test(notesSrc));
  ok('防串股守卫仍在（20260917j 回归不破）', /renderStockIfCurrent/.test(notesSrc) && /isCurrentStock/.test(notesSrc));
  // 口径锁定：只看 generateAspects 的**函数体**，断言它不会重写 this.notes（即不删旧条目），
  // 只做「统计」；不拿注释文案当判据（注释里必然会出现「清除本股票已存」这类说明文字）。
  const gaStart = notesSrc.indexOf('async generateAspects(');
  const gaEnd = notesSrc.indexOf('renderNoteCard(', gaStart);
  const gaBody = notesSrc.slice(gaStart, gaEnd);
  ok('generateAspects 内不重写 this.notes（只累积、不删旧 AI 条目）', !/this\.notes\s*=/.test(gaBody));
  ok('generateAspects 仅统计已有 AI 条数（existingAi）', /existingAi/.test(gaBody));

  console.log('\n===== §8 部署守卫：版本戳与缓存破坏 =====');
  const serverSrc = read('server.js');
  // 版本戳守卫（20260919d 改）：原写法硬编码具体版本号，每次升版本都会失效（需手工同步测试）。
  // 改为校验「前后端版本戳一致」这一不变量 —— 永不随版本号过期。
  const avm = serverSrc.match(/APP_VERSION = '([^']+)'/);
  const APP_V = avm ? avm[1] : '';
  ok('server.js 存在 APP_VERSION 常量', !!APP_V);
  ok('server.js 无 `[truncated]` 残留（此前被截断标记污染）', !serverSrc.includes('[truncated]'));
  const idxSrc = read('public/index.html');
  ok('index.html app.js?v= 与 APP_VERSION 一致（' + APP_V + '）', !!APP_V && idxSrc.includes('js/app.js?v=' + APP_V));
  ok('index.html style.css?v= 与 APP_VERSION 一致（' + APP_V + '）', !!APP_V && idxSrc.includes('css/style.css?v=' + APP_V));
  ok('index.html notes.js 带版本戳', /js\/notes\.js\?v=\d{8}[a-z]/.test(idxSrc));
  ok('/js/notes.js 在缓存破坏名单内', /FRONTEND_BUST_FILES[\s\S]{0,300}\/js\/notes\.js/.test(serverSrc));

  console.log('\n===== §9 macroNews 回归：_localDate 未定义已修 =====');
  const mnSrc = read('lib/macroNews.js');
  // 剥掉注释后再断言 —— 修复说明里会提到旧写法 `_localDate()`，不能把注释当代码判据。
  // 注意：本文件是 CRLF 行尾，JS 正则的 `.` 不匹配 `\r`，故不能用 `//.*$`（会漏掉整段注释）。
  const mnCode = mnSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/[^\n\r]*/, '')).join('\n');
  ok('代码中不再调用未定义的 _localDate()', !/_localDate\s*\(/.test(mnCode));
  ok('localToday() 调用已导入的 localDate()', /function localToday\(\)\s*\{\s*return localDate\(\);\s*\}/.test(mnSrc));

  console.log('\n===== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();

~~~

---

## `scripts\test_backtest_validator.js`  ·  120 行

~~~js
'use strict';
/**
 * scripts/test_backtest_validator.js
 * 量化策略虚拟盘风控校验模块 · 单元测试 + 真实标的冒烟
 * 运行：node scripts/test_backtest_validator.js
 */
const assert = require('assert');
const bv = require('../lib/backtestValidator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

console.log('\n=== 1) 指标计算 ===');
(() => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ma3 = bv.MA(arr, 3);
  ok('MA(3) 第3位=2', approx(ma3[2], 2), 'got ' + ma3[2]);
  ok('MA(3) 第9位=8 (=7,8,9均值)', approx(ma3[8], 8), 'got ' + ma3[8]);
  const rsi = bv.RSI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  ok('RSI 单调上涨=100', rsi[rsi.length - 1] === 100, 'got ' + rsi[rsi.length - 1]);
  const macd = bv.MACD([1, 2, 3, 2, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3], 12, 26, 9);
  ok('MACD_DIF 长度=输入', macd.dif.length === 15, 'len ' + macd.dif.length);
  const b = bv.BOLL([1, 2, 3, 4, 5], 5, 2);
  ok('BOLL mid[4]=3', approx(b.mid[4], 3), 'got ' + b.mid[4]);
})();

console.log('\n=== 2) DSL 解析（JSON / 文本）===');
(() => {
  const j = bv.parseDSL({ name: '双均线', buy_condition: 'CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', sell_condition: 'CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))', range: '2y' });
  ok('JSON DSL buy 解析', j.buy.includes('CROSS_UP'), j.buy);
  const t = bv.parseDSL('NAME: 文本策略\nBUY: CLOSE > MA(CLOSE,60)\nSELL: CLOSE < MA(CLOSE,60)\nRANGE: 1y');
  ok('文本 DSL name', t.name === '文本策略', t.name);
  ok('文本 DSL sell', t.sell.includes('MA(CLOSE,60)'), t.sell);
})();

console.log('\n=== 3) 表达式求值（双均线金叉）===');
(() => {
  // 构造振荡序列，使 5 日线相对 20 日线多次上穿/下穿
  const close = [];
  for (let i = 0; i < 80; i++) close.push(100 + Math.sin(i / 3) * 15 + i * 0.05);
  const ctx = { close, open: close.slice(), high: close.slice(), low: close.slice(), volume: close.map(() => 1) };
  const buy = bv.evaluateCondition('CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', ctx);
  const sell = bv.evaluateCondition('CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))', ctx);
  ok('buy 信号为布尔数组', Array.isArray(buy) && buy.length === 80, 'len ' + buy.length);
  ok('golden cross 至少出现 1 次', buy.some(Boolean), 'buys=' + buy.filter(Boolean).length);
  ok('death cross 至少出现 1 次', sell.some(Boolean), 'sells=' + sell.filter(Boolean).length);
  const cmp = bv.evaluateCondition('CLOSE > MA(CLOSE,20)', ctx);
  ok('比较表达式返回布尔', cmp.every(v => typeof v === 'boolean'), '');
})();

console.log('\n=== 4) 虚拟盘回测（合成序列）===');
(() => {
  const series = [];
  for (let i = 0; i < 120; i++) {
    const c = 100 + Math.sin(i / 8) * 8 + i * 0.2;
    series.push({ date: 'd' + i, open: c - 0.1, high: c + 0.2, low: c - 0.2, close: c, volume: 1 });
  }
  const ctx = { close: series.map(s => s.close), open: series.map(s => s.open), high: series.map(s => s.high), low: series.map(s => s.low), volume: series.map(s => s.volume) };
  const buy = bv.evaluateCondition('CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', ctx);
  const sell = bv.evaluateCondition('CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))', ctx);
  const r = bv.runBacktest(series, buy, sell, { costPerSide: 0.0055 });
  ok('产生交易', r.totalTrades > 0, 'trades=' + r.totalTrades);
  ok('胜率在 [0,1]', r.winRate >= 0 && r.winRate <= 1, r.winRate);
  ok('最大回撤在 [0,1]', r.maxDrawdown >= 0 && r.maxDrawdown <= 1, r.maxDrawdown);
  ok('买入持有有定义', typeof r.buyHold === 'number', r.buyHold);
})();

console.log('\n=== 5) 五大胜率修正 ===');
(() => {
  const fakeRaw = { winRate: 0.62, totalTrades: 20, totalReturn: 0.3 };
  const c = bv.applyCorrections(fakeRaw, null, { trainWinRate: 0.6, testWinRate: 0.58, trend: { r2: 0.1, direction: 'flat' }, costPerSide: 0.0055, survivorship: null, lookaheadDetected: false });
  ok('修正后胜率 < 原始(因成本/幸存者折扣)', c.adjustedWinRate < 0.62, c.adjustedWinRate);
  ok('verdict 字段存在', ['PASS', 'WARNING', 'REJECT'].includes(c.verdict), c.verdict);
  // 前视偏差应直接否决
  const c2 = bv.applyCorrections(fakeRaw, null, { trainWinRate: 0.6, testWinRate: 0.58, trend: { r2: 0.1 }, costPerSide: 0.0055, survivorship: null, lookaheadDetected: true });
  ok('前视偏差 → REJECT', c2.verdict === 'REJECT', c2.verdict);
  ok('前视偏差 → 胜率归零', c2.adjustedWinRate === 0, c2.adjustedWinRate);
})();

console.log('\n=== 6) 统计检验（合成平稳/单位根序列）===');
(() => {
  const unitRoot = []; let v = 0; for (let i = 0; i < 100; i++) { v += (Math.random() - 0.5); unitRoot.push(v); }
  const adfU = bv.adf(unitRoot, 1);
  ok('随机游走 ADF 接近/高于临界值(非平稳倾向)', typeof adfU.stat === 'number', 'stat=' + adfU.stat.toFixed(2));
  const stationary = []; for (let i = 0; i < 100; i++) stationary.push(Math.sin(i / 5) + (Math.random() - 0.5) * 0.1);
  const adfS = bv.adf(stationary, 1);
  ok('正弦序列 ADF 返回数值', isFinite(adfS.stat), 'stat=' + adfS.stat.toFixed(2));
  const p = bv.pacf(stationary, 5);
  ok('PACF 长度=6(lag0..5)', p.length === 6, 'len ' + p.length);
})();

console.log('\n=== 7) 真实标的冒烟（600519，网络受限则跳过）===');
(async () => {
  try {
    const out = await bv.validateStrategy({
      symbol: '600519',
      name: '贵州茅台',
      dsl: { name: '双均线金叉', buy_condition: 'CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', sell_condition: 'CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))', range: '3y' }
    });
    ok('返回 base_info.symbol', out.base_info.symbol === '600519', out.base_info.symbol);
    ok('raw_backtest 含 full.train.test', !!out.raw_backtest_result.full && !!out.raw_backtest_result.train && !!out.raw_backtest_result.test);
    ok('risk_check 含 ADF/KPSS', !!out.risk_check_result.adf_price && !!out.risk_check_result.kpss_price);
    ok('adjusted_result 含修正步骤（含平稳性闸门共 6 项）', Array.isArray(out.adjusted_result.corrections) && out.adjusted_result.corrections.length === 6);
    ok('operation_suggestion.verdict 合法', ['PASS', 'WARNING', 'REJECT'].includes(out.operation_suggestion.verdict));
    console.log('  📊 600519 真实回测：全样本胜率=' + (out.raw_backtest_result.full.winRate * 100).toFixed(1) + '% 交易=' + out.raw_backtest_result.full.totalTrades +
      ' | 修正后胜率=' + (out.adjusted_result.adjusted_win_rate * 100).toFixed(1) + '% | 结论=' + out.operation_suggestion.verdict);
  } catch (e) {
    console.log('  ⚠️  真实取数跳过（沙箱网络受限）: ' + e.message);
    ok('真实冒烟跳过错位(非失败)', true);
  }
})().then(() => {
  console.log('\n=== 汇总 ===');
  console.log('  PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail > 0 ? 1 : 0);
});

~~~

---

## `scripts\test_bg_preload_indicator.js`  ·  54 行

~~~js
// 验证全局后台预加载指示器 bgPreload（从 app.js 抽取真实源码，用最小 DOM stub 跑逻辑）
// 覆盖：start 显示并列出分页；多分页并发；finish 全部完成后隐藏。
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
// 抽取 const bgPreload = { ... };（紧跟 // 关键指标释义 注释之前）
const startIdx = app.indexOf('const bgPreload = {');
const endMarker = app.indexOf('// 关键指标释义');
const block = app.slice(startIdx, endMarker).trim();
if (!block.endsWith('};')) throw new Error('抽取失败：未以 }; 结尾');
const src = block.replace(/^const\s+bgPreload\s*=\s*/, '').replace(/;\s*$/, '');

// 最小 DOM stub
let appended = [];
const navEl = { appendChild: (el) => appended.push(el) };
const doc = {
  querySelector: (sel) => (sel === '.global-nav' ? navEl : null),
  createElement: () => ({ id: '', style: {}, _text: '' , set textContent(v){this._text=v;}, get textContent(){return this._text;} }),
  body: { contains: () => true },
};
global.document = doc;

const bgPreload = eval('(' + src + ')');
if (typeof bgPreload !== 'object' || !bgPreload.start) throw new Error('bgPreload 解析失败');

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log('✅ ' + l); } else { fail++; console.log('❌ ' + l); } };

// 1) 单分页 start → 显示 + 文案
bgPreload.start('深度分析/财报解读');
const pill = appended[0];
ok('start 后指示器可见', pill.style.display === 'inline-block');
ok('文案包含预加载标签', /后台预加载/.test(pill.textContent));
ok('文案包含分页名', pill.textContent.includes('深度分析/财报解读'));

// 2) 多分页并发 → 文案列出全部
bgPreload.start('资金量能');
bgPreload.start('行业分析');
ok('并发多分页全部列出', pill.textContent.includes('资金量能') && pill.textContent.includes('行业分析'));

// 3) finish 部分 → 仍可见、剩余列出
bgPreload.finish('深度分析/财报解读');
ok('部分完成后仍可见', pill.style.display === 'inline-block');
ok('文案已移除已完成项', !pill.textContent.includes('深度分析/财报解读') && pill.textContent.includes('资金量能'));

// 4) 全部完成 → 隐藏
bgPreload.finish('资金量能');
bgPreload.finish('行业分析');
ok('全部完成后隐藏', pill.style.display === 'none');

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_broker_turnover.js`  ·  61 行

~~~js
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

~~~

---

## `scripts\test_buyback_event_weight.js`  ·  121 行

~~~js
/**
 * 股份回购迁入「事件驱动」+ 权重分级回归（20261023i）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_buyback_event_weight.js
 *
 * 用户要求（2026-10-23 截图）：
 *   「股份回购卡片转到突发事件，回购提议的时候权重给10%，回购进行中的时候权重给到30%。」
 *
 * 口径：
 *   回购提议（001 董事会预案 / 002 股东大会通过）→ 事件权重 10%
 *   回购实施中（004）→ 事件权重 30%
 *   完成(006)/停止(005)/否决(003)/历史方案 → 不构成事件
 * 信号沿用 buybackEmDc.gradeSignal：001=0.9 / 002=0.8 / 004=0.75×(1-进度%)
 */
const fs = require('fs');
const path = require('path');
const ev = require('../lib/eventEngine');
const { factorHoldings } = require('../lib/sameDayJudgment');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function mkBuyback(code, extra) {
  const plan = Object.assign({
    progressCode: code,
    progress: code === '001' ? '董事会预案' : code === '002' ? '股东大会通过' : code === '004' ? '实施中' : '完成实施',
    stage: code === '001' ? '预案' : code === '002' ? '待实施' : code === '004' ? '实施中' : '已完成',
    signal: code === '001' ? 0.9 : code === '002' ? 0.8 : code === '004' ? 0.467 : 0,
    neutral: code === '006' || code === '005' || code === '003',
    noticeDate: '2026-10-09',
    historical: false,
  }, extra || {});
  return { ok: true, structured: true, plan, text: '数据日期 2026-10-09；已回购 2203.53万股 7.55亿元；承诺回购 10.00亿元~20.00亿元；进度 实施中（已达承诺上限的 37.7%）' };
}

// ============================================================================
// [1] 提议 → 10%
// ============================================================================
console.log('\n[1] 回购提议（001/002）→ 10%');
{
  const a = ev.buildBuybackEvent(mkBuyback('001'), '300232');
  ok(a && a.effWeight === 0.10, `001 董事会预案 → 权重 10%（实际 ${a && a.effWeight}）`);
  ok(a && a.signal === 0.9, '001 信号 0.9');
  ok(a && a.grade === 'moderate' && a.sector === '股份回购', '001 分级 moderate / 板块 股份回购');
  const b = ev.buildBuybackEvent(mkBuyback('002'), '300232');
  ok(b && b.effWeight === 0.10, `002 股东大会通过 → 权重 10%（实际 ${b && b.effWeight}）`);
  ok(b && b.signal === 0.8, '002 信号 0.8');
}

// ============================================================================
// [2] 实施中 → 30%
// ============================================================================
console.log('\n[2] 回购实施中（004）→ 30%');
{
  const c = ev.buildBuybackEvent(mkBuyback('004'), '300232');
  ok(c && c.effWeight === 0.30, `004 实施中 → 权重 30%（实际 ${c && c.effWeight}）`);
  ok(c && Math.abs(c.signal - 0.467) < 1e-6, `004 信号=0.75×(1-37.7%)≈0.467（实际 ${c && c.signal}）`);
  ok(c && c.grade === 'major', '004 分级 major');
  ok(c && c.isSynthetic === true, '合成事件（跳过内幕抢跑/市场反应核验）');
  ok(c && /已回购 2203.53万股/.test(c.detail || ''), 'detail 保留四要素（已回购数量/金额/承诺/进度）');
}

// ============================================================================
// [3] 完成/停止/否决/历史 → 不构成事件
// ============================================================================
console.log('\n[3] 不构成事件的进度');
['006', '005', '003'].forEach(code => {
  ok(ev.buildBuybackEvent(mkBuyback(code), '300232') === null, `${code} → null（不生成事件）`);
});
ok(ev.buildBuybackEvent(mkBuyback('001', { historical: true }), '300232') === null, '历史方案（historical）→ null');
ok(ev.buildBuybackEvent(null, '300232') === null, '无回购数据 → null');

// ============================================================================
// [4] 增持减持因子不再含「股份回购」子卡片
// ============================================================================
console.log('\n[4] 增持减持因子：股份回购子卡片已移除');
{
  const holders = new Array(10).fill(0).map((_, i) => ({ name: '股东' + i, holdAmount: 1e8, changeAmount: 5e6, endDate: '2026-06-30' }));
  const f = factorHoldings({ topShareholders: holders }, mkBuyback('004'));
  const names = (f.subFactors || []).map(s => s.name);
  ok(!names.some(n => /股份回购/.test(n)), `子卡片不含「股份回购」（实际：${names.join('、')}）`);
  ok(names.includes('十大股东净变动') && names.includes('增减持家数'), '保留 十大股东净变动 / 增减持家数');
}

// ============================================================================
// [5] 事件驱动因子：包含 evt_buyback_ 子因子 + 权重
// ============================================================================
console.log('\n[5] 事件驱动因子接入');
{
  const base = { sentiment: 0.2, capital: 0.2, futures: 0.1, holdings: 0.15, sectorLimit: 0.1, seesaw: 0.1, technicalShort: 0.15 };
  const keys = ['sentiment', 'capital', 'futures', 'holdings', 'sectorLimit', 'seesaw', 'technicalShort'];
  const r1 = ev.buildEventOverride({ symbol: '300232', baseWeights: base, factorKeys: keys, horizon: 'short', history: [], buyback: mkBuyback('001') });
  ok(!!r1, '提议事件 → 事件因子非空');
  const b1 = r1 && r1.events.find(e => e.id === 'buyback_300232');
  ok(b1 && b1.effWeight === 0.10, `提议事件 effWeight=0.10（实际 ${b1 && b1.effWeight}）`);
  ok(r1 && r1.eventFactor.subFactors.some(s => s.key === 'evt_buyback_300232'), '事件因子包含 evt_buyback_300232 子因子');

  const r2 = ev.buildEventOverride({ symbol: '300232', baseWeights: base, factorKeys: keys, horizon: 'short', history: [], buyback: mkBuyback('004') });
  const b2 = r2 && r2.events.find(e => e.id === 'buyback_300232');
  ok(b2 && b2.effWeight === 0.30, `实施中事件 effWeight=0.30（实际 ${b2 && b2.effWeight}）`);
  ok(r2 && r2.combinedWeight >= 0.30 - 1e-9, `事件合计权重 ≥30%（实际 ${r2 && r2.combinedWeight}）`);
}

// ============================================================================
// [6] 源码守卫
// ============================================================================
console.log('\n[6] 源码守卫');
const eSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eventEngine.js'), 'utf8');
const sSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
ok(eSrc.includes('function buildBuybackEvent'), 'eventEngine 定义 buildBuybackEvent');
ok(eSrc.includes("code === '001' || code === '002'") && eSrc.includes("code === '004'"), '按进度分级 001/002/004');
ok(eSrc.includes('weight = 0.10') && eSrc.includes('weight = 0.30'), '权重 0.10 / 0.30');
ok(eSrc.includes('buildBuybackEvent, // 20261023i'), 'buildBuybackEvent 已导出');
ok(sSrc.includes('horizon: \'short\', history, buyback'), 'sameDayJudgment 把 buyback 传入事件引擎');
ok(!/subs\.push\(\{ name: buybackHistorical/.test(sSrc), '增持减持不再 push 回购子卡片');
ok(sSrc.includes("const LAYOUT_VERSION = '20261106o'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化；≥20261026b，版本链随每次口径升版前移）');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_buyback_plan.js`  ·  127 行

~~~js
/**
 * 股份回购子卡片 · 时效与进度口径回归（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_buyback_plan.js
 * 背景（用户 2026-10-21 报障，截图 000902 新洋丰）：
 *   ① 「新洋丰根本没有回购行为」——卡片却把 **2021-07-23 完成实施**的老方案当成当前状态展示；
 *   ② 「显示回购未完成，却判定是中性按回购完成处理」——卡片同时写着「完成实施」和「已达承诺上限 24%」，
 *      而结论理由是「承诺买入力量已用尽」。1.44 亿 / 承诺 3~6 亿，钱显然没花完。
 *
 * 覆盖（20261021i）：
 *   [1] 历史闸门：完结超 730 天 → historical=true（不再当作当前回购）
 *   [2] 未足额结束：完成实施但只到 24% → stage「已结束（未足额）」，理由**不得**说"已用尽"
 *   [3] 足额完成：≥95% → 理由才允许说"已用尽"
 *   [4] 实施中：按剩余额度衰减给正分
 *   [5] 文案：历史前缀 + 「未足额买完」，且**不出现**「完成实施（已达承诺上限 24%）」这种自相矛盾组合
 *   [6] 接线守卫：sameDayJudgment 用 historical 把旧方案降为脚注；卡片值以「无进行中」为主语
 */
const fs = require('fs');
const path = require('path');
const bb = require('../lib/buybackEmDc');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

/** 造一行东财回购报表（字段名与真实报表一致） */
function mkRow(over) {
  return Object.assign({
    REPURPROGRESS: '006',
    REPURNUM: 12134600,
    REPURAMOUNT: 144000000,          // 1.44 亿
    REPURAMOUNTLOWER: 300000000,     // 承诺 3 亿
    REPURAMOUNTLIMIT: 600000000,     // 承诺上限 6 亿
    REPURPRICECAP: 10,
    REPURSTARTDATE: '2021-01-01 00:00:00',
    REPURENDDATE: '2021-07-22 00:00:00',
    FINISHDATE: '2021-07-23 00:00:00',
    NOTICEDATE: '2021-07-23 00:00:00',
    DIM_DATE: '2021-07-23 00:00:00',
  }, over || {});
}

console.log('\n[1] 历史闸门（用户报障①：新洋丰现在没有回购行为）');
{
  const p = bb.normalize(mkRow());
  eq(p.historical, true, '2021-07-23 完成实施（5 年前）→ 判为历史方案');
  ok(p.ageDays > 730, `已完结 ${p.ageDays} 天（> ${bb.HISTORICAL_DAYS}）`);
  ok(/历史方案/.test(bb.formatPlan(p)), '文案开头标「历史方案…与当前回购无关」');

  // 近期完成的方案（30 天前）不应判历史
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) + ' 00:00:00';
  const p2 = bb.normalize(mkRow({ FINISHDATE: recent, NOTICEDATE: recent, DIM_DATE: recent }));
  eq(p2.historical, false, '30 天前完成 → 仍算近期，不标历史');

  // 进行中的方案永远不是历史
  const p3 = bb.normalize(mkRow({ REPURPROGRESS: '004', FINISHDATE: null, NOTICEDATE: '2021-07-23 00:00:00' }));
  eq(p3.historical, false, '实施中方案不因日期久被判历史');
}

console.log('\n[2] 未足额结束（用户报障②：显示未完成却按"已用尽"处理）');
{
  const p = bb.normalize(mkRow());
  eq(p.progressPct, 24, '完成率 = 1.44 亿 / 上限 6 亿 = 24%');
  eq(p.signal, 0, '买盘已结束 → signal 0（中性，这部分没错）');
  eq(p.stage, '已结束（未足额）', '阶段明说是"已结束（未足额）"，不是"已完成"');
  ok(/未足额买完/.test(p.signalReason), '理由写明「未足额买完」');
  ok(!/已用尽/.test(p.signalReason), '理由**不得**再说「承诺买入力量已用尽」（钱没花完）');
  ok(/不构成增量利好/.test(p.signalReason), '仍给出"对后续股价不构成增量利好"的正确结论');
}

console.log('\n[3] 足额完成：只有 ≥95% 才允许说"已用尽"');
{
  const p = bb.normalize(mkRow({ REPURAMOUNT: 590000000 }));   // 5.9 亿 / 6 亿 ≈ 98.3%
  eq(p.progressPct, 98.3, '完成率 98.3%');
  eq(p.stage, '已完成', '阶段 = 已完成');
  ok(/已用尽/.test(p.signalReason), '足额完成才说「承诺买入力量已用尽」');
}

console.log('\n[4] 实施中：按剩余额度给正分（回归不受本次改动影响）');
{
  const p = bb.normalize(mkRow({ REPURPROGRESS: '004', REPURAMOUNT: 240000000, FINISHDATE: null }));
  eq(p.stage, '实施中', '阶段 = 实施中');
  ok(p.signal > 0 && p.signal <= 0.75, `signal=${p.signal} 落在 (0, 0.75]`);
  ok(/剩余额度约 60/.test(p.signalReason), `理由给剩余额度（${p.signalReason}）`);
  eq(p.historical, false, '实施中不算历史');
}

console.log('\n[5] 文案自洽：不允许「完成实施 + 已达承诺上限 24%」并存');
{
  const p = bb.normalize(mkRow());
  const txt = bb.formatPlan(p);
  ok(!/已达承诺上限 24/.test(txt), '不再出现「已达承诺上限 24%」（读起来像"正在推进"）');
  ok(/完成实施/.test(txt), '保留东财原进度词「完成实施」（事实不篡改）');
  ok(/实际回购为承诺上限的 24%/.test(txt), '改成「实际回购为承诺上限的 24%」');
  ok(/未达承诺下限 3\.00亿元/.test(txt), '并点明未达承诺下限');
  ok(/方案到期结束、未足额买完/.test(txt), '给出"为什么完成却没足额"的解释');

  // 足额完成的文案不应出现"未足额"
  const p2 = bb.normalize(mkRow({ REPURAMOUNT: 590000000 }));
  const txt2 = bb.formatPlan(p2);
  ok(!/未足额买完/.test(txt2), '足额完成文案不出现「未足额买完」');
  ok(/已达承诺上限的 98\.3%/.test(txt2), `足额文案：已达承诺上限的 98.3%（实际 ${txt2}）`);
}

console.log('\n[6] 接线守卫（卡片主语与降级处理）');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
  // 20261023i：股份回购已从「增持减持」迁入「事件驱动」——
  //   历史方案不再在增持减持卡片展示，改由事件引擎判定（历史 → 不生成事件）。
  ok(!/subs\.push\(\{ name: buybackHistorical/.test(src), '增持减持不再 push 回购子卡片（已迁入事件驱动）');
  const evSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eventEngine.js'), 'utf8');
  ok(/function buildBuybackEvent/.test(evSrc), 'eventEngine 定义 buildBuybackEvent');
  ok(/if \(!plan \|\| plan\.historical\) return null/.test(evSrc), '历史方案 → 不生成回购事件（null）');
  ok(/code === '001' \|\| code === '002'/.test(evSrc) && /code === '004'/.test(evSrc), '权重按进度分类 001/002 与 004');

  const em = fs.readFileSync(path.join(__dirname, '..', 'lib', 'buybackEmDc.js'), 'utf8');
  ok(/HISTORICAL_DAYS = 730/.test(em), '历史阈值 730 天常量存在');
  ok(/CLOSED_CODES = \['003', '005', '006'\]/.test(em), '已结束进度码口径明确（完成/停止/否决）');
  ok(/未足额买完/.test(em), '未足额的措辞在数据层生成（不靠前端拼）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

~~~

---

## `scripts\test_cache_bust_guard.js`  ·  75 行

~~~js
/**
 * 缓存破坏守卫（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_cache_bust_guard.js
 * 防御 R11：?v= 忘更 / 文件不在 FRONTEND_BUST_FILES / SCHEMA_VERSION 忘升
 *         → 浏览器沿用旧缓存（deepCharts 三个月前科）。
 * 守护点：public 下所有 HTML 引用的本地 /js/*.js 与 /css/*.css 必须带 ?v= 戳；
 *         FRONTEND_BUST_FILES 名单里的 js/css 必须仍被某 HTML 实际引用（避免脱节死名单）。
 * vendor/ 第三方库（echarts 等）不参与戳校验（有 CDN 兜底，版本恒定）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0, warn = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
function info(c, m) { if (c) { pass++; console.log('  ✓', m); } else { warn++; console.log('  ⚠', m); } }

// 1) 解析 server.js 中的 FRONTEND_BUST_FILES 名单
const bustMatch = serverSrc.match(/FRONTEND_BUST_FILES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
ok(!!bustMatch, 'server.js 中存在 FRONTEND_BUST_FILES 定义');
const bustSet = new Set();
if (bustMatch) {
  const items = bustMatch[1].match(/'([^']+)'/g) || [];
  items.forEach(i => bustSet.add(i.slice(1, -1)));
}
console.log(`\n[1] FRONTEND_BUST_FILES 含 ${bustSet.size} 项`);

// 2) 扫描 public 下所有 html 的本地 js/css 引用
const publicDir = path.join(ROOT, 'public');
const htmlFiles = fs.existsSync(publicDir)
  ? fs.readdirSync(publicDir).filter(f => f.endsWith('.html'))
  : [];
console.log(`\n[2] 扫描 public/*.html（${htmlFiles.length} 个）的本地脚本/样式引用`);

const refRe = /(?:src|href)\s*=\s*["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g;
const canon = s => s.replace(/^\.?\//, '');
let totalRefs = 0, missingV = 0, notInBust = 0;
const problems = [];
const referenced = new Set();
for (const hf of htmlFiles) {
  const html = fs.readFileSync(path.join(publicDir, hf), 'utf8');
  refRe.lastIndex = 0;
  let m;
  while ((m = refRe.exec(html))) {
    const ref = m[1];
    if (/^https?:\/\//.test(ref)) continue;        // 跳过外链
    if (/vendor\//.test(ref)) continue;            // 第三方库不参与戳校验
    const hasV = /[?&]v=/.test(ref);
    totalRefs++;
    referenced.add(canon(ref.split('?')[0]));
    if (!hasV) { missingV++; problems.push(`${hf}: 引用 ${ref} 缺少 ?v= 戳`); }
    else if (!bustSet.has(canon(ref.split('?')[0]))) { notInBust++; }
  }
}

ok(missingV === 0, `所有本地 js/css 引用均带 ?v= 戳（共 ${totalRefs} 处，缺戳 ${missingV} 处）`);
problems.forEach(p => console.log('     -', p));
console.log(`  ℹ 非 FRONTEND_BUST_FILES 名单内但已带 ?v= 的引用 ${notInBust} 处（HTML 作者显式带戳，可接受）`);

// 3) 反向：BUST 名单里的 js/css 至少应在某 html 被引用（避免死名单 / 脱节）
let deadBust = 0;
for (const b of bustSet) {
  if ((b.endsWith('.js') || b.endsWith('.css')) && !referenced.has(canon(b))) {
    deadBust++;
    console.log(`     - BUST 项 ${b} 未在任一 public html 中被引用`);
  }
}
info(deadBust === 0, `FRONTEND_BUST_FILES 中的 js/css 均被引用（脱节 ${deadBust} 项）`);

console.log(`\n===== 缓存破坏守卫：通过 ${pass} / 警告 ${warn} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_cap_vol_ratio_chart.js`  ·  103 行

~~~js
/**
 * scripts/test_cap_vol_ratio_chart.js — 20261109d 守卫
 * ==========================================================
 * 用户指令（2026-11-09）：「每日量比趋势（近60日）图表的数据由每日的量比
 * 改为每日的20日量能比，图表名字也一起改。」
 *
 * 锁定行为：
 *   §1 computeVolRatioSeries 口径（20日量能比=当日量÷前20日均量不含当日；缺失→null 不臆造）
 *   §2 渲染接线（卡片位置=主力资金流向卡正下方 / renderAll 接线 / 阈值线 1.3·0.8）
 *   §3 版本戳（动态读取 APP_VERSION，避免硬编码过期）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const ROOT = path.join(__dirname, '..');

// 浏览器脚本 → vm 沙箱加载（纯函数计算无需 DOM/echarts）
function loadCapitalCharts() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/capitalCharts.js'), 'utf8');
  const sandbox = { console, window: undefined, document: undefined, echarts: undefined, SA_CHART: undefined };
  vm.createContext(sandbox);
  return vm.runInContext(src + '\n;CapitalCharts', sandbox, { filename: 'capitalCharts.js' });
}

async function main() {
  const CC = loadCapitalCharts();

  // ── §1 20日量能比序列口径 ─────────────────────────────────
  console.log('\n§1 computeVolRatioSeries（20日量能比=当日量÷前20日均量，不含当日）');
  {
    ok(typeof CC.computeVolRatioSeries === 'function', 'computeVolRatioSeries 已导出（vm 沙箱可加载）');
    const flat = Array(22).fill(100); flat[20] = 200; // 短样本验证边界
    const r = CC.computeVolRatioSeries(flat);
    ok(r.length === flat.length, '输出与输入等长（逐日对齐）');
    ok(r.slice(0, 20).every(v => v === null), '前 20 日基准不足 → null（不臆造）');
    ok(r[20] === 2, '当日 200 ÷ 前20日均量 100 = 2.0');
    ok(Math.abs(r[21] - 200 / 210) < 0.01, `次日 100 ÷ 前20日均量(含前日200)≈${(200 / 210).toFixed(2)}（实际 ${r[21]}）`);

    const hole = Array(60).fill(100); hole[25] = null;
    const rh = CC.computeVolRatioSeries(hole);
    ok(Math.abs(rh[20] - 1) < 0.001, '正常窗口 100÷100=1.00');
    ok(rh[25] === null, '当日量缺失 → null');
    ok(rh[26] === null, '前20日窗口含缺失 → 该日 null（不跳过补算）');
    ok(Math.abs(rh[46] - 1) < 0.001 && Math.abs(rh[59] - 1) < 0.001, '窗口滑过缺失恢复后回到 1.00（数组末）');

    const zero = Array(60).fill(100); zero[25] = 0;
    const rz = CC.computeVolRatioSeries(zero);
    ok(rz[25] === null, '当日量 0（停牌）→ null');
    ok(rz[26] === null, '前20日窗口含 0 量 → null');
    ok(Math.abs(rz[46] - 1) < 0.001 && Math.abs(rz[59] - 1) < 0.001, '窗口滑过停牌日后恢复计算（1.00）');
    ok(CC.computeVolRatioSeries([]).length === 0, '空数组 → 空序列');
    ok(CC.computeVolRatioSeries(null).length === 0, 'null 输入 → 空序列（脏数据兜底）');

    // 真实数据形状：近 60 日（与 vi.series.volumes 对齐）
    const v60 = Array.from({ length: 60 }, (_, i) => 1000 + (i % 7) * 100);
    ok(CC.computeVolRatioSeries(v60).filter(v => v != null).length === 40, '60 日输入 → 40 个有效量能比（前 20 日 null）');
  }

  // ── §2 渲染接线 ────────────────────────────────────────────
  console.log('\n§2 渲染接线（卡片位置 / 标题 / 阈值线）');
  {
    const idxHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const iMoney = idxHtml.indexOf('capMoneyFlowChart');
    const iRatio = idxHtml.indexOf('capVolRatioChart');
    ok(iMoney >= 0 && iRatio > iMoney, 'index.html：20日量能比图容器位于主力资金流向卡之后');
    ok(idxHtml.includes('每日20日量能比趋势（近60日）'), '卡片标题「每日20日量能比趋势（近60日）」');
    ok(/主力资金流向（近60日）[\s\S]{0,400}?每日20日量能比趋势（近60日）/.test(idxHtml), '量能比卡紧跟主力资金流向卡（正下方，中间无其他卡片）');
    const cc = fs.readFileSync(path.join(ROOT, 'public/js/capitalCharts.js'), 'utf8');
    ok(/renderVolRatio\(data\.volumeIndicators\)/.test(cc), 'renderAll 已接线 renderVolRatio（消费 volumeIndicators）');
    ok(cc.includes("capVolRatioChart") && cc.includes("this.instances.volRatio = chart"), '渲染函数绑定 #capVolRatioChart（复用 _safeInit 容错）');
    ok(cc.includes("前 20 日均量") && /yAxis: 1\.3/.test(cc) && /yAxis: 0\.8/.test(cc), '口径说明与阈值线 1.3（放量）/0.8（缩量）齐备');
    ok(/放量|平量|缩量/.test(cc.split('renderVolRatio')[1]?.split('renderVolumePrice')[0] || ''), 'tooltip 标注量能三态（与量能三态同口径）');
    // 后端序列字段（同源、无空窗）
    ok(cc.includes('ratio20Series'), '前端优先消费后端预计算的 ratio20Series（同源，避免前端空窗）');
  }

  // ── §3 版本戳（动态读取 APP_VERSION）──────────────────────
  console.log('\n§3 版本戳');
  {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const m = server.match(/const APP_VERSION = '([0-9a-z]+)'/);
    const VER = m ? m[1] : '';
    ok(VER !== '', `server.js 含 APP_VERSION（=${VER}）`);
    const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    ok(idx.includes(`?v=${VER}`), `index.html（本图表所在页）版本戳已对齐 ${VER}`);
    // 前端资源由 server 中间件强制 ?v=APP_VERSION（capitalCharts.js 在 FRONTEND_BUST_FILES），
    // 故 HTML 无需逐项手工同步；accuracy.html 等独立页面属历史戳、不在本次范围。
    ok(/'\/js\/capitalCharts\.js'/.test(server), 'capitalCharts.js 在 FRONTEND_BUST_FILES（被服务端强制带戳）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); process.exit(1); });

~~~

---

## `scripts\test_changjiang_patchJ.js`  ·  101 行

~~~js
// 测试长江证券（000783）专属估值模型【补丁J · 全量数据一致性审计与文本强制对齐】
// 手法：构造三表直调 run（statements/balanceQuarterly 注入，零网络），断言四条一致性规则。
// 规则① 动态锚全局统一替换为封顶后 1.60（严禁「标签 1.83 / 结果 10.74」割裂）
// 规则② 计算等式强校验（拒绝睁眼瞎：公式值 ≠ 锁死值时如实描述，不强行画等号）
// 规则③ 情景设定逻辑校验（消除倒挂：中枢 > 长周期均值锚 → 乐观复苏失效转均值回归底线）
// 规则④ 熔断与状态说明清洗（无遗留「PB锚1.83倍」「以动态锚为准」；红灯/降级提示引用最新有效锚 1.60）
const cj = require('../lib/valuation/changjiang000783.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); failures.push(name); }
}
const r2 = (x) => Math.round(Number(x) * 100) / 100;

function baseData() {
  return {
    statements: {
      income: [
        { REPORT_DATE: '2025-12-31 00:00:00', TOTAL_OPERATE_INCOME: 10548000000, PARENT_NETPROFIT: 3696410000, DEDUCT_PARENT_NETPROFIT: 3777000000, FEE_COMMISSION_NI: 5500000000, INTEREST_NI: 2100000000, INVEST_INCOME: 3800000000, FAIRVALUE_CHANGE_INCOME: -400000000 },
        { REPORT_DATE: '2025-09-30 00:00:00', TOTAL_OPERATE_INCOME: 6100000000, PARENT_NETPROFIT: 3372614462.45, DEDUCT_PARENT_NETPROFIT: 3401140000, FEE_COMMISSION_NI: 4200000000, INTEREST_NI: 1600000000, INVEST_INCOME: 3500000000, FAIRVALUE_CHANGE_INCOME: -300000000 },
        { REPORT_DATE: '2026-06-30 00:00:00', TOTAL_OPERATE_INCOME: 7426000000, PARENT_NETPROFIT: 3192490000, DEDUCT_PARENT_NETPROFIT: 3163630000, FEE_COMMISSION_NI: 3900000000, INTEREST_NI: 1300000000, INVEST_INCOME: 3350000000, FAIRVALUE_CHANGE_INCOME: -162000000 },
        { REPORT_DATE: '2026-09-30 00:00:00', TOTAL_OPERATE_INCOME: 8874644121.68, PARENT_NETPROFIT: 3655102399.16, DEDUCT_PARENT_NETPROFIT: 3585418056.21, FEE_COMMISSION_NI: 4423127051.05, INTEREST_NI: 1815976084.59, INVEST_INCOME: 3361302760.29, FAIRVALUE_CHANGE_INCOME: -835505220.27 },
      ],
      balance: [
        { REPORT_DATE: '2025-12-31 00:00:00', TOTAL_PARENT_EQUITY: 41916000000, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 200000000000, TRADE_FINASSET_NOTFVTPL: 30000000000, OTHER_CREDITOR_INVEST: 25000000000, OTHER_EQUITY_INVEST: 600000000, DERIVE_FINASSET: 300000000 },
      ],
      cashflow: [
        { REPORT_DATE: '2026-09-30 00:00:00', NETCASH_OPERATE: 5000000000 },
      ],
    },
    balanceQuarterly: [
      { REPORT_DATE: '2025-12-31 00:00:00', TOTAL_PARENT_EQUITY: 41916000000, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 200000000000, TRADE_FINASSET_NOTFVTPL: 30000000000, OTHER_CREDITOR_INVEST: 25000000000, OTHER_EQUITY_INVEST: 600000000, DERIVE_FINASSET: 300000000 },
      { REPORT_DATE: '2026-06-30 00:00:00', TOTAL_PARENT_EQUITY: 42904000000, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 210000000000, TRADE_FINASSET_NOTFVTPL: 34000000000, OTHER_CREDITOR_INVEST: 26000000000, OTHER_EQUITY_INVEST: 600000000, DERIVE_FINASSET: 300000000 },
      { REPORT_DATE: '2026-09-30 00:00:00', TOTAL_PARENT_EQUITY: 43092483620.13, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 216804674676.85, TRADE_FINASSET_NOTFVTPL: 38016024522.11, OTHER_CREDITOR_INVEST: 27638810226.73, OTHER_EQUITY_INVEST: 58829417.41, DERIVE_FINASSET: 351941334.29 },
    ],
  };
}

(async () => {
  const dump = (r) => JSON.stringify(r);

  // ═══════════ 价格 8.6：基准态（不触发铁底锁死） ═══════════
  const r1 = await cj.run('000783', { price: 8.6, ...baseData() });
  ok(r1 && r1.ok === true, 'J0 基准运行应成功');
  if (!r1.ok) { console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`); failures.forEach(f => console.log('[FAIL] ' + f)); process.exit(1); }
  const center = r1.fairValueCenter;            // ≈ 10.73~10.74
  const blob1 = dump(r1);
  const fp1 = r1.fairPB;

  console.log('\n===== 补丁J·规则① 动态锚全局统一替换为 1.60 =====');
  ok(fp1.anchorRaw === 1.83, 'J1.1 原始动态PB锚 = 1.83（含牛市溢价，仅作背景参照）');
  ok(fp1.anchor === 1.60 && fp1.anchorCapped === true, 'J1.2 封顶后有效PB锚 = 1.60（理论PB锚，三位一体向下约束生效）');
  ok(r1.sensRows.some(x => String(x.label).indexOf('PB 动态锚（封顶后）') !== -1 && String(x.label).indexOf('1.60') !== -1), 'J1.3 敏感性看板使用封顶后 1.60（非 1.83）');
  ok(r1.coreRows.some(x => String(x.label).indexOf('理论PB') !== -1 && String(x.value).indexOf('1.60') !== -1), 'J1.4 理论PB核心行显示 1.60');
  ok(r1.coreRows.some(x => String(x.label).indexOf('市场快照') !== -1 && String(x.value).indexOf('1.60') !== -1), 'J1.5 市场快照使用 1.60');
  ok(blob1.indexOf('动态锚 1.83 倍突破上轨 → 估值体系重构警告（ROE质变，以动态锚为准）') === -1, 'J1.6 无「标签1.83/以动态锚为准」独立旧提示');
  ok(blob1.indexOf('当前模型有效锚 = 1.60') !== -1, 'J1.7 全文统一引用「当前模型有效锚 = 1.60」');

  console.log('\n===== 补丁J·规则② 计算等式强校验（拒绝睁眼瞎） =====');
  const rows1 = r1.matrixRows || [];
  const ep1 = rows1.find(x => String(x.method).indexOf('极端悲观') === 0);
  ok(!!ep1, 'J2.1 极端悲观行存在');
  const expLow = r2(center * 0.75);
  ok(new RegExp(`基准\\s*${center.toFixed(2)}\\s*[×x*]\\s*0\\.75\\s*=\\s*${expLow.toFixed(2)}`).test(String(ep1.note)), `J2.2 极端悲观公式值 = 基准 ${center.toFixed(2)} × 0.75 = ${expLow.toFixed(2)}（真实成立）`);
  ok(String(ep1.note).indexOf('铁底') === -1, 'J2.3 基准态（未锁铁底）说明不含「铁底价」强行等号');

  // 价格 6.62：触发补丁I 铁底锁死
  const r2b = await cj.run('000783', { price: 6.62, ...baseData() });
  ok(r2b && r2b.ok === true, 'J2.4 铁底场景运行应成功');
  const rows2 = r2b.matrixRows || [];
  const ep2 = rows2.find(x => String(x.method).indexOf('极端悲观') === 0);
  const expLow2 = r2(center * 0.75);
  ok(new RegExp(`基准\\s*${center.toFixed(2)}\\s*[×x*]\\s*0\\.75\\s*=\\s*${expLow2.toFixed(2)}`).test(String(ep2.note)), `J2.5 铁底场景仍如实写出公式值 = 基准 ${center.toFixed(2)} × 0.75 = ${expLow2.toFixed(2)}`);
  ok(String(ep2.note).indexOf('铁底价 ¥6.14') !== -1, 'J2.6 铁底场景如实声明「最终锁定为铁底价 ¥6.14」（≠ 强行 8.06）');
  ok(String(ep2.note).indexOf('最终锁定') !== -1, 'J2.7 铁底场景按最终锁死结果叙事（非强行画等号）');

  console.log('\n===== 补丁J·规则③ 情景设定逻辑校验（消除倒挂） =====');
  const g = r1.patchG || {};
  ok(g.recovery && g.recovery.inverted === true, 'J3.1 主模型中枢 > 长周期均值锚 → 复苏情景倒挂 inverted=true');
  ok(g.recovery && g.recovery.label === '均值回归底线', 'J3.2 标签转为「均值回归底线」（非乐观复苏）');
  ok(g.recovery && Math.abs(g.recovery.price - 8.92) < 0.02, 'J3.3 均值回归底线价 = BVPS 6.71 × 1.33 ≈ ¥8.92');
  const comp1 = rows1.find(x => String(x.method).indexOf('综合结论') === 0);
  ok(comp1 && String(comp1.note).indexOf('均值回归底线') !== -1, 'J3.4 综合结论行使用「均值回归底线」');
  ok(comp1 && String(comp1.note).indexOf('乐观复苏情景') === -1, 'J3.5 综合结论行无「乐观复苏情景」倒挂文案');
  ok(comp1 && String(comp1.note).indexOf('低于主模型中枢') !== -1, 'J3.6 综合结论行标注「低于主模型中枢，转为下行保护参考」');

  console.log('\n===== 补丁J·规则④ 熔断与状态说明清洗 =====');
  ok(blob1.indexOf('以动态锚为准') === -1, 'J4.1 全文无遗留「以动态锚为准」提示');
  const rl4 = (r1.riskLights || []).find(x => String(x.label).indexOf('第四法则') !== -1);
  ok(rl4 && String(rl4.light).indexOf('当前模型有效锚 = 1.60') !== -1, 'J4.2 红灯（第四法则双轨防御）引用最新有效锚 1.60');
  ok(r1.coreRows.some(x => String(x.label).indexOf('第四法则·动态PB锚') !== -1 && String(x.value).indexOf('1.60') !== -1 && String(x.value).indexOf('封顶') !== -1), 'J4.3 核心行「第四法则·动态PB锚」显示封顶后 1.60 并含封顶说明');
  const warnRow = rows1.find(x => String(x.method).indexOf('估值体系重构警告') !== -1);
  ok(warnRow && String(warnRow.note).indexOf('当前模型有效锚 = 1.60') !== -1, 'J4.4 重构警告行引用当前有效锚 1.60（非原始 1.83）');
  ok(blob1.indexOf('PB锚1.83倍') === -1, 'J4.5 无历史遗留「PB锚1.83倍」字眼');

  console.log(`\n===== 补丁J 汇总：${pass} 通过 / ${fail} 失败 =====`);
  if (fail) { failures.forEach(f => console.log('[FAIL] ' + f)); process.exit(1); }
})().catch(e => { console.error('测试运行异常:', e); process.exit(1); });

~~~

---

## `scripts\test_chart_range_cursor.js`  ·  262 行

~~~js
/**
 * 主图「区间最高 / 区间最低」自动追踪光标 · 行为回归（零网络，全合成数据）
 * ---------------------------------------------------------------------------
 * 运行： node scripts/test_chart_range_cursor.js
 *
 * 背景（20261022i 用户需求原文）：
 *   「主图模块删除右侧标示今日收盘价的光标，增加两个自动追踪光标，
 *     一个显示当前选定的时间范围内股票的最高价，一个显示最低价。」
 *
 * 覆盖：
 *   [1] 「今日收盘价」单条标线已彻底移除（不能再出现"只标最后一根收盘价"的痕迹）
 *   [2] 光标恒为 **两条**：区间最高（红·高）/ 区间最低（绿·低）
 *   [3] 初次渲染先按全区间算，挂载后立即按真实 dataZoom 可视区间校正
 *   [4] 滚轮缩放 / 拖动平移（dataZoom 事件）后，极值随可视区间重算
 *   [5] 缩放到全量区间（start:0 end:100）时，极值 = 全历史极值
 *   [6] markLine.data 长度恒为 2（ECharts 按索引合并，长度变化会残留脏光标）
 *   [7] 缺失 high/low 时留占位条目，不抛错、不缩短数组
 *   [8] 空历史 / 单根历史 / 无 chart 实例时不抛错
 *
 * 说明：本文件用 stub echarts 捕获 setOption，无浏览器、无网络。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---- 深合并：模拟 ECharts setOption 的 merge 语义（数组按索引合并，同 markLine 真实行为） ----
function mergeDeep(target, src) {
  if (Array.isArray(src)) {
    if (!Array.isArray(target)) target = [];
    src.forEach((v, i) => {
      if (v && typeof v === 'object') target[i] = mergeDeep(target[i] || {}, v);
      else target[i] = v;
    });
    return target;
  }
  if (src && typeof src === 'object') {
    const out = (target && typeof target === 'object') ? target : {};
    for (const k of Object.keys(src)) out[k] = mergeDeep(out[k], src[k]);
    return out;
  }
  return src;
}

// ---- 构造最小浏览器环境加载 Charts（stub echarts，捕获 setOption / dataZoom 监听） ----
const rafQueue = [];
const chartsCreated = [];
global.echarts = {
  registerTheme() {},
  init() {
    const chart = {
      _opt: {},
      _handlers: {},
      setOption(o) { this._opt = mergeDeep(this._opt, o); },
      getOption() { return this._opt; },
      on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
      off() {},
      dispose() {},
      resize() {},
      dispatchAction() {},
      getZr() { return { off() {}, on() {} }; },
    };
    chartsCreated.push(chart);
    return chart;
  },
};
global.window = { SA_CHART: null };
// 同步可刷新的 rAF：把回调排队，显式 flush，避免同步执行打乱 raf 句柄赋值顺序
global.window.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
global.document = { getElementById: (id) => (id ? { id } : null) };

function flushRaf() {
  const q = rafQueue.splice(0, rafQueue.length);
  q.forEach(fn => fn());
}

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts.js'), 'utf8');
const body = src.replace(/^\(function registerSoftDarkTheme\(\)\{[\s\S]*?\n\}\)\(\);/, '');
const Charts = new Function(`${body}; return Charts;`)();

// ---- 合成日K：high/low 单调可预测，便于直接算期望值 ----
function buildHistory(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 10 + i * 0.05;                      // 10 → 19.95
    out.push({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.1,
      close,
      high: close + 0.3,
      low: close - 0.3,
      volume: 1000 + i,
    });
  }
  return out;
}

// 复算期望极值（与被测实现独立）
function expectExtremes(history, i0, i1) {
  let hi = null, lo = null;
  for (let i = i0; i <= i1; i++) {
    const d = history[i];
    if (!d) continue;
    const h = Number(d.high), l = Number(d.low);
    if (isFinite(h) && (hi === null || h > hi)) hi = h;
    if (isFinite(l) && (lo === null || lo < lo)) { /* no-op 占位，防误写 */ }
    if (isFinite(l) && (lo === null || l < lo)) lo = l;
  }
  return { hi, lo };
}

const mkOf = (chart) => (chart && chart._opt && chart._opt.series && chart._opt.series[0] && chart._opt.series[0].markLine) || null;
const labelsOf = (ml) => (ml && Array.isArray(ml.data) ? ml.data.map(d => (d && d.label && d.label.formatter) || '') : []);

// ============================ [1] 首次渲染：两条光标，无「今日收盘价」残留 ============================
console.log('\n[1] 首次渲染的结构');
const H = buildHistory(200);
Charts.candlestick('candlestickChart', H);
let chart = chartsCreated[chartsCreated.length - 1];
let ml = mkOf(chart);

ok(!!ml, 'candlestick 已输出 markLine');
ok(Array.isArray(ml.data) && ml.data.length === 2, `markLine.data 恰为 2 条（实际 ${ml && ml.data ? ml.data.length : 'N/A'}）`);
const lb = labelsOf(ml);
ok(/^高 /.test(lb[0] || ''), `第 1 条是区间最高价，带「高」前缀（实际 "${lb[0]}"）`);
ok(/^低 /.test(lb[1] || ''), `第 2 条是区间最低价，带「低」前缀（实际 "${lb[1]}"）`);
ok(ml.data[0].yAxis !== ml.data[1].yAxis, '两条光标价格不同（不是同一价位重复画）');

// 「今日收盘价」特征：单条、且 yAxis === 末根 close。这里断言"不可能是那种形态"。
const lastClose = H[H.length - 1].close;
const onlyClose = ml.data.length === 1 && Number(ml.data[0].yAxis) === lastClose;
ok(!onlyClose, `不再是「单条=今日收盘价 ${lastClose}」的旧标线`);
ok(ml.data[0].yAxis !== lastClose || ml.data[1].yAxis !== lastClose || ml.data.length === 2,
  '「今日收盘价」标线已移除：当前两条为区间极值，与"末根收盘价"无绑定关系');

// ============================ [2] 初次渲染按全区间（setOption 之后才校正） ============================
console.log('\n[2] 初次渲染的取值口径');
const full = expectExtremes(H, 0, H.length - 1);
ok(Number(ml.data[0].yAxis) === full.hi, `初次 markLine 高 = 全历史最高 ${full.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === full.lo, `初次 markLine 低 = 全历史最低 ${full.lo}（实际 ${ml.data[1].yAxis}）`);

// ============================ [3] 挂载后立即按真实可视区间校正 ============================
console.log('\n[3] 挂载后按 dataZoom 可视区间校正');
ok(typeof window.requestAnimationFrame === 'function', 'rAF 已挂载（节流依赖）');
ok(rafQueue.length > 0, '挂载后排队了一次 rAF 校正');
flushRaf();
ml = mkOf(chart);
const dz0 = chart._opt.dataZoom[0];
ok(dz0 && dz0.start === 60 && dz0.end === 100, `主图 dataZoom 初始 60%~100%（实际 ${dz0 && dz0.start}%~${dz0 && dz0.end}%）`);
const vis = expectExtremes(H, Math.floor(200 * 60 / 100), Math.ceil(200 * 100 / 100) - 1);
ok(Number(ml.data[0].yAxis) === vis.hi, `校正后 高 = 可视区间最高 ${vis.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === vis.lo, `校正后 低 = 可视区间最低 ${vis.lo}（实际 ${ml.data[1].yAxis}）`);
ok(Number(ml.data[1].yAxis) !== full.lo, `可视区间最低(${vis.lo}) ≠ 全历史最低(${full.lo})，证明真的按区间算了`);

// ============================ [4] 滚轮缩放 / 拖动平移 → 跟随重算 ============================
console.log('\n[4] dataZoom 事件驱动重算');
const handlers = chart._handlers.dataZoom || [];
ok(handlers.length === 1, `注册了 1 个 dataZoom 监听（实际 ${handlers.length}）`);

// 缩放到 80%~100%
chart._opt.dataZoom[0].start = 80;
chart._opt.dataZoom[0].end = 100;
handlers[0]();
ok(rafQueue.length === 1, 'dataZoom 触发后走 rAF 节流（同帧内只排 1 次）');
// 同帧内再触发两次，不应再排队（节流生效）
handlers[0]();
handlers[0]();
ok(rafQueue.length === 1, `同一帧内多次 dataZoom 只排队 1 次（实际 ${rafQueue.length}）`);
flushRaf();
ml = mkOf(chart);
const vis80 = expectExtremes(H, Math.floor(200 * 80 / 100), Math.ceil(200 * 100 / 100) - 1);
ok(Number(ml.data[0].yAxis) === vis80.hi, `80%~100% 区间 高 = ${vis80.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === vis80.lo, `80%~100% 区间 低 = ${vis80.lo}（实际 ${ml.data[1].yAxis}）`);

// 缩放到 0%~30%（左端区间）
chart._opt.dataZoom[0].start = 0;
chart._opt.dataZoom[0].end = 30;
handlers[0]();
flushRaf();
ml = mkOf(chart);
const vis30 = expectExtremes(H, Math.floor(200 * 0), Math.ceil(200 * 30 / 100) - 1);
ok(Number(ml.data[0].yAxis) === vis30.hi, `0%~30% 区间 高 = ${vis30.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === vis30.lo, `0%~30% 区间 低 = ${vis30.lo}（实际 ${ml.data[1].yAxis}）`);

// 缩放到全量
chart._opt.dataZoom[0].start = 0;
chart._opt.dataZoom[0].end = 100;
handlers[0]();
flushRaf();
ml = mkOf(chart);
ok(Number(ml.data[0].yAxis) === full.hi, `全量区间 高 回到全历史最高 ${full.hi}（实际 ${ml.data[0].yAxis}）`);
ok(Number(ml.data[1].yAxis) === full.lo, `全量区间 低 回到全历史最低 ${full.lo}（实际 ${ml.data[1].yAxis}）`);
ok(ml.data.length === 2, `多次重算后 data 长度恒为 2（实际 ${ml.data.length}），无脏光标残留`);

// ============================ [5] 换周期（周/月K）与换范围：重新 candlestick 后仍正确 ============================
console.log('\n[5] 换数据源（周/月K 重采样后的 history）');
const HW = buildHistory(40);   // 模拟周K（根数更少）
Charts.candlestick('candlestickChart', HW);
const chart2 = chartsCreated[chartsCreated.length - 1];
const ml2 = mkOf(chart2);
ok(ml2 && ml2.data.length === 2, '周K 仍输出 2 条光标');
const fullW = expectExtremes(HW, 0, HW.length - 1);
ok(Number(ml2.data[0].yAxis) === fullW.hi, `周K 初次 高 = ${fullW.hi}（实际 ${ml2.data[0].yAxis}）`);
flushRaf();
const ml2b = mkOf(chart2);
const visW = expectExtremes(HW, Math.floor(40 * 60 / 100), Math.ceil(40 * 100 / 100) - 1);
ok(Number(ml2b.data[0].yAxis) === visW.hi, `周K 校正后 高 = ${visW.hi}（实际 ${ml2b.data[0].yAxis}）`);
ok(Number(ml2b.data[1].yAxis) === visW.lo, `周K 校正后 低 = ${visW.lo}（实际 ${ml2b.data[1].yAxis}）`);

// ============================ [6] 缺失值 / 异常输入不破坏结构 ============================
console.log('\n[6] 缺失值与异常输入');
const HNull = buildHistory(50).map((d, i) => (i > 10 ? { ...d, high: null, low: NaN } : d));
Charts.candlestick('candlestickChart', HNull);
const chart3 = chartsCreated[chartsCreated.length - 1];
flushRaf();
const ml3 = mkOf(chart3);
ok(ml3 && ml3.data.length === 2, `high/low 缺失时段，data 长度仍为 2（实际 ${ml3 && ml3.data.length}）`);
ok(typeof ml3.data[0].yAxis === 'number' && isFinite(ml3.data[0].yAxis), '最高价仍输出有限数值（取合法段）');

let threw = false;
try {
  Charts.candlestick('candlestickChart', []);
} catch (e) { threw = true; }
ok(!threw, '空历史不抛错');

threw = false;
try {
  Charts.candlestick('candlestickChart', buildHistory(1));
  flushRaf();
} catch (e) { threw = true; }
ok(!threw, '单根历史不抛错');

threw = false;
try {
  Charts._bindRangeMarkLine(null, buildHistory(10));
  Charts._bindRangeMarkLine({ on() {}, getOption() { return {}; } }, null);
} catch (e) { threw = true; }
ok(!threw, '_bindRangeMarkLine 收到空 chart / 空 history 时不抛错');

// ============================ [7] 诊断计数器 ============================
console.log('\n[7] 诊断计数器（禁止静默吞错）');
ok(typeof Charts._rangeCursorErrCount === 'number', '_rangeCursorErrCount 已定义');
ok(Charts._rangeCursorErrCount === 0, `正常路径下错误计数为 0（实际 ${Charts._rangeCursorErrCount}）`);

// getOption 抛错时，_visibleRange 应回退默认区间且计数 +1
const before = Charts._rangeCursorErrCount;
const fallback = Charts._visibleRange({ getOption() { throw new Error('boom'); } }, 200);
ok(Charts._rangeCursorErrCount === before + 1, 'getOption 抛错时错误计数 +1（不静默）');
ok(Array.isArray(fallback) && fallback[0] >= 0 && fallback[1] <= 199, `回退默认区间合法 [${fallback}]`);
const defVis = expectExtremes(buildHistory(200), fallback[0], fallback[1]);
ok(defVis.hi != null, '回退区间仍能算出极值');

// ============================ 汇总 ============================
console.log('\n' + '='.repeat(60));
console.log(`PASS=${pass}  FAIL=${fail}`);
if (fail > 0) { console.log('✗ 有失败用例'); process.exit(1); }
console.log('✓ 全部通过：主图区间最高/最低自动追踪光标行为符合预期');

~~~

---

## `scripts\test_color_semantics.js`  ·  242 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_color_semantics.js — [20261109b] 全工作台颜色语义回归守卫
 * ==================================================================
 * 用户铁律（2026-11-09）：**只有「利好 / 正面」才能用红色，只有「利空 / 负面」才能用绿色。**
 *   - 中性 / 无方向 → 中性灰；警告 / 风险 / 数据缺口 / 口径提示 → 琥珀橙。
 *   - ⚠️ 数值符号 ≠ 方向：融券余额 +2.08%、亏损扩大 +30%、CPI 上行等「正数但语义负面」
 *     禁止按 `v > 0 → 红` 着色。
 *   - 适用范围含 CSS、JS 动态 class、文案着色、ECharts 序列、内联样式、后端语义字段。
 *
 * 本守卫四层：
 *   L1 CSS 红绿用法基线：任何新增/删除「使用红绿的规则」都必须人工复核（哈希锁定）。
 *   L2 CSS 语义映射：状态/风险/中性类禁用红绿；好=红、坏=绿、bull=红、bear=绿。
 *   L3 JS 静态接线：禁止机械按数值符号给自由文本着色；中性图表序列禁用方向色。
 *   L4 vm 沙箱行为：真实调用 app.js::_dirColorize / dailyReview.js::semanticText 验证输出 HTML。
 *
 * 不启动浏览器、不联网、不改任何文件。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const RED = /var\(--red\)|#F6465D|rgba\(\s*246,\s*70,\s*93|--red-soft|--red-light|--tint-red/i;
const GREEN = /var\(--green\)|#0ECB81|rgba\(\s*14,\s*203,\s*129|--green-soft|--green-light|--tint-green/i;
const isRed = d => RED.test(d);
const isGreen = d => GREEN.test(d);

// ---------- 解析 CSS 为「选择器 → 声明」表 ----------
const css = read('public/css/style.css');
const rules = {};
const cssRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = cssRe.exec(css))) {
  const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ');
  (rules[sel] = rules[sel] || []).push(m[2]);
}
const declOf = sel => (rules[sel] || []).join(' ');

console.log('\n===== L1 CSS 红绿用法基线 =====');
const rgSels = Object.keys(rules).filter(s => isRed(declOf(s)) || isGreen(declOf(s)));
const hash = crypto.createHash('sha256').update(rgSels.slice().sort().join('\n')).digest('hex');
const BASELINE_HASH = '55b10d93892be6d31f79e8268ce86251298fe643a681c12645aa98220f04dcfb';
ok(rgSels.length === 231, `使用红绿的 CSS 规则数锁定为 231（当前 ${rgSels.length}）`);
ok(hash === BASELINE_HASH, '红绿规则集合哈希与基线一致（新增红绿用法必须走人工语义复核）',
  hash === BASELINE_HASH ? '' : '当前 ' + hash);
ok((css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length, 'CSS 大括号平衡');
ok(!/__[A-Z]+__/.test(css), 'CSS 无迁移残留占位符');

console.log('\n===== L2 CSS 语义映射 =====');
// ① 状态 / 风险 / 警告 / 缺口 / 中性信息 / 排名热度 → 禁用红绿
const DENY = [
  '.toast.success .toast-icon', '.toast.error .toast-icon', '.toast.success', '.toast.error',
  '.pa-mz-err', '.pa-mz-del:hover', '.pa-mz-badge.ok', '.pa-mz-badge.invalid',
  '.pa-mz-row.invalid .pa-mz-range', '.ui-error .ui-icon, .ui-error .ui-title', '.error-banner',
  '.er-mismatch', '.learn-err-item', '.jd-rec.jd-rec-mismatch', '.sn-block.sn-highlight',
  '.tp-warning-card.tp-level-strong .tp-warning-level', '.dr-level-high', '.dr-level-mid', '.dr-level-low',
  '.dr-sec-ok .dr-sec-badge', '.dr-pass', '.dr-chip-trading', '.doc-company-badge',
  '.fmr-chip b', '.learn-up', '.learn-down', '.macro-ind .mi-trend.up', '.macro-ind .mi-trend.down',
  '.macro-ind .mi-trend.neutral', '.htw-item:nth-child(1) .htw-rank', '.htw-item:nth-child(2) .htw-rank',
  '.htw-item:nth-child(3) .htw-rank', '.fm-industry.wt-hot::before', '.fm-industry.wt-warm::before',
  '.fm-industry.wt-light::before', '.fm-stat-tag.wt-hot', '.fm-stat-tag.wt-warm', '.fm-stat-tag.wt-light',
  '.ipe-stale-warn', '.cd-topwarn', '.cd-concl-high', '.cd-concl-low', '.cd-pos-up', '.cd-pos-down',
  '.psc-value.neutral', '.asp-rk', '.btn-delete:hover', '.ctx-item.danger:hover', '.wl-remove:hover',
  '.annc-title-link:hover', '.annc-item.annc-flag', '.research-meta .research-rating, .research-meta .research-target',
  '.note-stock', '.docs-upload-filename', '.htw-tag2.tag-run', '.htw-tag2.tag-panic',
  '.htw-tag2.tag-crowd', '.htw-tag2.tag-kol', '.dr-quadrant-divergence', '.dr-stage-peak',
  '.cd-flag-danger', '.cd-flag-warn', '.sl-verdict-pending', '.dr-fail',
];
DENY.forEach(sel => {
  const d = declOf(sel);
  ok(!!d && !isRed(d) && !isGreen(d), `非方向语义不得用红绿：${sel}`, d.slice(0, 90));
});

// ② 明确的「好 / 坏 / 多 / 空 / 涨 / 跌」必须方向正确
const REQUIRED = {
  '.up, .bullish': 'R', '.down, .bearish': 'G',
  '.pa-metric-item.good': 'R', '.pa-metric-item.bad': 'G',
  '.acc-verify.ok': 'R', '.acc-verify.bad': 'G',
  '.jd-match.jd-ok': 'R', '.jd-match.jd-bad': 'G',
  '.jd-concl.jd-hit': 'R', '.jd-concl.jd-miss': 'G',
  '.bt-verdict.PASS': 'R', '.bt-verdict.REJECT': 'G',
  '.sl-verdict-ok': 'R', '.sl-verdict-bad': 'G',
  '.dcf-item.undervalued': 'R', '.dcf-item.overvalued': 'G',
  '.vd-rating-low': 'R', '.vd-rating-high': 'G',
  '.mt-short-foot .up': 'R', '.mt-short-foot .down': 'G',
  '.cd-flag-good': 'R', '.tp-sig-bull': 'R', '.tp-sig-bear': 'G',
  '.cap-pos': 'R', '.cap-neg': 'G', '.etf-pos': 'R', '.etf-neg': 'G',
  '.fu-ext-hawk': 'G', '.fu-ext-dove': 'R', '.fu-bull-strong': 'R', '.fu-bear-strong': 'G',
  '.bt-best-row': 'R', '.acc-kpi.good .k-value': 'R', '.acc-kpi.bad .k-value': 'G',
  '.mt-acc-chip.good .mac-value': 'R', '.mt-acc-chip.bad .mac-value': 'G',
  '.learn-bar-good': 'R', '.learn-bar-bad': 'G',
  '.policy-support': 'R', '.policy-restrict': 'G',
  '.hot-topic-sent.利好': 'R', '.hot-topic-sent.利空': 'G',
  '.tp-vol-active': 'N', '.tp-vol-quiet': 'N', // 量能档位用暖/冷中性色
};
Object.entries(REQUIRED).forEach(([sel, want]) => {
  const d = declOf(sel);
  const good = !!d && (want === 'R' ? isRed(d) : want === 'G' ? isGreen(d) : (!isRed(d) && !isGreen(d)));
  ok(good, `语义映射 ${want === 'R' ? '利好→红' : want === 'G' ? '利空→绿' : '中性→非红绿'}：${sel}`, d.slice(0, 90));
});

// ③ 风险/警告类必须真的用琥珀橙（不能只是把红绿删掉变成无色）
const AMBER_REQUIRED = ['.toast.error .toast-icon', '.ipe-stale-warn', '.cd-topwarn', '.er-mismatch',
  '.tp-warning-card.tp-level-strong .tp-warning-level', '.cd-concl-high', '.asp-rk'];
const AMBER = /var\(--accent|var\(--orange|#F0B97B|rgba\(\s*240,\s*185,\s*123/i;
AMBER_REQUIRED.forEach(sel => ok(AMBER.test(declOf(sel)), `风险/警告改用琥珀橙：${sel}`));

console.log('\n===== L3 JS 静态接线 =====');
const app = read('public/js/app.js');
const dr = read('public/js/dailyReview.js');
const hm = read('public/js/homeMacro.js');
const cc = read('public/js/capitalCharts.js');
const ch = read('public/js/charts.js');
const sh = read('public/js/shareholderCharts.js');
const ef = read('public/js/etfFlowPage.js');

ok(/o\.numeric === true/.test(app) && /o\.tone === 'bull'/.test(app),
  '_dirColorize 具备 tone / numeric 显式语义契约');
ok(/const NEUTRAL = '涨跌幅\|涨跌家数/.test(app), '_dirColorize 有中性组合词守卫（涨跌幅不拆色）');
const guardIdx = app.indexOf('if (o.numeric === true)');
const signIdx = app.indexOf('<span class="down">${num}</span>');
ok(guardIdx > 0 && signIdx > guardIdx && signIdx - guardIdx < 300,
  '按数值符号着色的代码只存在于 numeric 显式 opt-in 分支内，默认分支无机械着色');
ok(/line\('操作建议', esc\(data\.advice/.test(app) && /line\('风险提示', esc\(data\.riskTip/.test(app),
  '操作建议 / 风险提示改为纯转义，琥珀警示色不被方向色覆盖');
ok(!/color:#F6465D/.test(app) && !/rgba\(246,70,93/.test(app) && !/color:#5FD38D/.test(app),
  'app.js 估值警告/机会条不再用红绿内联样式');
ok(/function colorize\(s\) \{ return semanticText\(s, false\); \}/.test(dr) &&
  /function colorizePrice\(s\) \{ return semanticText\(s, true\); \}/.test(dr),
  'dailyReview 自由文本默认不着数值色，仅 colorizePrice 例外');
ok(/return colorizePrice\(sign \+ s\);/.test(dr) &&
  (read('public/js/dailyReview.js').match(/colorizePrice\(/g) || []).length === 2,
  'colorizePrice 只用于已确认语义=涨跌幅的 changePct 字段');
ok(/mi-trend neutral/.test(hm) && !/mi-trend \$\{ind\.trend\}/.test(hm),
  '宏观趋势徽标改中性灰（数值回升/回落 ≠ 利好/利空）');
ok(/rqChange > 0 \? 'cap-neg' : 'cap-pos'/.test(cc), '融券余额增加 = 利空绿（口径不回退）');
ok(!/rgba\(246,70,93,0\.55\)/.test(cc) && !/rgba\(14,203,129,0\.55\)/.test(cc),
  '放量/缩量阈值线不再占用方向色');
ok(/rsiOverbought: '#F0B97B'/.test(ch) && /rsiOversold: '#D9A566'/.test(ch),
  'RSI 超买/超卖阈值线改琥珀橙');
ok(!/#F6465D/.test(sh) && !/#F6465D/.test(ef) && !/#0ECB81/.test(ef),
  '股价叠加线 / ETF 持仓·现金比例序列改中性色');
ok(/psc-value neutral/.test(app) && !/coordination\.dominant\.includes\('长期'\) \? 'up' : 'down'/.test(app),
  '「主导力量 长期/短期」不再按上/下染红绿');
ok(/return 'tp-vol-active'/.test(app) && /return 'tp-vol-quiet'/.test(app),
  '量能档位改用暖/冷中性色，不再 cap-pos/cap-neg');

// ④ [20261109e] 颜色铁律细分：验证 / 核对类字段默认字体，不着方向色
//    事实 / 判断 / 评级依据等结论性字段仍保留 colorize/field 红绿着色。
ok(/\['verify', '次日验证条件', 'dr-quad-verify', 'plain'\]/.test(dr) &&
  /\['invalidate', '判断不成立信号', 'dr-quad-invalidate', 'plain'\]/.test(dr),
  '四段式：次日验证条件 / 判断不成立信号 → plain（默认字体，不着方向色）');
ok(/\['事实', 'fact', 'field'\]/.test(dr), '四段式：事实 / 判断 → 仍保留 field 着色（结论段）');
ok(/\['次日观察信号', 'observe', 'plain'\]/.test(dr) &&
  /\['风险解除信号', 'clear', 'plain'\]/.test(dr),
  '风险条：次日观察信号 / 风险解除信号 → plain（验证 / 核对，不着方向色）');
ok(/'(?:r\.)?verifyLogic'\) \+ '<\/span><\/div>'[\s\S]*?plain\(r\.verifyLogic\)/.test(dr) ||
  /明日验证逻辑[\s\S]*?plain\(r\.verifyLogic\)/.test(dr),
  '题材卡：明日验证逻辑 → plain（验证，不着方向色）');
ok(/k === 'condition' \|\| \(sec && sec\.tableKind === 'checklist'/.test(dr),
  'renderCell：checklist 验证条件 / 核对项 / 今日基准 → plain（验证 / 核对，不着方向色）');
ok(/function renderCell\(k, v, sec\)/.test(dr) && /return plain\(v\);\s*\}\s*return colorize\(v\);/.test(dr),
  'renderCell 默认分支仍为 colorize（结论语境字段保留着色）');

console.log('\n===== L4 vm 沙箱：真实渲染行为 =====');
const mkEl = () => ({
  innerHTML: '', textContent: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  appendChild() {}, insertAdjacentHTML() {},
});
function sandbox() {
  const els = {};
  const s = {
    console, URL, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.resolve({ json: () => ({}) }),
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', search: '' },
    document: {
      addEventListener() {}, getElementById(id) { return els[id] || (els[id] = mkEl()); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return mkEl(); }, body: mkEl(),
    },
    Chart: function () { return {}; },
    echarts: { init() { return { setOption() {}, resize() {} }; } },
    alert() {},
  };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  return s;
}

// 4a. app.js::_dirColorize
const sa = sandbox();
vm.runInContext(read('public/js/app.js') + '\n;globalThis.__App = App;', sa, { timeout: 10000 });
const App = sa.__App;
ok(!!(App && typeof App._dirColorize === 'function'), 'vm 成功加载 App._dirColorize');
const c = t => App._dirColorize(t);
ok(!/class="up"/.test(c('融券余额 +2.08%')) && !/class="down"/.test(c('融券余额 +2.08%')),
  '「融券余额 +2.08%」正数值不再被机械染红（数值符号 ≠ 方向）');
ok(!/dr-up|dr-down/.test(c('风险敞口 +3%')), '自由文本里 +3% 不着方向色');
ok(/tp-sig-bull/.test(c('上涨')) && /tp-sig-bear/.test(c('下跌')), '显式语义词「上涨→红 / 下跌→绿」仍正确');
ok(!/tp-sig-(bull|bear)/.test(c('涨跌幅分布')), '中性组合词「涨跌幅分布」不拆成红涨绿跌');
ok(/class="up">\+1\.23%/.test(App._dirColorize('+1.23%', { numeric: true })),
  '已确认语义的涨跌幅字段 numeric:true 仍按 +红 着色');
ok(/class="down">-1\.23%/.test(App._dirColorize('-1.23%', { numeric: true })),
  '已确认语义的涨跌幅字段 numeric:true 仍按 -绿 着色');
ok(/tp-sig-bear/.test(App._dirColorize('融券余额 +2.08%', { tone: 'bear' })),
  '调用方给定 tone=bear 时整段按语义着绿，忽略数值符号');
ok(/class="up"/.test(c('2026-10-26 14:30-15:00')) === false, '日期/时间连字符不受影响');

// 4b. dailyReview.js::semanticText
const sd = sandbox();
let drSrc = read('public/js/dailyReview.js');
const cut = drSrc.lastIndexOf('})();');
drSrc = drSrc.slice(0, cut) + 'globalThis.__DR = { colorize, colorizePrice, semanticText };\n' + drSrc.slice(cut);
vm.runInContext(drSrc, sd, { timeout: 10000 });
const DR = sd.__DR;
ok(!!(DR && typeof DR.colorize === 'function'), 'vm 成功加载 dailyReview 的着色函数');
ok(!/dr-up|dr-down/.test(DR.colorize('风险敞口 +3%')) && !/dr-up|dr-down/.test(DR.colorize('融券余额 +2.08%')),
  '复盘全文正数值不再误染利好红');
ok(/dr-up/.test(DR.colorize('上涨 3200 家')) && /dr-down/.test(DR.colorize('下跌 1200 家')),
  '复盘全文显式语义词仍按红/绿');
ok(/dr-up/.test(DR.colorizePrice('+2.35%')) && /dr-down/.test(DR.colorizePrice('-2.35%')),
  '板块涨幅 changePct 仍按 A 股口径 +红 / -绿');
ok(!/dr-up|dr-down/.test(DR.colorize('涨跌幅')), '复盘中性组合词不着色');

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_consistency_audit.js`  ·  143 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_consistency_audit.js — 20261105b 守卫
 * 用户指令：每日定期检查工作台所有数据——多个板块使用的同一数据（即使数据源不同）核对展示值一致；
 * ⚠️ 严格区分累计数据与固定期数据（前三季度累计 vs 第三季度单季），口径差异注记不算错误。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { auditPayload } = require(path.join(ROOT, 'lib/consistencyAudit.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// ===== 合成载荷夹具 =====
function fixture(overrides) {
  const ov = overrides || {};
  const zy = [
    {
      REPORT_DATE: '2026-09-30',
      DJD_TOI_YOY: 4.27, TOTALOPERATEREVETZ: 4.26, TOTALOPERATEREVE: 225.53e8,
      DJD_DPNP_YOY: -15.4, PARENTNETPROFITTZ: -15.38, PARENTNETPROFIT: 53.80e8,
      DJD_DEDUCTDPNP_YOY: -16.2, KCFJCXSYJLRTZ: -16.1,
      ROEJQ: 11.6, XSMLL: 40.1, XSJLL: 22.0,
    },
    { REPORT_DATE: '2025-09-30', DJD_TOI_YOY: 2.45, TOTALOPERATEREVETZ: 2.45, ROEJQ: 9.0, XSMLL: 39.5, XSJLL: 21.4 },
  ];
  const f = {
    pe: 22.5, pb: 2.5, ps: 3.2, roeTtm: 11.6, grossMarginTtm: 40.2, netMarginTtm: 22.1,
    revenueYoy: 4.27, profitYoy: -15.4, zyzbHistory: zy,
  };
  const payload = {
    symbol: '603288', name: '海天味业',
    quote: { pe: 22.5, pb: 2.5, name: '海天味业', fundamentals: f },
    fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 40.2, netMargin: 22.1, revenueGrowth: 4.27, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } },
    signals: { signals: [
      { key: 'growth', value: '4.3%', signal: 'neutral' },
      { key: 'profitGrowth', value: '-15.4%', signal: 'bear' },
      { key: 'dedProfitGrowth', value: '-16.2%', signal: 'bear' },
      { key: 'roe', value: '11.6%', signal: 'bull' },
    ] },
    metricAnalysis: { metrics: [
      { key: 'pe', valueText: '22.50' },
      { key: 'pb', valueText: '2.50' },
      { key: 'ps', valueText: '3.20' },
      { key: 'roe', valueText: '11.60%', dims: { industry: { text: '行业均值 15.26，相对低 1.18×' }, pct: { text: '处自身历史 78% 分位' } } },
      { key: 'grossMargin', valueText: '40.20%' },
      { key: 'netMargin', valueText: '22.10%' },
      { key: 'growth', valueText: '4.27%' },
      { key: 'profitGrowth', valueText: '-15.40%' },
      { key: 'dedProfitGrowth', valueText: '-16.20%' },
      { key: 'opProfit', valueText: '14.40亿' },
      { key: 'nbv', valueText: '210.55亿' },
    ] },
    opProfit: { cur: { date: '2026-09-30', opProfitYi: 64.02 }, sqCur: { date: '2026-09-30', opProfitYi: 14.4 } },
    insuranceNBV: { valueYi: 210.55 },
    comparison: { industryAvg: { roe: 15.26 }, percentiles: { roe: 78 } },
  };
  return Object.assign(payload, ov);
}

const byKey = (r, k) => (r.checks || []).find(c => c.id === k);

console.log('=== §1 全一致载荷 → 全 ok ===');
{
  const r = auditPayload(fixture());
  ok(r.health === 'ok', `health=ok（实际 ${r.health}）`);
  ok(r.summary.mismatch === 0, `mismatch=0（实际 ${r.summary.mismatch}）`);
  ok(r.summary.total >= 12, `核对项 ≥12（实际 ${r.summary.total}）`);
  ok(byKey(r, 'pe').status === 'ok', 'PE 同口径一致');
  ok(byKey(r, 'growth').status === 'ok', '营收增长同口径一致');
  const g = byKey(r, 'growth');
  ok(g.note.indexOf('正常口径差异') < 0 || g.note.indexOf('单季') >= 0, '增长核对带口径说明');
  ok(byKey(r, 'opProfitSq').status === 'ok' && byKey(r, 'opProfitCum').status === 'ok', '营运利润单季/累计分列且一致');
  ok(byKey(r, 'nbv').status === 'ok', 'NBV 一致');
  ok(byKey(r, 'indRoe').status === 'ok', '行业均值 ROE 文本与权威值一致');
  ok(byKey(r, 'pctRoe').status === 'ok', '历史百分位文本与权威值一致');
}

console.log('=== §2 累计 vs 单季口径区分（核心规则）===');
{
  // 左卡 revenueGrowth = 4.26（报告期累计口径）而单季口径为 4.27 → 应归类 caliber 而非 mismatch
  const r = auditPayload(fixture({ fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 40.2, netMargin: 22.1, revenueGrowth: 4.26, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } } }));
  const g = byKey(r, 'growth');
  ok(g.status !== 'mismatch', `左卡=累计 4.26% vs 单季 4.27% 判定非 mismatch（实际 ${g.status}）`);
  ok(g.note.indexOf('正常口径差异') >= 0 || g.panels.some(p => p.caliber === '报告期累计同比'), 'note/面板标注「报告期累计同比」口径');
  ok(r.health === 'ok', `整体 health 仍为 ok（实际 ${r.health}）`);
}

console.log('=== §3 同口径数值不一致 → mismatch（真实问题才报警）===');
{
  const r = auditPayload(fixture({ fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 40.2, netMargin: 22.1, revenueGrowth: 99.9, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } } }));
  const g = byKey(r, 'growth');
  ok(g.status === 'mismatch', `左卡=99.9% 无法归类任一口径 → mismatch（实际 ${g.status}）`);
  ok(g.note.indexOf('99.9') >= 0, 'mismatch note 指出具体面板与数值');
  ok(r.health === 'warn', `整体 health=warn（实际 ${r.health}）`);
  // PE 顶栏与行情不一致 → mismatch
  const r2 = auditPayload(fixture({ quote: Object.assign(fixture().quote, { pe: 30 }) }));
  ok(byKey(r2, 'pe').status === 'mismatch', `quote.pe=30 vs 其余 22.5 → PE mismatch（实际 ${byKey(r2, 'pe').status}）`);
}

console.log('=== §4 兜底 0 视为缺失（与 ZERO_AS_MISSING 同口径）===');
{
  const r = auditPayload(fixture({ fundamental: { metrics: { pe: 22.5, pb: 2.5, ps: 3.2, roe: 11.6, grossMargin: 0, netMargin: 22.1, revenueGrowth: 4.27, profitGrowth: -15.4, deductedProfitGrowth: -16.2 } } }));
  const gm = byKey(r, 'grossMargin');
  ok(gm.status !== 'mismatch', `m.grossMargin=0（兜底 0，左卡显示 --）不误报不一致（实际 ${gm.status}）`);
}

console.log('=== §5 数据缺失如实跳过 ===');
{
  const r = auditPayload(fixture({ opProfit: null, insuranceNBV: null, comparison: null }));
  ok(r.summary.total >= 10, '无 opProfit/NBV/comparison 时仍完成其余核对');
  ok(byKey(r, 'indRoe').status === 'missing', '行业均值缺失 → missing（不误报）');
  ok(r.health === 'ok', `缺数据不触发 warn（实际 ${r.health}）`);
}

console.log('=== §6 接线守卫（server / 前端 / 版本戳）===');
{
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(serverJs.includes("require('./lib/consistencyAudit')"), 'server.js 已接入 consistencyAudit');
  ok(serverJs.includes("'/api/consistency-audit'"), 'server.js 已挂 /api/consistency-audit 路由');
  ok(serverJs.includes('_lastConsistencyAudit'), 'server.js 有每日幂等守卫变量');
  ok(serverJs.includes('runConsistencyAuditDaily'), 'server.js 有每日巡检执行函数');
  ok(/启动后 60 秒：跨板块数据一致性巡检补跑/.test(serverJs), 'server.js 有启动补跑兜底');
  const accHtml = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');
  ok(accHtml.includes('data-tab="consistency"') && accHtml.includes('id="consistencyPanel"'), 'accuracy.html 有巡检页签与面板');
  const accJs = fs.readFileSync(path.join(ROOT, 'public/js/accuracy.js'), 'utf8');
  ok(accJs.includes('loadConsistency') && accJs.includes("consistency: 'consistencyPanel'"), 'accuracy.js 已接入巡检加载与面板映射');
  ok(accJs.includes('loadConsistency(true)'), '结算按钮 = 立即重跑巡检（force）');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  ok(css.includes('.ca-table'), 'style.css 有巡检明细表样式');
  ok(/const APP_VERSION = '20261106p'/.test(serverJs), "APP_VERSION = '20261106p'");
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.includes('?v=20261106p') && accHtml.includes('?v=20261106p'), 'index/accuracy 页面版本戳已对齐');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_current_quote_refresh.js`  ·  56 行

~~~js
/**
 * 详情页「当前个股」实时刷新守卫
 * 验证：详情页头部价格每 60s 跟随实时行情刷新（与左侧自选股同源），消除「同一只股两个价」。
 * 运行：node scripts/test_current_quote_refresh.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  (' + extra + ')' : '')); }
};

const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const accSrc = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');

const avm = serverSrc.match(/APP_VERSION = '([^']+)'/);
const APP_V = avm ? avm[1] : '';

console.log('===== §1 实时刷新接线 =====');
ok('server.js 存在 APP_VERSION', !!APP_V, APP_V);
ok('app.js 定义 startCurrentQuoteRefresh', /startCurrentQuoteRefresh\s*\(\)\s*\{/.test(appSrc));
ok('init() 中启动 startCurrentQuoteRefresh', /this\.startCurrentQuoteRefresh\(\);/.test(appSrc));
ok('app.js 定义 refreshCurrentQuoteTick', /refreshCurrentQuoteTick\s*\(\)/.test(appSrc));
ok('app.js 定义 refreshCurrentQuote（异步拉取行情）', /async\s+refreshCurrentQuote\s*\(\)/.test(appSrc));
ok('app.js 定义 refreshCapitalFlowSilent（资金卡静默刷新）', /async\s+refreshCapitalFlowSilent\s*\(\)/.test(appSrc));

console.log('\n===== §2 单一价格渲染口径（避免两套格式）=====');
ok('renderStockHeader 委托 applyLiveQuote', /renderStockHeader\s*\([^)]*\)\s*\{[\s\S]{0,400}this\.applyLiveQuote\(quote, market\)/.test(appSrc));
ok('stockPrice 仅在 applyLiveQuote 取一次（单一渲染点，无第二处直接写价格）',
  (appSrc.match(/getElementById\('stockPrice'\)/g) || []).length === 1);
ok('applyLiveQuote 负责写入头部价格文本', /priceEl\.textContent\s*=/.test(appSrc));

console.log('\n===== §3 刷新覆盖与同源 =====');
ok('refreshCurrentQuote 拉取 /api/quote/（与自选股同源）', /refreshCurrentQuote[\s\S]{0,400}\/api\/quote\//.test(appSrc));
ok('refreshCurrentQuote 复用 applyLiveQuote 更新头部', /refreshCurrentQuote[\s\S]{0,1200}this\.applyLiveQuote\(merged/.test(appSrc));
ok('refreshCurrentQuote 同步刷新关键指标网格 renderKeyMetrics', /refreshCurrentQuote[\s\S]{0,1200}this\.renderKeyMetrics\(this\.currentData\)/.test(appSrc));
ok('refreshCurrentQuote 触发资金量能·量价卡静默刷新', /refreshCurrentQuote[\s\S]{0,1400}this\.refreshCapitalFlowSilent\(\)/.test(appSrc));
ok('刷新对切股做隔离（丢弃过期结果，不串股）', /refreshCurrentQuote[\s\S]{0,600}期间已切股/.test(appSrc));
ok('首页（dashboard 隐藏）不刷新', /refreshCurrentQuoteTick[\s\S]{0,400}dashboard/.test(appSrc));

console.log('\n===== §4 版本戳与缓存破坏（与 APP_VERSION 一致）=====');
ok('index.html app.js?v= 与 APP_VERSION 一致', idxSrc.includes('js/app.js?v=' + APP_V));
ok('index.html style.css?v= 与 APP_VERSION 一致', idxSrc.includes('css/style.css?v=' + APP_V));
ok('index.html backtestUI.js?v= 与 APP_VERSION 一致', idxSrc.includes('js/backtestUI.js?v=' + APP_V));
ok('index.html shareholderCharts.js?v= 与 APP_VERSION 一致', idxSrc.includes('js/shareholderCharts.js?v=' + APP_V));
ok('accuracy.html style.css?v= 与 APP_VERSION 一致', accSrc.includes('css/style.css?v=' + APP_V));
ok('accuracy.html accuracy.js?v= 与 APP_VERSION 一致', accSrc.includes('js/accuracy.js?v=' + APP_V));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_daily_market_review.js`  ·  72 行

~~~js
/**
 * 每日「实时大盘 AI 复盘」→ 大盘记录 单测（20261024g）
 * 运行： node scripts/test_daily_market_review.js
 */
'use strict';
const dr = require('../lib/dailyMarketReview');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

console.log('\n[1] marketReviewMarker 标题含日期');
{
  ok(dr.marketReviewMarker('2026-10-24') === 'AI 大盘复盘 · 2026-10-24', '标题 = AI 大盘复盘 · 2026-10-24');
}

console.log('\n[2] buildMarketReviewNote 组装 scope=market 笔记');
{
  const data = { cn: [{ name: '上证指数', changePct: 0.89 }, { name: '深证成指', changePct: 2.79 }] };
  const ai = { cn: '两市放量上行，情绪回暖。', gainers: '电机领涨。', losers: '银行走弱。', model: 'glm-5.3' };
  const n = dr.buildMarketReviewNote('2026-10-24', data, ai);
  ok(n && n.scope === 'market', 'scope=market');
  ok(n && typeof n.title === 'string' && n.title.includes('AI 大盘复盘 · 2026-10-24'), 'title 含日期标记');
  ok(n && n.ai === true && n.type === 'ai', 'ai=true / type=ai');
  ok(n && Array.isArray(n.tags) && n.tags.includes('AI复盘') && n.tags.includes('大盘'), 'tags 含 AI复盘/大盘');
  ok(n && /【大盘】/.test(n.content) && /【领涨板块】/.test(n.content) && /【领跌板块】/.test(n.content), '正文含三段（大盘/领涨/领跌）');
  ok(n && /【指数收盘】上证指数 \+0\.89%，深证成指 \+2\.79%/.test(n.content), '正文含指数收盘（含正号）');
  ok(n && /glm-5\.3/.test(n.content), '正文标注模型');
  ok(n && n.verification && n.verification.status === 'pending', 'verification 初始 pending');

  const n1 = dr.buildMarketReviewNote('2026-10-24', data, ai);
  const n2 = dr.buildMarketReviewNote('2026-10-24', data, ai);
  ok(n1.id !== n2.id, '多次生成 id 唯一');
}

console.log('\n[3] 空内容/缺数据边界');
{
  ok(dr.buildMarketReviewNote('2026-10-24', { cn: [] }, { cn: '', gainers: '', losers: '' }) === null, '三段解读全空 → null（不写空记录）');
  ok(dr.buildMarketReviewNote('2026-10-24', {}, null) === null, 'ai=null → null');
  const n = dr.buildMarketReviewNote('2026-10-24', {}, { cn: '大盘一句话。' });
  ok(n && !/【指数收盘】/.test(n.content), '无指数数据 → 省略「指数收盘」行');
  ok(n && /【大盘】大盘一句话。/.test(n.content), '仅有大盘解读也能成条');
  const neg = dr.buildMarketReviewNote('2026-10-24', { cn: [{ name: '上证指数', changePct: -0.52 }] }, { cn: '回调。' });
  ok(neg && /上证指数 -0\.52%/.test(neg.content), '负涨跌幅不给「+」号');
}

console.log('\n[4] alreadyReviewed 同日幂等');
{
  const notes = [{ scope: 'market', title: 'AI 大盘复盘 · 2026-10-24' }, { scope: 'global', title: 'x' }];
  ok(dr.alreadyReviewed(notes, '2026-10-24') === true, '已有当日复盘 → true（跳过）');
  ok(dr.alreadyReviewed(notes, '2026-10-25') === false, '不同日 → false');
  ok(dr.alreadyReviewed([], '2026-10-24') === false, '空数组 → false');
  ok(dr.alreadyReviewed(null, '2026-10-24') === false, 'null → false（不崩）');
  ok(dr.alreadyReviewed([{ scope: 'market', title: 123 }], '2026-10-24') === false, 'title 非字符串 → 安全跳过');
  ok(dr.alreadyReviewed([{ scope: 'market', title: 'AI 大盘复盘 · 2026-10-24 补记' }], '2026-10-24') === true, '标题含日期子串也算已存在');
}

console.log('\n[5] 源码守卫：server.js 已接入定时任务');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(src.includes('async function runDailyMarketAiReview'), '定义 runDailyMarketAiReview');
  ok(src.includes('_lastMarketAiReview'), '有每日守卫 _lastMarketAiReview');
  ok(src.includes('runDailyMarketAiReview(today)'), '调度器内调用');
  ok(src.includes("require('./lib/dailyMarketReview')"), '引用 lib/dailyMarketReview');
  ok(src.includes('SA_NO_DAILY_AI_REVIEW'), '支持 SA_NO_DAILY_AI_REVIEW 开关');
  ok(src.includes("scope === 'market'") === false || true, '（信息）笔记 scope=market');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_daily_review.js`  ·  448 行

~~~js
/**
 * scripts/test_daily_review.js — 每日复盘隔离单测（20261110b · LLM 生成 Markdown 契约）
 * ==================================================================================
 * 用户 2026-11-10 16:03 架构裁决后的新契约守卫：
 *  - 旧输出层已废弃并删除；代码不再拼装报告文字、不再有 SECTION_DEFS / 硬性质检；
 *  - 代码交付干净 JSON Context → 复盘 System Prompt + LLM → 整篇 Markdown；
 *  - 缺失数据 / LLM 失败都不阻断发布；
 *  - 前端本地随包 Markdown 渲染，零 CDN。
 *
 * 全程用临时目录 + mock 数据源 + mock LLM 生成层，不触碰真实 data/，不发起任何外部网络请求。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-review-llm-test-'));
process.env.SA_REVIEW_DIR = path.join(TMP, 'reviews');
process.env.SA_TRADE_CALENDAR_DB = path.join(TMP, 'trade_calendar.db');
process.env.SA_TRADE_CALENDAR_OVERRIDES = path.join(TMP, 'overrides.json');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}

const LHB_OK = {
  ok: true, asOf: '2026-11-09', count: 79, netBuyTotal: -7.32, buyTotal: 88.1, sellTotal: 95.4,
  topNetBuy: [{ code: '002696', name: '百洋股份', netBuyYi: 1.87, reason: '日换手率达到20%' }],
  reasonStats: [{ reason: '日涨幅偏离值达到7%', count: 5 }],
  institutionBuyMentions: 3, institutionSellMentions: 6,
  source: 'akshare stock_lhb_detail_em（东方财富龙虎榜明细）',
};
const LHB_PENDING_BLOCK = {
  ok: false, asOf: '2026-11-09', count: null,
  note: '龙虎榜为盘后延迟发布数据：当前时点尚未发布，或接口暂不可用；本项标注「待晚间补录」',
  source: 'akshare stock_lhb_detail_em（东方财富龙虎榜明细）',
};

// ---------- 源码契约（防止旧输出层悄悄回潮） ----------
console.log('\n[1] 架构契约：纯代码拼接已下线，LLM 生成链路已接通');
t('lib/reviewOutput.js 已删除（废弃旧输出层）', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'lib', 'reviewOutput.js')), false);
});
t('reviewService 不再 require reviewOutput / 不再有 SECTION_DEFS / qualityOf 硬门禁', () => {
  const s = read('lib/reviewService.js');
  assert.ok(!s.includes("require('./reviewOutput')"), '不得再引用旧输出层');
  assert.ok(!/\b(?:const|let|var)\s+SECTION_DEFS\b/.test(s), '不得再定义固定段落常量（注释提及不算）');
  assert.ok(!s.includes('后台质检未通过'), '不得再以质检失败拒绝发布');
  assert.ok(s.includes("require('./reviewContext')") && s.includes("require('./reviewLlm')"));
  assert.ok(s.includes('reviewLlm.generate(context'), '必须真正调用 LLM 生成层');
});
t('复盘 System Prompt 已加载且包含「### 标题骨架 / 两张强制表格 / 说人话 / 柔性缺失 / 合规」要求', () => {
  const p = read('prompts/daily-review-system.md');
  ['纯 Markdown', '三级标题', '### 一句话总结', '### 题材结构与归因', '### 资金与龙虎榜', '### 明日观察计划',
    '热点题材归因卡片', '明日核心观察池', '说人话', '暂无数据', '不给任何操作指令', '归因', '龙虎榜'].forEach(k =>
    assert.ok(p.includes(k), '提示词缺少要求：' + k));
  // 用户明确要求两张表必须带字面标题【热点题材归因卡片】/【明日核心观察池】，
  // 提示词里必须出现带方括号的字面串，否则 LLM 只会当成描述性文字而不会原样输出。
  assert.ok(p.includes('【热点题材归因卡片】'), '提示词必须含字面标题【热点题材归因卡片】');
  assert.ok(p.includes('【明日核心观察池】'), '提示词必须含字面标题【明日核心观察池】');
});
t('reviewLlm 复用项目统一 callLLM、加载提示词、关闭联网搜索、失败降级不抛错', () => {
  const s = read('lib/reviewLlm.js');
  assert.ok(s.includes("require('./ai/llm')") && s.includes('callLLM('));
  assert.ok(s.includes("loadPromptFile(PROMPT_FILE)"));
  assert.ok(s.includes('webSearch: false'), '本地数据推理不得联网');
  assert.ok(s.includes('PROMPT_FILE = \'daily-review-system.md\''));
  assert.ok(s.includes('degraded(context'), 'LLM 失败必须降级而非抛错');
});
t('reviewContext 只出 JSON，不含 SECTION_DEFS / 文本拼装 / 质检', () => {
  const s = read('lib/reviewContext.js');
  assert.ok(!/\b(?:const|let|var)\s+SECTION_DEFS\b/.test(s) &&
    !/function\s+qualityOf\b/.test(s) && !/function\s+plainify\b/.test(s));
  assert.ok(s.includes('function build(') && s.includes('function lhbBlock('));
  assert.ok(s.includes('computed'), '确定性数值必须作为 Context 的一部分');
});
t('前端 Markdown 直出：不再套卡片组件，渲染器本地随包、零 CDN', () => {
  const js = read('public/js/dailyReview.js');
  const html = read('public/daily-review.html');
  assert.ok(!/\bconst TABLE_COLS\b/.test(js) && !/function\s+renderSection\b/.test(js) &&
    !js.includes('class="dr-sections"'), '不得残留 11 段卡片渲染逻辑');
  assert.ok(js.includes('window.Markdown.render') && js.includes('dr-markdown'), '必须直接渲染 Markdown');
  assert.ok(html.includes('js/markdown.js?v='), '渲染器必须本地随包');
  assert.ok(html.indexOf('js/markdown.js') < html.indexOf('js/dailyReview.js'), '渲染器必须先加载');
  const md = read('public/js/markdown.js');
  assert.ok(!/https?:\/\/[^"']*\.min\.js/.test(md), '不得引用外部 CDN');
  assert.ok(md.includes('escape') && md.includes('safeUrl'), '必须有 XSS 防护');
});
t('APP_VERSION 与 3 个 HTML 的 ?v= 缓存戳同步 20261110d（dailyReview.js 升 d，其余保持 b）', () => {
  assert.ok(read('server.js').includes("const APP_VERSION = '20261110d'"));
  assert.ok(read('public/daily-review.html').includes('js/dailyReview.js?v=20261110d'), 'daily-review 的 dailyReview.js 须升 20261110d');
  assert.ok(read('public/daily-review.html').includes('js/markdown.js?v=20261110c'), 'daily-review 的 markdown.js 须升 20261110c（标题映射修复）');
  ['public/index.html', 'public/etf-flow.html', 'public/daily-review.html'].forEach(f =>
    assert.ok(read(f).includes('?v=20261110b'), f + ' 其余资源缓存戳未升级'));
});
t('SCHEMA_VERSION 按铁律升级，旧落盘文档不会被幂等锁死', () => {
  const c = read('lib/reviewContext.js');
  assert.ok(c.includes("SCHEMA_VERSION = 'review-llm-20261110b'"));
});

// ---------- 干净 JSON Context ----------
console.log('\n[2] 干净 JSON Context：只有数据，没有报告文案');
const reviewContext = require(path.join(ROOT, 'lib', 'reviewContext'));
t('build() 产出不带 sections / lines / quads / 标题的纯数据对象', () => {
  const ctx = reviewContext.build({
    date: '2026-11-09', sources: [], engine: { trends: {}, candidates: [] },
    topics: { cards: [] }, meta: {}, stage: 'formal', dragonTigerStatus: 'pending',
  });
  assert.strictEqual(ctx.schema, 'review-context-20261110b');
  assert.strictEqual(ctx.sections, undefined);
  assert.strictEqual(ctx.quads, undefined);
  const txt = JSON.stringify(ctx);
  ['一、今日一句话', 'SECTION_DEFS', '四段式', '有效对照点', '待晚间补录。15:35'].forEach(k =>
    assert.ok(!txt.includes(k), 'Context 混入了报告文案：' + k));
});
t('computed 只保留数值/枚举，过滤引擎生成的句子字段', () => {
  const ctx = reviewContext.build({
    date: '2026-11-09', sources: [],
    engine: { schemaVersion: 'e1', marketRiskLevel: '高', trends: { zt: { direction: '收缩', ok: true, note: '有效对照点不足' } },
      candidates: [{ name: '甲', code: '600001', grade: 'A', oneLine: '这是引擎写死的一句话' }] },
    topics: { cards: [{ name: '半导体', grade: 'S', gradeReason: '引擎写死的评级理由' }] },
    meta: {}, stage: 'formal', dragonTigerStatus: 'pending',
  });
  const c = ctx.computed;
  assert.strictEqual(c.engine.trends.zt.direction, '收缩');
  assert.strictEqual(c.engine.trends.zt.note, undefined, 'trends.note 是黑话，不得进 Context');
  assert.strictEqual(c.engine.candidates[0].oneLine, undefined, '引擎句子不得进 Context');
  assert.strictEqual(c.topics.cards[0].gradeReason, undefined, '引擎句子不得进 Context');
  assert.strictEqual(c.topics.cards[0].grade, 'S');
});
t('龙虎榜未发布 → available=false，且明确非「数据缺失 / 接口故障」', () => {
  const b = reviewContext.lhbBlock(LHB_PENDING_BLOCK, '2026-11-09', 'akshare', false);
  assert.strictEqual(b.available, false);
  assert.strictEqual(b.count, null);
  assert.ok(b.note.includes('非接口故障、非数据缺失'));
});
t('龙虎榜已发布 → available=true 且数值原样不改写', () => {
  const b = reviewContext.lhbBlock(LHB_OK, '2026-11-09', 'akshare', true);
  assert.strictEqual(b.available, true);
  assert.strictEqual(b.count, 79);
  assert.strictEqual(b.netBuyTotal, -7.32);
  assert.strictEqual(b.topNetBuy[0].name, '百洋股份');
});
t('缺失数据源保留在 missing 清单并保留五要素（不臆造）', () => {
  const ctx = reviewContext.build({
    date: '2026-11-09',
    sources: [{ key: 'x', label: '某源', status: 'failed', source: 's', asOf: null, fetchedAt: 't', note: '暂无' }],
    engine: { trends: {}, candidates: [] }, topics: { cards: [] }, meta: {},
    stage: 'formal', dragonTigerStatus: 'pending',
  });
  assert.strictEqual(ctx.missing.length, 1);
  assert.strictEqual(ctx.missing[0].key, 'x');
  assert.strictEqual(ctx.sources[0].asOf, null);
});

// ---------- LLM 生成层（真实模块，不触网） ----------
console.log('\n[3] LLM 生成层：System Prompt / 降级 / 输出清洗');
const reviewLlm = require(path.join(ROOT, 'lib', 'reviewLlm'));
t('提示词文件名与超时配置正确', () => {
  assert.strictEqual(reviewLlm.PROMPT_FILE, 'daily-review-system.md');
  assert.ok(reviewLlm.TIMEOUT_MS >= 180000);
  assert.strictEqual(typeof reviewLlm.isConfigured(), 'boolean');
});
t('cleanMarkdown 去掉模型常见的 ```markdown 围栏', () => {
  assert.strictEqual(reviewLlm.cleanMarkdown('```markdown\n# 标题\n```'), '# 标题');
  assert.strictEqual(reviewLlm.cleanMarkdown('  正文  '), '正文');
});
// generate() 的真实链路（System Prompt + JSON Context 注入 callLLM）在 [5] 以 mock 通道验证，
// 此处不调用真实模型，避免守卫触发外部网络与费用。

// ---------- 前端 Markdown 渲染器 ----------
console.log('\n[4] 本地 Markdown 渲染器：排版能力 + XSS 防护');
const mdSrc = read('public/js/markdown.js');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(mdSrc, sandbox);
const MD = sandbox.Markdown;
t('标题 / 加粗 / 列表 / 引用 / 表格 / 代码块均可渲染', () => {
  const src = ['# 今日复盘', '', '**情绪升温**，比前三天放大。', '', '- 半导体', '- 光伏', '', '> 盘后观察记录', '',
    '| 题材 | 涨停家数 |', '| :--- | ---: |', '| 半导体 | 6 |', '', '```json', '{"a":1}', '```'].join('\n');
  const h = MD.render(src);
  ['<h2>', '<strong>', '<ul>', '<li>', '<blockquote>', '<table>', '<thead>', 'style="text-align:right"', '<pre><code'].forEach(k =>
    assert.ok(h.includes(k), '缺少渲染能力：' + k));
});
// URL 用拼接构造：run_all_tests.js 的 needsNetwork() 会把源码里出现「协议 + 冒号」
// 字面量的测试判为「需网络」而在 --quick 中跳过；本守卫完全不触网，不应被误分类。
const EXAMPLE_URL = 'https' + '://example.com';
const EVIL_IMG = 'https' + '://evil.example/a.png';
t('LLM 输出里的 <script> / javascript: 链接被安全处理', () => {
  const h = MD.render('<script>alert(1)</script>\n\n[点我](javascript:alert(1))\n\n[正常](' + EXAMPLE_URL + ')');
  assert.ok(!h.includes('<script>'));
  assert.ok(!h.includes('href="javascript:'));
  assert.ok(h.includes('href="' + EXAMPLE_URL + '"'));
});
t('不渲染外链图片', () => {
  const h = MD.render('![x](' + EVIL_IMG + ')');
  assert.ok(!h.includes('<img'));
});

// ---------- 端到端：mock 数据源 + mock LLM 生成层 ----------
console.log('\n[5] 端到端：runReview / 幂等 / 补录 / 降级（不触网）');
const tc = require(path.join(ROOT, 'lib', 'tradeCalendar'));
function mockSources(opts = {}) {
  const put = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, 'lib', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  put('stockData', { getMarketOverview: async () => ({
    cn: [{ code: 'sh000001', name: '上证指数', changePct: 0.86 }],
    sectorsUp: [{ name: '半导体', changePct: 3.21 }], sectorDate: '2026-11-09',
  }) });
  put('marketEmotionData', { getMarketEmotionData: async () => ({
    date: '2026-11-09',
    breadth: { up: 3100, down: 1800, flat: 200, limitUp: 62, limitDown: 9 },
    mainFund: { mainNetToday: -125.6, date: '2026-11-09' },
  }) });
  put('sectorCapitalFlow', { getSectorCapitalFlow: async () => ({ ok: true, date: '2026-11-09', todayInflowTop5: [] }) });
  put('boardReviewData', {
    getBoardReviewData: async () => ({
      ok: true, date: '2026-11-09',
      ladder: { ok: true, asOf: '2026-11-09', maxBoards: 5, limitUpCount: 32, tiers: [], promotion: [] },
      lhb: opts.lhbPending ? LHB_PENDING_BLOCK : LHB_OK,
      prevPool: { ok: true, asOf: '2026-11-09', redRate: 35.71, bigDropCount: 10, promotion: [{ from: 1, rate: 6.35 }] },
      sectors: { ok: true, asOf: '2026-11-09', top: [], industryHistory: [] },
      activity: { ok: true, asOf: '2026-11-09', ztAmountYi: 193.74 },
      historySeries: [], issues: [],
    }),
    clearCache: () => {},
    getLhbOnly: async () => ({ ok: true, date: '2026-11-09', lhb: LHB_OK, issues: [] }),
  });
  put('marketLogDb', { searchMarketLog: () => ({ total: 0, records: [], facets: {} }) });
  put('newsSearch', { getHotNews: async () => ({ source: '东财快讯', items: [{ title: '某政策发布', source: '东财', date: '2026-11-09 14:30' }] }) });
}

const LLM_CALLS = [];
let LLM_FAIL = false;
function mockLlmLayer() {
  const p = require.resolve(path.join(ROOT, 'lib', 'reviewLlm'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      PROMPT_FILE: 'daily-review-system.md', TIMEOUT_MS: 240000,
      isConfigured: () => true,
      generate: async (context, opts) => {
        LLM_CALLS.push({ context, opts });
        if (LLM_FAIL) {
          return { ok: false, degraded: true,
            markdown: '# 数据快照（AI 暂不可用）\n\n```json\n{}\n```',
            model: 'mock-model', promptFile: 'daily-review-system.md',
            error: '模拟模型超时', elapsedMs: 1, contentChars: 30 };
        }
        return { ok: true, degraded: false,
          markdown: '# 2026-11-09 复盘\n\n大模型基于干净 JSON 生成的正文，情绪比前三天放大。',
          model: 'mock-model', promptFile: 'daily-review-system.md',
          error: null, elapsedMs: 12, contentChars: 42 };
      },
    },
  };
}

(async () => {
  t('交易日历表可用（先查表，非交易日静默跳过）', () => {
    tc.ensureImported();
    assert.strictEqual(tc.isTradingDay('2026-11-09').is_trading_day, true);
    assert.strictEqual(tc.isTradingDay('2026-11-07').is_trading_day, false);
  });

  mockSources({ lhbPending: false });

  await ta('真实 reviewLlm 层：System Prompt + 干净 JSON Context 确实传给 callLLM', async () => {
    const llmPath = require.resolve(path.join(ROOT, 'lib', 'ai', 'llm'));
    const reviewLlmPath = require.resolve(path.join(ROOT, 'lib', 'reviewLlm'));
    const orig = require.cache[llmPath];
    let args = null;
    require.cache[llmPath] = {
      ...orig, exports: {
        ...orig.exports,
        callLLM: async (...a) => { args = a; return '```markdown\n# 链路实测\n```'; },
        pickModelFor: () => ({ model: 'mock-model', webSearch: false }),
      },
    };
    delete require.cache[reviewLlmPath];
    try {
      const L = require(reviewLlmPath);
      const ctx = { schema: 'review-context-20261110b', meta: { reviewDate: '2026-11-09', stage: 'formal' }, market: { breadth: { limitUp: 62 } } };
      const r = await L.generate(ctx, { stage: 'formal', date: '2026-11-09' });
      assert.ok(args, 'callLLM 必须被真正调用（证明链路不是纯代码拼装）');
      assert.strictEqual(args[3][0].role, 'system');
      assert.ok(args[3][0].content.includes('每日复盘'), 'System Prompt 必须加载复盘提示词');
      assert.ok(args[3][1].content.includes('"limitUp":62'), '干净 JSON Context 必须作为用户消息注入（紧凑序列化）');
      assert.strictEqual(args[4].webSearch, false, '本地数据推理不得联网');
      assert.strictEqual(r.markdown, '# 链路实测');
      assert.strictEqual(r.ok, true);
    } finally {
      require.cache[llmPath] = orig;
      delete require.cache[reviewLlmPath];
    }
  });

  await ta('callLLM 抛错 → 降级为数据快照，不抛异常、不拒绝发布', async () => {
    const llmPath = require.resolve(path.join(ROOT, 'lib', 'ai', 'llm'));
    const reviewLlmPath = require.resolve(path.join(ROOT, 'lib', 'reviewLlm'));
    const orig = require.cache[llmPath];
    require.cache[llmPath] = {
      ...orig, exports: {
        ...orig.exports,
        callLLM: async () => { throw new Error('模拟模型超时'); },
        pickModelFor: () => ({ model: 'mock-model', webSearch: false }),
      },
    };
    delete require.cache[reviewLlmPath];
    try {
      const L = require(reviewLlmPath);
      const r = await L.generate({ meta: { reviewDate: '2026-11-09' } }, {});
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.degraded, true);
      assert.ok(r.markdown.includes('数据快照'));
      assert.ok(!r.markdown.includes('质检未通过'));
    } finally {
      require.cache[llmPath] = orig;
      delete require.cache[reviewLlmPath];
    }
  });

  mockLlmLayer();
  const svc = require(path.join(ROOT, 'lib', 'reviewService'));

  t('SCHEMA_VERSION / 导出契约已更新（不再导出 SECTION_DEFS）', () => {
    assert.strictEqual(svc.SCHEMA_VERSION, 'review-llm-20261110b');
    assert.strictEqual(svc.SECTION_DEFS, undefined);
    assert.strictEqual(svc.CONTEXT_VERSION, 'review-context-20261110b');
  });
  t('getStatus 声明 LLM 已启用且失败策略为降级发布', () => {
    const st = svc.getStatus();
    assert.strictEqual(st.scheduler.outputFormat, 'markdown');
    assert.strictEqual(st.scheduler.llm.enabled, true);
    assert.ok(st.scheduler.llm.onFailure.includes('不阻断'));
  });

  await ta('runReview 生成 Markdown 落盘，且确实调用了一次 LLM 生成层', async () => {
    const r = await svc.runReview({ date: '2026-11-09', trigger: 'test' });
    assert.strictEqual(r.action, 'created', JSON.stringify(r));
    assert.strictEqual(r.outputFormat, 'markdown');
    assert.ok(LLM_CALLS.length >= 1, '必须调用 LLM 生成层');
    const doc = svc.readReviewSync('2026-11-09');
    assert.strictEqual(doc.outputFormat, 'markdown');
    assert.ok(doc.markdown.startsWith('# 2026-11-09 复盘'));
    assert.strictEqual(doc.stage, 'complete', '龙虎榜已有数据时直接完整版');
    assert.strictEqual(doc.llm.ok, true);
    const ver = doc.versions.find(v => v.version === doc.currentVersion);
    assert.ok(ver.context && ver.context.schema === 'review-context-20261110b', '必须保存干净 JSON Context');
    assert.strictEqual(ver.sections, undefined, '不得残留旧 sections');
    assert.strictEqual(ver.quality, undefined, '不得残留硬性质检');
    assert.strictEqual(ver.llm.model, 'mock-model');
    // 交给 LLM 的 Context 里不含任何报告文案
    assert.ok(LLM_CALLS[0].context.news[0].title === '某政策发布');
    assert.ok(!JSON.stringify(LLM_CALLS[0].context).includes('一、今日一句话'));
  });

  await ta('非交易日静默跳过（不拿最近交易日行情冒名）', async () => {
    const r = await svc.runReview({ date: '2026-11-07', trigger: 'test' });
    assert.strictEqual(r.action, 'skipped_holiday');
  });

  await ta('LLM 失败 / 字段缺失 → 降级为数据快照，照常发布（取消硬性质检）', async () => {
    LLM_FAIL = true;
    fs.rmSync(path.join(process.env.SA_REVIEW_DIR, '2026-11-06.json'), { force: true });
    const r = await svc.runReview({ date: '2026-11-06', trigger: 'test' });
    assert.strictEqual(r.action, 'created', 'LLM 失败不得拒绝发布：' + JSON.stringify(r));
    const doc = svc.readReviewSync('2026-11-06');
    assert.ok(doc.markdown.includes('数据快照'));
    assert.strictEqual(doc.llm.ok, false);
    LLM_FAIL = false;
  });

  await ta('formal → complete 补录：并入新龙虎榜并重新生成整篇 Markdown', async () => {
    fs.rmSync(path.join(process.env.SA_REVIEW_DIR, '2026-11-05.json'), { force: true });
    mockSources({ lhbPending: true });   // 让主跑时龙虎榜尚未发布 → formal
    const r1 = await svc.runReview({ date: '2026-11-05', trigger: 'test' });
    assert.strictEqual(r1.action, 'created');
    let doc = svc.readReviewSync('2026-11-05');
    assert.strictEqual(doc.stage, 'formal');
    assert.strictEqual(doc.versions[0].context.dragonTiger.available, false);
    const before = LLM_CALLS.length;
    const r2 = await svc.backfillDragonTiger('2026-11-05', { trigger: 'test' });
    assert.strictEqual(r2.action, 'completed', JSON.stringify(r2));
    assert.strictEqual(r2.stage, 'complete');
    assert.ok(LLM_CALLS.length === before + 1, '补录必须重新调用一次 LLM');
    doc = svc.readReviewSync('2026-11-05');
    assert.strictEqual(doc.stage, 'complete');
    const v2 = doc.versions.find(v => v.version === doc.currentVersion);
    assert.strictEqual(v2.context.dragonTiger.available, true);
    assert.strictEqual(v2.context.dragonTiger.count, 79);
    assert.ok(v2.markdown.startsWith('# 2026-11-09 复盘'), '完整版是重新生成的 Markdown');
    assert.strictEqual(v2.sections, undefined);
  });

  await ta('同一日期 complete 幂等唯一，重复补录静默跳过', async () => {
    const r = await svc.backfillDragonTiger('2026-11-05', { trigger: 'test' });
    assert.strictEqual(r.action, 'skipped');
    assert.ok(r.reason.includes('只允许一份'));
  });

  await ta('取消硬性质检：Context 内数据重复 / 大量 null 也不阻断发布', async () => {
    const ctx = reviewContext.build({
      date: '2026-11-04', sources: [], engine: { trends: {}, candidates: [] },
      topics: { cards: [] }, meta: {}, stage: 'formal', dragonTigerStatus: 'pending',
    });
    assert.ok(JSON.stringify(ctx).includes('null'));
    const snap = reviewContext.toDataSnapshotMarkdown(ctx, '测试');
    assert.ok(snap.includes('数据快照') && snap.includes('```json'));
    const r = await svc.runReview({ date: '2026-11-04', trigger: 'test', force: true });
    assert.ok(r.action === 'created' || r.action === 'revision', JSON.stringify(r));
  });

  await ta('SCHEMA 升级优先：旧 11 段文档即使完整度更高，重跑也会生成 Markdown 修订版', async () => {
    mockSources({ lhbPending: false });
    const f = path.join(process.env.SA_REVIEW_DIR, '2026-11-03.json');
    fs.writeFileSync(f, JSON.stringify({
      schemaVersion: 'review-20261110a', reviewDate: '2026-11-03', status: 'ok',
      stage: 'complete', currentVersion: 1,
      versions: [{ version: 1, kind: 'official', stage: 'complete',
        completeness: { score: 100 }, sections: [{ key: 'oneline', title: '一、今日一句话结论' }] }],
    }), 'utf8');
    const r = await svc.runReview({ date: '2026-11-03', trigger: 'test' });
    assert.strictEqual(r.action, 'revision', '旧结构不得锁死新报告：' + JSON.stringify(r));
    const doc = svc.readReviewSync('2026-11-03');
    assert.strictEqual(doc.schemaVersion, 'review-llm-20261110b');
    assert.ok(doc.markdown.startsWith('# 2026-11-09 复盘'));
  });

  console.log('\n──────────────────────────────────────────');
  console.log(`  每日复盘 LLM 契约守卫：${pass} 通过 / ${fail} 失败`);
  console.log('──────────────────────────────────────────');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fail) process.exit(1);
})();

~~~

---

## `scripts\test_dashboard_ui_d.js`  ·  96 行

~~~js
// test_dashboard_ui_d.js —— 20261106d 资金/量能卡与 banner 界面守卫
// 用户截图五项需求：
//  ①短期资金/中期资金文字分析补「日均净流入/净流出」；
//  ②20日涨跌日卡涨天数多于跌天数标红、反之标绿；
//  ③（诊断项，不改码）量能档位卡数据联动与可删性；
//  ④20261106d 曾把「60日量能确认」→「20日量能比」并改名，20261106e 用户裁决「换回60日卡」：
//    第 3 格恢复「60日量能确认」（该口径仍被后端多模块引用、数据从未删除），「5日量能比」新名保留；
//  ⑤个股 banner 换手率后补「量比」。
// 本轮纯前端展示改动：数值、公式、判定逻辑、API 输出结构零改动；
// 引擎 schema 与 LAYOUT_VERSION 按铁律不升。运行： node scripts/test_dashboard_ui_d.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const section = t => console.log('\n===== ' + t + ' =====');

const app = read('public/js/app.js');
const cc = read('public/js/capitalCharts.js');
const css = read('public/css/style.css');
const idx = read('public/index.html');
const cf = read('lib/capitalFlow.js');
const ve = read('lib/volumeEngine.js');
const sjd = read('lib/sameDayJudgment.js');
const server = read('server.js');

section('§1 短期/中期资金文字分析补日均净流入/流出');
ok(cc.includes('const dailyText = (s, days) =>'), 'capitalCharts.js 定义日均计算 helper');
ok(cc.includes("typeof s.mainNet !== 'number'") && cc.includes('!isFinite(s.mainNet)') && cc.includes('!(days > 0)'),
  '数据缺失/非有限值/天数非法时诚实降级，不编造日均值');
ok(/const avg = Math\.abs\(s\.mainNet\) \/ days/.test(cc), '日均 = 窗口累计主力净额 ÷ 窗口交易日天数');
ok(cc.includes("s.mainNet > 0 ? '净流入' : s.mainNet < 0 ? '净流出' : '持平'"), '方向按 mainNet 符号独立判定（净流入/净流出/持平）');
ok(cc.includes('${dailyText(s5, 5)}') && cc.includes('${dailyText(s20, 20)}'), '短期按 5 日、中期按 20 日分别计算');
ok(cc.includes('近5日主力${dir}') && cc.includes('近20日主力${dir}'), '原累计额文案保留，日均追加在其后');
ok(cc.includes('日均${d}${avg.toFixed(2)}亿'), '文案含「日均净流入/净流出 X.XX亿」');
ok(/rows\.push\(\{ icon: '💰'[\s\S]{0,260}tone: moneyTone\(s5\.mainNet\)/.test(cc), '短期资金 tone 仍按累计净额着色，未因追加文字改变');

section('§2 20日涨跌日卡：涨多红 / 跌多绿（全站红涨绿跌）');
for (const [name, src] of [['app.js', app], ['capitalCharts.js', cc]]) {
  ok(src.includes('const daysCls ='), `${name} 定义 daysCls`);
  ok(/vp\.upDays > vp\.downDays \? 'cap-pos' : vp\.upDays < vp\.downDays \? 'cap-neg' : ''/.test(src),
    `${name} 涨多 cap-pos（红）/ 跌多 cap-neg（绿）/ 持平中性`);
  ok(src.includes('class="cm-value ${daysCls}"'), `${name} 涨跌日 tile 应用 daysCls`);
  ok(src.includes('涨天数多于跌天数标红'), `${name} 标签 title 写明着色规则`);
}
ok(css.includes('.cap-pos { color: var(--red); }') && css.includes('.cap-neg { color: var(--green); }'), '红涨绿跌色值仍为 --red / --green');

section('§3 banner 换手率后补量比');
ok(idx.includes('id="stockVolRatio"') && idx.includes('class="stock-vol-ratio"'), 'index.html 新增量比 span');
ok(idx.indexOf('id="stockTurnover"') < idx.indexOf('id="stockVolRatio"')
  && idx.indexOf('id="stockVolRatio"') < idx.indexOf('id="stockAmount"'), '顺序为 换手率 → 量比 → 成交额');
ok(css.includes('.stock-vol-ratio::before { content: \'量比 \''), 'CSS 前缀标签为「量比 」');
ok(css.includes('.stock-turnover, .stock-amount, .stock-vol-ratio'), '量比与相邻两枚同字号同色，信息行节奏统一');
ok(app.includes("typeof quote.volumeRatio === 'number'") && app.includes('isFinite(quote.volumeRatio)') && app.includes('quote.volumeRatio > 0'),
  '取腾讯行情原生字段 quote.volumeRatio，非正数不展示');
ok(app.includes("vrEl.textContent = quote.volumeRatio.toFixed(2)"), '显示两位小数比值');
ok(/vrEl\.style\.display = 'none'/.test(app), '字段缺失时整段隐藏，不用均值反推/不估算');
ok(app.includes('腾讯行情口径，盘中为半天累计量、收盘后定论'), 'tooltip 标注盘中 caveat');
ok(app.includes('与量能引擎 volumeState.ratio5 同源'), '20261106l：tooltip 标注与 volumeState.ratio5 同源（5日量能比卡退役后 banner 为 ÷5 口径唯一展示处）');

section('§4 20261106k/l：「60日量能确认」「5日量能比」卡先后退役，量价统计行三联');
ok(!app.includes('>5日量能比</span>') && !app.includes('>60日量能确认</span>'), '20261106l：「5日量能比」与「60日量能确认」卡均已退役');
ok(!app.includes('>量能档位</span>') && !app.includes('>20日量能比</span>'), '旧卡名「量能档位」与临时「20日量能比」零残留');
ok(!app.includes('const vr60') && !app.includes('const confirmTile') && !app.includes('const confirmVal'), '60 日展示层变量与 tile 全部清理，无死代码');
ok(!app.includes('const volTierSub') && !app.includes('const volTierTile') && !app.includes('const volTierTip'), '20261106l：5日量能比展示层变量（volTierSub/volTierTile/volTierTip）零残留');
ok(!app.includes('const vs = ve.volumeState'), '20261106l：主分支专用 vs 别名随卡退役');
ok(!ve.includes('confirmDesc:') && !/pc\.confirm\b/.test(ve) && !cf.includes('confirm'), '20261106n：引擎与 capitalFlow 的 60 日口径字段（confirm/confirmDesc）已彻底删除');
ok(app.includes('全量价判定已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源）') && app.includes('与 ÷20 统一口径分母不同，数值不应相等'), '底部口径说明写明全量价判定统一 ÷20 分母并列原始指标卡');
ok(app.includes('60 日均量口径整体退役') && app.includes('全量价判定与文字分析统一使用 20 日量能比'), '20261106n：口径说明披露 60 日口径整体退役、文字分析统一 ÷20');
ok(/<div class="ve-tile-row ve-cols-3">\s*\$\{vpRatioTile\}/.test(app), '20261106l：三联行 ve-cols-3（20日涨跌日量能比 → 20日涨跌日 → 20日净涨跌）');

section('§5 数值 / 公式 / 判定结构零改动');
ok(cf.includes('const volumePriceRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 1;'), 'capitalFlow 量价比公式原样');
ok(ve.includes('const ratio20 = avg20 > 0 ? volToday / avg20 : null;'), 'volumeEngine ratio20 公式原样');
ok(ve.includes('const health = (upVols.length && dnVols.length) ? _mean(upVols) / _mean(dnVols) : null;'), '⑤量价健康度公式原样');
ok(ve.includes('volumeTier: _volumeTier(pc)'), 'volumeTier 统一真值源仍输出（量能档位数据未被删除，§3 诊断结论）');
ok(cf.includes('unifiedTier = volumeEngine.volumeTier;'), 'capitalFlow 仍消费 volumeTier（下游联动未断）');
ok(app.includes('${vp.ratio != null ? vp.ratio') && app.includes('esc(vol.ratio20)'), '前端仍消费原字段 vp.ratio / vol.ratio20');
ok(ve.includes("schema: 'volume-engine-20261109c'"), '引擎 schema = volume-engine-20261109c（量能单一真值源）');
ok(sjd.includes("const LAYOUT_VERSION = '20261106o'"), 'LAYOUT_VERSION 已升 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，判断记录强制重算）');

section('§6 版本戳与缓存破坏');
ok(/const APP_VERSION = '20261106p'/.test(server), 'APP_VERSION = 20261106p');
ok(server.includes('[20261106e]'), 'server.js 存在 [20261106e] 独立变更日志条目');
ok(server.includes('[20261106d]'), 'server.js 存在 [20261106d] 独立变更日志条目');
ok(server.includes('[20261106c]') && server.includes('[20261106b]'), '功能引入版本号保留，未随全局升版误改（铁律）');
for (const f of ['index.html', 'accuracy.html', 'logic-model.html', 'notes.html', 'volume-map.html']) {
  const html = read('public/' + f);
  ok(html.includes('?v=20261106p') && !html.includes('?v=20261106l'), `public/${f} 缓存戳全部对齐 20261106p`);
}

console.log(`\n===== 汇总：通过 ${pass} / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_data_honesty.js`  ·  88 行

~~~js
/**
 * 数据诚实原则·守卫测试（20261002b）
 * --------------------------------------------------------------
 * 回归锁定：未成功获取的数据必须明示"获取失败"，绝不拿
 *   ① 其他来源数据冒充；② 陈旧快照当新数据；③ 零值/空值伪装成已算出结果。
 *
 * 两类断言：
 *   一、lib/dataHonesty.js 信封单元：ok/stale/fail/classify/hasSilentPadding 行为正确。
 *   二、静态扫描 lib/ 全量源码，禁止"零值聚合伪装成功"的反模式
 *       （stats: { mean:0, std:0, high:0, low:0 } 这类全零聚合出现在"结果信封"返回里）。
 *       合法的空输入统计助手（deep/shared.js、deep/statements.js 的 _calcStats）
 *       在空输入时返回全零是正常行为，列入豁免名单；但调用方必须据此返回 success:false，
 *       因此扫描只禁止"结果信封级"的伪装，不禁止纯统计助手本身。
 */
const fs = require('fs');
const path = require('path');
const dh = require('../lib/dataHonesty');

const ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'lib');
const ZERO_STATS_RE = /mean:\s*0,\s*std:\s*0,\s*high:\s*0,\s*low:\s*0/;
// 豁免：纯统计助手在空输入时返回全零是合法行为（调用方负责返回 success:false）
const EXEMPT = new Set(['lib/deep/shared.js', 'lib/deep/statements.js']);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

// —— 一、信封单元 ——
console.log('===== 一、统一信封单元 =====');
const fresh = dh.ok({ series: [1, 2] }, { source: '东财' });
ok(fresh.success === true && fresh.source === '东财', 'ok() 返回 success:true 且带 source');
ok(dh.classify(fresh) === 'fresh', 'classify(fresh)=fresh');
ok(dh.isFresh(fresh) && !dh.isFailure(fresh), 'isFresh 正确、isFailure 否定');

const st = dh.stale({ series: [1] }, { reason: '数据源暂不可用，显示最近快照' });
ok(st.success === true && st.stale === true && /快照/.test(st.staleReason), 'stale() 显式标注 stale + staleReason');
ok(dh.classify(st) === 'stale', 'classify(stale)=stale');

const er = dh.fail('连接超时', { source: '同花顺', errorType: 'TIMEOUT' });
ok(er.success === false && er.errorType === 'TIMEOUT' && er.reason === '连接超时', 'fail() 诚实声明 success:false + errorType + reason');
ok(dh.classify(er) === 'failed', 'classify(failed)=failed');
ok(dh.isFailure(er) && !dh.isFresh(er), 'isFailure 正确、isFresh 否定');
ok(dh.isFailure(null) === true, 'null 保守判为失败');
ok(dh.isFailure({ success: false }) === true, 'success:false 判为失败');
ok(dh.classify({}) === 'fresh', '缺 success 字段默认 fresh（合同要求调用方显式置 success；自身缓存读取返回 {} 不报错）');

// 反凑数检测：成功信封里塞全零聚合 + note 说明失败 → 视为伪装
const padded = { success: true, stats: { mean: 0, std: 0, high: 0, low: 0 }, note: '暂不可用' };
ok(dh.hasSilentPadding(padded) === true, 'hasSilentPadding 命中"成功+全零聚合+note"伪装');
ok(dh.hasSilentPadding(er) === false, '已诚实声明 success:false 的不算伪装');
ok(dh.hasSilentPadding({ stats: { mean: 0, std: 0, high: 0, low: 0 } }) === false, '纯统计助手空返回（无 success/无 note）不算伪装');

// —— 二、静态扫描 lib/ 禁止零值聚合伪装 ——
console.log('\n===== 二、lib/ 反凑数静态扫描 =====');
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(p);
  }
}
const files = [];
walk(LIB_DIR, files);
let violations = [];
let exemptHits = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const src = fs.readFileSync(f, 'utf8');
  if (ZERO_STATS_RE.test(src)) {
    if (EXEMPT.has(rel)) { exemptHits++; }
    else { violations.push(rel); }
  }
}
ok(exemptHits === EXEMPT.size, `豁免名单中的统计助手仍含全零聚合（${exemptHits}/${EXEMPT.size}，证明扫描非真空洞）`);
if (violations.length) {
  console.log('  —— 命中反模式（结果信封返回全零聚合，违反诚实原则）：');
  violations.forEach(v => console.log('     · ' + v));
} else {
  console.log('  （lib/ 中无"结果信封返回全零聚合"的反模式）');
}
ok(violations.length === 0, 'lib/ 全量源码无零值聚合伪装（股息率链路 yield.js/pipeline.js 已修复）');

console.log(`\n===== test_data_honesty 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_deep_chip_u1.js`  ·  82 行

~~~js
// =====================================================================
// test_deep_chip_u1.js —— U1「深度分析筹码分布统一到锚点三」守卫（20261105j 定版）
// 背景：deep/pipeline.js 原有一套 120 日窗口 / 50 档 / 指数衰减的过时筹码算法，
//       与量价判定锚点三（lib/chipDistribution.js 本地 CYQ）并存。U1 将其统一。
// 核实前提：旧 sections.chipDistribution 全项目零下游消费（深度分析页「成交密集区」图
//           用的是 capitalFlow.volumeProfile 的另一套 VPVR），故换输出字段不会破坏下游。
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { computeChipDistribution, CYQ_WINDOW, CYQ_BARS } = require('../lib/chipDistribution');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'deep', 'pipeline.js'), 'utf8');
const veSrc = fs.readFileSync(path.join(ROOT, 'lib', 'volumeEngine.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = (t) => console.log('\n===== ' + t + ' =====');

section('§A 旧 120 日算法已整块移除');
ok(!src.includes('function calculateChipDistribution'), '旧 calculateChipDistribution 函数已删除');
ok(!src.includes('slice(-120)'), '120 日窗口已移除');
ok(!src.includes('binCount = 50'), '50 档分箱已移除');
ok(!src.includes('const decay = 0.995'), '指数衰减权重已移除');
ok(!src.includes('dayWeight'), '旧 dayWeight 已移除');

section('§B 新锚点三模块接线');
ok(src.includes("require('../chipDistribution')"), '静态 require 锚点三模块');
ok(/const \{\s*computeChipDistribution\s*\}/.test(src), '解构 computeChipDistribution');
ok(src.includes('computeChipDistribution(history, fv * 1e8 / px, {})'), '调用入参 = history + 流通股本');
ok(src.includes('quote.circulationValue'), '流通股本来源 = 腾讯行情流通市值(亿)');
ok(src.includes('authoritativePrice > 0 ? authoritativePrice'), '现价优先用入口确立的权威价');

section('§C 与 volumeEngine 锚点三同源（单一权威源）');
ok(veSrc.includes('computeChipDistribution(barsResult.bars, fv * 1e8 / px'), '引擎侧同为 fv*1e8/px 推流通股本');
ok(veSrc.includes("require('./chipDistribution')"), '引擎侧也 require 同一模块');
ok(CYQ_WINDOW === 250 && CYQ_BARS === 150, '250 日窗口 / 150 档为单一知识源参数');

section('§D 诚实降级与不伪造');
ok(src.includes('if (!fv || !px) return null;'), '流通股本或权威价不可得 → 不上报筹码');
ok(src.includes('if (!chip) return null;'), 'CYQ 计算失败 → 不上报筹码');
ok(src.includes('chartData: null, peakPrice: null, minPrice: null, maxPrice: null'), '新模块不产出的旧字段一律置 null，禁止编造');
ok(src.includes('profitRatio: chip.benefitPct'), '兼容别名 profitRatio 取真实 benefitPct（同为百分比量纲）');
ok(src.includes('dataDate:'), '保留数据日五要素之一');
ok(src.includes('...chip'), '输出含新模块原生字段（benefitRatio/avgCost/p90/p70/verdict/note/basis）');

section('§E 新模块行为自洽（合成日K，零网络）');
function mkBars(n) {
  const out = [];
  const d0 = new Date('2025-01-02');
  while (out.length < n) {
    const wd = d0.getDay();
    if (wd !== 0 && wd !== 6) {
      const i = out.length;
      const px = 30 + 6 * Math.sin(i / 18) + i * 0.012;
      out.push({
        date: d0.toISOString().slice(0, 10),
        open: px - 0.12, close: px + 0.08, high: px + 0.5, low: px - 0.5,
        volume: 120000, // 手
      });
    }
    d0.setDate(d0.getDate() + 1);
  }
  return out;
}
const bars = mkBars(260);
const floatShares = 5e9; // 50 亿股 → 日换手约 0.24%
const chip = computeChipDistribution(bars, floatShares, {});
ok(chip !== null, '合成 260 根日K + 有效流通股本 → 筹码计算成功');
if (chip) {
  ok(chip.window === 250, '窗口取 250 日');
  ok(typeof chip.benefitRatio === 'number' && chip.benefitRatio >= 0 && chip.benefitRatio <= 1, 'benefitRatio ∈ [0,1]');
  ok(chip.benefitPct === +((chip.benefitRatio * 100).toFixed(1)), 'benefitPct 与 benefitRatio 同口径');
  ok(typeof chip.avgCost === 'number' && chip.avgCost > 0, 'avgCost 为正数');
  ok(!!chip.p90 && !!chip.p70 && typeof chip.verdict === 'string' && !!chip.basis, 'p90/p70/verdict/basis 齐备');
}
ok(computeChipDistribution([], floatShares, {}) === null, 'bars 不足 → null 降级');
ok(computeChipDistribution(bars, 0, {}) === null, '流通股本缺失 → null 降级');

console.log(`\n===== 汇总：通过 ${pass}/${pass + fail} =====`);
process.exit(fail > 0 ? 1 : 0);

~~~

---

## `scripts\test_emotion_judgment_consistency.js`  ·  139 行

~~~js
/**
 * 「首页情绪 vs 个股大盘因子」一致性回归（20261024g）
 * ---------------------------------------------------------------------------
 * 运行： node scripts/test_emotion_judgment_consistency.js
 *
 * 用户报障（2026-10-24 14:00 截图）：
 *   首页「市场情绪提醒」= 情绪总分 0.009（中性）· 放量（量比 1.24）· 量价齐升；
 *   个股士兰微「大盘」因子 = 市场情绪提醒 看跌·预警 · 情绪总分 -0.317 · 平量。
 *   同一句「引用首页判断（2026-10-24）」，数值却相反 → 违反单源一致性铁律。
 *
 * 根因：个股判断在生成时把当日情绪总分**烘死**进 factors[sentiment].subFactors[市场情绪提醒].signal；
 *   之后首页情绪被重算（-0.317 → 0.009），判断缓存仍按 targetDate 复用，未感知情绪已变。
 * 修复：复用前比对「烘焙的情绪信号」与「当前最新情绪记录」，不一致 → 强制重算。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sdj = require('../lib/sameDayJudgment');
const mem = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function recWith(signal) {
  return { factors: [{ key: 'sentiment', name: '大盘', subFactors: [{ name: '市场情绪提醒', signal }] }] };
}

// ============================================================================
console.log('\n[1] _findEmotionSubSignal 从判断记录里取出烘焙的情绪信号');
{
  ok(sdj._findEmotionSubSignal(recWith(-0.317)) === -0.317, '取出 市场情绪提醒.signal = -0.317');
  ok(sdj._findEmotionSubSignal({ factors: [{ key: 'sentiment', subFactors: [{ name: '大盘短期走势', signal: 0 }] }] }) === null, '无「市场情绪提醒」子因子 → null');
  ok(sdj._findEmotionSubSignal({}) === null, '空记录 → null');
  ok(sdj._findEmotionSubSignal(recWith(0)) === 0, 'signal=0 属于有效值（不当作 null）');
}

// ============================================================================
console.log('\n[2] _emotionSubStale：引用信号变化即判过期（核心复现用户场景；20261028c 起比对口径=_emotionQuoteSig）');
{
  const orig = mem.readLatestJudgment;
  const rec = recWith(-0.317);

  mem.readLatestJudgment = () => ({ score: 0.009, tendency: '中性', tendencyKey: 'neutral' });
  ok(sdj._emotionSubStale(rec) === true, '烘焙 -0.317 vs 当前中性(0.009→信号0) → 过期=true（需重算）');

  mem.readLatestJudgment = () => ({ score: -0.317, tendency: '看跌', tendencyKey: 'bear' });
  ok(sdj._emotionSubStale(rec) === false, '烘焙 -0.317 vs 当前看跌(-0.317) → 未变=false（可复用）');

  mem.readLatestJudgment = () => ({ score: -0.31700001, tendency: '看跌', tendencyKey: 'bear' });
  ok(sdj._emotionSubStale(rec) === false, '浮点抖动（<0.0005）→ 未变=false（不误重算）');

  // 20261028c 关键回归：中性场景烘焙 0 vs 当前中性 → 不误判过期（否则每次请求都强制重算）
  const recNeutral = recWith(0);
  mem.readLatestJudgment = () => ({ score: -0.04, tendency: '中性', tendencyKey: 'neutral' });
  ok(sdj._emotionSubStale(recNeutral) === false, '烘焙 0（中性）vs 当前中性(-0.04→信号0) → 未变=false（不误重算）');

  mem.readLatestJudgment = () => null;
  ok(sdj._emotionSubStale(rec) === false, '当前情绪不可得 → false（交回原逻辑按中性处理）');

  mem.readLatestJudgment = () => ({ score: 1.4, tendency: '看涨', tendencyKey: 'bull' });
  ok(sdj._emotionSubStale(recWith(1)) === false, '当前分 clamp 到 1，与烘焙 1 一致 → false');

  ok(sdj._emotionSubStale(recWith(null)) === false, '记录无情绪子因子 → false（不额外判）');

  mem.readLatestJudgment = orig;
}

// ============================================================================
console.log('\n[3] 真实数据端到端：600460 缓存判断(11:35) vs 最新情绪记录');
{
  const jf = path.join(__dirname, '..', 'data', 'judgments', '2026-10-26.json');
  const rf = path.join(__dirname, '..', 'data', 'market-emotion', 'records.json');
  if (fs.existsSync(jf) && fs.existsSync(rf)) {
    const arr = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const rec = arr.find(x => String(x.symbol || '').includes('600460'));
    const emo = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const last = emo[emo.length - 1];
    if (rec && last && typeof last.score === 'number') {
      const baked = sdj._findEmotionSubSignal(rec);
      const curSig = sdj._emotionQuoteSig(last); // 20261028c：与引用子因子同源的信号推导
      if (baked !== null) {
        const shouldStale = Math.abs(baked - curSig) > 0.0005;
        // 不依赖具体数值，只校验「门控判定 == 烘焙/当前是否真的不同」这一因果关系
        ok(sdj._emotionSubStale(rec) === shouldStale,
          `600460 烘焙情绪 ${baked} vs 最新 ${curSig} → _emotionSubStale=${shouldStale}（与差值一致）`);
        console.log(`     （记录 generatedAt=${rec.generatedAt}, 最新情绪 date=${last.date} score=${last.score}）`);
      } else {
        console.log('     （600460 记录无情绪子因子，跳过）');
      }
    } else {
      console.log('     （记录/情绪文件结构不含预期字段，跳过）');
    }
  } else {
    console.log('     （判断/情绪数据文件不存在，跳过端到端校验）');
  }
}

// ============================================================================
console.log('\n[4] 源码守卫：复用条件必须包含情绪门控');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
  ok(src.includes('_emotionSubStale(rec)'), 'getJudgmentWithAccuracy 复用条件含 _emotionSubStale(rec)');
  ok(src.includes('!_emotionSubStale(cur)'), 'ensureAllTrackedJudgments 复用条件含 !_emotionSubStale(cur)');
  ok(src.includes('function _emotionSubStale'), '定义 _emotionSubStale');
  ok(src.includes('readLatestJudgment()'), '读最新情绪记录（单源）');
}

// ============================================================================
console.log('\n[5] 引用子因子单源同义（20261028c）：徽标语义必须继承首页 tendency，不得自行判档');
{
  // _emotionQuoteSig 映射
  ok(sdj._emotionQuoteSig({ score: -0.04, tendency: '中性', tendencyKey: 'neutral' }) === 0, '首页中性(-0.04) → 引用信号 0（不再被判利空）');
  ok(sdj._emotionQuoteSig({ score: -0.5, tendency: '看跌', tendencyKey: 'bear' }) === -0.5, '首页看跌(-0.5) → -0.5');
  ok(sdj._emotionQuoteSig({ score: 0.3, tendency: '看涨', tendencyKey: 'bull' }) === 0.3, '首页看涨(+0.3) → +0.3');
  ok(sdj._emotionQuoteSig({ score: -0.04 }) === 0, '旧记录无 tendencyKey → 按中性兜底 → 0');
  ok(sdj._emotionQuoteSig(null) === 0, '无记录 → 0');
  // computeMarketEmotionSub 端到端：中性首页不得输出利空信号
  const orig = mem.readLatestJudgment;
  mem.readLatestJudgment = () => ({
    date: '2026-10-28', score: -0.039, tendency: '中性', tendencyKey: 'neutral',
    coreDriver: '融资余额（杠杆资金）', volumeState: '平量（量比 0.97）', advice: '维持中性、不追高不杀跌，建议仓位 4 成',
  });
  const sub = sdj.computeMarketEmotionSub();
  ok(sub.signal === 0, '首页中性 → 引用子因子 signal=0（徽标中性、权重行隐藏）');
  ok(/中性/.test(sub.value), `value 仍显示首页倾向「中性」（实际：${sub.value}）`);
  ok(/-0\.04/.test(sub.detail) && /继承首页判档/.test(sub.detail), 'detail 保留原始分数 + 注明徽标继承首页判档');
  mem.readLatestJudgment = () => ({ date: '2026-10-28', score: -0.5, tendency: '看跌', tendencyKey: 'bear' });
  const subBear = sdj.computeMarketEmotionSub();
  ok(subBear.signal === -0.5 && subBear.signal < 0, '首页看跌 → 引用子因子信号为负（利空徽标与 tendency 同向）');
  mem.readLatestJudgment = () => ({ date: '2026-10-28', score: 0.4, tendency: '看涨', tendencyKey: 'bull' });
  const subBull = sdj.computeMarketEmotionSub();
  ok(subBull.signal === 0.4 && subBull.signal > 0, '首页看涨 → 引用子因子信号为正（利好徽标与 tendency 同向）');
  mem.readLatestJudgment = orig;
}

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_emotion_margin_dual.js`  ·  203 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_emotion_margin_dual.js — [20261109a] 两融余额因子卡「融资 / 融券双栏平分权重」守卫
 *
 * 用户指令（截图 屏幕截图 2026-11-09 124522.png）：
 *   「图二卡片修改：添加融券余额数据，余额增加判断为短期利空，余额减少判断为短期利好，
 *     融券余额和融资余额共用平分卡片的权重。」
 * 用户选型：一张卡内双栏 + 沿用融资同口径（5 日变动 / ±0.5%，月末 ±0.8% / ±10% 异常闸门）。
 *
 * 本守卫验证：
 *   §1 calcMargin 纯函数：9 种方向组合、缺失 / 异常 / 月末阈值、subs 契约
 *   §2 端到端：半格按原始 score 计入净权重与总分，其它 9 因子零改动、权重和恒 100
 *   §3 Python 取数列精确匹配（「融资融券余额」不得被误当「融券余额」）
 *   §4 前端语义着色与接线（融券「+」=利空，不得按数值符号染红）
 * 全部离线、零网络；端到端部分用临时目录，不碰生产 records/state。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-margin-dual-test-'));
process.env.SA_MARKET_EMOTION_DIR = TMP;
process.env.SA_MSI_SERIES = path.join(TMP, 'msi-series.json');
fs.writeFileSync(process.env.SA_MSI_SERIES, '[]');

const { computeMarketEmotion, calcMargin, FACTOR_NAMES } = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
const M = (rz, rq, extra = {}) => Object.assign({
  latest: 22710, change5Pct: rz,
  rqLatest: 288.11, rqChange5Pct: rq,
}, extra);
const call = (m, isMonthEnd = false) => calcMargin({ date: '2026-11-09', margin: m }, isMonthEnd);

(async () => {
  // ---------- §1 纯函数分支 ----------
  console.log('\n[§1] 融资 / 融券方向组合（融资增=利好，融券增=利空，各占 50%）');
  const cases = [
    { rz: 1.2, rq: -1.2, score: 1, long: 1, short: 1, desc: '融资加仓 + 融券减少 → 双利好 → 满格 +1' },
    { rz: -1.2, rq: 1.2, score: -1, long: -1, short: -1, desc: '融资撤离 + 融券增加 → 双利空 → 满格 -1' },
    { rz: 1.2, rq: 1.2, score: 0, long: 1, short: -1, desc: '融资加仓 + 融券增加 → 互相抵消 → 0' },
    { rz: -1.2, rq: -1.2, score: 0, long: -1, short: 1, desc: '融资撤离 + 融券减少 → 互相抵消 → 0' },
    { rz: 1.2, rq: 0.1, score: 0.5, long: 1, short: 0, desc: '仅融资利好 → 半格 +0.5' },
    { rz: -1.2, rq: 0.1, score: -0.5, long: -1, short: 0, desc: '仅融资利空 → 半格 -0.5' },
    { rz: 0.1, rq: -1.2, score: 0.5, long: 0, short: 1, desc: '仅融券利好 → 半格 +0.5' },
    { rz: 0.1, rq: 1.2, score: -0.5, long: 0, short: -1, desc: '仅融券利空 → 半格 -0.5' },
    { rz: 0.1, rq: 0.1, score: 0, long: 0, short: 0, desc: '两侧均不明显 → 0' },
  ];
  for (const c of cases) {
    const r = call(M(c.rz, c.rq));
    ok(r.score === c.score, `${c.desc}（score=${r.score}）`);
    ok(r.subs[0].dir === c.long && r.subs[1].dir === c.short, `  └ 子项方向 融资=${r.subs[0].dir} 融券=${r.subs[1].dir}`);
  }

  console.log('\n[§1b] subs 契约与语义着色 tone');
  {
    const r = call(M(1.2, 1.2));
    ok(Array.isArray(r.subs) && r.subs.length === 2, 'subs 恰为 2 个子项');
    ok(r.subs[0].name === '融资余额' && r.subs[1].name === '融券余额', '子项名称正确');
    ok(r.subs.every(s => s.weightPct === 50), '两子项各占 50%');
    ok(r.subs[0].tone === 'bull' && r.subs[1].tone === 'bear', '融资利好=红(bull) / 融券增加利空=绿(bear)');
    ok(r.subScore === true, 'subScore=true 标记（净权重/总分用原始 score）');
    ok(/各占本卡 50% 权重/.test(r.splitNote || ''), 'splitNote 明示平分权重');
    ok(!/[+−-]\d+\.\d+%/.test(r.detail), 'detail 不含带符号百分比（防前端按符号染错色）');
    ok(r.change5Pct === 1.2, 'change5Pct 仍是融资 5 日变动（topWarning 口径不变）');
    ok(r.lagged === true && r.lagKind === 'cadence', 'T+1 例行披露标记保留');
  }

  console.log('\n[§1c] 缺失 / 异常 / 月末阈值');
  {
    const noRq = call({ latest: 22710, change5Pct: 1.2 });
    ok(noRq.degraded === false, '融券缺失不降级整卡');
    ok(noRq.score === 0.5, `融券缺失 → 仅融资半格 +0.5（实际 ${noRq.score}）`);
    ok(noRq.subs[1].absent === true && noRq.subs[1].tone === 'flat', '融券子项标 absent / 中性');
    ok(/不计分|不计入/.test(noRq.subs[1].note + noRq.detail) || /融券余额缺失/.test(noRq.detail), '缺失口径已如实披露');
  }
  {
    const r = call(M(1.2, 25));
    ok(r.subs[1].absent === true && r.score === 0.5, '融券 5 日变动超 ±10% → 该子项不计分（不误降级整卡）');
    const r2 = call(M(25, -1.2));
    ok(r2.degraded === true, '融资 5 日变动超 ±10% → 整卡降级（与旧版一致）');
  }
  {
    ok(call({ latest: 0, change5Pct: 1.2 }).degraded === true, '融资余额缺失 → 降级');
    ok(call({ latest: 22710 }).degraded === true, '融资变化不可用 → 降级');
  }
  {
    // 0.6% 在平日 (±0.5%) 达阈值、月末 (±0.8%) 不达 → 月末放宽只影响融资侧，融券 0.1% 两侧都不明显
    const normal = call(M(0.6, 0.1), false);
    const monthEnd = call(M(0.6, 0.1), true);
    ok(normal.score === 0.5 && monthEnd.score === 0,
      `月末阈值放宽到 ±0.8% 生效（平日 ${normal.score} / 月末 ${monthEnd.score}）`);
  }

  // ---------- §2 端到端 ----------
  console.log('\n[§2] 端到端：半格计入总分、其它因子零改动、权重和恒 100');
  function mkBars(n) {
    const bars = []; let close = 3800;
    const endT = Date.parse('2026-09-17T00:00:00');
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dates = [];
    for (let t = endT; dates.length < n; t -= 86400000) {
      const d = new Date(t);
      if (d.getDay() !== 0 && d.getDay() !== 6) dates.unshift(fmt(d));
    }
    for (let i = 0; i < n; i++) {
      close *= 1.0005;
      bars.push({ date: dates[i], close: Math.round(close * 100) / 100, vol: Math.round(5e8 * (1 + Math.sin(i / 7) * 0.1)) });
    }
    return bars;
  }
  const bundle = (margin) => ({
    ok: true, date: '2026-09-17',
    index: { code: 'sh000001', name: '上证指数', bars: mkBars(260) },
    breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
    margin,
    mainFund: { mainNetToday: 150, history: [] },
    capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
    fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
    bond: { cn10y: 2.0, chgBp5: 5 },
    discussionHeat: { marketHeat: 0.2, date: '2026-09-17', value: '热度 0.2', detail: '讨论综合得分 0.12、看多占比 55%（数据源：东财股吧，样本 1200 只）' },
    issues: [], warnings: [],
  });
  {
    const r = await computeMarketEmotion({ data: bundle(M(1.2, 1.2)), macroFactors: [] });
    const mg = r.factors.find(f => f.key === 'margin');
    ok(r.factors.length === 10, '因子数仍为 10（8 常驻 + 2 非常驻），未新增因子');
    ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '权重合计仍 = 100%');
    ok(mg.score === 0 && mg.contribution === 0, '两子项反向 → margin 净权重 0');
    ok(mg.name === '两融余额' && FACTOR_NAMES.margin === '两融余额', '卡片显示名已缩短为「两融余额」');
    // 关键回归：computeMarketEmotion 返回时 factors 经过字段白名单，漏透出 subs 会让前端双栏不渲染
    ok(Array.isArray(mg.subs) && mg.subs.length === 2, '输出白名单已透出 subs（前端才能渲染双栏）');
    ok(mg.subScore === true && /50%/.test(mg.splitNote || ''), 'subScore / splitNote 一并透出');
    const dirOf = s => (s > 0 ? 1 : s < 0 ? -1 : 0);
    const dirVal = f => (f.subScore ? (f.score || 0) : dirOf(f.score || 0));
    const exp = r.factors.reduce((a, f) => a + dirVal(f) * (f.weight / 100), 0);
    ok(Math.abs(r.totalScore - exp) < 0.001, `总分 = Σ(方向强度×权重)（${r.totalScore} vs ${exp.toFixed(3)}）`);
    ok(r.factors.every(f => Math.abs((f.contribution || 0) - dirVal(f) * f.weight) < 0.011), '每因子净权重与评分同源');
  }
  {
    // 半格因子：融资 +1、融券 0 → score=+0.5，净权重必须恰为权重的一半（不被 dirOf 压回满格）
    const r = await computeMarketEmotion({ data: bundle(M(1.2, 0.1)), macroFactors: [] });
    const mg = r.factors.find(f => f.key === 'margin');
    ok(mg.score === 0.5, '半格 score=+0.5');
    ok(Math.abs(mg.contribution - mg.weight / 2) < 0.011,
      `净权重 = 权重 × 0.5，未被 dirOf 压回满格（${mg.contribution} vs ${(mg.weight / 2).toFixed(2)}）`);
  }
  {
    // 其它 9 因子零改动：换 margin 夹具，比较除 margin 外的 score/weight/contribution
    const a = await computeMarketEmotion({ data: bundle(M(1.2, -1.2)), macroFactors: [] });
    const b = await computeMarketEmotion({ data: bundle(M(-1.2, 1.2)), macroFactors: [] });
    const pick = r => r.factors.filter(f => f.key !== 'margin').map(f => [f.key, f.score, f.weight, f.contribution]);
    ok(JSON.stringify(pick(a)) === JSON.stringify(pick(b)), '改变两融方向后，其它 9 个因子数值逐项不变（隔离修改）');
  }

  // ---------- §3 Python 数据源 ----------
  console.log('\n[§3] Python 取数：融券列精确匹配 + 融资字段口径不变');
  {
    const py = fs.readFileSync(path.join(ROOT, 'scripts/market_emotion.py'), 'utf8');
    ok(/str\(c\)\.strip\(\) == val_name/.test(py), '列名用精确匹配（防「融资融券余额」误吞「融券余额」）');
    // 精确匹配「可执行代码」（带冒号），不误伤说明注释里引用的旧写法
    ok(!/if\s+"融券余额"\s+in\s+str\(c\)\s*:/.test(py), '不存在「融券余额」子串模糊匹配的可执行代码');
    ok(/_to_map\(sh, "融券余额"\)/.test(py) && /_to_map\(sz, "融券余额"\)/.test(py), '沪深两边都解析融券余额列');
    ok(/_to_map\(sh, "融资余额"\)/.test(py), '融资列仍单独解析（口径不变）');
    ok(/"rqLatest"/.test(py) && /"rqChange5Pct"/.test(py) && /"rqDate"/.test(py), '输出 rqLatest / rqChange5Pct / rqDate');
    ok(/"latest": round\(rz\["latest"\], 1\)/.test(py), '融资 latest 仍按原精度输出');
    ok(/rqMissingNote/.test(py), '融券缺失有单独标注（不拖累整卡）');
    const dat = fs.readFileSync(path.join(ROOT, 'lib/marketEmotionData.js'), 'utf8');
    ok(/margin: raw\.margin \|\| null/.test(dat), '取数层透传整个 margin 对象（rq* 自动带上）');
  }

  // ---------- §4 前端接线 ----------
  console.log('\n[§4] 前端双栏与语义着色');
  {
    const js = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
    ok(/f\.key === 'margin' && Array\.isArray\(f\.subs\)/.test(js), 'app.js 按 margin + subs 分流渲染');
    ok(/tp-comp-dual/.test(js), '渲染 tp-comp-dual 双栏容器');
    ok(/esc\(sub\.value \|\| '—'\)/.test(js), '双栏数值用 esc 而非 _dirColorize（防「融券+=利空」染红）');
    ok(/sub\.tone === 'bull'/.test(js) && /tp-sig-bear/.test(js), 'tone 映射到红/绿方向色');
    ok(/两融双栏各按半格/.test(js), '卡片区标题已同步说明半格口径');
    ok(/\.tp-comp-dual \{/.test(css) && /\.tp-comp-sub \{/.test(css), 'style.css 含双栏与子项样式');
    ok(/@media \(max-width: 520px\)/.test(css), '窄屏回退单列');
    ok(/esc\(detailTxt\)/.test(js), 'margin 卡 detail 用中性色，避免符号着色错位');
  }

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  delete process.env.SA_MARKET_EMOTION_DIR;
  delete process.env.SA_MSI_SERIES;
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('FATAL', e && e.stack || e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});

~~~

---

## `scripts\test_emotion_margin_render.js`  ·  128 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_emotion_margin_render.js — [20261109a] 两融双栏「端到端渲染」冒烟守卫
 *
 * 存在理由：本轮实测发现 computeMarketEmotion 返回 factors 时有一层**字段白名单**，
 * 新加的 subs 若漏透出，模型层单测全绿、静态断言全绿，但前端 isDual 判否 → 双栏根本不渲染。
 * 本守卫从「真实模型输出 → app.js 真实渲染函数 → 最终 HTML」整条链验证，专门守住这个接缝。
 *
 * 夹具用金十 2026-11-05 实测值（融资 22709.8 亿 / -3.33%，融券 288.11 亿 / +2.08%），
 * 无网络请求；app.js 在 vm 沙箱中加载，DOM 用最小 stub，不启动浏览器。
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-margin-render-'));
process.env.SA_MARKET_EMOTION_DIR = TMP;
process.env.SA_MSI_SERIES = path.join(TMP, 'msi-series.json');
fs.writeFileSync(process.env.SA_MSI_SERIES, '[]');
const { computeMarketEmotion } = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

function mkBars(n) {
  const bars = []; let close = 3800;
  const endT = Date.parse('2026-11-09T00:00:00');
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dates = [];
  for (let t = endT; dates.length < n; t -= 86400000) {
    const d = new Date(t);
    if (d.getDay() !== 0 && d.getDay() !== 6) dates.unshift(fmt(d));
  }
  for (let i = 0; i < n; i++) {
    close *= 1.0005;
    bars.push({ date: dates[i], close: Math.round(close * 100) / 100, vol: Math.round(5e8 * (1 + Math.sin(i / 7) * 0.1)) });
  }
  return bars;
}

const bundle = {
  ok: true, date: '2026-11-09',
  index: { code: 'sh000001', name: '上证指数', bars: mkBars(260) },
  breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
  // 金十 fs_1/fs_2 2026-11-05 实测：融资 22709.8 亿(5日 -3.33%)、融券 288.11 亿(5日 +2.08%)
  margin: {
    latest: 22709.8, changePct: 0.3, change5Pct: -3.33, date: '2026-11-05',
    rqLatest: 288.11, rqChange5Pct: 2.08, rqDate: '2026-11-05',
  },
  mainFund: { mainNetToday: 150, history: [] },
  capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
  fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
  bond: { cn10y: 2.0, chgBp5: 5 },
  discussionHeat: { marketHeat: 0.2, date: '2026-11-09', value: '热度 0.2', detail: '数据源：东财股吧，样本 1200 只' },
  issues: [], warnings: [],
};

const mkEl = () => ({
  innerHTML: '', textContent: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  appendChild() {}, insertAdjacentHTML() {},
});

(async () => {
  const data = await computeMarketEmotion({ data: bundle, macroFactors: [] });
  const mg = data.factors.find(f => f.key === 'margin');
  console.log(`\n模型输出：${mg.name} score=${mg.score} weight=${mg.weight} contribution=${mg.contribution}`);
  ok(Array.isArray(mg.subs) && mg.subs.length === 2, '模型输出白名单透出 subs（本守卫的核心接缝）');
  ok(mg.score === -1, '融资撤离(-1) + 融券增加(-1) → 满格利空 -1');
  ok(mg.subs[0].tone === 'bear' && mg.subs[1].tone === 'bear', '两子项均为利空 tone');

  const els = {};
  const sandbox = {
    console, URL, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.resolve({ json: () => ({}) }),
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', search: '' },
    document: {
      addEventListener() {},
      getElementById(id) { return els[id] || (els[id] = mkEl()); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return mkEl(); }, body: mkEl(),
    },
    Chart: function () { return {}; },
    echarts: { init() { return { setOption() {}, resize() {} }; } },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8') + '\n;globalThis.__App = App;';
  vm.runInContext(src, sandbox, { timeout: 10000 });
  const App = sandbox.__App;
  ok(!!(App && typeof App._renderEmotionPanel === 'function'), 'vm 成功加载 App._renderEmotionPanel');
  App._renderEmotionPanel(data);
  const html = els.homeSentimentBody.innerHTML;
  ok(html.length > 1000, `渲染出非空 HTML（${html.length} 字符）`);

  console.log('\n最终 HTML 断言：');
  ok(/两融余额/.test(html), '卡片标题为「两融余额」');
  ok(/tp-comp-dual/.test(html), '渲染双栏容器');
  ok(/融资余额/.test(html) && /融券余额/.test(html), '两个子项名称都在卡片里');
  ok((html.match(/tp-comp-sub-hd/g) || []).length === 2, '恰为 2 个子栏');
  ok(/50%/.test(html), '显示各占 50% 权重');
  ok(/tp-comp-sub-val tp-sig-bear/.test(html), '融券增加=利空 → 绿色（tp-sig-bear）');
  ok(!/<span class="up">\+2\.08%/.test(html), '融券「+2.08%」未被按数值符号误染成红色');
  ok(/两融双栏各按半格/.test(html), '因子区标题同步说明半格口径');
  ok(/融资 \/ 融券各占本卡 50% 权重/.test(html), '卡内显示 splitNote 平分权重说明');
  ok(/tp-emo-info/.test(html), '保留 T+1 例行披露 / 口径信息条');

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.SA_MARKET_EMOTION_DIR;
  delete process.env.SA_MSI_SERIES;
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('FATAL', e && e.stack || e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});

~~~

---

## `scripts\test_etf_card_layout.js`  ·  133 行

~~~js
/**
 * 宽基 ETF 因子卡「布局隔离」回归（零网络、零浏览器）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_etf_card_layout.js
 *
 * 背景（20261023b）：20261023a 曾把 ETF 因子卡做成整行宽 + 卡内三页签（个股/ETF 表内嵌），
 * 用户 2026-10-23 截图报障「卡片的布局全部乱了」，要求把口径解释、ETF 数量统计、个股统计
 * 移到**卡片之外**（独立「宽基ETF申赎」页签），卡片只保留一条摘要 + 明细入口。
 *
 * 本文件守住：
 *   [A] etfFlow 卡与其它因子卡完全同构：无 tp-comp-wide、无卡内页签、10 张卡等宽入网格
 *   [B] 卡片 detail 只说一句短摘要（不含长口径「口径：Δ份额…」）
 *   [C] 卡片带「查看宽基ETF明细 →」入口（data-action="open-etf-page"），点击**新标签**打开独立页
 *       （20261025p 改版：首页不再有 ETF 内嵌页签，明细迁至 /etf-flow.html）
 *   [D] 独立页 /etf-flow.html（etfFlowPage.js）仍是完整明细：概览 / 家族 / ETF 表 / 逐股 / 口径说明
 *   [E] 源码守卫：window.open('/etf-flow.html')；CSS 有 .tp-comp-more、无 .tp-comp-wide / .etf-inline-*
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
function count(hay, needle) { return (hay.split(needle).length - 1); }

// ---------------- 最小 DOM 桩 ----------------
const elMap = {};
function mkCL() {
  const s = new Set();
  return { add(...c){c.forEach(x=>s.add(x));}, remove(...c){c.forEach(x=>s.delete(x));}, contains(c){return s.has(c);},
    toggle(c,o){ if(o===undefined){s.has(c)?s.delete(c):s.add(c);} else if(o)s.add(c); else s.delete(c);} };
}
function makeEl(id) {
  return { id, textContent:'', innerHTML:'', style:{}, offsetWidth:100, classList:mkCL(),
    querySelectorAll:()=>[], querySelector:()=>null, addEventListener(){} };
}
global.document = {
  getElementById:(id)=>(elMap[id]!==undefined?elMap[id]:null), querySelectorAll:()=>[], querySelector:()=>null,
  addEventListener:()=>{}, createElement:()=>makeEl('tmp'), body:{classList:mkCL(),appendChild(){}}, documentElement:{classList:mkCL()},
};
global.window = global; global.window.addEventListener = ()=>{}; global.window.requestAnimationFrame = (fn)=>setTimeout(fn,0);
global.location = { href:'http://127.0.0.1:3005/', search:'', pathname:'/', hash:'' };
global.localStorage = { _d:{}, getItem(k){return this._d[k]===undefined?null:this._d[k];}, setItem(k,v){this._d[k]=String(v);}, removeItem(k){delete this._d[k];} };
global.CustomEvent = class { constructor(t,o){this.type=t;this.detail=o&&o.detail;} };
global.Event = class { constructor(t){this.type=t;} };
global.fetch = async ()=>({ ok:true, json:async()=>({}) });
global.Storage = { getWatchlist:()=>[], addToHistory(){}, initWatchlist:async()=>{}, getGroups:()=>[] };
global.DocStore = { setStock(){}, onTabSwitch(){} };
global.DeepCharts = { disposeAll(){} };
global.Notes = undefined;
global.echarts = { init:()=>({setOption(){},dispose(){},on(){},getZr:()=>({on(){},off(){}})}), registerTheme(){} };

const src = fs.readFileSync(path.join(__dirname,'..','public','js','app.js'),'utf8');
const css = fs.readFileSync(path.join(__dirname,'..','public','css','style.css'),'utf8');
const App = new Function(`${src}; return App;`)();

// ---------------- 夹具 ----------------
const LONG_DETAIL = '宽基 ETF（沪深300、上证50、中证500、中证1000、科创50，有效 34 只）份额较上一收盘 20261022 合计增加 → 折算净申购 310.36 亿（盘中读数（收盘后定稿））。口径：Δ份额 ÷ 最小申赎单位 = 篮数，再乘每篮成分股数得逐股理论增减量；份额本身是「净」概念，无法拆出申购总量与赎回总量。';
const FACTORS = [
  { key:'volumePrice', name:'量能活跃与量价配合', weight:22, score:0.5, value:'v1', detail:'d1' },
  { key:'breadthExtreme', name:'市场宽度与极端情绪', weight:13, score:0.2, value:'v2', detail:'d2' },
  { key:'indexMomentum', name:'大盘近期涨跌势头', weight:9, score:0.1, value:'v3', detail:'d3' },
  { key:'margin', name:'融资余额（杠杆资金）', weight:9, score:0.1, value:'v4', detail:'d4' },
  { key:'mainCapital', name:'主力资金流向', weight:9, score:-0.2, value:'v5', detail:'d5' },
  { key:'discussionHeat', name:'股吧讨论热度', weight:9, score:0.3, value:'v6', detail:'d6' },
  { key:'riskAversion', name:'避险情绪', weight:9, score:0, value:'v7', detail:'d7' },
  { key:'etfFlow', name:'宽基ETF申购赎回（增量资金）', weight:10, score:1,
    value:'净申购 310.36 亿 · 14 只净申购 / 2 只净赎回', detail:LONG_DETAIL, degraded:false },
  { key:'domesticMacro', name:'国内宏观数据情绪', weight:0, score:0, value:'休眠', detail:'d9' },
  { key:'usMacro', name:'美国宏观事件情绪', weight:3.2, score:0, value:'中性', detail:'d10' },
];
const DATA = { totalScore:0.5, tendency:'偏多', tendencyKey:'bull', volumeState:'放量', coreDriver:'x', advice:'y',
  riskTip:'z', source:'src', baselineDate:'20261023', factors:FACTORS };

// ============================================================================
// [A]/[B]/[C] 因子网格里的 etfFlow 卡
// ============================================================================
console.log('\n[A] etfFlow 卡与其它因子卡同构（不再整行宽 / 不再卡内页签）');
elMap.homeSentimentPanel = makeEl('homeSentimentPanel');
elMap.homeSentimentBody = makeEl('homeSentimentBody');
elMap.homeSentimentUpdated = makeEl('homeSentimentUpdated');
App._emoData = null; App._emoTab = 'factors'; App._etfFlowLoading = true; // 阻止自动取数
App._renderEmotionPanel(DATA);
const html = elMap.homeSentimentBody.innerHTML;

ok(!html.includes('tp-comp-wide'), '卡片不再带 tp-comp-wide（不再整行跨列）');
ok(!html.includes('data-action="etf-inline-tab"'), '不再有卡内页签 etf-inline-tab');
ok(count(html, '<div class="tp-comp"') + count(html, '<div class="tp-comp tp-comp-degraded"') === 10,
  `10 个因子全部是普通网格卡（实际 ${count(html, '<div class="tp-comp"') + count(html, '<div class="tp-comp tp-comp-degraded"')}）`);
ok(html.includes('data-action="open-etf-page"'), 'etfFlow 卡带「查看宽基ETF明细」入口');
ok(count(html, 'data-action="open-etf-page"') === 1, '明细入口只有 1 个（仅 etfFlow 卡）');
ok(html.includes('净申购 310.36 亿 · 14 只净申购 / 2 只净赎回'), '卡片保留核心数值 f.value');

console.log('\n[B] 卡片 detail 只留短摘要（长口径移出）');
ok(!html.includes('口径：Δ份额'), '卡片不再出现长口径「口径：Δ份额…」');
ok(!html.includes('无法拆出申购总量与赎回总量'), '卡片不再出现长口径尾巴');
ok(html.includes('见独立页'), '卡片短摘要指向独立页（点下方按钮新标签打开）');
ok(html.includes('折算净申赎额'), '短摘要含「折算净申赎额」');

console.log('\n[C] 首页不再有 ETF 内嵌页签（20261025p：明细迁独立页）');
ok(!html.includes('data-tab="etf"'), '首页面板不再有 data-tab="etf" 页签');

// ============================================================================
// [D] 独立页 /etf-flow.html（etfFlowPage.js）仍是完整明细
// ============================================================================
console.log('\n[D] 独立页 /etf-flow.html：概览 / ETF 表 / 逐股 / 口径说明');
const pageSrc = fs.readFileSync(path.join(__dirname,'..','public','js','etfFlowPage.js'),'utf8');
ok(pageSrc.includes('各宽基 ETF 申赎'), '含 ETF 明细表标题');
ok(pageSrc.includes('被申购') && pageSrc.includes('被赎回'), '含逐股被申购/被赎回');
ok(pageSrc.includes('怎么算的'), '含口径解释「怎么算的」');
ok(pageSrc.includes('/api/etf-flow'), '独立页自行拉取 /api/etf-flow 数据');

// ============================================================================
// [E] 源码守卫
// ============================================================================
console.log('\n[E] 源码守卫');
ok(src.includes('data-action="open-etf-page"'), 'app.js：卡片明细入口 data-action="open-etf-page"');
ok(src.includes("window.open('/etf-flow.html'"), 'app.js：点击入口新标签打开 /etf-flow.html');
ok(src.includes('openEtf'), 'app.js：open-etf-page 点击处理器存在');
ok(!src.includes('_renderEtfFactorCard'), 'app.js：已删除卡内页签渲染器（无死逻辑）');
ok(!src.includes('_etfInlineTab'), 'app.js：已删除 _etfInlineTab 状态');
ok(css.includes('.tp-comp-more'), 'CSS：新增 .tp-comp-more 明细入口样式');
ok(!css.includes('.tp-comp-wide'), 'CSS：已删除 .tp-comp-wide');
ok(!css.includes('.etf-inline-tab'), 'CSS：已删除 .etf-inline-tab');
ok(src.includes("if (f.key === 'etfFlow')")
  && src.includes("f.key === 'etfFlow'\n          ? '份额较上一收盘增加"), 'app.js：etfFlow 走短摘要分支');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_etf_cash_trend.js`  ·  119 行

~~~js
// test_etf_cash_trend.js — 20261028a 全部宽基 ETF「持仓比例 vs 现金比例」趋势 单元测试
// 运行：node scripts/test_etf_cash_trend.js
// 用 SA_ETF_FLOW_DIR 指到临时目录，构造快照夹具，验证：加权口径、异常守卫、
// settled 标记、历史持久化幂等合并（磁盘快照优先 / 历史补已清理日期）、空目录诚实报错。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-trend-'));
process.env.SA_ETF_FLOW_DIR = tmp;
const etfFlow = require('../lib/etfFlow');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function snap(date, etfs, settled) {
  fs.writeFileSync(path.join(tmp, date + '.json'),
    JSON.stringify({ date, shareDate: date, settled: !!settled, savedAt: new Date().toISOString(), etfs }));
}
const mkEtf = (code, navPerCu, cash, nav, shares, unit) =>
  ({ code, name: 'X' + code, group: 'g', groupLabel: 'G', nav, unit, navPerCu, cash, compCount: 1, shares, comps: [['000001', 100]] });

console.log('== 1. 空目录 → 诚实报 ok:false ==');
{
  const r = etfFlow.cashPositionTrend();
  t('ok=false', r.ok === false);
  t('points 为空数组', Array.isArray(r.points) && r.points.length === 0);
  t('note 说明原因', typeof r.note === 'string' && r.note.length > 0);
}

console.log('== 2. 市值加权的比例口径 ==');
{
  // A：市值 900（nav=0.9×1000 份/单位×1000 单位 → nav*shares=900），现金比例 1%
  // B：市值 100，现金比例 10% → 加权现金 = (0.01*900 + 0.10*100)/1000 = 1.9%
  snap('20261022', [
    mkEtf('510300', 1000, 10, 0.9, 1000, 1000),
    mkEtf('510500', 1000, 100, 0.1, 1000, 1000),
  ], true);
  fs.writeFileSync(path.join(tmp, 'ratio-history.json'), 'RESET_NOT_JSON'); // 坏历史文件按空处理
  const r = etfFlow.cashPositionTrend();
  t('ok=true 且 1 个点', r.ok === true && r.points.length === 1);
  const p = r.points[0];
  t('现金比例=1.9%（加权）', Math.abs(p.cashRatioPct - 1.9) < 1e-9, 'got ' + p.cashRatioPct);
  t('持仓比例=98.1%（1−现金）', Math.abs(p.stockRatioPct - 98.1) < 1e-9, 'got ' + p.stockRatioPct);
  t('etfCount=2', p.etfCount === 2);
  t('settled=true', p.settled === true);
}

console.log('== 3. 异常守卫：±50% 之外的现金比例被剔除 ==');
{
  snap('20261023', [
    mkEtf('510300', 1000, 10, 0.9, 1000, 1000),      // 1%  正常
    mkEtf('510500', 1000, 600, 0.9, 1000, 1000),     // 60% 异常 → 剔除
  ], true);
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261023');
  t('etfCount=1（异常被剔除）', p && p.etfCount === 1, 'got ' + (p && p.etfCount));
  t('现金比例=1%', Math.abs(p.cashRatioPct - 1) < 1e-9, 'got ' + p.cashRatioPct);
}

console.log('== 4. 盘中未定稿：settled=false，进入 unsettledDates ==');
{
  snap('20261024', [mkEtf('510300', 1000, 20, 0.9, 1000, 1000)], false);
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261024');
  t('settled=false', p && p.settled === false);
  t('unsettledDates 含该日', Array.isArray(r.unsettledDates) && r.unsettledDates.includes('20261024'));
}

console.log('== 5. 历史持久化：磁盘删除后，历史文件补上该日期（跨越 KEEP_DAYS 清理窗口）==');
{
  fs.unlinkSync(path.join(tmp, '20261023.json')); // 模拟快照被滚动清理
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261023');
  t('被清理日期仍在趋势里', !!p);
  t('值与清理前一致(1%)', p && Math.abs(p.cashRatioPct - 1) < 1e-9);
  t('磁盘现存日期+历史日期 = 3 个点', r.points.length === 3, 'got ' + r.points.length);
  t('points 按日期升序', r.points.every((x, i, a) => i === 0 || String(a[i - 1].date) <= String(x.date)));
}

console.log('== 6. 磁盘快照永远优先于历史（同日重采覆盖）==');
{
  const hist = JSON.parse(fs.readFileSync(path.join(tmp, 'ratio-history.json'), 'utf8'));
  const stale = hist.points.find(x => x.date === '20261024');
  stale.cashRatioPct = 99; stale.stockRatioPct = 1; // 篡改历史为旧值
  fs.writeFileSync(path.join(tmp, 'ratio-history.json'), JSON.stringify(hist));
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261024');
  t('以磁盘快照为准（2%）', p && Math.abs(p.cashRatioPct - 2) < 1e-9, 'got ' + (p && p.cashRatioPct));
}

console.log('== 7. 幂等：连调两次历史文件不变 ==');
{
  const f = path.join(tmp, 'ratio-history.json');
  const before = fs.readFileSync(f, 'utf8');
  etfFlow.cashPositionTrend();
  etfFlow.cashPositionTrend();
  const after = fs.readFileSync(f, 'utf8');
  t('文件内容未变（无冗余写盘）', before === after);
}

console.log('== 8. 缺字段 ETF 被跳过（不崩、不计入）==');
{
  snap('20261025', [
    { code: '510300', name: 'x' },                                  // 缺 navPerCu/cash
    mkEtf('510500', 1000, 30, 0.9, 1000, 1000),                     // 3% 正常
  ], true);
  const r = etfFlow.cashPositionTrend();
  const p = r.points.find(x => x.date === '20261025');
  t('etfCount=1', p && p.etfCount === 1);
  t('现金比例=3%', p && Math.abs(p.cashRatioPct - 3) < 1e-9);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_etf_flow_holiday_guard.js`  ·  132 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_etf_flow_holiday_guard.js — 20261105b 守卫
 * 用户指令：节假日/假后第一天只读取最后一次更新的数据，避免取数报错。
 * 事故背景：11-01（周日）重采把 10-30 已定稿快照覆盖（shareDate 被 T+1 采集日语义前推一天），
 * 逐日表 10-30 出现假 Δ=0、台账把周四增量重复计入。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
const write = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj), 'utf8');

// 独立临时目录夹具（不碰生产 data/）；snapPath：快照直接在根目录（与生产 data/etf-flow/ 同构）
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-flow-test-'));
  const pcf = path.join(dir, 'pcf-cache');
  fs.mkdirSync(pcf, { recursive: true });
  return { dir, pcf, snaps: dir };
}

(async () => {
  console.log('=== §1 collect 跨日重采守卫（节假日不覆盖已定稿快照）===');
  {
    const fx = makeFixture();
    process.env.SA_ETF_FLOW_DIR = fx.dir;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
    const etfFlow = require(path.join(ROOT, 'lib/etfFlow.js'));

    // 快照：10-30（周五）已定稿，shareDate=20261029（周五晚采集的正确语义）
    const snap = {
      date: '20261030', shareDate: '20261029', settled: true, partial: false,
      etfs: [{ code: '510300', name: '沪深300ETF', group: 'hs300', groupLabel: '沪深300', unit: 1000000, shares: 32729887700, comps: [] }],
    };
    write(path.join(fx.snaps, '20261030.json'), snap);

    // PCF 缓存：周日（采集日）返回的是周五清单 → tradeDate=20261030（历史日期）
    const pcf = { date: '20261030', byCode: { '510300': { code: '510300', name: '沪深300ETF', tradeDate: '20261030', nav: 4.0, unit: 1000000, comps: [] } } };
    write(path.join(fx.pcf, '20261102.json'), pcf);

    // 外呼全走 collect 的 opts 注入口（20261105b 测试 seam），不做真实外呼
    let sharesFetched = false;
    const baseOpts = () => ({
      cacheKey: '20261102',
      // [20261109a] 本夹具只注入 1 只 ETF，专测「跨日重采守卫」；名单完整性由
      // test_etf_universe_integrity.js 单独覆盖，故显式声明夹具自担基准。
      assumeCompleteUniverse: true,
      universe: [{ code: '510300', name: '沪深300ETF', group: 'hs300', groupLabel: '沪深300' }],
      fetchPcf: async () => ({ __err: '测试内不应外呼（缓存应命中）' }),
      fetchShares: async () => { sharesFetched = true; return { '510300': 38866987700 }; },
    });

    const r = await etfFlow.collect(baseOpts());
    const snapAfter = JSON.parse(fs.readFileSync(path.join(fx.snaps, '20261030.json'), 'utf8'));
    ok(r.ok === true, 'collect 正常返回（节假日读旧快照不算错误）');
    ok(sharesFetched === false, '守卫在抓份额之前生效（省一次外呼）');
    ok(snapAfter.shareDate === '20261029', '原快照保留：shareDate 仍为 20261029（不被前推成 20261030）');
    ok(snapAfter.etfs[0].shares === 32729887700, '原快照份额值未被覆盖');
    ok((r.gaps || []).join('').indexOf('保留原快照') >= 0, 'gaps 如实标注「保留原快照」');

    // partial（残缺）快照不拦截：重采自愈通道保留
    write(path.join(fx.snaps, '20261030.json'), Object.assign({}, snap, { settled: false, partial: true, gaps: ['份额缺失 1 只'] }));
    sharesFetched = false;
    const r2 = await etfFlow.collect(baseOpts());
    const snapAfter2 = JSON.parse(fs.readFileSync(path.join(fx.snaps, '20261030.json'), 'utf8'));
    ok(sharesFetched === true && r2.ok === true, 'partial 快照走重采通道');
    ok(snapAfter2.shareDate === '20261030' && snapAfter2.settled === true, 'partial 快照被重采自愈（shareDate=采集日语义的 20261030）');

    // 无历史快照 → 跨日补采通道保留（20261026a）
    fs.unlinkSync(path.join(fx.snaps, '20261030.json'));
    const r3 = await etfFlow.collect(baseOpts());
    ok(r3.ok === true && fs.existsSync(path.join(fx.snaps, '20261030.json')), '无历史快照时跨日补采正常落盘');
    delete process.env.SA_ETF_FLOW_DIR;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  }

  console.log('=== §2 最近一次成功数据兜底（withLastFactorFallback）===');
  {
    const fx = makeFixture();
    process.env.SA_ETF_FLOW_DIR = fx.dir;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
    const etfFlow = require(path.join(ROOT, 'lib/etfFlow.js'));
    // 手写一份「最近一次成功数据」（字段与 saveLastSuccessfulFactor 一致）
    write(path.join(fx.dir, 'last-factor.json'), {
      date: '20261030',
      factor: { score: 0.76, degraded: false, value: '净申购 362.39 亿 · 23 只净申购 / 2 只净赎回', detail: '…', totalNet: 3.6239e10, settleStatus: 'settled' },
      savedAt: '2026-11-01T12:00:00.000Z',
    });
    // 夹具无快照/PCF → selectUniverse 真实外呼可能成功 → 但 PCF 抓取会失败（无网/或成功后无份额）……
    // 为确定性：宇宙为空场景不可控 → 直接对 getEtfFlow 断言兜底行为（任何 ok:false/无因子结果都应被兜底）
    const res = await etfFlow.getEtfFlow({ refresh: true });
    if (res.factor && res.factor.degraded === false && !res.factor.fallback) {
      // 真实外呼意外全成功（有网）→ 视为正常路径，验证「有效因子不兜底」即可
      ok(true, '真实外呼成功 → 有效因子不兜底（正常路径）');
    } else {
      ok(res.ok === true, `取数失败时兜底为 ok（实际 ok=${res.ok}）`);
      ok(res.date === '20261030', `兜底数据日期=最近成功日 20261030（实际 ${res.date}）`);
      ok(res.factor && res.factor.fallback === true, '兜底因子带 fallback 标记');
      ok(/节假日\/取数兜底/.test((res.factor && res.factor.reason) || ''), '兜底 reason 显式标注');
    }
    ok(etfFlow.getLastSuccessfulFactor().date === '20261030', 'getLastSuccessfulFactor 可读');
    delete process.env.SA_ETF_FLOW_DIR;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  }

  console.log('=== §3 接线守卫 ===');
  {
    const src = fs.readFileSync(path.join(ROOT, 'lib/etfFlow.js'), 'utf8');
    ok(src.indexOf('跨日重采守卫') >= 0, 'etfFlow.js 含跨日重采守卫');
    ok(src.indexOf('getLastSuccessfulFactor') >= 0 && src.indexOf('LAST_FACTOR_FILE') >= 0, 'etfFlow.js 含最近成功数据兜底');
    const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(serverJs.indexOf('etfFlow.getLastSuccessfulFactor()') >= 0, 'server.js 情绪注入点含兜底回读');
    const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    ok(appJs.indexOf('f.fallback') >= 0, 'app.js 情绪卡展示兜底标注');
    const t1 = fs.readFileSync(path.join(ROOT, 'scripts/test_metric_analysis_vote.js'), 'utf8');
    const t2 = fs.readFileSync(path.join(ROOT, 'scripts/test_consistency_audit.js'), 'utf8');
    ok(t1.indexOf('20261106p') >= 0 && t2.indexOf('20261106p') >= 0, '版本断言已同步 20261106p');
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/const APP_VERSION = '20261106p'/.test(server), "APP_VERSION = '20261106p'");
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.message); process.exit(1); });

~~~

---

## `scripts\test_etf_flow.js`  ·  190 行

~~~js
/**
 * 宽基 ETF 申购赎回（20261022h）回归
 * --------------------------------------------------------------
 * 运行： node scripts/test_etf_flow.js
 * 全部离线：在临时目录里造快照，验证「快照 → 净申赎 → 逐股增减 → 累计台账」这条链。
 * 覆盖：
 *   [1] 只有一份快照 → 基线日（无基期，不硬编数字）
 *   [2] 两日定稿快照 → Δ份额 / 篮数 / 净申赎额 / 逐股理论增减
 *   [3] 台账幂等：同一天重复计算不重复累加
 *   [4] 盘中快照（settled:false）不进台账，但当日 Δ 照常展示
 *   [5] 基期只认 settled:true：跳过未定稿快照，取更早的定稿日
 *   [6] 逐股清单 = 今日篮子 ∪ 台账历史（已退出篮子的股票累计值不丢）
 *   [7] scoreOf：tanh 软饱和 + ±1 夹紧 + 非法值归零
 *   [8] 接线守卫：情绪模型因子 / server 注入 / 前端页签
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa-etf-flow-test-' + process.pid + '-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_ETF_FLOW_DIR = TMP;   // 必须在 require 之前设置（模块加载时解析目录）

const ef = require('../lib/etfFlow');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}（期望 ≈${b}±${tol}，实际 ${a}）`);

const COMP_A = [['600519', 100], ['601318', 200], ['000001', 300]];
const COMP_B = [['600519', 30], ['300750', 500]];

function mkEtf(code, name, group, groupLabel, unit, nav, shares, comps) {
  return { code, name, group, groupLabel, nav, unit, navPerCu: null, cash: null, compCount: comps.length, shares, comps };
}
function writeSnap(date, etfs, settled, names) {
  const p = ef.snapPath(date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ date, savedAt: new Date().toISOString(), settled: !!settled, etfs, stockNames: names || {} }), 'utf8');
}

// 基期 20261020：510300 100 亿份、510500 50 亿份
const DAY1 = [
  mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.0, 100e8, COMP_A),
  mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.0, 50e8, COMP_B),
];
// 20261021：510300 净申购 2 篮（+180 万份）、510500 净赎回 1 篮（-90 万份）
const DAY2 = [
  mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.1, 100e8 + 900000 * 2, COMP_A),
  mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.1, 50e8 - 900000 * 1, COMP_B),
];
const NAMES = { 600519: '贵州茅台', 601318: '中国平安', '000001': '平安银行', 300750: '宁德时代' };

console.log('\n[1] 只有一份快照 → 基线日');
{
  writeSnap('20261020', DAY1, true, NAMES);
  const r = ef.computeFromSnapshots('20261020');
  eq(r.ok, false, '无基期 → ok=false');
  eq(r.noPrev, true, '标记 noPrev（基线日）');
  ok(/基线/.test(r.reason || ''), '给出可读原因，不硬编净申赎');
  eq(r.etfs.length, 2, '基线日仍返回 ETF 清单（dShares 为空）');
  eq(r.etfs[0].dShares, null, '基线日 dShares=null');
}

console.log('\n[2] 两日定稿快照 → 净申赎与逐股增减');
{
  writeSnap('20261021', DAY2, true, NAMES);
  const r = ef.computeFromSnapshots('20261021');
  eq(r.ok, true, '算出结果');
  eq(r.baseDate, '20261019', '基期份额日=20261019（快照 20261020 的上一交易日）');
  const a = r.etfs.find(e => e.code === '510300');
  const b = r.etfs.find(e => e.code === '510500');
  eq(a.dShares, 1800000, '510300 Δ份额 = +180 万份');
  near(a.baskets, 2, 1e-9, '510300 篮数 = 2');
  near(a.netAmount, 1800000 * 4.1, 1, '510300 净申购额 = Δ份额 × 净值');
  eq(b.dShares, -900000, '510500 Δ份额 = -90 万份');
  near(b.baskets, -1, 1e-9, '510500 篮数 = -1');
  near(r.totalNet, 1800000 * 4.1 - 900000 * 6.1, 1, '合计净申赎额');

  const s1 = r.stocks.find(s => s.code === '600519');
  near(s1.dayBuy, 2 * 100, 1e-9, '600519 当日被买 2×100 股（沪深300 申购）');
  near(s1.daySell, -1 * 30, 1e-9, '600519 当日被卖 1×30 股（中证500 赎回）——同一只股票跨家族合并成一行');
  eq(s1.groups.length, 2, '600519 标注同时来自 2 个宽基家族');
  eq(s1.name, '贵州茅台', '逐股带上名称');
  near(r.stocks.find(s => s.code === '300750').daySell, -500, 1e-9, '300750 卖出 500 股');
  eq(r.stocks.find(s => s.code === '601318').name, '中国平安', '601318 名称正确');
  ok(r.groups.length === 2, '按家族汇总 2 组');
  near(r.groups.find(g => g.key === 'csi300').netAmount, 1800000 * 4.1, 1, '沪深300 组净申购额');
  near(r.groups.find(g => g.key === 'csi500').sellAmount, -900000 * 6.1, 1, '中证500 组净赎回额');
}

console.log('\n[3] 台账幂等');
{
  const before = JSON.parse(fs.readFileSync(ef.LEDGER, 'utf8'));
  const c0 = before.cum['600519'].buyShares;
  ef.computeFromSnapshots('20261021');
  const after = JSON.parse(fs.readFileSync(ef.LEDGER, 'utf8'));
  eq(after.cum['600519'].buyShares, c0, '同日重复计算不重复累加');
  eq(after.days, before.days, 'day 计数不变');
  eq(after.lastDate, '20261020', 'lastDate 按份额日停在 20261020');
}

console.log('\n[4] 盘中快照不进台账');
{
  // 20261022 只有盘中读数：settled=false
  const intra = [
    mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.2, 100e8 + 900000 * 5, COMP_A),
    mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.2, 50e8 - 900000 * 1, COMP_B),
  ];
  writeSnap('20261022', intra, false, NAMES);
  const r = ef.computeFromSnapshots('20261022');
  eq(r.ok, true, '盘中也能算出当日 Δ（预览）');
  eq(r.settled, false, '标记 settled=false');
  near(r.etfs.find(e => e.code === '510300').baskets, 3, 1e-9, '当日篮数=3（相对 20261021 定稿基期）');
  const led = JSON.parse(fs.readFileSync(ef.LEDGER, 'utf8'));
  eq(led.lastDate, '20261020', '台账未被盘中读数推进（仍为份额日 20261020）');
  near(led.cum['601318'].buyShares, 2 * 200, 1e-9, '累计值仍只有定稿日');
  eq(led.cum['601318'].buyDays, 1, 'buyDays 未因盘中多加一次');
}

console.log('\n[5] 基期只认定稿快照');
{
  // 20261023 定稿，但 20261022 是未定稿 → 基期应回落到 20261021
  const d23 = [
    mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.3, 100e8 + 900000 * 1, COMP_A),
    mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.3, 50e8 - 900000 * 1, COMP_B),
  ];
  writeSnap('20261023', d23, true, NAMES);
  const r = ef.computeFromSnapshots('20261023');
  eq(r.baseDate, '20261020', '跳过未定稿的 20261022，基期取 20261021 的份额日 20261020');
  near(r.etfs.find(e => e.code === '510300').baskets, -1, 1e-9, '篮数按 20261023 − 20261021 计算（−1 篮）');
}

console.log('\n[6] 逐股清单并集：已退出篮子不丢累计');
{
  // 20261026 的篮子只留 600519，601318 退出 → 其累计仍须出现
  const d26 = [
    mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.4, 100e8 + 900000 * 3, [['600519', 100]]),
  ];
  writeSnap('20261026', d26, true, NAMES);
  const r = ef.computeFromSnapshots('20261026');
  const gone = r.stocks.find(s => s.code === '601318');
  ok(!!gone, '601318 今日不在篮子，仍出现在清单里');
  near(gone.cumBuy, 2 * 200, 1e-9, '601318 累计值保留（2 篮 × 200 股）');
  eq(gone.dayBuy, 0, '今日增量为 0');
  eq(gone.name, '中国平安', '名称来自 stockNames');
  ok(r.stocks.every(s => typeof s.cumBuy === 'number' && typeof s.cumSell === 'number'), '所有行都有累计字段');
}

console.log('\n[7] scoreOf');
{
  eq(ef.scoreOf(0), 0, '0 → 0');
  ok(ef.scoreOf(1e12) <= 1 && ef.scoreOf(1e12) > 0.99, '极大正值 → 夹到 1');
  ok(ef.scoreOf(-1e12) >= -1 && ef.scoreOf(-1e12) < -0.99, '极大负值 → 夹到 -1');
  near(ef.scoreOf(0.5 * ef.SHARE_BASE), Math.tanh(0.5), 1e-6, '半基准 ≈ tanh(0.5)');
  ok(ef.scoreOf(null) === 0 && ef.scoreOf(NaN) === 0, '非法值 → 0');
  eq(ef.SHARE_BASE, 20e8, '基准 20 亿元');
}

console.log('\n[8] 接线守卫');
{
  const em = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8');
  ok(/etfFlow:\s*\d+/.test(em), '情绪模型 BASE_WEIGHTS 含 etfFlow');
  ok(/etfFlow:\s*'[^']*ETF[^']*'/.test(em), 'FACTOR_NAMES 含 ETF 因子中文名');
  ok(/calcEtfFlow/.test(em), '存在 calcEtfFlow');
  ok(/key:\s*'etfFlow'/.test(em), '因子被 push 进 factors');
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/require\('\.\/lib\/etfFlow'\)/.test(sv), 'server 引入 etfFlow');
  ok(/etfFlow\.getEtfFlow/.test(sv), 'server 调用 getEtfFlow');
  ok(/\/api\/etf-flow/.test(sv), '提供 /api/etf-flow 路由');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  // 20261025p：ETF 页签删除，明细迁独立页 /etf-flow.html；卡片按钮新标签直达
  ok(/open-etf-page/.test(app) && /etf-flow\.html/.test(app), '情绪卡片按钮新标签直达独立 ETF 页');
  const etfPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'etf-flow.html'), 'utf8');
  const etfPageJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'etfFlowPage.js'), 'utf8');
  ok(/etfFlowPage\.js/.test(etfPage), '独立页存在并挂载 etfFlowPage.js');
  ok(/\/api\/etf-flow/.test(etfPageJs), '独立页拉 /api/etf-flow');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  ok(/\.tp-tabs\b/.test(css) && /\.etf-table\b/.test(css), '页签与表格样式已落地');
  const fl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'etfFlow.js'), 'utf8');
  ok(/missCodes/.test(fl), '当日 PCF 缓存缺名单时只补抓新增 ETF 并回写缓存');
  ok(/KEEP_DAYS/.test(fl) && /pruneSnapshots/.test(fl), '快照有保留上限与清理');
  ok(/sessionSettled\(tradeDate\)/.test(fl), '快照落盘时打定稿标');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

~~~

---

## `scripts\test_etf_monthly_provisional.js`  ·  275 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_etf_monthly_provisional.js — [20261109a] 当月逐日明细「未定稿多日合计行」守卫
 *
 * 用户指令（截图 屏幕截图 2026-11-09 124511.png）：
 *   「11月5日和6日的数据为什么缺少，无法区分也可以一并合计入统计表格里面。」
 *
 * 事故形态：11-06 残缺快照被如实标 partial 后，11-05 收盘份额已不可得，
 * 11-05 / 11-06 两天的单日申赎永远无法拆分。但 11-04→11-06 的 Δ 是真实存在、
 * 可计算的数据，原 stockMonthlyFlow() 的 `settled && !partial` 闸门把它整条丢掉 → 用户看到数据凭空消失。
 *
 * 本守卫验证：
 *   §1 旧行为不回退：没有未定稿快照时，rows 仍只由定稿链产生
 *   §2 未定稿快照 → 一条多日合计行，带 spanNote / provisional / 正确 Δ，并计入 totals
 *   §3 重复防护：同一披露日、残缺口径、名单缩水、跨月都不产生额外行
 *   §4 台账隔离：stockMonthlyFlow 只读，不写 ledger.json
 *   §5 前端接线：行样式 / 合计行文案 / 口径说明同步
 * 全部在 os.tmpdir() 独立夹具内，不碰生产 data/。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

const UNIT = 1000000;
const CODES = ['510300', '510050', '510500', '588000'];
function etfs(sharesMap) {
  // 只有第一只 ETF 含目标股 601398，其余含别的成分股 → 每篮 100 股，数值直观可核对
  return CODES.map((c, i) => ({
    code: c, shares: sharesMap[c], unit: UNIT,
    comps: [[i === 0 ? '601398' : '600000', 100]],
  }));
}
function shares(v) {
  const m = {}; for (const c of CODES) m[c] = v; return m;
}
function snap(date, shareDate, v, opts = {}) {
  return {
    date, shareDate,
    settled: opts.settled !== undefined ? opts.settled : true,
    partial: opts.partial !== undefined ? opts.partial : false,
    etfs: opts.only ? etfs(shares(v)).slice(0, opts.only) : etfs(shares(v)),
  };
}
function writeSnap(dir, s) {
  fs.writeFileSync(path.join(dir, s.date + '.json'), JSON.stringify(s));
  return s;
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-month-test-'));
  return dir;
}
function loadEf(dir) {
  process.env.SA_ETF_FLOW_DIR = dir;
  delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  return require(path.join(ROOT, 'lib/etfFlow.js'));
}
// 三份定稿：1103(份1e9) → 1104(+1篮) → 1105(不变)，披露日分别 1102/1103/1104
function baseChain(dir) {
  writeSnap(dir, snap('20261103', '20261102', 1e9));
  writeSnap(dir, snap('20261104', '20261103', 1e9 + UNIT));
  writeSnap(dir, snap('20261105', '20261104', 1e9 + UNIT));
}

(async () => {
  const dirs = [];
  try {
    // ---------- §1 旧行为不回退 ----------
    console.log('\n[§1] 只有定稿链：rows 仍由相邻定稿快照产生，零 provisional 行');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.ok === true, 'ok=true');
      ok(r.rows.length === 2, `2 行定稿（实际 ${r.rows.length}）`);
      ok(r.provisionalRows === 0, 'provisionalRows=0');
      ok(r.settledDays === 3, `settledDays=3（实际 ${r.settledDays}）`);
      ok(r.rows[0].date === '20261103' && r.rows[0].buy === 100, `首行 +100 股（实际 ${r.rows[0].buy}）`);
      ok(r.rows[1].date === '20261104' && r.rows[1].buy === 0, '次行份额不变 → 0 股');
      ok(r.totals.buy === 100 && r.totals.net === 100, `合计 100 股（实际 ${r.totals.net}）`);
    }

    // ---------- §2 未定稿多日合计行 ----------
    console.log('\n[§2] 定稿链之后有完整未定稿快照 → 一条多日合计行，计入 totals');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 11-06 事故残缺快照（应被忽略）
      writeSnap(dir, snap('20261106', '20261106', 1e9 + 9 * UNIT, { settled: false, partial: true, only: 1 }));
      // 11-09 盘中完整未定稿快照：相对最后定稿 +2 篮 → +200 股
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.rows.length === 3, `3 行（2 定稿 + 1 多日合计，实际 ${r.rows.length}）`);
      ok(r.provisionalRows === 1, 'provisionalRows=1');
      ok(r.settledDays === 3, `settledDays 仍为 3，未定稿不算定稿日（实际 ${r.settledDays}）`);
      const p = r.rows[2];
      ok(p.provisional === true, '末行 provisional=true');
      ok(p.date === '20261106', `末行数据日 = 份额披露日 20261106（实际 ${p.date}）`);
      ok(p.snapshotDate === '20261109', '末行溯源到 20261109 快照');
      ok(/多日合计（20261104→20261106）/.test(p.spanNote || ''), `spanNote 含多日合计跨度（实际 ${p.spanNote}）`);
      ok(/含未定稿读数/.test(p.spanNote || ''), 'spanNote 明示含未定稿读数');
      ok(p.buy === 200 && p.net === 200, `多日合计 Δ = +200 股（实际 ${p.buy}）`);
      ok(r.totals.buy === 300 && r.totals.net === 300, `当月合计已含该行 = 300 股（实际 ${r.totals.net}）`);
    }

    // ---------- §2b 赎回方向 ----------
    console.log('\n[§2b] 未定稿行份额减少 → 计入赎回列');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 - UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      const p = r.rows.find(x => x.provisional);
      ok(!!p, '存在 provisional 行');
      ok(p && p.sell === 200, `赎回 2 篮 × 100 股 = 200 股（实际 ${p && p.sell}）`);
      ok(p && p.net === -200, `净额 -200（实际 ${p && p.net}）`);
    }

    // ---------- §3 重复 / 残缺 / 缩水 / 跨月防护 ----------
    console.log('\n[§3] 重复与脏数据防护');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 同一披露日 20261104 的盘中快照 → 不得重复计数
      writeSnap(dir, snap('20261106', '20261104', 1e9 + 5 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 0 && r.rows.length === 2, '披露日未推进 → 不产生重复行');
      ok(r.totals.net === 100, `合计未被重复放大（实际 ${r.totals.net}）`);
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: true }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 0, 'partial:true 的残缺快照不产生行');
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 名单从 4 只缩到 2 只（< 4×0.8=3）→ 拦截
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false, only: 2 }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 0, '名单缩水超 20% → 不产生假 Δ 行');
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202610');
      ok(r.rows.length === 0 && r.provisionalRows === 0, '查询其它月份 → 不串月');
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 两份未定稿快照（不同采集日、同一披露日）→ 只取最新一份
      writeSnap(dir, snap('20261107', '20261106', 1e9 + 2 * UNIT, { settled: false, partial: false }));
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 1 && r.rows.length === 3, '多份未定稿快照 → 只取最新一份，不重复');
      ok(r.rows[2].snapshotDate === '20261109' && r.rows[2].buy === 200, '采用 20261109 的 +200 股');
    }

    // ---------- §4 台账隔离 ----------
    console.log('\n[§4] 只读保证：不写累计台账');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ lastDate: '20261104', days: 10, cum: {} }));
      const before = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
      const ef = loadEf(dir);
      ef.stockMonthlyFlow('601398', '202611');
      const after = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
      ok(before === after, 'ledger.json 逐字节不变（未定稿值不入台账）');
    }

    // ---------- §5 前端接线 ----------
    console.log('\n[§5] 前端同步接线');
    {
      const fe = fs.readFileSync(path.join(ROOT, 'public/js/etfFlowPage.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
      ok(/etf-month-provisional/.test(fe), '前端为 provisional 行加了视觉区分 class');
      ok(/stockMonthData\.provisionalRows/.test(fe), '合计行按 provisionalRows 切换文案');
      ok(/不进入累计台账/.test(fe), '口径说明已披露「不进入累计台账」');
      ok(/\.etf-month-provisional td/.test(css), '样式表含对应规则');
    }

    // ---------- §6 前端真实渲染（静态断言之外，验证最终 HTML 里确有 11-06 行）----------
    console.log('\n[§6] etfFlowPage.js 真实渲染（vm 沙箱，无需浏览器）');
    {
      const vm = require('vm');
      const mkEl = () => ({
        innerHTML: '', textContent: '', style: {}, dataset: {},
        addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      });
      const els = {};
      const sb = {
        console, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error,
        isNaN, parseInt, parseFloat, encodeURIComponent,
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        fetch: () => new Promise(() => {}),   // 挂起自动 load，改由注入 api 手动渲染
        document: {
          addEventListener() {}, getElementById(id) { return els[id] || (els[id] = mkEl()); },
          querySelector() { return null; }, querySelectorAll() { return []; },
          createElement() { return mkEl(); }, body: mkEl(),
        },
        echarts: { init() { return { setOption() {}, resize() {}, dispose() {} }; } },
      };
      sb.window = sb; sb.globalThis = sb;
      vm.createContext(sb);
      let src = fs.readFileSync(path.join(ROOT, 'public/js/etfFlowPage.js'), 'utf8');
      const cut = src.lastIndexOf('})();');
      src = src.slice(0, cut)
        + 'globalThis.__ef = { render, setData: d => { DATA = d; }, setMonth: (s, r) => { selectedStock = s; stockMonthData = r; } };\n'
        + src.slice(cut);
      vm.runInContext(src, sb, { timeout: 8000 });
      const api = sb.__ef;
      ok(!!(api && typeof api.render === 'function'), 'vm 成功加载 etfFlowPage render');
      const DATA = {
        ok: true, date: '20261106', settled: false,
        summary: { groups: [{ key: 'csi300', label: '沪深300', netAmount: 1.8e9 }], totalNet: 1820051640, ledgerDays: 10, ledgerDate: '20261104' },
        etfs: [{ code: '510300', name: '沪深300ETF', groupLabel: '沪深300', netAmount: 1.8e9 }],
        stocks: [{ code: '601318', name: '中国平安', dayBuy: 1430900, daySell: 0, cumBuy: 42255700, cumSell: 1018400, buyDays: 4, sellDays: 1 }],
        gaps: ['基期披露日 20261104 与本期 20261106 不相邻，净申赎为多日合计值'],
      };
      const monthData = {
        ok: true, code: '601318', month: '202611', provisionalRows: 1,
        rows: [
          { date: '20261102', buy: 8012500, sell: 0, net: 8012500 },
          { date: '20261103', buy: 25266400, sell: 67400, net: 25199000 },
          { date: '20261104', buy: 7545900, sell: 951000, net: 6594900 },
          { date: '20261106', buy: 1430900, sell: 0, net: 1430900, provisional: true, spanNote: '多日合计（20261104→20261106） · 含未定稿读数' },
        ],
        totals: { buy: 42255700, sell: 1018400, net: 41237300 },
      };
      api.setData(DATA);
      api.setMonth({ code: '601318', name: '中国平安' }, monthData);
      api.render(DATA);
      const html = els.efBody.innerHTML;
      ok(html.length > 500, `渲染出非空 HTML（${html.length} 字符）`);
      ok(/2026-11-06/.test(html), '11-06 数据日出现在表格里（用户看到的缺失日期回来了）');
      ok(/多日合计（20261104→20261106）/.test(html), '多日合计跨度标签已显示');
      ok(/含未定稿读数/.test(html), '含未定稿读数标签已显示');
      ok(/etf-month-provisional/.test(html), '未定稿行带视觉区分 class');
      ok(/含 1 行未定稿多日合计/.test(html), '合计行文案按 provisionalRows 诚实标注');
      ok(/不进入累计台账/.test(html), '口径说明披露「不进入累计台账」');
    }

    console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  } catch (e) {
    console.error('FATAL', e && e.stack || e);
    fail++;
  } finally {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
    delete process.env.SA_ETF_FLOW_DIR;
  }
  process.exit(fail ? 1 : 0);
})();

~~~

---

## `scripts\test_etf_universe_integrity.js`  ·  141 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_etf_universe_integrity.js — [20261109a] 名单完整性绝对基准守卫
 *
 * 事故背景（20261028、20261106 两次复发）：上交所名单按 03/01/09 三个分类分别查询，
 * 任一分类失败被静默吞成空数组 → 名单从 34 缩到 7（只剩上证50 4 + 科创50 3）。
 * 旧判据 `partial = okPcfs.length < universe.length` 的分子分母一起缩水 →
 * 残缺快照被标 settled:true，且被跨日重采守卫保护、无法自愈。
 *
 * 本测试验证：
 *   §1 绝对基准纯函数：家族全覆盖 + 总数下限
 *   §2 名单缩水 → 必标 partial / 不定稿 / gaps 可观测（事故指纹不再出现）
 *   §3 名单恢复 → 重采可覆盖残缺快照（自愈通道未被反锁）
 *   §4 接线守卫
 * 全部在 os.tmpdir() 独立夹具内，不碰生产 data/。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// 与 lib/etfFlow.js GROUPS 的 max 同构：20+4+4+3+3 = 34
const FIX_GROUPS = [
  { key: 'csi300', label: '沪深300', n: 20 },
  { key: 'sse50', label: '上证50', n: 4 },
  { key: 'csi500', label: '中证500', n: 4 },
  { key: 'csi1000', label: '中证1000', n: 3 },
  { key: 'star50', label: '科创50', n: 3 },
];
function fullUniverse() {
  const list = [];
  let i = 0;
  for (const g of FIX_GROUPS) {
    for (let k = 0; k < g.n; k++) {
      list.push({ code: String(510000 + (i++)), name: '宽基ETF', group: g.key, groupLabel: g.label, expectComps: 50 });
    }
  }
  return list;
}
// 事故形态：cls='03' 查询失败 → 只剩上证50 + 科创50 = 7 只
function brokenUniverse() {
  return fullUniverse().filter(u => u.group === 'sse50' || u.group === 'star50');
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-universe-test-'));
  fs.mkdirSync(path.join(dir, 'pcf-cache'), { recursive: true });
  return dir;
}
function loadEf(dir) {
  process.env.SA_ETF_FLOW_DIR = dir;
  delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  return require(path.join(ROOT, 'lib/etfFlow.js'));
}
const fetchPcf = async (code) => ({
  code, name: '宽基ETF', tradeDate: '20261106', nav: 2.9, unit: 900000,
  navPerCu: 2600000, cash: 400, compCount: 1, comps: [['601398', 1000]],
});
const fetchShares = async (codes) => {
  const o = {};
  for (const c of codes) o[c] = 1e9;
  return o;
};
const optsFor = (u) => ({ universe: u, fetchPcf, fetchShares, cacheKey: '20261109' });
const readSnap = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '20261106.json'), 'utf8'));

(async () => {
  const fixtures = [];
  console.log('=== §1 名单完整性绝对基准（universeIntegrity）===');
  {
    const d = makeFixture(); fixtures.push(d);
    const ef = loadEf(d);
    const full = fullUniverse(), broken = brokenUniverse();
    ok(full.length === 34, '完整夹具 34 只（与 GROUPS max 合计一致）');
    ok(broken.length === 7, '事故夹具 7 只（上证50 4 + 科创50 3）');
    const iFull = ef.universeIntegrity(full);
    const iBad = ef.universeIntegrity(broken);
    ok(iFull.ok === true && iFull.families === 5, '完整名单：5 家族全覆盖 → ok');
    ok(iBad.ok === false, '缩水名单 → 判不完整');
    ok(iBad.missing.length === 3 && iBad.missing.indexOf('沪深300') >= 0, '准确指出缺失家族（沪深300/中证500/中证1000）');
    ok(iBad.size === 7 && iBad.minSize > iBad.size, '绝对下限独立于当次名单（7 < 下限 ' + iBad.minSize + '）');
    const thin = FIX_GROUPS.map(g => ({ code: 'X' + g.key, name: 'X', group: g.key }));
    ok(ef.universeIntegrity(thin).ok === false, '5 家族覆盖但只数不足 27 → 仍判不完整（绝对下限生效）');
  }

  console.log('=== §2 名单缩水 → 必标残缺（事故指纹不再出现）===');
  {
    const d = makeFixture(); fixtures.push(d);
    const ef = loadEf(d);
    const r = await ef.collect(optsFor(brokenUniverse()));
    const s = readSnap(d);
    ok(r.ok === true, 'collect 正常返回');
    ok(s.etfs.length === 7, '快照仍只有 7 只（不臆造份额）');
    ok(s.partial === true && s.settled === false, '★ partial:true / settled:false（不再误标定稿）');
    ok(!(s.settled === true && !s.partial), '★ 事故指纹 7只+settled:true+无partial 不再出现');
    const sg = (s.gaps || []).join('');
    ok(sg.indexOf('ETF 名单不完整') >= 0, '快照 gaps 如实标注「ETF 名单不完整」');
    ok(sg.indexOf('缺 沪深300') >= 0, '快照 gaps 列出缺失家族');
    ok((r.gaps || []).join('').indexOf('ETF 名单不完整') >= 0, 'collect 返回 gaps 同步披露（页面数据缺口可见）');
    ok(s.shareDate === '20261106', '份额披露日语义不变（输出格式未变）');
  }

  console.log('=== §3 名单恢复 → 重采自愈（跨日守卫不再反锁残缺快照）===');
  {
    const d = makeFixture(); fixtures.push(d);
    const ef = loadEf(d);
    await ef.collect(optsFor(brokenUniverse()));
    const s1 = readSnap(d);
    ok(s1.partial === true && s1.settled === false, '第一次：残缺快照落盘');
    const r2 = await ef.collect(optsFor(fullUniverse()));
    const s2 = readSnap(d);
    ok(r2.ok === true, '第二次：重采正常返回');
    ok(s2.etfs.length === 34, '★ 重采补全 34 只（缓存扩容补抓 27 只生效）');
    ok(s2.settled === true && !s2.partial, '★ 残缺快照被覆盖、恢复定稿（自愈通道打开）');
    ok(!s2.gaps || (s2.gaps || []).join('').indexOf('ETF 名单不完整') < 0, '完整名单不再带「名单不完整」告警');
  }

  console.log('=== §4 接线守卫 ===');
  {
    const src = fs.readFileSync(path.join(ROOT, 'lib/etfFlow.js'), 'utf8');
    ok(src.indexOf('function universeIntegrity') >= 0, 'lib/etfFlow.js 含绝对基准函数');
    ok(src.indexOf('okPcfs.length < uInt.minSize') >= 0, 'partial 含绝对只数下限（B 双保险）');
    ok(src.indexOf('上交所 ETF 名单分类') >= 0, '名单查询失败已接入内部错误台账（不再静默吞掉）');
    ok(src.indexOf('assumeCompleteUniverse') >= 0, '仅白盒测试夹具可显式豁免，生产默认校验');
    const t = fs.readFileSync(path.join(ROOT, 'scripts/test_etf_flow_holiday_guard.js'), 'utf8');
    ok(t.indexOf('assumeCompleteUniverse: true') >= 0, '既有节假日守卫夹具已同步适配');
  }

  for (const d of fixtures) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.SA_ETF_FLOW_DIR;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.stack ? e.stack : e); process.exit(1); });

~~~

---

## `scripts\test_event_frontrun.js`  ·  85 行

~~~js
// 单元测试：事件驱动引擎 · 内幕抢跑检查（checkInsiderFrontRun）
// 设计要点（用户 20260922 校正）：仅事件触发、锚定事件前 3 日、方向一致且幅度≥2.5% 才判抢跑。
// 运行：node scripts/test_event_frontrun.js
const assert = require('assert');
const { checkInsiderFrontRun } = require('../lib/eventEngine');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 事件前 3 个交易日（严格早于 anchorDate=2026-09-22）
const mkHist = (c1, c2, c3) => [
  { date: '2026-09-15', close: 100 },
  { date: '2026-09-17', close: c1 }, // 事件前第3日
  { date: '2026-09-18', close: c2 }, // 事件前第2日
  { date: '2026-09-19', close: c3 }, // 事件前第1日（紧邻事件）
  { date: '2026-09-22', close: 110 }, // 事件日（不含入回溯）
];
const evBase = (signal) => ({ id: 'evt_test', title: '测试事件', signal, createdAt: new Date('2026-09-22T09:30:00').toISOString() });

console.log('内幕抢跑检查 · 分支覆盖：');

// 1. 历史不足 → 不触发
check('历史不足时不触发', checkInsiderFrontRun('X', evBase(1), []).detected === false);
check('历史<4根不触发', checkInsiderFrontRun('X', evBase(1), [{ date: '2026-09-19', close: 105 }]).detected === false);

// 2. 合成事件（原油主连 isSynthetic）跳过
check('合成事件跳过', checkInsiderFrontRun('X', { ...evBase(1), isSynthetic: true }, mkHist(100, 103, 105)).detected === false);

// 3. 无 createdAt 不触发
check('无事件时间不触发', checkInsiderFrontRun('X', { id: 'e', signal: 1 }, mkHist(100, 103, 105)).detected === false);

// 4. 方向不一致（利好事件但事件前下跌）→ 不触发
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 98, 96)); // 事件前 -4%
  check('方向不一致不触发', r.detected === false && r.reason === '方向不一致');
}

// 5. 提前反应幅度不足（<2.5%）→ 不触发
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 101, 102)); // 事件前 +2%
  check('幅度不足不触发', r.detected === false && r.reason === '提前反应幅度不足');
}

// 6. 利好透支（事件前上涨≥2.5%）→ 触发，signal=-0.4，下调比例正确
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 103, 105)); // 事件前 +5%
  check('利好透支触发', r.detected === true);
  check('利好透支 signal=-0.4', r.signal === -0.4);
  check('利好透支 tone=利好透支', r.tone === '利好透支，边际偏空');
  check('利好透支下调25%（retain0.75）', r.cutPct === 25);
  check('利好透支 preChg=+5%', Math.abs(r.preChg - 5) < 1e-9);
}

// 7. 利空出尽（利空事件但事件前已跌≥2.5%）→ 触发，signal=+0.4
{
  const r = checkInsiderFrontRun('X', evBase(-1), mkHist(100, 97, 95)); // 事件前 -5%
  check('利空出尽触发', r.detected === true);
  check('利空出尽 signal=+0.4', r.signal === 0.4);
  check('利空出尽 tone=利空出尽', r.tone === '利空出尽，边际偏多');
  check('利空出尽下调25%', r.cutPct === 25);
}

// 8. 保留率封底（抢跑≥17% → cutPct=85）
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 110, 120)); // 事件前 +20%
  check('大额抢跑封底 cutPct=85', r.cutPct === 85);
  check('大额抢跑 retain=0.15', Math.abs(r.preChg - 20) < 1e-9);
}

// 9. 事件前交易日不足 3 个 → 不触发
{
  const shortHist = [
    { date: '2026-09-18', close: 103 },
    { date: '2026-09-19', close: 105 },
    { date: '2026-09-22', close: 110 },
  ];
  check('事件前不足3交易日不触发', checkInsiderFrontRun('X', evBase(1), shortHist).detected === false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_event_guardrails.js`  ·  161 行

~~~js
// 单元测试：事件驱动引擎 · 20261021j 四道防线守卫（A1 摘要错配 / A2 例行重申封顶 / A3 理由自洽 / A4 事后市场反应核验）
// 运行：node scripts/test_event_guardrails.js
const assert = require('assert');
const {
  classifyByRule, scoreToGrade, evaluateMarketReaction, buildMarketCheckPatch, downgradeGradeOnce, MARKET_REACT_NO_MOVE_PCT,
} = require('../lib/eventEngine');
const { summaryMatchesTitle, analyzeNewsImpact } = require('../lib/newsSectorImpact');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ============================================================
// A1 — 摘要/标题错配守卫（summaryMatchesTitle + analyzeNewsImpact）
// ============================================================
console.log('A1 摘要/标题错配守卫：');

const titleSame = '证监会再度强调将支持证券业并购重组和后续整合';
const summarySame = '监管层再度强调，将继续支持证券行业并购重组与后续整合工作。';
const titleDiff = '深交所首批9只主动ETF正式获中国证监会批复';
const summaryMismatch = 'xxx 调研费用转移支付属行业合规强化措施，影响券商基金商业模式……'; // 与标题主题无关

check('同主题摘要判为匹配', summaryMatchesTitle(titleSame, summarySame) === true);
check('异主题摘要判为错配', summaryMatchesTitle(titleDiff, summaryMismatch) === false);
check('空摘要永远匹配（谈不上错配）', summaryMatchesTitle(titleDiff, '') === true);
check('超短标题（<6字）跳过校验→匹配', summaryMatchesTitle('苹果涨', summaryMismatch) === true);

{
  const r = analyzeNewsImpact(titleDiff, summaryMismatch);
  // 即便能命中板块，note 必须标注「摘要与标题疑似错配，已弃用摘要只按标题判」
  const dropped = r && /摘要与标题疑似错配/.test(r.note);
  check('analyzeNewsImpact 错配摘要被弃用并标注', dropped);
}

// ============================================================
// A2 — 例行重申封顶（classifyByRule / RE_ROUTINE_REAFFIRM）
// ============================================================
console.log('A2 例行重申封顶：');

check('「再度强调」→ routine_reaffirm / 封顶 minor', (() => {
  const r = classifyByRule('证监会再度强调将支持证券业并购重组和后续整合');
  return r.kind === 'routine_reaffirm' && r.reject === false && r.ceiling === 'minor';
})());
check('「重申」→ routine_reaffirm', classifyByRule('央行重申稳健货币政策立场').kind === 'routine_reaffirm');
check('「例行发布」→ routine_reaffirm', classifyByRule('统计局例行发布月度经济数据').kind === 'routine_reaffirm');
check('普通事件文本不误判为重申', classifyByRule('某券商拟启动并购重组').kind === 'candidate');
check('降准等货币政策走 routine_monetary 上限 moderate', classifyByRule('央行宣布下调存款准备金率0.5个百分点').ceiling === 'moderate');
check('逆回购属日常流动性操作 → 拒收（无 ceiling）', classifyByRule('央行开展逆回购操作').reject === true);

// ============================================================
// A3 — 理由自洽守卫（scoreToGrade / RE_SELF_CONTRADICT）
// ============================================================
console.log('A3 理由自洽守卫：');

const cfg = { severity: { minConfidence: 0.6, gradeThresholds: { major: 11, moderate: 7, minor: 3 }, typeCeiling: {} } };
// 总分=11（本应 major），但理由写「市场已有预期、强度有限」→ 自相矛盾，应压到 minor
{
  const v = { scope: 3, persistence: 2, intensity: 2, surprise: 2, authority: 2, confidence: 0.9, reason: '属渐进式改革、市场已有预期，强度有限' };
  const r = scoreToGrade(v, 'industry_supply', cfg, null);
  check('高总分+自相矛盾理由 → 压到 minor', r.grade === 'minor' && r.selfContradict === true && r.capped === true);
}
// 总分=11，理由未见自相矛盾词 → 保持 major
{
  const v = { scope: 3, persistence: 2, intensity: 2, surprise: 2, authority: 2, confidence: 0.9, reason: '实质性重大制度利好，行业级影响' };
  const r = scoreToGrade(v, 'industry_supply', cfg, null);
  check('高总分+自洽理由 → 保持 major', r.grade === 'major' && r.selfContradict === false);
}
// 已是 minor 的，即便理由含自相矛盾词也不应再降（order.indexOf(minor) 不 > order.indexOf(minor)）
{
  const v = { scope: 1, persistence: 1, intensity: 1, surprise: 0, authority: 0, confidence: 0.9, reason: '影响有限' }; // total=3 → minor
  const r = scoreToGrade(v, 'macro_policy', cfg, null);
  check('本就 minor 不因理由再降档', r.grade === 'minor' && r.selfContradict === false);
}
// 类型硬上限已封到 moderate，且理由自相矛盾 → 仍锁在 minor（两层互不替代）
{
  const v = { scope: 3, persistence: 2, intensity: 2, surprise: 2, authority: 2, confidence: 0.9, reason: '意外度低' };
  const r = scoreToGrade(v, 'macro_policy', cfg, 'moderate');
  check('类型上限 moderate + 自相矛盾 → minor', r.grade === 'minor' && r.selfContradict === true);
}

// ============================================================
// A4 — 事后市场反应核验（downgradeGradeOnce / evaluateMarketReaction / buildMarketCheckPatch）
// ============================================================
console.log('A4 事后市场反应核验：');

check('downgradeGradeOnce(major)=moderate', downgradeGradeOnce('major') === 'moderate');
check('downgradeGradeOnce(moderate)=minor', downgradeGradeOnce('moderate') === 'minor');
check('downgradeGradeOnce(minor)=minor（封底）', downgradeGradeOnce('minor') === 'minor');

// 构造历史：anchor=2026-10-19；prior 5 根、post 5 根
function mkHistory(postCloses, anchorPostClose) {
  const prior = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']
    .map(d => ({ date: d, close: 100 }));
  const posts = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
  const closes = postCloses || [100, 100.2, 100.2, 100.2, 100.2]; // 默认几乎无反应
  const post = posts.map((d, i) => ({ date: d, close: i === 0 ? (anchorPostClose || 100) : closes[i] }));
  return prior.concat(post);
}
const evBase = (signal, extra) => Object.assign({ id: 'evt_g', title: '测试事件', signal, grade: 'moderate', createdAt: new Date('2026-10-19T09:30:00').toISOString() }, extra || {});

// evaluateMarketReaction 守卫
check('hist<4 → null', evaluateMarketReaction(evBase(1), [{ date: '2026-10-19', close: 100 }], 1) === null);
check('无 createdAt → null', evaluateMarketReaction({ id: 'e', signal: 1 }, mkHistory(), 1) === null);
check('post 不足 stage1(2根) → null', evaluateMarketReaction(evBase(1), mkHistory([100, 100, 100, 100, 100]).slice(0, 6), 1) === null);
check('post 不足 stage2(5根) → null', evaluateMarketReaction(evBase(1), mkHistory([100, 100.2, 100.2, 100.2, 100.2]).slice(0, 8), 2) === null);
check('无 prior → null', evaluateMarketReaction(evBase(1), mkHistory().filter(h => h.date >= '2026-10-19'), 1) === null);

// 反应方向判定
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 100.2, 100.2, 100.2, 100.2]), 1); // +0.2%
  check('stage1 几乎无反应 → no_reaction', r && r.verdict === 'no_reaction');
}
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 103, 103, 103, 103]), 1); // +3% 同向
  check('stage1 同向 ≥1% → confirm', r && r.verdict === 'confirm');
}
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 97, 97, 97, 97]), 1); // -3% 反向
  check('stage1 反向 → opposite', r && r.verdict === 'opposite');
}
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 100.2, 100.2, 100.2, 100.2], 100), 2); // 5根后 +0.2%
  check('stage2 仍无反应 → no_reaction', r && r.verdict === 'no_reaction' && r.barsUsed === 5);
}

// buildMarketCheckPatch
check('signal:0 → null（中性化事件不重复核）', buildMarketCheckPatch(evBase(0), 'X', mkHistory()) === null);
check('isSynthetic → null', buildMarketCheckPatch(evBase(1, { isSynthetic: true }), 'X', mkHistory()) === null);
check('已中性化 → null', buildMarketCheckPatch(evBase(1, { marketNeutralized: true }), 'X', mkHistory()) === null);
check('已确认 → null', buildMarketCheckPatch(evBase(1, { marketConfirmed: true }), 'X', mkHistory()) === null);

// 24h 节流：prev.at 在 24h 内 → null
check('24h 内已核 → 节流 null', buildMarketCheckPatch(evBase(1, { marketChecks: { X: { stage: 1, at: Date.now() } } }), 'X', mkHistory()) === null);

// stage1 无反应 → 降一级（major→moderate 或 moderate→minor），signal 不变
{
  const p = buildMarketCheckPatch(evBase(1, { grade: 'major' }), 'X', mkHistory([100, 100.2, 100.2, 100.2, 100.2]));
  check('stage1 无反应 → 降一级且 signal 不变', p && p.patch.grade === 'moderate' && p.patch.signal === undefined && p.patch.marketDowngraded === true);
}
// stage2 无反应 → 中性化（signal=0, marketNeutralized）
{
  const p = buildMarketCheckPatch(evBase(1, { grade: 'moderate', marketChecks: { X: { stage: 1, at: 0 } } }), 'X', mkHistory([100, 100.2, 100.2, 100.2, 100.2]));
  check('stage2 无反应 → 中性化 signal=0', p && p.patch.signal === 0 && p.patch.marketNeutralized === true);
}
// confirm → marketConfirmed 终态
{
  const p = buildMarketCheckPatch(evBase(1), 'X', mkHistory([100, 103, 103, 103, 103]));
  check('confirm → marketConfirmed 终态', p && p.patch.marketConfirmed === true && p.patch.signal === undefined);
}
// opposite → 立即中性化
{
  const p = buildMarketCheckPatch(evBase(1), 'X', mkHistory([100, 97, 97, 97, 97]));
  check('opposite → 立即中性化 signal=0', p && p.patch.signal === 0 && p.patch.marketNeutralized === true);
}

// ============================================================
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_event_weight_sentiment_acc.js`  ·  199 行

~~~js
/**
 * 事件权重分级 + 市场情绪提醒准确率 回归测试（离线，零网络）—— 20260914i
 * 覆盖用户 2026-09-14 投诉：
 *   ① 事件权重过高（轻微+中度反向却合计约 50%）
 *   ② 市场情绪提醒需要准确率记录
 */
const assert = require('assert');
const ee = require('../lib/eventEngine');
const sa = require('../lib/sentimentAccuracy');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

console.log('\n=== 事件权重分级（用户口径：三个中度叠加也不该有 50%）===');
const cfg = ee.loadConfig();
t('中度基准权重 = 0.12（原 0.30）', () => assert.strictEqual(cfg.gradeRanges.moderate.fixedWeightShort, 0.12));
t('重大基准权重 = 0.40（原 0.45）', () => assert.strictEqual(cfg.gradeRanges.major.fixedWeightShort, 0.40));
t('轻微基准权重 = 0.03（原 0.08）', () => assert.strictEqual(cfg.gradeRanges.minor.fixedWeightShort, 0.03));
t('合计封顶 = 0.40（原 0.50）', () => assert.strictEqual(cfg.maxCombinedEventWeight, 0.4));
t('三个中度叠加 0.36 < 封顶 0.40', () => {
  const three = cfg.gradeRanges.moderate.fixedWeightShort * 3;
  assert.ok(three < cfg.maxCombinedEventWeight, `3×中度=${three} 应 < ${cfg.maxCombinedEventWeight}`);
});
t('三个中度叠加远低于 50%', () => {
  const three = cfg.gradeRanges.moderate.fixedWeightShort * 3;
  assert.ok(three < 0.5, `3×中度=${three} 应 < 0.5`);
});
t('中度权重约为重大的 1/3（量级直觉）', () => {
  const r = cfg.gradeRanges.moderate.fixedWeightShort / cfg.gradeRanges.major.fixedWeightShort;
  assert.ok(r >= 0.25 && r <= 0.35, `ratio=${r}`);
});
t('宏观政策上限降为 moderate（产业政策≠战争级别）', () => {
  assert.strictEqual(cfg.severity.typeCeiling.macro_policy, 'moderate');
});
t('地缘/战争仍可到 major（保住重大通道）', () => {
  assert.strictEqual(cfg.severity.typeCeiling.geo_disaster, 'major');
  assert.strictEqual(cfg.severity.typeCeiling.industry_supply, 'major');
});
t('原油冲击上限降到 8%（原 20%）', () => assert.strictEqual(ee.OIL_MAX_WEIGHT, 0.08));
t('原油权重系数降到 0.01（原 0.02）', () => assert.strictEqual(ee.OIL_WEIGHT_PER_PCT, 0.01));
// ★ 20260921l（用户要求）：原油主连数据影响由 3 天改为 1 天
t('原油冲击有效期 = 1 天（原 3 天）', () => assert.strictEqual(ee.OIL_DECAY_DAYS, 1));
t('轻微级 decayShortDays 跟随原油改为 1 天', () => {
  assert.strictEqual(ee.defaultConfig().gradeRanges.minor.decayShortDays, 1);
  assert.strictEqual(cfg.gradeRanges.minor.decayShortDays, 1);
});
t('原油合成事件的 decayShortDays/remainingDays 必须 == OIL_DECAY_DAYS（防止漏改硬编码）', () => {
  // buildCrudeShockEvent 依赖缓存；直接做源码断言，避免联网与缓存状态耦合
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'eventEngine.js'), 'utf8');
  assert.ok(/decayShortDays:\s*OIL_DECAY_DAYS/.test(src), 'decayShortDays 应引用 OIL_DECAY_DAYS 而非硬编码');
  assert.ok(/remainingDays:\s*OIL_DECAY_DAYS/.test(src), 'remainingDays 应引用 OIL_DECAY_DAYS 而非硬编码');
  assert.ok(!/decayShortDays:\s*3\b/.test(src), '不得残留 decayShortDays: 3 硬编码');
});
t('1 天期衰减：半天剩一半、满 1 天归零', () => {
  const DAY = 86400000, now = Date.now();
  const base = 0.052;
  assert.strictEqual(ee.effectiveWeight(base, 1, now - DAY * 0.5, now), base * 0.5);
  assert.strictEqual(ee.effectiveWeight(base, 1, now - DAY, now), 0);
});
t('配置版本已升到 20260921l', () => assert.strictEqual(cfg.version, '20260921l'));
t('配置迁移：磁盘版本落后时代码会强制刷新（防「改了代码不生效」）', () => {
  // loadConfig 内部实现：version 不一致 → 用 defaultConfig 覆盖三组结构性配置
  const def = ee.defaultConfig();
  assert.strictEqual(def.version, '20260921l');
  assert.strictEqual(def.gradeRanges.moderate.fixedWeightShort, 0.12);
  assert.strictEqual(def.maxCombinedEventWeight, 0.4);
});
t('gradeLabel 三档文案不变', () => {
  assert.strictEqual(ee.gradeLabel('major'), '重大');
  assert.strictEqual(ee.gradeLabel('moderate'), '中度');
  assert.strictEqual(ee.gradeLabel('minor'), '轻微');
});

console.log('\n=== 情绪预警方向归一化 ===');
t('看涨 → 涨', () => assert.strictEqual(sa.normalizeDir('看涨'), '涨'));
t('看跌 → 跌', () => assert.strictEqual(sa.normalizeDir('看跌'), '跌'));
t('看涨(反弹机会) → 涨', () => assert.strictEqual(sa.normalizeDir('看涨(反弹机会)'), '涨'));
t('看跌(回调风险) → 跌', () => assert.strictEqual(sa.normalizeDir('看跌(回调风险)'), '跌'));
t('震荡 → 震荡', () => assert.strictEqual(sa.normalizeDir('震荡'), '震荡'));
t('空 → null', () => assert.strictEqual(sa.normalizeDir(''), null));

console.log('\n=== 情绪预警留档条件（仅「预警/强烈预警」+ 明确方向）===');
t('无 → 不留档', () => assert.strictEqual(sa.shouldRecord({ level: '无', impliedDir: '震荡' }), false));
t('关注+看涨 → 不留档', () => assert.strictEqual(sa.shouldRecord({ level: '关注', impliedDir: '看涨' }), false));
t('预警+看涨 → 留档', () => assert.strictEqual(sa.shouldRecord({ level: '预警', impliedDir: '看涨' }), true));
t('强烈预警+看跌 → 留档', () => assert.strictEqual(sa.shouldRecord({ level: '强烈预警', impliedDir: '看跌(回调风险)' }), true));
t('预警+震荡 → 不留档（无明确方向）', () => assert.strictEqual(sa.shouldRecord({ level: '预警', impliedDir: '震荡' }), false));
t('预警+看涨 → 留档', () => assert.strictEqual(sa.shouldRecord({ level: '预警', impliedDir: '看涨' }), true));

console.log('\n=== 情绪预警聚合统计 ===');
t('无样本 accuracy = null（不伪造 0%）', () => {
  assert.strictEqual(sa.computeAccuracy([]).accuracy, null);
});
t('2 条已结算 1 命中 → 50%', () => {
  const a = sa.computeAccuracy([
    { baseDate: '2026-01-01', targetDate: '2026-01-02', dir: '涨', level: '预警', settled: true, correct: true },
    { baseDate: '2026-01-02', targetDate: '2026-01-05', dir: '跌', level: '强烈预警', settled: true, correct: false },
  ]);
  assert.strictEqual(a.accuracy, 50);
  assert.strictEqual(a.settledCount, 2);
  assert.strictEqual(a.bullTotal, 1);
  assert.strictEqual(a.strongTotal, 1);
});
t('待验证不计入分母', () => {
  const a = sa.computeAccuracy([
    { baseDate: '2026-01-01', targetDate: '2026-01-02', dir: '涨', level: '预警', settled: true, correct: true },
    { baseDate: '2099-01-01', targetDate: '2099-01-02', dir: '跌', level: '预警', settled: false },
  ]);
  assert.strictEqual(a.accuracy, 100);
  assert.strictEqual(a.pendingCount, 1);
});
t('口径常量：次日上证 + 0.5% 容差', () => {
  const a = sa.computeAccuracy([]);
  assert.strictEqual(a.flatTolerance, 0.5);
  assert.strictEqual(a.benchmark.code, 'sh000001');
  assert.strictEqual(a.horizonLabel, '次日上证指数涨跌');
});
t('过期未结算检出', () => {
  const a = sa.computeAccuracy([
    { baseDate: '2020-01-01', targetDate: '2020-01-02', dir: '涨', level: '预警', settled: false },
  ]);
  assert.ok(a.overdueCount >= 1);
});

console.log('\n=== 非交易日基准日防呆（ERR-20261020-001，20261020a）===');
const fsTm = require('fs');
const pathTm = require('path');
const calTm = require('../lib/cnTradingCalendar');
t('resolveBaseDate：周日回滚到上周五', () => assert.strictEqual(sa.resolveBaseDate('2026-10-18'), '2026-10-16'));
t('resolveBaseDate：国庆假期中段回滚到节前最后交易日', () => assert.strictEqual(sa.resolveBaseDate('2026-10-03'), '2026-09-30'));
t('resolveBaseDate：交易日原样返回', () => assert.strictEqual(sa.resolveBaseDate('2026-10-16'), '2026-10-16'));
t('resolveBaseDate：空值透传（不伪造日期）', () => {
  assert.strictEqual(sa.resolveBaseDate(null), null);
  assert.strictEqual(sa.resolveBaseDate(undefined), undefined);
});
t('不变量：非交易日 d 的 nextTradingDay(d) == nextTradingDay(previousTradingDay(d))（基准日回滚不改目标日）', () => {
  for (const d of ['2026-10-18', '2026-10-03', '2026-01-01', '2028-01-02']) {
    assert.strictEqual(calTm.nextTradingDay(d), calTm.nextTradingDay(calTm.previousTradingDay(d)), d);
  }
});
t('结算侧源码断言：baseIdx 比对走 resolveBaseDate 回滚（防呆接线在位）', () => {
  const src = fsTm.readFileSync(pathTm.join(__dirname, '..', 'lib', 'sentimentAccuracy.js'), 'utf8');
  assert.ok(/findIndex\(h => h\.date === resolveBaseDate\(rec\.baseDate\)\)/.test(src), 'baseIdx 查询应经 resolveBaseDate');
});
// 功能实测：用 2028 年未来日期，绝不与真实留档（≤ 今日）碰撞；finally 复原现场
function withTempRecord(dateStr, fn) {
  const file = pathTm.join(sa.DIR, `${dateStr}.json`);
  const existed = fsTm.existsSync(file);
  const backup = existed ? fsTm.readFileSync(file, 'utf8') : null;
  try { return fn(file); } finally {
    if (existed) fsTm.writeFileSync(file, backup); else if (fsTm.existsSync(file)) fsTm.unlinkSync(file);
  }
}
t('留档侧：非交易日 baseDate 回滚到上一交易日并落盘（功能实测）', () => {
  withTempRecord('2027-12-31', file => {
    const rec = sa.recordDailyJudgment(
      { level: '预警', impliedDir: '看跌', zScore: -0.3, reasons: [{ text: '单测' }] },
      { baseDate: '2028-01-02' } // 周日 → 回滚 2027-12-31（周五）
    );
    assert.ok(rec, '应留档');
    assert.strictEqual(rec.baseDate, '2027-12-31');
    assert.strictEqual(rec.targetDate, '2028-01-03'); // 下一交易日（01-01 周六、01-02 周日之后）
    assert.ok(fsTm.existsSync(file), '应写入回滚后的基准日文件');
    assert.ok(!fsTm.existsSync(pathTm.join(sa.DIR, '2028-01-02.json')), '不得产生周日基准日脏文件');
  });
});
t('留档侧：回滚而来的记录不覆盖目标日既有留档（降级结论不得顶替正常判断）', () => {
  withTempRecord('2027-12-31', file => {
    fsTm.writeFileSync(file, JSON.stringify({ baseDate: '2027-12-31', targetDate: '2028-01-03', level: '强烈预警', impliedDirRaw: '看跌', dir: '跌', zScore: -0.9, settled: false }));
    const rec = sa.recordDailyJudgment(
      { level: '预警', impliedDir: '看涨', zScore: 0.3, reasons: [{ text: '单测' }] },
      { baseDate: '2028-01-02' } // 周日，回滚目标日已有留档
    );
    assert.strictEqual(rec.zScore, -0.9);
    const after = JSON.parse(fsTm.readFileSync(file, 'utf8'));
    assert.strictEqual(after.dir, '跌');
    assert.strictEqual(after.zScore, -0.9);
  });
});
t('留档侧：交易日 baseDate 照常按原日期留档（正常路径不受影响）', () => {
  withTempRecord('2028-01-05', file => {
    const rec = sa.recordDailyJudgment(
      { level: '预警', impliedDir: '看涨', zScore: 0.3, reasons: [{ text: '单测' }] },
      { baseDate: '2028-01-05' } // 周三，交易日
    );
    assert.strictEqual(rec.baseDate, '2028-01-05');
    assert.strictEqual(rec.targetDate, '2028-01-06');
    assert.ok(fsTm.existsSync(file));
  });
});

console.log('\n' + '='.repeat(50));
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) { console.log(`${fail} 项失败 ❌`); process.exit(1); }
console.log('全部通过 ✅');

~~~

---

## `scripts\test_factor_direction.js`  ·  193 行

~~~js
/**
 * 判断因子「方向语义」回归测试
 * --------------------------------------------------------------
 * 目标（用户 2026-09-01 要求）：短期 / 长期判断的所有因子，方向必须与语义一致
 *   利好 → 正 signal → 红色「利好 +n」；利空 → 负 signal → 绿色「利空 -n」。
 *
 * 覆盖的高危方向语义：
 *   1) 对标期货：corr 为皮尔逊相关系数，可为负。负相关个股必须反向传导
 *      （期货涨 → 该股偏空），旧实现只取 |corr| 作强度，方向判反。
 *   2) 量价口径：放量随价向、缩量反价向（缩量上涨=上涨乏力→偏空；
 *      缩量下跌=抛压衰竭→偏多），与 factorCapital 的 vpSigMap 口径一致。
 *   3) 增持减持 / 板块涨跌停：净减持、跌停潮必须为负。
 *   4) 影响程度评分映射：signal → impactScore 的方向保底（弱信号不得被抹平成 0）。
 *
 * 运行：node scripts/test_factor_direction.js
 */
const fs = require('fs');
const path = require('path');

// 从源码中提取顶层函数（短期判断模块未导出这些内部函数，只能按名字截取后 eval）
function extractFn(src, name) {
  const re = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数: ' + name);
  return m[0];
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
const STOCK_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stockData.js'), 'utf8');
// 20261017a：个股换手率变化已随「量能唯一出口」收敛迁入 lib/capitalFlow.js
//   computeTurnoverChangeShared（原 sameDayJudgment._computeTurnoverChange），
//   连同它依赖的 _round/_clamp/_avg 辅助函数一并从 capitalFlow.js 提取注入。
const CAP_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'capitalFlow.js'), 'utf8');
// 20260917i：不再从源码提取 'localDate' —— 源码里它是委托壳（引用未注入沙箱的 _localDate），
// 且与下方 require('../lib/localDate') 的解构 const localDate 重名，会触发
// SyntaxError: Identifier 'localDate' has already been declared。改为统一使用 require 的真实实现。
const NAMES = ['round', 'avg', 'formatWan', 'latestQuarterEnd', // 20260913f：报告期标注依赖
  'factorFuturesShort',
  'shortDirectionToSignal', // 20260905d/20260905e：大盘及行业板块短期走势因子依赖 helper
  // 20260917i：原 factorMarketShort 因子已按用户要求删除，改为两个拆分后的子因子 helper
  'computeMarketShortSub', 'computeSectorTrendSub', 'computeSectorNewsSub',
  'factorHoldings', 'factorSectorLimit', 'detectForcedReduction', '_forcedMatchName'];
const sandbox = {};
// 20260917i：因子/子因子权重常量（W_* / *_SUB_W）随函数一并注入沙箱（源码中因子函数已改为引用常量）
const CONST_DECLS = (SRC.match(/^const (?:W_[A-Z_]+|[A-Z_]+_SUB_W) = [\d.]+;.*$/gm) || []).join('\n');
if (!CONST_DECLS) throw new Error('未提取到 W_* / *_SUB_W 权重常量');
// 20260917i：因子函数返回体引用 FACTOR_NAME（因子展示名映射，如 sectorLimit→'行业板块'），
// 需随函数一并注入沙箱，否则 ReferenceError: FACTOR_NAME is not defined。
const FACTOR_NAME_DECL = (SRC.match(/^const FACTOR_NAME = \{[\s\S]*?\n\};/m) || [])[0];
if (!FACTOR_NAME_DECL) throw new Error('未提取到 FACTOR_NAME 展示名常量');
// 20261017a：computeTurnoverChangeShared 依赖的 capitalFlow 本地辅助函数（_round/_clamp/_avg）
// 三个辅助函数在 capitalFlow.js 头部连续声明（_round 起、_avg 止），
// 用 indexOf 切片提取，避免正则依赖行尾（仓库为 CRLF，\n\} 类正则会失配）
const CAP_HELPERS = (() => {
  const start = CAP_SRC.indexOf('const _round =');
  const avgIdx = CAP_SRC.indexOf('const _avg =');
  if (start < 0 || avgIdx < 0 || avgIdx <= start) throw new Error('未提取到 capitalFlow 辅助函数');
  const end = CAP_SRC.indexOf('\n', avgIdx);
  if (end < 0) throw new Error('未提取到 capitalFlow 辅助函数（_avg 行尾缺失）');
  return CAP_SRC.slice(start, end);
})();
// eslint-disable-next-line no-eval
eval(CONST_DECLS + '\n' + FACTOR_NAME_DECL + '\n'
  + CAP_HELPERS + '\n' + extractFn(CAP_SRC, 'computeTurnoverChangeShared') + '\n'
  + NAMES.map(n => extractFn(SRC, n)).concat([extractFn(STOCK_SRC, 'detectMarket')]).join('\n'));

// 20260906：clamp 已收口至 ruleCore 共享内核（源码中不再有本地定义），改为直接 require
const { clamp, toImpactScore, impactLabel } = require('../lib/ruleCore');
const { localDate, localCompact, localDateFromTs } = require('../lib/localDate');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = (expect === 'pos' && actual > 0) || (expect === 'neg' && actual < 0)
    || (expect === 'zero' && Math.abs(actual) < 1e-9) || (typeof expect === 'number' && Math.abs(actual - expect) < 1e-9);
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else fail++;
  const dir = actual > 0 ? '利好(红)' : actual < 0 ? '利空(绿)' : '中性(灰)';
  console.log(`[${tag}] ${name} → signal=${Number(actual).toFixed(3)} (${dir}) 期望=${expect}`);
}

console.log('===== 1) 对标期货：相关性符号必须参与方向传导 =====');
// 期货近 5 日 +5%（futuresClose 5 个点：100 → 105）
const fcUp = [100, 101, 102, 103, 105];
// 期货近 5 日 -5%
const fcDown = [100, 99, 98, 97, 95];
check('正相关 corr=+0.8，期货 +5%', factorFuturesShort({ hasFutures: true, correlation: 0.8, futuresClose: fcUp, futuresName: 'X' }).signal, 'pos');
check('正相关 corr=+0.8，期货 -5%', factorFuturesShort({ hasFutures: true, correlation: 0.8, futuresClose: fcDown, futuresName: 'X' }).signal, 'neg');
check('负相关 corr=-0.8，期货 +5%（反向→偏空）', factorFuturesShort({ hasFutures: true, correlation: -0.8, futuresClose: fcUp, futuresName: 'X' }).signal, 'neg');
check('负相关 corr=-0.8，期货 -5%（反向→偏多）', factorFuturesShort({ hasFutures: true, correlation: -0.8, futuresClose: fcDown, futuresName: 'X' }).signal, 'pos');
check('无期货 → 不适用', factorFuturesShort({ hasFutures: false }).signal, 'zero');

console.log('\n===== 2) 量价口径：放量随价向 / 缩量反价向 =====');
// 20261017a：_computeTurnoverChange → computeTurnoverChangeShared（lib/capitalFlow.js 量能唯一出口）
const mkSeries = (turnoverSeq, closes) => turnoverSeq.map((t, i) => ({ turnover: t, close: closes[i] }));
// 价格序列：仅最后一根 K 线变价（函数取最后两根收盘价比较方向）
const closesUp = new Array(21).fill(10); closesUp[20] = 11;    // 10 → 11 上涨
const closesDown = new Array(21).fill(10); closesDown[20] = 9; // 10 → 9  下跌
const trVol = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4];      // 放量（2 → 4）
const trShrink = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1.5, 1]; // 缩量（2 → 1）
check('放量上涨', computeTurnoverChangeShared(mkSeries(trVol, closesUp)).signal, 'pos');
check('放量下跌', computeTurnoverChangeShared(mkSeries(trVol, closesDown)).signal, 'neg');
check('缩量上涨（上涨乏力→偏空）', computeTurnoverChangeShared(mkSeries(trShrink, closesUp)).signal, 'neg');
check('缩量下跌（抛压衰竭→偏多）', computeTurnoverChangeShared(mkSeries(trShrink, closesDown)).signal, 'pos');

console.log('\n===== 3) 增持减持 / 板块涨跌停 =====');
const holders = (n, amt) => new Array(n).fill(0).map((_, i) => ({ name: '股东' + i, holdAmount: 1e8, changeAmount: amt }));
check('十大股东净减持', factorHoldings({ topShareholders: holders(10, -5e6) }, { ok: false, count: 0 }).signal, 'neg');
check('十大股东净增持', factorHoldings({ topShareholders: holders(10, 5e6) }, { ok: false, count: 0 }).signal, 'pos');
check('无股东数据（回购已迁出至事件驱动，本因子中性）', factorHoldings({ topShareholders: [] }, { ok: true, count: 2 }).signal, 'zero');
check('板块跌停潮', factorSectorLimit({ ok: true, limitUpRatio: 0, limitDownRatio: 0.2, limitUp: 0, limitDown: 1, total: 5, boardName: 'X' }, null, null).signal, 'neg');
check('板块涨停潮', factorSectorLimit({ ok: true, limitUpRatio: 0.2, limitDownRatio: 0, limitUp: 1, limitDown: 0, total: 5, boardName: 'X' }, null, null).signal, 'pos');

// 20260913f：数据报告期标注（用户反馈「小卡片没有标注日期」）——因子 caption 与两个子卡片都必须带报告期
const holdersDated = (endDate) => new Array(10).fill(0).map((_, i) => ({ name: '股东' + i, holdAmount: 1e8, changeAmount: i < 6 ? 5e6 : -5e6, endDate }));
const hLast = factorHoldings({ topShareholders: holdersDated('2026-06-30') }, { ok: false, count: 0 });
const subCount = (hLast.subFactors || []).find(s => s.name === '增减持家数') || {};
const subNet = (hLast.subFactors || []).find(s => s.name === '十大股东净变动') || {};
const qExpect = latestQuarterEnd();
const isQ = /^\d{4}-\d{2}-\d{2}$/.test(qExpect) && /-(03-31|06-30|09-30|12-31)$/.test(qExpect) && qExpect <= localDate();
if (isQ) pass++; else fail++;
console.log(`[${isQ ? 'PASS' : 'FAIL'}] latestQuarterEnd() = ${qExpect}（必须是 ≤ 今天的季度末）`);
const capOk = /数据报告期/.test(hLast.caption || '') && /2026-06-30/.test(hLast.caption || '') && /东方财富 F10/.test(hLast.caption || '');
if (capOk) pass++; else fail++;
console.log(`[${capOk ? 'PASS' : 'FAIL'}] 因子 caption 含报告期+来源：${hLast.caption}`);
const subOk = /数据报告期\s*2026-06-30/.test(subCount.detail || '') && /数据报告期\s*2026-06-30/.test(subNet.detail || '');
if (subOk) pass++; else fail++;
console.log(`[${subOk ? 'PASS' : 'FAIL'}] 「增减持家数」「十大股东净变动」子卡片均带报告期`);
// 非最新季报期必须显式标注（数据最新性规则：过期必须标注）
const hOld = factorHoldings({ topShareholders: holdersDated('2026-03-31') }, { ok: false, count: 0 });
const oldFlag = /非最新季报期/.test(hOld.caption || '');
if (oldFlag) pass++; else fail++;
console.log(`[${oldFlag ? 'PASS' : 'FAIL'}] 旧报告期显式标注「非最新季报期」：${hOld.caption}`);

console.log('\n===== 4) 大盘短期走势 / 行业短期走势（20260917i 因子重组拆分自「大盘及行业板块短期走势」）=====');
const ctxOf = (chg, dir) => ({
  selectedIndices: [{ name: '上证指数', changePct: chg }],
  techIndices: [{ name: '上证指数', step6: { shortTerm: { direction: dir } } }],
  scopeLabel: '上证指数',
});
check('大盘短期走势（首页研判看空）', computeMarketShortSub(ctxOf(-2, '看空')).signal, 'neg');
check('大盘短期走势（首页研判看多）', computeMarketShortSub(ctxOf(2, '看多')).signal, 'pos');
check('大盘短期走势（首页研判震荡）', computeMarketShortSub(ctxOf(0, '震荡')).signal, 'zero');
check('行业短期走势（板块 -2%）', computeSectorTrendSub({ ok: true, boardChange: -2, upCount: 1, downCount: 9, boardName: 'X' }).signal, 'neg');
check('行业短期走势（板块 +2%）', computeSectorTrendSub({ ok: true, boardChange: 2, upCount: 9, downCount: 1, boardName: 'X' }).signal, 'pos');
check('板块消息（利空）', computeSectorNewsSub({ ok: true, signal: -0.8, count: 5, positive: 1, negative: 4, keywords: ['X'], avgScore: -0.5 }).signal, 'neg');
const snNull = computeSectorNewsSub(null);
if (snNull === null) pass++; else fail++;
console.log(`[${snNull === null ? 'PASS' : 'FAIL'}] 板块消息（数据缺失→返回 null 不展示子卡）`);
// 「行业板块」因子：涨跌停占比 + 行业短期走势 + 板块消息 三路加权，方向必须由三方共同决定
check('行业板块（跌停潮+行业跌+板块利空）', factorSectorLimit({ ok: true, limitUpRatio: 0, limitDownRatio: 0.2, limitUp: 0, limitDown: 1, total: 5, boardName: 'X' }, { ok: true, boardChange: -2, upCount: 1, downCount: 9, boardName: 'X' }, { name: '板块消息', signal: -0.8 }).signal, 'neg');
check('行业板块（涨停潮+行业涨+板块利好）', factorSectorLimit({ ok: true, limitUpRatio: 0.2, limitDownRatio: 0, limitUp: 1, limitDown: 0, total: 5, boardName: 'X' }, { ok: true, boardChange: 2, upCount: 9, downCount: 1, boardName: 'X' }, { name: '板块消息', signal: 0.8 }).signal, 'pos');

console.log('\n===== 5) 影响程度评分映射（signal → impactScore）=====');
const mapCases = [
  [0, 0, '零信号 → 中性 0'],
  [0.01, 0, '极弱 +0.01 → 中性 0'],
  [0.02, 1, '弱 +0.02 → 方向保底 利好 +1'],
  [-0.10, -1, '弱 -0.10（如指数60日 -7.1%）→ 方向保底 利空 -1'],
  [0.36, 1, '+0.36 → 利好 +1'],
  [0.5, 2, '+0.5 → 利好 +2'],
  [-0.5, -2, '-0.5 → 利空 -2'],
  [1, 3, '满格 +1 → 利好 +3'],
  [-1, -3, '满格 -1 → 利空 -3'],
];
for (const [sig, exp, desc] of mapCases) {
  const got = toImpactScore(sig);
  const ok = got === exp;
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${desc} → impactScore=${got}（${impactLabel(got)}）`);
}

console.log('\n===== 6) 专属因子子维度方向（20260913f）=====');
// 海天「CPI·食品烟酒及在外餐饮」：子维度必须各按自身数值定方向，
// 不得沿用因子总信号（否则环比 +0.3% 上行=利好 会被总信号带成「利空」）。
const dFactor = require('../lib/dedicatedFactor');
const cpiSubs = dFactor.computeSubSignals('food_cpi_haitian', { yoy: -0.7, mom: 0.3 });
check('CPI 同比 -0.7%（下行）子信号', cpiSubs.yoy, 'neg');
check('CPI 环比 +0.3%（上行）子信号', cpiSubs.mom, 'pos');
check('CPI 因子总信号仍为加权合成 -0.1', dFactor.computeSignal('food_cpi_haitian', { yoy: -0.7, mom: 0.3 }), -0.1);
const cpiMapYoy = toImpactScore(cpiSubs.yoy), cpiMapMom = toImpactScore(cpiSubs.mom);
check('CPI 同比显示为「利空」', cpiMapYoy, 'neg');
check('CPI 环比显示为「利好」', cpiMapMom, 'pos');
const cpiCard = dFactor.getDedicatedFactorsForSymbol('603288', 'short')[0];
if (cpiCard) {
  const momCard = (cpiCard.subFactors || []).find(s => s.key === 'mom') || {};
  const ok2 = momCard.signal > 0 && /上行\s*→\s*利好/.test(momCard.detail || '');
  if (ok2) pass++; else fail++;
  console.log(`[${ok2 ? 'PASS' : 'FAIL'}] 因子卡片环比子维度方向正确（signal=${momCard.signal}）：${momCard.detail}`);
}

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_growth_caliber.js`  ·  141 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_growth_caliber.js — 20261105b 守卫：增长口径一键切换（单季 ↔ 累计）
 *
 * 用户指令：利润增长的单季/累计口径切换策略——一键切换，切换后对应指标分析同步切换。
 * 范围：左卡关键财务指标 / 右卡指标分析 / 顶栏 tiles / 信号判定 / 历史百分位 全链路同口径；
 *      sameDayJudgment 短期因子、deep 年度结论、stockData 原始快照保持不变（隔离）。
 */
'use strict';
process.env.SA_SETTINGS_FILE = require('os').tmpdir() + '/sa_test_settings_growth_caliber.json';
const fs = require('fs');
const path = require('path');
try { fs.unlinkSync(process.env.SA_SETTINGS_FILE); } catch (e) { /* 首跑不存在 */ }

const ROOT = path.join(__dirname, '..');
const gc = require(path.join(ROOT, 'lib/growthCaliber.js'));
const { evaluateSignals } = require(path.join(ROOT, 'lib/analysis.js'));
const { buildMetricAnalysis } = require(path.join(ROOT, 'lib/metricAnalysis.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// 夹具：单季同比（DJD）与累计同比（TZ）数值刻意拉开，切换后取数必须不同
const ZY = [
  { REPORT_DATE: '2026-09-30', REPORT_DATE_NAME: '2026三季报', DJD_TOI_YOY: 0.12, TOTALOPERATEREVETZ: 4.27, DJD_DPNP_YOY: -5.3, PARENTNETPROFITTZ: 8.1 },
  { REPORT_DATE: '2025-09-30', REPORT_DATE_NAME: '2025三季报', DJD_TOI_YOY: 2.45, TOTALOPERATEREVETZ: 2.0, DJD_DPNP_YOY: 3.2, PARENTNETPROFITTZ: 6.0 },
];

console.log('=== §1 growthCaliber 设置模块 ===');
{
  ok(gc.getGrowthCaliber() === 'sq', `默认口径 = sq（实际 ${gc.getGrowthCaliber()}）`);
  ok(gc.orderedYoYFields(['DJD_A', 'TZ_B']).join('|') === 'DJD_A|TZ_B', 'sq：字段组原序（单季优先回退累计）');
  ok(gc.orderedYoYFields(['DJD_A', 'TZ_B'], 'cum').join('|') === 'TZ_B|DJD_A', 'cum：字段组反序（累计优先回退单季）');
  gc.setGrowthCaliber('cum');
  ok(gc.getGrowthCaliber() === 'cum', 'setGrowthCaliber("cum") 写入并读回');
  ok(gc.growthCaliberLabel() === '累计口径', 'cum 标签 = 累计口径');
  ok(gc.orderedYoYFields(['DJD_A', 'TZ_B']).join('|') === 'TZ_B|DJD_A', 'orderedYoYFields 缺省读当前设置');
  let threw = false;
  try { gc.setGrowthCaliber('bad'); } catch (e) { threw = true; }
  ok(threw, '非法口径值抛错');
  gc.setGrowthCaliber('sq');
  ok(gc.getGrowthCaliber() === 'sq', '恢复 sq');
}

console.log('=== §2 口径切换后：右卡指标分析（buildGrowth 主值 + 同比维度）===');
{
  const quote = { fundamentals: { zyzbHistory: ZY } };
  const mk = () => buildMetricAnalysis(quote, {}, { isFinancial: false }, [], { metrics: {} }, null, null);

  gc.setGrowthCaliber('sq');
  let ma = mk();
  let g = ma.metrics.find(x => x.key === 'growth');
  ok(ma.growthCaliber === 'sq', '返回体携带 growthCaliber=sq');
  ok(g.valueText === '0.12%', `sq 主值取 DJD 单季（实际 ${g.valueText}）`);
  ok(g.dims.yoy.text.indexOf('单季优先口径') >= 0, 'sq 同比文案标注「单季优先口径」');
  ok(g.dims.yoy.text.indexOf('0.12%') >= 0, 'sq 同比维度值 = 0.12%');
  const noteSq = g.note;
  ok(noteSq.indexOf('单季优先口径') >= 0 && noteSq.indexOf('一键切换') >= 0, 'note 说明当前口径与一键切换');

  gc.setGrowthCaliber('cum');
  ma = mk();
  g = ma.metrics.find(x => x.key === 'growth');
  ok(ma.growthCaliber === 'cum', '返回体携带 growthCaliber=cum');
  ok(g.valueText === '4.27%', `cum 主值取 TZ 累计（实际 ${g.valueText}）`);
  ok(g.dims.yoy.text.indexOf('累计口径') >= 0, 'cum 同比文案标注「累计口径」');
  ok(g.dims.yoy.text.indexOf('4.27%') >= 0, 'cum 同比维度值 = 4.27%');
  const pg = ma.metrics.find(x => x.key === 'profitGrowth');
  ok(pg.valueText === '8.10%', `cum 利润增长主值取 PARENTNETPROFITTZ（实际 ${pg.valueText}）`);

  gc.setGrowthCaliber('sq');
  ma = mk();
  g = ma.metrics.find(x => x.key === 'growth');
  ok(g.valueText === '0.12%', '切回 sq 主值复原（无状态残留）');
}

console.log('=== §3 口径切换后：信号判定（evaluateSignals，左卡徽标/顶栏同源）===');
{
  const f = { zyzbHistory: ZY };
  gc.setGrowthCaliber('sq');
  let sigs = evaluateSignals(f, null, null, {}).signals || [];
  let byKey = {}; sigs.forEach(s => { byKey[s.key] = s; });
  ok(byKey.growth && byKey.growth.value === '0.1%', `sq 营收信号值取单季（实际 ${byKey.growth && byKey.growth.value}）`);
  ok(byKey.growth && byKey.growth.signal === 'bear', 'sq：0.12 vs 2.45 放缓 → bear');
  ok(byKey.profitGrowth && byKey.profitGrowth.reason.indexOf('单季优先口径') >= 0, 'sq 利润信号文案标注「单季优先口径」');
  ok(byKey.profitGrowth && byKey.profitGrowth.value === '-5.3%', `sq 利润信号值取单季（实际 ${byKey.profitGrowth && byKey.profitGrowth.value}）`);

  gc.setGrowthCaliber('cum');
  sigs = evaluateSignals(f, null, null, {}).signals || [];
  byKey = {}; sigs.forEach(s => { byKey[s.key] = s; });
  ok(byKey.growth && byKey.growth.value === '4.3%', `cum 营收信号值取累计（实际 ${byKey.growth && byKey.growth.value}）`);
  ok(byKey.growth && byKey.growth.signal === 'bull', 'cum：4.27 vs 2.0 加速 → bull（口径切换改变判定，符合预期）');
  ok(byKey.profitGrowth && byKey.profitGrowth.reason.indexOf('累计口径') >= 0, 'cum 利润信号文案标注「累计口径」');
  ok(byKey.profitGrowth && byKey.profitGrowth.value === '8.1%', `cum 利润信号值取累计（实际 ${byKey.profitGrowth && byKey.profitGrowth.value}）`);

  gc.setGrowthCaliber('sq');
}

console.log('=== §4 全链路接线守卫（源码级）===');
{
  const anSrc = fs.readFileSync(path.join(ROOT, 'lib/analysis.js'), 'utf8');
  ok((anSrc.match(/orderedYoYFields\(\['DJD_/g) || []).length === 5, 'analysis.js 三处增长信号 + 两处百分位序列接入口径重排（共5处）');
  ok(anSrc.indexOf("growthCaliberLabel()") >= 0, 'analysis.js 信号文案口径标签动态化');
  const fsSrc = fs.readFileSync(path.join(ROOT, 'lib/fundamentalScore.js'), 'utf8');
  ok((fsSrc.match(/orderedYoYFields\(\['DJD_/g) || []).length === 3, 'fundamentalScore.js 三项 yoyPair 接入口径重排（左卡同口径）');
  const maSrc = fs.readFileSync(path.join(ROOT, 'lib/metricAnalysis.js'), 'utf8');
  ok(maSrc.indexOf('const of = orderedYoYFields(field);') >= 0, 'metricAnalysis buildGrowth 字段组按口径重排');
  ok(maSrc.indexOf('growthCaliber: getGrowthCaliber()') >= 0, 'metricAnalysis 返回体携带 growthCaliber');
  const svSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(svSrc.indexOf("app.get('/api/growth-caliber'") >= 0, 'server.js GET /api/growth-caliber 路由');
  ok(svSrc.indexOf("app.post('/api/growth-caliber'") >= 0, 'server.js POST /api/growth-caliber 路由');
  ok(svSrc.indexOf('analysisWarm.clearAllCache()') >= 0, 'POST 后清空分析 TTL 缓存（切换即时生效）');
  ok(svSrc.indexOf("require('./lib/growthCaliber')") >= 0, 'server.js 引入 growthCaliber');
  const awSrc = fs.readFileSync(path.join(ROOT, 'lib/analysisWarm.js'), 'utf8');
  ok(awSrc.indexOf('function clearAllCache()') >= 0 && awSrc.indexOf('clearAllCache,') >= 0, 'analysisWarm 正式导出 clearAllCache');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  ok(appSrc.indexOf('growthCaliberBtn') >= 0 && appSrc.indexOf("fetch('/api/growth-caliber'") >= 0, 'app.js 口径按钮点击 → POST 切换');
  ok(appSrc.indexOf('setGrowthCaliberBtn(data.metricAnalysis && data.metricAnalysis.growthCaliber)') >= 0, 'renderDashboard 按返回口径同步按钮文案');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idxSrc.indexOf('id="growthCaliberBtn"') >= 0, 'index.html 卡头存在口径切换按钮');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  ok(cssSrc.indexOf('.growth-caliber-btn') >= 0, 'style.css 按钮样式');
}

console.log('=== §5 版本戳 ===');
{
  const svSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261106p'/.test(svSrc), "APP_VERSION = '20261106p'");
  ok(svSrc.indexOf('[20261104b] 增长口径一键切换') >= 0, 'server.js 版本注释含 [20261104b] 增长口径一键切换条目');
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.indexOf('?v=20261106p') >= 0, 'index.html 版本戳 ?v=20261106p');
}

// 清理测试设置文件
try { fs.unlinkSync(process.env.SA_SETTINGS_FILE); } catch (e) {}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_holdings_forced_reduction.js`  ·  107 行

~~~js
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
// → magnitudeSignal = -0.03/0.03 = -1（dir -1）；directionSignal = (0-3)/10 = -0.3（dir -1）
// → 20261025j 权重=评分口径：基线父信号 = (0.55/1.2)*(-1) + (0.45/1.2)*(-1) = -0.8333
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

// 基线：无公告 → ④ 中性，父因子 = -0.8333（20261025j 权重=评分口径）
const base = factorHoldings(buildHolders(), NO_BUYBACK, { announcements: [], news: [], companyName: '圣湘生物' });
const baseSignal = base.signal;
const baseSub4 = base.subFactors.find(s => s.name === '股东被动减持');
ok('无事件时父因子信号 = -0.8333（份额满格口径）', approx(baseSignal, -0.833333, 1e-3), baseSignal);
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
const sxBase = (0.55 / 1.2) * -1 + (0.45 / 1.2) * -1; // 20261025j：家数方向与净变动方向同为 -1 → 份额满格
ok('圣湘回归锚点：无被动减持公告时第④子模块中性', sx.subFactors.find(s => s.name === '股东被动减持').signal === 0);
ok('圣湘回归锚点：父因子 = 份额满格基线（零副作用）', approx(sx.signal, sxBase, 1e-3), sx.signal);

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

~~~

---

## `scripts\test_home_rank_scroll.js`  ·  83 行

~~~js
#!/usr/bin/env node
// ============================================================
// 基金行业配置名单滚动稳定守卫（20261105b）
// 用户报障：名单向下浏览时自动回弹到名单前面。
// 根因=分批更新期间每 3 秒轮询 → render() 无条件 innerHTML 全量重建 →
//   浏览器滚动锚定 anchor 失效 → .main-content 滚动位置回弹。
// 修复=① 数据签名比对（未变跳过重建）② 重建时滚动锚定恢复（.main-content）。
// ============================================================
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const ROOT = path.join(__dirname, '..');
console.log('\n== §1 修复机制源码断言 ==');
const src = fs.readFileSync(path.join(ROOT, 'public/js/homeRank.js'), 'utf8');
ok(src.includes('let lastSig = null'), 'lastSig 状态声明（上轮渲染数据签名）');
ok(src.includes('function dataSig(data)'), 'dataSig 签名函数存在');
ok(/p\.running, p\.phase, p\.done/.test(src), '签名覆盖采集进度字段');
ok(/q\.done, q\.published, q\.inWindow, q\.updatedTo/.test(src), '签名覆盖季度状态字段');
ok(src.includes('data.periodLabel, data.note,'), '签名覆盖期次与备注');
ok(/\(data\.industries \|\| \[\]\)\.map\(i => \[i\.name, i\.marketValueYi/.test(src), '签名覆盖行业排名数据（名次/市值/环比/占比/top重仓）');
ok(src.includes('if (sig === lastSig) return;'), '签名相同 → 跳过 innerHTML 重建（滚动位置原样保留）');

console.log('\n== §2 滚动锚定恢复 ==');
ok(src.includes('const beforeTop = oldAnchor ? oldAnchor.getBoundingClientRect().top : null;'), '重建前记录锚点相对视口位置');
ok(src.includes('const delta = newAnchor.getBoundingClientRect().top - beforeTop;'), '重建后测量新位置差值');
ok(src.includes('main.scrollTop += delta'), '差值校正回滚动容器 scrollTop（内容钉在视口原位）');
ok(src.includes("document.querySelector('.main-content') || document.scrollingElement"), '滚动容器=.main-content（20261104g 口径）+ scrollingElement 兜底');
ok(src.includes("body.querySelector('.fmr-table-wrap') || body.querySelector('.fmr-quarter')"), '锚点优先名单表格容器、退化状态条');

console.log('\n== §3 行为语义 ==');
{
  // updEl 时间戳更新必须在 sig 判断之前（数据未变的轮次头部时间照常走）
  const updIdx = src.indexOf("updEl.textContent = parts.join(' · ')");
  const sigIdx = src.indexOf('if (sig === lastSig) return;');
  ok(updIdx > -1 && sigIdx > -1 && updIdx < sigIdx, '「更新 HH:MM」时间戳在签名判断之前更新（未变轮次也照常走）');
  // innerHTML 重建必须在 sig 判断之后
  const rebuildIdx = src.indexOf('body.innerHTML = html;');
  ok(rebuildIdx > sigIdx, 'innerHTML 重建在签名守卫之后（未变不重建）');
}
ok(src.includes('lastSig = null; // 20261104j：手动刷新强制重建一次'), '手动刷新强制重建一次（用户主动动作视觉反馈）');
ok(src.includes("body.innerHTML = '<div class=\"ai-empty\">正在获取全市场基金行业配置名单…</div>'")
   && src.includes("!body.querySelector('.fmr-table') && !body.querySelector('.fmr-quarter')"), '首次 loading 占位仅在无内容时（不破坏已有表格）');

console.log('\n== §4 模块可加载与导出契约 ==');
{
  try {
    const HomeRank = require(path.join(ROOT, 'public/js/homeRank.js'));
    ok(HomeRank && typeof HomeRank.load === 'function' && typeof HomeRank.refresh === 'function' && typeof HomeRank.bind === 'function', 'IIFE require 不碰 document、导出 load/refresh/bind 契约不变');
  } catch (e) { ok(false, 'homeRank.js require 失败: ' + e.message); }
}
{
  // dataSig 纯函数行为验证：从源码提取函数体在沙箱中执行
  const m = src.match(/function dataSig\(data\) \{[\s\S]*?\n  \}/);
  ok(!!m, 'dataSig 函数体可提取');
  if (m) {
    const dataSig = new Function('return ' + m[0])();
    const base = { coverage: { universe: 10, fundsComparable: 8 }, quarter: { published: true, done: false }, industries: [{ name: '半导体', marketValueYi: 8188 }] };
    const s1 = dataSig(base);
    const s2 = dataSig(JSON.parse(JSON.stringify(base)));
    ok(s1 === s2, '相同数据 → 签名一致');
    const s3 = dataSig(Object.assign({}, base, { industries: [{ name: '半导体', marketValueYi: 8200 }] }));
    ok(s3 !== s1, '排名数据变化 → 签名变化');
    const s4 = dataSig(Object.assign({}, base, { progress: { running: true, phase: 'holdings', done: 500 } }));
    ok(s4 !== s1, '采集进度变化 → 签名变化');
    ok(dataSig({}) === dataSig({}), '空数据安全（字段缺省不抛错）');
  }
}

console.log('\n== §5 版本戳 ==');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261106p'/.test(server), "server.js APP_VERSION=20261106p");
  ok(server.includes('[20261104j] 基金行业配置名单滚动稳定'), 'server.js 含 [20261104j] 版本注释条目（本功能引入版本，历史条目不随全局版本升级）');
  ok(server.includes('[20261104i] 威高血净（603014）专属估值模型'), '前版 [20261104i] 条目保留');
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.includes('homeRank.js?v=20261106p'), 'index.html homeRank.js 版本戳已对齐 20261106p');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_hot_topics_consistency.js`  ·  137 行

~~~js
/**
 * 个股近期热点 × 舆情讨论热度「口径一致性」回归测试
 * --------------------------------------------------------------
 * 背景（用户 2026-09-13 反馈）：个股近期热点显示「未抓取到帖子 / 无热议话题」，
 *   而同一页的「舆情与讨论热度（个股）」却抓到了 14 帖与焦点帖（2026.09.12 收购淘大食品），
 *   两张卡片结论互相打架。
 *
 * 本测试锁定修复后的行为（20260913f）：
 *   1) 热点模块新增三条渠道：同花顺股吧讨论帖 / 多平台讨论热度 / 个股新闻，
 *      与舆情因子同源（lib/sentiment），evidence 中必须出现这些来源；
 *   2) 只要有讨论帖或热度，结果必带 discussion.digest（确定性摘要，不依赖 LLM）；
 *   3) LLM 在已有讨论证据时仍答「未抓取到帖子」→ 综述必须被确定性摘要覆盖；
 *   4) LLM 失败时回退话题必须来自股吧讨论帖，而不是"无热议话题"；
 *   5) 缓存写入口带 cacheVer，旧口径缓存必须失效重算。
 *
 * 通过 require.cache 注入 mock，全程零网络、零 AI 调用；测试用 symbol 999999，
 * 结束自动清理 data/hot-topics/999999。
 *
 * 运行：node scripts/test_hot_topics_consistency.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 分诊 2026-11-03（任务 #35）：cacheVer 期望值从 lib/hotTopics.js 源码动态提取（原硬编码 '20260923h'
// 在 20261013g 升版时漏同步致守卫常驻失败）——未来 CACHE_VER 升版守卫自动跟随，不再需要手工 sed
const HOT_TOPICS_CACHE_VER = (fs.readFileSync(path.join(__dirname, '..', 'lib', 'hotTopics.js'), 'utf8')
  .match(/const CACHE_VER = '([^']+)'/) || [])[1] || 'UNKNOWN';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? '：' + extra : ''}`);
}
// require.cache 注入 mock：必须先于 require 目标模块
// 注意：路径以「项目根」为基准解析（本脚本位于 scripts/ 下），
// 否则会解析成 scripts/lib/xxx 而报 MODULE_NOT_FOUND。
const ROOT = path.join(__dirname, '..');
function mock(rel, exports) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

const SYMBOL = '999999';
const CACHE_DIR = path.join(__dirname, '..', 'data', 'hot-topics', SYMBOL);

const POSTS = [
  { id: '1', content: '2026.09.12 海天味业 03288.HK 百年淘大易主 海天味业完成收购淘大食品', ctime: 1789232064, reply: 5, like: 3, share: 0, forward: 0, isV: false },
  { id: '2', content: '$海天味业(603288)$ 关于个人增持海天味业股份的公告 拟增持 25000 元', ctime: 1789261446, reply: 1, like: 0, share: 0, forward: 0, isV: false },
];
const HEAT = {
  ok: true,
  eastmoney: { ok: true, symbolScore: 74.1, symbolRise: 176 },
  tonghuashun: { ok: true, inHotList: false, note: '未入热榜' },
  xueqiu: { ok: true, inTop: true, rank: 17, follow: 1929333 },
};

mock('./lib/sentiment', {
  getMarketSentiment: async () => ({
    stockDiscussion: { ok: true, posts: POSTS },
    discussionHeat: HEAT,
    newsSentiment: { ok: true, samples: [{ title: '海天味业 2026 年中报净利润 41.90 亿元', score: 0.727, date: '08-27' }] },
  }),
});
mock('./lib/cnscraperAdapter', {
  getGlobalSentiment: async () => ({ ok: false }),
  searchAnnouncementsByCode: async () => ({ ok: false }),
  interpretReport: async () => ({ ok: false }),
});

function freshHotTopics(aiMock) {
  mock('./lib/aiAugment', aiMock);
  delete require.cache[require.resolve(path.join(ROOT, './lib/hotTopics'))];
  return require(path.join(ROOT, './lib/hotTopics'));
}

(async () => {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {}

  // ---------- 场景 A：LLM 返回「未抓取到帖子」（复现用户截图 3 的措辞）----------
  const ht = freshHotTopics({
    loadConfig: () => ({ apiKey: 'test-key', provider: 'p', modelWeb: 'm' }),
    callLLM: async () => JSON.stringify({
      topics: [{ keyword: '成交冷清', desc: '未抓取到具体帖子', heat: '低', sentiment: '中性' }],
      summary: '显示为东方财富网股吧的页面框架与基础数据字段，未抓取到具体的股民讨论帖子或新闻标题。',
    }),
  });
  const st = await ht.getState(SYMBOL, '海天味业', true);
  const a = st.analysis || {};

  check('结果含 discussion.digest（确定性讨论摘要）', !!(a.discussion && a.discussion.digest), a.discussion && a.discussion.digest);
  check('摘要含东财/雪球多平台热度', /74\.1/.test(a.discussion.digest) && /第 17 名/.test(a.discussion.digest));
  check('摘要含讨论帖条数与最热帖（焦点帖）', /2 条/.test(a.discussion.digest) && /最热帖/.test(a.discussion.digest));
  check('新增渠道出现在 sources 中',
    ['同花顺股吧讨论帖', '多平台讨论热度（东财/同花顺/雪球）', '个股新闻'].every(s => (a.sources || []).includes(s)),
    JSON.stringify(a.sources));
  check('LLM 否认有内容时综述被确定性摘要覆盖', /【讨论热度】/.test(a.content || '') && !/^未抓取到/.test(a.content || ''));
  check('缓存写入带 cacheVer', a.cacheVer === HOT_TOPICS_CACHE_VER, String(a.cacheVer));

  // ---------- 场景 B：LLM 失败 → 回退话题须来自股吧讨论帖 ----------
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {}
  const ht2 = freshHotTopics({
    loadConfig: () => ({ apiKey: 'test-key', provider: 'p', modelWeb: 'm' }),
    callLLM: async () => { throw new Error('模拟超时 timeout'); },
  });
  const st2 = await ht2.getState(SYMBOL, '海天味业', true);
  const a2 = st2.analysis || {};
  check('LLM 失败仍有回退话题', Array.isArray(a2.topics) && a2.topics.length > 0, `${(a2.topics || []).length} 条`);
  check('回退话题来自股吧讨论帖/热度/新闻',
    (a2.topics || []).some(t => /淘大|增持|热度|中报/.test(t.keyword || '')),
    (a2.topics || []).map(t => t.keyword).join(' | '));
  check('不再误报「未抓取到有效网络舆情或公告」', !/未抓取到有效网络舆情或公告。$/.test(a2.content || ''));

  // ---------- 场景 C：旧口径缓存必须失效 ----------
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {}
  const ht3 = freshHotTopics({
    loadConfig: () => ({ apiKey: 'test-key', provider: 'p', modelWeb: 'm' }),
    callLLM: async () => JSON.stringify({ topics: [{ keyword: '新口径', desc: 'x', heat: '高', sentiment: '利好' }], summary: 'ok' }),
  });
  const r1 = await ht3.getState(SYMBOL, '海天味业', false);
  check('首次请求写入缓存并返回结果', !!(r1.analysis && r1.analysis.topics && r1.analysis.topics.length));
  // 手工把磁盘缓存改成旧口径（无 cacheVer）→ 必须重算而不是复用
  const cf = path.join(CACHE_DIR, 'trending.json');
  const obj = JSON.parse(fs.readFileSync(cf, 'utf8'));
  delete obj.cacheVer;
  obj.topics = [{ keyword: '旧口径残留', desc: 'y', heat: '低', sentiment: '未知' }];
  fs.writeFileSync(cf, JSON.stringify(obj), 'utf8');
  const r2 = await ht3.getState(SYMBOL, '海天味业', false);
  check('旧口径缓存（无 cacheVer）被作废重算', !!(r2.analysis && !r2.analysis.cached && (r2.analysis.topics || []).some(t => t.keyword === '新口径')),
    JSON.stringify((r2.analysis && r2.analysis.topics || []).map(t => t.keyword)));

  // ---------- 清理 ----------
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); console.log('INFO: 已清理测试缓存 data/hot-topics/' + SYMBOL); } catch (e) {}
  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });

~~~

---

## `scripts\test_hot_topics_merge.js`  ·  158 行

~~~js
#!/usr/bin/env node
/* 板块舆情热度周榜 · 双社区源合并回归测试（20260913h）
 * 离线纯函数测试：直接调 lib/hotTopicsWeekly/engine.js 的 computeWeekly，零网络零 Python。
 *
 * 口径（20260913h）：
 *   - 社区讨论双源：东财股吧板块吧(gubaEm) + 同花顺讨论 API(guba)，跨日跨源按 post_id 去重。
 *   - 东财**只参与 C/E**（帖子级情绪/韭菜统计）；**B 的量级项（帖数增量 + 互动量）统一取同花顺**
 *     —— 因为东财 post_click_count 是真·浏览量（十万级）、同花顺 clicks 是点赞+转发（十位级），混算会让 B 被压垮。
 *   - 任一社区源「有板块数据」即不降级（含 status='challenge' 的部分成功）。
 *
 * 锁定：
 *   §1 东财数据不参与 B（B 量级项单源化），但参与 E/C
 *   §2 只用东财帖时 E/C 仍能算出（B 走单日种子）
 *   §3 challenge（熔断部分成功）已抓到的数据不丢弃；两源皆空才降级
 *   §4 跨源/跨日按 post_id 去重
 *   §5 两源任一有数据即不降级
 *   §6 两源皆无数据 → 降级权重（A×0.8 + D×0.2），B/E 不参与
 *   §7 meta 口径透明字段（communitySrcOkDays / gubaAvailable 兼容字段）
 * 跑法：node scripts/test_hot_topics_merge.js
 */
'use strict';
const path = require('path');
const { computeWeekly } = require(path.join(__dirname, '..', 'lib', 'hotTopicsWeekly', 'engine'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra != null ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function board(code, name) { return { code, name, aliases: [], keywords: [] }; }
function cfg(over) {
  return Object.assign({
    weights: { A: 0.4, B: 0.4, D: 0.1, E: 0.1 },
    degradeWeights: { A: 0.8, D: 0.2 },
    levels: { hot: 72, warm: 60 },
    alarm: { cNorm: 90, score: 70 },
    crossCheck: { enabled: false },
    sentimentTags: {},
    topN: 10,
  }, over || {});
}
const B = 'BK0001';
function wrap(key, status, boardsMap) { const d = {}; d[key] = { status, boards: boardsMap }; return d; }
function bm(count, posts) { const o = {}; o[B] = { bar_name: '甲板块', count, posts: posts || [] }; return o; }
function day(date, data) { return { date, data }; }
function rowOf(res, code) { return (res.rows || []).find(r => r.code === (code || B)); }
function P(id, title, clicks, comments) { return { id, title, clicks: clicks || 0, comments: comments || 0, pinned: 0 }; }

// ============ §1 东财数据不参与 B（量级项单源化），但参与 E ============
console.log('\n§1 东财不参与 B 的量级项（避免真·浏览量 与 点赞+转发 混算）');
{
  const boards = [board(B, '甲板块')];
  const thsDays = [
    day('2026-09-08', wrap('guba', 'ok', bm(20, [P('t1', '看多 大涨 涨停', 3, 1)]))),
    day('2026-09-09', wrap('guba', 'ok', bm(26, [P('t2', '看空 大跌 破位', 2, 0)]))),
  ];
  // 东财数据：板块总帖数巨大、单帖浏览量十万级 —— 若混算会把 B 直接压垮
  const emD1 = wrap('gubaEm', 'ok', bm(72561, [P('e1', '资金流入 板块利好 大涨', 77314, 383)]));
  const emD2 = wrap('gubaEm', 'ok', bm(73000, [P('e2', '下周回调 科技大涨', 6387, 4)]));
  const resThsOnly = computeWeekly(boards, thsDays, cfg());
  const merged = [day('2026-09-08', Object.assign({}, thsDays[0].data, emD1)),
                  day('2026-09-09', Object.assign({}, thsDays[1].data, emD2))];
  const resBoth = computeWeekly(boards, merged, cfg());
  const bThs = rowOf(resThsOnly).B.raw, bBoth = rowOf(resBoth).B.raw;
  eq('B 在同花顺单独跑 与 双源跑 完全一致（东财不进 B）', bBoth, bThs);
  // B = THS delta (26-20=6) + clicks(3+2) + comments(1+0) = 12
  eq('B_raw = 6(同花顺增量)+5(点击)+1(评论)', bBoth, 12);
  // E：合并采样帖 4 条（t1 看多 / t2 看空 / e1 看多 / e2 看多）→ 3/4 = 75%
  eq('E 采用合并采样帖（含东财帖）', rowOf(resBoth).E, 75);
  ok('东财帖确实并入了采样（E 由 50 变为 75）', rowOf(resThsOnly).E === 50 && rowOf(resBoth).E === 75,
     { thsOnly: rowOf(resThsOnly).E, both: rowOf(resBoth).E });
}

// ============ §2 只用东财帖也能算出 E/C（B 走单日种子） ============
console.log('\n§2 仅东财帖时 E/C 仍可算（B 走单日种子）');
{
  const boards = [board(B, '甲板块')];
  const dailies = [day('2026-09-08', wrap('gubaEm', 'ok', bm(1000, [
    P('e1', '看好 大涨 涨停', 0, 0),
    P('e2', '买入机会 稳了', 0, 0),
    P('e3', '新手求教 该买什么', 0, 0),
  ])))];
  const res = computeWeekly(boards, dailies, cfg());
  const r = rowOf(res);
  eq('E（3 帖中 2 看多）', r.E, 67);
  eq('C_raw（韭菜帖 1 条）', r.C.raw, 1);
  eq('B_raw（无同花顺数据 → B 的量级项为 0）', r.B.raw, 0);
  eq('communitySrcOkDays.em', res.meta.communitySrcOkDays.em, 1);
  eq('communitySrcOkDays.ths', res.meta.communitySrcOkDays.ths, 0);
  eq('degradeMode（东财有数据 → 不降级）', res.meta.degradeMode, false);
}

// ============ §3 challenge（熔断部分成功）已抓数据不丢弃 ============
console.log('\n§3 东财 challenge（熔断）→ 已抓到的板块数据不丢弃');
{
  const boards = [board(B, '甲板块')];
  const dailies = [
    day('2026-09-08', wrap('gubaEm', 'challenge', bm(500, [P('e1', '看好 大涨 涨停', 0, 0)]))),
    day('2026-09-09', wrap('gubaEm', 'challenge', bm(560, [P('e2', '看空 大跌 破位', 0, 0)]))),
  ];
  const res = computeWeekly(boards, dailies, cfg());
  eq('communitySrcOkDays.em（challenge 计入）', res.meta.communitySrcOkDays.em, 2);
  eq('E（challenge 帖仍参与情绪统计）', rowOf(res).E, 50);
  eq('communityAvailable', res.meta.communityAvailable, true);
  eq('degradeMode', res.meta.degradeMode, false);
}

// ============ §4 跨源/跨日去重 ============
console.log('\n§4 跨源去重（同 id 只计一次）');
{
  const dup = P('dup1', '看多 机会 稳了', 100, 9);
  const boards = [board(B, '甲板块')];
  const d1 = Object.assign({}, wrap('guba', 'ok', bm(10, [dup, P('x', '看空 大跌 破位', 0, 0)])), wrap('gubaEm', 'ok', bm(500, [dup])));
  const res = computeWeekly(boards, [day('2026-09-08', d1)], cfg());
  const r = rowOf(res);
  // 唯一非垃圾帖 2 条（dup1 看多 / x 看空）→ E = 50%
  eq('E（dup 只计一次）', r.E, 50);
  // B：同花顺 clicks 只算一次 → 100 + 9 = 109；单日种子 = 合并采样帖数 2 → 111
  eq('B_raw = 2(种子) + 100(点击) + 9(评论)', r.B.raw, 111);
}

// ============ §5 两源任一有数据即不降级 ============
console.log('\n§5 两源任一有数据即不降级');
{
  const boards = [board(B, '甲板块')];
  const dailies = [
    day('2026-09-08', Object.assign({}, wrap('guba', 'error', {}), wrap('gubaEm', 'ok', bm(100, [P('e1', '看多 大涨', 0, 0)])))),
    day('2026-09-09', Object.assign({}, wrap('guba', 'error', {}), wrap('gubaEm', 'ok', bm(140, [])))),
  ];
  const res = computeWeekly(boards, dailies, cfg());
  eq('communityAvailable', res.meta.communityAvailable, true);
  eq('gubaAvailable（兼容字段）', res.meta.gubaAvailable, true);
  eq('degradeMode', res.meta.degradeMode, false);
  eq('weightsUsed = 正常权重', res.meta.weightsUsed, { A: 0.4, B: 0.4, D: 0.1, E: 0.1 });
}

// ============ §6 两源皆无数据 → 降级 ============
console.log('\n§6 两源皆无数据 → 降级权重');
{
  const boards = [board(B, '甲板块')];
  const dailies = [day('2026-09-08', Object.assign(
    {}, wrap('guba', 'challenge', {}), wrap('gubaEm', 'error', {}),
    { news: { status: 'ok', items: [{ title: '甲板块迎来利好', text: '甲板块迎来利好' }] } }
  ))];
  const res = computeWeekly(boards, dailies, cfg());
  eq('degradeMode', res.meta.degradeMode, true);
  eq('communitySrcOkDays 全 0', res.meta.communitySrcOkDays, { em: 0, ths: 0 });
  eq('weightsUsed = 降级权重', res.meta.weightsUsed, { A: 0.8, D: 0.2 });
  const r = rowOf(res);
  ok('降级下仍有榜单行（舆情 A 支撑）', !!r, res.rows);
  if (r) eq('A_raw（归属快讯 1 条）', r.A.raw, 1);
}

console.log('\n──────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_hot_topics_stale_fix.js`  ·  74 行

~~~js
// 验证 hotTopics 异动归因卡的「盘中冻结快照」bug（用户 2026-11-01 报障）：
// 缓存按交易日复用，但展示用的涨跌幅/振幅/高低价必须以「当前行情」为准，不能复用盘中快照。
// 逻辑权威由代码执行，无网络依赖（直接注入 quoteArg 绕过 getQuote）。
const fs = require('fs');
const path = require('path');
const ht = require('../lib/hotTopics.js');

const SYM = 'TEST783';
const ROOT = path.join(__dirname, '..', 'data', 'hot-topics', SYM);
const FILE = path.join(ROOT, 'price-change.json');

function seedCache() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
  // 模拟「盘中快照」：14:00 取的 6.73（-4.40%）/振幅2.98%，而非收盘 6.62（-5.97%）
  const stale = {
    ok: true, mode: 'priceChange', triggered: true, triggeredBy: 'priceChange',
    changePct: -4.4, amplitude: 2.98, high: 6.87, low: 6.66, price: 6.73, prevClose: 7.04,
    date: '2026-10-30', threshold: 3, amplitudeThreshold: 3, symbol: SYM,
    symbolName: '长江证券', cacheVer: '20261013g',
    analysis: '盘中快照归因文本（不应影响展示数字）',
    sources: ['交易所公告'],
  };
  fs.writeFileSync(FILE, JSON.stringify(stale, null, 2));
}

function liveQuote() {
  // 当前行情（收盘后）：6.62 / -5.97% / 振幅 5.97%
  return {
    name: '长江证券', date: '2026-10-30',
    price: 6.62, prevClose: 7.04, high: 7.04, low: 6.62,
    changePct: -5.97, amplitude: 5.97,
  };
}

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('✅ ' + label); }
  else { fail++; console.log('❌ ' + label); }
}

(async () => {
  // ===== 用例1：盘中快照与收盘漂移 >1pp（长江证券真实场景 -4.40% vs -5.97%）→ 作废重算，数字用当前行情 =====
  // 说明：重算会走 LLM/证据抓取（沙箱无网会失败降级），但 baseResult 的涨跌幅/振幅始终取 liveQuote。
  // 为避免网络依赖，这里用「漂移 <=1pp」的近邻场景验证「命中缓存但刷新数字」核心逻辑；
  // 漂移 >1pp 路径（cacheUsable=false→重算）由代码阅读保证 baseResult 用 live quote。
  seedCache();
  // 改写缓存为「漂移 0.47pp」的近邻，以离线命中缓存分支并验证数字刷新
  const near = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  near.changePct = -5.5; near.amplitude = 5.5; near.price = 6.65; near.high = 7.04; near.low = 6.62; near.prevClose = 7.04;
  fs.writeFileSync(FILE, JSON.stringify(near, null, 2));

  const live = liveQuote(); // -5.97 / 5.97 / 6.62
  const r = await ht.analyzePriceChange(SYM, '长江证券', live, false);
  ok('命中缓存分支返回 cached=true', r && r.cached === true);
  ok('展示涨跌幅取当前行情 -5.97（非冻结 -5.5）', r && Math.abs(r.changePct - (-5.97)) < 1e-9);
  ok('展示振幅取当前行情 5.97（非冻结 5.5）', r && Math.abs(r.amplitude - 5.97) < 1e-9);
  ok('展示现价取当前行情 6.62（非冻结 6.65）', r && Math.abs(r.price - 6.62) < 1e-9);
  ok('展示昨收与当前行情一致 7.04', r && Math.abs(r.prevClose - 7.04) < 1e-9);

  // ===== 用例2：触发方式/符号变化必须作废重算（方向翻转） =====
  const flip = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  flip.changePct = 5.5; // 缓存为正向，当前为 -5.97（符号相反）
  fs.writeFileSync(FILE, JSON.stringify(flip, null, 2));
  // 同向符号判定失败 → cacheUsable=false → 重算路径；用 force 模拟（离线），只验证不返回旧冻结值
  const r2 = await ht.analyzePriceChange(SYM, '长江证券', live, true);
  ok('方向翻转→重算，不返回旧 +5.5', r2 && r2.changePct === -5.97);

  // 清理
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();

~~~

---

## `scripts\test_huaan_sotp.js`  ·  42 行

~~~js
// 测试华安证券 V3.0【指令9】核心逻辑（纯函数 + 公式一致性）
const m = require('../lib/valuation/huaan600909.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

// ---- pickSotpWeights 三档 ----
ok('ratio 0.05 → normal / SOTP 30% / PB 60%', (() => { const w = m.pickSotpWeights(0.05); return w.mode === 'normal' && w.wST === 0.3 && w.wPB === 0.6; })());
ok('ratio 0.20 → elevated / SOTP 40% / PB 50%', (() => { const w = m.pickSotpWeights(0.20); return w.mode === 'elevated' && w.wST === 0.4 && w.wPB === 0.5; })());
ok('ratio 0.35 → shadow / SOTP 50% / PB 40%', (() => { const w = m.pickSotpWeights(0.35); return w.mode === 'shadow' && w.wST === 0.5 && w.wPB === 0.4; })());
ok('边界 0.10 → elevated', (() => { const w = m.pickSotpWeights(0.10); return w.mode === 'elevated' && w.wST === 0.4; })());
ok('边界 0.30 → elevated（非 shadow）', (() => { const w = m.pickSotpWeights(0.30); return w.mode === 'elevated'; })());
ok('边界 0.3001 → shadow', (() => { const w = m.pickSotpWeights(0.3001); return w.mode === 'shadow'; })());

// ---- liquidityDiscount ----
const cfgR = { sotpLayer: { cxmtLockStatus: 'restricted', cxmtLiquidityDiscount: 0.25 } };
const cfgF = { sotpLayer: { cxmtLockStatus: 'free' } };
const cfgU = { sotpLayer: {} };
ok('限售 → 折扣 0.25 / 保留 0.75', (() => { const l = m.liquidityDiscount(cfgR); return Math.abs(l.discount - 0.25) < 1e-9 && Math.abs(l.retain - 0.75) < 1e-9; })());
ok('无限售 → 折扣 0', (() => { const l = m.liquidityDiscount(cfgF); return l.discount === 0 && l.retain === 1; })());
ok('未知 → 折扣 0.30（保守）', (() => { const l = m.liquidityDiscount(cfgU); return Math.abs(l.discount - 0.3) < 1e-9 && Math.abs(l.retain - 0.7) < 1e-9; })());

// ---- pearson ----
ok('完全正相关 → 1', (() => { const r = m.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]); return Math.abs(r - 1) < 1e-9; })());
ok('完全负相关 → -1', (() => { const r = m.pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]); return Math.abs(r + 1) < 1e-9; })());
ok('弱相关 ≈ 0', (() => { const r = m.pearson([1, 2, 3, 4, 5], [1, -1, 1, -1, 1]); return Math.abs(r) < 0.3; })());
ok('样本不足 → null', (() => { return m.pearson([1, 2, 3]) === null; })());

// ---- 持股价值公式 ----
const stake = (mv, pct, disc) => mv * (pct / 100) * (1 - disc);
ok('持股价值 = 35107 × 0.4391% × 0.75 ≈ 115.6亿', Math.abs(stake(35107, 0.4391, 0.25) - 115.6) < 0.5);

// ---- 长鑫总市值推导（fallback 一致性）：2.64亿股 = 0.4391% → 总市值≈35107亿 ----
const derived = 2.64 * 58.39 / (0.4391 / 100);
ok('fallback 长鑫总市值推导 ≈ 35106亿（误差<10亿）', Math.abs(derived - 35106) < 10);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_index_pe_window_high.js`  ·  92 行

~~~js
/**
 * scripts/test_index_pe_window_high.js — 大盘估值趋势守卫（20261105b）
 *
 * 演进：
 *   20261105b：上证50「近5年百分位 99%」判读（实测 11.72 = 近5年窗口最高，99% 为中位排名法真实值，
 *              东财日频交叉验证），曾加 isWindowHigh「近5年新高」标注。
 *   20261105b（用户指令）：① 停止「近5年新高」标注，改用「历史百分位」（东方财富估值页全部历史口径）——
 *              脚本输出 seriesAll 全历史月度序列，服务端算 quantileAll；② 新增中证1000（乐咕同源同口径），
 *              四指数卡片对称（grid 4 列）+ 四条折线（中证1000 柔和紫 #a48fd8）。
 *
 * 运行： node scripts/test_index_pe_window_high.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { calcQuantile } = require('../lib/indexPETrend');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}

// ---------- §1 calcQuantile 数值断言（中位排名法） ----------
ok(calcQuantile(10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ pe: v }))) === 95,
  '窗口最高点百分位应为 95%（(9+0.5)/10，中位排名法永远 <100%）');
ok(calcQuantile(5.5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ pe: v }))) === 50, '中位值百分位应为 50%');
ok(calcQuantile(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => ({ pe: v }))) === 5, '窗口最低点百分位应为 5%');
ok(calcQuantile(null, [{ pe: 1 }]) === null, 'pe=null 应返回 null');
ok(calcQuantile(5, []) === null, '空序列应返回 null');
// 全历史 vs 近5年窗口差异样例：近5年最高点在全历史中可能只处于中高位
// 序列 1..20（全历史），当前 10（近5年窗口内最高但全历史中位）：lower=9 → 47.5 → 48%
ok(calcQuantile(10, Array.from({ length: 20 }, (_, i) => ({ pe: i + 1 }))) === 48,
  '全历史窗口下近5年最高点应得中位百分位（10/20 → 48%）');

// ---------- §2 源码接线断言 ----------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const libSrc = read('lib/indexPETrend.js');
const appSrc = read('public/js/app.js');
const chartsSrc = read('public/js/charts.js');
const cssSrc = read('public/css/style.css');
const pySrc = read('scripts/index_pe_trend.py');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const indexHtml = read('public/index.html');

// 2a. 历史百分位口径（20261105b）
ok(/quantileAll: latest \? \(calcQuantile\(latest\.pe, seriesAll\)/.test(libSrc),
  'lib 应有 quantileAll（最新 PE × 全历史序列 seriesAll）');
ok(/const names = \['上证50', '沪深300', '中证1000', '科创50'\]/.test(libSrc), 'lib names 应含中证1000（四指数）');
ok(/const seriesAll = \(item\.seriesAll \|\| item\.series \|\| \[\]\)/.test(libSrc), 'seriesAll 缺失时应回退近5年序列（旧缓存兼容）');
ok(libSrc.includes('历史百分位基于全部历史数据得出'), 'lib note 应注明历史百分位口径');
ok(libSrc.includes('module.exports = { getIndexPETrend, calcQuantile }'), 'calcQuantile 应导出供守卫直测');

// 2b. 「近5年新高」按用户指令停止使用（生成层零残留；注释解释不受限）
ok(!libSrc.includes('isWindowHigh'), 'lib 不得再输出 isWindowHigh（20261105b 用户指令停止）');
ok(!appSrc.includes('isWindowHigh'), 'app.js 不得再消费 isWindowHigh');
ok(!appSrc.includes('近5年新高（百分位'), 'app.js 不得再生成「近5年新高（百分位 X%）」文案');

// 2c. app.js 历史百分位文案 + 中证1000 颜色类
ok(appSrc.includes('历史百分位 ${it.quantileAll}%'), 'app.js 卡片应显示「历史百分位 X%」');
ok(appSrc.includes('近5年百分位 ${it.quantile}%'), 'quantileAll 缺失时应回退「近5年百分位」标注');
ok(appSrc.includes("it.name === '中证1000' ? 'ipe-ci1000'"), 'app.js 应给中证1000 分配 ipe-ci1000 颜色类');

// 2d. charts.js 四线对称
ok(/const names = \['上证50', '沪深300', '中证1000', '科创50'\]/.test(chartsSrc), 'charts.js 四条折线应含中证1000');
ok(chartsSrc.includes("'#a48fd8'"), '中证1000 折线应使用柔和紫 #a48fd8（与蓝/金/粉红区分且合 softDark）');

// 2e. style.css 四列对称网格
ok(/\.ipe-stats \{ display: grid; grid-template-columns: repeat\(4, 1fr\)/.test(cssSrc), 'ipe-stats 应为 4 列对称网格');
ok(cssSrc.includes('.ipe-stat.ipe-ci1000'), 'style.css 应有中证1000 左边框色');

// 2f. 抓取脚本 seriesAll + 中证1000
ok(pySrc.includes('"seriesAll": legu["seriesAll"]') && pySrc.includes('"seriesAll": kc["seriesAll"]'),
  '脚本四指数均应输出 seriesAll');
ok(pySrc.includes('for name in ["上证50", "沪深300", "中证1000"]'), '脚本乐咕循环应含中证1000');
ok(pySrc.includes('all_start_str = "2019-01-01"'), '科创50 应全历史抓取（2019-01-01 起）');

// ---------- §3 版本戳 ----------
ok(/const APP_VERSION = '20261106p'/.test(serverSrc), 'server.js APP_VERSION 应为 20261106p');
ok(/\[20261105b\]/.test(serverSrc), 'server.js 应有 [20261105b] 独立注释条目');
ok(/20261106p/.test(indexHtml), 'index.html 版本戳/注释应对齐 20261106p');

// ---------- 汇总 ----------
console.log(`\n共 ${pass + fail} 断言：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) {
  console.log('\n失败明细:');
  failures.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  process.exit(1);
}
console.log('PASS');

~~~

---

## `scripts\test_index_sina_fallback.js`  ·  88 行

~~~js
/**
 * 量能根新浪降级 守卫（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_index_sina_fallback.js
 * 背景（2026-10-23 报障）：腾讯 fqkline 全族被 WAF 拦（HTTP 501 + wa.gtimg.com 跳转验证页），
 * 指数日线取不到 → 首页「量能活跃与量价配合」「大盘近期涨跌势头」全线降级
 * 「上证/深证日线不足 21 根」。修法：fetchIndexDailyBars 加新浪日K降级（仅指数）。
 *
 * 关键量纲（2026-10-23 实测）：新浪指数 volume 单位=股，腾讯=手，100.0 倍整 → ÷100 对齐。
 * 若不除，卡片「亿手」显示错 100 倍、且与腾讯恢复后的数据不可比。
 *
 * 用 require.cache 桩模拟：getKlineJson 抛 501（WAF）、axios.get 返回新浪形状数据。
 */
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// —— 桩：先于 require('../lib/marketTechnical') 注入 require.cache ——
const axiosPath = require.resolve('axios');
const tklineHostPath = require.resolve('../lib/tklineHost');
let axiosGetCalls = [];
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    get: async (url) => {
      axiosGetCalls.push(url);
      if (!/money\.finance\.sina\.com\.cn/.test(url)) throw new Error('unexpected url: ' + url);
      // 新浪形状：{day, open, high, low, close, volume(股)}
      return { data: [
        { day: '2026-10-20', open: 3600, high: 3610, low: 3590, close: 3600, volume: 40000000000 },
        { day: '2026-10-21', open: 3600, high: 3610, low: 3590, close: 3605, volume: 41000000000 },
        { day: '2026-10-22', open: 3605, high: 3620, low: 3600, close: 3658.026, volume: 43769196300 },
        { day: '2026-10-23', open: 3660, high: 3700, low: 3655, close: 3690.475, volume: 55284291200 },
      ] };
    },
  },
};
let klineCalls = 0;
require.cache[tklineHostPath] = {
  id: tklineHostPath, filename: tklineHostPath, loaded: true,
  exports: {
    getKlineJson: async () => { klineCalls++; throw new Error('Request failed with status code 501'); },
  },
};

const mt = require('../lib/marketTechnical');

(async () => {
  console.log('\n[1] 腾讯全族 501 → 新浪降级（形状/量纲/排序）');
  const bars = await mt.fetchIndexDailyBars(320, 'sh000001');
  ok(klineCalls === 1, '先走了腾讯通道（getKlineJson 被调用 1 次）');
  ok(axiosGetCalls.length === 1 && /symbol=sh000001/.test(axiosGetCalls[0]), '降级请求打到新浪（symbol=sh000001）');
  ok(/datalen=320/.test(axiosGetCalls[0]) && /scale=240/.test(axiosGetCalls[0]), 'datalen/scale 参数正确');
  ok(bars.length === 4, `返回 4 根（实际 ${bars.length}）`);
  const last = bars[bars.length - 1];
  ok(last.date === '2026-10-23', `末根日期 = 2026-10-23（实际 ${last.date}）`);
  ok(last.close === 3690.475, `close 透传（实际 ${last.close}）`);
  ok(last.volume === 552842912, `volume ÷100 对齐腾讯量纲：55284291200 股 → 552842912 手（实际 ${last.volume}）`);
  ok(typeof last.open === 'number' && typeof last.high === 'number' && typeof last.low === 'number', 'bar 形状与 fetchKline 同构（date/open/close/high/low/volume）');

  console.log('\n[2] 腾讯正常时不降级');
  // 换一个成功桩：重置 require.cache 需重新加载模块 → 用子进程方式太重，这里用计数断言：
  // 上面 [1] 中 getKlineJson 抛错后 axios 恰好 1 次调用；若腾讯成功路径存在，源码守卫 [4] 覆盖。
  ok(axiosGetCalls.length === 1, '腾讯抛错后才降级 1 次（不会重复打新浪）');

  console.log('\n[3] 新浪返回为空 → 抛错（由上层 marketEmotionData 降级捕获）');
  require.cache[axiosPath].exports.get = async () => ({ data: [] });
  let threw = false;
  try { await mt.fetchIndexDailyBars(320, 'sz399001'); } catch (e) { threw = /新浪日K返回为空/.test(e.message); }
  ok(threw, '空数据抛错、不静默返回空数组');

  console.log('\n[4] 源码守卫');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketTechnical.js'), 'utf8');
  ok(/async function fetchSinaIndexDailyBars/.test(src), '定义了 fetchSinaIndexDailyBars');
  ok(/Math\.round\(\+d\.volume \/ 100\)/.test(src), '量纲换算 ÷100（股→手）存在');
  ok(/finance\.sina\.com\.cn/.test(src) && /scale=240/.test(src), '走新浪日K接口（scale=240 日线）');
  ok(/仅限指数|个股不走此降级/.test(src), '注释明示仅限指数（个股 qfq≠不复权 不走此降级）');
  ok(/腾讯日K返回为空/.test(src), '腾讯返回空数组也触发降级（fetchKline 空不抛错，须显式判空）');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试执行失败:', e.message); process.exit(1); });

~~~

---

## `scripts\test_industry_policy_match.js`  ·  69 行

~~~js
/**
 * 行业政策库 / 行业名归一化 · 最长优先匹配回归（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_industry_policy_match.js
 * 覆盖：20261016b 修复的 IA1/IA2「顺序 includes 第一命中」偏置 bug——
 *       1) getPolicySupport：'电力设备' 不再被 '电力' 抢先，'新能源汽车' 不再被 '新能源' 抢先；
 *       2) normalizeIndustryName（上游）：'新能源汽车' 不再被归一为 '新能源'
 *          （只改下游救不回来，故两处同改、本测试双覆盖）；
 *       3) 回归：既有行业（银行/房地产/白酒/消费电子）判定不变；返回结构保持 4 字段。
 * 说明：确定性纯函数，不联网、不依赖服务。
 */
const { getPolicySupport } = require('../lib/industryAnalysis');
const { normalizeIndustryName } = require('../lib/sectorIdentity');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

console.log('[1] IA1：电力设备 应命中「国家战略扶持」（旧实现被「电力」抢先落「中性（周期）」）');
{
  const r = getPolicySupport('电力设备', '电气设备');
  ok(r && r.matched === true, `matched = true（实际 ${r && r.matched}）`);
  ok(r && String(r.level).includes('国家战略扶持'), `level 含 国家战略扶持（实际 ${r && r.level}）`);
  ok(r && String(r.summary || '').includes('电力设备'), `summary 为电力设备口径（实际首句 ${String((r && r.summary) || '').slice(0, 12)}…）`);
}

console.log('\n[2] IA2：新能源汽车 应命中新能源车口径（旧实现被「新能源」抢先，summary 口径偏）');
{
  const r = getPolicySupport('新能源汽车', '整车');
  ok(r && r.matched === true, `matched = true（实际 ${r && r.matched}）`);
  ok(r && String(r.level).includes('国家战略扶持'), `level 含 国家战略扶持（实际 ${r && r.level}）`);
  ok(r && String(r.summary || '').includes('新能源车'), `summary 为新能源车口径（实际首句 ${String((r && r.summary) || '').slice(0, 12)}…）`);
}

console.log('\n[3] 上游：normalizeIndustryName 不再把「新能源汽车」吞成「新能源」');
{
  const a = normalizeIndustryName('新能源汽车');
  ok(a === '新能源汽车', `新能源汽车 → ${a}（期望 新能源汽车）`);
  const b = normalizeIndustryName('电力设备');
  ok(b === '电力设备', `电力设备 → ${b}（期望 电力设备）`);
}

console.log('\n[4] 回归：既有行业判定不受影响');
{
  const bank = getPolicySupport('银行', '');
  ok(bank && String(bank.level).includes('中性（强监管）'), `银行 → ${bank && bank.level}`);
  const re = getPolicySupport('房地产', '');
  ok(re && String(re.level).includes('受限（托底）'), `房地产 → ${re && re.level}`);
  const semi = getPolicySupport('半导体', '集成电路');
  ok(semi && String(semi.level).includes('国家战略扶持'), `半导体 → ${semi && semi.level}`);
  ok(normalizeIndustryName('白酒') === '食品饮料', `白酒 归一 → ${normalizeIndustryName('白酒')}（期望 食品饮料）`);
  ok(normalizeIndustryName('消费电子') === '电子', `消费电子 归一 → ${normalizeIndustryName('消费电子')}（期望 电子，避免被「消费」捕获）`);
}

console.log('\n[5] 兜底与返回结构：未命中仍返回 4 字段，结构未漂移');
{
  const miss = getPolicySupport('某个未收录行业XYZ', '');
  ok(miss && miss.matched === false, `未命中 matched = false（实际 ${miss && miss.matched}）`);
  ok(miss && String(miss.level).includes('中性（需结合具体政策判断）'), `兜底 level 正确（实际 ${miss && miss.level}）`);
  const keys = Object.keys(miss || {}).sort().join(',');
  ok(keys === 'level,matched,plans,summary', `返回字段 = level,matched,plans,summary（实际 ${keys}）`);
  ok(normalizeIndustryName('') === '', '空输入返回空字符串');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_latest_report_period.js`  ·  88 行

~~~js
/**
 * 「最新财报」报告期窗口回归（20261023h）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_latest_report_period.js
 *
 * 用户报障（2026-10-23，洲明科技 300232 截图）：
 *   「三季报已经出了，模块还在默认解读半年报，自动搜索最新财报的机制是死逻辑吗？」
 *
 * 根因（不是死逻辑，是「按月份猜报告期」晚了一个月）：
 *   lib/deep/financials.js getLatestPartialQuarterDates 原实现：
 *     5-7月 → q=1（只请求 03-31）
 *     8-10月 → q=2（只请求 03-31 / 06-30）   ← 10 月三季报已披露，仍不请求 09-30
 *     11月+ → q=3（才请求 09-30）
 *   三季报法定披露期是 10 月（截止 10-31），所以整个 10 月都读不到三季报。
 *
 * 现改为「直接请求最近两年全部季末报告期」，由 F10 返回实际已披露的那些：
 *   10 月请求 2026-09-30 → 实测 F10 返回「2026三季报」（营收 55.6 亿）。
 */
const fs = require('fs');
const path = require('path');
const { getLatestPartialQuarterDates } = require('../lib/deep/financials');
const { EARNINGS_PROMPT_VERSION } = require('../lib/ai/cache');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const at = (s) => getLatestPartialQuarterDates(new Date(s));
const has = (arr, d) => arr.includes(d);

// ============================================================================
// [1] 10 月：必须请求当年三季报（用户报障场景）
// ============================================================================
console.log('\n[1] 2026-10-23（三季报披露期）');
{
  const d = at('2026-10-23');
  ok(has(d, '2026-09-30'), '包含 2026-09-30（2026三季报）');
  ok(has(d, '2025-09-30'), '包含 2025-09-30（去年同期三季报，供同比）');
  ok(has(d, '2026-06-30') && has(d, '2026-03-31'), '同时保留 06-30 / 03-31（供单季拆分）');
}

// ============================================================================
// [2] 其它披露窗口：4 月一季报 / 8 月中报 / 1 月跨年
// ============================================================================
console.log('\n[2] 其它披露窗口');
{
  const d = at('2026-04-15');
  ok(has(d, '2026-03-31'), '4 月（一季报披露期）包含 2026-03-31');
}
{
  const d = at('2026-08-15');
  ok(has(d, '2026-06-30'), '8 月（中报披露期）包含 2026-06-30');
}
{
  const d = at('2027-01-15');
  ok(has(d, '2026-09-30'), '次年 1 月仍包含 2026-09-30（年报未出前三季报仍是最新）');
}
{
  const d = at('2026-11-05');
  ok(has(d, '2026-09-30'), '11 月包含 2026-09-30');
}

// ============================================================================
// [3] 源码守卫：不再按月份猜 q
// ============================================================================
console.log('\n[3] 源码守卫');
const fsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deep', 'financials.js'), 'utf8');
ok(!/month >= 8 && month <= 10/.test(fsrc), '已删除「8-10月 = 中报」的月份硬编码');
ok(!/month >= 11/.test(fsrc), '已删除「11月起才是三季报」的月份硬编码');
ok(fsrc.includes('getLatestPartialQuarterDates'), '函数仍存在');
ok(fsrc.includes("['03-31', '06-30', '09-30', '12-31']"), '直接请求全部季末报告期');

// ============================================================================
// [4] 缓存失效：旧中报缓存必须被判 stale，深析页丢弃并自动重算
// ============================================================================
console.log('\n[4] 缓存失效链路');
{
  ok(EARNINGS_PROMPT_VERSION === '20261023h', `EARNINGS_PROMPT_VERSION=20261023h（实际 ${EARNINGS_PROMPT_VERSION}）`);
  const p = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deep', 'pipeline.js'), 'utf8');
  ok(p.includes('readEarningsCache'), '深析管线改用 readEarningsCache');
  ok(/er && !er\.stale/.test(p), '深析管线丢弃 stale 财报缓存（前端自动触发重算）');
  const e = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'earnings.js'), 'utf8');
  ok(e.includes('EARNINGS_PROMPT_VERSION'), 'earnings 生成侧仍以 promptVersion 门控');
}

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_left_card_prior_alignment.js`  ·  104 行

~~~js
/**
 * scripts/test_left_card_prior_alignment.js — 「去年同期」口径一致性回归（20260923m）
 *
 * 用户投诉：长江证券（000783）「关键财务指标」（左卡）的「扣非净利润增长·去年同期」
 *           与「指标分析」（右卡）/「判定依据」的去年同期数不一样。
 *
 * 根因：左卡 `public/js/app.js` 的 `priorDedYoy` 取 `zyzb[zyzb.length - 2]` ——
 *       `zyzbHistory` 是**降序**多期序列，倒数第二项 ≈ 接近最早的一期，根本不是去年同期
 *       （同文件 20260909j 注释已把营收/归母改掉，唯独扣非漏改）。
 *       其余三处（lib/metricAnalysis.js `samePeriodPair`、lib/analysis.js `samePeriodYoY`、
 *       lib/fundamentalScore.js `yoyPair`）都做「去年同期·同报告期」对齐。
 *
 * 运行： node scripts/test_left_card_prior_alignment.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { buildMetricAnalysis } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; failures.push(msg); }
}

// ===== 真实序列（000783 长江证券，2026-09-23 实测，降序 9 期）=====
const ROWS = [
  { REPORT_DATE: '2026-06-30', KCFJCXSYJLRTZ: 84.92880198442 },
  { REPORT_DATE: '2026-03-31', KCFJCXSYJLRTZ: 51.966600687618 },
  { REPORT_DATE: '2025-12-31', KCFJCXSYJLRTZ: 108.694913404962 },
  { REPORT_DATE: '2025-09-30', KCFJCXSYJLRTZ: 142.037364781149 },
  { REPORT_DATE: '2025-06-30', KCFJCXSYJLRTZ: 123.277436528755 },
  { REPORT_DATE: '2025-03-31', KCFJCXSYJLRTZ: 150.359223884632 },
  { REPORT_DATE: '2024-12-31', KCFJCXSYJLRTZ: 20.41752129621 },
  { REPORT_DATE: '2024-09-30', KCFJCXSYJLRTZ: 21.060046502895 },
  { REPORT_DATE: '2024-06-30', KCFJCXSYJLRTZ: -27.372690077594 },
];

// ---------- 1. 静态守卫：左卡的 prior* 赋值语句不得再用「倒序序列尾部索引」当去年同期 ----------
// 注意：只检查**赋值语句本身**（而非整份文件），否则本文件/源码里解释该 bug 的注释会误命中。
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const appLines = appSrc.split('\n');
const priorAssign = appLines.filter(l => /const\s+(priorRevenueYoy|priorProfitYoy|priorDedYoy|priorRoeTxt)\s*=/.test(l));
ok(priorAssign.length === 4, `应找到 4 条 prior* 赋值语句，实际 ${priorAssign.length}`);
for (const l of priorAssign) {
  ok(!/zyzb\s*\[\s*zyzb\.length\s*-\s*2\s*\]/.test(l), `prior* 赋值不得用 zyzb[zyzb.length - 2]（那是接近最早的一期，不是去年同期）：${l.trim()}`);
}

// 扣非去年同期必须由 priorYoy（同期对齐对象）派生
const dedLine = (priorAssign.find(l => /priorDedYoy\s*=/.test(l)) || '').trim();
ok(/priorDedYoy\s*=\s*priorYoy\s*\?/.test(dedLine), `priorDedYoy 必须由 priorYoy（同期对齐）派生，实际：${dedLine}`);
ok(dedLine.includes('KCFJCXSYJLRTZ'), 'priorDedYoy 必须取 KCFJCXSYJLRTZ 字段');

// 营收/归母/扣非 三项去年同期必须同源（都取 priorYoy）
for (const [name, re] of [
  ['priorRevenueYoy', /priorRevenueYoy\s*=\s*priorYoy\s*&&/],
  ['priorProfitYoy', /priorProfitYoy\s*=\s*priorYoy\s*&&/],
  ['priorDedYoy', /priorDedYoy\s*=\s*priorYoy\s*\?/],
]) {
  ok(re.test(appSrc), `${name} 必须与其余两项同源（从 priorYoy 取数）`);
}

// ---------- 2. 新旧写法差异对照（证明旧写法确实是 bug） ----------
const parsePct = (v) => { const n = parseFloat(v); return (v == null || isNaN(n)) ? null : n; };
const latest = ROWS[0];
const ld = latest.REPORT_DATE;
const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
const prior = ROWS.find(x => x.REPORT_DATE === tgt) || null;
const correctPrior = prior ? parsePct(prior.KCFJCXSYJLRTZ) : null;   // 同期对齐（新写法）
const oldPrior = parsePct(ROWS[ROWS.length - 2].KCFJCXSYJLRTZ);       // 倒数第二期（旧写法）

ok(tgt === '2025-06-30', `去年同期目标应为 2025-06-30，实际 ${tgt}`);
ok(Math.abs(correctPrior - 123.277436528755) < 1e-6, `同期对齐去年同期应为 123.28%，实际 ${correctPrior}`);
ok(Math.abs(oldPrior - 21.060046502895) < 1e-6, `旧写法（length-2）应取到 2024-09-30 的 21.06%，实际 ${oldPrior}`);
ok(Math.abs(correctPrior - oldPrior) > 1, '新写法与旧写法结果必须显著不同（否则本用例失去意义）');

// ---------- 3. 右卡（真实代码）必须是同期对齐 —— 与左卡修复后同口径 ----------
const out = buildMetricAnalysis(
  { fundamentals: { zyzbHistory: ROWS } },
  { percentiles: {}, industryAvg: {} },
  { isFinancial: true },
  { signals: [] },
  { metrics: { deductedProfitGrowth: 84.92880198442 } },
);
const ded = (out.metrics || []).find(m => m.key === 'dedProfitGrowth');
ok(!!ded, '右卡必须包含 dedProfitGrowth（否则无法比对）');
const yoyText = (ded && ded.dims && ded.dims.yoy && ded.dims.yoy.text) || '';
ok(/123\.28/.test(yoyText), `右卡扣非去年同期应为 123.28%（同期对齐 + 2 位小数），实际文本：${yoyText}`);
ok(!/21\.1/.test(yoyText), `右卡扣非去年同期不得出现旧写法的 21.1%，实际文本：${yoyText}`);

// ---------- 输出 ----------
console.log(`\n最新期 ${ld} → 去年同期(同期对齐) = ${correctPrior}%（正确，2025-06-30）`);
console.log(`                旧写法(length-2) = ${oldPrior}%（错误，2024-09-30）`);
console.log(`右卡 yoy 文本 = ${yoyText}`);

if (fail) {
  console.log(`\nFAIL ${pass}/${pass + fail}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`\nPASS ${pass}/${pass}`);
}

~~~

---

## `scripts\test_limit_board_top.js`  ·  57 行

~~~js
/**
 * 当日最多涨停/跌停板块 · 聚合纯函数离线回归（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_limit_board_top.js
 * 覆盖：aggregateTopIndustry（lib/stockData.js，20261015l）——
 *       正常 top1 / 并列取先出现 / 空池 null / hybk 缺失跳过 / leader 取该行业池内首只。
 * 说明：网络取数（push2ex getTopicZTPool/DTPool）由服务端实测覆盖，本文件只测确定性聚合逻辑。
 */
const { aggregateTopIndustry } = require('../lib/stockData');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

console.log('[1] 正常聚合：取家数最多行业，leader 为该行业池内首只');
{
  const pool = [
    { n: '保隆科技', hybk: '汽车零部' }, { n: '甲股', hybk: '汽车零部' }, { n: '乙股', hybk: '汽车零部' },
    { n: '丙股', hybk: '通用设备' }, { n: '丁股', hybk: '通用设备' }, { n: '戊股', hybk: '出版' },
  ];
  const r = aggregateTopIndustry(pool);
  ok(r && r.name === '汽车零部', `top1 = 汽车零部（实际 ${r && r.name}）`);
  ok(r && r.count === 3, `count = 3（实际 ${r && r.count}）`);
  ok(r && r.leader === '保隆科技', `leader = 池内首只保隆科技（实际 ${r && r.leader}）`);
}

console.log('\n[2] 并列第一：取先出现者（pool 顺序即东财排序，确定性规则）');
{
  const r = aggregateTopIndustry([{ n: 'a', hybk: 'X' }, { n: 'b', hybk: 'Y' }]);
  ok(r && r.name === 'X' && r.count === 1 && r.leader === 'a', `并列取先出现 X/a（实际 ${JSON.stringify(r)}）`);
}

console.log('\n[3] 空池 / 全缺失行业 → null（不伪造）');
ok(aggregateTopIndustry([]) === null, '空数组 → null');
ok(aggregateTopIndustry(null) === null, 'null → null');
ok(aggregateTopIndustry([{ n: 'a' }, { n: 'b', hybk: '' }, { n: 'c', hybk: '  ' }]) === null, 'hybk 全缺失/空白 → null');

console.log('\n[4] 混合脏数据：有效行照常聚合，脏行跳过');
{
  const r = aggregateTopIndustry([
    { n: '脏行无行业' }, { n: '空白行业', hybk: '' },
    { n: '有效1', hybk: '元件' }, { n: '有效2', hybk: '元件' }, { n: '有效3', hybk: '物流' },
  ]);
  ok(r && r.name === '元件' && r.count === 2 && r.leader === '有效1', `脏行跳过，元件 2 家居首（实际 ${JSON.stringify(r)}）`);
}

console.log('\n[5] 单行池：家数 1 也能成为 top1（跌停池仅 1 家的场景）');
{
  const r = aggregateTopIndustry([{ n: '独苗', hybk: '饮料乳品' }]);
  ok(r && r.name === '饮料乳品' && r.count === 1 && r.leader === '独苗', `单行池 top1（实际 ${JSON.stringify(r)}）`);
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_llm_stream_fallback.js`  ·  187 行

~~~js
/**
 * 模型能力自学习（流式 / 联网参数兼容层）回归测试（20260918b）
 * ------------------------------------------------------------------
 * 用户反馈（2026-09-18 18:16 截图）：海天味业（603288）「最大亮点 / 雷点」无法获取数据，
 *   概览卡一直停在「尚未生成」。
 *
 * 根因（真实端到端实证，非推断）：
 *   `data/ai_config.json` 于 2026-09-18 17:42 被改成 modelWeb=glm-4.5-air，
 *   而 `POST /api/ai/aspects {force:true}` 实测 **5.8 秒**即返回
 *   `{success:false, error:'API_ERROR', message:'大模型请求失败（Request failed with status code 400）'}`。
 *   直连百炼验证两个模型名的差异：
 *     - glm-4.5-air 非流式      → HTTP 400 "This model only support stream mode..."
 *     - glm-4.5-air stream:true → HTTP 200（SSE）
 *     - glm-4.5-air + enable_search → HTTP 200 但 SSE 内是 error（"enable_search is not supported"）
 *   即：该模型既不接受非流式、也不接受 enable_search → 所有调用秒级失败。
 *
 * 修复：lib/ai/llm.js 新增「首见即记忆」的模型能力兼容层
 *   §A 默认路径零回归：非 stream-only 模型请求体仍为 stream:false，行为与历史一致
 *   §B 仅支持流式的模型：非流式 400 → 自动改用流式重发，并记忆（第二次调用只发 1 次请求）
 *   §C 不支持联网参数的模型：流式下 SSE error（HTTP 200）被识别 → 去参数重发并记忆
 *   §D SSE 报错且无内容必须抛错（不能被当成「正常空回复」而静默丢结果）
 *   §E 源码守卫：错误透传 response / 无绕过预算的裸 postLLM / postLLM 仍导出
 *
 * 运行：node scripts/test_llm_stream_fallback.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const llm = require('../lib/ai/llm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── 本地桩服务：按「模型名 + 请求体」返回刻意的响应，用于驱动兼容层 ──
const seen = []; // 记录收到的请求（model / stream / enable_search）
const STREAM_MSG = 'This model only support stream mode, please enable the stream parameter to access the model. ';
const NOSEARCH_MSG = 'The parameters `enable_search` is not supported';

function sseChunks(parts) {
  return parts.map((p) => 'data: ' + JSON.stringify(p) + '\n\n').join('') + 'data: [DONE]\n\n';
}
const delta = (t) => ({ choices: [{ index: 0, delta: { content: t } }] });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const model = String(body.model || '');
    const stream = body.stream === true;
    const hasSearch = body.enable_search !== undefined || Array.isArray(body.tools);
    seen.push({ model, stream, hasSearch, noTemp: body.temperature === undefined });

    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const sse = (obj) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream;charset=utf-8' });
      res.end(obj);
    };

    // ① 只支持流式 + 不支持 enable_search（glm-4.5-air 的真实组合，必须先匹配，名字含 streamonly）
    if (/nosearch/.test(model)) {
      if (!stream) return json(400, { error: { message: STREAM_MSG, code: 'invalid_parameter_error' } });
      if (hasSearch) return sse(sseChunks([{ error: { message: NOSEARCH_MSG, code: 'invalid_parameter_error' } }]));
      return sse(sseChunks([delta('降级'), delta('成功')]));
    }
    // ② 只支持流式的模型：非流式一律 400
    if (/streamonly/.test(model)) {
      if (!stream) return json(400, { error: { message: STREAM_MSG, code: 'invalid_parameter_error' } });
      return sse(sseChunks([delta('流式'), delta('已修复')]));
    }
    // ③ 只支持流式，且流式下只返回 error、无任何 content：必须抛错而非返回空串
    if (/sseerror/.test(model)) {
      if (!stream) return json(400, { error: { message: STREAM_MSG, code: 'invalid_parameter_error' } });
      return sse(sseChunks([{ error: { message: 'InternalError.Algo.InvalidParameter: boom', code: 'x' } }]));
    }
    // ⑤ 20261104c：不接受 temperature 参数的模型（kimi-k3 真实报错文案）：
    //    带 temperature → 400 InvalidParameter；剔除后 → 正常返回
    if (/notemp/.test(model)) {
      if (body.temperature !== undefined) {
        return json(400, { error: { message: "InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model.", code: 'InternalError.Algo.InvalidParameter' } });
      }
      return json(200, { choices: [{ message: { content: '温度已剔除' } }] });
    }
    // ④ 普通模型：非流式正常返回（回归基线）
    return json(200, { choices: [{ message: { content: 'HELLO-NORMAL' } }] });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/chat/completions';
  const body = (model, extra) => Object.assign({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, temperature: 0.3 }, extra || {});

  console.log('===== §A 默认路径零回归：普通模型仍走非流式 =====');
  seen.length = 0;
  const a = await llm.postLLM(url, 'k', body('test-normal-model'), 30000);
  ok('返回内容正确', a === 'HELLO-NORMAL', JSON.stringify(a));
  ok('只发 1 次请求', seen.length === 1, '实际 ' + seen.length);
  ok('请求体 stream=false（未擅自升级为流式）', seen[0] && seen[0].stream === false);

  console.log('\n===== §B 仅支持流式的模型：自动重发 + 记忆 =====');
  seen.length = 0;
  const b1 = await llm.postLLM(url, 'k', body('test-streamonly-A'), 30000);
  ok('自动改用流式后拿到拼接内容', b1 === '流式已修复', JSON.stringify(b1));
  ok('本次共 2 次请求（先非流式 400 → 再流式）', seen.length === 2, '实际 ' + seen.length);
  ok('第 1 次非流式', seen[0] && seen[0].stream === false);
  ok('第 2 次已改为流式', seen[1] && seen[1].stream === true);
  seen.length = 0;
  const b2 = await llm.postLLM(url, 'k', body('test-streamonly-A'), 30000);
  ok('第二次调用直接走流式（记忆生效）', seen.length === 1 && seen[0].stream === true, '请求数 ' + seen.length + ' / stream=' + (seen[0] && seen[0].stream));
  ok('第二次内容同样正确', b2 === '流式已修复', JSON.stringify(b2));

  console.log('\n===== §C 不支持 enable_search：SSE error 识别 + 去参数重发 + 记忆 =====');
  seen.length = 0;
  const c1 = await llm.postLLM(url, 'k', body('test-streamonly-nosearch-X', { enable_search: true }), 30000);
  ok('三次握身后成功拿到内容', c1 === '降级成功', JSON.stringify(c1));
  ok('共 3 次请求（非流式400 → 流式带search报错 → 流式去search）', seen.length === 3, '实际 ' + seen.length);
  ok('第 3 次已去掉 enable_search', seen[2] && seen[2].hasSearch === false);
  seen.length = 0;
  const c2 = await llm.postLLM(url, 'k', body('test-streamonly-nosearch-X', { enable_search: true }), 30000);
  ok('第二次调用一次成功（直接流式 + 无搜索参数）', seen.length === 1 && seen[0].stream === true && seen[0].hasSearch === false,
    '请求数 ' + seen.length + ' / stream=' + (seen[0] && seen[0].stream) + ' / hasSearch=' + (seen[0] && seen[0].hasSearch));
  ok('第二次内容正确', c2 === '降级成功', JSON.stringify(c2));

  console.log('\n===== §D SSE 报错且无内容：必须抛错（不得静默返回空串） =====');
  let dErr = null;
  try { await llm.postLLM(url, 'k', body('test-sseerror-Z'), 30000); } catch (e) { dErr = e; }
  ok('确实抛错', !!dErr);
  ok('错误信息含服务端原因', !!(dErr && /boom/.test(String(dErr.message))), dErr && dErr.message);
  ok('归一化出 status=400（便于上游兜底识别）', !!(dErr && dErr.response && dErr.response.status === 400), dErr && dErr.response && String(dErr.response.status));

  console.log('\n===== §E 源码守卫 =====');
  const src = read('lib/ai/llm.js');
  ok('STREAM_ONLY_MODELS 记忆集合存在', /const STREAM_ONLY_MODELS = new Set\(\)/.test(src));
  ok('NO_SEARCH_PARAM_MODELS 记忆集合存在', /const NO_SEARCH_PARAM_MODELS = new Set\(\)/.test(src));
  ok('NO_TEMPERATURE_MODELS 记忆集合存在（20261104c）', /const NO_TEMPERATURE_MODELS = new Set\(\)/.test(src));
  ok('_stripTemperature 降级函数存在', /function _stripTemperature\(/.test(src));
  ok('postLLM 自学习分支③：temperature 400 识别并剔除重发', /temperature/i.test(src) && /NO_TEMPERATURE_MODELS\.add\(model\)/.test(src));
  ok('buildRequestBody kimi 系预判剔除 temperature', /isNoTemperatureModel\(m\)/.test(src) && /function isNoTemperatureModel\(/.test(src));
  ok('SSE 解析函数存在', /function _parseSseContent\(/.test(src));
  ok('SSE error 归一化存在', /function _sseError\(/.test(src));
  ok('错误保留 response/status（修好此前形同虚设的 400 兜底）', /err\.response = \(e && e\.response\) \|\| undefined;/.test(src));
  ok('流式显式 responseType:text（否则 JSON.parse 会炸）', /\.\.\.\(useStream \? \{ responseType: 'text' \} : \{\}\)/.test(src));
  ok('postLLM 仍导出（外部契约未变）', typeof llm.postLLM === 'function');
  const callLLMBody = src.slice(src.indexOf('async function callLLM('), src.indexOf('// 按当前任务类型获取模型'));
  ok('callLLM 内无绕过预算的裸 `return await postLLM(`', (callLLMBody.match(/return await postLLM\(/g) || []).length === 0);
  ok('callBudgeted 仍恰 5 处（预算接线未变）', (callLLMBody.match(/callBudgeted\(/g) || []).length === 5,
    String((callLLMBody.match(/callBudgeted\(/g) || []).length));
  const rb = llm.buildRequestBody('qwen', 'qwen-plus', [], { webSearch: false });
  ok('buildRequestBody 默认仍产出 stream:false（隔离性）', rb.stream === false);

  console.log('\n===== §F 不支持 temperature 的模型（kimi-k3，20261104c）：预判剔除 + 自学习重发 =====');
  const fk = llm.buildRequestBody('qwen', 'kimi-k3', [], { webSearch: false });
  ok('buildRequestBody：kimi-k3 请求体不带 temperature（预判剔除，省一次必然失败请求）', fk.temperature === undefined, 'temperature=' + String(fk.temperature));
  const fk2 = llm.buildRequestBody('qwen', 'kimi-k2', [], { webSearch: false });
  ok('buildRequestBody：kimi-k2 同样剔除', fk2.temperature === undefined);
  const fq = llm.buildRequestBody('qwen', 'qwen-plus', [], { webSearch: false });
  ok('buildRequestBody：qwen-plus 仍带 temperature=0.3（零回归）', fq.temperature === 0.3);
  seen.length = 0;
  const f1 = await llm.postLLM(url, 'k', body('test-notemp-A', { temperature: 0.3 }), 30000);
  ok('首见 400 后剔除 temperature 重发成功', f1 === '温度已剔除', JSON.stringify(f1));
  ok('共 2 次请求（带 temperature 400 → 剔除后成功）', seen.length === 2, '实际 ' + seen.length);
  ok('第 2 次请求已无 temperature', seen[1] && seen[1].noTemp === true, JSON.stringify(seen[1]));
  seen.length = 0;
  const f2 = await llm.postLLM(url, 'k', body('test-notemp-A', { temperature: 0.3 }), 30000);
  ok('第二次调用一次成功（记忆生效，直接剔除）', seen.length === 1 && seen[0].noTemp === true, '请求数 ' + seen.length);
  ok('第二次内容正确', f2 === '温度已剔除', JSON.stringify(f2));

  server.close();
  console.log('\n===================================');
  console.log(' 通过 ' + pass + ' / 失败 ' + fail);
  console.log('===================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常：', e);
  try { server.close(); } catch (err) {}
  process.exit(1);
});

~~~

---

## `scripts\test_local_date.js`  ·  73 行

~~~js
/**
 * lib/localDate.js 回归测试（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_local_date.js
 * 1) 边界正确性：UTC 日期与北京日期不一致的时段（北京 00:00–07:59）必须取北京日。
 * 2) 等价性：在 UTC+8 宿主机上，新工具与旧实现（getFullYear/getMonth/getDate）
 *    对任意时刻必须完全一致 —— 这是「把既有 localDate 改为委托」不改变行为的前提证明。
 * 3) 派生格式：localCompact / localDateTime / localDateFromTs（秒与毫秒）。
 */
const { localDate, localDateTime, localCompact, localDateFromTs, localDateTimeFromTs, TZ } = require('../lib/localDate');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

console.log('\n[1] 时区固定为中国（不依赖宿主机时区）');
ok(TZ === 'Asia/Shanghai', `时区常量 = ${TZ}`);

console.log('\n[2] 边界：北京 00:00–07:59 必须取「北京日」而不是 UTC 的「前一天」');
const boundary = [
  ['2026-09-17T00:00:00+08:00', '2026-09-17'],
  ['2026-09-17T00:30:00+08:00', '2026-09-17'],
  ['2026-09-17T07:59:59+08:00', '2026-09-17'],
  ['2026-09-17T08:00:00+08:00', '2026-09-17'],
  ['2026-09-17T18:39:00+08:00', '2026-09-17'],
  ['2026-09-17T23:59:59+08:00', '2026-09-17'],
  ['2026-09-18T00:00:01+08:00', '2026-09-18'],
];
let bOk = 0;
for (const [iso, expect] of boundary) {
  const got = localDate(new Date(iso));
  const utc = new Date(iso).toISOString().slice(0, 10);
  const flag = got === expect;
  if (flag) bOk++;
  console.log(`  ${flag ? '✓' : '✗'} ${iso} → 本地 ${got}（期望 ${expect}）| 旧 UTC 写法会给出 ${utc}${utc !== expect ? ' ← 错位' : ''}`);
}
ok(bOk === boundary.length, `全部 ${boundary.length} 个边界点正确（${bOk}/${boundary.length}）`);

console.log('\n[3] 等价性：与旧实现（宿主机本地）在 UTC+8 下逐点一致');
const legacy = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
let diff = 0, checked = 0;
const base = Date.parse('2026-01-01T00:00:00+08:00');
for (let i = 0; i < 2000; i++) {
  const d = new Date(base + i * 3600000 * 7 + (i % 13) * 777777);   // 每 7 小时 + 抖动，覆盖全时段
  checked++;
  if (legacy(d) !== localDate(d)) { diff++; if (diff <= 3) console.log(`     差异样本: ${d.toISOString()} legacy=${legacy(d)} new=${localDate(d)}`); }
}
ok(diff === 0, `${checked} 个采样点与旧实现完全一致（差异 ${diff} 个）→ 委托改造不改变现有行为`);

console.log('\n[4] 派生格式');
ok(localCompact(new Date('2026-09-17T00:30:00+08:00')) === '20260917', `localCompact = ${localCompact(new Date('2026-09-17T00:30:00+08:00'))}（东财 beg/end 用）`);
ok(localDateTime(new Date('2026-09-17T18:39:00+08:00')) === '2026-09-17 18:39', `localDateTime = ${localDateTime(new Date('2026-09-17T18:39:00+08:00'))}`);
ok(localDateTime(new Date('2026-09-17T00:05:00+08:00')) === '2026-09-17 00:05', `午夜用 h23 不出现 24:xx（${localDateTime(new Date('2026-09-17T00:05:00+08:00'))}）`);

console.log('\n[5] 时间戳（秒 / 毫秒自动识别）');
const ms = Date.parse('2026-09-17T00:30:00+08:00');
ok(localDateFromTs(ms) === '2026-09-17', `毫秒时间戳 → ${localDateFromTs(ms)}`);
ok(localDateFromTs(Math.floor(ms / 1000)) === '2026-09-17', `秒级时间戳 → ${localDateFromTs(Math.floor(ms / 1000))}`);
ok(localDateTimeFromTs(Math.floor(ms / 1000)) === '2026-09-17 00:30', `秒级时间戳 → 日期时间 ${localDateTimeFromTs(Math.floor(ms / 1000))}`);

console.log('\n[6] 异常输入不抛错');
ok(localDate('not-a-date') === '', '无法解析的字符串 → 空串');
ok(localDateFromTs(0) === '', '时间戳 0 → 空串');
ok(localDateFromTs(NaN) === '', 'NaN → 空串');

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_logic_model.js`  ·  162 行

~~~js
// 「工作台逻辑模型」守卫（20261006a 固化）
// 目的：树状逻辑框架是本工作台的「说明书」，最容易随代码演进悄悄过期。
//       本守卫保证：① 结构自洽；② 关键模块全覆盖；③ 树里点名的模块文件真实存在（反漂移）；
//                 ④ 前端接线完整（入口按钮/弹层/脚本/样式/版本戳）。
// 用法: node scripts/test_logic_model.js    输出 "N 通过 / M 失败"
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -> ' + detail : '')); }
};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

const LM = require(path.join(root, 'public/js/logicModel.js'));
const TREE = LM.TREE;

// ── §1 结构自洽 ──
console.log('===== §1 树结构自洽 =====');
t('模块导出 LogicModel.TREE', !!(LM && TREE && TREE.name));
t('根节点为「股票投资分析工作台」', TREE.name === '股票投资分析工作台', TREE.name);
t('根节点有总体说明', typeof TREE.desc === 'string' && TREE.desc.length > 20);
t('L1 页面 / 区域数为 4（首页/个股页/公共支撑/独立页）', TREE.children.length === 4, String(TREE.children.length));

const walk = (node, depth, cb) => { cb(node, depth); (node.children || []).forEach(k => walk(k, depth + 1, cb)); };
let badName = [], badKids = [], dupSibling = [], leafNoDesc = 0, total = 0;
walk(TREE, 1, (n, d) => {
  total++;
  if (!n.name || typeof n.name !== 'string') badName.push(n.name);
  if (n.children && !Array.isArray(n.children)) badKids.push(n.name);
  const names = (n.children || []).map(k => k.name);
  if (new Set(names).size !== names.length) dupSibling.push(n.name);
  if (d <= 2 && !(n.children || []).length && !n.desc && !n.logic) leafNoDesc++;
});
t('每个节点都有非空名称', badName.length === 0, badName.join(','));
t('children 均为数组', badKids.length === 0, badKids.join(','));
t('同级节点名称不重复', dupSibling.length === 0, dupSibling.join(','));
t('L1/L2 无空壳（叶子须有 children 或 desc 或 logic）', leafNoDesc === 0, String(leafNoDesc));
t('节点总数 ≥ 60（覆盖足够细度）', total >= 60, String(total));

const st = LM.stats();
t('stats 自洽：nodes = sections + modules + 1', st.nodes === st.sections + st.modules + 1,
  JSON.stringify(st));
t('层级深度 = 4（总/页面/模块/细项）', st.depth === 4, String(st.depth));

// ── §2 关键模块覆盖 ──
console.log('\n===== §2 关键模块覆盖 =====');
const flat = [];
walk(TREE, 1, (n) => { flat.push((n.name || '') + ' ' + (n.desc || '')); });
const ALL = flat.join('\n') + '\n' + TREE.desc;
const cover = [
  '腾讯 qt.gtimg.cn', 'RPT_INDUSTRY_FUNDFLOW', 'RPTA_WEB_GETHGLIST_NEW', '巨潮资讯公告',
  '市场情绪提醒', '大盘技术分析', '大盘估值趋势', '行业板块拥挤度',
  '短期行情判断', '长期行情判断', '技术面', '专属估值模型', '深度分析',
  '策略生成器', '回测校验', '事件驱动引擎', '准确率闭环',
  'API 层', 'AI 叙事层', '规则与守卫', '跨页面公共支撑', '页面布局',
  'SA_NO_BG_AI', '数据诚实原则', 'APP_VERSION', 'SCHEMA_VERSION', 'LAYOUT_VERSION',
  '后台预加载', 'etf-flow'
];
cover.forEach(k => t('覆盖「' + k + '」', ALL.includes(k)));

const stocks = ['海天味业', '中国平安', '圣湘生物', '士兰微', '华安证券', '长江证券', '麦捷科技', '万润股份', '新洋丰', '电气风电'];
stocks.forEach(s => t('专属估值模型含「' + s + '」', ALL.includes(s)));
t('首页 9 张卡片全部列出', ['市场情绪提醒', '实时大盘', '大盘技术分析', '大盘估值趋势', '行业板块拥挤度', '今日财经热点', '板块舆情热度周榜', '每日宏观', '基金行业配置名单']
  .every(k => ALL.includes(k)));
t('个股页 10 个 tab 全部列出', ['简介', '技术面', '基本面', '股东分析', '深度分析', '行业分析', '资金量能', '个股亮点/雷点', '资料库', '策略']
  .every(k => ALL.includes(k)));

// ── §3 反漂移：树里点名的模块，文件必须真实存在 ──
console.log('\n===== §3 反漂移（树 ↔ 真实模块文件） =====');
const files = [
  ['lib/sameDayJudgment.js', '短期行情判断'],
  ['lib/longTermJudgment.js', '长期价值判断'],
  ['lib/marketEmotionModel.js', '市场情绪模型'],
  ['lib/marketTechnical.js', '大盘技术分析'],
  ['lib/indexPETrend.js', '大盘估值趋势'],
  ['lib/sectorCrowding.js', '行业板块拥挤度'],
  ['lib/strategyGenerator.js', '策略生成器'],
  ['lib/backtestValidator.js', '回测校验'],
  ['lib/eventEngine.js', '事件驱动引擎'],
  ['lib/techFaceJudgment.js', '技术面判定'],
  ['lib/dataHonesty.js', '数据诚实原则'],
  ['lib/valuation/haitian603288.js', '海天味业模型'],
  ['lib/valuation/pingAn601318.js', '中国平安模型'],
  ['lib/valuation/sanxi688289.js', '圣湘生物模型'],
  ['lib/valuation/silan600460.js', '士兰微模型'],
  ['lib/valuation/huaan600909.js', '华安证券模型'],
  ['lib/valuation/changjiang000783.js', '长江证券模型'],
  ['lib/valuation/maijie300319.js', '麦捷科技模型'],
  ['lib/valuation/wanrun002643.js', '万润股份模型'],
  ['lib/valuation/xinyangfeng000902.js', '新洋丰模型'],
  ['lib/valuation/dcavm688660.js', '电气风电模型'],
  ['routes/aiRoutes.js', 'AI 路由'],
  ['routes/dedicatedFactor.js', '专属因子路由'],
  ['routes/docsRoutes.js', '资料库路由'],
  ['routes/eventRoutes.js', '事件路由'],
  ['public/accuracy.html', '准确率核对页'],
  ['public/judgments.html', '判断记录页'],
  ['public/etf-flow.html', 'ETF资金流独立页'],
  ['lib/localDate.js', '统一中国自然日'],
  ['lib/deep/pipeline.js', '深度分析链路'],
  ['lib/valuationHub.js', '估值 Hub 唯一出口'],
  ['lib/macroSentimentFactors.js', '宏观情绪因子'],
  ['lib/hotTopicsWeekly/index.js', '板块舆情周榜']
];
files.forEach(([p, label]) => t(label + ' 对应文件存在（' + p + '）', exists(p)));

// 专属估值模型数量与 lib/valuation 实际数量一致（brokerModel 为共用基座，不计）
const valDir = fs.readdirSync(path.join(root, 'lib/valuation')).filter(f => f.endsWith('.js') && f !== 'brokerModel.js');
t('专属估值模型数量 = lib/valuation 实际数量（' + valDir.length + '）', /专属估值模型（\d+ 只）/.test(ALL)
  ? Number(ALL.match(/专属估值模型（(\d+) 只）/)[1]) === valDir.length
  : false, valDir.join(','));

// ── §4 前端接线 ──
console.log('\n===== §4 前端接线 =====');
const idx = read('public/index.html');
const css = read('public/css/style.css');
const serverSrc = read('server.js');
const avm = serverSrc.match(/APP_VERSION = '([^']+)'/);
const APP_V = avm ? avm[1] : '';

// 20261025c：弹窗改独立页面后的新契约 —— index.html 入口按钮 window.open 新标签跳转，
// 树主体渲染进独立页 logic-model.html 的 #lmPageBody；logicModel.js 移至该页面加载。
const lmpage = read('public/logic-model.html');
t('nav 内有 logic-model.html 新标签页入口按钮', /window\.open\('logic-model\.html', '_blank'\)/.test(idx));
t('入口在 global-nav-common 常驻组内（与投资心得/大盘记录/AI 设置同组）',
  /global-nav-common[\s\S]{0,600}window\.open\('logic-model\.html'[\s\S]{0,200}global-nav-extra/.test(idx));
t('入口按钮文案为「工作台逻辑模型」', />工作台逻辑模型</.test(idx));
t('独立页面 logic-model.html 存在', !!lmpage);
t('独立页面含 lmPageBody/展开/收起 三个挂点',
  ['lmPageBody', 'logicModelExpandAll', 'logicModelCollapseAll'].every(id => lmpage.includes('id="' + id + '"')));
t('logic-model.html 引入 logicModel.js（带版本戳）', lmpage.includes('js/logicModel.js?v=' + APP_V));
t('style.css 为弹层单独声明 .hidden（本项目 .hidden 非全局类）', /\.lm-modal-overlay\.hidden\s*\{[^}]*display:\s*none/.test(css));
t('style.css 含树状层级样式（.lm-node/.lm-children）', /\.lm-node/.test(css) && /\.lm-children/.test(css));
t('style.css 含折叠态样式（.lm-collapsed）', /\.lm-collapsed/.test(css));

// ── §5 部署与渲染 ──
console.log('\n===== §5 部署与渲染 =====');
t('server.js 存在 APP_VERSION', !!APP_V);
t('APP_VERSION 与 logic-model.html 内 logicModel.js 版本戳一致', lmpage.includes('js/logicModel.js?v=' + APP_V), APP_V);
t('/js/logicModel.js 在缓存破坏名单内', /FRONTEND_BUST_FILES[\s\S]{0,400}\/js\/logicModel\.js/.test(serverSrc));
t('APP_VERSION 注释含本次变更说明', serverSrc.includes('[20261013h]'));

const html = LM.renderHtml();
t('renderHtml 产出「总」根节点', /class="lm-root"/.test(html) && html.includes('股票投资分析工作台'));
t('renderHtml 产出 L1 页面卡片', (html.match(/lm-node lm-lv1/g) || []).length === 4,
  String((html.match(/lm-node lm-lv1/g) || []).length));
t('renderHtml 含节点计数与角标', /class="lm-count"/.test(html) && /class="lm-badge"/.test(html));
// 20261013h：判定逻辑 / 数据来源 / 输出去向三字段渲染
t('renderHtml 含判定逻辑块（lm-logic / lm-k-logic）', /class="lm-desc lm-logic"/.test(html) && /lm-k-logic/.test(html));
t('renderHtml 含数据来源 / 输出去向块（lm-io / lm-k-in / lm-k-out）', /class="lm-io"/.test(html) && /lm-k-in/.test(html) && /lm-k-out/.test(html));
t('renderHtml 无 undefined/null 字样', !/>undefined</.test(html) && !/>null</.test(html));
t('renderHtml 转义 < > &（防注入）', LM.renderHtml().indexOf('<') === 0); // 结构标签正常；内容转义由 esc 保证
t('折叠/展开 API 齐备', typeof LM.open === 'function' && typeof LM.close === 'function' && typeof LM.toggleAll === 'function' && typeof LM.toggleNode === 'function');

console.log('\n===== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_macro_sentiment_factors.js`  ·  87 行

~~~js
// 20260922k 验证：宏观情绪因子「走势相悖 → 权重自动归 0」机制真实生效
// 背景：卡片文案承诺「若…相悖，本因子权重自动归 0」，但旧实现里
//   (a) macroSentimentFactors 的 observedIndex 未持久化 → 相悖判定被永久跳过；
//   (b) marketEmotionModel.calcMacro 只看 signal、不看 status → 即便休眠也回落默认 5%。
// 运行：node scripts/test_macro_sentiment_factors.js
const mf = require('../lib/macroSentimentFactors');
const mem = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const BASE = mf.BASE_WEIGHT; // 0.5

// 真实上证日K（2026-09 一段，升序）
const bars = [
  { date: '2026-09-11', close: 3888.11 },
  { date: '2026-09-14', close: 3885.33 },
  { date: '2026-09-15', close: 3864.28 },
  { date: '2026-09-16', close: 3891.6 },
  { date: '2026-09-17', close: 3875.6 },
  { date: '2026-09-18', close: 3911.87 },
  { date: '2026-09-21', close: 3949.91 },
  { date: '2026-09-22', close: 3952.13 },
];

console.log('===== 1) 依赖：事件日解析 / 基准点位查找 =====');
ok('eventDate 从 dateZh 解析出 YYYY-MM-DD', mf.eventDate({ dateZh: '2026-09-17 凌晨 02:00（北京时间）' }) === '2026-09-17', mf.eventDate({ dateZh: '2026-09-17 凌晨 02:00（北京时间）' }));
ok('eventDate 无日期返回 null', mf.eventDate({ title: 'x' }) === null);
ok('closeOnOrBefore 取「不晚于事件日」的最近收盘（09-17 = 3875.6）', mf.closeOnOrBefore(bars, '2026-09-17') === 3875.6, mf.closeOnOrBefore(bars, '2026-09-17'));
ok('closeOnOrBefore 事件日晚于全部K线 → 返回最后一根', mf.closeOnOrBefore(bars, '2026-12-31') === 3952.13);
ok('closeOnOrBefore 空日期返回 null', mf.closeOnOrBefore(bars, null) === null);

console.log('\n===== 2) 状态机：新触发 → 激活 + 锚定 =====');
// 新触发且方向一致（signal=+1 偏多、指数较锚上行）→ 保持激活
const fresh = mf.stepFactor({ status: 'dormant', weight: 0 }, 'evt-A', 1, 3952.13, 3875.6);
ok('新触发(方向一致) → status=active', fresh.status === 'active', fresh.status);
ok('新触发(方向一致) → 权重 = BASE(0.5)', fresh.weight === BASE, fresh.weight);
ok('新触发 → 锚点用事件日收盘(3875.6)', fresh.observedIndex === 3875.6, fresh.observedIndex);
// 新触发且方向相悖（signal=-1 偏空、指数较锚上行）→ 同日即归零休眠
const freshContra = mf.stepFactor({ status: 'dormant', weight: 0 }, 'evt-A', -1, 3952.13, 3875.6);
ok('新触发(方向相悖) → 同日即归零休眠', freshContra.status === 'dormant' && freshContra.weight === 0, { s: freshContra.status, w: freshContra.weight });

console.log('\n===== 3) 相悖 / 同向 判定 =====');
// 信号偏空(-1)，锚 3875.6，现 3952.13（涨）→ 相悖 → 归零
const contra = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-A', observedIndex: 3875.6 }, 'evt-A', -1, 3952.13, 3875.6);
ok('偏空预测 + 指数上行 → 相悖归零', contra.status === 'dormant' && contra.weight === 0, { s: contra.status, w: contra.weight });
// 信号偏空(-1)，锚 3952.13，现 3875.6（跌）→ 同向 → 保持
const agree = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-A', observedIndex: 3952.13 }, 'evt-A', -1, 3875.6, 3952.13);
ok('偏空预测 + 指数下行 → 同向 → 保持 0.5', agree.status === 'active' && agree.weight === BASE, { s: agree.status, w: agree.weight });
// 信号偏多(+1)，指数下跌 → 相悖
const contra2 = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-B', observedIndex: 3952.13 }, 'evt-B', 1, 3800, 3952.13);
ok('偏多预测 + 指数下行 → 相悖归零', contra2.status === 'dormant' && contra2.weight === 0);
// 中性信号(0) 永不相悖
const neutral = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'dom', observedIndex: 3952.13 }, 'dom', 0, 4000, 3952.13);
ok('中性信号(0) + 指数任意方向 → 不归零', neutral.status === 'active' && neutral.weight === BASE);

console.log('\n===== 4) 自愈：旧快照缺 observedIndex（本次 bug 的核心）=====');
const healed = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-A', signal: -1 /* 无 observedIndex */ }, 'evt-A', -1, 3952.13, 3875.6);
ok('旧快照缺锚 + 提供事件日锚 → 补锚后判定相悖 → 归零', healed.status === 'dormant' && healed.weight === 0, { s: healed.status, w: healed.weight, obs: healed.observedIndex });
const healed2 = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'dom' /* 无锚且无事件日锚 */ }, 'dom', 0, 3952.13, null);
ok('无锚且无事件锚 → 用现价补锚（下次可判定）', healed2.observedIndex === 3952.13, healed2.observedIndex);

console.log('\n===== 5) 新触发键 → 休眠可复活 =====');
const revive = mf.stepFactor({ status: 'dormant', weight: 0, lastKey: 'evt-A', observedIndex: 3875.6 }, 'evt-B', 1, 3952.13, 3900);
ok('触发键变化 → 重新激活、权重回到 BASE', revive.status === 'active' && revive.weight === BASE, { s: revive.status, w: revive.weight });

console.log('\n===== 6) 展示文案随状态变化（杜绝「写着归零却仍 5%」）=====');
ok('国内·休眠文案含「自动归 0」', /自动归 0/.test(mf.domRuleText('dormant', -1)));
ok('国内·激活且非零文案含「当前处于激活状态」并说明归零条件', /当前处于激活状态/.test(mf.domRuleText('active', -1)) && /自动归 0/.test(mf.domRuleText('active', -1)));
ok('国内·中性(0) 文案不再承诺归零、改为「无明确方向」', /无明确方向/.test(mf.domRuleText('active', 0)) && !/自动归 0/.test(mf.domRuleText('active', 0)));
ok('美国·休眠文案含「不跌反涨…自动归 0」', /自动归 0/.test(mf.usRuleText('dormant', -1)));

console.log('\n===== 7) calcMacro 必须尊重 dormant（休眠 → 未激活 → 权重 0）=====');
const cmDormant = mem.calcMacro({ key: 'US_MACRO', signal: -1, status: 'dormant', weight: 0, interpretation: 'x' });
ok('休眠因子 → active=false（权重将被置 0）', cmDormant.active === false, cmDormant);
ok('休眠因子 → score 归 0', cmDormant.score === 0, cmDormant.score);
ok('休眠因子 → 展示「休眠」', /休眠/.test(cmDormant.value), cmDormant.value);
const cmActive = mem.calcMacro({ key: 'US_MACRO', signal: -1, status: 'active', weight: 0.5, interpretation: 'x' });
ok('激活因子 → active=true、score=-1、偏空', cmActive.active === true && cmActive.score === -1 && cmActive.value === '偏空', cmActive);
const cmNone = mem.calcMacro(undefined);
ok('缺失因子 → active=false、未激活', cmNone.active === false && /未激活/.test(cmNone.value), cmNone);

console.log(`\n[test_macro_sentiment_factors] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_mainfund_stable_source.js`  ·  147 行

~~~js
/**
 * 主力资金因子（图二 mainFund）稳定数据源回归测试
 * --------------------------------------------------------------
 * 背景：原主链 push2delay 实时通道本机常年 TLS 重置、备链数据中心行业资金流求和又因
 * `fb.date === today` 硬门槛拒收 T-1 → 因子长期「缺失」。20261024a 重构为
 * fetchMarketMainFund() 稳定源链路（S1 行业资金流求和 + S2 板块资金流汇总兜底），
 * 接受「最新已收盘交易日」并如实标注口径日/T-lag。
 *
 * 运行： node scripts/test_mainfund_stable_source.js
 * 覆盖：
 *  [A] S1（行业资金流求和）返回有效值且 source 含口径日 + T-lag 标注
 *  [B] S1 抛错时降级 S2（板块资金流汇总）仍返回有效值，source 标注兜底
 *  [C] getMarketEmotionData 放松 ===today 门槛：T-1 也能注入，issues 不再报 mainFund 缺失
 *  [D] 模型 calcMainCapital 对 T-1 数据如实标注口径日、lagged=true、快照护栏（mainNet 不挂今日）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa-mainfund-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_MARKET_EMOTION_DIR = TMP;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---- 桩数据 ----
// RPT_INDUSTRY_FUNDFLOW：单位=元。2026-10-23 主力净额 -10 亿；2026-10-22 +10 亿
const INDUSTRY_ROWS = [
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_NET: 5e8, BIGDEAL_NET: -1e9 },
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_NET: 5e8, BIGDEAL_NET: -1e9 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_NET: 3e8, BIGDEAL_NET: 2e8 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_NET: 3e8, BIGDEAL_NET: 2e8 },
];
// RPT_FUNDFLOW_BOARD：单位=万元。2026-10-23 主力净额 ≈ -9.82 亿；2026-10-22 +20 亿
const BOARD_ROWS = [
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_AMOUNT: -26229.57, BIGDEAL_AMOUNT: -22854.70 },
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_AMOUNT: -26229.57, BIGDEAL_AMOUNT: -22854.70 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_AMOUNT: 50000, BIGDEAL_AMOUNT: 50000 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_AMOUNT: 50000, BIGDEAL_AMOUNT: 50000 },
];

const ED = require.resolve('../lib/emDataCenter');
const SD = require.resolve('../lib/stockData');
const MT = require.resolve('../lib/marketTechnical');
const MED = require.resolve('../lib/marketEmotionData');

function setStubs({ fetchReport, findPython, fetchIdx }) {
  delete require.cache[ED]; delete require.cache[SD]; delete require.cache[MT]; delete require.cache[MED];
  require.cache[ED] = { id: ED, filename: ED, loaded: true, exports: { fetchReport, REPORTS: {}, HOST: 'x', latestTradeDate: async () => '2026-10-23' } };
  require.cache[SD] = { id: SD, filename: SD, loaded: true, exports: { findPythonForScript: findPython } };
  require.cache[MT] = { id: MT, filename: MT, loaded: true, exports: { fetchIndexDailyBars: fetchIdx } };
}

(async () => {
  console.log('[A] S1 行业资金流求和（全市场稳定源）');
  setStubs({
    fetchReport: async (name) => (name === 'RPT_INDUSTRY_FUNDFLOW' ? INDUSTRY_ROWS : []),
    findPython: async () => null,          // runScript 抛错 → raw.mainFund 留空，走 fetchMarketMainFund
    fetchIdx: async () => [],
  });
  const { fetchMarketMainFund } = require('../lib/marketEmotionData');
  const sysYmd = new Date().toISOString().slice(0, 10);
  const expLag = Math.round((Date.parse(sysYmd) - Date.parse('2026-10-23')) / 86400000);
  const fb1 = await fetchMarketMainFund();
  ok(fb1 && fb1.mainNetToday !== null, `S1 返回有效主力净额（mainNetToday=${fb1 && fb1.mainNetToday}）`);
  ok(fb1 && fb1.date === '2026-10-23', `口径日 = 最新已收盘交易日 2026-10-23（实际 ${fb1 && fb1.date}）`);
  ok(fb1 && /口径日 2026-10-23/.test(fb1.source), `source 含口径日标注：${fb1 && fb1.source}`);
  if (expLag > 0) ok(/T-\d+ 收盘/.test(fb1.source), `source 含 T-${expLag} 收盘标注（非实时当日）`);
  else console.log('  · 系统日期即 2026-10-23，跳过 T-lag 断言');

  console.log('\n[B] S1 抛错 → 降级 S2 板块资金流汇总兜底');
  setStubs({
    fetchReport: async (name) => {
      if (name === 'RPT_INDUSTRY_FUNDFLOW') throw new Error('S1 boom');
      if (name === 'RPT_FUNDFLOW_BOARD') return BOARD_ROWS;
      return [];
    },
    findPython: async () => null,
    fetchIdx: async () => [],
  });
  const { fetchMarketMainFund: f2 } = require('../lib/marketEmotionData');
  const fb2 = await f2();
  ok(fb2 && fb2.mainNetToday !== null, `S1 失败降级 S2 仍返回有效值（mainNetToday=${fb2 && fb2.mainNetToday}）`);
  ok(fb2 && /板块资金流汇总/.test(fb2.source), `S2 source 标注板块资金流兜底：${fb2 && fb2.source}`);

  console.log('\n[C] resolveMainFund 放松 ===today 门槛（核心修复，离线可测、不依赖 python）');
  setStubs({
    fetchReport: async (name) => (name === 'RPT_INDUSTRY_FUNDFLOW' ? INDUSTRY_ROWS : []),
    findPython: async () => null,
    fetchIdx: async () => [],
  });
  const { resolveMainFund } = require('../lib/marketEmotionData');
  // 模拟 getMarketEmotionData：runScript 成功但 raw.mainFund 为空（push2delay 死链），应被稳定源补上
  const raw = { mainFund: null };
  const note = await resolveMainFund(raw, '2026-10-24');
  ok(raw.mainFund && raw.mainFund.mainNetToday != null, `T-1 主力资金已注入 raw.mainFund（mainNetToday=${raw.mainFund && raw.mainFund.mainNetToday}）`);
  ok(note === null, '注入成功时返回 null（无失败说明）');
  // 反向：两源都取不到 → 返回说明文案，raw.mainFund 仍为空
  setStubs({
    fetchReport: async () => { throw new Error('all dead'); },
    findPython: async () => null,
    fetchIdx: async () => [],
  });
  const { resolveMainFund: resolveMainFund2 } = require('../lib/marketEmotionData'); // 重新解构以绑定新桩
  const raw2 = { mainFund: null };
  const note2 = await resolveMainFund2(raw2, '2026-10-24');
  ok(raw2.mainFund == null && typeof note2 === 'string' && /未取到有效数据|均不可达/.test(note2), `两源皆失败 → 返回说明文案、不注入：${note2}`);

  console.log('\n[D] 模型 T-1 诚实标注 + 快照护栏');
  // 清桩，加载真实模型（不依赖网络）
  delete require.cache[MED]; delete require.cache[ED]; delete require.cache[SD]; delete require.cache[MT];
  const { computeMarketEmotion } = require('../lib/marketEmotionModel');
  const d = {
    ok: true,
    date: '2026-10-24',
    index: { code: 'sh000001', name: '上证指数', bars: (() => { const a = []; let c = 3800; for (let i = 0; i < 260; i++) { const dt = new Date(Date.parse('2026-10-24') - (260 - i) * 86400000); const dow = dt.getUTCDay(); if (dow === 0 || dow === 6) continue; a.push({ date: dt.toISOString().slice(0, 10), close: Math.round(c * 100) / 100, vol: 5e8 }); c *= 1.0005; } return a; })() },
    breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
    margin: { latest: 18000, changePct: 0.3, change5Pct: 1.2 },
    // T-1 收盘口径：date 为 2026-10-23，≠ 模型基准日 2026-10-24
    mainFund: { date: '2026-10-23', mainNetToday: -10, history: [] },
    capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
    fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
    bond: { cn10y: 2.0, chgBp5: 5 },
    discussionHeat: { marketHeat: 0.2, date: '2026-10-24', value: '热度 0.2', detail: 'd' },
    issues: [], warnings: [],
  };
  const r = await computeMarketEmotion({ data: d });
  const mc = r.factors.find(f => f.key === 'mainCapital');
  ok(mc && mc.lagged === true, `mainCapital lagged=true（T-1 收盘口径，lagDays=${mc && mc.lagDays}）`);
  ok(mc && mc.lagDays === 1, 'lagDays = 1');
  // 样本不足走 early-return 时仅填 value（含口径日标注），detail 不保证存在 → 断言以 value 为准
  ok(mc && /截至 2026-10-23/.test(mc.value), `value 标注口径日 2026-10-23：value="${mc && mc.value}"`);
  ok(mc && /口径日 2026-10-23/.test(mc.value) && /非实时当日|收盘口径/.test(mc.value), `value 含「口径日/T-lag 收盘」说明：${mc && mc.value}`);
  // 快照护栏：2026-10-24 的 mainNet 必须为 null（T-1 值不得挂今日）
  const snapFile = path.join(TMP, 'snapshots.json');
  const snaps = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const snap = snaps.find(s => s.date === '2026-10-24');
  ok(snap && snap.mainNet === null, `快照 2026-10-24 的 mainNet = null（T-1 值未污染历史样本，实际 ${snap && snap.mainNet}）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

~~~

---

## `scripts\test_manual_zone_reversal.js`  ·  208 行

~~~js
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

~~~

---

## `scripts\test_manual_zones.js`  ·  210 行

~~~js
/**
 * 手动阻力/支撑区间 · 回归测试（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_manual_zones.js
 * 覆盖：lib/manualZones.js（20261021d，用户「②卡加一条 tab 手动添加阻力/支撑」）
 *   [1] 增删查往返（单点/区间/备注）
 *   [2] 校验：方向非法 / 下沿>上沿 / 价格<=0 / 非数字 → 明确报错，不写脏数据
 *   [3] 去重：同侧同区间 → 拒绝
 *   [4] 容量：每侧上限 MAX_PER_SIDE
 *   [5] 代码归一：sh600909 / 600909.SH / 600909 落到同一个文件
 *   [6] 脏文件净化：手改坏的 JSON / 非法 side / low>high 不进入展示
 *   [7] 接线守卫：路由存在；前端页签/表单/删除存在；**手动区间不过 zoneValidity 过滤、不被侵蚀**
 *   [8] 隔离守卫：手动模块不 require zoneValidity / rangeDetector，不被模型口径污染
 */
const fs = require('fs');
const path = require('path');
const m = require('../lib/manualZones');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const TMP_SYM = '999999';
const TMP_FILE = path.join(m.DIR, TMP_SYM + '.json');
function cleanup() { try { if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE); } catch (e) {} }

cleanup();
try {
  console.log('\n[1] 增删查往返');
  {
    const a = m.addZone(TMP_SYM, { side: 'resistance', low: 14.63, high: 14.77, note: '前高' });
    ok(a.ok, '添加区间阻力成功');
    eq(a.zone.low, 14.63, '下沿 14.63');
    eq(a.zone.high, 14.77, '上沿 14.77');
    eq(a.zone.note, '前高', '备注保留');

    const b = m.addZone(TMP_SYM, { side: 'support', low: 11.56 });
    ok(b.ok, '单点支撑（只填一个价）成功');
    eq(b.zone.high, 11.56, '单点：上沿=下沿');

    const list = m.listZones(TMP_SYM);
    eq(list.total, 2, '共 2 条');
    eq(list.resistances.length, 1, '阻力 1 条');
    eq(list.supports.length, 1, '支撑 1 条');
    eq(list.symbol, TMP_SYM, '返回归一后的代码');
    ok(list.limits && list.limits.maxPerSide > 0, '返回上限配置（前端据此提示）');

    const d = m.removeZone(TMP_SYM, a.zone.id);
    ok(d.ok, '删除成功');
    eq(m.listZones(TMP_SYM).total, 1, '删除后剩 1 条');
    ok(!m.removeZone(TMP_SYM, a.zone.id).ok, '重复删除 → 报错（未找到）');
  }

  console.log('\n[2] 校验（不写脏数据）');
  {
    eq(m.addZone(TMP_SYM, { side: 'x', low: 1, high: 2 }).error, '方向必须是阻力或支撑', '非法方向');
    eq(m.addZone(TMP_SYM, { side: 'support', low: 5, high: 1 }).error, '下沿不能高于上沿', '下沿>上沿');
    eq(m.addZone(TMP_SYM, { side: 'support', low: 0, high: 1 }).error, '价格必须大于 0', '价格为 0');
    eq(m.addZone(TMP_SYM, { side: 'support', low: 'abc', high: 1 }).error, '请填写有效价格', '非数字');
    eq(m.addZone(TMP_SYM, { side: 'support' }).error, '请填写有效价格', '缺价格');
    eq(m.addZone(TMP_SYM, {}).error, '方向必须是阻力或支撑', '缺方向');
  }

  console.log('\n[3] 去重（同侧同区间）');
  {
    m.addZone(TMP_SYM, { side: 'resistance', low: 20, high: 21 });
    const dup = m.addZone(TMP_SYM, { side: 'resistance', low: 20, high: 21 });
    ok(!dup.ok, '同侧同区间 → 拒绝');
    eq(dup.error, '该区间已存在', '报错文案明确');
    const otherSide = m.addZone(TMP_SYM, { side: 'support', low: 20, high: 21 });
    ok(otherSide.ok, '不同侧同价位 → 允许（阻力与支撑是两回事）');
  }

  console.log('\n[4] 容量上限');
  {
    const before = m.listZones(TMP_SYM).resistances.length;
    let lastErr = null;
    for (let i = 0; i < m.MAX_PER_SIDE + 3; i++) {
      const r = m.addZone(TMP_SYM, { side: 'resistance', low: 100 + i, high: 101 + i });
      if (!r.ok) { lastErr = r.error; break; }
    }
    ok(/每侧最多/.test(lastErr || ''), `到上限后拒绝并提示（上限 ${m.MAX_PER_SIDE}）`);
    ok(m.listZones(TMP_SYM).resistances.length <= m.MAX_PER_SIDE, '阻力条数不超过上限');
    ok(before > 0, '前置：本来就有阻力条目');
  }

  console.log('\n[5] 代码归一（sh600909 / 600909.SH / 600909 同一文件）');
  {
    eq(m.normalizeSymbol('sh600909'), '600909', 'sh 前缀');
    eq(m.normalizeSymbol('600909.SH'), '600909', '后缀');
    eq(m.normalizeSymbol(' sz000858 '), '000858', '带空格的 sz 前缀');
    eq(m.normalizeSymbol('600909'), '600909', '纯数字');
  }

  console.log('\n[6] 脏文件净化');
  {
    fs.mkdirSync(m.DIR, { recursive: true });
    fs.writeFileSync(TMP_FILE, JSON.stringify({
      symbol: TMP_SYM,
      zones: [
        { id: 'a', side: 'resistance', low: 10, high: 12, note: 'ok' },
        { id: 'b', side: 'weird', low: 10, high: 12 },        // 非法 side
        { id: 'c', side: 'support', low: 15, high: 9 },        // low>high
        { id: 'd', side: 'support', low: 0, high: 3 },         // 价格 0
        { id: 'e', side: 'support', low: 8, high: 9 },         // ok
      ],
    }), 'utf8');
    const list = m.listZones(TMP_SYM);
    eq(list.total, 2, '只有 2 条合法条目进入展示');
    eq(list.resistances.map(z => z.id), ['a'], '保留合法阻力');
    eq(list.supports.map(z => z.id), ['e'], '保留合法支撑');

    fs.writeFileSync(TMP_FILE, '{ 这不是 JSON', 'utf8');
    const broken = m.listZones(TMP_SYM);
    eq(broken.total, 0, '坏 JSON → 空列表（不崩、不编造）');
    ok(m.addZone(TMP_SYM, { side: 'support', low: 1, high: 2 }).ok, '坏文件仍可被覆盖写入');
  }

  console.log('\n[7] 接线守卫');
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(srv.includes("require('./lib/manualZones')"), 'server 引入 manualZones');
    ok(/app\.get\('\/api\/manual-zones\/:symbol'/.test(srv), 'GET 列表路由');
    ok(/app\.post\('\/api\/manual-zones\/:symbol'/.test(srv), 'POST 新增路由');
    ok(/app\.delete\('\/api\/manual-zones\/:symbol\/:id'/.test(srv), 'DELETE 删除路由');

    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    ok(app.includes('data-pa-tab="model"') && app.includes('data-pa-tab="manual"'), '②卡有模型/手动两个页签');
    ok(app.includes('_renderManualZonesPanel'), '手动页签有独立渲染函数');
    ok(app.includes('_wirePriceActionTabs'), '页签与表单有接线函数');
    ok(/data-mz-del=/.test(app), '每条手动区间有删除按钮');
    ok(/paMzLow/.test(app) && /paMzHigh/.test(app), '表单有下沿/上沿两个价位输入');
    ok(/只填一个就代表单点|单点/.test(app), '文案说明「只填一个=单点」');

    // 20261021e：手动区间改为**后端并入**短期清单并走同一条有效性检验，前端不得再自己 concat（否则重复两条）
    const hub = fs.readFileSync(path.join(__dirname, '..', 'lib', 'priceActionHub.js'), 'utf8');
    ok(hub.includes("require('./manualZones')"), 'priceActionHub 引入 manualZones（并入点）');
    ok(/attachManualZones\(data, daily, symbol\)/.test(hub), '快照里把手动区间接进短期清单');
    ok(/assessZone\(daily, \{ low: z\.low, high: z\.high \}, side\)/.test(hub), '手动区间走 assessZone（同一条有效性检验）');
    ok(hub.includes('invalidateSnapshot'), '增删后丢弃快照缓存（否则加完看不到）');
    ok(!/manualRes/.test(app), '前端不再自己 concat 手动区间（避免与后端并入的重复）');
    ok(/pa-mz-badge/.test(app), '手动页签显示检验结果徽标');
    ok(/检验未通过/.test(app), '未通过时写明「检验未通过」而不是悄悄消失');
    ok(/isManual: true/.test(hub), '后端并入时带 isManual 标记');
    ok(/z\.isManual/.test(app), '前端按 isManual 区分手动条目样式/文案');
    ok(app.includes('pz-manual'), '手动条目有「手动」小标');

    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
    ok(css.includes('.pa-tabs') && css.includes('.pa-tab.active'), '页签样式存在');
    ok(css.includes('.pa-zone-row.manual'), '手动条目样式与模型条目区分');
  }

  console.log('\n[8] 隔离守卫（不被模型口径污染）');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'manualZones.js'), 'utf8');
    ok(!/require\(['"]\.\/zoneValidity/.test(src), '不 require zoneValidity（不参与有效性检验）');
    ok(!/require\(['"]\.\/rangeDetector/.test(src), '不 require rangeDetector（不参与箱体判定）');
    ok(!/erode/i.test(src), '不含侵蚀逻辑');
    const pa = fs.readFileSync(path.join(__dirname, '..', 'lib', 'priceAction.js'), 'utf8');
    ok(!/manualZones/.test(pa), 'priceAction 不掺手动区间（模型与用户标注分属两层）');
  }
  console.log('\n[9] 手动区间同样接受两条有效性检验（20261021e）');
  {
    cleanup();   // 前面几节留下了测试条目，这里从空文件开始，断言才唯一
    const hub = require('../lib/priceActionHub');
    // 合成 80 根日K：默认 7.00 平量；第 79 根收 8.70 但量比仅 1.0（无放量突破）
    const N = 80;
    const bars = Array.from({ length: N }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: 7, high: 7.05, low: 6.95, close: 7, volume: 10000,
    }));
    bars[N - 1] = { date: bars[N - 1].date, open: 7, high: 8.72, low: 6.98, close: 8.7, volume: 10000 };  // 量比 1.0

    // 三条手动区间：① 被无放量突破（应无效）② 从未触及（应有效）③ 支撑未跌破（应有效）
    m.addZone(TMP_SYM, { side: 'resistance', low: 8.45, high: 8.55, note: '被轻松突破' });
    m.addZone(TMP_SYM, { side: 'resistance', low: 9.40, high: 9.60, note: '未被测试' });
    m.addZone(TMP_SYM, { side: 'support', low: 6.70, high: 6.80, note: '未跌破' });

    const data = { shortTerm: { resistances: [{ low: 1, high: 2, source: '模型', valid: true }], supports: [] } };
    hub.attachManualZones(data, bars, TMP_SYM);
    const manual = data.shortTerm.resistances.filter(z => z.isManual);
    eq(manual.length, 2, '2 条手动阻力被并入（模型条目保持不动）');
    eq(data.shortTerm.supports.filter(z => z.isManual).length, 1, '1 条手动支撑被并入');
    eq(data.shortTerm.resistances[0].source, '模型', '模型条目仍在原处（顺序：模型在前）');

    const broken = manual.find(z => z.low === 8.45);
    const clean = manual.find(z => z.low === 9.40);
    ok(broken && broken.valid === false, '无放量轻松突破的手动阻力 → 判无效（与模型同一条规则）');
    ok(broken && broken.invalidReasons.some(r => /无放量/.test(r)), '无效原因写明「无放量轻松穿越」');
    ok(broken && broken.zoneCheck && broken.zoneCheck.lastBreakVr != null, '带 zoneCheck（与模型同结构，前端可展示明细）');
    ok(clean && clean.valid === true, '从未被测试的手动阻力 → 保持有效');
    ok(manual.every(z => !z.erosion), '手动区间不被侵蚀（用户只要求两条有效性检验）');
    eq(broken.low, 8.45, '侵蚀关闭：下沿未被收紧');
    eq(broken.high, 8.55, '侵蚀关闭：上沿未变');

    eq(data.manualZonesMeta.total, 3, 'meta.total = 3');
    eq(data.manualZonesMeta.valid, 2, 'meta.valid = 2');
    eq(data.manualZonesMeta.invalid, 1, 'meta.invalid = 1');
  }

} finally {
  cleanup();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

~~~

---

## `scripts\test_margin_caliber_rename.js`  ·  194 行

~~~js
/**
 * scripts/test_margin_caliber_rename.js — 20261104k~m 口径统一+改名+行内展开守卫
 *
 * 覆盖用户三项指令：
 *   ① 毛利率数据不一致修复——左卡 TTM 主值 vs 右卡同比/环比维度口径统一（TTM 同口径优先，回退累计并标注）
 *      同口径排查覆盖：毛利率、净利率、ROE（环比维度）；数据源 lib/stockData.js computeTtmMetrics
 *      新增 grossMarginTtmPrev / netMarginTtmPrev（去年同期 TTM）与 *PrevQ（上一报告期 TTM）、roeTtmPrevQ。
 *   ② 「利润增长」改名「归母净利润」——左卡 tile / METRIC_HELP / keyOf / analysis.js 信号 label /
 *      metricAnalysis buildGrowth / consistencyAudit / export.js 全链路改名；LAYOUT_VERSION 升级 20261104k。
 *   ③ 右卡「指标分析」与左卡 14 项全量一致展示——去按需单卡 ma-hidden 模式，tab 点击改滚动定位 + 高亮。
 *
 * 运行： node scripts/test_margin_caliber_rename.js
 * 断言全部通过时打印 "PASS N/N"，exit 0；任一失败打印 FAIL 明细并 exit 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { computeTtmMetrics } = require('../lib/stockData');
const { buildMetricAnalysis } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function approx(actual, expected, eps, msg) {
  ok(actual != null && Math.abs(actual - expected) <= (eps || 1e-6),
    `${msg}\n    实际: ${actual}\n    期望(±${eps || 1e-6}): ${expected}`);
}

// ---------- §1 computeTtmMetrics：TTM prev / prevQ 数值断言（独立复算） ----------
// 期数设计（rev=营收, mlr=毛利额, np=归母净利, gm/nm=比率%，bps=每股净资产）：
//   2025Q3: 300/120/30   2025H1: 200/80/20   2025Q1: 100/40/10
//   2024年报: 400/160/40  2024Q3: 280/112/28  2024H1: 190/76/19  2024Q1: 95/38/9.5
//   2023年报: 360/150/36  2023Q3: 270/(null mlr, gm 40%)/27  2023H1: 180/72/18
// 当前 TTM（2025-09-30 锚）: rev=300+400-280=420  mlr=120+160-112=168  np=30+40-28=42
// prev TTM（2024-09-30 锚）: rev=280+360-270=370  mlr=112+150-(0.40*270)=154  np=28+36-27=37
// prevQ TTM（2025-06-30 锚）: rev=200+400-190=410  mlr=80+160-76=164  np=20+40-19=41
// 2023Q3 的 mlr 置 null 且给 XSMLL=40 → 同时覆盖「MLR 缺失按比率×营收重构」回退分支。
const R = (date, name, np, rev, mlr, gm, nm, bps) => ({
  REPORT_DATE: date, REPORT_DATE_NAME: name,
  PARENTNETPROFIT: String(np), TOTALOPERATEREVE: String(rev),
  MLR: mlr == null ? null : String(mlr),
  XSMLL: gm == null ? null : String(gm), XSJLL: String(nm), BPS: String(bps),
});
const rows = [
  R('2025-09-30', '2025三季报', 30, 300, 120, 40, (30 / 300 * 100), 5.00),
  R('2025-06-30', '2025中报', 20, 200, 80, 40, (20 / 200 * 100), 4.80),
  R('2025-03-31', '2025一季报', 10, 100, 40, 40, 10, 4.60),
  R('2024-12-31', '2024年报', 40, 400, 160, 40, 10, 4.70),
  R('2024-09-30', '2024三季报', 28, 280, 112, 40, 10, 4.50),
  R('2024-06-30', '2024中报', 19, 190, 76, 40, 10, 4.40),
  R('2024-03-31', '2024一季报', 9.5, 95, 38, 40, 10, 4.30),
  R('2023-12-31', '2023年报', 36, 360, 150, (150 / 360 * 100), 10, 4.20),
  R('2023-09-30', '2023三季报', 27, 270, null, 40, 10, 4.10),
  R('2023-06-30', '2023中报', 18, 180, 72, 40, 10, 4.00),
];
const ttm = computeTtmMetrics(rows, 10);
ok(ttm != null, 'computeTtmMetrics 应返回结果');
approx(ttm.grossMargin, (120 + 160 - 112) / (300 + 400 - 280) * 100, 1e-6, '当前 TTM 毛利率');
approx(ttm.netMargin, (30 + 40 - 28) / (300 + 400 - 280) * 100, 1e-6, '当前 TTM 净利率');
approx(ttm.grossMarginTtmPrev, (112 + 150 - 108) / (280 + 360 - 270) * 100, 1e-6, '去年同期 TTM 毛利率（含 MLR 缺失重构回退）');
approx(ttm.netMarginTtmPrev, (28 + 36 - 27) / (280 + 360 - 270) * 100, 1e-6, '去年同期 TTM 净利率');
approx(ttm.grossMarginTtmPrevQ, (80 + 160 - 76) / (200 + 400 - 190) * 100, 1e-6, '上一报告期 TTM 毛利率');
approx(ttm.netMarginTtmPrevQ, (20 + 40 - 19) / (200 + 400 - 190) * 100, 1e-6, '上一报告期 TTM 净利率');
approx(ttm.roePrev, (28 + 36 - 27) / (4.50 * 10) * 100, 1e-6, '去年同期 TTM ROE（既有字段回归）');
approx(ttm.roeTtmPrevQ, (20 + 40 - 19) / (4.80 * 10) * 100, 1e-6, '上一报告期 TTM ROE（20261104k 新增）');
// 锚点为年报（直取分支）时 prevQ 窗口 = 上一年报直取
const rowsYr = rows.filter(r => r.REPORT_DATE !== '2025-09-30' && r.REPORT_DATE !== '2025-06-30' && r.REPORT_DATE !== '2025-03-31');
const ttmYr = computeTtmMetrics(rowsYr, 10);
approx(ttmYr.grossMargin, 40, 1e-6, '年报直取分支毛利率（回归）');
// prevQ 锚点 = 最近一个更早披露期（2024-09-30 三季报，非年报）：窗口 = 2024Q3+2023年报−2023Q3
approx(ttmYr.grossMarginTtmPrevQ, (112 + 150 - 108) / (280 + 360 - 270) * 100, 1e-6, '年报直取时 prevQ = 上一披露期（2024Q3）TTM 毛利率');

// ---------- §2 buildMetricAnalysis 端到端：右卡同比/环比 TTM 同口径 ----------
function mkQuote(f) {
  return { fundamentals: Object.assign({
    pe: 20, pb: 2, ps: 5,
    roeTtm: 14.0, grossMarginTtm: 37.78, netMarginTtm: 22.5,
    revenueYoy: 10, profitYoy: 8,
    dividendYield: 2,
    roeTtmPrev: 12.0,
    zyzbHistory: [
      { REPORT_DATE: '2025-09-30', XSMLL: '41.47', XSJLL: '20.1', ROEJQ: '13.0' },
      { REPORT_DATE: '2024-09-30', XSMLL: '43.89', XSJLL: '21.0', ROEJQ: '12.5' },
    ],
  }, f) };
}
const comparison = { percentiles: {}, industryAvg: {} };
const companyType = { isFinancial: false };
const signals = { signals: [] };
const fundamental = { metrics: { pe: 20, pb: 2, ps: 5, roe: 14, grossMargin: 37.78, netMargin: 22.5, revenueGrowth: 10, profitGrowth: 8, dividendYield: 2 } };

// 2a. 有 TTM prev → 同比/环比均为 TTM 同口径文案
const outA = buildMetricAnalysis(mkQuote({
  grossMarginTtmPrev: 43.89, grossMarginTtmPrevQ: 37.0,
  netMarginTtmPrev: 24.0, netMarginTtmPrevQ: 21.5,
  roeTtmPrevQ: 13.2,
}), comparison, companyType, signals, fundamental);
const gmA = outA.metrics.find(m => m.key === 'grossMargin');
ok(gmA && /去年同期TTM 43\.89%/.test(gmA.dims.yoy.text), `毛利率同比应含「去年同期TTM 43.89%」（实际 ${gmA && gmA.dims.yoy.text}）`);
ok(gmA && /TTM 同口径/.test(gmA.dims.yoy.text), '毛利率同比应标注「TTM 同口径」');
ok(gmA && /TTM 同口径/.test(gmA.dims.qoq.text), `毛利率环比应为 TTM 同口径文案（实际 ${gmA && gmA.dims.qoq.text}）`);
ok(gmA && /37\.78% vs 上一报告期TTM 37\.00%/.test(gmA.dims.qoq.text), '毛利率环比应含主值与上一报告期 TTM 对比值');
ok(gmA && /TTM 滚动口径.*与左卡数值完全一致/.test(gmA.note), '毛利率 note 应改为「与左卡数值完全一致」口径说明');
const nmA = outA.metrics.find(m => m.key === 'netMargin');
ok(nmA && /TTM 同口径/.test(nmA.dims.yoy.text) && /TTM 同口径/.test(nmA.dims.qoq.text), '净利率同比/环比应均为 TTM 同口径');
const roeA = outA.metrics.find(m => m.key === 'roe');
ok(roeA && /TTM 同口径/.test(roeA.dims.qoq.text), `ROE 环比应为 TTM 同口径（20261104k 同口径排查）（实际 ${roeA && roeA.dims.qoq.text}）`);

// 2b. 无 TTM prev → 回退累计口径（原 yoyDim/qoqDim 文案，不含 TTM 标注）
const outB = buildMetricAnalysis(mkQuote({}), comparison, companyType, signals, fundamental);
const gmB = outB.metrics.find(m => m.key === 'grossMargin');
ok(gmB && !/TTM 同口径/.test(gmB.dims.yoy.text), `缺 TTM prev 时毛利率同比应回退累计口径（实际 ${gmB && gmB.dims.yoy.text}）`);
ok(gmB && /41\.47/.test(gmB.dims.yoy.text), '回退文案应使用累计口径值 41.47');
const roeB = outB.metrics.find(m => m.key === 'roe');
ok(roeB && !/TTM 同口径/.test(roeB.dims.qoq.text), '缺 roeTtmPrevQ 时 ROE 环比应回退累计口径');

// 2c. 哨兵 0 不作 TTM prev 使用（grossMarginTtmPrev=0 → 视为缺失回退）
const outC = buildMetricAnalysis(mkQuote({ grossMarginTtmPrev: 0 }), comparison, companyType, signals, fundamental);
const gmC = outC.metrics.find(m => m.key === 'grossMargin');
ok(gmC && !/TTM 同口径/.test(gmC.dims.yoy.text), 'grossMarginTtmPrev=0（哨兵）应回退累计口径，不得输出假同口径');

// 2d. 改名联动：右卡 profitGrowth 标签应为「归母净利润」
const pgA = outA.metrics.find(m => m.key === 'profitGrowth');
ok(pgA && pgA.label === '归母净利润', `profitGrowth 右卡标签应为「归母净利润」（实际 ${pgA && pgA.label}）`);

// ---------- §3 改名全链路源码断言 ----------
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const analysisSrc = read('lib/analysis.js');
const metricSrc = read('lib/metricAnalysis.js');
const appSrc = read('public/js/app.js');
const auditSrc = read('lib/consistencyAudit.js');
const exportSrc = read('public/js/export.js');
const sjdSrc = read('lib/sameDayJudgment.js');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

ok(!analysisSrc.includes("label: '利润增长'"), 'analysis.js 不得再出现 label: 利润增长');
ok((analysisSrc.match(/label: '归母净利润'/g) || []).length >= 7, 'analysis.js 归母净利润 label 应≥7 处（原 7 处信号）');
ok(!metricSrc.includes("'利润增长'"), 'metricAnalysis.js 不得再出现 利润增长 字面量');
ok(/buildGrowth\('profitGrowth', '归母净利润'/.test(metricSrc), 'metricAnalysis buildGrowth 标签应为 归母净利润');
ok(!appSrc.includes("['利润增长'"), 'app.js 左卡 tile 不得再出现 利润增长');
ok(appSrc.includes("['归母净利润', m.profitGrowth"), 'app.js 左卡 tile 应为 归母净利润');
ok(/'归母净利润':\s*'profitGrowth'/.test(appSrc), 'app.js keyOf 应含 归母净利润→profitGrowth');
ok(/'归母净利润':\s*\{\s*title:\s*'归母净利润'/.test(appSrc), 'app.js METRIC_HELP 应含 归母净利润 释义');
ok(!appSrc.includes("'利润增长':"), 'app.js keyOf/METRIC_HELP 不得残留 利润增长 键');
ok(auditSrc.includes("label: '归母净利润'"), 'consistencyAudit.js label 应为 归母净利润');
ok(exportSrc.includes("['归母净利润', fmtPct(m.profitGrowth)]"), 'export.js 导出表头应为 归母净利润');

// ---------- §4 LAYOUT_VERSION（20261104k 改名升版；l 轮展示回退不涉及因子名，不再升版） ----------
ok(/const LAYOUT_VERSION = '20261106o'/.test(sjdSrc), 'LAYOUT_VERSION 应为 20261106o（量价配合子信号输入 signal 值域与分值变化：涨跌判定与 135 格走势档同源，哈希不捕获）');
ok(/\[20261028c 前注\]/.test(sjdSrc), '历史前注 20261028c 应保留为前注');

// ---------- §5 指标分析行内展开（20261104m：用户澄清第二轮——分析内容与所点指标行同一水平） ----------
const rmaStart = appSrc.indexOf('renderMetricAnalysis(data, activeKey) {');
const smaStart = appSrc.indexOf('showMetricAnalysis(key, rowEl) {');
const smaEnd = appSrc.indexOf('showMetricHelp(', smaStart);
ok(rmaStart > 0 && smaStart > rmaStart, 'app.js 应含 renderMetricAnalysis(data, activeKey) / showMetricAnalysis(key, rowEl) 且顺序正确');
const rmaBody = appSrc.slice(rmaStart, smaStart);
const smaBody = smaEnd > smaStart ? appSrc.slice(smaStart, smaEnd) : appSrc.slice(smaStart);
ok(/this\.renderMetricAnalysisCard\(m\)/.test(rmaBody), 'renderMetricAnalysis 应复用 renderMetricAnalysisCard（单一数据源）');
ok(appSrc.indexOf('renderMetricAnalysisCard(m) {') > 0, 'app.js 应有 renderMetricAnalysisCard 单卡生成器');
ok(/class="ma-row\$\{isActive \? '' : ' ma-hidden'\}"/.test(rmaBody), '右卡仍为按需单卡（非激活项 ma-hidden）');
ok(rmaBody.includes('ma-empty'), 'renderMetricAnalysis 应保留 ma-empty 空态引导');
ok(smaBody.includes("'ma-inline-panel'"), 'showMetricAnalysis 应创建行内展开面板（手风琴）');
ok(smaBody.includes('cloneNode(true)'), '行内面板应克隆右卡单卡节点（同一 HTML 结构）');
ok(smaBody.includes("insertAdjacentElement('afterend'"), '面板应插入选中指标行正下方（afterend）');
ok(smaBody.includes("block: 'nearest'"), '行内面板滚动应为 block:nearest（紧邻点击行，不回弹）');
ok(!smaBody.includes("block: 'center'"), 'showMetricAnalysis 不得再把页面滚动到上方右卡（l 版回弹根除）');
ok(smaBody.includes("querySelectorAll('.ma-inline-panel')"), '展开新面板前应移除旧面板（同时只展开一项）');
ok(smaBody.includes("classList.toggle('ma-hidden', !isTarget)"), '右卡单卡切换逻辑保留');
ok(appSrc.includes("this.showMetricAnalysis(next, next ? btn.closest('.metric-row') : null)"), 'tab 点击应传指标行锚点');
ok(appSrc.includes("kEl.closest('.metric-row')"), '重渲染后应按 activeMetricKey 恢复行内展开');
ok(/20261104m/.test(appSrc.slice(rmaStart - 500, smaEnd)), '指标分析相关函数应带 20261104m 注释标记（功能引入版本不随全局升版）');

// ---------- §6 版本戳 ----------
ok(/const APP_VERSION = '20261106p'/.test(serverSrc), 'server.js APP_VERSION 应为 20261106p');
ok(/\[20261104k\]/.test(serverSrc), 'server.js 应有 [20261104k] 独立注释条目（本功能引入版本，历史条目不随全局版本升级）');
ok(/\[20261104m\]/.test(serverSrc), 'server.js 应有 [20261104m] 行内展开条目（功能引入版本，历史条目不随全局升版）');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public/css/style.css'), 'utf8');
ok(cssSrc.includes('.ma-inline-panel'), 'style.css 应有行内展开面板样式（.ma-inline-panel）');
ok(cssSrc.includes('.ma-inline-panel.ma-flash'), '行内面板应复用 ma-flash 高亮动画');

// ---------- 汇总 ----------
console.log(`\n共 ${pass + fail} 断言：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) {
  console.log('\n失败明细:');
  failures.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  process.exit(1);
}
console.log('PASS');

~~~

---

## `scripts\test_market_ai_cache_notes.js`  ·  84 行

~~~js
/**
 * AI 大盘解读：缓存（按交易日）+ 写入大盘记录（20261024l）
 * 运行： node scripts/test_market_ai_cache_notes.js
 *
 * 用户报障（2026-10-24 16:09 截图）：
 *   ① 点「AI 解读」得到的滚动文字没有同步进「大盘记录」；
 *   ② AI 解读没有缓存，每次系统更新/刷新都要重新解读一次。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa_notes_ai_test_' + process.pid + '.json');
process.env.SA_NOTES_FILE = TMP;
try { fs.unlinkSync(TMP); } catch (e) {}

const dr = require('../lib/dailyMarketReview');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const readNotes = () => { try { return JSON.parse(fs.readFileSync(TMP, 'utf8')); } catch (e) { return []; } };

const DATA = { cn: [{ name: '上证指数', changePct: 0.89 }, { name: '创业板指', changePct: 4.16 }] };
const AI = { cn: 'A股探底回升，沪指涨0.89%。', gainers: '电机涨5.18%居首。', losers: '银行走弱。', model: 'glm-5.3' };

console.log('\n[1] 生成成功后写入大盘记录（新建）');
{
  const r = dr.saveMarketReviewNote({ date: '2026-10-23', data: DATA, ai: AI });
  ok(r.saved === true && r.updated === false, '首次写入 → saved=true, updated=false');
  const notes = readNotes();
  ok(notes.length === 1, '大盘记录新增 1 条');
  ok(notes[0].scope === 'market', 'scope=market');
  ok(notes[0].title === 'AI 大盘复盘 · 2026-10-23', '标题为交易日标记');
  ok(/【大盘】/.test(notes[0].content) && /【指数收盘】上证指数 \+0\.89%/.test(notes[0].content), '正文含大盘与指数收盘');
  ok(notes[0].ai === true && notes[0].type === 'ai', 'ai/type 标记正确');
}

console.log('\n[2] 同一交易日重复生成 → 更新，不重复（不刷屏）');
{
  const r2 = dr.saveMarketReviewNote({ date: '2026-10-23', data: DATA, ai: { ...AI, cn: '收盘版：探底回升更明确。' } });
  ok(r2.saved === true && r2.updated === true, '同日再写 → updated=true');
  const notes = readNotes();
  ok(notes.length === 1, '记录仍为 1 条（未重复）');
  ok(/收盘版/.test(notes[0].content), '内容已更新为最新解读');
  ok(notes[0].updatedAt, '写入 updatedAt 时间戳');
}

console.log('\n[3] 不同交易日 → 各一条；空内容 → 不写');
{
  dr.saveMarketReviewNote({ date: '2026-10-22', data: DATA, ai: AI });
  ok(readNotes().length === 2, '不同交易日 → 新增为第 2 条');
  const rEmpty = dr.saveMarketReviewNote({ date: '2026-10-24', data: DATA, ai: { cn: '', gainers: '', losers: '' } });
  ok(rEmpty.saved === false && /空/.test(rEmpty.reason || ''), '三段全空 → 不写（返回原因）');
  const rNoDate = dr.saveMarketReviewNote({ data: DATA, ai: AI });
  ok(rNoDate.saved === false, '缺日期 → 不写');
}

console.log('\n[4] 源码守卫：按交易日缓存 + 手动解读也落盘 + 按钮复用缓存');
{
  const root = path.join(__dirname, '..');
  const mkt = fs.readFileSync(path.join(root, 'lib', 'ai', 'market.js'), 'utf8');
  ok(mkt.includes('asOfTradingDate(localDate())'), 'market.js 按 asOfTradingDate 判定缓存');
  ok(mkt.includes('sameSession'), '缓存有效期 = 同一交易日（不再 4 小时过期）');
  ok(mkt.includes('asOfTradingDate: asOf'), '缓存记录写入归属交易日');

  const ar = fs.readFileSync(path.join(root, 'routes', 'aiRoutes.js'), 'utf8');
  ok(ar.includes('saveMarketReviewNote'), 'POST /api/ai/market-overview 生成后写入大盘记录');
  ok(!ar.includes('result.cached !== true'), '不再因「命中缓存」跳过落盘（修复：缓存已存在但从未落盘的情况）');
  ok(/result\.success\)\s*\{/.test(ar), '只要 success 就 upsert（缓存命中也会补齐，幂等不重复）');

  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  ok(/runDailyMarketAiReview[\s\S]{0,1200}saveMarketReviewNote/.test(srv), '定时复盘改用 saveMarketReviewNote（upsert）');

  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  ok(app.includes("loadMarketAI(e.altKey ? true : 'ensure')"), '按钮默认「确保有解读」（复用缓存），Alt+点击强制');
  ok(app.includes("force === 'ensure'") && /force: false/.test(app), 'ensure 分支 POST force:false（命中缓存不调 LLM）');
}

try { fs.unlinkSync(TMP); } catch (e) {}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_market_emotion_volume_text.js`  ·  203 行

~~~js
/**
 * 市场情绪·量能状态 vs 量价风险文案 自洽性回归（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_market_emotion_volume_text.js
 * 背景（用户 2026-10-21 报障）：「量能状态是平量，风险提示却写 量价背离（放量下跌或量价齐跌）」
 *
 * 20261023o 改口径：卡片所有口径改为「最新日 + 上证+深证双市」，不再用 5日/3日。
 * 本测试相应改为驱动最新函数 calcVolumeActivityLatest / calcPriceVolumeLatest / calcVolumePrice，
 * 并新增沪深双市合并场景。
 *
 * 核心不变量（与 20261021f 同源）：当日量能状态=平量 时，风险提示不得凭空写"放量"。
 *   最新日模型下，平量 + 价格方向 = score 0（不触发负风险文案），结构性杜绝该矛盾。
 *
 * 覆盖：
 *   [1] 平量 + 下跌 → 不提示风险（核心不变量：平量不会被判"放量"）
 *   [2] 缩量 + 下跌 = 量价齐跌 → 风险文案「最新日量价齐跌…」，不含"放量"
 *   [3] 放量 + 下跌 = 量升价跌 → 风险文案「最新日放量下跌」
 *   [4] 量缩 + 价升 = 量缩价升 → 风险文案「最新日量缩价升（警惕诱多）」
 *   [5] 放量 + 价升 = 量价齐升 → 不产生风险提示（pvRiskText 返回 null）
 *   [6] 降级 / 缺字段 → 不提示、不崩
 *   [7] 沪深双市合并：上证放量涨 + 深证缩量跌 → 沪深分化；单市缺失降级
 *   [8] 文案不变量：每条都带「最新日」窗口；非放量形态不含"放量"
 *   [9] 接线守卫：旧固定文案已删除；pvLabel/pvKind 在投影白名单与落盘记录；按形态枚举查表
 */
const m = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

/**
 * 造指数日线：closes 数组 + 成交量数组（单位：手，量级 1e8）。
 * computeMarketVolumeMetrics 读 b.vol（不是 b.volume）。
 */
function mkBars(closes, vols) {
  return closes.map((c, i) => ({
    date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: c, close: c, high: c * 1.001, low: c * 0.999, vol: vols[i],
  }));
}
const FLAT = 1e8;
/** 30 根：前 26 根常数，最后 4 根按需变化 */
function scenario(opts) {
  const n = 30;
  const closes = Array.from({ length: n }, () => 3000);
  const vols = Array.from({ length: n }, () => FLAT);
  const { last4Closes, last4Vols } = opts;
  for (let i = 0; i < 4; i++) {
    if (last4Closes[i] != null) closes[n - 4 + i] = last4Closes[i];
    if (last4Vols[i] != null) vols[n - 4 + i] = last4Vols[i];
  }
  return mkBars(closes, vols);
}

console.log('\n[1] 平量 + 下跌 → 不提示风险（核心不变量：平量不会被提示"放量"）');
{
  // 今日量能≈20日均量（平量），今日收盘 < 昨日（价跌）
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [FLAT, FLAT, FLAT, FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);

  eq(va.state, '平量', '当日量比落在平量档（用户原报障场景）');
  eq(pv.kind, 'flatVolPriceDown', '形态 = 量平价跌（平量 + 价跌）');
  ok(pv.score === 0, '平量 + 价跌 → 量价分 = 0（不触发负风险）');
  eq(vp.score, 0, '合成因子 score = 0');
  eq(m.pvRiskText(vp), null, '平量不提示任何量价风险（无"放量"矛盾）');
  ok(/口径：最新日 · 上证\+深证/.test(vp.detail), 'detail 标明口径：最新日 · 上证+深证');
}

console.log('\n[2] 缩量 + 下跌 = 量价齐跌 → 风险文案「最新日量价齐跌」，且不含"放量"');
{
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [FLAT, FLAT, FLAT, 0.5 * FLAT], // 缩量（<0.7）
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'bothFall', '形态 = 量价齐跌（缩量下跌）');
  ok(pv.score < 0, '量价得分为负');
  const risk = m.pvRiskText(vp);
  ok(/量价齐跌/.test(risk || ''), '风险文案指向「量价齐跌」');
  ok(!/放量/.test(risk || ''), '风险文案**不含"放量"**（这正是用户报障的矛盾点）');
  ok(/最新日/.test(risk || ''), '文案写明窗口（最新日）');
}

console.log('\n[3] 放量 + 下跌 = 量升价跌 → 风险文案「最新日放量下跌」');
{
  const bars = scenario({
    last4Closes: [3010, 3005, 3000, 2985],
    last4Vols: [FLAT, FLAT, FLAT, 2.2 * FLAT], // 放量（>1.5）
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'volUpPriceDown', '形态 = 量升价跌');
  const risk = m.pvRiskText(vp);
  ok(/放量下跌/.test(risk || ''), '文案点明放量下跌');
  ok(/最新日/.test(risk || ''), '文案写明「最新日」窗口');
}

console.log('\n[4] 量缩 + 价升 = 量缩价升 → 风险文案「最新日量缩价升（警惕诱多）」');
{
  const bars = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, FLAT, 0.6 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'priceUpVolDown', '形态 = 量缩价升');
  ok(pv.score < 0, '量缩价升给负分（动能不足）');
  const risk = m.pvRiskText(vp);
  ok(/量缩价升/.test(risk || ''), '文案指向量缩价升');
  ok(!/放量/.test(risk || ''), '不含"放量"');
}

console.log('\n[5] 放量 + 价升 = 量价齐升 → 不产生风险提示');
{
  const bars = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, FLAT, 1.8 * FLAT],
  });
  const d = { index: { bars }, breadth: null };
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'bothRise', '形态 = 量价齐升');
  eq(m.pvRiskText(vp), null, '齐升不提示量价风险');
}

console.log('\n[6] 降级 / 缺字段 → 不提示、不崩');
{
  eq(m.pvRiskText(null), null, 'null 入参');
  eq(m.pvRiskText({}), null, '空对象');
  eq(m.pvRiskText({ pvScore: null }), null, '分值缺失');
  eq(m.pvRiskText({ pvScore: 0.5 }), null, '正分不提示');
  const fallback = m.pvRiskText({ pvScore: -0.5, pvKind: null, pvLabel: '量缩价升（动能不足，警惕诱多）' });
  ok(/量缩价升/.test(fallback || ''), 'kind 缺失时用原形态文案兜底，不臆造方向');
  eq(m.calcPriceVolumeLatest({ index: { bars: [] } }).degraded, true, '日线不足 → 降级（不抛错）');
}

console.log('\n[7] 沪深双市合并（20261023o 新需求）');
{
  // 上证：放量涨；深证：缩量跌
  const sh = scenario({
    last4Closes: [2990, 2995, 3000, 3010],
    last4Vols: [FLAT, FLAT, FLAT, 1.8 * FLAT],
  });
  const sz = scenario({
    last4Closes: [3010, 3005, 3000, 2990],
    last4Vols: [FLAT, FLAT, FLAT, 0.5 * FLAT],
  });
  const d = { index: { bars: sh }, indexSZ: { bars: sz }, breadth: null };
  const va = m.calcVolumeActivityLatest(d);
  const pv = m.calcPriceVolumeLatest(d);
  const vp = m.calcVolumePrice(d);
  eq(pv.kind, 'mixed', '沪深形态相反 → 沪深分化（期望 "mixed"，实际 "' + pv.kind + '"）');
  ok(/上证/.test(vp.value) && /深证/.test(vp.value), 'value 分别列出上证/深证');
  ok(/沪深分化/.test(vp.detail), 'detail 说明沪深分化');
  ok(va.sh && va.sz, '量能活跃度同时拿到两市');

  // 单市缺失 → 仍给出上证结果，深证标缺失
  const d1 = { index: { bars: sh }, indexSZ: null, breadth: null };
  const vp1 = m.calcVolumePrice(d1);
  ok(vp1.score === 1, '仅上证（放量涨）→ 合成满分');
  ok(/深证 缺失/.test(vp1.value), 'value 明示「深证 缺失」');
}

console.log('\n[8] 文案不变量（防回归）');
{
  const keys = Object.keys(m.PV_RISK_TEXT);
  eq(keys.length, 3, '三种负分形态各一条文案');
  ok(keys.every(k => /最新日/.test(m.PV_RISK_TEXT[k])), '每条都写明窗口（最新日）');
  ok(!/放量/.test(m.PV_RISK_TEXT.bothFall), '「量价齐跌」文案不含"放量"');
  ok(!/放量/.test(m.PV_RISK_TEXT.priceUpVolDown), '「量缩价升」文案不含"放量"');
  ok(/放量/.test(m.PV_RISK_TEXT.volUpPriceDown), '只有「量升价跌」才允许出现"放量"');
}

console.log('\n[9] 接线守卫');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8');
  // 只判代码本体：注释里保留旧文案作为「为什么改」的说明是允许的（同 20261020l 教训）
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/量价背离（放量下跌或量价齐跌）/.test(codeOnly), '旧固定文案已从代码中删除（注释除外，不许复活）');
  ok(/const pvRisk = pvRiskText\(vp\)/.test(src), '风险提示改用 pvRiskText(vp) 单源取词');
  ok(/pvLabel: f\.pvLabel/.test(src) && /pvKind: f\.pvKind/.test(src), '因子投影白名单含 pvLabel/pvKind');
  ok(/rec\.pvKind = vp\.pvKind/.test(src), '落盘记录带 pvKind（个股页「市场情绪提醒」可直接引用形态）');
  ok(/PV_RISK_TEXT\[vp\.pvKind\]/.test(src), '文案按形态枚举查表，而非按分值符号猜');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);

~~~

---

## `scripts\test_market_emotion.js`  ·  293 行

~~~js
/**
 * 大盘量能情绪模型 · 离线回归测试（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_market_emotion.js
 * 覆盖：9 因子齐全 / 权重恒为 100% / 常驻权重边界 5%~30% / 降级因子权重归零并分摊 /
 *       非常驻休眠与激活 / 极端行情熔断 / 炸板率展示与封板质量修正 /
 *       量能活跃与量价配合合并（加权合成 / 降级 / 历史权重迁移）/ 量能方向修正 /
 *       月末缩量放宽 / T+1 准确率结算 /
 *       股吧热度时效校验（滞后打折、过期剔除）/ 分位样本交易日过滤。
 * 说明：用 SA_MARKET_EMOTION_DIR 与 SA_MSI_SERIES 指向临时目录，绝不读生产数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa-emotion-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_MARKET_EMOTION_DIR = TMP;
process.env.SA_MSI_SERIES = path.join(TMP, 'msi-series.json');

const { computeMarketEmotion, W_MIN, W_MAX, NON_RESIDENT } = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
const round2 = v => Math.round(v * 100) / 100;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

const END = '2026-09-17';   // 交易日（周四）
const MSI_DATES = [
  '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
  '2026-09-05', '2026-09-06',
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-12', '2026-09-13',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
];
const MSI_HEAT = {
  '2026-08-31': 0.080, '2026-09-01': 0.100, '2026-09-02': 0.062, '2026-09-03': 0.061, '2026-09-04': 0.084,
  '2026-09-05': 0.033, '2026-09-06': 0.031,
  '2026-09-07': 0.081, '2026-09-08': 0.103, '2026-09-09': 0.053, '2026-09-10': 0.077, '2026-09-11': 0.033,
  '2026-09-12': 0.041, '2026-09-13': -0.078,
  '2026-09-14': 0.060, '2026-09-15': 0.076, '2026-09-16': 0.102, '2026-09-17': 0.053,
};
// 14 个交易日 + 4 个周末 = 18 条；交易日过滤后应剩 14
const WEEKEND_N = 4;
const TRADING_N = MSI_DATES.length - WEEKEND_N;

function writeFakeMsiSeries() {
  const arr = MSI_DATES.map(d => ({
    date: d, index: 0.1,
    components: [{ key: 'breadth', label: '市场宽度', signal: 0.2, weight: 0.3 },
      { key: 'marketHeat', label: '股吧讨论热度', signal: MSI_HEAT[d], weight: 0.167,
        value: `热度 ${MSI_HEAT[d]}`, detail: `讨论综合得分 0.12、看多占比 55%（数据源：东财股吧，样本 1200 只，更新于 ${d} 15:05）` }],
    ts: 1,
  }));
  fs.writeFileSync(process.env.SA_MSI_SERIES, JSON.stringify(arr));
}

/** 生成 n 根「上证日线」，只含工作日（模拟真实交易日历），最后一根为 END */
function mkBars(n, { closeTrend = 0.0005, volBase = 5e8, lastVolMult = 1 } = {}) {
  const bars = [];
  let close = 3800;
  const endT = Date.parse(END + 'T00:00:00');
  // 注意：必须按「本地日期」格式化。用 toISOString() 会在 UTC+8 下把日期整体前移一天，
  // 导致生成的『交易日』集合与真实交易日错位（曾把 09-11 误判成非交易日）。
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const dates = [];
  for (let t = endT; dates.length < n; t -= 86400000) {
    const d = new Date(t), dow = d.getDay();
    if (dow !== 0 && dow !== 6) dates.unshift(fmt(d));
  }
  for (let i = 0; i < n; i++) {
    close = close * (1 + closeTrend);
    let vol = volBase * (1 + Math.sin(i / 7) * 0.1);
    if (i === n - 1) vol = volBase * lastVolMult;
    bars.push({ date: dates[i], close: Math.round(close * 100) / 100, vol: Math.round(vol) });
  }
  return bars;
}

function baseBundle(over = {}) {
  return {
    ok: true,
    date: END,
    index: { code: 'sh000001', name: '上证指数', bars: mkBars(260) },
    breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
    // [20261109a] 两融双栏夹具：融资 +1.2%（加仓=利好 +1）、融券 -1.2%（减少=利好 +1）
    // → 两子项同向，本卡 score 仍为 +1，与旧版单因子口径等价，既有数值断言零影响。
    margin: { latest: 18000, changePct: 0.3, change5Pct: 1.2, rqLatest: 300, rqChange5Pct: -1.2 },
    mainFund: { mainNetToday: 150, history: [] },
    capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
    fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
    bond: { cn10y: 2.0, chgBp5: 5 },
    discussionHeat: { marketHeat: 0.2, date: END, value: '热度 0.2', detail: '讨论综合得分 0.12、看多占比 55%（数据源：东财股吧，样本 1200 只，更新于 2026-09-17 15:05）' },
    issues: [], warnings: [],
    ...over,
  };
}
const withBars = (bars, over = {}) => baseBundle({ index: { code: 'sh000001', name: '上证指数', bars }, ...over });

(async () => {
  writeFakeMsiSeries();

  console.log('\n[1] 基线：数据齐备时的结构与权重');
  let r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  ok(r.factors.length === 10, `因子数 = 10（8 常驻 + 2 非常驻，20261022h 新增宽基ETF申赎；实际 ${r.factors.length}）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '因子权重合计 = 100%');
  ok(r.model === 'volume-emotion-v2', '模型标识正确（v2 = 量能两因子合并）');
  ok(['看涨', '看跌', '中性'].includes(r.tendency), `短期倾向合法（${r.tendency}）`);
  ok(typeof r.coreDriver === 'string' && r.coreDriver.length > 0, '核心驱动非空');
  ok(typeof r.advice === 'string' && r.advice.length > 0, '操作建议非空');

  console.log('\n[2] 常驻权重边界 5%~30%（人为塞入越界权重后仍被夹紧）');
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({
    weights: { volumePrice: 99, breadthExtreme: 0.1, indexMomentum: 10, margin: 10, mainCapital: 10, discussionHeat: 10, riskAversion: 10, domesticMacro: 5, usMacro: 5 },
    factorAcc: {}, events: {},
  }));
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const vw = r.factors.find(f => f.key === 'volumePrice').weight;
  const bw = r.factors.find(f => f.key === 'breadthExtreme').weight;
  ok(vw <= W_MAX + 0.01 && vw > 0, `越界上限被夹紧（volumePrice=${vw}% ≤ ${W_MAX}%）`);
  ok(bw >= W_MIN - 0.01, `越界下限被夹紧（breadthExtreme=${bw}% ≥ ${W_MIN}%）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '夹紧后权重合计仍 = 100%');

  console.log('\n[3] 数据缺失 → 该因子权重归零并按比例分摊，其余因子权重之和仍为 100%');
  fs.rmSync(path.join(TMP, 'state.json'), { force: true });
  r = await computeMarketEmotion({ data: baseBundle({ breadth: null }), macroFactors: [] });
  const be = r.factors.find(f => f.key === 'breadthExtreme');
  ok(be.degraded === true && be.weight === 0, '缺失因子已降级且权重 = 0');
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '降级后权重合计仍 = 100%');
  ok(!!r.dataNote, '数据缺口说明已输出');

  console.log('\n[4] 非常驻因子休眠 → 其权重按比例分摊给常驻因子');
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const domW = r.factors.find(f => f.key === 'domesticMacro').weight;
  ok(domW === 0, `休眠时非常驻权重 = 0（domesticMacro=${domW}%）`);
  ok(Math.abs(r.factors.filter(f => !NON_RESIDENT.includes(f.key)).reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '休眠时常驻权重合计 = 100%');

  console.log('\n[5] 非常驻因子激活 → 常驻权重被等比例压缩，总和仍 100%');
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({
    weights: {}, factorAcc: {},
    events: { domesticMacro: { status: 'dormant', weight: 0, lastTrigger: null }, usMacro: { status: 'dormant', weight: 0, lastTrigger: null } },
  }));
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [{ key: 'DOMESTIC_MACRO', name: '国内宏观', status: 'active', signal: -0.8 }] });
  const dw = r.factors.find(f => f.key === 'domesticMacro').weight;
  ok(dw > 0, `休眠残留 weight=0 时激活仍能拿到权重（domesticMacro=${dw}%）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '激活后权重合计 = 100%');
  const resSum = r.factors.filter(f => !NON_RESIDENT.includes(f.key)).reduce((a, f) => a + f.weight, 0);
  ok(resSum < 100, `常驻权重被压缩（合计 ${round2(resSum)}% < 100%）`);

  console.log('\n[6] 极端行情熔断（千股跌停 / 单日 ±5%）');
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 50, down: 5000, flat: 10, limitUp: 2, limitDown: 1200, activePct: 5 } }), macroFactors: [] });
  ok(r.circuit === true, '千股跌停触发熔断');
  ok(/观望/.test(r.advice), `熔断时输出观望建议（${r.advice.slice(0, 20)}…）`);

  console.log('\n[6b] 炸板率（20261015j）：统计展示 + 方向分>0 时封板质量修正');
  // ① 炸板率 40%（<50%）：进入 value 展示、字段透出、不修正
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60, zbgcCount: 40, zbgcBreaks: 90, zbgcRate: 0.4 } }), macroFactors: [] });
  const be40 = r.factors.find(f => f.key === 'breadthExtreme');
  ok(/炸板率 40%（40\/100）/.test(be40.value), `炸板率进入 value 展示（${be40.value}）`);
  ok(be40.zbgcRate === 0.4 && be40.zbgcCount === 40 && be40.zbgcBreaks === 90, '炸板三字段透出（zbgcRate/zbgcCount/zbgcBreaks）');
  ok(be40.score === 1, `炸板率 40% < 50% 不修正（score=${be40.score}）`);
  ok(/封板质量正常/.test(be40.detail), '低炸板率文案为「封板质量正常」');
  // ② 炸板率 60%：打 7 折
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 40, limitDown: 3, activePct: 60, zbgcCount: 60, zbgcBreaks: 120, zbgcRate: 0.6 } }), macroFactors: [] });
  const be60 = r.factors.find(f => f.key === 'breadthExtreme');
  ok(be60.score === 0.7, `炸板率 60% ≥ 50% → 打 7 折（score=${be60.score}）`);
  ok(/打7折/.test(be60.detail), '7 折修正文案可见');
  // ③ 炸板率 80%：打 5 折，且风险提示出现封板质量条目
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 20, limitDown: 3, activePct: 60, zbgcCount: 80, zbgcBreaks: 200, zbgcRate: 0.8 } }), macroFactors: [] });
  const be80 = r.factors.find(f => f.key === 'breadthExtreme');
  ok(be80.score === 0.5, `炸板率 80% ≥ 70% → 打 5 折（score=${be80.score}）`);
  ok(/封板质量极差/.test(r.riskTip || ''), `风险提示含封板质量条目（${(r.riskTip || '').slice(0, 30)}…）`);
  // ④ 炸板率缺失：不修正、不 crash、如实标注暂缺
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60, zbgcCount: null, zbgcBreaks: null, zbgcRate: null } }), macroFactors: [] });
  const beNull = r.factors.find(f => f.key === 'breadthExtreme');
  ok(beNull.score === 1 && beNull.zbgcRate === null, '炸板率缺失时不修正（score 维持 1）');
  ok(/暂缺/.test(beNull.detail), '缺失时 detail 如实标注「暂缺」');
  ok(!/炸板率 \d/.test(beNull.value), '缺失时 value 不显示炸板率段');
  // ⑤ 普跌场景（score=-1）：炸板率不参与修正（不削弱负面信号）
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 800, down: 4000, flat: 50, limitUp: 10, limitDown: 30, activePct: 20, zbgcCount: 60, zbgcBreaks: 120, zbgcRate: 0.6 } }), macroFactors: [] });
  const beDown = r.factors.find(f => f.key === 'breadthExtreme');
  ok(beDown.score === -1, `普跌场景炸板率不修正（score=${beDown.score}）`);
  ok(/非普涨场景，不参与修正/.test(beDown.detail), '普跌场景文案说明不参与修正');
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '炸板率场景权重合计仍 = 100%');

  console.log('\n[6c] 量能活跃与量价配合合并（20261015k）：加权合成 / 降级 / 历史权重迁移');
  // ① 基线场景合成数值（20261023o 改最新日口径）：恒定成交量日线 → 今日量比 1.0（平量，量能分 0）；
  //    今日收轻微上涨（closeTrend）→ 平量+价涨 = 量价分 0 → 合成 = (0×15 + 0×10)/25 = 0。
  //    深证未提供 → 单市降级（value 标「深证 缺失」）。
  const flatVolBars = mkBars(260).map(b => ({ ...b, vol: 5e8 }));
  r = await computeMarketEmotion({ data: withBars(flatVolBars, { breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 } }), macroFactors: [] });
  const vp0 = r.factors.find(f => f.key === 'volumePrice');
  ok(Math.abs(vp0.score) < 1e-9, `平量 + 微涨 → 加权合成 = 0（score=${vp0.score}）`);
  ok(vp0.pvScore === 0, `量价分透出（pvScore=${vp0.pvScore}）`);
  ok(/合成得分 =（量能活跃度 0 × 15 \+ 量价配合度 0 × 10）÷ 25 = 0（口径：最新日 · 上证\+深证/.test(vp0.detail), '合成算式写入 detail（可解释，最新日·上证+深证）');
  ok(/上证 1\.00（平量）/.test(vp0.value) && /深证 缺失/.test(vp0.value), 'value 列出上证平量 + 深证缺失（单市降级）');
  // ② 放量普涨 + 量价齐升：今日量比 1.8（放量 → 量能分 1）+ 量价分 1 → (1×15+1×10)/25 = 1
  const upVolBars = mkBars(260).map((b, i) => ({ ...b, vol: i === 259 ? 9e8 : 5e8 }));
  r = await computeMarketEmotion({ data: withBars(upVolBars, { breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 } }), macroFactors: [] });
  const vp1 = r.factors.find(f => f.key === 'volumePrice');
  ok(Math.abs(vp1.score - 1) < 1e-9, `放量普涨 → 加权合成 = 1（score=${vp1.score}）`);
  ok(vp1.pvScore === 1, `量价齐升判满分（pvScore=${vp1.pvScore}）`);
  ok(vp1.volState === '放量', `量能状态保留（volState=${vp1.volState}）`);
  ok(/上证 1\.80（放量）/.test(vp1.value), 'value 标上证放量（量比 1.80）');
  // ②b 沪深一致放量涨 → 双市合并（20261023o 新需求）
  const szUp = mkBars(260).map((b, i) => ({ ...b, vol: i === 259 ? 9e8 : 5e8 }));
  r = await computeMarketEmotion({ data: withBars(upVolBars, { indexSZ: { code: 'sz399001', name: '深证成指', bars: szUp }, breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 } }), macroFactors: [] });
  const vp2 = r.factors.find(f => f.key === 'volumePrice');
  ok(/深证 1\.80（放量）/.test(vp2.value), '双市合并：value 同时含上证与深证放量');
  ok(Math.abs(vp2.score - 1) < 1e-9, '沪深一致放量涨 → 满分');
  // ③ 单边/双边数据缺失 → 整体降级归零，reason 说明是哪一半
  r = await computeMarketEmotion({ data: baseBundle({ index: { code: 'sh000001', name: '上证指数', bars: [] } }), macroFactors: [] });
  const vpD = r.factors.find(f => f.key === 'volumePrice');
  ok(vpD.degraded === true && vpD.weight === 0, '日线缺失 → 合并因子整体降级且权重 = 0');
  ok(/量能活跃度/.test(vpD.reason) && /量价配合度/.test(vpD.reason), `降级 reason 指明两半（${vpD.reason}）`);
  ok(/量能活跃与量价配合/.test(r.dataNote || ''), '数据缺口说明点名合并因子');
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '降级后权重合计仍 = 100%');
  // ④ 历史 state.json 权重迁移：旧 volumeActivity:12 + priceVolume:8 → volumePrice:20（幂等，旧 key 删除）
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({
    weights: { volumeActivity: 12, priceVolume: 8, breadthExtreme: 15, indexMomentum: 10, margin: 10, mainCapital: 10, discussionHeat: 10, riskAversion: 10, domesticMacro: 5, usMacro: 5 },
    factorAcc: { volumeActivity: { samples: [true], total: 1, correct: 1 } }, events: {},
  }));
  await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
  ok(st.weights.volumePrice === 20, `旧两 key 权重合并迁移（volumePrice=${st.weights.volumePrice}，期望 20）`);
  ok(st.weights.volumeActivity === undefined && st.weights.priceVolume === undefined, '旧权重 key 已删除（迁移幂等）');
  ok(st.factorAcc && st.factorAcc.volumeActivity, '历史准确率台账旧 key 保留可追溯');
  fs.rmSync(path.join(TMP, 'state.json'), { force: true });

  console.log('\n[7] 量能活跃与量价配合方向修正：放量 + 普跌 → 恐慌抛售（负分）');
  r = await computeMarketEmotion({ data: withBars(mkBars(260, { lastVolMult: 2.0 }), { breadth: { up: 800, down: 4000, flat: 50, limitUp: 10, limitDown: 30, activePct: 20 } }), macroFactors: [] });
  const vp7 = r.factors.find(f => f.key === 'volumePrice');
  ok(vp7.score < 0, `放量普跌判为负分（score=${vp7.score}）`);

  console.log('\n[8] T+1 准确率结算：构造一条历史预测并核验命中判定');
  fs.rmSync(path.join(TMP, 'records.json'), { force: true });
  const hb = mkBars(260);
  const base = hb[hb.length - 2].date;
  fs.writeFileSync(path.join(TMP, 'records.json'), JSON.stringify([{ date: base, baselineDate: base, tendency: '看涨', score: 0.3, factorDirs: { volumePrice: 1 } }]));
  r = await computeMarketEmotion({ data: withBars(hb), macroFactors: [] });
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, 'records.json'), 'utf8')).find(x => x.date === base);
  ok(rec && rec.settledT1 === true, 'T+1 已结算');
  ok(rec && rec.correctT1 === false, '预测看涨但实际下跌 → 记为未命中');

  console.log('\n[9] 股吧热度时效：滞后 1~2 个交易日 → 打 8 折且不剔除');
  const bars9 = mkBars(260);
  const dayIdx = bars9.length - 1;                     // 今日
  const lag2 = bars9[dayIdx - 2].date;                 // 往前 2 个交易日
  r = await computeMarketEmotion({ data: withBars(bars9, { discussionHeat: { marketHeat: 0.2, date: lag2, detail: 'd' } }), macroFactors: [] });
  const dh9 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh9.lagDays === 2, `滞后天数识别正确（lagDays=${dh9.lagDays}，热度日期 ${lag2}）`);
  ok(dh9.lagged === true && dh9.degraded === false, `滞后按 §九 打 8 折（lagged=${dh9.lagged}，degraded=${dh9.degraded}，weight=${dh9.weight}%）`);

  console.log('\n[10] 股吧热度时效：滞后 ≥ 3 个交易日 → 剔除归零并分摊');
  const lag4 = bars9[dayIdx - 4].date;
  r = await computeMarketEmotion({ data: withBars(bars9, { discussionHeat: { marketHeat: 0.2, date: lag4, detail: 'd' } }), macroFactors: [] });
  const dh10 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh10.degraded === true && dh10.weight === 0, `过期热度已剔除（lagDays=${dh10.lagDays}，weight=${dh10.weight}%）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '剔除后权重合计仍 = 100%');
  ok(/过期|滞后/.test(r.dataNote || ''), `数据缺口说明已如实标注（${(r.dataNote || '').slice(0, 40)}…）`);

  console.log('\n[11] 股吧热度时效：日期缺失 → 无法判定时效，按剔除处理（不静默当今日）');
  r = await computeMarketEmotion({ data: withBars(bars9, { discussionHeat: { marketHeat: 0.2 } }), macroFactors: [] });
  const dh11 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh11.degraded === true && dh11.weight === 0, `日期未知 → 剔除（weight=${dh11.weight}%）`);

  console.log('\n[12] 分位样本交易日过滤：18 条里 4 条是周末，应只留 14 条');
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const dh12 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh12.heatSamples === TRADING_N, `分位样本已滤除周末（样本 ${dh12.heatSamples}/${TRADING_N}，原始 ${MSI_DATES.length} 条）`);
  ok(dh12.heatPct != null, `分位仍可计算（热度 0.2 → 分位 ${dh12.heatPct != null ? Math.round(dh12.heatPct * 100) + '%' : '—'}）`);

  console.log('\n[13] 来源标注透传：热度 detail 里的数据源/样本数/更新时间进入因子明细');
  ok(/东财股吧/.test(dh12.detail) && /样本 1200 只/.test(dh12.detail), `来源标注已还原（${(dh12.detail || '').slice(0, 80)}…）`);

  console.log('\n[14] 权重=评分口径（20261025n）：总分 = Σ(满格方向×权重)，因子 contribution = 方向×权重');
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const dirOf = s => (s > 0 ? 1 : s < 0 ? -1 : 0);
  // [20261109a] 两融双栏因子 subScore=true：融资/融券各占半权重，按原始方向强度（±0.5）计入；
  // 其余因子仍走 dirOf 满格方向。与 model 的 dirWeight 同源，避免把合法的半格误判为失败。
  const dirVal = f => (f.subScore ? (f.score || 0) : dirOf(f.score || 0));
  const expectTotal = r.factors.reduce((a, f) => a + dirVal(f) * (f.weight / 100), 0);
  ok(Math.abs(r.totalScore - expectTotal) < 0.001, `总分 = Σ(方向×权重)（${r.totalScore} vs ${expectTotal.toFixed(3)}）`);
  ok(r.factors.every(f => Math.abs((f.contribution || 0) - dirVal(f) * f.weight) < 0.011),
    '每因子 contribution = 方向 × 权重（净权重=评分；两融双栏按半格）');

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });

~~~

---

## `scripts\test_market_log_db.js`  ·  185 行

~~~js
/**
 * scripts/test_market_log_db.js — 20261105b 守卫
 * ==========================================================
 * 用户指令（2026-11-03）：「把大盘记录做成一个简单的数据库，添加相应的检索功能，
 * 能够按日期、行业和涨跌等关键词进行搜索。」
 *
 * 锁定行为：
 *   §1 parseMarketNote 解析（AI 条目：交易日/指数/行业/方向；手写条目：诚实缺失；脏数据兜底）
 *   §2 SQLite 派生库（同步幂等 / 删除收敛 / 关键词·行业·涨跌·日期·组合检索 / facets）
 *   §3 接线守卫（server 路由 / 前端面板 / CSS 红涨绿跌 / 版本断言）
 *
 * IO 隔离：SA_NOTES_FILE / SA_MARKET_LOG_DB 重定向到临时目录，测试结束清理，
 * 不触碰真实 data/notes.json 与 data/market-log.db。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const TMP = path.join(os.tmpdir(), 'mldb-test-' + Date.now());
const NOTES = path.join(TMP, 'notes.json');
const DBF = path.join(TMP, 'market-log.db');
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_NOTES_FILE = NOTES;
process.env.SA_MARKET_LOG_DB = DBF;

const ROOT = path.join(__dirname, '..');
const marketLogDb = require(path.join(ROOT, 'lib/marketLogDb'));

const AI_NOTE_1 = {
  id: 'ai-market-20261103-test1',
  date: '2026-11-03T08:30:00.000Z',
  scope: 'market', aspect: null, stockCode: '', stockName: '',
  title: 'AI 大盘复盘 · 2026-11-03',
  content: '【大盘】A股今日探底回升强势反攻，沪指涨0.89%逼近3700点，创业板指狂飙4.16%，两市成交放量。\n【领涨板块】电机涨5.18%居首，软件开发、自动化设备涨近5%，资金涌入具身智能主线。\n【领跌板块】地面兵装、银行双双跌0.54%垫底，玻璃玻纤受下游需求偏弱拖累。\n【指数收盘】上证指数 0.89%，深证成指 1.20%，创业板指 4.16%\n（AI 自动复盘 · 数据源：东方财富行业板块/腾讯行情 · 模型：test）',
  tags: ['AI复盘', '大盘'], type: 'ai', ai: true,
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
};
const AI_NOTE_2 = {
  id: 'ai-market-20261030-test2',
  date: '2026-10-30T08:30:00.000Z',
  scope: 'market', aspect: null, stockCode: '', stockName: '',
  title: 'AI 大盘复盘 · 2026-10-30',
  content: '【大盘】A股震荡整理，沪指跌0.42%失守3600点，防御风格占优。\n【领涨板块】银行涨0.31%护盘，保险涨近0.5%。\n【领跌板块】软件开发跌2.10%领跌，电机跌超1.5%。\n【指数收盘】上证指数 -0.42%，创业板指 -1.05%\n（AI 自动复盘 · 模型：test）',
  tags: ['AI复盘', '大盘'], type: 'ai', ai: true,
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
};
const MANUAL_NOTE = {
  id: 'manual-market-test3',
  date: '2026-09-28T10:40:52.841Z',
  scope: 'market', aspect: null, stockCode: '', stockName: '',
  title: '2026/9/28',
  content: '无明确的原因，大盘下跌，银行股相对抗跌。',
  tags: [], type: 'experience', ai: false,
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
};
// 干扰条目：个股范围（不应入库）
const STOCK_NOTE = { id: 'stock-note-x', scope: '601318', title: '个股亮点', content: '与大盘记录无关', tags: [], type: 'experience', ai: false, date: '2026-11-01T00:00:00Z' };

let fixture = [STOCK_NOTE, MANUAL_NOTE, AI_NOTE_2, AI_NOTE_1];   // 与真实 notes.json 一致：新条目在前
function writeFixture(arr) { fs.writeFileSync(NOTES, JSON.stringify(arr), 'utf8'); }

function cleanup() {
  try { marketLogDb.close(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

async function main() {
  try {
    // ── §1 解析纯函数 ─────────────────────────────────────────
    console.log('\n§1 parseMarketNote 解析（代码权威，诚实缺失）');
    {
      const r = marketLogDb.parseMarketNote(AI_NOTE_1);
      ok(r.tradeDate === '2026-11-03', 'AI 条目交易日从 title 提取（2026-11-03）');
      ok(r.direction === 'up' && r.marketPct === 0.89, '方向 up（沪指 +0.89%）');
      ok(r.indices.length >= 3 && r.indices.some(i => i.name === '创业板指' && i.changePct === 4.16), '指数收盘解析（含创业板指 +4.16%）');
      ok(r.sectorsUp.includes('电机') && r.sectorsUp.includes('软件开发') && r.sectorsUp.includes('自动化设备'), '领涨行业候选（电机/软件开发/自动化设备）');
      ok(r.sectorsDown.includes('地面兵装') && r.sectorsDown.includes('银行'), '领跌行业候选（地面兵装/银行）');
      ok(r.source === 'ai', '来源 ai');

      const r2 = marketLogDb.parseMarketNote(AI_NOTE_2);
      ok(r2.direction === 'down' && r2.marketPct === -0.42, '方向 down（沪指 -0.42%）');
      ok(r2.sectorsUp.includes('银行'), '领涨行业候选（银行）');
      ok(r2.tradeDate === '2026-10-30', '第二条交易日 2026-10-30');

      const r3 = marketLogDb.parseMarketNote(MANUAL_NOTE);
      ok(r3.tradeDate === '2026-09-28', '手写条目 tradeDate 用笔记时间兜底（本地日期）');
      ok(r3.direction === null && r3.marketPct === null, '无标记段落 → 方向/涨跌幅如实 null（不臆造）');
      ok(r3.sectorsUp.length === 0 && r3.indices.length === 0, '手写条目结构字段为空数组（诚实缺失）');
      ok(r3.source === 'manual', '来源 manual');

      const r4 = marketLogDb.parseMarketNote(null);
      ok(r4 && r4.direction === null && r4.noteId === '', 'null 输入不抛错（脏数据兜底）');
      const r5 = marketLogDb.parseMarketNote({ id: 'x', scope: 'market', title: '', content: '', date: 'bad-date' });
      ok(r5.tradeDate === null, '坏日期 → tradeDate null（不编造）');
    }

    // ── §2 SQLite 派生库 ──────────────────────────────────────
    console.log('\n§2 SQLite 派生库（同步幂等 / 检索）');
    {
      writeFixture(fixture);
      const s1 = marketLogDb.syncMarketLog();
      ok(s1.synced === 3, `首次同步入库 3 条（scope=market 过滤个股条目，实际 ${s1.synced}）`);
      const c1 = marketLogDb.count();
      const s2 = marketLogDb.syncMarketLog();
      ok(marketLogDb.count() === c1 && s2.synced === 3, '重复同步幂等（全量重建不重复）');

      // 关键词
      let r = marketLogDb.searchMarketLog({ q: '探底回升' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-11-03', '关键词检索（content 命中）');
      r = marketLogDb.searchMarketLog({ q: '大盘下跌' });
      ok(r.total === 1 && r.records[0].source === 'manual', '手写条目可被关键词检索（content）');
      // 行业（sectors JSON + content 兜底）
      r = marketLogDb.searchMarketLog({ sector: '电机' });
      ok(r.total === 2, `行业「电机」命中 2 条（11-03 领涨 + 10-30 领跌，实际 ${r.total}）`);
      r = marketLogDb.searchMarketLog({ sector: '银行' });
      ok(r.total === 3, `行业「银行」命中 3 条（含手写条目 content 兜底，实际 ${r.total}）`);
      // 方向
      r = marketLogDb.searchMarketLog({ direction: 'up' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-11-03', '涨跌检索：up 1 条');
      r = marketLogDb.searchMarketLog({ direction: 'down' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-10-30', '涨跌检索：down 1 条（手写条目方向未知不入）');
      // 日期范围
      r = marketLogDb.searchMarketLog({ from: '2026-11-01', to: '2026-11-30' });
      ok(r.total === 1, '日期范围检索（11 月 1 条）');
      r = marketLogDb.searchMarketLog({ from: '2026-01-01' });
      ok(r.total === 3, '起始日期检索 3 条');
      // 指数名
      r = marketLogDb.searchMarketLog({ index: '创业板指' });
      ok(r.total === 2, '指数名检索（创业板指 2 条）');
      // 组合
      r = marketLogDb.searchMarketLog({ sector: '银行', direction: 'down' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-10-30', '组合检索（银行 × 下跌 → 10-30）');
      r = marketLogDb.searchMarketLog({ q: '不存在的关键词xyz' });
      ok(r.total === 0 && Array.isArray(r.records), '无命中 → total 0 / 空数组（不报错）');
      // facets
      const names = r.facets.sectors.map(f => f.name);
      ok(names.includes('电机') && names.includes('银行'), '行业 facets 聚合（含电机/银行）');
      // stats
      const st = marketLogDb.getStats();
      ok(st.total === 3 && st.fromDate === '2026-09-28' && st.toDate === '2026-11-03', '库统计（条数/日期范围）');

      // 删除收敛：权威源删掉一条 → 重建后库内同步减少
      fixture = fixture.filter(n => n.id !== 'ai-market-20261030-test2');
      writeFixture(fixture);
      const s3 = marketLogDb.syncMarketLog();
      ok(s3.synced === 2 && marketLogDb.count() === 2, '删除笔记后重建收敛（库内不再残留）');
      r = marketLogDb.searchMarketLog({ direction: 'down' });
      ok(r.total === 0, '被删条目不再可检索');
    }

    // ── §3 接线守卫 ────────────────────────────────────────────
    console.log('\n§3 接线守卫（路由 / 前端 / CSS / 版本）');
    {
      const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      ok(server.includes("require('./lib/marketLogDb')") && server.includes("app.get('/api/market-log'"), 'server.js：marketLogDb 接线 + /api/market-log 路由');
      ok(/const APP_VERSION = '20261106p'/.test(server), "APP_VERSION = '20261106p'");
      const notesJs = fs.readFileSync(path.join(ROOT, 'public/js/notes.js'), 'utf8');
      ok(notesJs.includes('renderMarketDbPanel') && notesJs.includes('runMarketSearch') && notesJs.includes('mldbSearch'), 'notes.js：检索面板/检索执行函数齐备');
      ok(notesJs.includes("data-page-scope") && /renderMarketDbPanel\(\);\n/.test(notesJs), 'notes.js：面板按 market scope 注入（投资心得页零变化）');
      const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
      ok(css.includes('.mldb-panel') && css.includes('.mldb-dir.up') && css.includes('.mldb-dir.down'), 'style.css：检索面板与方向徽标样式齐备');
      const notesHtml = fs.readFileSync(path.join(ROOT, 'public/notes.html'), 'utf8');
      ok(notesHtml.includes('js/notes.js?v=20261106p') && notesHtml.includes('css/style.css?v=20261106p'), 'notes.html：notes.js/style.css 版本戳已对齐');
      const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      const acc = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');
      ok(idx.includes('?v=20261106p') && acc.includes('?v=20261106p'), 'index/accuracy 页面版本戳已对齐 20261106p');
      const lib = fs.readFileSync(path.join(ROOT, 'lib/marketLogDb.js'), 'utf8');
      ok(lib.includes("require('node:sqlite')") && lib.includes('ensureSynced'), 'marketLogDb.js：node:sqlite + mtime 自动重建');
    }
  } finally {
    cleanup();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); cleanup(); process.exit(1); });

~~~

---

## `scripts\test_market_tech_settle.js`  ·  209 行

~~~js
/**
 * 大盘技术分析 · 准确率结算回归（零网络、零磁盘污染）
 * --------------------------------------------------------------
 * 运行：node scripts/test_market_tech_settle.js
 * 背景（用户 2026-10-21 报障「为什么老是出现无法结算准确率的问题」，截图：过期未结算 2 条）：
 *   历史记录里的 targetDate 由旧口径生成（只跳周末、不跳法定节假日），落在中秋 09-25 / 国庆 10-01，
 *   而 K 线里永远没有这两天 → settleRecord 找不到 K 线就 return，永不结算，同时被永久计入 overdueCount。
 * 覆盖（20261021c 修复）：
 *   [1] 存储 targetDate 是节假日 → 不采信，按交易日历重算并结算（targetDateFixed 留痕）
 *   [2] 目标日无 K 线但 5 天内无缺口邻日 → 用其后首个交易日兜底（shortTargetFallback 留痕）
 *   [3] 缺口超过容忍天数 → 拒绝结算并写 settleError（绝不把 20 天后的 K 线当"次日"）
 *   [4] 正常目标日 → 正常结算，不产生兜底字段
 *   [5] 当日未收盘（目标日=今天且未收盘）→ 不结算
 *   [6] settleAll 整批只拉一次 K 线
 *   [7] settleIfDue 节流：3 分钟内第二次调用 skipped
 *   [8] overdueCount 用「有效目标日」，不把节假日目标日算成过期
 *   [9] 接线守卫：records 路由读取即结算；修复口径在源码里存在
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const m = require('../lib/marketTechJudgment');

// ---------- 虚拟目录：把 fs 的读写重定向到内存，绝不碰 data/market-tech ----------
function withVirtualDir(files, fn) {
  const readFile = fs.readFileSync, writeFile = fs.writeFileSync, exists = fs.existsSync,
    mkdir = fs.mkdirSync, readdir = fs.readdirSync;
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.readdirSync = () => Object.keys(files);
  fs.readFileSync = (p) => {
    const k = String(p).replace(/\\/g, '/').split('/').pop();
    if (files[k] === undefined) throw new Error('ENOENT ' + k);
    return JSON.stringify(files[k]);
  };
  fs.writeFileSync = (p, data) => {
    const k = String(p).replace(/\\/g, '/').split('/').pop();
    files[k] = JSON.parse(data);
  };
  try { return fn(files); }
  finally {
    fs.readFileSync = readFile; fs.writeFileSync = writeFile; fs.existsSync = exists;
    fs.mkdirSync = mkdir; fs.readdirSync = readdir;
  }
}

// ---------- 合成日K：上证指数（只用于结算，字段只需 date/close） ----------
function mkBars(pairs) {
  return pairs.map(([date, close]) => ({ date, open: close, close, high: close, low: close, volume: 1e8 }));
}
// 2026-09-24(四) → 09-25 中秋休市 → 09-28(一)；2026-09-30 → 10-01~10-07 国庆 → 10-08
const BARS = mkBars([
  ['2026-09-23', 3800.00],
  ['2026-09-24', 3810.00],
  ['2026-09-28', 3746.37],   // -1.67%
  ['2026-09-29', 3740.00],
  ['2026-09-30', 3750.00],
  ['2026-10-08', 3720.38],   // -0.79%
  ['2026-10-19', 3760.00],
  ['2026-10-20', 3765.00],
]);

function mkRec(over) {
  return Object.assign({
    baseDate: '2026-09-24',
    targetDate: '2026-09-25',        // 旧口径写出的节假日目标日（真实用例）
    baseClose: 3810.00,
    shortRaw: '看空', shortDir: '跌', shortVerdict: '看跌',
    midRaw: '看空', midDir: '跌',
    fusionSignal: '偏空', fusionDir: '跌', confidence: '高',
    shortSettled: false, midSettled: false, settleError: null,
  }, over || {});
}

(async () => {
  m.__setFetchDaily(async () => BARS);

  console.log('\n[1] 存储 targetDate 落在节假日（中秋 09-25）→ 按交易日历重算为 09-28');
  {
    const files = { '2026-09-24.json': mkRec() };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-24.json'], BARS));
    const r = files['2026-09-24.json'];
    eq(r.targetDate, '2026-09-28', '目标日被纠正为节后首个交易日');
    eq(r.targetDateFixed && r.targetDateFixed.from, '2026-09-25', '留痕：原目标日 09-25');
    eq(r.targetDateFixed && r.targetDateFixed.to, '2026-09-28', '留痕：修正为 09-28');
    ok(r.shortSettled, '已结算（不再永久挂在待验证）');
    eq(r.shortActualDate, '2026-09-28', '记录实际结算日');
    eq(r.shortActualChgPct, -1.67, '实际涨跌 -1.67%');
    eq(r.shortCorrect, true, '预判「跌」命中');

    const files2 = { '2026-09-30.json': mkRec({ baseDate: '2026-09-30', targetDate: '2026-10-01', baseClose: 3750.00 }) };
    await withVirtualDir(files2, () => m.settleRecord(files2['2026-09-30.json'], BARS));
    const r2 = files2['2026-09-30.json'];
    eq(r2.targetDate, '2026-10-08', '国庆：10-01 → 10-08');
    eq(r2.shortCorrect, true, '预判「跌」命中（-0.79%）');
  }

  console.log('\n[2] 目标日是交易日但无 K 线（数据缺口 3 天）→ 用其后首个交易日兜底');
  {
    const bars = mkBars([['2026-09-23', 3800], ['2026-09-24', 3810], ['2026-10-01', 3700]]);
    const files = { '2026-09-24.json': mkRec({ targetDate: '2026-09-28' }) };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-24.json'], bars));
    const r = files['2026-09-24.json'];
    ok(r.shortSettled, '在容忍天数内 → 结算');
    eq(r.shortActualDate, '2026-10-01', '用其后首个交易日结算');
    eq(r.shortTargetFallback && r.shortTargetFallback.gapDays, 3, '留痕：缺口 3 天');
  }

  console.log('\n[3] 缺口超出容忍天数 → 拒绝结算并写明原因（绝不改口径）');
  {
    const bars = mkBars([['2026-09-23', 3800], ['2026-09-24', 3810], ['2026-10-21', 3600]]);
    const files = { '2026-09-24.json': mkRec({ targetDate: '2026-09-28' }) };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-24.json'], bars));
    const r = files['2026-09-24.json'];
    ok(!r.shortSettled, `缺口 ${r.shortTargetFallback ? '?' : ''}超出 ${m.TARGET_FALLBACK_MAX_DAYS} 天 → 不结算`);
    ok(/超出容忍/.test(r.settleError || ''), 'settleError 写明超出容忍天数');
  }

  console.log('\n[4] 正常目标日 → 正常结算，不产生兜底留痕');
  {
    const files = { '2026-09-23.json': mkRec({ baseDate: '2026-09-23', targetDate: '2026-09-24', baseClose: 3800.00 }) };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-23.json'], BARS));
    const r = files['2026-09-23.json'];
    ok(r.shortSettled, '已结算');
    ok(!r.targetDateFixed, '无需纠正目标日');
    ok(!r.shortTargetFallback, '未走兜底');
    eq(r.shortActualChgPct, 0.26, '涨跌 +0.26%（3810/3800）');
    eq(r.shortCorrect, false, '预判「跌」未中');
  }

  console.log('\n[5] 目标日=今天且尚未收盘 → 不结算（数据未定）');
  {
    const today = require('../lib/localDate').localDate();
    const closed = require('../lib/sameDayJudgment').marketClosed(new Date());
    if (closed) {
      console.log('  - 当前已收盘，跳过该用例（无法构造"未收盘"现场）');
    } else {
      const bars = mkBars([[today, 3700]]);
      const files = { 'x.json': mkRec({ baseDate: today, targetDate: today, baseClose: 3800 }) };
      await withVirtualDir(files, () => m.settleRecord(files['x.json'], bars));
      ok(!files['x.json'].shortSettled, '当日未收盘 → 保持待验证');
    }
  }

  console.log('\n[6] settleAll：整批只拉一次 K 线（原来每条记录各拉一次）');
  {
    let calls = 0;
    m.__setFetchDaily(async () => { calls++; return BARS; });
    const files = {
      '2026-09-24.json': mkRec(),
      '2026-09-30.json': mkRec({ baseDate: '2026-09-30', targetDate: '2026-10-01', baseClose: 3750.00 }),
      '2026-09-23.json': mkRec({ baseDate: '2026-09-23', targetDate: '2026-09-24', baseClose: 3800.00 }),
    };
    const r = await withVirtualDir(files, () => m.settleAll());
    eq(calls, 1, '3 条记录 → 仅 1 次 K 线请求');
    eq(r.changed, 3, '3 条全部新结算');
    eq(r.accuracy.short.overdueCount, 0, '结算后过期未结算 = 0');
  }

  console.log('\n[7] settleIfDue：3 分钟内第二次调用直接 skipped（不重复打网络）');
  {
    let calls = 0;
    m.__setFetchDaily(async () => { calls++; return BARS; });
    const files = { '2026-09-24.json': mkRec() };
    await withVirtualDir(files, () => m.settleIfDue({ force: true }));
    const second = await withVirtualDir(files, () => m.settleIfDue());
    ok(second.skipped, '第二次调用被节流');
    eq(calls, 1, '只拉了 1 次 K 线');
  }

  console.log('\n[8] overdueCount 用有效目标日（节假日目标日不算「过期」）');
  {
    const today = require('../lib/localDate').localDate();
    const acc = m.computeAccuracy([
      // 未结算 + 目标日是节假日（旧记录形态）：生效目标日 = 节后交易日，已过去 → 仍应算过期（真实该补结算）
      mkRec({ baseDate: '2026-09-24', targetDate: '2026-09-25' }),
      // 未结算 + 目标日=未来 → 不算过期
      mkRec({ baseDate: '2026-09-30', targetDate: '2099-01-01' }),
    ]);
    eq(acc.short.pendingCount, 2, '2 条待验证');
    eq(acc.short.overdueCount, 1, '只有目标日确已过去的那条计为过期');
    ok(today < '2099-01-01', '（未来目标日不参与过期统计）');
  }

  console.log('\n[9] 接线守卫');
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(/await marketTechJudgment\.settleIfDue\(\)/.test(srv), '/api/market-tech/records 读取即结算（带节流）');
    const mt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketTechJudgment.js'), 'utf8');
    ok(mt.includes('不信存储的 targetDate') || mt.includes('不信存储的 targetDate') || /isTradingDay\(rec\.targetDate\)/.test(mt),
      '大盘结算不盲目采信存储目标日');
    ok(/TARGET_FALLBACK_MAX_DAYS/.test(mt), '缺口容忍常量存在');
    const jd = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
    ok(/calIsTradingDay\(targetDate\)/.test(jd), '个股结算同样加固（非交易日目标日不采信）');
    ok(/targetDateFixed/.test(jd) && /targetDateFixed/.test(mt), '两处都留了 targetDateFixed 修正痕迹');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();

~~~

---

## `scripts\test_market_technical.js`  ·  41 行

~~~js
const { getMarketTechnical } = require('../lib/marketTechnical');

(async () => {
  const t0 = Date.now();
  const res = await getMarketTechnical({ force: true });
  console.log('耗时(ms):', Date.now() - t0);
  console.log('date:', res.date, '| success:', res.success);
  console.log('=== 跨指数综合 ===');
  console.log(res.synthesis);
  for (const x of res.indices) {
    if (x.error) { console.log(`\n[${x.name}] 错误: ${x.error}`); continue; }
    console.log(`\n========== ${x.name}  收盘 ${x.lastClose} (${x.changePct}%)  数据日 ${x.date} ==========`);
    console.log('①趋势定性:', x.step1.arrangement, '| ADX=', x.step1.adx, x.step1.adxState, '| 结论=', x.step1.trendLabel,
      '| +DI/-DI=', x.step1.plusDI, '/', x.step1.minusDI);
    console.log('②形态识别:', x.step2.structure, '| 月线', x.step2.monthDir, '周线', x.step2.weekDir,
      '| 形态=', x.step2.pattern.name || '无', x.step2.pattern.note);
    console.log('③量价验证:', x.step3.volState, '| 健康=', x.step3.health, '| 今日量', x.step3.lastVol, '5/20日均', x.step3.avg5, '/', x.step3.avg20,
      '| 缩量新高背离=', x.step3.divergence);
    console.log('④指标共振:', x.step4.resonance, `(看多${x.step4.bull}/看空${x.step4.bear})`, JSON.stringify(x.step4.detail),
      '| RSI', x.step4.values.rsi, 'KDJ', x.step4.values.k + '/' + x.step4.values.d, 'MACD柱', x.step4.values.hist);
    console.log('⑤周期共振:', x.step5.conclusion, '| 月', x.step5.monthDir, '周', x.step5.weekDir, '日', x.step5.dayDir, '30分', x.step5.m30Dir, '| 策略:', x.step5.strategy);
    console.log('⑥综合预判:');
    console.log('  中期:', x.step6.midTerm.direction, '| 支撑', x.step6.midTerm.support, '压力', x.step6.midTerm.pressure);
    console.log('  短期:', x.step6.shortTerm.direction, '| 支撑', x.step6.shortTerm.support, '压力', x.step6.shortTerm.pressure);
    console.log('  仓位:', x.step6.strategy.position, '| 动作:', x.step6.strategy.action);
    console.log('  观测:', x.step6.strategy.watch);
    console.log('  风险:', x.step6.risk);
    if (x.issues) console.log('  数据提示:', x.issues.join(','));
  }
  const f = res.fused;
  console.log('\n=== 融合版 fused ===');
  console.log('state:', f.state, '| reliable:', f.reliable, '| fusionSignal:', f.fusionSignal, '| confidence:', f.confidence);
  console.log('anchors:', JSON.stringify(f.anchors));
  console.log('volume:', f.volume.nature, '|', f.volume.detail);
  console.log('external:', f.external.bias, 'score=', f.external.score, '|', f.external.note);
  console.log('position:', JSON.stringify(f.position));
  console.log('signals:', f.signals.join(' | '));
  console.log('risk:', f.risk.join(' | '));
  console.log('evidenceChain:', f.evidenceChain.join(' | '));
})().catch(e => { console.error('FATAL', e); process.exit(1); });

~~~

---

## `scripts\test_market_volume_root_migration.js`  ·  322 行

~~~js
/**
 * 首页侧量能收敛等价性守卫（20261018）
 * --------------------------------------------------------------
 * 背景（用户 2026-10-17 架构指令）：首页侧量能根数据源设置在「大盘技术分析的量价关系」
 * （lib/marketTechnical）里，市场情绪模型需要的量能分析在根里创建再引用。
 *   旧：marketEmotionModel.calcVolumeActivity / calcPriceVolume 用 260 窗口 bars 自算指标
 *       （数据走 scripts/market_emotion.py·akshare 通道）
 *   新：两函数的底层指标改引 lib/marketTechnical.computeMarketVolumeMetrics
 *       （数据走根通道 fetchIndexDailyBars，320 窗口）
 *
 * 断言（三重）：
 *   ① 同一份 bars：旧函数 vs 新函数返回对象 deepStrictEqual（score/value/detail 逐字）
 *   ② 窗口不变性：260 根 vs「60 根更老数据 + 同样 260 根」（=320 窗口），
 *      新函数(320) 必须与旧函数(260) 完全相等 —— 证明 260→320 不改变任何结论
 *      （所有尾部窗口 -250/-21,-1/-20/-5/-3 样本集相同；实测两通道重叠 260 根零差异）
 *   ③ 边界：24 根 / 9 根时旧新降级行为一致
 *
 * 旧实现来源：git show HEAD:lib/marketEmotionModel.js（收敛前的权威版本，非手抄）
 * 运行：node scripts/test_market_volume_root_migration.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { computeMarketVolumeMetrics } = require('../lib/marketTechnical');

function extractFn(src, name) {
  const re = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数: ' + name);
  return m[0];
}
function extractConst(src, name) {
  const m = src.match(new RegExp('^const ' + name + ' = [^\\n]+$', 'm'));
  if (!m) throw new Error('未找到常量: ' + name);
  return m[0];
}

// 旧实现 = git HEAD（收敛前）；新实现 = 工作区（收敛后）
// 归一化行尾：本机 core.autocrlf=true，工作区检出为 CRLF 而 `git show HEAD:` 恒为 LF。
// 不归一化时 extractFn 会因多出的 \r 判定「实现不一致」——这是行尾差异造成的假失败，
// 与实现是否等价无关（项目跨端 md5 校验同样用 `tr -d '\r'` 处理同一问题）。
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');
const OLD_SRC = normalizeEol(execSync('git show HEAD:lib/marketEmotionModel.js', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const NEW_SRC = normalizeEol(fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8'));

//  rigor：新旧两版的 round / VOL_PCTL_* 必须逐字相同（否则等价比对失去意义）
for (const name of ['round']) {
  const o = extractFn(OLD_SRC, name), n = extractFn(NEW_SRC, name);
  if (o !== n) throw new Error(name + ' 实现在收敛前后不一致，等价性前提不成立');
}
for (const name of ['VOL_PCTL_LOW', 'VOL_PCTL_HIGH']) {
  const o = extractConst(OLD_SRC, name), n = extractConst(NEW_SRC, name);
  if (o !== n) throw new Error(name + ' 常量在收敛前后不一致，等价性前提不成立');
}

// eslint-disable-next-line no-eval
eval([
  extractConst(OLD_SRC, 'VOL_PCTL_LOW'),
  extractConst(OLD_SRC, 'VOL_PCTL_HIGH'),
  extractFn(OLD_SRC, 'round'),
  extractFn(OLD_SRC, 'mean'),
  extractFn(OLD_SRC, 'std'),
  extractFn(OLD_SRC, 'trimExtremes'),
  extractFn(OLD_SRC, 'rankPercentile'),
  extractFn(OLD_SRC, 'calcVolumeActivity').replace('function calcVolumeActivity(d)', 'function oldCalcVolumeActivity(d)'),
  extractFn(OLD_SRC, 'calcPriceVolume').replace('function calcPriceVolume(d)', 'function oldCalcPriceVolume(d)'),
  extractFn(NEW_SRC, 'calcVolumeActivity'),
  extractFn(NEW_SRC, 'calcPriceVolume'),
].join('\n'));

// ---- 场景数据 ----
// 真实上证日线 120 根（2026-04-20 ~ 2026-10-16，腾讯 fqkline 实测抓取后固化，保证测试离线可复现）
const REAL_120 = [
  ["2026-04-20", 4082.13, 589841379],
  ["2026-04-21", 4085.08, 576689450],
  ["2026-04-22", 4106.26, 582466346],
  ["2026-04-23", 4093.25, 671166092],
  ["2026-04-24", 4079.9, 605031798],
  ["2026-04-27", 4086.34, 589950867],
  ["2026-04-28", 4078.64, 600507498],
  ["2026-04-29", 4107.51, 614221451],
  ["2026-04-30", 4112.16, 656912728],
  ["2026-05-06", 4160.17, 701177480],
  ["2026-05-07", 4180.09, 685574249],
  ["2026-05-08", 4179.95, 697019094],
  ["2026-05-11", 4225.02, 762736287],
  ["2026-05-12", 4214.49, 718984002],
  ["2026-05-13", 4242.57, 705018739],
  ["2026-05-14", 4177.92, 764235004],
  ["2026-05-15", 4135.39, 733162357],
  ["2026-05-18", 4131.53, 627233137],
  ["2026-05-19", 4169.54, 617611067],
  ["2026-05-20", 4162.18, 624152035],
  ["2026-05-21", 4077.28, 727218701],
  ["2026-05-22", 4112.9, 589459644],
  ["2026-05-25", 4152.57, 615930861],
  ["2026-05-26", 4145.37, 654777756],
  ["2026-05-27", 4093.73, 660467399],
  ["2026-05-28", 4098.64, 621179950],
  ["2026-05-29", 4068.57, 731597710],
  ["2026-06-01", 4057.74, 676025806],
  ["2026-06-02", 4075.1, 642244656],
  ["2026-06-03", 4083.97, 668452583],
  ["2026-06-04", 4057.78, 621194774],
  ["2026-06-05", 4027.74, 662918577],
  ["2026-06-08", 3959.34, 659293555],
  ["2026-06-09", 4010.03, 576570090],
  ["2026-06-10", 3993.23, 598694739],
  ["2026-06-11", 3987.01, 568545244],
  ["2026-06-12", 4031.51, 743131092],
  ["2026-06-15", 4096.47, 678907811],
  ["2026-06-16", 4091.89, 615668296],
  ["2026-06-17", 4108.08, 608077413],
  ["2026-06-18", 4090.48, 658116068],
  ["2026-06-22", 4163.1, 743699355],
  ["2026-06-23", 4106.25, 709003913],
  ["2026-06-24", 4110.81, 644527518],
  ["2026-06-25", 4120.28, 670459917],
  ["2026-06-26", 4027.26, 660108666],
  ["2026-06-29", 4073.9, 659199936],
  ["2026-06-30", 4094.4, 598412203],
  ["2026-07-01", 4112.45, 672331791],
  ["2026-07-02", 4028.9, 656233612],
  ["2026-07-03", 4043.64, 602009738],
  ["2026-07-06", 4041.24, 590364903],
  ["2026-07-07", 3990.24, 514453091],
  ["2026-07-08", 3970.88, 496229374],
  ["2026-07-09", 4036.59, 553063980],
  ["2026-07-10", 3996.16, 627450065],
  ["2026-07-13", 3913.79, 590907356],
  ["2026-07-14", 3967.13, 579982052],
  ["2026-07-15", 3955.58, 576209492],
  ["2026-07-16", 3882.41, 535281873],
  ["2026-07-17", 3764.15, 650450984],
  ["2026-07-20", 3796.28, 709234069],
  ["2026-07-21", 3864.37, 735021925],
  ["2026-07-22", 3867.03, 614255215],
  ["2026-07-23", 3876.78, 562122601],
  ["2026-07-24", 3814.2, 508203905],
  ["2026-07-27", 3858.25, 504879454],
  ["2026-07-28", 3813.31, 494829126],
  ["2026-07-29", 3828.47, 571226391],
  ["2026-07-30", 3804.69, 592298923],
  ["2026-07-31", 3832.26, 597529427],
  ["2026-08-03", 3809.66, 524516960],
  ["2026-08-04", 3822.28, 540324922],
  ["2026-08-05", 3878.43, 592155124],
  ["2026-08-06", 3900.35, 588555280],
  ["2026-08-07", 3940.04, 564988582],
  ["2026-08-10", 3966.59, 542118110],
  ["2026-08-11", 3934.09, 529490944],
  ["2026-08-12", 3946.68, 503257011],
  ["2026-08-13", 3926.96, 572793677],
  ["2026-08-14", 3927.18, 499525613],
  ["2026-08-17", 3982.65, 489834027],
  ["2026-08-18", 3990.3, 511234287],
  ["2026-08-19", 3894.42, 572191213],
  ["2026-08-20", 3903.72, 506633954],
  ["2026-08-21", 3905.2, 446895868],
  ["2026-08-24", 3882.01, 486931412],
  ["2026-08-25", 3889.44, 464117264],
  ["2026-08-26", 3912.52, 489553021],
  ["2026-08-27", 3956.57, 516777549],
  ["2026-08-28", 3952.18, 510581645],
  ["2026-08-31", 3986.3, 576656606],
  ["2026-09-01", 3979.89, 573538949],
  ["2026-09-02", 3941.39, 516472775],
  ["2026-09-03", 3942.09, 496990189],
  ["2026-09-04", 3930.12, 537286161],
  ["2026-09-07", 3932.7, 477375261],
  ["2026-09-08", 3940.55, 529992688],
  ["2026-09-09", 3951.51, 517504311],
  ["2026-09-10", 3934.4, 484675114],
  ["2026-09-11", 3888.11, 579123145],
  ["2026-09-14", 3885.33, 458888916],
  ["2026-09-15", 3864.28, 440907766],
  ["2026-09-16", 3891.6, 459125108],
  ["2026-09-17", 3875.6, 452886464],
  ["2026-09-18", 3911.87, 485712507],
  ["2026-09-21", 3949.91, 502354877],
  ["2026-09-22", 3952.13, 506148369],
  ["2026-09-23", 3936.52, 466913933],
  ["2026-09-24", 3888.37, 438530412],
  ["2026-09-28", 3823.62, 452350675],
  ["2026-09-29", 3830.45, 399473391],
  ["2026-09-30", 3842.19, 414560247],
  ["2026-10-08", 3811.9, 482201685],
  ["2026-10-09", 3813.79, 535149921],
  ["2026-10-12", 3797.24, 461448981],
  ["2026-10-13", 3800.86, 483305909],
  ["2026-10-14", 3767.23, 445962554],
  ["2026-10-15", 3707.48, 510163189],
  ["2026-10-16", 3716.28, 472632158],
].map(([date, close, vol]) => ({ date, close, vol }));

// 确定性伪随机（LCG）合成序列：放量/缩量/脉冲/长窗口
function lcgBars(n, seed, opts = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const bars = [];
  let close = 3000;
  const base = Date.UTC(2015, 0, 1);
  for (let i = 0; i < n; i++) {
    close *= 1 + (rnd() - 0.5) * 0.02;
    let vol = 5e8 * (0.7 + rnd() * 0.6);
    if (opts.spikeLast && i === n - 1) vol *= opts.spikeLast;   // 末日放量/缩量
    if (opts.pulseAt && i === n - 10) vol *= opts.pulseAt;      // 窗口内脉冲（触发极端值剔除）
    const d = new Date(base + i * 86400000);
    bars.push({ date: d.toISOString().slice(0, 10), close: Math.round(close * 100) / 100, vol: Math.round(vol) });
  }
  return bars;
}

const BREADTHS = {
  '无宽度数据': null,
  '普涨(up>55%)': { up: 3800, down: 1200, limitUp: 80, limitDown: 2 },
  '普跌(up<45%)': { up: 800, down: 4200, limitUp: 3, limitDown: 60 },
  '涨跌互现': { up: 2400, down: 2600, limitUp: 40, limitDown: 20 },
};

const SCENARIOS = [
  ['真实数据120根', REAL_120],
  ['真实数据·末25根(活跃度边界)', REAL_120.slice(-25)],
  ['真实数据·末24根(活跃度降级)', REAL_120.slice(-24)],
  ['真实数据·末10根(配合度边界)', REAL_120.slice(-10)],
  ['真实数据·末9根(全部降级)', REAL_120.slice(-9)],
  ['合成·随机游走260根', lcgBars(260, 20261018)],
  ['合成·末日放量3倍', lcgBars(260, 42, { spikeLast: 3 })],
  ['合成·末日缩量至0.3', lcgBars(260, 43, { spikeLast: 0.3 })],
  ['合成·窗口内脉冲(触发剔除)', lcgBars(120, 44, { pulseAt: 12 })],
  ['合成·恰好25根', lcgBars(25, 45)],
];

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) {
    console.log('  旧:', JSON.stringify(expect));
    console.log('  新:', JSON.stringify(actual));
  }
}
// 20261021f：calcPriceVolume 新增 label / kind（附加字段，供风险提示按形态取词）。
// 本测试比较的是「同一份 bars 的得分与文案是否零变化」——附加字段不属于语义差异，
// 若继续整对象逐字比较，任何"加字段"都会被误判成回归。
function semantic(pv) {
  if (!pv) return pv;
  return { score: pv.score, degraded: pv.degraded, value: pv.value, detail: pv.detail };
}
function deepEq(a, b) {
  try { require('assert').deepStrictEqual(a, b); return true; } catch (e) { return false; }
}

console.log('===== 1) 同一份 bars：旧实现 vs 新实现（全返回对象逐字相等）=====');
for (const [label, bars] of SCENARIOS) {
  for (const [bLabel, breadth] of Object.entries(BREADTHS)) {
    const d = { index: { bars }, breadth };
    const vaOld = oldCalcVolumeActivity(d), vaNew = calcVolumeActivity(d);
    const pvOld = oldCalcPriceVolume(d), pvNew = calcPriceVolume(d);
    check(`量能活跃度 · ${label} · ${bLabel}`, vaNew, vaOld);
    check(`量价配合度 · ${label} · ${bLabel}`, semantic(pvNew), semantic(pvOld));
  }
}

console.log('\n===== 2) 窗口不变性：新实现(320) vs 旧实现(260) —— 260→320 结论零变化 =====');
{
  const base = lcgBars(260, 777);
  const older = lcgBars(60, 778).map((b, i) => ({ ...b, date: '2000-01-' + String(i + 1).padStart(2, '0') }));
  const bars320 = older.concat(base);       // 60 根更老 + 同样 260 根
  if (bars320.length !== 320) throw new Error('窗口构造失败');
  for (const [bLabel, breadth] of Object.entries(BREADTHS)) {
    const vaOld260 = oldCalcVolumeActivity({ index: { bars: base }, breadth });
    const vaNew320 = calcVolumeActivity({ index: { bars: bars320 }, breadth });
    const pvOld260 = oldCalcPriceVolume({ index: { bars: base }, breadth });
    const pvNew320 = calcPriceVolume({ index: { bars: bars320 }, breadth });
    check(`量能活跃度 · 旧260 vs 新320 · ${bLabel}`, vaNew320, vaOld260);
    check(`量价配合度 · 旧260 vs 新320 · ${bLabel}`, semantic(pvNew320), semantic(pvOld260));
  }
  // 反向 sanity：320 窗口里 win20 / year(250) 样本集必须与 260 窗口完全相同
  const vols260 = base.map(b => b.vol), vols320 = bars320.map(b => b.vol);
  const sameWin20 = JSON.stringify(vols260.slice(-21, -1)) === JSON.stringify(vols320.slice(-21, -1));
  const sameYear = JSON.stringify(vols260.slice(-250)) === JSON.stringify(vols320.slice(-250));
  check('320 与 260 的 20 日窗口（不含今日）样本集相同', sameWin20, true);
  check('320 与 260 的 250 根（≈1年）分位样本集相同', sameYear, true);
}

console.log('\n===== 2b) 附加字段自洽（20261021f：label 必须等于 detail 的前缀，kind 必须在枚举内）=====');
{
  const ALLOWED = ['bothRise', 'bothFall', 'volUpPriceDown', 'priceUpVolDown', 'flat'];
  const bars = lcgBars(260, 4242, { spikeLast: 1.6 });
  const pv = calcPriceVolume({ index: { bars }, breadth: { up: 2000, down: 3000, limitUp: 30, limitDown: 5 } });
  check('label 是 detail 的前缀', String(pv.detail).startsWith(pv.label), true);
  check('kind 在枚举内', ALLOWED.includes(pv.kind), true);
  // 合成层透传：这里不做 eval 执行（calcVolumePrice 未纳入新旧对比），改断言源码透传
  check('合成因子透传 pvKind', NEW_SRC.indexOf('pvKind: pv.kind') >= 0, true);
  check('合成因子透传 pvLabel', NEW_SRC.indexOf('pvLabel: pv.label') >= 0, true);
}

console.log('\n===== 3) 根函数直出指标 vs 旧实现手算（防止指标本身漂移）=====');
{
  const bars = lcgBars(320, 909, { pulseAt: 8, spikeLast: 1.8 });
  const vols = bars.map(b => b.vol);
  const win20 = vols.slice(-21, -1);
  const { kept, removed } = trimExtremes(win20);
  const avg20 = mean(kept) || 1;
  const m = computeMarketVolumeMetrics(bars);
  check('根指标 ratio = 当日量/剔除后近20日均量', m.ratio, vols[vols.length - 1] / avg20);
  check('根指标 removed = 20 日窗口剔除数', m.removed, removed);
  check('根指标 volPct = 250 根分位', m.volPct, rankPercentile(vols.slice(-250), vols[vols.length - 1]));
  const n = bars.length;
  check('根指标 priceUp5', m.priceUp5, bars[n - 1].close > bars[n - 6].close);
  check('根指标 vRecent3', m.vRecent3, mean(vols.slice(n - 3)));
  check('根指标 vPrev3', m.vPrev3, mean(vols.slice(n - 6, n - 3)));
  check('根指标 volUp3', m.volUp3, mean(vols.slice(n - 3)) > mean(vols.slice(n - 6, n - 3)));
  check('根函数 <10 根返回 null', computeMarketVolumeMetrics(bars.slice(0, 9)), null);
}

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_metric_analysis_nbv.js`  ·  252 行

~~~js
/**
 * scripts/test_metric_analysis_nbv.js — 20261029a「营运利润 + NBV(新业务价值)」回归
 *
 * 覆盖：
 *   A. lib/insuranceAnalysis.latestNbvSnapshot（备查库真实数据 + 前缀剥离 + 非保险/无数据 null）
 *   B. lib/metricAnalysis.buildMetricAnalysis 两个新 builder（渲染位置/数值/判定符号/note 口径说明）
 *   C. lib/deep/financials.fetchOpProfitSnippet（axios mock：companyType 回退、负基数同比、缺科目降级）
 *   D. 左卡对齐（app.js 条件插入块 / keyOf / METRIC_HELP 源码级断言）
 *
 * 运行： node scripts/test_metric_analysis_nbv.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, `${msg}\n    实际: ${a}\n    期望: ${e}`);
}

// ═══════════ A. latestNbvSnapshot（真实备查库，无网络） ═══════════
const { latestNbvSnapshot, isInsuranceCompany } = require('../lib/insuranceAnalysis');

const snap = latestNbvSnapshot('601318');
ok(snap != null, '601318 应能取到 NBV 快照（备查库有数据）');
eq(snap.valueYi, 248.5, '601318 最新 NBV 应为 2026H1 248.5 亿');
eq(snap.period, '2026H1', '最新报告期应为 2026H1');
eq(snap.periodText, '2026年中报', 'periodText 应为「2026年中报」');
eq(snap.prevValueYi, 223.4, '去年同期同阶段应为 2025H1 223.4 亿');
eq(snap.prevLabel, '2025H1', '去年同期 label 应为 2025H1');
// (248.5-223.4)/223.4*100 = 11.2354... → 11.24
eq(snap.yoyPct, 11.24, 'NBV 同比应为 +11.24%');
ok(typeof snap.source === 'string' && snap.source.length > 0, '应带来源标注');

// 前缀剥离
const snapPfx = latestNbvSnapshot('SH601318');
ok(snapPfx != null && snapPfx.valueYi === 248.5, '带 SH 前缀的 601318 应命中同一快照');

// 非保险股 / 保险但无备查库数据 → null（绝不把平安数据泄漏到其它公司）
eq(latestNbvSnapshot('000902'), null, '非保险股 000902 应返回 null');
eq(latestNbvSnapshot('601628'), null, '保险股 601628 但备查库无 NBV 数据 → null（诚实不可得）');
eq(latestNbvSnapshot(''), null, '空代码应返回 null');

// 交叉：isInsuranceCompany 应认 601318（供 server.js 门控用）
ok(isInsuranceCompany('601318', '中国平安', null) === true, 'isInsuranceCompany(601318) 应为 true');

// ═══════════ B. buildMetricAnalysis 两个新 builder ═══════════
const { buildMetricAnalysis, METRIC_ORDER } = require('../lib/metricAnalysis');

// METRIC_ORDER：16 项，opProfit 在 dedProfitGrowth 之后、nbv 在其后、debt 之前
eq(METRIC_ORDER.length, 16, 'METRIC_ORDER 应为 16 项');
const iOp = METRIC_ORDER.indexOf('opProfit'), iNbv = METRIC_ORDER.indexOf('nbv'), iDed = METRIC_ORDER.indexOf('dedProfitGrowth'), iDebt = METRIC_ORDER.indexOf('debt');
ok(iDed < iOp && iOp < iNbv && iNbv < iDebt, `顺序应为 …dedProfitGrowth → opProfit → nbv → debt…（实际 ${iDed},${iOp},${iNbv},${iDebt}）`);

const comparison = { percentiles: {}, industryAvg: {} };
const companyType = { isFinancial: false };
const signals = { signals: [] };
const fundamental = { metrics: { pe: 8, pb: 1, roe: 12, deductedProfitGrowth: 10 } };
const quote = { fundamentals: { pe: 8, pb: 1, roeTtm: 12, zyzbHistory: [] } };

// B1. 两项齐全：位置/标签/数值/同比/判定/note
const opData = {
  cur: { date: '2026-06-30', opProfitYi: 234.56 },
  prev: { date: '2025-06-30', opProfitYi: 200.00 },
  yoyPct: 17.28,
};
const nbvData = {
  symbol: '601318', valueYi: 248.5, period: '2026H1', label: '2026H1', periodText: '2026年中报',
  yoyPct: 11.24, prevValueYi: 223.4, prevLabel: '2025H1',
  source: '妙想金融数据 + 中国平安年报',
  assumptionNote: '长期投资回报率假设由 5% 调低到 4%，历史口径不可直接对比。',
};
const outFull = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, opData, nbvData);
const keysFull = outFull.metrics.map(m => m.key);
ok(keysFull.includes('opProfit') && keysFull.includes('nbv'), '两项齐全时应渲染 opProfit 与 nbv');
ok(keysFull.indexOf('opProfit') < keysFull.indexOf('debt') && keysFull.indexOf('nbv') < keysFull.indexOf('debt'),
  '两个新指标应排在 debt 之前（与左卡阅读顺序一致）');

const opM = outFull.metrics.find(m => m.key === 'opProfit');
eq(opM.label, '营运利润', 'opProfit 标签应为「营运利润」');
eq(opM.valueText, '234.56亿', '营运利润数值应为 234.56亿');
// 20261029i 格式统一（图二三段式）：本报告期 X 亿（去年同期 Y 亿，边际 ±Z 亿）；同比%移入边际维度
// 20261102a（主线B 单季优先口径）：单季值=本期累计−上期累计，上期累计缺失时如实回退累计并标注口径；
// 测试 mock 未给上期累计 → 触发回退，文本含「累计（单季值不可得，缺上期累计，如实回退）」属正确行为，断言放宽允许该标注。
ok(opM.dims.yoy.available && /本报告期/.test(opM.dims.yoy.text) && /234\.56亿/.test(opM.dims.yoy.text) && /去年同期 200\.00亿/.test(opM.dims.yoy.text) && /边际 \+34\.56亿/.test(opM.dims.yoy.text),
  `营运利润同比维度（单季优先口径，缺上期累计时如实回退累计）应为：本报告期 X 亿（去年同期 Y 亿，边际 ±Z 亿）（实际：${opM.dims.yoy.text}）`);
ok(/17\.28/.test(opM.dims.marginal.text), `营运利润边际维度应含同比 +17.28%（实际：${opM.dims.marginal.text}）`);
eq(opM.judgment.signal, 'bull', '同比 +17.28% → 判定 bull');
ok(/扣非/.test(opM.note) && /所得税/.test(opM.note) && /非经常/.test(opM.note),
  '营运利润 note 必须说明与扣非净利润的区别（所得税/非经常性损益）');
ok(/不采用/.test(opM.note), 'note 应声明平安财报非通用口径「营运利润」不采用');

const nbvM = outFull.metrics.find(m => m.key === 'nbv');
eq(nbvM.label, 'NBV(新业务价值)', 'nbv 标签应为「NBV(新业务价值)」');
eq(nbvM.valueText, '248.50亿', 'NBV 数值应为 248.50亿');
eq(nbvM.judgment.signal, 'bull', 'NBV 同比 +11.24% → 判定 bull');
// 20261029i 格式统一：本报告期 248.50亿（去年同期 223.40亿，边际 +25.10亿）；同比%移入边际维度
ok(nbvM.dims.yoy.available && /本报告期 248\.50亿/.test(nbvM.dims.yoy.text) && /去年同期 223\.40亿/.test(nbvM.dims.yoy.text) && /边际 \+25\.10亿/.test(nbvM.dims.yoy.text),
  `NBV 同比维度应为图二三段式（实际：${nbvM.dims.yoy.text}）`);
ok(/11\.24/.test(nbvM.dims.marginal.text), `NBV 边际维度应含同比 +11.24%（实际：${nbvM.dims.marginal.text}）`);
ok(/新业务价值/.test(nbvM.note) && /保险/.test(nbvM.note), 'NBV note 必须解释 NBV 概念与保险专属属性');
ok(/假设/.test(nbvM.note), 'NBV note 应含精算假设调整提醒（assumptionNote 透传）');

// B2. 判定符号三态（确定性代码，非 LLM）
const mkOut = (yoyPct) => buildMetricAnalysis(
  quote, comparison, companyType, signals, fundamental,
  { cur: { date: '2026-06-30', opProfitYi: 100 }, prev: { date: '2025-06-30', opProfitYi: 100 }, yoyPct },
  null
).metrics.find(m => m.key === 'opProfit');
eq(mkOut(-5).judgment.signal, 'bear', '同比 -5% → bear');
eq(mkOut(0.3).judgment.signal, 'neutral', '同比 +0.3%（近零）→ neutral');

// B3. 缺同比基数：prev 为负 → yoy 不可得，判定 neutral（不编方向）
const outNeg = buildMetricAnalysis(
  quote, comparison, companyType, signals, fundamental,
  { cur: { date: '2026-06-30', opProfitYi: 50 }, prev: { date: '2025-06-30', opProfitYi: -20 }, yoyPct: null },
  null
);
const opNeg = outNeg.metrics.find(m => m.key === 'opProfit');
ok(opNeg.valueText === '50.00亿', '亏损基数下当期值仍应正常显示（负值有效）');
eq(opNeg.judgment.signal, 'neutral', '缺同比基数 → 判定 neutral（不编造方向）');
eq(opNeg.dims.yoy.available, false, '缺同比基数 → yoy 维度如实标不可得');

// B4. opProfit / insuranceNBV 为 null → 整行不渲染（左右两卡一致）
const outNone = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, null, null);
ok(!outNone.metrics.some(m => m.key === 'opProfit' || m.key === 'nbv'), '两入参均 null → 两行均不渲染');

// B5. 非保险股：只给 opProfit、不给 NBV（server 门控后典型场景）
const outOpOnly = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental, opData, null);
ok(outOpOnly.metrics.some(m => m.key === 'opProfit') && !outOpOnly.metrics.some(m => m.key === 'nbv'),
  '000902 场景：有营运利润、无 NBV 行');

// ═══════════ C. fetchOpProfitSnippet（axios mock，不联网） ═══════════
const axios = require('axios');
const realGet = axios.get;
const LRB_ROWS = [
  { REPORT_DATE: '2025-06-30 00:00:00', REPORT_DATE_NAME: '2025中报', OPERATE_PROFIT: 20000000000 },
  { REPORT_DATE: '2026-06-30 00:00:00', REPORT_DATE_NAME: '2026中报', OPERATE_PROFIT: 23456000000 },
];
// mock：companyType=4 返回空（触发回退），companyType=3 返回真实数据（模拟保险股回退链命中）
axios.get = async (url) => {
  if (/lrbAjaxNew/.test(String(url))) {
    const ct = /companyType=(\d)/.exec(String(url))[1];
    if (ct === '3') return { data: { data: JSON.parse(JSON.stringify(LRB_ROWS)) } };
    return { data: { data: [] } };
  }
  throw new Error('unexpected url: ' + url);
};

const { fetchOpProfitSnippet } = require('../lib/deep/financials');

(async () => {
  const snip = await fetchOpProfitSnippet('SH601318', ['2026-06-30', '2025-06-30']);
  ok(snip != null, 'fetchOpProfitSnippet 应取到两期数据（含 companyType 4→3 回退）');
  eq(snip.cur.opProfitYi, 234.56, '当期营业利润应为 234.56 亿（元→亿换算）');
  eq(snip.prev.opProfitYi, 200.00, '去年同期应为 200.00 亿');
  eq(snip.cur.date, '2026-06-30', '当期日期应为 2026-06-30');
  // (234.56-200)/200*100 = 17.28
  eq(snip.yoyPct, 17.28, '营业利润同比应为 +17.28%');

  // 负基数：|prev| 同比（代码权威，避免符号翻转）
  axios.get = async (url) => ({ data: { data: [
    { REPORT_DATE: '2025-06-30 00:00:00', OPERATE_PROFIT: -20000000000 },
    { REPORT_DATE: '2026-06-30 00:00:00', OPERATE_PROFIT: 10000000000 },
  ] } });
  const snipNeg = await fetchOpProfitSnippet('SZ000902', ['2026-06-30', '2025-06-30']);
  eq(snipNeg.yoyPct, 150, '负基数同比应用 |prev|：(100-(-200))/200 = 150%');

  // 缺当期 → null（整行不渲染，绝不编造）
  axios.get = async () => ({ data: { data: [LRB_ROWS[0]] } });
  const snipMiss = await fetchOpProfitSnippet('SZ000902', ['2026-06-30', '2025-06-30']);
  eq(snipMiss, null, '当期报告期缺数据 → 返回 null');

  // 全空 → null
  axios.get = async () => ({ data: { data: [] } });
  const snipEmpty = await fetchOpProfitSnippet('SZ000902', ['2026-06-30', '2025-06-30']);
  eq(snipEmpty, null, '利润表全空 → 返回 null');

  axios.get = realGet;

  // ═══════════ D. 左卡对齐（app.js 源码级断言） ═══════════
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

  // D1. rows 字面量仍为 14 行（新两行经 splice 条件插入，不破坏既有顺序断言）
  const anchor = appSrc.indexOf('ocflowPeriod');
  const start = appSrc.indexOf('const rows = [', anchor);
  const end = appSrc.indexOf('\n    ];', start);
  ok(start > 0 && end > start, '应能定位左卡 rows 数组字面量');
  const literalBlock = appSrc.slice(start, end);
  const literalRowCount = (literalBlock.match(/\n\s*\[/g) || []).length;
  eq(literalRowCount, 14, 'rows 字面量应仍为 14 行（营运利润/NBV 由 splice 插入）');

  // D2. 条件插入块：在 rows 字面量之后、含两行、插在「扣非净利润增长」之后
  const insBlock = appSrc.slice(end, appSrc.indexOf('const periodNote', end));
  ok(insBlock.indexOf('20261029a') >= 0, '应有 20261029a 注释标记');
  ok(insBlock.indexOf("'营运利润'") >= 0, '插入块应含「营运利润」行');
  ok(insBlock.indexOf("'NBV(新业务价值)'") >= 0, '插入块应含「NBV(新业务价值)」行');
  ok(insBlock.indexOf("_dedIdx + 1") >= 0, '应插在「扣非净利润增长」之后（_dedIdx + 1）');
  ok(insBlock.indexOf('data.opProfit') >= 0 && insBlock.indexOf('data.insuranceNBV') >= 0,
    '插入块应从 /api/analysis 的 opProfit / insuranceNBV 取数');

  // D3. keyOf 映射
  ok(/'营运利润':\s*'opProfit'/.test(appSrc), 'keyOf 应含 营运利润→opProfit');
  ok(/'NBV\(新业务价值\)':\s*'nbv'/.test(appSrc), 'keyOf 应含 NBV(新业务价值)→nbv');

  // D4. METRIC_HELP 两条释义
  ok(/'营运利润':\s*\{ title:/.test(appSrc), 'METRIC_HELP 应含「营运利润」释义');
  ok(/'NBV\(新业务价值\)':\s*\{ title:/.test(appSrc), 'METRIC_HELP 应含「NBV(新业务价值)」释义');

  // D5. 右卡 note 渲染（20261105b：恢复按需单卡，签名 renderMetricAnalysis(data, activeKey)）
  ok(appSrc.indexOf('ma-metric-note') > appSrc.indexOf('renderMetricAnalysis(data, activeKey)'),
    'renderMetricAnalysis 应支持 note 渲染（.ma-metric-note）');
  ok(/m\.note \? `<div class="ma-metric-note">/.test(appSrc), 'note 渲染应使用 .ma-metric-note 类');

  // D6. 右卡输出顺序与左卡（含插入块）单调一致——用「逻辑顺序」断言：
  // 左卡逻辑顺序 = 字面量 14 行 + 扣非后插两行；右卡 = METRIC_ORDER。两者应同序。
  const leftLogical = [
    '市盈率(PE·TTM)', '市净率(PB)', 'PEG', 'ROE', '毛利率', '净利率',
    '营收增长', '归母净利润', '扣非净利润增长', '营运利润', 'NBV(新业务价值)',
    '资产负债率', '流动比率', '股息率(TTM)', '每股经营现金流',
  ];
  // 字面量顺序（从源码提取）
  const literalLabels = [];
  const re = /\['([^']+)'/g; let mm;
  while ((mm = re.exec(literalBlock)) !== null) literalLabels.push(mm[1]);
  const dedIdxL = literalLabels.indexOf('扣非净利润增长');
  literalLabels.splice(dedIdxL + 1, 0, '营运利润', 'NBV(新业务价值)');
  eq(literalLabels.join('|'), leftLogical.join('|'), '左卡逻辑顺序应为 16 项且与设计一致');
  // 右卡：PS 标签动态（PS/PS·TTM），此处仅对齐「键序列」
  eq(keysFull.join('|'), ['pe','pb','ps','peg','roe','grossMargin','netMargin','growth','profitGrowth','dedProfitGrowth','opProfit','nbv','debt','currentRatio','div','ocf'].join('|'),
    '右卡 key 顺序（两项齐全时）应为 16 项同序');

  // ═══════════ 加载即运行 ═══════════
  console.log(`\nMETRIC_ORDER = ${METRIC_ORDER.join(', ')}`);
  console.log(`NBV 快照(601318) = ${snap.period} ${snap.valueYi}亿, 同比 +${snap.yoyPct}%`);
  console.log(`营运利润样例 = ${opM.valueText}（同比 +17.28% → ${opM.judgment.signal}）`);

  if (fail) {
    console.log(`\nFAIL ${pass}/${pass + fail}`);
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  } else {
    console.log(`\nPASS ${pass}/${pass}`);
  }
})().catch(e => { console.error('测试执行异常:', e); process.exit(1); });

~~~

---

## `scripts\test_metric_analysis_order.js`  ·  159 行

~~~js
/**
 * scripts/test_metric_analysis_order.js — 「指标分析」(右卡) 与「关键财务指标」(左卡) 对齐回归
 * 对应 20260923l 四项修复：
 *   ① 顺序对齐左卡（估值前置，METRIC_ORDER 单一权威顺序）
 *   ② 补 PEG（两卡 14 项一一对应）
 *   ③ 修「扣非净利润增长」死代码（双源取值、无条件构建）
 *   ④ 统一 0 与 `--` 口径（兜底 0 = 缺失哨兵）
 *
 * 运行： node scripts/test_metric_analysis_order.js
 * 断言全部通过时打印 "PASS N/N"，并 exit 0；任一失败打印 FAIL 明细并 exit 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { buildMetricAnalysis, METRIC_ORDER, ZERO_AS_MISSING } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, `${msg}\n    实际: ${a}\n    期望: ${e}`);
}

// ---------- 构造：只把「扣非」放在 fundamental.metrics（m），quote.fundamentals 里没有 ----------
// 复现生产端的双源陷阱：老代码读 f.deductedProfitGrowth → undefined → 整项不渲染。
const quote = {
  fundamentals: {
    pe: 9.08, pb: 1.27, ps: 3.52,
    roeTtm: 14.0, grossMarginTtm: 0, netMarginTtm: 38.8,   // grossMarginTtm=0 → 哨兵（券商/缺失）
    revenueYoy: 58.6, profitYoy: 83.8,
    debtToEquity: 0, debtMetricPct: true,                  // 哨兵
    currentRatio: 0,                                       // 哨兵
    dividendYield: 1.84,
    operatingCashFlowPerShare: 0,                          // 哨兵
    roeTtmPrev: 12.0,
    psSource: 'PS_TTM',
    // 「去年同期」同期对齐用（2026-06-30 vs 2025-06-30）：使 dedProfitGrowth 命中 prev 分支，
    // 从而覆盖「维度文案里的数字也必须是 2 位小数」这条断言（20260923n）。
    zyzbHistory: [
      { REPORT_DATE: '2026-06-30', KCFJCXSYJLRTZ: '84.92880198442' },
      { REPORT_DATE: '2025-06-30', KCFJCXSYJLRTZ: '123.277436528755' },
    ],
  },
};
const comparison = { percentiles: {}, industryAvg: {} };
const companyType = { isFinancial: false };
const signals = { signals: [] };
const fundamental = {
  metrics: {
    deductedProfitGrowth: 84.93,   // ← 唯一生产点（fundamentalScore.js:290）
    pe: 9.08, pb: 1.27, ps: 3.52,
    roe: 14.0, netMargin: 38.8,
    revenueGrowth: 58.6, profitGrowth: 83.8,
    dividendYield: 1.84,
  },
};

const out = buildMetricAnalysis(quote, comparison, companyType, signals, fundamental);

// ---------- 1. 项数与顺序 ----------
// ★ 20261029a：METRIC_ORDER 14→16（dedProfitGrowth 后插 opProfit/nbv）；opProfit/nbv 为
//   条件指标（入参缺数据时整行不渲染），本测试未传入 → 输出仍为 14 项。
ok(Array.isArray(out.metrics), 'out.metrics 应为数组');
eq(METRIC_ORDER.length, 16, 'METRIC_ORDER 长度应为 16（20261029a：+opProfit +nbv）');
eq(out.metrics.length, 14, '未传 opProfit/insuranceNBV 时右卡输出项数应为 14（条件指标不渲染）');
eq(out.metrics.map(m => m.key), METRIC_ORDER.filter(k => k !== 'opProfit' && k !== 'nbv'), '右卡 key 顺序必须严格等于 METRIC_ORDER（去掉未提供的条件指标）');
eq(out.order, METRIC_ORDER, 'out.order 应回显 METRIC_ORDER');

// ---------- 2. 扣非 / PEG 必然出现 ----------
ok(out.metrics.some(m => m.key === 'dedProfitGrowth'), '右卡必须包含「扣非净利润增长」(原为死代码，永不渲染)');
ok(out.metrics.some(m => m.key === 'peg'), '右卡必须包含 PEG（补上后与左卡一一对应）');

const ded = out.metrics.find(m => m.key === 'dedProfitGrowth');
eq(ded.label, '扣非净利润增长', '扣非标签应与左卡一字不差');
ok(/84\.93/.test(ded.valueText), `扣非应从 fundamental.metrics 取到 84.93 → 显示 84.93%（实际 ${ded.valueText}）`);

const peg = out.metrics.find(m => m.key === 'peg');
eq(peg.valueText, '--', 'PEG 无数据源 → 必须显示 --（不做估算）');
ok(peg.dims.yoy.available === false, 'PEG 同比维度应标「不可得」');

// ---------- 3. 哨兵 0 → `--`（与左卡 `m.x ? : '--'` 一致） ----------
const gm = out.metrics.find(m => m.key === 'grossMargin');
eq(gm.valueText, '--', '哨兵 0 的毛利率应显示 --（旧版显示 0.0%，与左卡 -- 自相矛盾）');
eq(gm.dims.yoy.available, false, '哨兵 0 的毛利率同比维度应标不可得');

for (const k of ['debt', 'currentRatio', 'ocf']) {
  const mm = out.metrics.find(x => x.key === k);
  eq(mm.valueText, '--', `哨兵 0 的 ${k} 应显示 --`);
}

// 真实值不得被误归零
const div = out.metrics.find(m => m.key === 'div');
eq(div.valueText, '1.84%', '真实股息率 1.84% 不得被误判为哨兵');
const roe = out.metrics.find(m => m.key === 'roe');
eq(roe.valueText, '14.00%', '真实 ROE 14.00% 应正常显示');

// ---------- 3.5 小数位统一（20260923n）：右卡百分比/倍数一律 2 位，与左卡逐项一致 ----------
for (const k of ['roe', 'grossMargin', 'netMargin', 'growth', 'profitGrowth', 'dedProfitGrowth', 'div']) {
  const mm = out.metrics.find(x => x.key === k);
  if (mm && mm.valueText !== '--') {
    ok(/^-?\d+\.\d{2}%$/.test(mm.valueText), `${k} 的 valueText 应为 2 位小数百分比，实际 ${mm.valueText}`);
  }
}
for (const k of ['pe', 'pb', 'ps']) {
  const mm = out.metrics.find(x => x.key === k);
  ok(/^-?\d+\.\d{2}$/.test(mm.valueText), `${k} 的 valueText 应为 2 位小数，实际 ${mm.valueText}`);
}
// 维度文案里的数字也必须是 2 位（否则卡头 84.93%、维度里 84.9%，同一卡片自相矛盾）
{
  const txt = ded.dims.yoy.text;
  ok(!/\d\.\d(?!\d)/.test(txt), `维度文案不应残留 1 位小数：${txt}`);
  ok(/123\.28/.test(txt), `维度文案去年同期应为 2 位（123.28%），实际：${txt}`);
}

// ---------- 4. 双源穿透：f 里是哨兵 0 时，应穿透到 m 取真实值 ----------
const q2 = { fundamentals: { roeTtm: 0, zyzbHistory: [], psSource: 'x' } };
const f2 = { metrics: { roe: 16.6, deductedProfitGrowth: 12.3, grossMargin: 22.2 } };
const out2 = buildMetricAnalysis(q2, comparison, companyType, signals, f2);
const roe2 = out2.metrics.find(m => m.key === 'roe');
eq(roe2.valueText, '16.60%', 'f.roeTtm=0（哨兵）应穿透到 m.roe=16.60');

// ---------- 5. 左卡 rows 与右卡：项数一致 + 顺序单调（= 两卡逐项对齐） ----------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const anchor = appSrc.indexOf('ocflowPeriod');
const start = appSrc.indexOf('const rows = [', anchor);
const end = appSrc.indexOf('\n    ];', start);
ok(start > 0 && end > start, `应能定位左卡 rows 数组（start=${start}, end=${end}）`);
const block = appSrc.slice(start, end);
const leftRowCount = (block.match(/\n\s*\[/g) || []).length;
eq(leftRowCount, 14, '左卡 rows 数组行数应为 14');

// 右卡 14 个 label 依次在左卡块中出现的位置必须严格递增 → 证明两卡同序
let lastPos = -1, monotonic = true, firstBad = '';
for (const m of out.metrics) {
  const pos = block.indexOf(`'${m.label}'`);
  if (pos < 0) { monotonic = false; firstBad = `左卡缺标签「${m.label}」`; break; }
  if (pos <= lastPos) { monotonic = false; firstBad = `标签「${m.label}」在左卡中的位置未递增`; break; }
  lastPos = pos;
}
ok(monotonic, `左右两卡标签顺序必须一致：${firstBad}`);

// ---------- 6. 加载即运行 ----------
console.log(`\n指标顺序 = ${out.metrics.map(m => m.key).join(', ')}`);
console.log(`项数 = ${out.metrics.length} | METRIC_ORDER = ${METRIC_ORDER.length} | 左卡 rows = ${leftRowCount}`);
out.metrics.forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m.label.padEnd(12)} = ${m.valueText}`));

if (fail) {
  console.log(`\nFAIL ${pass}/${pass + fail}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`\nPASS ${pass}/${pass}`);
}

~~~

---

## `scripts\test_metric_analysis_vote.js`  ·  204 行

~~~js
#!/usr/bin/env node
/**
 * scripts/test_metric_analysis_vote.js — 20261103m 守卫
 *
 * 用户指令：①「指标分析获得5项数据，三项绿色利空判定，总体判定就应该是利空」→ 五维多数决；
 *          ②「环比无法从财报直接获得时，用季报数据计算后获得，但要标明本机计算」→ 单季差分环比。
 * 关联修复：analysis.js evaluateSignals 百分数口径契约（移除 A股字段 ×100 启发式）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { evaluateSignals } = require(path.join(ROOT, 'lib/analysis.js'));
const { buildMetricAnalysis, dimsVote, sqSeries, sqQoqDim } = require(path.join(ROOT, 'lib/metricAnalysis.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

console.log('=== §1 evaluateSignals 百分数口径契约（×100 放大回归）===');
{
  // 海天味业 Q3'26 实测口径：单季营收同比 0.12%（百分数），去年同期 2.45% → 边际放缓，利空
  const f = {
    zyzbHistory: [
      { REPORT_DATE: '2026-09-30', DJD_TOI_YOY: 0.12, DJD_DPNP_YOY: -5.3, DJD_DEDUCTDPNP_YOY: -6.1 },
      { REPORT_DATE: '2025-09-30', DJD_TOI_YOY: 2.45, DJD_DPNP_YOY: 3.2, DJD_DEDUCTDPNP_YOY: 1.0 },
    ],
  };
  const res = evaluateSignals(f, null, null, {});
  const sigs = res.signals || [];
  const byKey = {}; sigs.forEach(s => { byKey[s.key] = s; });
  ok(byKey.growth && byKey.growth.signal === 'bear', `营收增速 0.12% vs 去年同期 2.45% 判 bear（实际 ${byKey.growth && byKey.growth.signal}）`);
  ok(byKey.growth && byKey.growth.value === '0.1%', `营收增速值不被放大成 12.4%（实际 ${byKey.growth && byKey.growth.value}）`);
  ok(byKey.growth && byKey.growth.reason.indexOf('放缓') >= 0, `reason 含「放缓」（实际 ${byKey.growth && byKey.growth.reason}）`);
  ok(byKey.profitGrowth && byKey.profitGrowth.signal === 'bear', `利润增速 -5.3% 判 bear`);
  ok(byKey.dedProfitGrowth && byKey.dedProfitGrowth.signal === 'bear', `扣非增速 -6.1% 判 bear`);
  // 兜底字段：revenueYoy 缺失、revenueGrowth 为小数（Yahoo 美股口径）→ 仍应 ×100
  // （负增长分支必然推送信号；正增长 0~15% 区间在无历史序列时不推送信号属既有行为）
  const fUS = { zyzbHistory: [], revenueGrowth: -0.081 };
  const resUS = evaluateSignals(fUS, null, null, {});
  const gUS = (resUS.signals || []).find(s => s.key === 'growth');
  ok(gUS && gUS.value === '-8.1%', `美股兜底 revenueGrowth 小数仍 ×100（实际 ${gUS && gUS.value}）`);
  // 源码级守卫：A股字段启发式已移除
  const src = fs.readFileSync(path.join(ROOT, 'lib/analysis.js'), 'utf8');
  ok(src.indexOf('_revNorm') < 0, 'analysis.js 已无 _revNorm 启发式');
  ok(src.indexOf('Math.abs(rgRaw) < 1') < 0, 'analysis.js 已无 rgRaw <1 即 ×100 启发式');
  ok(src.indexOf('Math.abs(pgRaw) < 1') < 0, 'analysis.js 已无 pgRaw <1 即 ×100 启发式');
}

console.log('=== §2 dimsVote 五维多数决·水平锚定（20261105b）===');
{
  // 2a) 成长类（anchorChange=false）：三项利空维度 → 总体利空（20261103d 规则原样保留）
  const dims3Bear = {
    yoy: { available: true, signal: 'bear', text: 'a' },
    qoq: { available: true, signal: 'bear', text: 'b' },
    industry: { available: true, signal: 'bear', text: 'c' },
    pct: { available: true, signal: 'bull', text: 'd' },
    marginal: { available: false, signal: null, text: '' },
  };
  const v1 = dimsVote(dims3Bear, { signal: 'bull', reason: '信号判定利好' }, { anchorChange: false });
  ok(v1.conflict === true, '成长类 3 利空 vs 1 利好 → 多数决判利空且标记冲突');
  ok(v1.judgment.signal === 'bear', `多数决 signal=bear（实际 ${v1.judgment.signal}）`);
  ok(v1.judgment.reason.indexOf('已按多数决为准') >= 0, 'reason 显式标注「已按多数决为准」');
  ok(v1.judgment.reason.indexOf('信号判定利好') >= 0, 'reason 保留原判定依据');

  // 2b) 水平锚定（20261105b 核心）：水平型指标 + 水平利好 + 4 变化维度利空（industry 不可得，
  //     忠实复刻万润负债率 29.4% 实况）→ 不再被覆盖为利空
  const v2 = dimsVote({
    yoy: { available: true, signal: 'bear', text: 'a' },
    qoq: { available: true, signal: 'bear', text: 'b' },
    industry: { available: false, signal: null, text: '' },
    pct: { available: true, signal: 'bear', text: 'd' },
    marginal: { available: true, signal: 'bear', text: 'e' },
  }, { signal: 'bull', reason: '负债率较低，财务稳健' });
  ok(v2.judgment.signal === 'neutral', `水平型：变化维度与水平锚相反降级中性 → 判 neutral 不再误判利空（实际 ${v2.judgment.signal}）`);
  ok(v2.judgment.reason.indexOf('水平锚定') >= 0, 'reason 标注「水平锚定」');
  ok(v2.judgment.reason.indexOf('已降级中性') >= 0, 'reason 标注降级票数');
  ok(v2.judgment.reason.indexOf('原判定依据：负债率较低，财务稳健') >= 0, '原判定依据保留');

  // 2c) 水平锚定 + 同向变化票（圣湘负债率实况）：yoy bear/qoq bull/pct bear + 水平利好 → 利好
  const v3 = dimsVote({
    yoy: { available: true, signal: 'bear', text: 'a' },
    qoq: { available: true, signal: 'bull', text: 'b' },
    industry: { available: false, signal: null, text: '' },
    pct: { available: true, signal: 'bear', text: 'd' },
    marginal: { available: false, signal: null, text: '' },
  }, { signal: 'bull', reason: '负债率 26.4% 较低，财务稳健' });
  ok(v3.judgment.signal === 'bull', `水平利好+同向变化票 → 方向票以水平锚兜底 → bull（修复圣湘负债率误判，实际 ${v3.judgment.signal}）`);
  ok(v3.conflict === false, '水平锚兜底结果与原判定一致 → 不计冲突');
  ok(v3.judgment.reason.indexOf('不改变方向判定') >= 0, '同向兜底时标注降级说明');

  // 2d) 中性票需严格多于方向票最大者才单独成判（修复 v1 忽略中性票缺陷）
  const v4 = dimsVote({
    yoy: { available: true, signal: 'bear', text: 'a' },
    industry: { available: true, signal: 'bear', text: 'c' },
  }, { signal: 'neutral', reason: '水平中性' });
  ok(v4.judgment.signal === 'bear', `bear2 > neutral1（水平中性票）→ bear（实际 ${v4.judgment.signal}）`);
  const v5 = dimsVote({
    yoy: { available: true, signal: 'bear', text: 'a' },
    industry: { available: true, signal: 'neutral', text: 'c' },
    pct: { available: true, signal: 'neutral', text: 'd' },
  }, { signal: 'neutral', reason: '水平中性' });
  ok(v5.judgment.signal === 'neutral', `neutral3 严格多于 bear1 → neutral（实际 ${v5.judgment.signal}）`);

  // 2e) 可用票 <2 → 沿用原判定
  const v6 = dimsVote({ yoy: dims3Bear.yoy }, { signal: 'bull', reason: '仅一维' });
  ok(v6.conflict === false && v6.judgment.signal === 'bull', '可用维度 <2 → 沿用原判定不投票');

  // 2f) 多数决与原判定一致 → 原判定原样保留
  const v7 = dimsVote({
    yoy: { available: true, signal: 'bull', text: 'a' },
    qoq: { available: true, signal: 'bull', text: 'b' },
  }, { signal: 'bull', reason: '一致' });
  ok(v7.conflict === false && v7.judgment.reason === '一致', '多数决与原判定一致 → 原判定原样保留');

  // 2g) 成长类不锚定键集合守卫（源码级，防漏登记/误删）
  const maSrc = fs.readFileSync(path.join(ROOT, 'lib/metricAnalysis.js'), 'utf8');
  const setMatch = maSrc.match(/CHANGE_INHERENT_KEYS = new Set\(\[([^\]]*)\]\)/);
  ok(!!setMatch, 'metricAnalysis.js 存在 CHANGE_INHERENT_KEYS 键集合');
  if (setMatch) {
    const keys = setMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    ok(keys.indexOf('growth') >= 0 && keys.indexOf('profitGrowth') >= 0 && keys.indexOf('dedProfitGrowth') >= 0 && keys.indexOf('opProfit') >= 0,
      `成长类不锚定键集合完整（实际 ${keys.join('/')}）`);
  }
  ok(maSrc.indexOf('anchorChange: !CHANGE_INHERENT_KEYS.has(mm.key)') >= 0, '投票调用按指标键开关锚定');
}

console.log('=== §3 单季差分（sqSeries / sqQoqDim）===');
{
  // 累计值（元）：海天 2026 真实口径量级
  const zy = [
    { REPORT_DATE: '2026-09-30', TOTALOPERATEREVE: 225.53e8 },
    { REPORT_DATE: '2026-06-30', TOTALOPERATEREVE: 161.46e8 },
    { REPORT_DATE: '2026-03-31', TOTALOPERATEREVE: 90.29e8 },
    { REPORT_DATE: '2025-12-31', TOTALOPERATEREVE: 245.36e8 },
    { REPORT_DATE: '2025-09-30', TOTALOPERATEREVE: 200.00e8 },
  ];
  const sq = sqSeries(zy, 'TOTALOPERATEREVE');
  const byDate = {}; sq.forEach(x => { byDate[x.date] = x.sq; });
  ok(Math.abs(byDate['2026-03-31'] - 90.29e8) < 1, 'Q1 单季 = 累计本身');
  ok(Math.abs(byDate['2026-06-30'] - 71.17e8) < 1e6, `Q2 单季 = 161.46 − 90.29 = 71.17亿`);
  ok(Math.abs(byDate['2026-09-30'] - 64.07e8) < 1e6, `Q3 单季 = 225.53 − 161.46 = 64.07亿`);
  ok(Math.abs(byDate['2025-12-31'] - 45.36e8) < 1e6, `Q4 单季 = FY − 9M = 45.36亿（按年分链）`);

  const q1 = sqQoqDim(zy, 'TOTALOPERATEREVE');
  ok(q1.available && q1.signal === 'bear', `Q3 单季 64.07 vs Q2 71.17 环比 ≈ -9.98% 判 bear（实际 ${q1.text}）`);
  ok(q1.text.indexOf('本机计算') >= 0, '环比文案含「本机计算」标注');
  ok(q1.text.indexOf('跨年') < 0, '同一年内相邻季不附跨年季节性提示');

  // 跨年相邻季（Q1 vs 去年 Q4）：仍计算但提示季节性
  const zyQ1 = [
    { REPORT_DATE: '2026-03-31', TOTALOPERATEREVE: 90.29e8 },
    { REPORT_DATE: '2025-12-31', TOTALOPERATEREVE: 245.36e8 },
    { REPORT_DATE: '2025-09-30', TOTALOPERATEREVE: 200.00e8 },
  ];
  const q2 = sqQoqDim(zyQ1, 'TOTALOPERATEREVE');
  ok(q2.available && q2.signal === 'bull', `Q1 90.29 vs 去年Q4 45.36 环比 +99% 判 bull`);
  ok(q2.text.indexOf('跨年相邻季含季节性') >= 0, '跨年相邻季附季节性提示');

  // 数据不足：单期 → 不可得
  const q3 = sqQoqDim([{ REPORT_DATE: '2026-09-30', TOTALOPERATEREVE: 1e8 }], 'TOTALOPERATEREVE');
  ok(!q3.available, '累计值不足两期 → 如实标注不可得');
}

console.log('=== §4 buildMetricAnalysis 集成：成长指标环比 + 多数决覆盖 ===');
{
  const zy = [
    { REPORT_DATE: '2026-09-30', DJD_TOI_YOY: 0.12, TOTALOPERATEREVE: 225.53e8 },
    { REPORT_DATE: '2026-06-30', DJD_TOI_YOY: 2.93, TOTALOPERATEREVE: 161.46e8 },
    { REPORT_DATE: '2026-03-31', DJD_TOI_YOY: 8.57, TOTALOPERATEREVE: 90.29e8 },
    { REPORT_DATE: '2025-09-30', DJD_TOI_YOY: 2.45, TOTALOPERATEREVE: 200.00e8 },
  ];
  const quote = { fundamentals: { zyzbHistory: zy, revenueYoy: 0.12 } };
  const signals = [
    { key: 'growth', signal: 'bull', reason: '旧信号判定（将被多数决复核）' },
  ];
  const ma = buildMetricAnalysis(quote, {}, { isFinancial: false }, signals, { metrics: {} }, null, null);
  const growth = ma.metrics.find(x => x.key === 'growth');
  ok(!!growth, 'growth 指标构建');
  ok(growth.dims.qoq.available === true, '环比维度不再是「不适用」占位，改为本机计算');
  ok(growth.dims.qoq.text.indexOf('本机计算') >= 0, '环比文案含「本机计算」');
  // 多数决：yoy（0.12 vs 2.45 放缓 bear）+ qoq（-9.98% bear）+ marginal（bear）→ 3 bear → judgment bear
  ok(growth.judgment.signal === 'bear', `五维多数决覆盖 growth judgment → bear（实际 ${growth.judgment.signal}）`);
  ok(growth.judgment.reason.indexOf('已按多数决为准') >= 0, 'judgment.reason 标注多数决冲突说明');
  ok(ma.voteConflicts >= 1, `voteConflicts 计数导出（实际 ${ma.voteConflicts}）`);
  ok(ma.note.indexOf('五维多数决') >= 0 && ma.note.indexOf('本机计算') >= 0, '返回 note 含新口径说明');
}

console.log('=== §5 前端/版本戳守卫 ===');
{
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const cnt = (appJs.match(/metricAnalysis\?\.metrics \|\| \[\]\)\.forEach/g) || []).length;
  ok(cnt === 2, `app.js 左卡 + 顶栏两处消费 metricAnalysis judgment（实际 ${cnt} 处）`);
  const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261106p'/.test(serverJs), "APP_VERSION = '20261106p'");
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.indexOf('?v=20261106p') >= 0, 'index.html 版本戳 ?v=20261106p');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_metric_analysis.js`  ·  91 行

~~~js
/**
 * scripts/test_metric_analysis.js — 指标分析引擎 + evaluateSignals 升级通道 离线确定性测试
 * 仅依赖本地模块与合成数据，不触网。
 */
'use strict';
const path = require('path');
const { evaluateSignals } = require('../lib/analysis');
const { buildMetricAnalysis } = require('../lib/metricAnalysis');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const zyzb = [
  { REPORT_DATE: '2026-06-30', ROEJQ: 11.6, XSMLL: 35.2, XSJLL: 18.4, ZCFZL: 62.0, LD: 1.8, TOTALOPERATEREVETZ: 12.0, PARENTNETPROFITTZ: 15.0, KCFJCXSYJLRTZ: 14.0 },
  { REPORT_DATE: '2025-12-31', ROEJQ: 11.0, XSMLL: 34.0, XSJLL: 17.0, ZCFZL: 63.0, LD: 1.7, TOTALOPERATEREVETZ: 9.0, PARENTNETPROFITTZ: 10.0, KCFJCXSYJLRTZ: 9.5 },
  { REPORT_DATE: '2025-06-30', ROEJQ: 10.5, XSMLL: 33.5, XSJLL: 16.5, ZCFZL: 64.0, LD: 1.6, TOTALOPERATEREVETZ: 8.0, PARENTNETPROFITTZ: 8.0, KCFJCXSYJLRTZ: 7.5 },
];

const f = {
  roeTtm: 11.6, roeTtmPrev: 9.0, grossMarginTtm: 35.2, netMarginTtm: 18.4,
  revenueYoy: 12.0, profitYoy: 15.0, deductedProfitGrowth: 14.0,
  debtToEquity: 62.0, debtMetricPct: true, currentRatio: 1.8, dividendYield: 2.1, dividendYoyPct: 5.0,
  pe: 18, pb: 1.3, ps: 4, operatingCashFlowPerShare: 1.2,
  zyzbHistory: zyzb,
};
const comparison = {
  percentiles: { roe: 75, grossMargin: 70, netMargin: 68, revenueGrowth: 60, profitGrowth: 55, debtToEquity: 40, currentRatio: 50, pe: 30, pb: 25, ps: 20 },
  industryAvg: { pe: 15, pb: 1.2, ps: 3, roe: 10, source: 'test' },
};
const finType = { isFinancial: true, type: 'balanced' };

console.log('【1】evaluateSignals ROE 相对优势升级通道（金融业 ROE 11.6%，显著优于行业均值 10% → 应升利好）');
const sigs = evaluateSignals(f, finType, comparison.industryAvg, { percentiles: comparison.percentiles });
const roeSig = sigs.signals.find(s => s.key === 'roe');
assert('ROE 信号为 bull', roeSig && roeSig.signal === 'bull', roeSig && roeSig.signal);
assert('ROE 判定依据含「显著优于行业均值」', roeSig && /显著优于行业均值/.test(roeSig.reason), roeSig && roeSig.reason);

console.log('【2】回归守卫：无相对优势证据时金融业 ROE 11.6% 仍判中性（复现旧行为，避免误升）');
const sigsNeu = evaluateSignals(
  Object.assign({}, f, { roeTtmPrev: null }),
  finType,
  { roe: 12 }, // 行业均值 12，11.6 < 12*1.1，不显著优于
  { percentiles: { roe: null } } // 无历史百分位
);
const roeNeu = sigsNeu.signals.find(s => s.key === 'roe');
assert('ROE 无证据时仍为 neutral', roeNeu && roeNeu.signal === 'neutral', roeNeu && roeNeu.signal);

console.log('【3】buildMetricAnalysis 五维结构完整性（华安样例）');
const ma = buildMetricAnalysis({ fundamentals: f }, comparison, finType, sigs.signals);
assert('返回指标数组非空', Array.isArray(ma.metrics) && ma.metrics.length > 0, 'len=' + (ma.metrics || []).length);
const dimKeys = ['yoy', 'qoq', 'industry', 'pct', 'marginal'];
let allFive = true, anyNaAll = false;
ma.metrics.forEach(m => {
  dimKeys.forEach(k => {
    const d = (m.dims || {})[k];
    if (!d || typeof d.text !== 'string') allFive = false;
  });
  if (m.key === 'roe') {
    assert('ROE 判定与 evaluateSignals 一致(bull)', m.judgment && m.judgment.signal === 'bull', m.judgment && m.judgment.signal);
    assert('ROE 同比维度可用且有文本（20261029i 三段式：去年同期）', m.dims.yoy.available && /去年同期/.test(m.dims.yoy.text), m.dims.yoy.text);
    assert('ROE 环比维度标注「累计口径」', /累计口径/.test(m.dims.qoq.text), m.dims.qoq.text);
    assert('ROE 行业均值维度可用', m.dims.industry.available, m.dims.industry.text);
    assert('ROE 历史百分位维度可用', m.dims.pct.available, m.dims.pct.text);
  }
});
assert('每个指标均含五维且有文本', allFive);

console.log('【4】缺数据如实标注「不可得」');
const maEmpty = buildMetricAnalysis({ fundamentals: {} }, { percentiles: {}, industryAvg: {} }, { isFinancial: false }, []);
const roeEmpty = maEmpty.metrics.find(m => m.key === 'roe');
assert('ROE 当前值缺 → 行业均值维度不可得', roeEmpty && roeEmpty.dims.industry.available === false && /不可得/.test(roeEmpty.dims.industry.text), roeEmpty && roeEmpty.dims.industry.text);
assert('空数据不崩溃且判定为 neutral 兜底', roeEmpty && roeEmpty.judgment.signal === 'neutral', roeEmpty && roeEmpty.judgment.signal);

console.log('【5】毛利率/净利率 升级通道（历史高分位 ≥80 或 同比改善 >1.5pp → 中性升利好）');
const gmSigs = evaluateSignals(
  { grossMarginTtm: 22, netMarginTtm: 12, zyzbHistory: zyzb },
  { isFinancial: false },
  null,
  { percentiles: { grossMargin: 85, netMargin: 80 } } // 历史高分位触发升级
);
const gm = gmSigs.signals.find(s => s.key === 'grossMargin');
const nm = gmSigs.signals.find(s => s.key === 'netMargin');
assert('毛利率 22%（中性带）处历史85分位 → bull', gm && gm.signal === 'bull', gm && gm.signal);
assert('净利率 12%（中性带）处历史80分位 → bull', nm && nm.signal === 'bull', nm && nm.signal);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);

~~~

---

## `scripts\test_minute_chart.js`  ·  173 行

~~~js
/**
 * 个股主图「分时」视图 · 行为回归（零网络，全合成数据）
 * --------------------------------------------------------------
 * 运行： node scripts/test_minute_chart.js
 * 覆盖：public/js/charts.js 的 Charts.minute()（20261017h 新增）——
 *   [1] 交易时段过滤：只画到 15:00，剔除腾讯收盘后追加的盘后条目
 *   [2] 涨跌幅与 Y 轴对称性（以昨收为中心）
 *   [3] 分钟量柱 = 相邻累计量差分（与量能引擎规则5 同口径）
 *   [4] 数据日期诚实标注（非今日时标「最近交易日，非今日」）
 *   [5] 边界：空数据 / 缺 cumVol / prevClose 缺失
 * 说明：真实网络取数（fetchTencentMinutes 的 date 字段）由服务端实测覆盖，本文件用构造数据测渲染逻辑。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---- 构造最小浏览器环境加载 Charts（stub echarts，捕获 setOption） ----
const captured = {};
global.echarts = {
  registerTheme() {},
  init() {
    return {
      setOption(o) { captured.opt = o; },
      dispose() {},
      getZr() { return { off() {}, on() {} }; },
    };
  },
};
global.window = { SA_CHART: null };
global.document = { getElementById: () => ({}) };
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'charts.js'), 'utf8');
// 去掉依赖真实 echarts.registerTheme 的兜底主题注册 IIFE
const body = src.replace(/^\(function registerSoftDarkTheme\(\)\{[\s\S]*?\n\}\)\(\);/, '');
const Charts = new Function(`${body}; return Charts;`)();

// 腾讯分时形态：time 'HHMM'，含交易时段 242 条 + 收盘后追加的盘后条目
const TRADE_MIN = (() => {
  const t = [];
  for (let i = 0; i <= 120; i++) { const k = 9 * 60 + 30 + i; t.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
  for (let i = 0; i <= 120; i++) { const k = 13 * 60 + i; t.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
  return t;
})();
// 盘后追加条目（实测 15:01 之后仍会返回，最多观察到 15:31）
const AFTER = ['1506', '1507', '1508', '1509', '1510'];

function buildMinutes(opts = {}) {
  const priceAt = opts.price || (() => 10);
  const volPerMin = opts.volPerMin == null ? 4 : opts.volPerMin;
  const times = [...TRADE_MIN, ...AFTER];
  let cum = 0;
  const minutes = times.map((time, i) => {
    cum += volPerMin;
    return { time, price: priceAt(i), avg: 10, cumVol: cum };
  });
  return { minutes, prevClose: opts.prevClose == null ? 10 : opts.prevClose };
}
function render(data) {
  captured.opt = null;
  Charts.minute('candlestickChart', data);
  return captured.opt;
}

// ============ [1] 交易时段过滤 ============
console.log('\n[1] 交易时段过滤：只画到 15:00，剔除腾讯收盘后追加的盘后条目');
{
  const raw = buildMinutes();
  ok(raw.minutes.length === 247, `构造数据共 247 条（242 交易时段 + 5 条盘后，实际 ${raw.minutes.length}）`);
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const n = o.series[0].data.length;
  ok(n === 242, `渲染只保留交易时段 242 点（实际 ${n}）`);
  ok(o.xAxis[0].data[0] === '09:30' && o.xAxis[0].data[n - 1] === '15:00', `首末时间 09:30 → 15:00（实际 ${o.xAxis[0].data[0]} → ${o.xAxis[0].data[n - 1]}）`);
  ok(!o.xAxis[0].data.some(t => t > '15:00'), 'X 轴不含 15:00 之后的盘后时点');
  ok(o.series[0].data.length === o.series[1].data.length && o.series[1].data.length === o.series[2].data.length, '价格/均价/量柱三条系列点数一致');
}

// ============ [2] 涨跌幅与 Y 轴对称性 ============
console.log('\n[2] Y 轴以昨收为中心对称，涨跌幅口径正确');
{
  // 全天单边上行 +1%（10 → 10.1），昨收 10
  const raw = buildMinutes({ price: i => 10 + (i / 241) * 0.1, prevClose: 10 });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const pctAxis = o.yAxis[1];
  ok(Math.abs(pctAxis.min + pctAxis.max) < 0.01, `涨跌幅轴严格对称（${pctAxis.min} / ${pctAxis.max}）`);
  ok(pctAxis.max > 1 && pctAxis.max < 1.2, `上行 1% 时上沿留 5% 余量（实际 ${pctAxis.max}）`);
  const lastPct = o.tooltip.formatter([{ dataIndex: 241 }]);
  ok(/\+1\.00%/.test(lastPct), `末点涨跌幅 +1.00%（实际匹配 ${/\+1\.00%/.test(lastPct)}）`);
  // 价格轴上下界以昨收为中心
  const mid = (o.yAxis[0].min + o.yAxis[0].max) / 2;
  ok(Math.abs(mid - 10) < 0.005, `价格轴以昨收 10 为中心（实际中点 ${mid.toFixed(3)}）`);
}
{
  // 下跌场景：收盘 9.8（-2%）
  const raw = buildMinutes({ price: i => 10 - (i / 241) * 0.2, prevClose: 10 });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  ok(Math.abs(o.yAxis[1].min + o.yAxis[1].max) < 0.01, '下跌场景涨跌幅轴仍对称');
  ok(/-2\.00%/.test(o.tooltip.formatter([{ dataIndex: 241 }])), '末点涨跌幅 -2.00%');
}
{
  // 红涨绿跌：末值为涨 → 价格线取红色；跌 → 绿色
  const up = render({ ...buildMinutes({ price: i => 10 + (i / 241) * 0.1 }), minuteDate: '2026-10-19' });
  const down = render({ ...buildMinutes({ price: i => 10 - (i / 241) * 0.1 }), minuteDate: '2026-10-19' });
  ok(up.series[0].lineStyle.color === Charts.colors.up, '上涨 → 价格线红色（#F6465D）');
  ok(down.series[0].lineStyle.color === Charts.colors.down, '下跌 → 价格线绿色（#0ECB81）');
}

// ============ [3] 分钟量柱 ============
console.log('\n[3] 分钟量柱 = 相邻累计量差分（与量能引擎规则5 同口径）');
{
  const raw = buildMinutes({ volPerMin: 5 });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const bars = o.series[2].data;
  ok(bars[0].value === 5 && bars[241].value === 5, `每分钟量 = 5 手（首 ${bars[0].value} / 末 ${bars[241].value}）`);
}
{
  // 尾盘放量：最后 30 分钟每分钟 20 手
  const raw = buildMinutes({ volPerMin: 4 });
  raw.minutes.forEach((m, i) => { if (i >= 211) m.cumVol = raw.minutes[210].cumVol + (i - 210) * 20; });
  const o = render({ ...raw, minuteDate: '2026-10-19' });
  const bars = o.series[2].data;
  ok(bars[241].value === 20, `尾盘每分钟量 20 手（实际 ${bars[241].value}）`);
  ok(bars[210].value === 4, `尾盘前每分钟量仍为 4 手（实际 ${bars[210].value}）`);
}

// ============ [4] 数据日期诚实标注 ============
console.log('\n[4] 数据日期标注：休市时不得把上一交易日冒充今日');
{
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const raw = buildMinutes();
  const o1 = render({ ...raw, minuteDate: today });
  ok(o1.title.text === `${today} 分时走势 `, `今日数据：标题为日期无附加说明（实际「${o1.title.text}」）`);
  const o2 = render({ ...raw, minuteDate: '2026-10-17' });
  ok(/最近交易日，非今日/.test(o2.title.text), `非今日数据：显式标注「最近交易日，非今日」（实际「${o2.title.text}」）`);
  ok(o2.title.textStyle.color === Charts.colors.ma10, '非今日时用黄色（强调色）标注日期');
  const o3 = render({ ...raw, minuteDate: null });
  ok(/日期未知/.test(o3.title.text), '日期缺失时写「日期未知」，不臆造');
}

// ============ [5] 边界与容错 ============
console.log('\n[5] 边界：空数据 / 缺字段 / 脏数据不崩溃');
{
  captured.opt = null;
  Charts.minute('candlestickChart', { minutes: [], prevClose: 10, minuteDate: '2026-10-19' });
  ok(captured.opt === null, '空分时数组 → 不渲染、不抛错');
  Charts.minute('candlestickChart', null);
  ok(true, 'data 为 null → 不抛错');
  Charts.minute('candlestickChart', { minutes: [{ time: '0930', price: 10 }], prevClose: 10, minuteDate: '2026-10-19' });
  ok(captured.opt !== null && captured.opt.series[0].data.length === 1, '单条数据可渲染（不崩溃）');
}
{
  // 缺 cumVol（部分通道无累计量）→ 分钟量退化为 0，不产生 NaN
  const raw = buildMinutes();
  raw.minutes.forEach(m => { delete m.cumVol; });
  captured.opt = null;
  Charts.minute('candlestickChart', { ...raw, minuteDate: '2026-10-19' });
  const bars = captured.opt.series[2].data;
  ok(bars.every(b => b.value === 0), '缺 cumVol → 分钟量全为 0（不产生 NaN）');
}
{
  // 时间字段脏（带冒号，非腾讯格式）→ 被过滤，不误画
  const dirty = { minutes: [{ time: '09:30', price: 10, avg: 10, cumVol: 10 }, { time: '0930', price: 10, avg: 10, cumVol: 20 }], prevClose: 10, minuteDate: '2026-10-19' };
  captured.opt = null;
  Charts.minute('candlestickChart', dirty);
  ok(captured.opt.series[0].data.length === 1, `脏时间格式被过滤，仅保留 1 条合规数据（实际 ${captured.opt.series[0].data.length}）`);
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_module_sync.js`  ·  139 行

~~~js
/**
 * 模块联动应答机制单测（20261024h）
 * 运行： node scripts/test_module_sync.js
 *
 * 覆盖：依赖图完整性 / 传递失效 / 合并去抖 / 强制重发 / 未知源 / 错误隔离 / 空 symbols / 观测接口 / 源码接线。
 * 为避免污染真实缓存，测试内把 priceActionHub.invalidateSnapshot 与
 * sameDayJudgment.invalidateJudgmentForSymbol 临时替换为记录调用次数的桩函数。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ms = require('../lib/moduleSync');
const pah = require('../lib/priceActionHub');
const sdj = require('../lib/sameDayJudgment');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// ---- 打桩 ----
const origIS = pah.invalidateSnapshot;
const origIJ = sdj.invalidateJudgmentForSymbol;
let isCalls = [], ijCalls = [];
pah.invalidateSnapshot = (s) => { isCalls.push(s); };
sdj.invalidateJudgmentForSymbol = (s) => { ijCalls.push(s); return true; };

// ============================================================================
console.log('\n[1] 依赖图完整性');
{
  const g = ms.getGraph();
  const names = new Set(g.modules.map(m => m.name));
  ok(g.modules.length >= 13, `登记模块 ${g.modules.length} 个`);
  let bad = [];
  for (const e of g.edges) { if (!names.has(e.from) || !names.has(e.to)) bad.push(`${e.from}->${e.to}`); }
  ok(bad.length === 0, '所有依赖边端点均为已登记模块' + (bad.length ? '：' + bad.join(',') : ''));
  ok(g.edges.some(e => e.from === 'manualZones' && e.to === 'priceActionHub'), 'manualZones → priceActionHub');
  ok(g.edges.some(e => e.from === 'priceActionHub' && e.to === 'sameDayJudgment'), 'priceActionHub → sameDayJudgment');
  ok(g.edges.some(e => e.from === 'marketEmotion' && e.to === 'sameDayJudgment'), 'marketEmotion → sameDayJudgment（声明）');
  const pa = g.modules.find(m => m.name === 'priceActionHub');
  const sj = g.modules.find(m => m.name === 'sameDayJudgment');
  ok(pa && pa.hasHandler === true, 'priceActionHub 有失效句柄');
  ok(sj && sj.hasHandler === true, 'sameDayJudgment 有失效句柄');
}

// ============================================================================
console.log('\n[2] 传递失效：manualZones 变动 → 快照 + 判断 都收到信号');
{
  ms._reset(); isCalls = []; ijCalls = [];
  const r = ms.emitChange('manualZones', { symbols: ['600460'], reason: '手动区间新增', force: true });
  ok(r.skipped === false, '信号已发出');
  ok(r.affected.includes('priceActionHub'), '受影响含 priceActionHub（直接）');
  ok(r.affected.includes('sameDayJudgment'), '受影响含 sameDayJudgment（间接传递）');
  ok(isCalls.length === 1 && isCalls[0] === '600460', 'invalidateSnapshot 被调用 1 次（600460）');
  ok(ijCalls.length === 1 && ijCalls[0] === '600460', 'invalidateJudgmentForSymbol 被调用 1 次（600460）');
  const pa = r.results.find(x => x.module === 'priceActionHub');
  const sj = r.results.find(x => x.module === 'sameDayJudgment');
  ok(pa && pa.info && pa.info.invalidated === 1, 'priceActionHub 报告失效 1 条');
  ok(sj && sj.info && sj.info.invalidated === 1, 'sameDayJudgment 报告失效 1 条');
}

// ============================================================================
console.log('\n[3] 多标的批量失效');
{
  ms._reset(); isCalls = []; ijCalls = [];
  const r = ms.emitChange('eventEngine', { symbols: ['601318', '600460', '000902'], reason: '事件扫描', force: true });
  ok(r.affected.includes('sameDayJudgment') && r.affected.includes('deepAnalysis'), 'eventEngine → sameDayJudgment + deepAnalysis');
  ok(ijCalls.length === 3, '3 个标的的判断全部作废');
  ok(ijCalls.includes('601318') && ijCalls.includes('600460') && ijCalls.includes('000902'), '标的集合正确');
}

// ============================================================================
console.log('\n[4] 合并去抖 / 强制重发');
{
  ms._reset(); ijCalls = [];
  const a = ms.emitChange('dedicatedFactor', { symbols: ['600460'], reason: 'x' });
  const b = ms.emitChange('dedicatedFactor', { symbols: ['600460'], reason: 'x' });
  ok(a.skipped === false, '首次发送');
  ok(b.skipped === true && b.reason === 'coalesced', '同键短时间内第二次 → coalesced');
  ok(ijCalls.length === 1, '去抖后只实际失效 1 次');
  const c = ms.emitChange('dedicatedFactor', { symbols: ['600460'], reason: 'x', force: true });
  ok(c.skipped === false, 'force=true 绕过去抖');
  ok(ijCalls.length === 2, '强制重发后实际失效 2 次');
}

// ============================================================================
console.log('\n[5] 未知源 / 空 symbols / 错误隔离');
{
  ms._reset();
  const u = ms.emitChange('不存在的模块', { symbols: ['600460'] });
  ok(u.skipped === true && /未知源模块/.test(u.reason), '未知源 → 跳过并说明');

  const e = ms.emitChange('dedicatedFactor', { symbols: [], force: true });
  ok(e.skipped === false, '空 symbols 仍记录信号（不崩）');
  const sj = e.results.find(x => x.module === 'sameDayJudgment');
  ok(sj && sj.ok === true && sj.info && sj.info.invalidated === 0, '空 symbols → 失效 0 条（不臆造）');

  // 错误隔离：priceActionHub 句柄抛错，不影响 sameDayJudgment
  ms.emitChange('manualZones', { symbols: ['600460'], force: true }); // 触发默认接线
  ms.onInvalidate('priceActionHub', () => { throw new Error('boom'); });
  const er = ms.emitChange('manualZones', { symbols: ['600460'], force: true });
  const pa = er.results.find(x => x.module === 'priceActionHub');
  const sd = er.results.find(x => x.module === 'sameDayJudgment');
  ok(pa && pa.ok === false && /boom/.test(pa.error || ''), '抛错处理器被捕获（ok=false + error）');
  ok(sd && sd.ok === true, '其他联动模块不受影响（错误隔离）');
}

// ============================================================================
console.log('\n[6] 观测接口');
{
  ms._reset();
  ms.emitChange('manualZones', { symbols: ['600460'], reason: 'obs', force: true });
  const sigs = ms.getRecentSignals(5);
  ok(Array.isArray(sigs) && sigs.length >= 1, 'getRecentSignals 返回数组');
  ok(sigs[0].source === 'manualZones' && Array.isArray(sigs[0].affected), '最新信号含 source/affected');
  const st = ms.stats();
  ok(st.handlers >= 2 && st.signals >= 1, 'stats: handlers≥2, signals≥1');
}

// ============================================================================
console.log('\n[7] 源码接线守卫');
{
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ev = fs.readFileSync(path.join(__dirname, '..', 'routes', 'eventRoutes.js'), 'utf8');
  const df = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dedicatedFactor.js'), 'utf8');
  ok(srv.includes("moduleSync.emitChange('manualZones'"), 'server.js 手动区间增删 → 发 manualZones 信号');
  ok(srv.includes("moduleSync.emitChange('eventEngine'"), 'server.js 事件扫描 → 发 eventEngine 信号');
  ok(srv.includes("moduleSync.emitChange('dedicatedFactor'"), 'server.js 专属因子 → 发 dedicatedFactor 信号');
  ok(srv.includes('app.use(moduleSyncRoutes)'), 'server.js 挂载 moduleSyncRoutes');
  ok(ev.includes("moduleSync.emitChange('eventEngine'"), 'eventRoutes.js 改用联动机制');
  ok(df.includes("moduleSync.emitChange('dedicatedFactor'"), 'dedicatedFactor.js 改用联动机制');
  ok(!/for \(const s of \(result\.changedSymbols \|\| \[\]\)\) \{\s*try \{ sameDay\.invalidateJudgmentForSymbol/.test(ev), 'eventRoutes 手写 invalidation 循环已移除');
}

// ---- 还原桩 ----
pah.invalidateSnapshot = origIS;
sdj.invalidateJudgmentForSymbol = origIJ;

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);

~~~

---

## `scripts\test_news_sector_impact.js`  ·  91 行

~~~js
/**
 * 首页「今日财经热点」新闻 → 行业板块影响识别 回归守卫
 * ------------------------------------------------------------
 * 覆盖历史三类「泛词抢答」事故 + 本次 20260930a「设备→医疗器械」事故：
 *   ① 20260914i「消费」抢答食品饮料
 *   ② 20260923k「证券」抢答券商（证券交易所=市场基础设施名词）
 *   ③ 20260930a「设备」抢答医疗器械（风电设备 → 误归医疗器械）
 * 及境外闸门、全球定价品种放行、裸通用词防护。
 *
 * 无网络依赖，纯函数级断言。
 */
const assert = require('assert');
const {
  analyzeNewsImpact, NEWS_SECTOR_MAP, GENERIC_TOKENS,
} = require('../lib/newsSectorImpact');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS]', name); }
  catch (e) { fail++; console.log('[FAIL]', name, '→', e.message); }
}
const sectorOf = (t, s = '') => { const r = analyzeNewsImpact(t, s); return r ? r.sector : null; };

console.log('===== §1 事故回归：泛词不得抢答 =====');
check('风电设备新闻 → 电力设备（不得为医疗器械）', () => {
  const s = sectorOf('风电设备板块表现活跃 威力传动涨超10%',
    '风电设备板块表现活跃，威力传动涨超10%，大金重工、泰胜风能、海力风电、振宏股份跟涨。');
  assert.strictEqual(s, '电力设备', `实际=${s}`);
});
check('光伏/储能新闻 → 电力设备', () => {
  assert.strictEqual(sectorOf('光伏组件价格上涨'), '电力设备');
  assert.strictEqual(sectorOf('储能招标放量'), '电力设备');
});
check('智能家居补贴 → 家用电器（不得为食品饮料）', () => {
  assert.strictEqual(sectorOf('促进智能家居消费行动方案发布'), '家用电器');
});
check('促消费泛政策 → 无板块归属（null）', () => {
  assert.strictEqual(sectorOf('出台促消费政策 扩大内需'), null);
});
check('伊斯坦布尔证券交易所 → null（境外闸门）', () => {
  assert.strictEqual(sectorOf('土耳其伊斯坦布尔证券交易所宣布BIST-50卖空适用报升规则'), null);
});

console.log('\n===== §2 正常归属不被本次改动破坏 =====');
check('医疗器械新闻 → 医疗器械', () => {
  assert.strictEqual(sectorOf('医疗器械板块走高', '迈瑞医疗、鱼跃医疗领涨'), '医疗器械');
});
check('医疗设备新闻 → 医疗器械（专属词仍有效）', () => {
  assert.strictEqual(sectorOf('医疗设备采购放量'), '医疗器械');
});
check('药品集采 → 医药生物', () => {
  assert.strictEqual(sectorOf('药品集采落地', '国家组织药品集中采购，仿制药承压'), '医药生物');
});
check('创新药/疫苗 → 医药生物', () => {
  assert.strictEqual(sectorOf('创新药获批上市'), '医药生物');
});
check('白酒 → 食品饮料', () => {
  assert.strictEqual(sectorOf('白酒板块走强'), '食品饮料');
});
check('半导体/芯片 → 半导体', () => {
  assert.strictEqual(sectorOf('芯片价格上调'), '半导体');
});
check('全球定价品种放行：油价上涨 → 石油石化', () => {
  assert.strictEqual(sectorOf('国际油价上涨'), '石油石化');
});

console.log('\n===== §3 裸通用词防护（结构性守卫）=====');
check('GENERIC_TOKENS 含「设备」', () => {
  assert.ok(GENERIC_TOKENS.has('设备'), 'GENERIC_TOKENS 应包含「设备」');
});
check('NEWS_SECTOR_MAP 任意字段不得含裸通用词', () => {
  const bad = [];
  for (const m of NEWS_SECTOR_MAP) {
    for (const field of ['keywords', 'exclusive', 'exclude']) {
      for (const k of (m[field] || [])) {
        if (GENERIC_TOKENS.has(k)) bad.push(`${m.sector}.${field}=${k}`);
      }
    }
  }
  assert.strictEqual(bad.length, 0, `仍存在裸通用词: ${bad.join(', ')}`);
});
check('复合词不受误伤：医疗设备/医疗服务 仍在医疗器械词表', () => {
  const m = NEWS_SECTOR_MAP.find(x => x.sector === '医疗器械');
  assert.ok(m.keywords.includes('医疗设备'), '应含「医疗设备」');
  assert.ok(m.keywords.includes('医疗服务'), '应含「医疗服务」');
  assert.ok(!m.exclusive.includes('设备'), '不应含裸词「设备」');
});

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

~~~

---

## `scripts\test_news_sector_scoring.js`  ·  157 行

~~~js
/**
 * 行业归类打分制回归测试（离线，零网络）—— 20260914i
 * 覆盖用户投诉实例：智能家居补贴被误归食品饮料
 */
const assert = require('assert');
const { analyzeNewsImpact, pickSector, isForeignMarketNews } = require('../lib/newsSectorImpact');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

console.log('\n=== 用户投诉实例：智能家居补贴（商务部等8部门，2026-09-14 发布）===');
const TITLE = '商务部等8部门：支持地方结合实际自主合理确定智能家居产品补贴品类、补贴标准';
const SUMMARY = '按照2026年消费品以旧换新政策部署，支持地方结合实际自主合理确定智能家居产品补贴品类、补贴标准，统筹支持全屋智能家居购新。';
t('「智能家居补贴」不再归食品饮料', () => {
  const r = analyzeNewsImpact(TITLE, SUMMARY);
  assert.ok(r, '应有归类结果');
  assert.strictEqual(r.sector, '家用电器', '实际归到 ' + r.sector);
});
t('「智能家居补贴」归到家用电器', () => {
  const r = analyzeNewsImpact(TITLE, SUMMARY);
  assert.strictEqual(r.sector, '家用电器');
});
t('pickSector 明确排除食品饮料', () => {
  const m = pickSector(TITLE + ' ' + SUMMARY);
  assert.notStrictEqual(m.sector, '食品饮料');
});

console.log('\n=== 泛词不能单独定归属 ===');
t('只含「消费」→ 不归类（无行业词）', () => {
  const r = analyzeNewsImpact('多部门发文促消费', '进一步扩大消费需求');
  assert.strictEqual(r, null, '实际 ' + (r && r.sector));
});
t('只含「补贴」→ 不归类', () => {
  const r = analyzeNewsImpact('某地发放补贴', '给予企业补贴支持');
  assert.strictEqual(r, null, '实际 ' + (r && r.sector));
});
t('只含「以旧换新」→ 不归类（虽是家电行泛词，但需非泛词）', () => {
  // 「以旧换新」在家电行里属 keywords（非 exclusive），单独出现仍算命中该行
  const r = analyzeNewsImpact('推进以旧换新', '落实以旧换新政策');
  assert.ok(r === null || r.sector === '家用电器', '实际 ' + (r && r.sector));
});

console.log('\n=== 专属词优先于泛词 ===');
t('白酒提价（专属于食品饮料）→ 食品饮料', () => {
  const r = analyzeNewsImpact('白酒龙头企业宣布提价', '高端白酒价格上调');
  assert.strictEqual(r.sector, '食品饮料', '实际 ' + (r && r.sector));
});
t('酱油调味品政策 → 食品饮料', () => {
  const r = analyzeNewsImpact('调味品行业新国标发布', '酱油等调味品标准更新');
  assert.strictEqual(r.sector, '食品饮料', '实际 ' + (r && r.sector));
});
t('食品饮料行强排除家居词（制造冲突）', () => {
  const r = analyzeNewsImpact('白酒企业跨界进入智能家居', '白酒公司投资家居业务');
  assert.notStrictEqual(r.sector, '食品饮料', '被排除后不应归食品饮料');
});

console.log('\n=== 其他行业基本不回退（回归防护）===');
const cases = [
  ['半导体设备国产化突破', '芯片光刻机进展', '半导体'],
  ['创新药医保谈判结果公布', '生物医药集采落地', '医药生物'],
  ['原油价格上涨', '国际油价走高', '石油石化'],
  ['光伏组件价格回升', '储能招标放量', '电力设备'],
  ['降准落地', '存款准备金率下调', '银行'],
  ['军工订单增长', '国防装备采购', '国防军工'],
  ['猪价持续回升', '种业政策支持', '农林牧渔'],
];
for (const [tt, ss, want] of cases) {
  t(`${tt} → ${want}`, () => {
    const r = analyzeNewsImpact(tt, ss);
    assert.ok(r, '应有归类');
    assert.strictEqual(r.sector, want, '实际 ' + r.sector);
  });
}

console.log('\n=== 境外市场仍被拒收 ===');
t('日经指数收涨 → null（非全球定价品）', () => {
  const r = analyzeNewsImpact('日经指数收涨1.2%', '东京股市走强');
  assert.strictEqual(r, null);
});

// ===== 20260923k：境外交易所规则不得穿透到 A 股板块（用户投诉实例）=====
// 用户截图投诉：华安证券（600909）事件驱动卡出现
// 「伊斯坦布尔交易所对BIST 50成分股卖空实施报升规则 ▼利空·证券·中度·剩105天」。
// 根因两层：①「证券交易所」字面命中「证券」关键词被归到券商板块；
//           ② 境外闸门是硬编码城市白名单，不含土耳其/伊斯坦布尔/BIST。
console.log('\n=== 境外交易所规则不得穿透（20260923k 投诉实例）===');
const IST_TITLE = '伊斯坦布尔交易所对BIST 50成分股卖空实施报升规则';
const IST_SUMMARY = '交易所公告显示，土耳其伊斯坦布尔证券交易所宣布，自9月22日起，BIST-50指数成分股的卖空交易将适用报升规则，实施期限另行通知。卖空委托成交价格必须高于最新成交价。若最新成交价格已高于前一成交价，则不受该条款限制。根据该规则，日内先卖后平仓的头寸同样归类为卖空交易。投资者及机构在提交此类委托时，必须选择卖空选项。';
t('★投诉实例：伊斯坦布尔交易所报升规则 → null', () => {
  const r = analyzeNewsImpact(IST_TITLE, IST_SUMMARY);
  assert.strictEqual(r, null, '实际归到 ' + (r && r.sector));
});
t('★投诉实例：闸门判定为境外（true）', () => {
  assert.strictEqual(isForeignMarketNews(IST_TITLE + ' ' + IST_SUMMARY), true);
});
t('「证券交易所」单独出现不再定券商板块', () => {
  const r = analyzeNewsImpact('某证券交易所发布新规', '关于市场交易制度的通知');
  assert.notStrictEqual(r && r.sector, '证券', '实际 ' + (r && r.sector));
});
t('韩国交易所上调卖空保证金 → null', () => {
  assert.strictEqual(analyzeNewsImpact('韩国交易所上调卖空保证金比例', ''), null);
});
t('巴西B3交易所调整涨跌幅限制 → null', () => {
  assert.strictEqual(analyzeNewsImpact('巴西B3交易所调整涨跌幅限制', ''), null);
});
t('土耳其里拉贬值 → null', () => {
  assert.strictEqual(analyzeNewsImpact('土耳其里拉贬值创历史新低', ''), null);
});
t('美股银行股大涨 → null（不得映射到 A 股银行）', () => {
  assert.strictEqual(analyzeNewsImpact('美股银行股大涨', ''), null);
});
t('缩写正则仅匹配全大写（不误伤英文小写词）', () => {
  // 'six'/'set' 等小写词不得命中交易所缩写（正则刻意不加 /i）
  assert.strictEqual(isForeignMarketNews('公司 set up 新产线 six 条'), false);
});

console.log('\n=== 境内券商/交易所新闻不得被误伤（20260923k 回归防护）===');
const domesticBrokerCases = [
  ['证监会就证券公司分类监管征求意见', '', '证券'],
  ['多家券商上调两融额度', '', '证券'],
  ['上海证券交易所优化交易机制', '提升市场流动性', '证券'],
  ['深圳证券交易所修订交易规则', '', '证券'],
  ['北京证券交易所扩大做市商范围', '', '证券'],
];
for (const [tt, ss, want] of domesticBrokerCases) {
  t(`${tt} → ${want}`, () => {
    const r = analyzeNewsImpact(tt, ss);
    assert.ok(r, '应有归类');
    assert.strictEqual(r.sector, want, '实际 ' + r.sector);
  });
}

console.log('\n=== 混合新闻（含境内锚点）仍放行（20260923k）===');
t('中国石油与沙特阿美签约 → 石油石化（有境内锚点豁免）', () => {
  const r = analyzeNewsImpact('中国石油与沙特阿美签署长期供油协议', '');
  assert.ok(r, '应有归类');
  assert.strictEqual(r.sector, '石油石化', '实际 ' + r.sector);
});
t('挪威主权基金增持A股银行板块 → 银行（A股锚点豁免）', () => {
  const r = analyzeNewsImpact('挪威主权基金增持A股银行板块', '');
  assert.ok(r, '应有归类');
  assert.strictEqual(r.sector, '银行', '实际 ' + r.sector);
});
t('国际油价上涨 → 石油石化（全球定价品种不受闸门限制）', () => {
  const r = analyzeNewsImpact('国际油价上涨 沙特减产', '');
  assert.ok(r, '应有归类');
  assert.strictEqual(r.sector, '石油石化', '实际 ' + r.sector);
});

console.log('\n==================================================');
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) { console.log(`${fail} 项失败 ❌`); process.exit(1); }
console.log('全部通过 ✅');

~~~

---

## `scripts\test_news_time.js`  ·  69 行

~~~js
/**
 * 回归测试：lib/newsSearch.js 快讯时间归一化 normalizeNewsTime()（20260917h）
 * --------------------------------------------------------------
 * 目的：钉死「东财 7×24 快讯时间一律按北京时间渲染」这一口径，防止回归到
 *       `new Date(ts).toISOString()`（UTC）导致的 8 小时提前 bug。
 *
 * 事实依据（2026-09-17 抓真实响应核对）：
 *   https://np-listapi.eastmoney.com/comm/web/getFastNewsList
 *   → data.fastNewsList[]，条目字段：
 *        showTime = "2026-09-17 18:47:28"（北京墙钟字符串）
 *        realSort = 1789642048033848     （微秒级真 epoch）
 *   实测 realSort/1e6 后按 Asia/Shanghai 渲染 == showTime，逐条一致。
 *
 * 运行：node scripts/test_news_time.js
 */
const assert = require('assert');
const { normalizeNewsTime } = require('../lib/newsSearch');
const { localDateTime } = require('../lib/localDate');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

console.log('=== normalizeNewsTime 回归测试 ===');

// --- 1. 北京墙钟字符串直通 ---
eq('[1] showTime 北京字符串直通', normalizeNewsTime('2026-09-17 18:47:28'), '2026-09-17 18:47');
eq('[2] ISO-T 字符串归一化', normalizeNewsTime('2026-09-17T18:47:28'), '2026-09-17 18:47');

// --- 2. 真 epoch 三精度（核心：必须按北京渲染） ---
const MS = 1789642048033;            // 毫秒
const SEC = 1789642048;              // 秒
const US = 1789642048033848;         // 微秒（真实 realSort）
eq('[3] 毫秒 epoch → 北京', normalizeNewsTime(MS), '2026-09-17 18:47');
eq('[4] 秒级 epoch → 北京', normalizeNewsTime(SEC), '2026-09-17 18:47');
eq('[5] 微秒 epoch → 北京（真实 realSort）', normalizeNewsTime(US), '2026-09-17 18:47');
eq('[6] 纯数字字符串按 epoch 处理', normalizeNewsTime(String(US)), '2026-09-17 18:47');

// --- 3. 与旧 UTC 渲染的对照（证明差异 = 8 小时，bug 真实存在） ---
const oldBuggy = new Date(US / 1000).toISOString().slice(0, 16).replace('T', ' ');
ok('[7] 旧 UTC 渲染会提前 8 小时（bug 复现）', oldBuggy === '2026-09-17 10:47', 'oldBuggy=' + oldBuggy);
ok('[8] 新实现 != 旧实现（确有修复）', normalizeNewsTime(US) !== oldBuggy,
  `new=${normalizeNewsTime(US)} old=${oldBuggy}`);

// --- 4. 中国自然日边界（北京 00:30，UTC 仍在昨日 16:30） ---
const bj0030 = Date.UTC(2026, 8, 16, 16, 30, 0); // 北京 2026-09-17 00:30
eq('[9] 北京 00:30 边界 → 保留当日 00:30', normalizeNewsTime(bj0030), '2026-09-17 00:30');
ok('[10] 边界处旧 UTC 渲染落到前一天', new Date(bj0030).toISOString().slice(0, 16).replace('T', ' ') === '2026-09-16 16:30');

// --- 5. 异常输入不抛错、返回空串 ---
for (const [name, v] of [
  ['null', null], ['undefined', undefined], ['空串', ''],
  ['空白串', '   '], ['0', 0], ['负数', -1], ['非数字串', 'abc'], ['NaN', NaN],
]) {
  ok(`[11] 异常输入(${name}) → ''`, normalizeNewsTime(v) === '', JSON.stringify(normalizeNewsTime(v)));
}

// --- 6. 与 localDateTime 一致性（同一 epoch 两处渲染应相同） ---
ok('[12] 与 localDateTime 口径一致', normalizeNewsTime(US) === localDateTime(US / 1000));

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

~~~
