#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""板块舆情热度周榜 · 每日数据采集器（由 lib/hotTopicsWeekly/index.js 调度，每日一次）
三条通道：
  1) 行情交叉验证输入：akshare stock_sector_fund_flow_rank(5日) —— 板块周涨幅 + 主力资金净流入
  2) 社区讨论：东财股吧板块吧 list 页第 1 页（内嵌 article_list JSON）—— 每板块一次、限速、风控感知
  3) 全网舆情文本：akshare 新浪财经 7x24 + 同花顺全球财经快讯（当日增量，周聚合时去重）
输出：data/hotTopics/daily/{date}.json（原子写入）
辅助：--scan 模式做 bk 代码段枚举（结果写 data/hotTopics/bk_scan_extra.json，用后人工并入 sector_map）
诚实降级：任何通道失败都记录 status，不阻塞其他通道；股吧触发「身份核实」风控立即停止当日该通道。
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
    for host in ('push2delay.eastmoney.com', 'push2.eastmoney.com'):
        try:
            for pn in range(1, 7):  # 上限 600 条足够
                params['pn'] = str(pn)
                r = requests.get('https://%s/api/qt/clist/get' % host, params=params,
                                 headers={'User-Agent': UA}, timeout=12)
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
            time.sleep(1)
    if last_err:
        raise RuntimeError(last_err)
    return {'status': 'empty', 'rows': []}


def collect_news():
    import akshare as ak
    items = []
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
    try:
        df = ak.stock_info_global_ths()
        for _, r in df.iterrows():
            d = {str(k): ('' if r[k] is None else str(r[k]).strip()) for k in df.columns}
            items.append({'source': '同花顺', 'title': d.get('标题') or (d.get('内容') or '')[:40],
                          'text': d.get('内容', ''), 'time': d.get('时间', '')})
    except Exception:
        pass
    return {'status': 'ok' if items else 'empty', 'items': items}


def collect_guba(session, boards, cookie_path, min_interval):
    """逐板块抓取。返回 (status, boards_data, promoted, ok_codes)"""
    boards_data = {}
    promoted, removed = [], []
    challenged = False
    ok_cnt = 0
    for i, b in enumerate(boards):
        code = b['code']
        if challenged:
            break
        ok, data, ch = fetch_guba_board(session, code)
        if ch:
            challenged = True
            break
        if ok:
            ok_cnt += 1
            boards_data[code] = data
            # 候选板块自动校正：拿到权威 bar_name 后固化，错误代码剔除
            if b.get('verify'):
                bn = data.get('bar_name')
                if bn:
                    promoted.append({'code': code, 'name': bn, 'keywords': b.get('keywords', [])})
                else:
                    removed.append(code)
        if i < len(boards) - 1:
            time.sleep(min_interval + random.uniform(0, 0.35))
    status = 'challenge' if challenged else ('ok' if ok_cnt > 0 else 'empty')
    save_cookies(session, cookie_path)
    return {'status': status, 'boards': boards_data, 'promoted': promoted, 'removed': removed,
            'okCount': ok_cnt, 'total': len(boards)}


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
    # 2) 社区讨论（股吧）
    try:
        m = load_sector_map(_p('data/hotTopics/sector_map.json'))
        boards = [b for b in m.get('boards', [])]
        session = make_session(_p('data/hotTopics/em_cookies.txt'))
        result['guba'] = collect_guba(session, boards, _p('data/hotTopics/em_cookies.txt'), args.interval)
        result['guba']['mapCount'] = len(boards)
        # 候选板块校正：行情清单可验证代码有效性（不依赖股吧是否被风控）
        if code_set:
            promoted, removed = [], []
            for b in boards:
                if not b.get('verify'):
                    continue
                if b['code'] in code_set:
                    bn = result['guba']['boards'].get(b['code'], {}).get('bar_name') or name_by_code.get(b['code'])
                    if bn:
                        promoted.append({'code': b['code'], 'name': bn, 'keywords': b.get('keywords', [])})
                else:
                    removed.append(b['code'])
            if promoted or removed:
                result['guba']['promoted'] = promoted
                result['guba']['removed'] = removed
                update_sector_map(promoted, removed)
            else:
                result['guba'].pop('promoted', None)
                result['guba'].pop('removed', None)
    except Exception as e:
        result['guba'] = {'status': 'error', 'boards': {}, 'okCount': 0}
        result['errors'].append('guba: ' + str(e)[:160])
    # 3) 舆情文本
    try:
        result['news'] = collect_news()
    except Exception as e:
        result['news'] = {'status': 'error', 'items': []}
        result['errors'].append('news: ' + str(e)[:160])

    result['summary'] = {
        'market': result['market'].get('status'), 'marketRows': len(result['market'].get('rows', [])),
        'guba': result['guba'].get('status'), 'gubaOk': result['guba'].get('okCount', 0),
        'gubaTotal': result['guba'].get('mapCount', 0),
        'news': result['news'].get('status'), 'newsItems': len(result['news'].get('items', [])),
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
