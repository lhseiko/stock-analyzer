#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
今日最热股票（东方财富涨停板池，经 akshare 直连）
--------------------------------------------------------------
用途：为首页「今日最热股票话题」卡片提供真实的热门个股与行业热度。

为什么用涨停池而不是人气榜：
  本机东财 push2（含 stock_hot_rank_em 人气榜）被封/限流，返回 RemoteDisconnected；
  而 stock_zt_pool_em（涨停板池）走 datacenter 通道，实测稳定可用。
  当日涨停股本身就是最热标的，且其「所属行业」字段可直接聚合为行业级热点话题，
  无需 LLM 也能产出真实话题。

输出：单行 JSON
  {"ok":true,"source":"...","date":"20260830","total":82,
   "industries":[{"name":"证券Ⅱ","count":5,"stocks":[{"code","name","changePct","streak"}]}],
   "items":[{"rank","code","name","changePct","price","amount","turnover","streak","industry"}]}

行为：industries 按涨停家数降序；items 按连板数→成交额降序取前 N。
任何异常都转成 {"ok":false,"error":...} 并 exit 0，绝不抛给调用方。
"""
import sys
import json
import re
import time

sys.dont_write_bytecode = True


def _out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=str))
    return 0


def _fail(err):
    return _out({'ok': False, 'error': str(err)[:300], 'items': [], 'industries': []})


def _safe_float(v, default=None):
    try:
        s = str(v).replace('%', '').replace(',', '').strip()
        return float(s) if s else default
    except (ValueError, TypeError):
        return default


def _norm_code(raw):
    s = str(raw or '').strip()
    m = re.search(r'(\d{6})', s)
    return m.group(1) if m else s


def _streak(v):
    """连板数：接口给的是「连板数」列，可能是 int 或形如 '3' 的字符串。"""
    n = _safe_float(v, 1)
    if n is None:
        return 1
    return int(n) if n >= 1 else 1


def _fetch_zt_pool(date_str):
    import akshare as ak
    last_err = None
    for i in range(3):
        try:
            df = ak.stock_zt_pool_em(date=date_str)
            if df is not None and len(df) > 0:
                return df
        except Exception as e:
            last_err = e
        if i < 2:
            time.sleep(1.0 * (i + 1))
    raise RuntimeError('stock_zt_pool_em 失败(重试3次): %s' % last_err)


def main():
    from datetime import datetime
    date_str = datetime.now().strftime('%Y%m%d')

    try:
        import akshare as ak
    except Exception as e:
        return _fail('akshare 未安装: %s' % e)

    try:
        df = _fetch_zt_pool(date_str)
    except Exception as e:
        return _fail(str(e))

    col = {c: c for c in df.columns}
    items = []
    for idx, row in df.iterrows():
        name = str(row.get(col.get('名称', '名称'), '')).strip()
        code = _norm_code(row.get(col.get('代码', '代码'), ''))
        if not name:
            continue
        items.append({
            'rank': int(_safe_float(row.get(col.get('序号', '序号'), idx + 1), idx + 1) or (idx + 1)),
            'code': code,
            'name': name,
            'changePct': _safe_float(row.get(col.get('涨跌幅', '涨跌幅'), None)),
            'price': _safe_float(row.get(col.get('最新价', '最新价'), None)),
            'amount': _safe_float(row.get(col.get('成交额', '成交额'), None)),
            'turnover': _safe_float(row.get(col.get('换手率', '换手率'), None)),
            'streak': _streak(row.get(col.get('连板数', '连板数'), 1)),
            'industry': str(row.get(col.get('所属行业', '所属行业'), '') or '').strip() or '其他',
        })

    if not items:
        return _fail('涨停池解析后无有效条目')

    # 按行业聚合（涨停家数降序），行业内存量按连板数→成交额降序
    ind_map = {}
    for it in items:
        ind_map.setdefault(it['industry'], []).append(it)
    industries = []
    for ind, arr in ind_map.items():
        arr_sorted = sorted(arr, key=lambda x: (-(x['streak'] or 1), -(x['amount'] or 0)))
        industries.append({
            'name': ind,
            'count': len(arr_sorted),
            'stocks': [{
                'code': s['code'], 'name': s['name'],
                'changePct': s['changePct'], 'streak': s['streak'],
            } for s in arr_sorted[:5]],
        })
    industries.sort(key=lambda x: -x['count'])

    items.sort(key=lambda x: (-(x['streak'] or 1), -(x['amount'] or 0)))
    return _out({
        'ok': True,
        'source': '东方财富涨停板池(akshare stock_zt_pool_em)',
        'date': date_str,
        'total': len(items),
        'industries': industries[:12],
        'items': items[:30],
    })


if __name__ == '__main__':
    sys.exit(main() or 0)
