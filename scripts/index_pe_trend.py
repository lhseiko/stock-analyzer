#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取三大指数近5年市盈率趋势数据
- 上证50、沪深300：乐咕乐股(legulegu.com)月度滚动市盈率(TTM)
- 科创50：东方财富·市场估值(RPT_VALUEMARKET)日频平均市盈率(TTM)，按月采样

输出JSON结构：
{
  "success": true,
  "updatedAt": "2026-08-29T...",
  "data": {
    "上证50": {"source": "乐咕乐股", "peField": "滚动市盈率", "series": [{"date":"2021-09-01","pe":...,"close":...}]},
    "沪深300": {...},
    "科创50": {"source": "东方财富·市场估值", "peField": "PE_TTM_AVG", "series": [...]}
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
    """从乐咕乐股获取月度PE序列"""
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
    cutoff = datetime.now() - relativedelta(years=YEARS)
    df = df[df["date"] >= cutoff]
    # 只保留每月最后一个数据点，避免月内日线过多
    df["ym"] = df["date"].dt.to_period("M")
    df = df.groupby("ym").tail(1).drop(columns=["ym"])
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    df["pe"] = pd.to_numeric(df["pe"], errors="coerce")
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    return df.dropna().to_dict(orient="records")

def eastmoney_kc50():
    """从东方财富市场估值获取科创50日频PE，并按月采样"""
    end = datetime.now()
    start = end - relativedelta(years=YEARS)
    start_str = start.strftime("%Y-%m-%d")
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
            # 如果最早一条已超出5年范围，可停止
            last_date = str(rows[-1].get("TRADE_DATE", "")).split()[0]
            if last_date and last_date < start_str:
                break
            if len(rows) < 500:
                break
            page += 1
        except Exception as e:
            log("[Eastmoney KC50] page %d error: %s" % (page, e))
            break

    df = pd.DataFrame(all_rows)
    if df.empty:
        return []
    df["date"] = pd.to_datetime(df["TRADE_DATE"], errors="coerce")
    df = df.dropna(subset=["date"])
    df = df.sort_values("date")
    df = df[df["date"] >= start]
    df = df.rename(columns={"CLOSE_PRICE": "close", "PE_TTM_AVG": "pe"})
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df["pe"] = pd.to_numeric(df["pe"], errors="coerce")
    # 按月采样：取每月最后一个交易日
    df["ym"] = df["date"].dt.to_period("M")
    df = df.groupby("ym").tail(1).drop(columns=["ym"])
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    return df[["date", "close", "pe"]].dropna().to_dict(orient="records")

def main():
    try:
        data = {}
        # 上证50、沪深300
        for name in ["上证50", "沪深300"]:
            log("[IndexPETrend] fetching %s from legulegu" % name)
            data[name] = {
                "source": "乐咕乐股",
                "peField": "滚动市盈率(TTM)",
                "series": legu_pe(name)
            }
        # 科创50
        log("[IndexPETrend] fetching 科创50 from Eastmoney RPT_VALUEMARKET")
        data["科创50"] = {
            "source": "东方财富·市场估值",
            "peField": "平均市盈率(TTM)",
            "series": eastmoney_kc50()
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
