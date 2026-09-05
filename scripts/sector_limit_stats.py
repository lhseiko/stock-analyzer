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
