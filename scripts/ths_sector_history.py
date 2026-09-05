#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
同花顺行业板块历史成交额抓取（用于行业拥挤度历史回填）
============================================================
与首页「行业板块拥挤度」模块同源：分子/分母均来自同花顺·行业板块成交额
（同花顺行业指数成交额 = 板块成分股成交汇总，与板块总成交额同口径），
满足「同一指标单一数据源」红线。

数据源：akshare.stock_board_industry_index_ths（同花顺行业指数历史日线，
底层走 d.10jqka.com.cn，沙箱内可达；东财 push2his 在沙箱被封，故不用）。

输出（JSON，utf-8）：
{
  "ok": true,
  "days": {
     "2026-08-21": {"marketTotal": 12345.67, "sectors": [{"name","amount(亿)","crowding","changePct"}...]},
     ...
  },
  "count": N, "boardCount": 90, "failures": 0, "source": "同花顺·行业板块"
}

用法：
  python ths_sector_history.py --days 21
  python ths_sector_history.py --days 21 --end 20260824
"""
import argparse
import json
import sys
from datetime import datetime, timedelta

# Windows 下强制 stdout 使用 utf-8，避免中文行业名被系统默认代码页（GBK）破坏
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

try:
    import akshare as ak
except Exception as e:  # akshare 未安装时给出明确提示
    print(json.dumps({"ok": False, "error": "akshare 未安装: %s" % e}, ensure_ascii=False))
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=21, help='回填交易日数量（默认 21 ≈ 1 月）')
    ap.add_argument('--end', type=str, default='', help='截止日期 YYYYMMDD，默认今天')
    args = ap.parse_args()

    now = datetime.now()
    end_date = args.end or now.strftime('%Y%m%d')
    # 起始年份：年初（若当前在 1-2 月则前推一年），保证有 >= days 个交易日
    start_year = now.year if now.month > 2 else now.year - 1
    start_date = '%d0101' % start_year

    # 1) 同花顺行业板块名称列表（含 code；index_ths 内部用 name 查 code）
    try:
        name_df = ak.stock_board_industry_name_ths()
    except Exception as e:
        print(json.dumps({"ok": False, "error": "获取板块列表失败: %s" % e}, ensure_ascii=False))
        sys.exit(3)
    name_col = next((c for c in name_df.columns if 'name' in str(c).lower()), None) or name_df.columns[0]
    names = [str(x) for x in name_df[name_col].tolist() if x]

    # 2) 逐板块拉历史指数日线，按日期聚合成交额 + 计算涨跌幅
    by_date = {}     # date -> {name: (amount_yuan, changePct)}
    failures = 0
    for nm in names:
        try:
            df = ak.stock_board_industry_index_ths(symbol=nm, start_date=start_date, end_date=end_date)
        except Exception:
            failures += 1
            continue
        if df is None or getattr(df, 'empty', True) or len(df) == 0:
            failures += 1
            continue
        # 列名兼容
        date_col = next((c for c in df.columns if '日期' in str(c)), df.columns[0])
        amt_col = next((c for c in df.columns if '成交额' in str(c)), None)
        close_col = next((c for c in df.columns if '收盘' in str(c)), None)
        if not amt_col or not close_col:
            failures += 1
            continue
        df = df.sort_values(date_col).reset_index(drop=True)
        closes = []
        for _, row in df.iterrows():
            d = str(row[date_col])[:10]
            try:
                amt = float(row[amt_col])
            except Exception:
                amt = 0.0
            closes.append(float(row[close_col]))
            i = len(closes) - 1
            chg = None
            if i > 0 and closes[i - 1]:
                chg = round((closes[i] / closes[i - 1] - 1) * 100, 2)
            by_date.setdefault(d, {})[nm] = (amt, chg)

    # 3) 仅保留最近 --days 个交易日，并计算拥挤度（分母=当日全板块成交额合计）
    dates = sorted(by_date.keys())[-args.days:]
    out_days = {}
    for d in dates:
        sectors_d = by_date[d]
        total = sum(v[0] for v in sectors_d.values())
        if total <= 0:
            continue
        secs = []
        for nm, (amt, chg) in sectors_d.items():
            amt_yi = amt / 1e8
            crowding = round(amt / total * 10000) / 100
            secs.append({
                'name': nm,
                'amount': round(amt_yi, 2),
                'crowding': crowding,
                'changePct': chg,
            })
        out_days[d] = {'marketTotal': round(total / 1e8, 2), 'sectors': secs}

    print(json.dumps({
        'ok': True,
        'days': out_days,
        'count': len(out_days),
        'boardCount': len(names),
        'failures': failures,
        'source': '同花顺·行业板块',
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
