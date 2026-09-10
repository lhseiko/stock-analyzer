#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同花顺行业指数日线历史行情抓取（单板块）
=====================================
供个股「行业分析」页绘制行业指数 K 线走势（蜡烛图 + 均线 + 成交量）。

数据源：akshare.stock_board_industry_index_ths(symbol, start_date, end_date)
        底层走同花顺 d.10jqka.com.cn，沙箱内可达；东方财富 push2his 被封，故不用。

输入：
  --name  板块名称（如"保险"）
  --days  往前取多少个交易日（默认 250 ≈ 1 年）
  --end   结束日期 YYYYMMDD（默认今天）

输出（JSON，utf-8）：
{
  "ok": true,
  "name": "保险",
  "code": "881156",
  "tradeDate": "2026-08-26",
  "data": [
    {"date":"2025-08-26","open":...,"high":...,"low":...,"close":...,"volume":...,"amount":...},
    ...
  ],
  "source": "同花顺·行业板块"
}
"""
import argparse
import json
import os
import sys
import io
import time
import traceback
from datetime import datetime, timedelta

# Windows 控制台默认 GBK，强制 UTF-8 输出
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

# ---------------------------------------------------------------
# 20260911 修复：本机网络阻断 d.10jqka.com.cn:443（ConnectTimeout），
# 但同一主机 80 端口可达。akshare 源码写死 https://d.10jqka.com.cn/v4/line/...
# 因此这里对 requests.get 打一个「仅该主机」的 scheme 降级补丁：
# 先按原样请求 https，失败（超时/连接被拒）再自动改用 http 重试。
# 只影响该主机的 URL，其他请求（板块列表 q.10jqka.com.cn 等）完全不受影响。
# ---------------------------------------------------------------
import requests as _requests
# 本机系统代理(HTTP_PROXY=127.0.0.1:xxxxx)会挂起/阻断同花顺请求（项目既有教训）：
# 出图脚本全程强制直连，并清掉进程内代理环境变量（防止其他库再读）。
for _k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
    os.environ.pop(_k, None)

_orig_get = _requests.get


def _get_with_ths_fallback(url, *args, **kwargs):
    kwargs.setdefault('timeout', 12)
    kwargs['proxies'] = {'http': None, 'https': None}   # 强制直连
    if isinstance(url, str) and url.startswith('https://d.10jqka.com.cn/'):
        try:
            return _orig_get(url, *args, **kwargs)
        except Exception:
            # 443 被本机网络阻断时自动降级 80（同主机 http 可达）
            return _orig_get('http://' + url[len('https://'):], *args, **kwargs)
    return _orig_get(url, *args, **kwargs)


_requests.get = _get_with_ths_fallback

try:
    import akshare as ak
except ImportError as e:
    print(json.dumps({"ok": False, "error": "akshare 未安装: %s" % e}, ensure_ascii=False))
    sys.exit(2)

# 板块名 → 代码 缓存（网络/反爬异常时回退，避免整图失败）
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOARD_CACHE = os.path.join(BASE, 'data', 'cache', 'ths_industry_boards.json')
BOARD_CACHE_TTL = 7 * 24 * 3600


def _read_board_cache():
    try:
        if not os.path.exists(BOARD_CACHE):
            return None
        with open(BOARD_CACHE, 'r', encoding='utf-8') as f:
            obj = json.load(f)
        pairs = obj.get('pairs')
        if isinstance(pairs, list) and pairs:
            return pairs
    except Exception:
        pass
    return None


def _write_board_cache(pairs):
    try:
        os.makedirs(os.path.dirname(BOARD_CACHE), exist_ok=True)
        tmp = BOARD_CACHE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'ts': time.time(), 'pairs': pairs}, f, ensure_ascii=False)
        os.replace(tmp, BOARD_CACHE)
    except Exception:
        pass


def get_board_pairs():
    """返回 [(板块名, 代码)]。优先实时拉取并写缓存；实时失败时回退缓存（不阻塞出图）。"""
    try:
        name_df = ak.stock_board_industry_name_ths()
        pairs = []
        for _, r in name_df.iterrows():
            try:
                pairs.append((str(r['name']).strip(), str(r['code']).strip()))
            except Exception:
                continue
        if pairs:
            _write_board_cache(pairs)
            return pairs, 'live'
        raise ValueError('板块列表为空')
    except Exception as e:
        cached = _read_board_cache()
        if cached:
            return cached, 'cache(%s)' % str(e)[:40]
        raise


def normalize_name(s):
    return str(s or '').strip().replace(' ', '')


# 行业细化后缀白名单：当「短名 + 以下后缀」构成某板块名时，才认为该板块是短名的合理细化，
# 接受子串匹配。目的：避免"电子"误命中"电子化学品"、"医药"误命中"医药商业"等跨概念误判。
# 注意：故意不包含"商业""化学品"等会把短名引向不同概念的 suffix。
REFINEMENT_SUFFIXES = (
    '制造', '加工', '设备', '服务', '产业', '元器件', '制品', '材料', '零部件', '整车',
    '科技', '技术', '用品', '器械', '能源', '发电', '电池', '化工', '生物', '药品', '医疗',
    '食品', '饮料', '金融', '证券', '银行', '保险', '地产', '汽车', '机械', '电子',
)


def _is_refinement(prefix, full):
    """full 是否等于 prefix + 白名单后缀（含前缀本身是后缀子串的情况）。"""
    if not full.startswith(prefix) or len(full) <= len(prefix):
        return False
    suf = full[len(prefix):]
    return suf in REFINEMENT_SUFFIXES or any(suf.startswith(s) for s in REFINEMENT_SUFFIXES)


def find_sector_name(target, pairs):
    """按名称匹配同花顺板块列表；优先精确，再「短名+白名单后缀」的合理细化，杜绝跨概念误命中。
    pairs: [(板块名, 代码)]"""
    t = normalize_name(target)
    names = [normalize_name(p[0]) for p in pairs]
    # 1) 精确匹配
    for i, n in enumerate(names):
        if n == t:
            return pairs[i][0], pairs[i][1]
    # 2) target 为板块名的合理细化前缀（target 短、板块长，且板块=target+白名单后缀）
    for i, n in enumerate(names):
        if _is_refinement(t, n):
            return pairs[i][0], pairs[i][1]
    # 3) 板块名为 target 的合理细化前缀（板块短、target 长）
    for i, n in enumerate(names):
        if _is_refinement(n, t):
            return pairs[i][0], pairs[i][1]
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True, help='同花顺行业板块名称（如"保险"）')
    ap.add_argument('--days', type=int, default=250, help='往前取多少个交易日（默认 250 ≈ 1 年）')
    ap.add_argument('--end', type=str, default='', help='结束日期 YYYYMMDD，默认今天')
    args = ap.parse_args()

    try:
        pairs, src = get_board_pairs()
    except Exception as e:
        print(json.dumps({"ok": False, "error": "获取板块列表失败: %s" % e}, ensure_ascii=False))
        sys.exit(3)

    sector_name, sector_code = find_sector_name(args.name, pairs)
    if not sector_name:
        print(json.dumps({"ok": False, "error": "未找到名为 '%s' 的同花顺行业板块" % args.name}, ensure_ascii=False))
        sys.exit(4)

    now = datetime.now()
    end_date = args.end or now.strftime('%Y%m%d')
    # 多取 80 天以便计算 60 日均线后仍保留 --days 条
    buffer_days = max(args.days // 5, 80)
    start_dt = now - timedelta(days=args.days + buffer_days + 90)
    start_date = start_dt.strftime('%Y%m%d')

    try:
        df = ak.stock_board_industry_index_ths(symbol=sector_name, start_date=start_date, end_date=end_date)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "获取板块历史行情失败: %s" % e}, ensure_ascii=False))
        sys.exit(5)

    if df is None or getattr(df, 'empty', True) or len(df) == 0:
        print(json.dumps({"ok": False, "error": "板块 '%s' 无历史行情数据" % sector_name}, ensure_ascii=False))
        sys.exit(6)

    # 列名兼容
    col_date = next((c for c in df.columns if '日期' in str(c)), df.columns[0])
    col_open = next((c for c in df.columns if '开盘' in str(c)), None)
    col_high = next((c for c in df.columns if '最高' in str(c)), None)
    col_low = next((c for c in df.columns if '最低' in str(c)), None)
    col_close = next((c for c in df.columns if '收盘' in str(c)), None)
    col_volume = next((c for c in df.columns if '成交量' in str(c)), None)
    col_amount = next((c for c in df.columns if '成交额' in str(c)), None)

    if not all([col_open, col_high, col_low, col_close]):
        print(json.dumps({"ok": False, "error": "行情数据缺少 OHLC 列: %s" % list(df.columns)}, ensure_ascii=False))
        sys.exit(7)

    df = df.sort_values(col_date).reset_index(drop=True)
    out = []
    for _, row in df.iterrows():
        d = str(row[col_date])[:10]
        try:
            out.append({
                "date": d,
                "open": round(float(row[col_open]), 3),
                "high": round(float(row[col_high]), 3),
                "low": round(float(row[col_low]), 3),
                "close": round(float(row[col_close]), 3),
                "volume": int(row[col_volume]) if col_volume else 0,
                "amount": round(float(row[col_amount]), 6) if col_amount else 0.0,
            })
        except Exception:
            continue

    # 仅保留最近 --days 个交易日
    out = out[-args.days:]

    result = {
        "ok": True,
        "name": sector_name,
        "code": sector_code,
        "tradeDate": out[-1]["date"] if out else None,
        "data": out,
        "count": len(out),
        "source": "同花顺·行业板块",
        "boardListSrc": src,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "trace": traceback.format_exc()}, ensure_ascii=False))
        sys.exit(9)
