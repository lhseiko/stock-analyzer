#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cn-financial-scraper 后台接入适配器
--------------------------------------------------------------
把 cn-financial-scraper v7.2.0 的能力封装成 CLI JSON 接口，供 Node 端
( lib/cnscraperAdapter.js ) 通过 execFile 异步调用。

每个子命令都输出「单行 JSON」到 stdout；任何异常都转成 {"ok":false,"error":...}
并 exit 0（避免 Node 端拿到非零退出码 + stderr 刷屏）。

子命令：
  sentiment     全网舆情爬取（crawl_sentiment，68 源，含 RSS/搜索/媒体）
                --targets "中国平安,平安保险" --days 3 --max 20 --budget 12
  report        定期报告解读（interpret_stock，东财 RPT_LICO_FN_CPD 直连）
                --code 600519
  announcements 沪深交易所公告搜索（search_announcements）
                --keyword "分红" --market both --max 30
  regulatory    监管/政策资讯（get_regulatory_updates）
                --agency all --limit 15
  monetary      货币政策/财经要闻摘要（get_monetary_policy）
  fiscal        财政部《财政收支情况》公告解析（收入/支出累计额与同比）

设计要点：
  * sys.dont_write_bytecode = True，不产生 .pyc 污染技能目录。
  * sys.path 同时插入技能根目录 + scripts/，使「from scripts.X import」
    与浏览器兜底的「from browser_scraper import」两种绝对导入都能命中。
  * 舆情文章过滤掉「未能直接抓取」占位 stub，只保留真实抓取内容。
