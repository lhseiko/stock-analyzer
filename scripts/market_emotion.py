# -*- coding: utf-8 -*-
"""
大盘量能情绪分析模型 · 市场级数据采集（一次调用尽量取全）
------------------------------------------------------------------
输出（stdout，UTF-8 JSON）：
{
  "ok": bool,
  "date": "YYYY-MM-DD",
  "index":   { "code","name","bars":[{"date","close","vol"}] },   # 上证指数最近 ~250 交易日（vol=成交量·手）
  "breadth": { "up","down","flat","limitUp","limitDown","activePct","date" },
  "margin":  { "latest","prev","changePct","change5Pct","dates","series" },   # 沪深融资余额（亿元）
  "capital": { "mainNetToday","totalAmount","turnoverAvg","topDecileShare","sample","note" },  # 同花顺·市场资金
  "fx":      { "usdcnh","usdcny","chgPct" },
  "bond":    { "cn10y","prev","chgBp10" },
  "warnings":[...]
}

设计原则：
  · 单一权威源：每个指标只取一个来源，失败则置 null 并记 warnings（不猜、不补零）。
  · 全部 try/catch：任一子项失败不影响其余；网络异常写 warnings。
  · 单位统一：融资余额=亿元；资金=亿元；成交量=手；收益率=%。
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


# ---------- 1) 上证指数日线（腾讯，含成交量·手）----------
def fetch_index():
    df = ak.stock_zh_index_daily_tx(symbol="sh000001")
    if df is None or len(df) == 0:
        raise RuntimeError("腾讯指数日线为空")
    df = df.tail(260)
    bars = []
    for _, row in df.iterrows():
        d = row.get("date")
        ds = d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10]
        bars.append({
            "date": ds,
            "close": to_float(row.get("close")),
            "vol": to_float(row.get("amount")),   # 腾讯 amount 字段 = 成交量（手）
        })
    bars = [b for b in bars if b["close"] is not None and b["vol"] is not None]
    return {"code": "sh000001", "name": "上证指数", "bars": bars}


# ---------- 2) 市场宽度（涨跌家数 / 涨跌停）----------
def fetch_breadth():
    df = ak.stock_market_activity_legu()
    m = {}
    for _, row in df.iterrows():
        m[str(row["item"]).strip()] = row["value"]
    date_v = m.get("统计日期")
    ds = None
    if date_v is not None:
        ds = str(date_v)[:10]
    return {
        "up": int(to_float(m.get("上涨")) or 0),
        "down": int(to_float(m.get("下跌")) or 0),
        "flat": int(to_float(m.get("平盘")) or 0),
        "limitUp": int(to_float(m.get("涨停")) or 0),
        "limitDown": int(to_float(m.get("跌停")) or 0),
        "activePct": to_float(str(m.get("活跃度", "")).replace("%", "")),
        "date": ds,
        "source": "乐咕乐股·市场活跃度",
    }


# ---------- 3) 融资余额（沪深合计，亿元）----------
def fetch_margin():
    sh = ak.macro_china_market_margin_sh()
    sz = ak.macro_china_market_margin_sz()
    by_date = {}
    for df in (sh, sz):
        if df is None or len(df) == 0:
            continue
        col = None
        for c in df.columns:
            if "融资余额" in str(c):
                col = c
                break
        dcol = None
        for c in df.columns:
            if "日期" in str(c):
                dcol = c
                break
        if col is None or dcol is None:
            continue
        for _, row in df.iterrows():
            v = to_float(row.get(col))
            if v is None:
                continue
            d = row.get(dcol)
            ds = d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10]
            by_date[ds] = by_date.get(ds, 0.0) + v / 1e8  # 元 → 亿元
    if not by_date:
        raise RuntimeError("融资余额为空")
    series = sorted(by_date.items())
    dates = [d for d, _ in series]
    vals = [v for _, v in series]
    latest = vals[-1]
    prev = vals[-2] if len(vals) >= 2 else None
    idx5 = max(0, len(vals) - 6)
    base5 = vals[idx5] if len(vals) >= 6 else None
    chg1 = ((latest - prev) / prev * 100) if prev else None
    chg5 = ((latest - base5) / base5 * 100) if base5 else None
    return {
        "latest": round(latest, 1),
        "prev": round(prev, 1) if prev is not None else None,
        "changePct": round(chg1, 3) if chg1 is not None else None,
        "change5Pct": round(chg5, 3) if chg5 is not None else None,
        "date": dates[-1],
        "base5Date": dates[idx5] if base5 is not None else None,
        "source": "沪深交易所·融资余额",
    }


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
    out["index"] = safe("index", fetch_index)
    out["breadth"] = safe("breadth", fetch_breadth)
    out["margin"] = safe("margin", fetch_margin)
    out["mainFund"] = safe("mainFund", fetch_main_fund)
    out["capital"] = safe("capital", fetch_capital)
    out["fx"] = safe("fx", fetch_fx)
    out["bond"] = safe("bond", fetch_bond)
    out["warnings"] = WARN
    ok_count = sum(1 for k in ("index", "breadth", "margin", "mainFund", "capital", "fx", "bond") if out.get(k))
    out["ok"] = ok_count >= 3
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc(),
                          "warnings": WARN}, ensure_ascii=False))
        sys.exit(1)
