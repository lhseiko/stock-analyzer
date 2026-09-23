#!/usr/bin/env python3
# 巨潮资讯官方公告抓取（确定性数据，非 AI）。
# 复刻 a-stock-data 技能 cninfo_announcements（#19 orgId 动态映射修复）。
# 输出 JSON：{ok, code, orgId, count, items:[{title,type,date,url}]}
import os, sys, re, json
import requests
from datetime import datetime, timedelta

# 清除系统代理（与本机运行环境一致：系统代理会挂起请求）
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "cache")
ORGID_CACHE = os.path.join(CACHE_DIR, "cninfo_orgid.json")
ORGID_TTL = 7 * 24 * 3600  # 7 天


def _ts_to_date(ts):
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d")
    return str(ts)[:10] if ts else ""


def get_prefix(code):
    """6位代码 → 市场前缀（sh/sz/bj）。"""
    c = code.lower().strip()
    if c.endswith((".sh", ".sz", ".bj")):
        return c[-2:]
    if c.endswith((".xshg", ".xshe")):
        return "sh" if c.endswith(".xshg") else "sz"
    if c.startswith(("sh", "sz", "bj")):
        return c[:2]
    if c.startswith("92"):
        return "bj"
    if c.startswith(("5", "6", "9")):
        return "sh"
    if c.startswith(("4", "8")):
        return "bj"
    return "sz"


_ORGID_MAP = {}


def _load_orgid_map():
    global _ORGID_MAP
    try:
        if os.path.exists(ORGID_CACHE):
            with open(ORGID_CACHE, "r", encoding="utf-8") as f:
                cache = json.load(f)
            if (time_time() - cache.get("_ts", 0)) < ORGID_TTL:
                _ORGID_MAP = cache.get("map", {})
                return
    except Exception:
        pass
    try:
        r = requests.get("http://www.cninfo.com.cn/new/data/szse_stock.json",
                         headers={"User-Agent": UA}, timeout=15)
        data = r.json()
        _ORGID_MAP = {s["code"]: s["orgId"] for s in data.get("stockList", [])}
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(ORGID_CACHE, "w", encoding="utf-8") as f:
                json.dump({"_ts": time_time(), "map": _ORGID_MAP}, f, ensure_ascii=False)
        except Exception:
            pass
    except Exception as e:
        sys.stderr.write("[WARN] cninfo orgId 映射表拉取失败，回退硬编码规则: %s\n" % e)


def _cninfo_orgid(code):
    if not _ORGID_MAP:
        _load_orgid_map()
    org = _ORGID_MAP.get(code)
    if org:
        return org
    # fallback：老格式（仅部分老股票适用）
    return "gs%s0%s" % (get_prefix(code), code)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少股票代码参数"}, ensure_ascii=False))
        return
    code = re.sub(r"^(SH|SZ|BJ)", "", sys.argv[1], flags=re.I)
    code = re.sub(r"\.(SS|SZ|BJ)$", "", code, flags=re.I).strip()
    if not re.match(r"^\d{6}$", code):
        print(json.dumps({"ok": False, "error": "非A股6位代码: %s" % code}, ensure_ascii=False))
        return
    page_size = sys.argv[2] if len(sys.argv) > 2 else "30"
    try:
        org_id = _cninfo_orgid(code)
        payload = {
            "stock": "%s,%s" % (code, org_id),
            "tabName": "fulltext",
            "pageSize": str(page_size),
            "pageNum": "1",
            "column": "",
            "category": "",
            "plate": "",
            "seDate": "",
            "searchkey": "",
            "secid": "",
            "sortName": "",
            "sortType": "",
            "isHLtitle": "true",
        }
        headers = {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": "https://www.cninfo.com.cn/new/disclosure",
            "Origin": "https://www.cninfo.com.cn",
        }
        s = requests.Session()
        s.proxies = {"http": None, "https": None}
        r = s.post("https://www.cninfo.com.cn/new/hisAnnouncement/query",
                   data=payload, headers=headers, timeout=15)
        d = r.json()
        cutoff = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        anns = []
        for it in (d.get("announcements") or []):
            dt = _ts_to_date(it.get("announcementTime"))
            if dt and dt < cutoff:
                continue  # 仅保留近一年
            anns.append({
                "title": it.get("announcementTitle", ""),
                "type": it.get("announcementTypeName", ""),
                "date": dt,
                "url": "https://www.cninfo.com.cn/new/disclosure/detail?annoId=%s" % it.get("announcementId", ""),
            })
        print(json.dumps({"ok": True, "code": code, "orgId": org_id,
                          "count": len(anns), "items": anns}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))


def time_time():
    import time
    return time.time()


if __name__ == "__main__":
    main()