"""
import sys
import os
import re
import json
import argparse

sys.dont_write_bytecode = True

# 技能根目录（可用环境变量 CNSCRAPER_HOME 覆盖，便于换机/换路径）
SKILL_DIR = os.environ.get(
    'CNSCRAPER_HOME',
    r'C:\Users\16507\.workbuddy\skills\cnfinancialscraper__skillhub',
)
_SKILL_ROOT = SKILL_DIR
_SKILL_SCRIPTS = os.path.join(SKILL_DIR, 'scripts')
for _p in (_SKILL_ROOT, _SKILL_SCRIPTS):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)


def _fail(err):
    print(json.dumps({'ok': False, 'error': str(err)[:500]}, ensure_ascii=False))
    return 0


def _out(obj):
    print(json.dumps(obj, ensure_ascii=False, default=str))
    return 0


# ---------------------------------------------------------------------------
# 子命令实现
# ---------------------------------------------------------------------------
def _is_stub(title, content):
    """识别爬取失败的占位文章（未能直接抓取 / 空标题空正文）。"""
    t = (title or '').strip()
    c = (content or '').strip()
    if not t and not c:
        return True
    if '未能直接抓取' in t or '未能直接抓取' in c:
        return True
    if '关键词=' in t and '来自 ' in t and not c:
        return True
    return False


def cmd_sentiment(args):
    from scripts.sentiment_crawler import crawl_sentiment

    targets = [t.strip() for t in (args.targets or '').split(',') if t.strip()]
    if not targets:
        return _out({'ok': False, 'error': '未提供 --targets 目标名', 'articles': [],
                     'positive': 0, 'negative': 0, 'neutral': 0, 'signal': 0})

    try:
        snap = crawl_sentiment(
            targets=targets,
            days=args.days,
            max_articles=args.max_articles,
            max_total_seconds=args.budget,
            per_source_timeout=3,
            use_rss=True,
        )
    except Exception as e:
        return _fail('crawl_sentiment 异常: %s' % e)

    try:
        d = snap.to_dict()
    except Exception as e:
        return _fail('序列化舆情快照失败: %s' % e)

    raw = d.get('articles') or []
    # 过滤占位 stub，只保留真实文章
    articles = [a for a in raw if not _is_stub(a.get('title'), a.get('content'))]

    positive = sum(1 for a in articles if a.get('sentiment') == 'positive')
    negative = sum(1 for a in articles if a.get('sentiment') == 'negative')
    neutral = len(articles) - positive - negative

    scores = [float(a['sentiment_score']) for a in articles
              if isinstance(a.get('sentiment_score'), (int, float))]
    avg_score = (sum(scores) / len(scores)) if scores else 0.0
    # 平均情感分映射到 [-1,1]（skill 的 sentiment_score 量纲约 ±1）
    signal = max(-1.0, min(1.0, avg_score))

    return _out({
        'ok': True,
        'targets': targets,
        'days': args.days,
        'count': len(articles),
        'raw_count': len(raw),
        'positive': positive,
        'negative': negative,
        'neutral': neutral,
        'avg_score': round(avg_score, 4),
        'signal': round(signal, 4),
        'sources_used': (d.get('stats') or {}).get('sources_used'),
        'articles': [{
            'title': a.get('title', '')[:80],
            'source': a.get('source', ''),
            'source_type': a.get('source_type', ''),
            'sentiment': a.get('sentiment', 'neutral'),
            'sentiment_score': a.get('sentiment_score', 0.0),
            'severity': a.get('severity', ''),
            'publish_time': a.get('publish_time', ''),
            'url': a.get('url', ''),
        } for a in articles[:args.max_articles]],
        'note': '全网舆情（cn-financial-scraper %d 源，过滤占位 stub 后 %d 条）'
                % ((d.get('stats') or {}).get('sources_used') or 0, len(articles)),
    })


def cmd_report(args):
    from scripts.report_interpreter import interpret_stock

    code = (args.code or '').strip()
    if not code:
        return _out({'ok': False, 'error': '未提供 --code 股票代码'})
    try:
        r = interpret_stock(code)
    except Exception as e:
        return _fail('interpret_stock 异常: %s' % e)
    if not isinstance(r, dict):
        return _fail('interpret_stock 返回非 dict: %r' % type(r))
    if r.get('error'):
        return _out({'ok': False, 'error': r['error'], 'code': code})
    r['ok'] = True
    r['code'] = code
    # 去掉冗长 text，避免超大 JSON；保留结构化字段
    r.pop('text', None)
    return _out(r)


def cmd_announcements(args):
    from scripts.exchange_scraper import search_announcements

    kw = (args.keyword or '').strip()
    if not kw:
        return _out({'ok': False, 'error': '未提供 --keyword 搜索词', 'items': []})
    try:
        items = search_announcements(kw, market=args.market, max_results=args.max_articles)
    except Exception as e:
        return _fail('search_announcements 异常: %s' % e)
    return _out({'ok': True, 'keyword': kw, 'count': len(items),
                 'items': items[:args.max_articles]})


def cmd_regulatory(args):
    from scripts.regulatory_scraper import get_regulatory_updates

    try:
        items = get_regulatory_updates(agency=args.agency, limit=args.limit)
    except Exception as e:
        return _fail('get_regulatory_updates 异常: %s' % e)
    return _out({'ok': True, 'agency': args.agency, 'count': len(items),
                 'items': items[:args.limit]})


def cmd_monetary(args):
    from scripts.regulatory_scraper import get_monetary_policy

    try:
        d = get_monetary_policy()
    except Exception as e:
        return _fail('get_monetary_policy 异常: %s' % e)
    d['ok'] = True
    return _out(d)


def _safe_str(v, default=''):
    if v is None:
        return default
    return str(v).strip()


def _safe_float(v, default=0.0):
    try:
        s = str(v).replace('%', '').replace(',', '').strip()
        return float(s) if s else default
    except (ValueError, TypeError):
        return default


def extract_fiscal(text):
    """从财政部《财政收支情况》正文中解析一般公共预算收入/支出的累计额(亿元)与累计同比(%)。

    返回 {'revenue': {'acc': float|None, 'yoy': float|None},
          'expenditure': {'acc': float|None, 'yoy': float|None}}
    同比方向：'下降' 记负、'增长' 记正。无法解析的字段以 None 占位。
    """
    rev = {'acc': None, 'yoy': None}
    exp = {'acc': None, 'yoy': None}
    if not text:
        return {'revenue': rev, 'expenditure': exp}

    # 收入：优先「全国一般公共预算收入」，其次首个「一般公共预算收入」
    rev_patterns = [
        r'全国一般公共预算收入[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
        r'一般公共预算收入[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
    ]
    for pat in rev_patterns:
        m = re.search(pat, text)
        if m:
            rev = {'acc': _safe_float(m.group(1)),
                   'yoy': _safe_float(m.group(3)) * (-1 if m.group(2) == '下降' else 1)}
            break

    # 支出：优先「全国一般公共预算支出」，其次首个「一般公共预算支出」
    exp_patterns = [
        r'全国一般公共预算支出[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
        r'一般公共预算支出[约\s]*([\d,]+)\s*亿元[，,\s]*同比(下降|增长)\s*([\d.]+)\s*%',
    ]
    for pat in exp_patterns:
        m = re.search(pat, text)
        if m:
            exp = {'acc': _safe_float(m.group(1)),
                   'yoy': _safe_float(m.group(3)) * (-1 if m.group(2) == '下降' else 1)}
            break

    return {'revenue': rev, 'expenditure': exp}


def cmd_fund_matrix(args):
    """
    基金重仓行业配置矩阵的原始数据层。
    拉取头部基金（按近 1 年业绩）最新季度的前 10 重仓股，返回原始持仓数据，
    由 Node 侧完成「股票→行业」映射与行业×基金矩阵聚合（复用现有 industryAnalysis）。
    """
    import akshare as ak
    from datetime import datetime

    top_n = max(1, min(args.top_n or 15, 30))
    quarter = (args.quarter or '').strip()  # 形如 "2025" 或 "2025Q1"；空则自动检测

    out = {'ok': True, 'quarter': quarter, 'top_n': top_n, 'funds': [], 'skipped': 0}
    # 1) 拉头部基金列表（混合型 — 权益类主力，纯债/货币对行业配置无意义）
    try:
        rank_df = ak.fund_open_fund_rank_em(symbol='混合型')
    except Exception as e:
        return _fail('fund_open_fund_rank_em 失败: %s' % e)

    if rank_df is None or len(rank_df) == 0:
        return _out({'ok': False, 'error': '未获取到混合型基金排行', 'funds': []})

    if '近1年' not in rank_df.columns or '基金代码' not in rank_df.columns:
        return _out({'ok': False, 'error': 'fund_open_fund_rank_em 返回列结构异常', 'funds': []})

    ranked = rank_df[['基金代码', '基金简称', '近1年']].copy()
    ranked['近1年_num'] = ranked['近1年'].apply(lambda v: _safe_float(v, -1e9))
    ranked = ranked[ranked['近1年_num'] > -1e8].sort_values('近1年_num', ascending=False).head(top_n)

    if len(ranked) == 0:
        return _out({'ok': False, 'error': '头部基金排序后为空', 'funds': []})

    # 自动检测最新季度：尝试当前年/上一年
    now = datetime.now()
    quarter_candidates = [str(now.year), str(now.year - 1)]

    for _, row in ranked.iterrows():
        fund_code = _safe_str(row.get('基金代码', '')).zfill(6)
        fund_name = _safe_str(row.get('基金简称', ''))
        year_ret = _safe_float(row.get('近1年', ''), None)

        holdings = []
        used_quarter = None
        for y in quarter_candidates:
            try:
                hdf = ak.fund_portfolio_hold_em(symbol=fund_code, date=y)
            except Exception:
                hdf = None
            if hdf is not None and len(hdf) > 0:
                if '季度' in hdf.columns:
                    used_quarter = _safe_str(hdf['季度'].iloc[-1], y + '年')
                else:
                    used_quarter = y + '年'
                top10 = hdf.head(10)
                for _, h in top10.iterrows():
                    code = _safe_str(h.get('股票代码', ''))
                    name = _safe_str(h.get('股票名称', ''))
                    weight = _safe_float(h.get('占净值比例', ''), 0.0)
                    mv = _safe_float(h.get('持仓市值', ''), 0.0)
                    if not name:
                        continue
                    holdings.append({
                        'code': code,
                        'name': name,
                        'weight': round(weight, 2),
                        'marketValue': round(mv, 2),
                    })
                if holdings:
                    break

        if not holdings:
            out['skipped'] += 1
            continue

        out['funds'].append({
            'code': fund_code,
            'name': fund_name,
            'yearReturn': round(year_ret, 2) if year_ret is not None else None,
            'quarter': used_quarter,
            'holdings': holdings,
        })

    if out['funds']:
        quarters = [f['quarter'] for f in out['funds'] if f.get('quarter')]
        if quarters and not quarter:
            out['quarter'] = max(quarters)

    out['count'] = len(out['funds'])
    out['note'] = 'akshare 混合型基金按近1年业绩取头部 %d 只，最新季报前 10 重仓股；股票→行业映射由 Node 侧完成' % top_n
    return _out(out)


def _decode_html(resp):
    """从响应取原始字节并正确解码：先严格尝试 UTF-8，失败（如政府站点 GBK
    却声明 utf-8）回退 GB18030。避免 http_get 默认 utf-8 解码产生的乱码。"""
    raw = getattr(resp, 'content', None) or b''
    if not raw:
        return ''
    try:
        return raw.decode('utf-8', errors='strict')
    except UnicodeDecodeError:
        return raw.decode('gb18030', errors='replace')


def _fetch_latest_mof_fiscal():
    """主路径：直接抓财政部国库司统计数据库（gks.mof.gov.cn/tongjishuju/）最新
    「财政收支情况」页。列表页 newest-first 暴露相对 .htm 文章链接，逐篇抓取
    extract_main_content 正文并用 extract_fiscal 解析，命中收入+支出双指标即返回。
    任一环节失败返回 None（由调用方降级）。
    """
    import re
    from scripts.http_utils import http_get
    from scripts.web_parser import extract_main_content

    base = 'https://gks.mof.gov.cn/tongjishuju/'
    try:
        resp = http_get(base, timeout=15, use_cache=True)
    except Exception:
        return None
    html = getattr(resp, 'text', None) or ''
    if not html:
        return None
    # 收集相对 .htm 文章链接（排除 pdf），最新在前
    links = re.findall(r'href="(\./\d{6}/t\d+_\d+\.htm)"', html)
    if not links:
        return None
    for rel in links[:6]:
        url = base + rel.lstrip('./')
        try:
            r2 = http_get(url, timeout=15, use_cache=True)
        except Exception:
            continue
        h2 = _decode_html(r2)
        if not h2:
            continue
        main = extract_main_content(h2) or {}
        text = main.get('content') or ''
        if not text:
            continue
        parsed = extract_fiscal(text)
        rev = parsed.get('revenue') or {}
        exp = parsed.get('expenditure') or {}
        if rev.get('acc') is not None and exp.get('acc') is not None:
            m = re.search(r'/(\d{6})/t(\d{8})_', url)
            date = ''
            if m:
                d = m.group(2)
                date = '%s-%s-%s' % (d[0:4], d[4:6], d[6:8])
            return {
                'ok': True,
                'date': date,
                'source': '财政部·国库司（gks.mof.gov.cn 统计数据库）',
                'title': '全国财政收支情况',
                'url': url,
                'revenue': {'acc': rev.get('acc'), 'yoy': rev.get('yoy')},
                'expenditure': {'acc': exp.get('acc'), 'yoy': exp.get('yoy')},
                'note': '解析自财政部《财政收支情况》公告（一般公共预算收支）',
            }
    return None


def cmd_fiscal(args):
    """财政部《财政收支情况》公告解析：一般公共预算收入与支出（累计额/同比）。

    主路径：直接抓财政部国库司统计数据库（gks.mof.gov.cn）最新「财政收支情况」页；
    兜底：经 get_regulatory_updates 检索东财/新浪/巨潮的财政类快讯。
    任一外挂源失败均优雅降级为 {ok:false}，绝不让异常上抛。
    """
    from scripts.http_utils import http_get
    from scripts.web_parser import extract_main_content

    # 主路径：财政部官网统计库
    mof = _fetch_latest_mof_fiscal()
    if mof and mof.get('ok'):
        return _out(mof)

    # 兜底：经 get_regulatory_updates 检索
    from scripts.regulatory_scraper import get_regulatory_updates
    limit = max(10, min(args.limit or 40, 60))
    try:
        items = get_regulatory_updates(agency='all', limit=limit) or []
    except Exception as e:
        return _fail('get_regulatory_updates 异常: %s' % e)

    # 候选：标题命中「财政收支情况」优先，其次「财政收支 / 一般公共预算」
    cands = [it for it in items if it and '财政收支情况' in (it.get('title') or '')]
    if not cands:
        cands = [it for it in items if it and ('财政收支' in (it.get('title') or '')
                                              or '一般公共预算' in (it.get('title') or ''))]
    if not cands:
        return _out({'ok': False, 'error': '未检索到财政部「财政收支情况」相关公告',
                     'items': len(items), 'candidates': 0})

    for it in cands:
        url = (it.get('url') or '').strip()
        title = (it.get('title') or '').strip()
        date = (it.get('date') or '').strip()
        if not url:
            continue
        try:
            resp = http_get(url, timeout=15, use_cache=True)
        except Exception:
            resp = None
        if not resp:
            continue
        html = _decode_html(resp)
        if not html:
            continue
        main = extract_main_content(html) or {}
        text = main.get('content') or ''
        parsed = extract_fiscal(text)
        rev = parsed.get('revenue') or {}
        exp = parsed.get('expenditure') or {}
        # 必须同时拿到收入与支出的累计额才算成功
        if rev.get('acc') is not None and exp.get('acc') is not None:
            return _out({
                'ok': True,
                'date': date,
                'source': it.get('source') or '财政部·财政收支情况',
                'title': title,
                'url': url,
                'revenue': {'acc': rev.get('acc'), 'yoy': rev.get('yoy')},
                'expenditure': {'acc': exp.get('acc'), 'yoy': exp.get('yoy')},
                'note': '解析自财政部《财政收支情况》公告（一般公共预算收支）',
            })
    return _out({'ok': False,
                 'error': '已找到 %d 条候选公告，但均无完整收入/支出双指标正文' % len(cands),
                 'items': len(items), 'candidates': len(cands)})


def main():
    ap = argparse.ArgumentParser(description='cn-financial-scraper 后台接入适配器')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_s = sub.add_parser('sentiment', help='全网舆情爬取')
    p_s.add_argument('--targets', required=True, help='目标名，逗号分隔')
    p_s.add_argument('--days', type=int, default=3)
    p_s.add_argument('--max', dest='max_articles', type=int, default=20)
    p_s.add_argument('--budget', type=int, default=12, help='总耗时预算(秒)')

    p_r = sub.add_parser('report', help='定期报告解读')
    p_r.add_argument('--code', required=True)

    p_a = sub.add_parser('announcements', help='交易所公告搜索')
    p_a.add_argument('--keyword', required=True)
    p_a.add_argument('--market', default='both')
    p_a.add_argument('--max', dest='max_articles', type=int, default=30)

    p_g = sub.add_parser('regulatory', help='监管/政策资讯')
    p_g.add_argument('--agency', default='all')
    p_g.add_argument('--limit', type=int, default=15)

    sub.add_parser('monetary', help='货币政策/财经要闻摘要')

    p_f = sub.add_parser('fiscal', help='财政部《财政收支情况》公告解析（一般公共预算收入/支出）')
    p_f.add_argument('--limit', type=int, default=40, help='检索政策资讯条数，默认 40')

    p_m = sub.add_parser('fund-matrix', help='基金重仓行业配置矩阵原始数据（头部基金最新季报前10重仓股）')
    p_m.add_argument('--top-n', type=int, default=15, help='头部基金数量，默认 15，最大 30')
    p_m.add_argument('--quarter', default='', help='季度，形如 2025 / 2025Q1；空则自动检测最新')

    args = ap.parse_args()

    dispatch = {
        'sentiment': cmd_sentiment,
        'report': cmd_report,
        'announcements': cmd_announcements,
        'regulatory': cmd_regulatory,
        'monetary': cmd_monetary,
        'fiscal': cmd_fiscal,
        'fund-matrix': cmd_fund_matrix,
    }
    handler = dispatch.get(args.cmd)
    if not handler:
        return _fail('未知子命令: %s' % args.cmd)
    try:
        return handler(args)
    except Exception as e:
        return _fail('%s 执行异常: %s' % (args.cmd, e))


if __name__ == '__main__':
    sys.exit(main() or 0)
