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
  5) 投资者问答（20260923h 新增，个股维度，供「个股近期热点」投资者问答子卡）
       - 沪市(60/68/900)：上证e互动 sns.sseinfo.com（交易所官方平台，需先定位公司 uid）
       - 深市(00/30/200)：巨潮互动易 irm.cninfo.com.cn（两步：查 orgId → 取问答列表）

合规说明：以上接口均为 akshare 对公开财经数据接口的二次封装，用于个人研究；
不直爬雪球/股吧（强反爬 + ToS 风险），仅消费 akshare 聚合结果。
投资者问答仅取交易所官方平台的公开问答（免登录、低频、不采集提问者昵称等个人信息）。
输出单一 JSON（stdout），各子模块各自独立 try，失败仅该子模块 ok=false。

中文字符串统一 UTF-8 输出，避免 Windows 控制台 GBK 乱码。
"""
import json
import sys
import io
import os
import re
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

# 20260911：本机系统代理(HTTP_PROXY=127.0.0.1:xxxxx)对腾讯/东财/金十等转发故障，
# 会把 akshare 请求挂起或 ProxyError（融资余额曾因此恒失败）。脚本全程强制直连，
# 并清掉进程内代理环境变量；仅影响本进程，不改系统设置。
for _pk in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
    os.environ.pop(_pk, None)

_orig_requests_get = requests.get


def _direct_get(url, *args, **kwargs):
    """强制不经过系统代理（项目既有教训：直连才通）。"""
    kwargs.setdefault('timeout', 20)
    kwargs['proxies'] = {'http': None, 'https': None}
    return _orig_requests_get(url, *args, **kwargs)


requests.get = _direct_get


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

    # ---- 市场级聚合（主源：东财股吧全市场）----
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

    # ---- 交叉源（同花顺热榜 / 雪球关注榜）：best-effort，失败降级，对冲东财单一源噪声 ----
    # 目的：东财股吧综合得分由散户自评、口径不透明，单一源偏差大；引入两个独立平台的
    # 市场级广度信号做交叉验证，降低单一平台噪声（A 方案）。
    th_signal = None
    xq_signal = None
    try:
        th_rows = _th_hot_list()
        if th_rows:
            th_pos = sum(1 for r in th_rows if (r.get('rise') or 0) > 0)
            th_ratio = th_pos / len(th_rows)
            # 热榜中上涨占比：>0.5 偏热，<0.5 偏冷
            th_signal = max(-1.0, min(1.0, (th_ratio - 0.5) * 2))
    except Exception:
        th_signal = None
    try:
        xq_rows = _xueqiu_follow_list()
        xq_rets = [r.get('pct') for r in xq_rows if isinstance(r.get('pct'), (int, float))]
        if xq_rets:
            xq_avg = sum(xq_rets) / len(xq_rets)
            # 高关注股平均涨跌幅：±1.5% 映射到 ±1
            xq_signal = max(-1.0, min(1.0, xq_avg / 1.5))
    except Exception:
        xq_signal = None

    sources_used = ['东财股吧']
    has_th = th_signal is not None
    has_xq = xq_signal is not None
    if has_th:
        sources_used.append('同花顺热榜')
    if has_xq:
        sources_used.append('雪球关注榜')
    cross_n = (1 if has_th else 0) + (1 if has_xq else 0)
    if cross_n > 0:
        # 东财 0.6 为主，每个可用交叉源平分剩余 0.4，降低单一平台噪声
        cross_w = 0.4 / cross_n
        blended = 0.6 * market_heat
        if has_th:
            blended += cross_w * th_signal
        if has_xq:
            blended += cross_w * xq_signal
        market_heat = round(blended, 3)

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
        # ---- C 方案：时效 / 覆盖标注 + 缺失剔除支撑字段 ----
        'valid': True,                       # 市场热度是否成功计算（False 时 MSI 自动剔除该分量）
        'sampleCount': len(df),              # 东财股吧聚合样本数（全市场个股数）
        'coverage': ' + '.join(sources_used),  # 实际参与融合的数据源清单
        'updatedAt': time.strftime('%Y-%m-%d %H:%M', time.localtime()),  # 数据抓取时间戳
        'thSignal': round(th_signal, 3) if th_signal is not None else None,  # 同花顺交叉源信号
        'xqSignal': round(xq_signal, 3) if xq_signal is not None else None,  # 雪球交叉源信号
        'samples': samples,
        'note': f'股吧舆情聚合（{len(sources_used)}源融合）·市场热度+个股({symbol or "全市场"})',
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
                rc = it.get('hot_rank_chg')
                try:
                    rc = int(rc or 0)
                except Exception:
                    rc = 0
                tag = it.get('tag') or {}
                out.append({
                    'code': str(it.get('code', '')).strip(),
                    'order': int(it.get('order', 0) or 0),
                    'rate': float(it.get('rate', 0) or 0),
                    'rise': float(it.get('rise_and_fall', 0) or 0),
                    'name': str(it.get('name', '')),
                    'rankChg': rc,                                                     # 排名变化（正=上升）
                    'concepts': [str(x) for x in (tag.get('concept_tag') or [])][:6],   # 命中概念标签（同花顺人工运营）
                    'popTag': str(tag.get('popularity_tag') or ''),                    # 人气标签（如「持续上榜」）
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
        chg = hit.get('rankChg') or 0
        if chg > 0:
            chgTxt = '·较昨日 ↑%d' % chg
        elif chg < 0:
            chgTxt = '·较昨日 ↓%d' % (-chg)
        else:
            chgTxt = '·较昨日持平'
        cps = hit.get('concepts') or []
        cpTxt = ('·概念：' + ' / '.join(cps)) if cps else ''
        popTag = hit.get('popTag') or ''
        popTxt = ('·' + popTag) if popTag else ''
        return {
            'ok': True,
            'inHotList': True,
            'rank': hit['order'],
            'heatRate': hit['rate'],
            'risePct': round(hit['rise'], 2),
            'rankChg': chg,
            'concepts': cps,
            'popTag': popTag,
            'note': f'同花顺热榜·{hit["name"]}({symbol})·第{hit["order"]}名·热度{hit["rate"]}{chgTxt}{popTxt}{cpTxt}',
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


# 同花顺个股讨论（替代东财股吧个股讨论，绕过验证码墙；20260910 供个股舆情模块消费）
_THS_DISC_URL = 'https://t.10jqka.com.cn/lgt/post/open/api/forum/post/v2/recent'
_THS_DISC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Host': 't.10jqka.com.cn',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://t.10jqka.com.cn/',
    'sec-ch-ua': '"Not(A:Brand";v="24", "Chromium";v="122"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1', 'Upgrade-Insecure-Requests': '1',
}
# 直连（不经过系统代理，与 Node fetch 同效；代理曾阻断 axios/部分请求）
_THS_DISC_PROXIES = {'http': None, 'https': None}


def _strip_ths_tags(s):
    """剥离同花顺帖文内联标签与 HTML 实体，返回纯文本（与 hot_topics_collect.py 同款）。"""
    if not s:
        return ''
    t = str(s)
    for k, v in {'&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>',
                 '&quot;': '"', '&#39;': "'", '&ldquo;': '"', '&rdquo;': '"',
                 '&hellip;': '…'}.items():
        t = t.replace(k, v)
    t = re.sub(r'<[^>]+>', '', t)
    return t.strip()


def _ths_market_id(code):
    """同花顺讨论 API market_id：沪市(6 开头)=17，深市=33。"""
    c = str(code or '').strip()
    return 17 if c.startswith('6') else 33


def fetch_stock_discussion(symbol, name='', max_pages=5):
    """同花顺个股讨论（多页聚合，绕过东财股吧验证码）。
    返回 {ok, posts:[{id,content,ctime,reply,like,share,forward,isV}], pageCount, count, note}。
      · ctime 为 epoch 秒（时间衰减权重用）
      · user.is_v 为认证大V（KOL 近似；同花顺无粉丝字段）
      · 单页最多 15 条（page_size>15 接口返回 0），4~5 页覆盖近期讨论约 50~60 条
    任一异常 → ok=false 优雅降级，不阻塞其他子模块。"""
    if not symbol or not str(symbol).isdigit() or len(str(symbol)) != 6:
        return {'ok': False, 'posts': [], 'pageCount': 0,
                'note': '缺少有效 6 位股票代码，跳过同花顺讨论'}
    code = str(symbol)
    market_id = _ths_market_id(code)
    posts = []
    seen = set()
    page_count = 0
    last_err = None
    for page in range(1, max_pages + 1):
        params = {'page': page, 'page_size': 15, 'pid': 0, 'time': 0, 'sort': 'publish',
                  'code': code, 'market_id': market_id}
        try:
            r = requests.get(_THS_DISC_URL, params=params, headers=_THS_DISC_HEADERS,
                             timeout=12, proxies=_THS_DISC_PROXIES)
            if r.status_code != 200:
                last_err = f'HTTP {r.status_code}'
                break
            j = r.json()
            feed = (j.get('data') or {}).get('feed') or []
            if not feed:
                break
            page_count += 1
            for p in feed:
                content = _strip_ths_tags(p.get('content', ''))
                if not content:
                    continue
                pid = p.get('pid') or p.get('id')
                if not pid:
                    continue
                key = f'{code}_{pid}'
                if key in seen:
                    continue
                seen.add(key)
                stat = p.get('stat') or {}
                user = p.get('user') or {}
                try:
                    ctime = int(p.get('ctime', 0) or 0)
                except Exception:
                    ctime = 0
                try:
                    reply = int(stat.get('reply', 0) or 0)
                except Exception:
                    reply = 0
                try:
                    like = int(stat.get('like', 0) or 0)
                except Exception:
                    like = 0
                try:
                    share = int(stat.get('share', 0) or 0)
                except Exception:
                    share = 0
                try:
                    forward = int(stat.get('forward', 0) or 0)
                except Exception:
                    forward = 0
                posts.append({
                    'id': key,
                    'content': content,
                    'ctime': ctime,
                    'reply': reply,
                    'like': like,
                    'share': share,
                    'forward': forward,
                    'isV': bool(user.get('is_v')),
                })
        except Exception as e:
            last_err = str(e)[:80]
            break
    if not posts:
        return {'ok': False, 'posts': [], 'pageCount': page_count,
                'error': last_err or '空结果',
                'note': f'同花顺讨论({symbol})无有效帖：{last_err or "空结果"}'}
    return {
        'ok': True,
        'posts': posts,
        'pageCount': page_count,
        'count': len(posts),
        'note': f'同花顺讨论({name or symbol})·近{page_count}页共{len(posts)}帖',
    }


# ---- 投资者问答（沪市：上证e互动 / 深市：巨潮互动易）----
# 20260923h：个股近期热点「投资者问答」子卡数据源（用户要求：沪市上证e互动 + 深市巨潮互动易，带 uid 缓存）。
#   · 沪市(60/68/900) → 上交所官方平台「上证e互动」sns.sseinfo.com
#     按公司查询必须先用公司 uid；公司列表按代码升序分页（每页 32 家），只能倍增 + 二分定位
#     （实测冷启动 8~17 次请求、6~15s，且个别页会超时）。**uid 必须落盘缓存**——
#     sentiment.py 每次都是短生命周期子进程，进程内缓存无法跨请求复用，不落盘则每只沪市股每次都重跑二分。
#     落盘缓存同时记录「总页数」并对二分途经页做全量 code→uid 归档，越用越快（也可用 --warm-uid 一次性预热全表）。
#   · 深市(00/30/200) → 巨潮「互动易」irm.cninfo.com.cn（两步：queryKeyboardInfo 查 orgId → company/question 取列表）
# 合规：两平台均为交易所官方/指定信息披露平台的公开问答，免登录、低频访问、不采集提问者昵称等个人信息（asker 不入库）。
import html as _html

_IRM_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
_IRM_PROXIES = {'http': None, 'https': None}
_SSE_E_BASE = 'https://sns.sseinfo.com'
_SSE_COMPANY_END = '没有任何上市公司的信息'
_SSE_KIND = {'answered': 11, 'questions': 10}
# 无问答提示：公司维度「暂无回复 / 暂无提问」，全市场翻过末页「暂时没有问答内容」
_SSE_EMPTY_NOTE = re.compile(r'class="m_feed_note"[^>]*>[^<]*(暂无|暂时没有)[^<]*<')
_SSE_UID_CACHE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                   'data', 'cache', 'sse_e_uid.json')
_SSE_UID_TTL = 7 * 24 * 3600      # 公司 uid 7 天内直接复用
_SSE_PAGES_TTL = 30 * 24 * 3600   # 总页数 30 天内复用（跳过倍增探测）
_SSE_REQ_TIMEOUT = 8              # 单次请求超时（秒）
_SSE_DEADLINE = 12                # 沪市 uid 定位 + 取数总预算（秒），超预算则优雅降级
# ⚠️ 进程级时间预算：本脚本被 lib/sentiment.js 以 execFile timeout=60s 调用，
# 问答子卡绝不能把整脚本拖过上限——否则连既有涨跌停比/融资余额/个股舆情会被一起杀掉。
# 故进入本模块时若整脚本已耗时接近上限，直接跳过问答并如实标注，优先保既有因子。
_SCRIPT_T0 = time.time()
_IRM_SCRIPT_BUDGET = 40           # 整脚本已耗时超过该秒数则不再发起问答请求
_SSE_PAGES = {}                   # 单次进程内：页码 → [(code, uid)]
_SSE_UID_MEM = None               # 落盘缓存的内存副本


def _sse_uid_cache_load():
    global _SSE_UID_MEM
    if _SSE_UID_MEM is not None:
        return _SSE_UID_MEM
    data = None
    try:
        with open(_SSE_UID_CACHE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = None
    if not isinstance(data, dict):
        data = {}
    if not isinstance(data.get('codes'), dict):
        data['codes'] = {}
    if not isinstance(data.get('meta'), dict):
        data['meta'] = {}
    _SSE_UID_MEM = data
    return _SSE_UID_MEM


def _sse_uid_cache_save():
    if _SSE_UID_MEM is None:
        return
    try:
        os.makedirs(os.path.dirname(_SSE_UID_CACHE_PATH), exist_ok=True)
        with open(_SSE_UID_CACHE_PATH, 'w', encoding='utf-8') as f:
            json.dump(_SSE_UID_MEM, f, ensure_ascii=False, separators=(',', ':'))
    except Exception:
        pass


def _irm_retry(fn, attempts=2, delay=0.6, deadline=None):
    """上证e互动/巨潮互动易偶发 ReadTimeout（实测 600460 单次超时、重试即成功）。
    两个平台均为单次 1~2 个请求的轻量调用，故只做 1 次短延迟重试，不放大请求量。
    deadline 不为空时，超预算不再发起重试（保证总耗时可控）。"""
    last = None
    for i in range(attempts):
        if deadline is not None and time.time() > deadline:
            break
        try:
            return fn()
        except Exception as e:
            last = e
            if i < attempts - 1 and (deadline is None or time.time() + delay < deadline):
                time.sleep(delay)
    if last is None:
        raise RuntimeError('超出取数时间预算')
    raise last


def _sse_company_page(page, deadline=None):
    """上证e互动公司列表第 page 页（每页 32 家，按代码升序）。
    解析 0 家且该页没有「没有任何上市公司的信息」末页标记 → 判定页面格式已变并抛错（不静默返回空）。"""
    page = int(page)
    if page in _SSE_PAGES:
        return _SSE_PAGES[page]
    if deadline is not None and time.time() > deadline:
        raise RuntimeError('上证e互动公司列表定位超出时间预算')
    r = _irm_retry(lambda: requests.post(
        _SSE_E_BASE + '/allcompany.do',
        data={'code': '0', 'order': '2', 'areaId': '0', 'page': page},
        headers={'User-Agent': _IRM_UA, 'Referer': _SSE_E_BASE + '/'},
        timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
    if r.status_code != 200:
        raise RuntimeError(f'上证e互动公司列表第 {page} 页 HTTP {r.status_code}')
    try:
        payload = r.json()
    except Exception:
        raise RuntimeError(f'上证e互动公司列表第 {page} 页返回非 JSON')
    content = payload.get('content') if isinstance(payload, dict) else None
    if not isinstance(content, str):
        raise RuntimeError(f'上证e互动公司列表第 {page} 页返回结构变了（没有 content 字符串）')
    pairs = [(code, uid) for uid, code in
             re.findall(r"uid=['\"]?(\d+)['\"]?[^>]*>\s*<img[^>]*company/(\d{6})\.png", content)]
    if not pairs and (page == 1 or _SSE_COMPANY_END not in content):
        raise RuntimeError(f'上证e互动公司列表第 {page} 页解析出 0 家公司，页面格式可能已变')
    _SSE_PAGES[page] = pairs
    # 顺手把本页公司全量写入落盘缓存（二分途经多页 ≈ 免费预热），并记录总页数线索
    cache = _sse_uid_cache_load()
    now = time.time()
    for code, uid in pairs:
        cache['codes'][code] = {'u': uid, 'ts': now}
    if pairs:
        if page > int(cache['meta'].get('maxPage') or 0):
            cache['meta']['maxPage'] = page
    else:
        ep = int(cache['meta'].get('endPage') or 0)
        if not ep or page < ep:
            cache['meta']['endPage'] = page
    cache['meta']['ts'] = now
    _sse_uid_cache_save()
    return pairs


def _sse_company_uid(code, deadline):
    """上证e互动公司 uid 定位：落盘缓存命中即返回；否则二分定位（已知总页数时跳过倍增探测）。"""
    cache = _sse_uid_cache_load()
    ent = cache['codes'].get(code)
    if isinstance(ent, dict) and ent.get('u') and \
            (time.time() - float(ent.get('ts') or 0)) < _SSE_UID_TTL:
        return str(ent['u'])
    meta = cache.get('meta') or {}
    total = 0
    if (time.time() - float(meta.get('ts') or 0)) < _SSE_PAGES_TTL:
        mp, ep = int(meta.get('maxPage') or 0), int(meta.get('endPage') or 0)
        if mp and ep and 0 <= ep - mp <= 2:
            total = mp
    if total:
        low, high = 1, total
    else:
        low, high = 1, 1
        while _sse_company_page(high, deadline):
            if _sse_company_page(high, deadline)[-1][0] >= code:
                break
            low, high = high, high * 2
    found = None
    while low <= high:
        mid = (low + high) // 2
        pairs = _sse_company_page(mid, deadline)
        if not pairs or code < pairs[0][0]:
            high = mid - 1
        elif code > pairs[-1][0]:
            low = mid + 1
        else:
            for c, u in pairs:
                if c == code:
                    found = u
                    break
            break
    if not found:  # 二分区间落空时兜底查缓存（途经页已全量归档）
        found = (cache['codes'].get(code) or {}).get('u')
    if not found:
        raise ValueError(f'上证e互动未收录 {code}（非沪市公司或已退市）')
    cache['codes'][code] = {'u': found, 'ts': time.time()}
    _sse_uid_cache_save()
    return str(found)


def _sse_text(fragment):
    return _html.unescape(re.sub(r'<[^>]+>', '', fragment or '')).strip()


def _sse_time(text):
    m = re.search(r'(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}:\d{2})', text or '')
    return f'{m.group(1)}-{m.group(2)}-{m.group(3)} {m.group(4)}' if m else ''


def _sse_parse_feed(text, code=None):
    """按「回复块 class="m_feed_detail m_qa"」为界切问题段/回复段
    （问题框 class 因列表类型而异，不能靠 id 区分问答）。单条解析失败只跳过该条，不整批作废。"""
    rows = []
    for chunk in re.split(r'<div class="m_feed_item[^"]*" id="item-', text or '')[1:]:
        m = re.match(r'(\d+)', chunk)
        if not m:
            continue
        item_id = m.group(1)
        ask_part, _, answer_part = chunk.partition('class="m_feed_detail m_qa"')
        q = re.search(r'<div class="m_feed_txt"[^>]*>\s*<a[^>]*>:(.*?)\((\d{6})\)</a>(.*?)</div>',
                      ask_part, re.S)
        t = re.search(r'<div class="m_feed_from"[^>]*>\s*<span>([^<]+)</span>', ask_part)
        if not q or not t:
            continue
        if code and q.group(2) != code:
            continue
        asker = re.search(r'rel="face"[^>]*?title="([^"]*)"', ask_part, re.S)
        answer, answer_time = '', ''
        if answer_part:
            body = re.search(r'<div class="m_feed_txt"[^>]*>(.*?)</div>', answer_part, re.S)
            when = re.search(r'<div class="m_feed_from"[^>]*>\s*<span>([^<]+)</span>', answer_part)
            if body:
                answer = _sse_text(body.group(1))
            if when:
                answer_time = _sse_time(when.group(1))
        rows.append({
            'id': item_id, 'code': q.group(2), 'name': _sse_text(q.group(1)),
            'asker': asker.group(1) if asker else '',
            'question': _sse_text(q.group(3)),
            'question_time': _sse_time(t.group(1)),
            'answer': answer, 'answer_time': answer_time,
        })
    return rows


def _fetch_sse_e_qa(code, page_size=20):
    """上证e互动某公司问答：先取「最新已回复」，为空再取「最新提问」（含未回复，本身就是信号）。"""
    deadline = time.time() + _SSE_DEADLINE
    uid = _sse_company_uid(code, deadline)
    rows, kind_used = [], 'answered'
    for kind in ('answered', 'questions'):
        if time.time() > deadline:
            raise RuntimeError('上证e互动取数超出时间预算')
        r = _irm_retry(lambda: requests.post(
            _SSE_E_BASE + '/ajax/userfeeds.do',
            data={'typeCode': 'company', 'type': _SSE_KIND[kind],
                  'pageSize': int(page_size), 'uid': uid, 'page': 1},
            headers={'User-Agent': _IRM_UA, 'Referer': _SSE_E_BASE + '/'},
            timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
        if r.status_code != 200:
            raise RuntimeError(f'上证e互动问答 HTTP {r.status_code}')
        text = (r.content or b'').decode('utf-8', 'replace')
        rows = _sse_parse_feed(text, code)
        if rows:
            kind_used = kind
            break
        # 只有明确「暂无 / 暂时没有」才算真没有问答；解析 0 条又无该提示 = 页面结构变了
        if not _SSE_EMPTY_NOTE.search(text):
            raise RuntimeError('上证e互动返回既无问答也无「暂无」提示，结构可能已变')
    return rows, kind_used


def _fetch_cninfo_qa(code, page_size=20, page_num=1):
    """巨潮互动易（深市）两步取数。
    ⚠️ 第二步参数必须放 query string（POST 但 body 为空），否则 HTTP 400。"""
    deadline = time.time() + _SSE_DEADLINE
    r1 = _irm_retry(lambda: requests.post(
        'https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo',
        data={'keyWord': code}, headers={'User-Agent': _IRM_UA},
        timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
    if r1.status_code != 200:
        raise RuntimeError(f'互动易公司检索 HTTP {r1.status_code}')
    d1 = (r1.json() or {}).get('data') or []
    if not d1:
        return []
    org_id = d1[0].get('secid')
    if not org_id:
        return []
    params = {'_t': 1, 'stockcode': code, 'orgId': org_id, 'pageSize': int(page_size),
              'pageNum': int(page_num), 'keyWord': '', 'startDay': '', 'endDay': ''}
    r2 = _irm_retry(lambda: requests.post(
        'https://irm.cninfo.com.cn/newircs/company/question',
        params=params, headers={'User-Agent': _IRM_UA},
        timeout=_SSE_REQ_TIMEOUT, proxies=_IRM_PROXIES), deadline=deadline)
    if r2.status_code != 200:
        raise RuntimeError(f'互动易问答列表 HTTP {r2.status_code}')
    return (r2.json() or {}).get('rows') or []


def _cninfo_answered(it):
    """巨潮「是否已回复」判定：回复正文 or 附件（attachedContent 为空但有 attachedId/attachmentUrl）。
    不使用 qaStatus（语义未验证，不拿未确认的字段当事实）。"""
    return bool((it.get('attachedContent') or '').strip()
                or it.get('attachedId') or it.get('attachmentUrl'))


def _irm_market(code):
    c = str(code or '').strip()
    if c.startswith(('60', '68', '900')):
        return 'sh'
    if c.startswith(('00', '30', '200')):
        return 'sz'
    return ''


def fetch_irm_qa(symbol, name='', page_size=20):
    """投资者问答（沪市→上证e互动 / 深市→巨潮互动易）。
    返回 {ok, posts:[{id,question,answer,askTime,answerTime,asker,answerer,source,replied}],
          count, answered, source, note[, error]}；任一环节失败 → ok=false 优雅降级，不阻塞其他子模块。
    注：asker（提问者昵称）仅作展示用途，不写入项目持久化文件。"""
    code = str(symbol or '').strip()
    if not code.isdigit() or len(code) != 6:
        return {'ok': False, 'posts': [], 'count': 0, 'error': 'invalid_symbol',
                'note': '缺少有效 6 位股票代码，跳过投资者问答'}
    # 进程级时间预算守卫（见 _IRM_SCRIPT_BUDGET 注释）：整脚本已耗时接近 Node 侧 60s 上限时
    # 直接跳过问答，避免把既有涨跌停比/融资/舆情因子一起拖死；如实标注原因，不造假数据。
    _elapsed = time.time() - _SCRIPT_T0
    if _elapsed > _IRM_SCRIPT_BUDGET:
        return {'ok': False, 'posts': [], 'count': 0, 'error': 'budget_exceeded',
                'note': f'本次运行前面已耗时 {int(_elapsed)}s（接近取数上限），已跳过投资者问答；'
                        f'点「🔄 重新分析」可重试'}
    market = _irm_market(code)
    if not market:
        return {'ok': False, 'posts': [], 'count': 0, 'error': 'unsupported_market',
                'note': f'{code} 非沪深主板/创业板/科创板，暂无投资者问答数据源'}
    if market == 'sh':
        source = '上证e互动'
        try:
            rows, kind_used = _fetch_sse_e_qa(code, page_size)
        except Exception as e:
            return {'ok': False, 'posts': [], 'count': 0, 'source': source, 'error': str(e)[:140],
                    'note': f'上证e互动({code})获取失败：{str(e)[:60]}'}
        posts = []
        for r in rows:
            q = (r.get('question') or '').strip()
            if not q:
                continue
            a = (r.get('answer') or '').strip()
            posts.append({
                'id': f"sse_{r.get('id')}", 'question': q, 'answer': a,
                'askTime': r.get('question_time') or '', 'answerTime': r.get('answer_time') or '',
                'asker': r.get('asker') or '', 'answerer': '上证e互动',
                'source': source, 'replied': bool(a), 'unansweredList': kind_used == 'questions',
            })
    else:
        source = '巨潮互动易'
        try:
            rows = _fetch_cninfo_qa(code, page_size, 1)
            # 平台按时间倒序，近一页可能全是「尚未回复」的提问（如 002594 近 20 条全未回复），
            # 故本页无任何已回复问答时再翻一页合并，保证子卡能展示到真正的问答。
            if rows and not any(_cninfo_answered(r) for r in rows):
                seen = {str(r.get('indexId') or r.get('id') or '') for r in rows}
                for r in _fetch_cninfo_qa(code, page_size, 2):
                    k = str(r.get('indexId') or r.get('id') or '')
                    if k and k in seen:
                        continue
                    rows.append(r)
        except Exception as e:
            return {'ok': False, 'posts': [], 'count': 0, 'source': source, 'error': str(e)[:140],
                    'note': f'巨潮互动易({code})获取失败：{str(e)[:60]}'}
        posts = []
        for it in rows:
            q = (it.get('mainContent') or '').strip()
            if not q:
                continue
            pd = it.get('pubDate')
            try:
                ask_time = datetime.fromtimestamp(int(pd) / 1000).strftime('%Y-%m-%d %H:%M') if pd else ''
            except Exception:
                ask_time = ''
            a = (it.get('attachedContent') or '').strip()
            replied = _cninfo_answered(it)
            if replied and not a:   # 只有附件、没有正文回复：如实标注，不写成「未回复」
                a = '（公司以附件形式回复，详见巨潮互动易）'
            posts.append({
                'id': f"cninfo_{it.get('indexId') or it.get('id') or ask_time}", 'question': q,
                'answer': a, 'askTime': ask_time, 'answerTime': '',
                'asker': '', 'answerer': it.get('attachedAuthor') or '',
                'source': source, 'replied': replied, 'unansweredList': False,
            })
    if not posts:
        return {'ok': False, 'posts': [], 'count': 0, 'source': source, 'error': 'empty',
                'note': f'{source}({code})近端无问答（平台只开放近期问答）'}
    # 已回复优先 + 提问时间倒序（子卡只取前若干条，已获公司回复的信息价值更高）
    posts.sort(key=lambda p: (1 if p['replied'] else 0, p['askTime'] or ''), reverse=True)
    answered = sum(1 for p in posts if p['replied'])
    return {'ok': True, 'posts': posts, 'count': len(posts), 'answered': answered, 'source': source,
            'note': f'{source}({name or code})·{len(posts)}条问答（已回复{answered}）'}


def warm_sse_uid_map(max_pages=200, budget=300):
    """维护用（不在请求路径调用）：一次性把上证e互动公司 uid 全表落盘。
    逐页拉取直到「没有任何上市公司的信息」，之后单只沪市股票只需 1 次请求。"""
    cache = _sse_uid_cache_load()
    before = len(cache.get('codes') or {})
    page, deadline = 1, time.time() + budget
    while page <= max_pages and time.time() < deadline:
        try:
            pairs = _sse_company_page(page, deadline)
        except Exception as e:
            return {'ok': False, 'pages': page - 1, 'codes': len(cache['codes']),
                    'added': len(cache['codes']) - before, 'error': str(e)[:160]}
        if not pairs:
            break
        page += 1
        time.sleep(0.15)  # 礼貌限速：一次性翻全表，间隔 150ms 再取下一页
    _sse_uid_cache_save()
    return {'ok': True, 'pages': page - 1, 'codes': len(cache['codes']),
            'added': len(cache['codes']) - before}


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
    parser.add_argument('--warm-uid', action='store_true',
                        help='维护用：一次性预热上证e互动公司 uid 缓存后退出（不参与个股分析）')
    args = parser.parse_args()
    symbol = (args.symbol or '').strip()
    name = (args.name or '').strip()

    if args.warm_uid:
        print(json.dumps({'warmSseUid': warm_sse_uid_map()}, ensure_ascii=False))
        return

    result = {
        'source': ('东方财富·涨跌停池/融资余额/个股新闻/股吧舆情 + 同花顺/雪球公开热度榜 + 同花顺个股讨论 '
                   '+ 投资者问答(沪:上证e互动 / 深:巨潮互动易)'),
        'date': _now_str(),
        'breadth': None,
        'margin': None,
        'newsSentiment': None,
        'marketSentiment': None,
        'discussionHeat': None,
        'stockDiscussion': None,
        'irmQa': None,
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

    # 6) 同花顺个股讨论（替代东财股吧个股讨论，绕过验证码墙；供个股舆情模块消费）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['stockDiscussion'] = fetch_stock_discussion(symbol, name)
        except Exception as e:
            result['stockDiscussion'] = {'ok': False, 'posts': [], 'error': str(e)}
    else:
        result['stockDiscussion'] = {'ok': False, 'posts': [], 'error': '缺少有效 6 位股票代码'}

    # 7) 投资者问答（20260923h：沪市→上证e互动 / 深市→巨潮互动易；带 uid 落盘缓存）
    #    独立 try，失败仅该子卡降级；不计入 subOkCount（纯增益模块，不影响既有全失败判定与总体信号）
    if symbol and symbol.isdigit() and len(symbol) == 6:
        try:
            result['irmQa'] = fetch_irm_qa(symbol, name)
        except Exception as e:
            result['irmQa'] = {'ok': False, 'posts': [], 'count': 0, 'error': str(e)[:140],
                               'note': f'投资者问答获取失败：{str(e)[:60]}'}
    else:
        result['irmQa'] = {'ok': False, 'posts': [], 'count': 0, 'error': 'invalid_symbol',
                           'note': '缺少有效 6 位股票代码，跳过投资者问答'}

    result['subOkCount'] = sum(1 for k in ('breadth', 'margin', 'newsSentiment', 'marketSentiment', 'discussionHeat', 'stockDiscussion')
                               if result[k] and result[k].get('ok'))

    # 全部失败
    if result['subOkCount'] == 0:
        print(json.dumps({"error": "情绪数据全部获取失败", "detail": {
            'breadth': result['breadth'].get('error'),
            'margin': result['margin'].get('error'),
            'newsSentiment': result['newsSentiment'].get('error'),
            'marketSentiment': result['marketSentiment'].get('error'),
            'discussionHeat': result['discussionHeat'].get('error'),
            'stockDiscussion': result['stockDiscussion'].get('error'),
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
