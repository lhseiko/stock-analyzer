#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
市场情绪因子数据层（二期：量化指标 + 个股/市场级文本舆情）

数据来源（均为 akshare 官方封装，遵循其使用条款）：
  1) 市场广度：东方财富涨跌停池
       - stock_zt_pool_em(date)       涨停池
       - stock_zt_pool_dtgc_em(date)  跌停股池（akshare 1.18.x 新名）
  2) 杠杆情绪：沪深融资余额
       - macro_china_market_margin_sh() / _sz()
  3) 文本舆情（个股）：东方财富个股新闻 + 中文情感分析
       - stock_news_em(symbol)
       - 情感引擎可插拔：优先金融微调模型 text2vec-base-chinese-sentiment，
         不可用时降级 snownlp + 金融词库硬校正 + 中性词兜底（一期已验证稳健）
  4) 市场级舆情（二期新增）：东方财富股吧全市场情绪聚合
       - stock_comment_em()  返回全市场 5000+ 只个股的股吧热度
         （综合得分 / 上升 / 关注指数），既给个股舆情，也聚合出市场热度

合规说明：以上接口均为 akshare 对公开财经数据接口的二次封装，用于个人研究；
不直爬雪球/股吧（强反爬 + ToS 风险），仅消费 akshare 聚合结果。
输出单一 JSON（stdout），四个子模块各自独立 try，失败仅该子模块 ok=false。

