#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""板块舆情热度周榜 · 每日数据采集器（由 lib/hotTopicsWeekly/index.js 调度，每日一次）
四条通道：
  1) 行情交叉验证输入：东财 push2delay clist 行业板块 5 日 —— 板块周涨幅 + 主力资金净流入（权威 BK 代码）
  2) 社区讨论·主源：同花顺讨论 API（t.10jqka.com.cn，按板块代表性成分股归集）→ result['guba']
  3) 社区讨论·补充源：东财股吧板块吧 list 页第 1 页（内嵌 article_list JSON，每板块 1 请求）→ result['gubaEm']
     —— 东财为真实散户帖，且 bar 自带「板块总帖数」，可算 B 的真实帖数增量；触发「身份核实」立即熔断该通道
  4) 全网舆情文本：akshare 新浪财经 7x24 + 同花顺全球财经快讯 + 华尔街见闻 7x24 + 财联社电报（当日增量，周聚合时去重）
     —— 后两者 20260923 新增，均走独立域名（api-one.wallstcn.com / www.cls.cn），与 akshare 两源互为备份；
        财联社用本地签名 md5(sha1(排序 query))，零 key、零登录。
输出：data/hotTopics/daily/{date}.json（原子写入）
辅助：--scan 模式做 bk 代码段枚举（结果写 data/hotTopics/bk_scan_extra.json，用后人工并入 sector_map）
开关：data/hotTopics/config.json 的 community 节（{em, ths, emIntervalSec, emFailStreakMax}，默认两源皆启用）
     及 news 节（{sina, ths, wscn, cls} 四路快讯源开关，默认全启用）
