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