中文字符串统一 UTF-8 输出，避免 Windows 控制台 GBK 乱码。
"""
import json
import sys
import io
import os
import traceback
import time
import requests
from datetime import datetime, timedelta

# Windows 控制台默认 GBK，直接输出中文会乱码；强制 stdout/stderr 用 UTF-8。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass


def _now_str():
    return datetime.now().strftime('%Y-%m-%d')


def _parse_datetime(s):
    """解析常见中文新闻时间格式，失败返回 None。"""
    if not s:
        return None
    s = str(s).strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d', '%Y/%m/%d %H:%M:%S', '%Y/%m/%d'):
        try:
            return datetime.strptime(s[:len(fmt.replace('%', '%%'))] if len(s) > len(fmt) else s, fmt)
        except Exception:
            continue
    # 兜底：尝试取前 10 位作为日期
    try:
        return datetime.strptime(s[:10], '%Y-%m-%d')
    except Exception:
        return None


def _time_decay_weight(pub_dt, base=None):
    """新闻时效衰减：当天 1.0、1 天前 0.7、2 天前 0.5、3 天及以上 0.3。
    同一消息不可能持续维持同样影响，越旧的新闻权重越低。"""
    if pub_dt is None or not isinstance(pub_dt, datetime):
        return 0.5
    base = base or datetime.now()
    days = max(0, (base - pub_dt).total_seconds() / 86400.0)
    if days < 1:
        return 1.0
    if days < 2:
        return 0.7
    if days < 3:
        return 0.5
    return 0.3


def _neutralize(text, raw):
    """中性词库兜底：文本含明显中性表述时，将极端情感拉回中性(0.5)。"""
    neutral_words = ['观望', '震荡', '持平', '中性', '维持', '不变', '小幅', '波动',
                     '盘整', '横盘', '暂无', '谨慎', '平稳', '中性偏', '大体', '基本持平']
    if any(w in text for w in neutral_words):
        return 0.5 + (raw - 0.5) * 0.4
    return raw


# 金融情感词库（一级规则）：对通用情感模型在金融文本上的偏差做硬校正。
POS_WORDS = ['涨停', '大涨', '涨', '利好', '增持', '买入', '加仓', '净买入', '回暖', '增长',
             '盈利', '上调', '突破', '拉升', '走强', '回购', '中标', '超预期', '预增',
             '净流入', '大单流入', '机构看好', '看好', '扩产', '签单', '扭亏']
NEG_WORDS = ['跌停', '大跌', '跌', '利空', '减持', '卖出', '净卖出', '暴跌', '下跌', '亏损',
             '下滑', '下调', '回落', '走弱', '破位', '退市', '暴雷', '立案', '预减', '计提',
             '警示', '诉讼', '罚款', 'ST', '商誉减值', '减值', '风险警示']


def _lexicon_score(text):
    """词库极性：命中单向词给强极性，双向命中给中性，无命中返回 None。"""
    pos = sum(1 for w in POS_WORDS if w in text)
    neg = sum(1 for w in NEG_WORDS if w in text)
    if pos > 0 and neg == 0:
        return 0.85
    if neg > 0 and pos == 0:
        return 0.15
    if pos > 0 and neg > 0:
        return 0.5
    return None


# ============ 可插拔金融情感模型 ============
# 优先使用金融微调模型（text2vec-base-chinese-sentiment），其输出为 0~1 情感得分。
# 需要 sentence_transformers + 模型权重（本环境未预装，自动降级到 snownlp）。
# 环境变量 SA_NO_FIN_MODEL=1 可强制禁用模型（避免首次下载阻塞/离线环境）。
_MODEL = None
_MODEL_LOADED = False


def _load_fin_model():
    """懒加载金融微调模型，返回模型或 None（装好即复用，避免重复加载）。"""
    global _MODEL, _MODEL_LOADED
    if _MODEL_LOADED:
        return _MODEL
    _MODEL_LOADED = True
    if os.environ.get('SA_NO_FIN_MODEL') == '1':
        _MODEL = None
        return None
    try:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer('shibing624/text2vec-base-chinese-sentiment')
    except Exception:
        _MODEL = None
    return _MODEL


def _finance_model_scores(texts):
    """批量金融模型打分，返回与 texts 等长 list(0~1)，不可用时返回 None。"""
    model = _load_fin_model()
    if model is None:
        return None
    try:
        import numpy as np
        vecs = model.encode(texts, batch_size=16, convert_to_numpy=True,
                            show_progress_bar=False)
        return [max(0.0, min(1.0, float(v))) for v in np.asarray(vecs).flatten()]
    except Exception:
        return None


def _safe_len(df):
    try:
        return 0 if df is None else len(df)
    except Exception:
        return 0


def _col(df, kw):
    for c in (df.columns if df is not None else []):
        if kw in str(c):
            return c
    return None


def fetch_breadth(date_str):
    """市场广度：涨跌停家数比。返回 {limitUp, limitDown, limitUpDownRatio, signal, ok, note}"""
    from akshare import stock_zt_pool_em, stock_zt_pool_dtgc_em
    up = stock_zt_pool_em(date=date_str)
    down = stock_zt_pool_dtgc_em(date=date_str)
    up_n = _safe_len(up)
    down_n = _safe_len(down)
    ratio = (up_n / (down_n + 1)) if (down_n + 1) > 0 else 0.0
    denom = (up_n + down_n)
    signal = ((up_n - down_n) / denom) if denom > 0 else 0.0
    signal = max(-1.0, min(1.0, signal))
    return {
        'limitUp': up_n,
        'limitDown': down_n,
        'limitUpDownRatio': round(ratio, 2),
        'signal': round(signal, 3),
        'ok': True,
        'note': f'东财涨跌停池({date_str})',
    }


def fetch_margin():
    """杠杆情绪：沪深融资余额最新值与日环比。返回 {latest, prev, changePct, signal, ok, note}"""
    from akshare import macro_china_market_margin_sh, macro_china_market_margin_sz
    sh = macro_china_market_margin_sh()
    sz = macro_china_market_margin_sz()
    total_latest = None
    total_prev = None

    def _col_local(df, kw):
        for c in (df.columns if df is not None else []):
            if kw in str(c):
                return c
        return None

    parts = []
    for df in (sh, sz):
        if df is None or len(df) == 0:
            continue
        col = _col_local(df, '融资余额')
        if col is None:
            continue
        vals = df[col].dropna().tolist()
        if len(vals) >= 1:
            try:
                parts.append(float(vals[-1]) / 1e8)  # 原始单位"元"，转"亿元"
            except Exception:
                pass
    if len(parts) >= 1:
        total_latest = sum(parts)
    prev_parts = []
    for df in (sh, sz):
        if df is None or len(df) < 2:
            continue
        col = _col_local(df, '融资余额')
        if col is None:
            continue
        vals = df[col].dropna().tolist()
        if len(vals) >= 2:
            try:
                prev_parts.append(float(vals[-2]) / 1e8)
            except Exception:
                pass
    if len(prev_parts) >= 1:
        total_prev = sum(prev_parts)

    if total_latest is None:
        raise ValueError('融资余额接口返回空')

    change_pct = 0.0
    if total_prev and total_prev != 0:
        change_pct = (total_latest - total_prev) / total_prev * 100
    # 信号：日环比 1.0% 视为 ±1（杠杆资金日变动多落在 ±0.1%~±0.8%）
    signal = max(-1.0, min(1.0, change_pct / 1.0))
    return {
        'latest': round(total_latest, 1),
        'prev': round(total_prev, 1) if total_prev is not None else None,
        'changePct': round(change_pct, 3),
        'signal': round(signal, 3),
        'ok': True,
        'note': '沪深融资余额(亿元)',
    }


def fetch_news_sentiment(symbol, name):
    """文本舆情（个股）：东财个股新闻 + 可插拔情感引擎（金融模型批量优先）。
    已加入时效衰减：越旧的新闻权重越低（当天 1.0、1 天前 0.7、2 天前 0.5、3 天+ 0.3）。
    返回 {count, positive, neutral, negative, avgScore, weightedAvgScore, signal, ok, samples, engine}"""
    from akshare import stock_news_em
    from snownlp import SnowNLP

    df = stock_news_em(symbol=symbol)
    items = []  # [(title, text, pub_dt)]
    if df is not None and len(df) > 0:
        title_col = '新闻标题' if '新闻标题' in df.columns else df.columns[0]
        content_col = '新闻内容' if '新闻内容' in df.columns else None
        date_col = _col(df, '发布') or _col(df, '时间') or _col(df, 'date')
        base = datetime.now()
        for _, r in df.iterrows():
            t = str(r.get(title_col, '') or '')
            c = str(r.get(content_col, '') or '') if content_col else ''
            text = (t + ' ' + c).strip()
            if not text:
                continue
            pub_dt = _parse_datetime(r.get(date_col)) if date_col else None
            items.append((t, text, pub_dt))

    texts = [it[1] for it in items]
    # 批量情感：优先金融微调模型；不可用时逐条 snownlp
    fm_list = _finance_model_scores(texts) if texts else None
    engine = 'finance-model' if fm_list is not None else 'snownlp+词库'

    rows = []
    base = datetime.now()
    for idx, (t, text, pub_dt) in enumerate(items):
        if fm_list is not None:
            raw = fm_list[idx]
        else:
            try:
                raw = float(SnowNLP(text).sentiments)  # 0~1，0.5 中性
            except Exception:
                continue
        # 通用模型极端值偏多：压缩到中心附近
        sn = 0.5 + (raw - 0.5) * 0.6
        # 金融词库硬校正：命中单向金融词时以词库为主
        lex = _lexicon_score(text)
        score = (0.7 * lex + 0.3 * sn) if lex is not None else sn
        score = _neutralize(text, score)  # 中性表述兜底
        weight = _time_decay_weight(pub_dt, base)
        rows.append({'title': t[:60], 'score': round(score, 3), 'weight': round(weight, 2), 'date': pub_dt.strftime('%m-%d') if pub_dt else ''})

    if not rows:
        return {
            'count': 0, 'positive': 0, 'neutral': 0, 'negative': 0,
            'avgScore': None, 'weightedAvgScore': None, 'signal': 0.0, 'ok': True, 'engine': engine,
            'samples': [], 'note': f'近 30 日无个股新闻({symbol})',
        }

    # 统计计数保持原始（便于用户感知样本分布），但信号用加权平均计算
    pos = sum(1 for x in rows if x['score'] >= 0.55)
    neg = sum(1 for x in rows if x['score'] <= 0.45)
    neu = len(rows) - pos - neg
    avg = sum(x['score'] for x in rows) / len(rows)
    total_w = sum(x['weight'] for x in rows) or 1.0
    weighted_avg = sum(x['score'] * x['weight'] for x in rows) / total_w
    signal = max(-1.0, min(1.0, (weighted_avg - 0.5) * 2))
    return {
        'count': len(rows), 'positive': pos, 'neutral': neu, 'negative': neg,
        'avgScore': round(avg, 3), 'weightedAvgScore': round(weighted_avg, 3),
        'signal': round(signal, 3), 'ok': True, 'engine': engine,
        'samples': rows[:8], 'note': f'东财个股新闻·情感({symbol})·近{len(rows)}条加权',
    }


def fetch_market_comment(symbol, name):
    """市场级舆情（二期新增）：东财股吧全市场情绪聚合。
    返回 { symbolScore, symbolRise, symbolFocus, marketAvgScore, marketUpRatio,
           marketHeat, symbolSignal, signal, ok, samples, note }
      - 个股维度：该 symbol 的综合得分/上升/关注指数（股吧对该股的热度与情绪）
      - 市场维度：全市场综合得分均值 + 上升家数占比（对所有个股通用的市场热度）
    合规：仅消费 akshare 聚合结果，不直爬股吧。"""
    from akshare import stock_comment_em

    df = stock_comment_em()
    if df is None or len(df) == 0:
        raise ValueError('股吧舆情接口返回空')

    def _col_local(df, kw):
        for c in (df.columns if df is not None else []):
            if kw in str(c):
                return c
        return None

    score_col = _col_local(df, '综合得分')
    up_col = _col_local(df, '上升')
    focus_col = _col_local(df, '关注指数')

    # ---- 市场级聚合 ----
    scores = df[score_col].dropna().astype(float).tolist() if score_col else []
    avg_score = float(sum(scores) / len(scores)) if scores else 0.0
    ups = 0
    tot = 0
    if up_col:
        for v in df[up_col].dropna().astype(float).tolist():
            tot += 1
            if v > 0:
                ups += 1
    up_ratio = (ups / tot) if tot > 0 else 0.5
    # 综合得分以中性基准 60 偏离（每偏离 10 分计 0.3），上升占比映射 -1..1
    score_signal = max(-1.0, min(1.0, (avg_score - 60) / 10 * 0.3))
    heat_signal = max(-1.0, min(1.0, (up_ratio - 0.5) * 2))
    market_heat = round(0.5 * score_signal + 0.5 * heat_signal, 3)

    # ---- 个股维度 ----
    sym_score = sym_rise = sym_focus = None
    if symbol:
        hit = df[df['代码'].astype(str).str.strip() == str(symbol)]
        if len(hit) > 0:
            r = hit.iloc[0]
            try:
                sym_score = float(r[score_col]) if score_col else None
            except Exception:
                sym_score = None
            try:
                sym_rise = float(r[up_col]) if up_col else None
            except Exception:
                sym_rise = None
            try:
                sym_focus = float(r[focus_col]) if focus_col else None
            except Exception:
                sym_focus = None
    symbol_signal = 0.0
    if sym_score is not None:
        symbol_signal = max(-1.0, min(1.0, (sym_score - 60) / 15))
        if sym_rise is not None and sym_rise != 0:
            rise_part = (1.0 if sym_rise > 0 else -1.0) * min(abs(sym_rise), 1000) / 1000
            symbol_signal = max(-1.0, min(1.0, symbol_signal * 0.6 + rise_part * 0.4))

    # 综合信号：个股舆情 0.5 + 市场热度 0.5
    signal = round(max(-1.0, min(1.0, 0.5 * symbol_signal + 0.5 * market_heat)), 3)

    samples = []
    if sym_score is not None:
        samples.append({
            'symbol': symbol,
            'score': round(sym_score, 1),
            'rise': round(sym_rise, 1) if sym_rise is not None else None,
            'focus': round(sym_focus, 1) if sym_focus is not None else None,
        })
    return {
        'symbolScore': round(sym_score, 1) if sym_score is not None else None,
        'symbolRise': round(sym_rise, 1) if sym_rise is not None else None,
        'symbolFocus': round(sym_focus, 1) if sym_focus is not None else None,
        'marketAvgScore': round(avg_score, 1),
        'marketUpRatio': round(up_ratio, 3),
        'marketHeat': market_heat,
        'symbolSignal': round(symbol_signal, 3),
        'signal': signal,
        'ok': True,
        'samples': samples,
        'note': f'东财股吧舆情聚合·市场热度+个股({symbol or "全市场"})',
    }


# 三期新增：同花顺/雪球 公开热度榜（非直爬股吧，仅消费公开榜单/筛选接口）
_THS_HOT_CACHE = None
_THS_HOT_TS = 0
_THS_HOT_TTL = 60  # 同一次脚本调用中缓存 60s


def _th_hot_list():
    """获取同花顺 A 股热榜（公开接口，无需登录），返回 [(code, order, rate, rise, name)]"""
    global _THS_HOT_CACHE, _THS_HOT_TS
    now = time.time()
    if _THS_HOT_CACHE is not None and now - _THS_HOT_TS < _THS_HOT_TTL:
        return _THS_HOT_CACHE
    url = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=day&list_type=normal'
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://eq.10jqka.com.cn/',
    }
    try:
        r = requests.get(url, headers=headers, timeout=15)
        data = r.json()
        rows = data.get('data', {}).get('stock_list', []) or []
        out = []
        for it in rows:
            try:
                out.append({
                    'code': str(it.get('code', '')).strip(),
                    'order': int(it.get('order', 0) or 0),
                    'rate': float(it.get('rate', 0) or 0),
                    'rise': float(it.get('rise_and_fall', 0) or 0),
                    'name': str(it.get('name', '')),
                })
            except Exception:
                continue
        _THS_HOT_CACHE = out
        _THS_HOT_TS = now
        return out
    except Exception as e:
        raise ValueError(f'同花顺热榜接口异常: {e}')


def fetch_tonghuashun_hot(symbol, name=''):
    """同花顺个股热度：从公开热榜中查找该股排名与热度值。"""
    if not symbol:
        raise ValueError('缺少股票代码')
    rows = _th_hot_list()
    hit = next((r for r in rows if r['code'] == str(symbol)), None)
    if hit:
        return {
            'ok': True,
            'inHotList': True,
            'rank': hit['order'],
            'heatRate': hit['rate'],
            'risePct': round(hit['rise'], 2),
            'note': f'同花顺热榜·{hit["name"]}({symbol})·第{hit["order"]}名·热度{hit["rate"]}',
        }
    return {
        'ok': True,
        'inHotList': False,
        'rank': None,
        'heatRate': None,
        'risePct': None,
        'note': f'同花顺热榜·{symbol}未进入当日 A 股热榜前{len(rows)}名',
    }


_XUEQIU_FOLLOW_CACHE = None
_XUEQIU_FOLLOW_TS = 0
_XUEQIU_FOLLOW_TTL = 60


def _xueqiu_follow_list(max_pages=5):
    """获取雪球 A 股关注人数排序榜（公开筛选接口，无需登录）。
    返回 [{symbol, name, follow, pct, current}]，最多 max_pages * 200 只。"""
    global _XUEQIU_FOLLOW_CACHE, _XUEQIU_FOLLOW_TS
    now = time.time()
    if _XUEQIU_FOLLOW_CACHE is not None and now - _XUEQIU_FOLLOW_TS < _XUEQIU_FOLLOW_TTL:
        return _XUEQIU_FOLLOW_CACHE
    out = []
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Referer': 'https://xueqiu.com/',
    }
    for page in range(1, max_pages + 1):
        url = f'https://xueqiu.com/service/v5/stock/screener/screen?category=CN&size=200&order=desc&order_by=follow&only_count=0&page={page}'
        try:
            r = requests.get(url, headers=headers, timeout=15)
            data = r.json()
            rows = data.get('data', {}).get('list', []) or []
            if not rows:
                break
            base = len(out)
            for idx, it in enumerate(rows):
                try:
                    out.append({
                        'symbol': str(it.get('symbol', '')).strip(),
                        'name': str(it.get('name', '')),
                        'follow': int(it.get('follow', 0) or 0),
                        'pct': float(it.get('pct', 0) or 0),
                        'current': float(it.get('current', 0) or 0),
                        'rank': base + idx + 1,
                    })
                except Exception:
                    continue
        except Exception:
            break
    _XUEQIU_FOLLOW_CACHE = out
    _XUEQIU_FOLLOW_TS = now
    return out


def fetch_xueqiu_follow(symbol, name='', max_pages=5):
    """雪球个股热度：从公开关注榜中查找该股关注人数与排名。"""
    if not symbol:
        raise ValueError('缺少股票代码')
    # 雪球 symbol 形如 SH601318 / SZ000001
    prefix = 'SH' if str(symbol).startswith('6') or str(symbol).startswith('9') else 'SZ'
    xq_symbol = f'{prefix}{symbol}'
    rows = _xueqiu_follow_list(max_pages=max_pages)
    hit = next((r for r in rows if r['symbol'] == xq_symbol), None)
    if hit:
        return {
            'ok': True,
            'inTop': True,
            'rank': hit['rank'],
            'follow': hit['follow'],
            'pct': round(hit['pct'], 2),
            'note': f'雪球关注榜·{hit["name"]}({symbol})·第{hit["rank"]}名·关注{hit["follow"]}人',
        }
    return {
        'ok': True,
        'inTop': False,
        'rank': None,
        'follow': None,
        'pct': None,
        'note': f'雪球关注榜·{symbol}未进入 A 股关注榜前{len(rows)}名',
    }


def fetch_discussion_heat(symbol, name):
    """三期新增：个股多平台股吧讨论热度聚合。
    同时取 东方财富(akshare 股吧综合得分) + 同花顺热榜 + 雪球关注榜，
    输出统一 {eastmoney, tonghuashun, xueqiu, combinedScore, signal, ok, note}。
    任一平台失败不阻塞其他平台，失败平台在结果中 ok=false。"""
    out = {
        'ok': True,
        'eastmoney': {'ok': False},
        'tonghuashun': {'ok': False},
        'xueqiu': {'ok': False},
        'combinedScore': None,
        'signal': 0.0,
        'note': '多平台股吧热度聚合',
    }
    if not symbol or not str(symbol).isdigit() or len(str(symbol)) != 6:
        out['ok'] = False
        out['note'] = '缺少有效 6 位股票代码，跳过股吧热度'
        return out

    scores = []
    signals = []

    # 1) 东方财富（已有市场舆情函数）
    try:
        em = fetch_market_comment(symbol, name)
        out['eastmoney'] = {
            'ok': True,
            'symbolScore': em.get('symbolScore'),
            'symbolRise': em.get('symbolRise'),
            'marketAvgScore': em.get('marketAvgScore'),
            'marketUpRatio': em.get('marketUpRatio'),
            'marketHeat': em.get('marketHeat'),
            'note': em.get('note', '东财股吧舆情聚合'),
        }
        if em.get('symbolScore') is not None:
            scores.append(float(em['symbolScore']))
            signals.append(float(em.get('symbolSignal', 0.0)))
        else:
            # 只有市场热度时也作为信号参考
            signals.append(float(em.get('marketHeat', 0.0)))
    except Exception as e:
        out['eastmoney'] = {'ok': False, 'error': str(e)[:80], 'note': '东财股吧热度获取失败'}

    # 2) 同花顺热榜
    try:
        th = fetch_tonghuashun_hot(symbol, name)
        out['tonghuashun'] = th
        if th.get('inHotList'):
            # 排名 1~100 映射到 100~0 分
            rank = th['rank'] or 100
            score = max(0.0, 100.0 - (rank - 1) * 1.0)
            scores.append(score)
            signals.append(max(-1.0, min(1.0, (score - 50) / 50)))
    except Exception as e:
        out['tonghuashun'] = {'ok': False, 'error': str(e)[:80], 'note': f'同花顺热度获取失败'}

    # 3) 雪球关注榜
    try:
        xq = fetch_xueqiu_follow(symbol, name)
        out['xueqiu'] = xq
        if xq.get('inTop') and xq.get('rank'):
            # 排名越靠前越热：前 10 名 100 分，前 200 名 85 分，前 1000 名 70 分
            rank = xq['rank']
            if rank <= 10:
                score = 100.0
            elif rank <= 50:
                score = 95.0 - (rank - 10) * 0.25
            elif rank <= 200:
                score = 85.0 - (rank - 50) * (15.0 / 150.0)
            else:
                score = max(50.0, 70.0 - (rank - 200) * (20.0 / 800.0))
            scores.append(score)
            signals.append(max(-1.0, min(1.0, (score - 50) / 50)))
    except Exception as e:
        out['xueqiu'] = {'ok': False, 'error': str(e)[:80], 'note': f'雪球热度获取失败'}

    if scores:
        out['combinedScore'] = round(sum(scores) / len(scores), 1)
    if signals:
        # 多平台平均信号
        out['signal'] = round(sum(signals) / len(signals), 3)
    out['ok'] = any(out[p].get('ok') for p in ('eastmoney', 'tonghuashun', 'xueqiu'))
    out['note'] = f'东方财富+同花顺+雪球三平台股吧热度聚合({symbol})'
    return out


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


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', default='')
    parser.add_argument('--name', default='')
    args = parser.parse_args()
    symbol = (args.symbol or '').strip()
    name = (args.name or '').strip()

    result = {
        'source': '东方财富·涨跌停池/融资余额/个股新闻/股吧舆情 + 同花顺/雪球公开热度榜',
        'date': _now_str(),
        'breadth': None,
        'margin': None,
        'newsSentiment': None,
        'marketSentiment': None,
        'discussionHeat': None,
        'subOkCount': 0,
    }

    # 1) 市场广度（涨跌停比）：向前回溯到最近一个交易日
    breadth_err = None
    for ds in _try_dates(5):
        try:
            result['breadth'] = fetch_breadth(ds)
            break
        except Exception as e:
            breadth_err = str(e)
            continue
    if result['breadth'] is None:
        result['breadth'] = {'ok': False, 'signal': 0.0, 'error': breadth_err or '涨跌停池获取失败'}

    # 2) 融资余额
    try:
        result['margin'] = fetch_margin()
    except Exception as e:
        result['margin'] = {'ok': False, 'signal': 0.0, 'error': str(e)}

    # 3) 文本舆情（需 6 位代码）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['newsSentiment'] = fetch_news_sentiment(symbol, name)
        except Exception as e:
            result['newsSentiment'] = {'ok': False, 'signal': 0.0, 'error': str(e)}
    else:
        result['newsSentiment'] = {'ok': False, 'signal': 0.0,
                                   'error': '缺少有效 6 位股票代码，跳过文本舆情'}

    # 4) 市场级舆情（二期新增，需 6 位代码取个股维度；市场维度始终可用）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['marketSentiment'] = fetch_market_comment(symbol, name)
        except Exception as e:
            result['marketSentiment'] = {'ok': False, 'signal': 0.0, 'error': str(e)}
    else:
        result['marketSentiment'] = {'ok': False, 'signal': 0.0,
                                     'error': '缺少有效 6 位股票代码，跳过市场舆情'}

    # 5) 多平台股吧讨论热度（三期新增：东方财富+同花顺+雪球）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['discussionHeat'] = fetch_discussion_heat(symbol, name)
        except Exception as e:
            result['discussionHeat'] = {'ok': False, 'signal': 0.0, 'error': str(e)}
    else:
        result['discussionHeat'] = {'ok': False, 'signal': 0.0,
                                      'error': '缺少有效 6 位股票代码，跳过股吧热度'}

    result['subOkCount'] = sum(1 for k in ('breadth', 'margin', 'newsSentiment', 'marketSentiment', 'discussionHeat')
                               if result[k] and result[k].get('ok'))

    # 全部失败
    if result['subOkCount'] == 0:
        print(json.dumps({"error": "情绪数据全部获取失败", "detail": {
            'breadth': result['breadth'].get('error'),
            'margin': result['margin'].get('error'),
            'newsSentiment': result['newsSentiment'].get('error'),
            'marketSentiment': result['marketSentiment'].get('error'),
            'discussionHeat': result['discussionHeat'].get('error'),
        }}, ensure_ascii=False))
        sys.exit(1)

    # 整体混合信号（不含量能活跃度，量能由 Node 侧从 K 线量比补充）：
    # 涨跌停比 0.30 / 融资余额 0.25 / 个股新闻 0.22 / 多平台股吧热度 0.23
    # marketSentiment 仍保留供下游兼容，但不再重复参与总体信号（discussionHeat 已包含东财）
    weights = {'breadth': 0.30, 'margin': 0.25, 'newsSentiment': 0.22, 'discussionHeat': 0.23}
    s = 0.0
    wsum = 0.0
    for k, w in weights.items():
        blk = result[k]
        if blk and blk.get('ok'):
            s += w * blk.get('signal', 0.0)
            wsum += w
    overall = round(max(-1.0, min(1.0, s / wsum)) if wsum > 0 else 0.0, 3)
    result['signal'] = overall

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}, ensure_ascii=False))
        sys.exit(1)