诚实降级：任何通道失败都记录 status，不阻塞其他通道；两个社区源任一可用即非降级。
"""
import sys, os, re, json, time, random, argparse, http.cookiejar, traceback
from datetime import datetime, timedelta

sys.dont_write_bytecode = True
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
HEADERS = {'User-Agent': UA, 'Referer': 'https://guba.eastmoney.com/',
           'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
           'Accept-Language': 'zh-CN,zh;q=0.9'}


def _p(rel):
    return os.path.join(BASE, rel.replace('/', os.sep))


def load_sector_map(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_community_cfg():
    """读取 data/hotTopics/config.json 的 community 节（缺省：两源皆启用）。
    键：em(东财股吧开关) / ths(同花顺讨论开关) / emIntervalSec(东财抓取间隔) / emFailStreakMax(东财连续失败熔断阈值)。
    与 Node 侧 lib/hotTopicsWeekly/config.js 共用同一份用户配置。"""
    defaults = {'em': True, 'ths': True, 'emIntervalSec': 1.2,
                'emFailStreakMax': 3, 'emDailyBlock': True}
    try:
        with open(_p('data/hotTopics/config.json'), 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        c = cfg.get('community') or {}
        out = dict(defaults)
        for k in defaults:
            if k in c:
                out[k] = c[k]
        return out
    except Exception:
        return defaults


def load_news_cfg():
    """读取 data/hotTopics/config.json 的 news 节（缺省：四路快讯源皆启用，20260923）。
    键：sina(新浪财经 7x24) / ths(同花顺全球财经快讯) / wscn(华尔街见闻 7x24) / cls(财联社电报)。
    新增源默认开启；任一源失败仅自身返回空，不影响其他源（诚实降级）。"""
    defaults = {'sina': True, 'ths': True, 'wscn': True, 'cls': True}
    try:
        with open(_p('data/hotTopics/config.json'), 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        c = cfg.get('news') or {}
        out = dict(defaults)
        for k in defaults:
            if k in c:
                out[k] = c[k]
        return out
    except Exception:
        return defaults


def make_session(cookie_path):
    jar = http.cookiejar.MozillaCookieJar()
    if os.path.exists(cookie_path):
        try:
            jar.load(cookie_path, ignore_discard=True, ignore_expires=True)
        except Exception:
            pass
    s = requests.Session()
    s.cookies = jar
    s.headers.update(HEADERS)
    return s


def save_cookies(session, cookie_path):
    try:
        session.cookies.save(cookie_path, ignore_discard=True, ignore_expires=True)
    except Exception:
        pass


def extract_article_list(html):
    """从股吧页面 HTML 中提取内嵌 var article_list = {...}; 的 JSON（括号配对扫描）。"""
    idx = html.find('var article_list')
    if idx < 0:
        return None
    start = html.find('{', idx)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, min(start + 900000, len(html))):
        ch = html[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[start:i + 1])
                except Exception:
                    return None
    return None


def is_challenge(html):
    return ('身份核实' in html) or (len(html) < 5000) or ('article_list' not in html)


def fetch_guba_board(session, code):
    """抓单板块吧第 1 页。返回 (ok, data|None, challenge_hit)"""
    url = 'https://guba.eastmoney.com/list,%s.html' % code.lower()
    try:
        r = session.get(url, timeout=12)
        html = r.text
        if r.status_code != 200:
            return False, None, False
        if is_challenge(html):
            return False, None, True
        data = extract_article_list(html)
        if not data:
            return False, None, False
        posts = []
        for p in (data.get('re') or []):
            try:
                posts.append({
                    'id': str(p.get('post_id', '')),
                    'title': str(p.get('post_title', '') or ''),
                    'nick': str(p.get('user_nickname', '') or ''),
                    'clicks': _to_int(p.get('post_click_count')),
                    'comments': _to_int(p.get('post_comment_count')),
                    'time': str(p.get('post_publish_time', '') or ''),
                    'pinned': 1 if str(p.get('post_top_status') or '0') in ('1',) else 0,
                })
            except Exception:
                continue
        posts = [p for p in posts if p['title']]
        return True, {'bar_name': data.get('bar_name'), 'count': _to_int(data.get('count')), 'posts': posts}, False
    except Exception:
        return False, None, False


def _to_int(v):
    try:
        return int(float(str(v).replace(',', '')))
    except Exception:
        return 0


def _to_float(v):
    """'3.45%'→3.45；'12.3亿'→12.3（亿元口径统一）；'-2.1'→-2.1；失败→None"""
    if v is None:
        return None
    s = str(v).strip().replace('%', '').replace(',', '')
    if not s or s in ('-', '--'):
        return None
    mult = 1.0
    if s.endswith('亿'):
        mult, s = 1.0, s[:-1]
    elif s.endswith('万'):
        mult, s = 0.0001, s[:-1]
    try:
        return round(float(s) * mult, 4)
    except Exception:
        return None


CLIST_FIELDS = 'f12,f14,f2,f109,f164,f165,f257'


def collect_market():
    """行业板块 5 日资金流+周涨幅（东财 clist，push2delay 优先/ push2 兜底）。
    返回 rows 含 code（BKxxxx），供引擎按代码直配板块映射。"""
    params = {
        'pn': '1', 'pz': '100', 'po': '1', 'np': '1',
        'ut': 'b2884a393a59ad64002292a3e90d46a5', 'fltt': '2', 'invt': '2',
        'fid0': 'f164', 'fs': 'm:90 t:2', 'stat': '5',
        'fields': CLIST_FIELDS, 'rt': '52975239', '_': int(time.time() * 1000),
    }
    rows = []
    last_err = ''
    # 20261114c：实测 11-12 / 11-14 出现 RemoteDisconnected（服务端提前断连）。
    # 外部通道故障无法从代码层根治，此处做到：每 host 两轮尝试 + 20s 超时 + 失败退避，
    # 仍失败则如实留 error 状态，由前端标注「交叉验证今日不可用」，绝不编造数值。
    hosts = ('push2delay.eastmoney.com', 'push2.eastmoney.com') * 2
    for host in hosts:
        try:
            for pn in range(1, 7):  # 上限 600 条足够
                params['pn'] = str(pn)
                r = requests.get('https://%s/api/qt/clist/get' % host, params=params,
                                 headers={'User-Agent': UA}, timeout=20)
                d = r.json()
                diff = (d.get('data') or {}).get('diff') or []
                if not diff:
                    break
                for x in diff:
                    name = str(x.get('f14', '') or '')
                    if not name:
                        continue
                    rows.append({
                        'code': str(x.get('f12', '') or '').upper(),
                        'name': name,
                        'pct5d': x.get('f109') if isinstance(x.get('f109'), (int, float)) else None,
                        'netAmt5d': x.get('f164') if isinstance(x.get('f164'), (int, float)) else None,
                        'netPct5d': x.get('f165') if isinstance(x.get('f165'), (int, float)) else None,
                        'maxStock': str(x.get('f257') or ''),
                    })
                if len(diff) < 100:
                    break
                time.sleep(0.3)
            if rows:
                # 去重
                seen = set()
                uniq = []
                for r0 in rows:
                    if r0['code'] in seen:
                        continue
                    seen.add(r0['code'])
                    uniq.append(r0)
                return {'status': 'ok', 'host': host, 'rows': uniq}
        except Exception as e:
            last_err = str(e)[:120]
            time.sleep(2)
    if last_err:
        raise RuntimeError(last_err)
    return {'status': 'empty', 'rows': []}


# ---------- 全网舆情文本·补充两源（20260923，独立域名互为备份） ----------
WSCN_LIVES_URL = 'https://api-one.wallstcn.com/apiv1/content/lives'
CLS_ROLL_URL = 'https://www.cls.cn/v1/roll/get_roll_list'


def fetch_wallstreetcn(limit=30, channel='a-stock-channel'):
    """华尔街见闻 7x24 快讯（api-one.wallstcn.com，独立域名、无需鉴权）。
    ⚠️ channel 取 'a-stock-channel'（A 股 7×24）而**非** 'global-channel'：本模块 A 指标要按板块关键词
    归属，A 股频道命中率高；全球频道多为海外宏观/大宗（实测如「德国国债收益率」），基本无法归属到
    A 股板块，只会抬高条数基数却不产生区分度。
    返回 [{source,title,text,time}]；失败返回 []（不抛异常）。"""
    try:
        r = requests.get(WSCN_LIVES_URL,
                         params={'channel': channel, 'client': 'pc', 'limit': limit},
                         headers={'User-Agent': UA, 'Referer': 'https://wallstreetcn.com/live/global'},
                         timeout=12, proxies=THS_PROXIES)
        if r.status_code != 200:
            return []
        payload = r.json()
        if not isinstance(payload, dict) or payload.get('code') != 20000:
            return []
        out = []
        for it in ((payload.get('data') or {}).get('items') or []):
            text = (it.get('content_text') or '').strip()
            if not text:
                continue
            ts = it.get('display_time')
            t = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else ''
            out.append({'source': '华尔街见闻',
                        'title': (it.get('title') or '').strip() or text[:40],
                        'text': text, 'time': t})
        return out
    except Exception:
        return []


def fetch_cls_telegraph(page_size=30):
    """财联社电报（v1 API + 本地签名 md5(sha1(字典序 query))，零 key、零登录）。
    ⚠️ 签名必须对「拼好的 query 串」计算，故走完整 URL 拼装、不用 requests 的 params 重编码。
    返回 [{source,title,text,time}]；失败返回 []（不抛异常）。"""
    try:
        import hashlib
        params = {'appName': 'CailianpressWeb', 'os': 'web', 'sv': '7.7.5',
                  'last_time': '', 'refresh_type': '1', 'rn': str(page_size)}
        qs = '&'.join('%s=%s' % (k, params[k]) for k in sorted(params))
        sign = hashlib.md5(hashlib.sha1(qs.encode()).hexdigest().encode()).hexdigest()
        r = requests.get('%s?%s&sign=%s' % (CLS_ROLL_URL, qs, sign),
                         headers={'User-Agent': UA, 'Referer': 'https://www.cls.cn/'},
                         timeout=12, proxies=THS_PROXIES)
        if r.status_code != 200:
            return []
        payload = r.json()
        if not isinstance(payload, dict) or str(payload.get('errno')) != '0':
            return []
        out = []
        for it in ((payload.get('data') or {}).get('roll_data') or []):
            title = (it.get('title') or '').strip()
            text = re.sub(r'<[^>]+>', '', it.get('content') or '').strip()
            if not (title or text):
                continue
            ts = it.get('ctime')
            t = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else ''
            out.append({'source': '财联社', 'title': title or text[:40],
                        'text': text or title, 'time': t})
        return out
    except Exception:
        return []


def collect_news(cfg=None):
    """全网舆情文本（四路快讯源，任一失败不阻塞其他源）。
    cfg: load_news_cfg() 结果（{sina, ths, wscn, cls}），缺省全开。
    ⚠️ 口径提示：每增一路源都会抬高 A（曝光）的条数基数，而 A 为 Min-Max 归一化 → 榜单名次随之变化。"""
    cfg = cfg or {}
    items = []
    ak = None
    if cfg.get('sina', True) or cfg.get('ths', True):
        try:
            import akshare as ak  # noqa: F811
        except Exception:
            ak = None
    if cfg.get('sina', True) and ak is not None:
        try:
            df = ak.stock_info_global_sina()
            for _, r in df.iterrows():
                d = {str(k): ('' if r[k] is None else str(r[k]).strip()) for k in df.columns}
                t = d.get('时间', '')
                items.append({'source': '新浪财经', 'title': (d.get('内容') or '')[:40], 'text': d.get('内容', ''), 'time': t})
            if items:
                items[-1]['_last'] = 1
        except Exception:
            pass
        time.sleep(0.6)
    if cfg.get('ths', True) and ak is not None:
        try:
            df = ak.stock_info_global_ths()
            for _, r in df.iterrows():
                d = {str(k): ('' if r[k] is None else str(r[k]).strip()) for k in df.columns}
                items.append({'source': '同花顺', 'title': d.get('标题') or (d.get('内容') or '')[:40],
                              'text': d.get('内容', ''), 'time': d.get('时间', '')})
        except Exception:
            pass
    if cfg.get('wscn', True):
        time.sleep(0.4)
        items.extend(fetch_wallstreetcn())
    if cfg.get('cls', True):
        time.sleep(0.4)
        items.extend(fetch_cls_telegraph())
    return {'status': 'ok' if items else 'empty', 'items': items}


# ---------- 雪球公开热度榜 → 板块归集（20261114c） ----------
# 实测（2026-11-14）：雪球「热门话题/热帖/热股榜」接口均需登录或触发 WAF
#   （hots/topic/list.json=400、hot_rank/list=403、query/v1/search/status.json=400016），
#   只有 service/v5/stock/screener/screen 公开可用（xueqiu.com 会 301 到 www.xueqiu.com）。
# 因此本通道只消费「公开个股关注榜数值」（关注人数/排名/涨跌幅），不抓帖子正文、不做话题文本分析。
# 合规：遵守 lib/ai/earnings.js《来源分级》——论坛/社区内容只作市场情绪与热度代理，
#       绝不作为行情数字、财报数字或估值结论的依据。
XQ_SCREEN_URL = 'https://www.xueqiu.com/service/v5/stock/screener/screen'


def load_xq_cfg():
    """读取 data/hotTopics/config.json 的 xueqiu 节（缺省：启用 / 5 页 / 每页 200）。"""
    defaults = {'enabled': True, 'pages': 5, 'size': 200}
    try:
        with open(_p('data/hotTopics/config.json'), 'r', encoding='utf-8') as f:
            c = json.load(f).get('xueqiu') or {}
        out = dict(defaults)
        for k in defaults:
            if k in c:
                out[k] = c[k]
        return out
    except Exception:
        return defaults


def _xq_symbol(code):
    """6 位 A 股代码 → 雪球 SHxxxxxx / SZxxxxxx。"""
    c = str(code or '').strip()
    if len(c) != 6 or not c.isdigit():
        return ''
    return ('SH' if c[0] in '69' else 'SZ') + c


def fetch_xueqiu_follow_rank(max_pages=5, size=200):
    """雪球公开 A 股关注榜（无需登录）。返回 [{symbol,name,follow,pct,rank}]，失败返回 []。"""
    rows = []
    for page in range(1, max_pages + 1):
        url = (XQ_SCREEN_URL + '?category=CN&size=%d&order=desc&order_by=follow'
               '&only_count=0&page=%d' % (size, page))
        try:
            r = requests.get(url, headers={'User-Agent': UA, 'Referer': 'https://xueqiu.com/'},
                             timeout=15, proxies=THS_PROXIES)
            if r.status_code != 200:
                break
            lst = ((r.json() or {}).get('data') or {}).get('list') or []
            if not lst:
                break
            base = len(rows)
            for i, it in enumerate(lst):
                sym = str(it.get('symbol') or '').strip()
                if not sym:
                    continue
                try:
                    rows.append({'symbol': sym, 'name': str(it.get('name') or ''),
                                 'follow': int(it.get('follow') or 0),
                                 'pct': float(it.get('pct') or 0), 'rank': base + i + 1})
                except (TypeError, ValueError):
                    continue
            if len(lst) < size:
                break
            time.sleep(0.4)
        except Exception:
            break
    return rows


def collect_xueqiu(boards, members, cfg=None):
    """雪球热度 → 板块归集。全部确定性代码，LLM 不参与。

    口径（默认假设，写在此处以便人工裁决）：
      · 板块雪球热度 = 该板块代表性成分股在榜中的「排名得分」均值（未入榜记 0、不拉低均值）；
        排名得分 = 100 - (rank-1)*100/total（线性分位代理，越靠前越高）。
      · 只进 engine.js 的 crossCheck 交叉验证修正，不进 A/B/C/D/E 加权公式 ——
        因此不会抬高 Min-Max 归一化的条数基数，不引起榜单名次系统性漂移。
      · 回传 topStock / topRank，让板块热度能落到具体个股（服务个股热度判断）。
    返回 {status, boards:{code:{score,topStock,topRank,hits,stocks}}, count, rows, note}。
    """
    cfg = cfg or {}
    out = {'status': 'disabled', 'boards': {}, 'count': 0, 'rows': 0, 'note': ''}
    if not cfg.get('enabled', True):
        return out
    rank = fetch_xueqiu_follow_rank(int(cfg.get('pages', 5)), int(cfg.get('size', 200)))
    if not rank:
        out['status'] = 'error'
        out['note'] = '雪球公开关注榜不可用（接口变更/网络受限）'
        return out
    by_sym = {}
    for r in rank:
        by_sym.setdefault(r['symbol'], r)
    total = len(rank)
    raw_boards = {}
    for b in boards:
        code = b.get('code')
        if not code:
            continue
        scores, hits = [], []
        for m in (members.get(code) or []):
            sym = _xq_symbol(m.get('code'))
            hit = by_sym.get(sym)
            if not hit:
                continue
            s = max(0.0, 100.0 - (hit['rank'] - 1) * 100.0 / max(total, 1))
            scores.append(s)
            hits.append({'symbol': sym, 'name': hit['name'], 'rank': hit['rank'],
                         'follow': hit['follow'], 'pct': hit['pct'], 'raw': round(s, 2)})
        if not hits:
            continue
        top = sorted(hits, key=lambda x: x['rank'])[0]
        raw_boards[code] = {
            'raw': round(sum(scores) / len(scores), 2),
            'topStock': top['name'] or top['symbol'],
            'topRank': top['rank'],
            'hits': len(hits),
            'stocks': hits,
        }
    # ⚠️ 必须做板块间 Min-Max 归一化：原始排名分普遍偏高（前 1000 名大票约 80~99），
    #    直接拿绝对阈值 70 判定会让 85 个板块几乎全部命中「雪球热」，41 个被误判单源虚热、
    #    榜单名次大幅洗牌。归一化为 0~100 的**板块间分位**后，只有相对更热的板块参与修正。
    vals = [v['raw'] for v in raw_boards.values()]
    lo, hi = (min(vals), max(vals)) if vals else (0.0, 0.0)
    boards_data = {}
    for code, v in raw_boards.items():
        item = {k: val for k, val in v.items() if k != 'raw'}
        item['score'] = 50.0 if hi == lo else round((v['raw'] - lo) / (hi - lo) * 100, 2)
        boards_data[code] = item
    out.update({
        'status': 'ok', 'boards': boards_data, 'count': len(boards_data), 'rows': total,
        'note': '雪球公开关注榜（前 %d 名）按板块代表性成分股归集；仅作社区热度代理，非权威行情' % total,
    })
    return out


def _em_block_path():
    return _p('data/hotTopics/em_blocked_date.txt')


def em_blocked_today(date_str, enabled):
    """东财股吧当日已确认被反爬拦截 → 跳过本源，避免重复 92 次无效请求（约 2 分钟）。"""
    if not enabled:
        return False
    try:
        with open(_em_block_path(), 'r', encoding='utf-8') as f:
            return f.read().strip() == date_str
    except Exception:
        return False


def mark_em_blocked(date_str):
    try:
        path = _em_block_path()
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(date_str)
        os.replace(tmp, path)
    except Exception:
        pass


# ---------- 同花顺讨论 API（替代东财股吧：绕过验证码墙，20260910） ----------
THS_DISC_URL = 'https://t.10jqka.com.cn/lgt/post/open/api/forum/post/v2/recent'
THS_HEADERS = {
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
THS_PROXIES = {'http': None, 'https': None}
EM_CONST_HOST = 'push2delay.eastmoney.com'


def market_id_of(code):
    """同花顺讨论 API 的 market_id：沪市(600/601/603/605/688 科创板)=17，深市(000/001/002/003/300)=33。"""
    c = str(code or '').strip()
    if c.startswith('6'):
        return 17
    return 33


_TAG_RE = re.compile(r'<[^>]+>')
_ENT_RE = {'&amp;': '&', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
           '&ldquo;': '"', '&rdquo;': '"', '&hellip;': '…'}


def strip_tags(s):
    """剥离同花顺帖文里的 <hx_stock>/<span data-hx-tag> 等内联标签与 HTML 实体，返回纯文本。"""
    if not s:
        return ''
    t = str(s)
    for k, v in _ENT_RE.items():
        t = t.replace(k, v)
    t = _TAG_RE.sub('', t)
    return t.strip()


def fetch_ths_discussion(code, market_id, timeout=12):
    """取单只股票在同花顺的讨论（最新一页，最多 15 条）。返回帖子列表或 None(失败)。"""
    params = {'page': 1, 'page_size': 15, 'pid': 0, 'time': 0, 'sort': 'publish',
              'code': str(code), 'market_id': market_id}
    try:
        r = requests.get(THS_DISC_URL, params=params, headers=THS_HEADERS,
                         timeout=timeout, proxies=THS_PROXIES)
        if r.status_code != 200:
            return None
        j = r.json()
        feed = (j.get('data') or {}).get('feed') or []
        out = []
        for p in feed:
            content = strip_tags(p.get('content', ''))
            if not content:
                continue
            pid = p.get('pid') or p.get('id')
            if not pid:
                continue
            stat = p.get('stat') or {}
            try:
                likes = int(stat.get('like', 0) or 0)
            except Exception:
                likes = 0
            try:
                replies = int(stat.get('reply', 0) or 0)
            except Exception:
                replies = 0
            try:
                shares = int(stat.get('share', 0) or 0)
            except Exception:
                shares = 0
            out.append({
                'id': '%s_%s' % (code, pid),
                'title': content[:240],
                'nick': '',
                'clicks': likes + shares,
                'comments': replies,
                'time': str(p.get('ctime', '') or ''),
                'pinned': 0,
            })
        return out
    except Exception:
        return None


def build_members(boards, cache_path, max_age_days=7, top_n=3):
    """建立 板块码(BKxxxx) → 代表性成分股[{code,market_id}] 映射（按东财板块成分股市值前 top_n）。
    结果缓存到 cache_path，7 天内复用，避免每日重复抓取成分股。"""
    now = time.time()
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                cached = json.load(f)
            if (now - cached.get('_built', 0)) < max_age_days * 86400:
                return cached.get('members', {})
        except Exception:
            pass
    members = {}
    for b in boards:
        code = b.get('code')
        if not code:
            continue
        try:
            params = {'pn': 1, 'pz': 50, 'po': 1, 'np': 1,
                      'ut': 'b2884a393a59ad64002292a3e90d46a5', 'fltt': 2, 'invt': 2,
                      'fid': 'f20', 'fs': 'b:%s' % code, 'fields': 'f12,f14,f20'}
            r = requests.get('https://%s/api/qt/clist/get' % EM_CONST_HOST, params=params,
                             headers={'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/'},
                             timeout=12, proxies=THS_PROXIES)
            d = r.json()
            diff = (d.get('data') or {}).get('diff') or []

            def _mc(x):
                v = x.get('f20')
                try:
                    return float(v) if v is not None else 0
                except Exception:
                    return 0
            top = sorted(diff, key=_mc, reverse=True)[:top_n]
            mems = []
            for x in top:
                c = str(x.get('f12', '') or '').strip()
                if c:
                    mems.append({'code': c, 'market_id': market_id_of(c)})
            if mems:
                members[code] = mems
        except Exception:
            pass
        time.sleep(0.25)
    try:
        out = {'_built': now, 'members': members}
        tmp = cache_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.replace(tmp, cache_path)
    except Exception:
        pass
    return members


def collect_guba_ths(boards, members, min_interval):
    """同花顺讨论替代东财股吧：逐板块取其代表性成分股的讨论，归集到板块。
    返回 {status, boards:{code:{bar_name,count,posts}}, okCount, total, mapCount}（结构与旧 collect_guba 一致）。"""
    interval = min(min_interval, 0.6)  # 同花顺限流：单请求间隔收紧到 0.6s
    boards_data = {}
    ok_cnt = 0
    total = len(boards)
    fail_streak = 0
    challenged = False
    for i, b in enumerate(boards):
        code = b['code']
        mems = members.get(code) or []
        collected = []
        cnt = 0
        if mems:
            for m in mems:
                if fail_streak >= 15:
                    challenged = True
                    break
                res = fetch_ths_discussion(m['code'], m['market_id'])
                if res is None:
                    fail_streak += 1
                else:
                    fail_streak = 0
                    collected.extend(res)
                    cnt += len(res)
                if i < total - 1 or m is not mems[-1]:
                    time.sleep(interval + random.uniform(0, 0.25))
            if challenged:
                break
        boards_data[code] = {'bar_name': b.get('name'), 'count': cnt, 'posts': collected}
        if collected:
            ok_cnt += 1
    status = 'challenge' if challenged else ('ok' if ok_cnt > 0 else 'empty')
    return {'status': status, 'boards': boards_data, 'okCount': ok_cnt, 'total': total, 'mapCount': total}


def collect_guba_em(boards, cfg):
    """东财股吧「板块吧」第 1 页（20260913h 恢复为第二社区源）：每板块 1 请求，内嵌 article_list（真实散户帖）。
    返回结构与 collect_guba_ths 一致（便于引擎统一归集）：
      {status, boards:{code:{bar_name,count,posts}}, okCount, total, mapCount}
    与同花顺的语义差异（重要）：count = **板块总帖数**（bar 的 count 字段，如半导体 72561），
    故引擎可据此算 B 的「帖数真实增量」；posts 为当页采样帖（约 80 条）。
    风控：命中「身份核实」或连续失败 >= emFailStreakMax → 立即熔断（status='challenge'），不阻塞主流程。
    东财为 bk 板块代码（1 板块=1 请求），无需借助成分股。"""
    interval = max(float(cfg.get('emIntervalSec', 1.2)), 0.8)
    streak_max = int(cfg.get('emFailStreakMax', 8))
    session = make_session(_p('data/hotTopics/em_cookies.txt'))
    boards_data = {}
    ok_cnt = 0
    total = len(boards)
    fail_streak = 0
    challenged = False
    for i, b in enumerate(boards):
        code = b.get('code')
        if not code:
            continue
        if fail_streak >= streak_max:
            challenged = True
            break
        ok, data, ch = fetch_guba_board(session, code)
        if ch:
            challenged = True
            break
        if ok and data:
            boards_data[code] = {
                'bar_name': data.get('bar_name') or b.get('name'),
                'count': data.get('count'),
                'posts': data.get('posts') or [],
            }
            if data.get('posts'):
                ok_cnt += 1
            fail_streak = 0
        else:
            fail_streak += 1
        if i < total - 1:
            time.sleep(interval + random.uniform(0, 0.3))
    save_cookies(session, _p('data/hotTopics/em_cookies.txt'))
    status = 'challenge' if challenged else ('ok' if ok_cnt > 0 else 'empty')
    if challenged:
        # 反爬是外部风控，代码层无法根治。记录当日熔断，后续重采直接跳过本源，
        # 由同花顺单源承担社区数据，前端如实标注（不编造、不静默留白）。
        mark_em_blocked(datetime.now().strftime('%Y-%m-%d'))
    return {'status': status, 'boards': boards_data, 'okCount': ok_cnt,
            'total': total, 'mapCount': total, 'blockedToday': bool(challenged)}


def update_sector_map(promoted, removed):
    """采集成功日：候选板块自动校正进 sector_map（原子写）。"""
    if not promoted and not removed:
        return False
    path = _p('data/hotTopics/sector_map.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            m = json.load(f)
        boards = []
        rem = set(removed)
        for b in m.get('boards', []):
            if b['code'] in rem:
                continue
            hit = next((p for p in promoted if p['code'] == b['code']), None)
            if hit:
                b['name'] = hit['name']
                base_alias = re.sub(r'[ⅠⅡⅢIV]+$', '', hit['name']).strip()
                al = b.get('aliases') or []
                if base_alias and base_alias not in al:
                    al.append(base_alias)
                b['aliases'] = al
                b['keywords'] = b.get('keywords') or hit.get('keywords') or []
                b.pop('verify', None)
            boards.append(b)
        m['boards'] = boards
        m['updatedAt'] = datetime.now().strftime('%Y-%m-%dT%H:%M:%S+08:00')
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def run_scan(rng, cookie_path, min_interval):
    """--scan 模式：枚举某代码段（如 bk1050-bk1199），有效板块写 bk_scan_extra.json。"""
    a, b = rng.split('-')
    a_i, b_i = int(a[2:]), int(b[2:])
    session = make_session(cookie_path)
    found = []
    for i in range(a_i, b_i + 1):
        code = 'bk%04d' % i
        ok, data, ch = fetch_guba_board(session, code)
        if ch:
            break
        if ok and data.get('bar_name'):
            found.append({'code': code.upper(), 'name': data['bar_name']})
        time.sleep(min_interval + random.uniform(0, 0.3))
    out = _p('data/hotTopics/bk_scan_extra.json')
    old = []
    if os.path.exists(out):
        try:
            with open(out, 'r', encoding='utf-8') as f:
                old = json.load(f)
        except Exception:
            old = []
    seen = {x['code'] for x in old}
    for x in found:
        if x['code'] not in seen:
            old.append(x)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(old, f, ensure_ascii=False, indent=1)
    return {'scan': True, 'range': rng, 'found': len(found), 'total': len(old)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default=datetime.now().strftime('%Y-%m-%d'))
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--scan', default=None, help='bk0500-bk0599 形式的代码段枚举')
    ap.add_argument('--interval', type=float, default=1.2)
    args = ap.parse_args()

    if args.scan:
        print(json.dumps({'ok': True, **run_scan(args.scan, _p('data/hotTopics/em_cookies.txt'), args.interval)},
                         ensure_ascii=False))
        return 0

    outdir = _p('data/hotTopics/daily')
    os.makedirs(outdir, exist_ok=True)
    out_path = os.path.join(outdir, args.date + '.json')
    if os.path.exists(out_path) and not args.force:
        with open(out_path, 'r', encoding='utf-8') as f:
            old = json.load(f)
        print(json.dumps({'ok': True, 'skipped': True, 'date': args.date,
                          'summary': old.get('summary', {})}, ensure_ascii=False))
        return 0

    result = {'date': args.date, 'fetchedAt': datetime.now().strftime('%Y-%m-%dT%H:%M:%S+08:00'), 'errors': []}
    # 1) 行情交叉验证输入（push2delay clist，含权威板块代码）
    try:
        result['market'] = collect_market()
    except Exception as e:
        result['market'] = {'status': 'error', 'rows': []}
        result['errors'].append('market: ' + str(e)[:160])
    code_set = {r['code'] for r in result['market'].get('rows', []) if r.get('code')}
    name_by_code = {r['code']: r['name'] for r in result['market'].get('rows', []) if r.get('code')}
    # 2) 社区讨论（双源：同花顺讨论 API 为主源 + 东财股吧板块吧为补充源；任一可用即非降级）
    comm_cfg = load_community_cfg()
    news_cfg = load_news_cfg()
    xq_cfg = load_xq_cfg()
    boards = []
    try:
        m = load_sector_map(_p('data/hotTopics/sector_map.json'))
        boards = [b for b in m.get('boards', [])]
    except Exception as e:
        result['errors'].append('sector_map: ' + str(e)[:160])

    # 板块成分股映射：同花顺讨论与雪球归集共用，每日只构建一次（7 天缓存复用）
    members = {}
    try:
        members = build_members(boards, _p('data/hotTopics/sector_members.json'))
    except Exception as e:
        result['errors'].append('sector_members: ' + str(e)[:160])

    # 2a) 同花顺讨论 API（按板块代表性成分股归集）
    if comm_cfg.get('ths', True):
        try:
            result['guba'] = collect_guba_ths(boards, members, args.interval)
            result['guba']['mapCount'] = len(boards)
            result['guba']['memberTotal'] = sum(len(v) for v in members.values())
        except Exception as e:
            result['guba'] = {'status': 'error', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
            result['errors'].append('guba(ths): ' + str(e)[:160])
    else:
        result['guba'] = {'status': 'disabled', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
    # 2b) 东财股吧板块吧（真实散户帖 + 板块总帖数；1 板块 1 请求，带当日熔断记忆）
    if comm_cfg.get('em', True):
        if em_blocked_today(args.date, comm_cfg.get('emDailyBlock', True)):
            result['gubaEm'] = {'status': 'blocked', 'boards': {}, 'okCount': 0,
                                'mapCount': len(boards), 'blockedToday': True,
                                'note': '当日已确认东财股吧反爬拦截，跳过重采；社区数据由同花顺单源承担'}
        else:
            try:
                result['gubaEm'] = collect_guba_em(boards, comm_cfg)
            except Exception as e:
                result['gubaEm'] = {'status': 'error', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
                result['errors'].append('guba(em): ' + str(e)[:160])
    else:
        result['gubaEm'] = {'status': 'disabled', 'boards': {}, 'okCount': 0, 'mapCount': len(boards)}
    # 3) 舆情文本
    try:
        result['news'] = collect_news(news_cfg)
    except Exception as e:
        result['news'] = {'status': 'error', 'items': []}
        result['errors'].append('news: ' + str(e)[:160])
    # 4) 雪球公开热度榜（20261114c：按板块成分股归集，参与 crossCheck 热度判断）
    try:
        result['xueqiu'] = collect_xueqiu(boards, members, xq_cfg)
    except Exception as e:
        result['xueqiu'] = {'status': 'error', 'boards': {}, 'count': 0, 'rows': 0}
        result['errors'].append('xueqiu: ' + str(e)[:160])

    result['summary'] = {
        'market': result['market'].get('status'), 'marketRows': len(result['market'].get('rows', [])),
        'guba': result['guba'].get('status'), 'gubaOk': result['guba'].get('okCount', 0),
        'gubaTotal': result['guba'].get('mapCount', 0),
        'gubaEm': result.get('gubaEm', {}).get('status'), 'gubaEmOk': result.get('gubaEm', {}).get('okCount', 0),
        'gubaEmTotal': result.get('gubaEm', {}).get('mapCount', 0),
        'gubaEmBlocked': bool(result.get('gubaEm', {}).get('blockedToday')),
        'news': result['news'].get('status'), 'newsItems': len(result['news'].get('items', [])),
        'xq': result['xueqiu'].get('status'), 'xqBoards': result['xueqiu'].get('count', 0),
        'xqRows': result['xueqiu'].get('rows', 0),
    }
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, out_path)
    print(json.dumps({'ok': True, 'date': args.date, 'summary': result['summary'],
                      'errors': result['errors'][:3]}, ensure_ascii=False))
    return 0


import requests  # noqa: E402  (放在底部以便 --help 不依赖网络库)

if __name__ == '__main__':
    sys.exit(main() or 0)
