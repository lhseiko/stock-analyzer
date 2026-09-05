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
