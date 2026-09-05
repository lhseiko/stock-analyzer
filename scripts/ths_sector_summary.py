#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
调用 akshare 获取同花顺行业板块一览（实时涨跌排名 + 板块总成交额）。
输出 JSON 数组，每个元素包含：code, name, changePct, amount(亿元), upCount, downCount, leader。
"""
import json
import sys
import io
import traceback
from datetime import datetime

# Windows 控制台默认 GBK，直接输出中文会乱码；强制 stdout/stderr 用 UTF-8。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

try:
    import akshare as ak
except ImportError as e:
    print(json.dumps({"error": "akshare not installed", "detail": str(e)}), file=sys.stderr)
    sys.exit(1)

def main():
    try:
        df = ak.stock_board_industry_summary_ths()
        # 字段：序号,板块,涨跌幅,总成交量,总成交额,净流入,上涨家数,下跌家数,均价,领涨股,领涨股-最新价,领涨股-涨跌幅
        records = []
        for _, row in df.iterrows():
            name = str(row['板块']).strip()
            change = float(row['涨跌幅']) if pd_notna(row['涨跌幅']) else 0.0
            # 总成交额原始单位：元 → 转 亿元（1 亿 = 1e8）
            amount_raw = row['总成交额'] if pd_notna(row['总成交额']) else 0.0
            try:
                amount_yi = float(amount_raw) / 1e8
            except (ValueError, TypeError):
                amount_yi = 0.0
            up = int(row['上涨家数']) if pd_notna(row['上涨家数']) else 0
            down = int(row['下跌家数']) if pd_notna(row['下跌家数']) else 0
            leader = str(row['领涨股']).strip() if pd_notna(row['领涨股']) else ''
            records.append({
                "code": '',
                "name": name,
                "changePct": change,
                "amount": round(amount_yi, 2),   # 板块当日总成交额（亿元）
                "upCount": up,
                "downCount": down,
                "leader": leader,
            })
        result = {
            "source": "同花顺·行业板块",
            "total": len(records),
            "date": datetime.now().strftime('%Y-%m-%d'),
            "sectors": records,
        }
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)

def pd_notna(v):
    import pandas as pd
    return pd.notna(v)

if __name__ == '__main__':
    main()
