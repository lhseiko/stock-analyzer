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
        block['note'] = '当日龙虎榜明细无数据（非交易日或接口不可用），本项标注「缺失」'
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
    a = p.parse_args()
    d, pd = a.date.strip(), a.prev_date.strip()
    hist_dates = [x.strip() for x in a.hist_dates.strip().split(',') if x.strip()]
    out = {
        'ok': True, 'date': d, 'prevDate': pd or None,
        'fetchedAt': datetime.now().isoformat(timespec='seconds'),
        'source': 'akshare（东方财富涨停股池 / 炸板池 / 跌停池 / 龙虎榜明细）',
        'ladder': None, 'lhb': None,
        'prevPool': None, 'sectors': None, 'activity': None, 'historySeries': [],
        'issues': [],
    }
    try:
        import akshare as ak
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
