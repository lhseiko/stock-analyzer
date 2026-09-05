#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
巨潮资讯网(CNINFO) / 东方财富(Eastmoney) 年报/半年报 批量下载脚本
====================================================================

功能：
  1. 批量下载多只 A 股公司的年报 + 半年报（默认），可扩展至季报。
  2. 支持多数据源通道（--channel）：
       cninfo     巨潮资讯网（官方披露，默认，PDF 直链最稳）
       eastmoney  东方财富公告中心（np-anotice 接口，从 attachments 取 PDF 直链）
       all        先巨潮后东方财富，互为备份
  3. 自动跳过已下载的文件（按 announcementId 记录 + 文件名去重），避免重复下载。
  4. 并发下载，提升批量效率。
  5. 支持命令行参数或文本文件传入股票代码。

依赖：仅使用 Python 标准库（urllib / concurrent.futures），无需 pip install。

用法示例：
  # 默认巨潮通道
  python download_reports.py --codes 600938,000001,601857

  # 指定东方财富通道
  python download_reports.py --codes 600938 --channel eastmoney

  # 全部通道（巨潮 + 东方财富，互为备份）
  python download_reports.py --codes 600938 --channel all

  # 输出机器可读的 JSON 结果（供工作台后端解析）
  python download_reports.py --codes 600938 --json
"""

import argparse
import json
import os
import re
import sys
import io
import time
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

# Windows 控制台默认 GBK，强制 stdout/stderr 用 UTF-8 以正常输出中文标题
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
except Exception:
    pass

# ----------------------------------------------------------------------------
# 常量
# ----------------------------------------------------------------------------
CNINFO_QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_QUERY_PAGE = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
CNINFO_STATIC_BASE = "https://static.cninfo.com.cn/"
# 东方财富公告中心接口（个股公告列表，含 attachments PDF 直链）
EM_ANN_URL = "https://np-anotice-stock.eastmoney.com/api/security/ann"
# 巨潮资讯「公告详情」接口（可返回 fileUrl PDF 直链）
CNINFO_BULLETIN_DETAIL_URL = "https://www.cninfo.com.cn/new/announcement/bulletin_detail"
CNINFO_PDF_BASE = "http://static.cninfo.com.cn/"

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
REFERER_CNINFO = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
REFERER_EM = "https://data.eastmoney.com/notices/"

# 可用通道
CHANNELS = ["cninfo", "eastmoney"]

# 报告类型 -> 标题关键字
REPORT_TYPE_KEYWORDS = {
    "annual": ["年度报告"],
    "semi": ["半年度报告"],
    "q1": ["第一季度报告", "一季度报告"],
    "q3": ["第三季度报告", "三季度报告"],
}

# 交易所代码前缀 -> CNINFO column 参数
EXCHANGE_COLUMN = {
    "SH": "sse",   # 6xxxxx / 9xxxxx
    "SZ": "szse",  # 0xxxxx / 3xxxxx
    "BJ": "bjse",  # 8xxxxx
}


# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------
def log(msg):
    """打印日志到 stderr，避免污染 --json 的标准输出。"""
    print(msg, file=sys.stderr, flush=True)


def detect_exchange(code):
    """根据代码判断交易所。"""
    c = code.strip().upper()
    c = re.sub(r"^(SH|SZ|BJ)", "", c)
    if c.startswith("6") or c.startswith("9"):
        return "SH"
    if c.startswith("8") or c.startswith("4"):
        return "BJ"
    return "SZ"


def sanitize_filename(name):
    """清理文件名中的非法字符（含全角符号）。"""
    for ch in ["/", "\\", ":", "*", "?", '"', "<", ">", "|",
              "：", "、", "（", "）", "·", "　"]:
        name = name.replace(ch, "_")
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"_+", "_", name)
    return name[:120].strip("_")


def ts_to_date(ts):
    """毫秒时间戳 -> YYYY-MM-DD。"""
    try:
        return time.strftime("%Y-%m-%d", time.localtime(int(ts) / 1000))
    except Exception:
        return ""


def em_date(s):
    """东方财富 notice_date '2024-04-03 00:00:00' -> '2024-04-03'。"""
    if not s:
        return ""
    return s[:10]


# 匹配优先级：更具体的类型先匹配（避免 "半年度报告" 被 "年度报告" 抢先）
REPORT_TYPE_PRIORITY = ["q1", "q3", "semi", "annual"]


def match_report_type(title, types):
    """判断公告标题属于哪种报告类型（仅返回用户指定的类型之一）。

    注意：'半年度报告' 包含 '年度报告' 子串，因此必须先检查更具体的类型。
    """
    for t in REPORT_TYPE_PRIORITY:
        if t not in types:
            continue
        for kw in REPORT_TYPE_KEYWORDS.get(t, []):
            if kw in title:
                return t
    return None


# ----------------------------------------------------------------------------
# 通用 opener
# ----------------------------------------------------------------------------
def _make_opener():
    """创建带 cookie 与代理支持的 opener（自动读取 HTTP_PROXY/HTTPS_PROXY 环境变量）。"""
    handlers = [urllib.request.HTTPCookieProcessor()]
    try:
        proxies = urllib.request.getproxies()
        if proxies:
            handlers.append(urllib.request.ProxyHandler(proxies))
    except Exception:
        pass
    return urllib.request.build_opener(*handlers)


def _warmup_cookie(opener):
    """先访问一次巨潮页面，让 opener 的 cookie jar 种下会话 cookie（JSESSIONID 等）。
    若直接 POST /query 而未预热，巨潮常返回空 announcements（totalRecordNum=0）。
    """
    try:
        req = urllib.request.Request(
            CNINFO_QUERY_PAGE,
            headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
        with opener.open(req, timeout=15) as resp:
            log("[cookie] 预热主页 HTTP %s，Set-Cookie=%s"
                % (getattr(resp, "status", None) or resp.getcode(),
                   "有" if resp.headers.get("Set-Cookie") else "无"))
    except Exception as e:
        log("[cookie] 预热主页失败(可忽略): %s" % e)


# ----------------------------------------------------------------------------
# 巨潮查询
# ----------------------------------------------------------------------------
def _query_one_page(opener, base_params, page, err_log=None):
    """查询单页公告。成功返回 (anns_list, j_dict, meta)；网络/解析失败返回 (None, None, meta)。"""
    params = dict(base_params)
    params["pageNum"] = str(page)
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        CNINFO_QUERY_URL, data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": REFERER_CNINFO,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*",
        },
    )
    meta = {"status": None, "body_head": "", "total_announcement": None,
            "classified_keys": [], "is_json": False, "set_cookie": ""}
    try:
        with opener.open(req, timeout=20) as resp:
            meta["status"] = getattr(resp, "status", None) or resp.getcode()
            meta["set_cookie"] = (resp.headers.get("Set-Cookie") or "")[:120]
            body = resp.read().decode("utf-8")
    except Exception as e:
        msg = "[查询] 第%d页请求失败: %s" % (page, e)
        log(msg)
        if err_log is not None:
            err_log.append(msg)
        return None, None, meta
    meta["body_head"] = body[:200]
    try:
        j = json.loads(body)
        meta["is_json"] = True
    except Exception as e:
        msg = "[查询] 第%d页返回非JSON，停止翻页: %s" % (page, e)
        log(msg)
        if err_log is not None:
            err_log.append(msg)
        return None, None, meta
    anns = j.get("announcements") or []
    meta["total_announcement"] = j.get("totalAnnouncement")
    ca = j.get("classifiedAnnouncements")
    if isinstance(ca, dict):
        meta["classified_keys"] = list(ca.keys())[:10]
    elif isinstance(ca, list):
        meta["classified_keys"] = [list(x.keys()) if isinstance(x, dict) else type(x).__name__
                                   for x in ca[:3]]
    return anns, j, meta


def _build_combos(base_column, prefix, code_norm):
    """构造参数组合列表（主组合优先，其余为备用）。"""
    return [
        {"column": base_column, "tabName": "fulltext", "stockCode": code_norm},
        {"column": base_column, "tabName": "fulltext", "stockCode": prefix + code_norm},
        {"column": base_column, "tabName": "fulltext", "stockCode": prefix.lower() + code_norm},
        {"column": base_column, "tabName": "", "stockCode": code_norm},
        {"column": "", "tabName": "fulltext", "stockCode": code_norm},
        {"column": base_column, "tabName": "company", "stockCode": code_norm},
    ]


def probe_combos(opener, code, name, years):
    """诊断模式：打印各参数组合下该股票的 totalRecordNum，不下载。"""
    exchange = detect_exchange(code)
    base_column = EXCHANGE_COLUMN.get(exchange, "szse")
    prefix = exchange
    code_norm = re.sub(r"\D", "", code)
    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1
    today = time.strftime("%Y-%m-%d", time.localtime())
    se_date = "%d-01-01~%s" % (start_year, today)
    common = {
        "pageSize": "30", "plate": "", "seDate": se_date, "isHL": "",
        "stockName": name or "", "indexCode": "", "category": "", "session": "",
    }
    combos = _build_combos(base_column, prefix, code_norm)
    log("=== 参数组合探测: %s ===" % code_norm)
    results = []
    for combo in combos:
        base = dict(common)
        base.update(combo)
        anns, j, meta = _query_one_page(opener, base, 1, None)
        entry = {
            "column": combo.get("column") or "",
            "tabName": combo.get("tabName") or "",
            "stockCode": combo.get("stockCode"),
            "totalRecordNum": None,
            "totalAnnouncement": meta.get("total_announcement"),
            "status": meta.get("status"),
            "isJson": meta.get("is_json"),
            "classifiedKeys": meta.get("classified_keys"),
            "hasCookie": bool(meta.get("set_cookie")),
            "sample": "",
            "ok": anns is not None,
            "error": "",
        }
        if anns is None:
            entry["error"] = "请求失败"
            log("  column=%-5s tabName=%-9s stockCode=%-9s -> 请求失败"
                % (combo.get("column") or "(空)", combo.get("tabName") or "(空)", combo.get("stockCode")))
        else:
            tr = j.get("totalRecordNum")
            entry["totalRecordNum"] = tr
            ta = meta.get("total_announcement")
            sample = ""
            if anns:
                a0 = anns[0]
                sample = "%s %s" % (a0.get("secCode"), a0.get("announcementTitle"))
                entry["sample"] = sample
            sample_txt = ("  样本: " + sample) if sample else ""
            ta_txt = ("  全站公告=%s" % ta) if ta is not None else ""
            ck = meta.get("classified_keys")
            ck_txt = ("  classifiedKeys=%s" % ck) if ck else ""
            st = meta.get("status")
            log("  column=%-5s tabName=%-9s stockCode=%-9s -> totalRecordNum=%s%s%s  [HTTP %s]%s"
                % (combo.get("column") or "(空)", combo.get("tabName") or "(空)",
                   combo.get("stockCode"), tr, sample_txt, ta_txt, st, ck_txt))
        results.append(entry)
    # 机器可读摘要（ensure_ascii=True 输出纯 ASCII，规避 Windows 管道编码乱码）
    print("PROBE_JSON:" + json.dumps(results, ensure_ascii=True))


def query_announcements(opener, code, name, years, types, err_log=None):
    """
    查询某只股票符合条件的公告（巨潮）。
    返回列表：[{secCode, announcementId, announcementTitle, adjunctUrl, adjunctType, date}]
    """
    exchange = detect_exchange(code)
    base_column = EXCHANGE_COLUMN.get(exchange, "szse")
    prefix = exchange  # SH / SZ / BJ
    code_norm = re.sub(r"\D", "", code)
    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1
    today = time.strftime("%Y-%m-%d", time.localtime())
    se_date = "%d-01-01~%s" % (start_year, today)

    common = {
        "pageSize": "30",
        "plate": "",
        "seDate": se_date,
        "isHL": "",
        "stockName": name or "",
        "indexCode": "",
        "category": "",
        "session": "",
    }

    combos = _build_combos(base_column, prefix, code_norm)

    chosen = None
    chosen_params = None
    for combo in combos:
        base = dict(common)
        base.update(combo)
        anns, j, _ = _query_one_page(opener, base, 1, err_log)
        if anns is None:
            continue  # 请求出错，试下一组合
        if anns:
            chosen = combo
            chosen_params = base
            log("  [探测] 采用参数组合 column=%s tabName=%s stockCode=%s（首屏 %d 条）"
                % (combo.get("column") or "(空)", combo.get("tabName") or "(空)",
                   combo.get("stockCode"), len(anns)))
            break
        if err_log is not None and combo is combos[0]:
            try:
                diag = "主组合返回 announcements 为空（totalRecordNum=%s）" % j.get("totalRecordNum")
            except Exception:
                diag = "主组合返回 announcements 为空"
            err_log.append(diag)

    if chosen is None:
        if err_log is not None:
            err_log.append("已尝试 %d 种参数组合（column/tabName/stockCode 变体）均返回 0 条公告，"
                           "可能该股票在巨潮无对应公告或接口字段已变更" % len(combos))
        return [], 0

    results = []
    seen_ids = set()
    total_seen = 0
    empty_streak = 0
    page = 1
    page_size = 30
    max_pages = 40

    while page <= max_pages:
        anns, j, _ = _query_one_page(opener, chosen_params, page, err_log)
        if anns is None:
            break
        total_seen += len(anns)
        if not anns:
            break

        matched_this_page = 0
        for a in anns:
            sec = a.get("secCode") or ""
            sec_name = a.get("secName") or ""
            sec_norm = re.sub(r"\D", "", sec)
            code_norm2 = re.sub(r"\D", "", code)
            if sec_norm and sec_norm != code_norm2:
                if name and name in sec_name:
                    pass
                else:
                    continue
            elif not sec and name and name not in sec_name:
                continue
            title = a.get("announcementTitle") or ""
            rtype = match_report_type(title, types)
            if not rtype:
                continue
            aid = a.get("announcementId")
            if not aid or aid in seen_ids:
                continue
            seen_ids.add(aid)
            results.append({
                "secCode": sec or code,
                "announcementId": aid,
                "announcementTitle": title,
                "adjunctUrl": a.get("adjunctUrl") or "",
                "adjunctType": (a.get("adjunctType") or "PDF").lower(),
                "date": ts_to_date(a.get("announcementTime")),
                "reportType": rtype,
            })
            matched_this_page += 1

        if len(anns) < page_size:
            break
        if matched_this_page == 0:
            empty_streak += 1
        else:
            empty_streak = 0
        if empty_streak >= 3:
            log("  [查询] 连续 %d 页无匹配，停止翻页（疑似 stockCode 未被服务端过滤）" % empty_streak)
            break
        page += 1

    return results, total_seen


# ----------------------------------------------------------------------------
# 巨潮资讯查询（akshare 披露查询 + bulletin_detail 接口）
# ----------------------------------------------------------------------------
def query_cninfo_v2(code, years, types, err_log=None):
    """
    新版巨潮通道：通过 akshare 的 stock_zh_a_disclosure_report_cninfo 查询公告列表，
    再调用巨潮 /new/announcement/bulletin_detail 接口获取 PDF 直链（fileUrl）。

    适用场景：旧版 hisAnnouncement/query 接口在本机/代理环境下被屏蔽或返回 500/0 条时，
    该路径通常仍可稳定访问。
    """
    try:
        import akshare as ak
    except ImportError as e:
        if err_log is not None:
            err_log.append("新版巨潮通道需要 akshare，但未安装: %s" % e)
        return [], 0

    code_norm = re.sub(r"\D", "", code)
    if not re.fullmatch(r"\d{6}", code_norm):
        if err_log is not None:
            err_log.append("新版巨潮通道：无效的 6 位代码 %s" % code)
        return [], 0

    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1
    start_date = "%d-01-01" % start_year
    end_date = time.strftime("%Y-%m-%d", time.localtime())

    type_to_category = {
        "annual": "年报",
        "semi": "半年报",
        "q1": "一季报",
        "q3": "三季报",
    }

    results = []
    seen_ids = set()
    total_returned = 0

    for t in types:
        category = type_to_category.get(t)
        if not category:
            continue
        try:
            df = ak.stock_zh_a_disclosure_report_cninfo(
                symbol=code_norm, market="沪深京", category=category,
                start_date=start_date.replace("-", ""),
                end_date=end_date.replace("-", ""),
            )
        except Exception as e:
            if err_log is not None:
                err_log.append("新版巨潮 %s 查询失败: %s" % (category, e))
            continue
        total_returned += len(df)
        if df.empty:
            continue
        for _, row in df.iterrows():
            title = str(row.get("公告标题") or "").strip()
            link = str(row.get("公告链接") or "").strip()
            date = str(row.get("公告时间"))[:10]
            m = re.search(r"announcementId=(\d+)", link)
            if not m:
                continue
            ann_id = m.group(1)
            if ann_id in seen_ids:
                continue
            # 过滤摘要类公告，优先取正文（PDF 更大）
            if "摘要" in title and any(k in title for k in ["年度报告", "半年度报告", "季度报告"]):
                # 保留摘要，但正文优先；后面同一年份同类型会去重
                pass
            seen_ids.add(ann_id)
            results.append({
                "secCode": code_norm,
                "announcementId": ann_id,
                "announcementTitle": title,
                "date": date,
                "reportType": t,
            })

    if not results:
        return [], total_returned

    # 获取每个公告的 PDF 直链
    enriched = []
    opener = _make_opener()
    for item in results:
        try:
            file_url = _fetch_bulletin_detail(opener, item["announcementId"], item["date"])
            if file_url:
                item["fileUrl"] = file_url
                enriched.append(item)
        except Exception as e:
            if err_log is not None:
                err_log.append("获取 %s PDF 链接失败: %s" % (item["announcementTitle"], e))

    # 同一年份同类型只保留正文（非摘要）；若只有摘要则保留摘要
    final = []
    seen_year_type = set()
    # 优先排非摘要，确保同一年份同类型先遇到正文
    enriched.sort(key=lambda x: 0 if "摘要" not in x.get("announcementTitle", "") else 1)
    for item in enriched:
        key = (item["date"][:4], item["reportType"])
        if key in seen_year_type:
            continue
        seen_year_type.add(key)
        final.append(item)

    return final, total_returned


def _fetch_bulletin_detail(opener, ann_id, announce_time):
    """调用巨潮 bulletin_detail 接口，返回完整 PDF 直链。"""
    params = {
        "announceId": ann_id,
        "flag": "false",
        "announceTime": announce_time,
    }
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        CNINFO_BULLETIN_DETAIL_URL, data=data,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": "https://www.cninfo.com.cn/new/disclosure/detail",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*",
        },
    )
    with opener.open(req, timeout=15) as resp:
        body = resp.read().decode("utf-8")
    j = json.loads(body)
    file_url = j.get("fileUrl") or j.get("announcement", {}).get("adjunctUrl", "")
    if file_url and not file_url.startswith("http"):
        file_url = CNINFO_PDF_BASE + file_url
    return file_url


# ----------------------------------------------------------------------------
# 东方财富查询
# ----------------------------------------------------------------------------
def query_eastmoney(opener, code, name, years, types, err_log=None):
    """
    查询某只股票符合条件的公告（东方财富公告中心 np-anotice 接口）。
    返回列表：[{secCode, announcementId, announcementTitle, fileUrl, fileName, referer, date, reportType}]

    说明：
      - np-anotice 列表项在「按个股过滤」时携带 attachments（含 file_url PDF 直链）。
      - 用 ann_type=2（个股公告）查询；若首屏 0 条，回退去掉 ann_type 再试（仍依赖 stock_list 过滤）。
      - 标题按报告类型关键字过滤。
    """
    code_norm = re.sub(r"\D", "", code)
    if not re.fullmatch(r"\d{6}", code_norm):
        if err_log is not None:
            err_log.append("东方财富：无效的 6 位代码 %s" % code)
        return []

    end_year = time.localtime().tm_year
    start_year = end_year - max(1, int(years)) + 1

    def _fetch(params):
        url = EM_ANN_URL + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Referer": REFERER_EM,
            "Accept": "application/json, text/plain, */*",
        })
        try:
            with opener.open(req, timeout=20) as resp:
                body = resp.read().decode("utf-8")
            return json.loads(body)
        except Exception as e:
            if err_log is not None:
                err_log.append("东方财富查询失败: %s" % e)
            return None

    results = []
    seen_ids = set()
    total_returned = 0
    used_params = None

    for attempt in ({"ann_type": "2", "client_source": "web", "stock_list": code_norm},
                    {"client_source": "web", "stock_list": code_norm}):
        params = dict(attempt)
        params.update({"sr": "-1", "page_size": "30", "page_index": "0"})
        j = _fetch(params)
        if j is None:
            continue
        data = j.get("data") or {}
        anns = data.get("list") or []
        total_hits = data.get("total_hits")
        if total_hits is not None and total_hits > 0:
            used_params = params
            log("  [东方财富] 命中接口公告数 total_hits=%s（ann_type=%s）"
                % (total_hits, params.get("ann_type", "(无)")))
            break
        else:
            log("  [东方财富] 该参数组合返回 0 条（ann_type=%s），尝试备用组合"
                % params.get("ann_type", "(无)"))

    if used_params is None:
        if err_log is not None:
            err_log.append("东方财富未返回该股票的任何公告（可能代码无对应披露或接口字段变更）")
        return [], 0

    # 正式翻页
    page = 0
    page_size = 30
    max_pages = 20
    while page < max_pages:
        params = dict(used_params)
        params["page_index"] = str(page)
        j = _fetch(params)
        if j is None:
            break
        anns = (j.get("data") or {}).get("list") or []
        total_returned += len(anns)
        if not anns:
            break

        for a in anns:
            title = (a.get("title") or a.get("title_ch") or "")
            rtype = match_report_type(title, types)
            if not rtype:
                continue
            atts = a.get("attachments") or []
            if not atts:
                continue
            # 优先取 PDF 附件
            pdf = None
            for at in atts:
                fu = (at.get("file_url") or "").lower()
                fn = (at.get("file_name") or "").lower()
                if fu.endswith(".pdf") or fn.endswith(".pdf") or "pdf" in fu:
                    pdf = at
                    break
            if pdf is None:
                pdf = atts[0]
            aid = a.get("art_code") or (pdf.get("file_url") or "")
            if not aid or aid in seen_ids:
                continue
            seen_ids.add(aid)
            results.append({
                "secCode": code_norm,
                "announcementId": aid,
                "announcementTitle": title,
                "fileUrl": pdf.get("file_url") or "",
                "fileName": pdf.get("file_name") or (title + ".pdf"),
                "referer": REFERER_EM,
                "date": em_date(a.get("notice_date")),
                "reportType": rtype,
            })

        if len(anns) < page_size:
            break
        page += 1

    return results, total_returned


# ----------------------------------------------------------------------------
# 下载
# ----------------------------------------------------------------------------
def download_one(opener, item, out_dir):
    """
    下载单个公告。返回 (status, item, path_or_reason)
    status: 'downloaded' | 'skipped' | 'error'

    兼容两种来源：
      - 巨潮：item 含 adjunctUrl（拼接 CNINFO_STATIC_BASE），referer 指向巨潮。
      - 东方财富：item 含 fileUrl（PDF 直链），referer 指向东方财富。
    """
    code = item["secCode"]
    date = item["date"] or "unknown"
    title = item["announcementTitle"]

    if item.get("fileUrl"):
        # 东方财富：完整 PDF 直链
        ext = "pdf"
        referer = item.get("referer") or REFERER_EM
        url = item["fileUrl"]
        base_name = sanitize_filename("%s_%s_%s" % (code, date, title))
    else:
        # 巨潮：静态基址 + 相对路径
        ext = (item.get("adjunctType") or "pdf").lower()
        if ext.lower() not in ("pdf", "html", "doc", "docx", "xls", "xlsx"):
            ext = "pdf"
        referer = REFERER_CNINFO
        url = CNINFO_STATIC_BASE + item["adjunctUrl"]
        base_name = sanitize_filename("%s_%s_%s" % (code, date, title))

    stock_dir = os.path.join(out_dir, code)
    os.makedirs(stock_dir, exist_ok=True)

    filename = base_name + "." + ext
    filepath = os.path.join(stock_dir, filename)

    # 1) 文件名去重：若已存在，跳过
    if os.path.exists(filepath):
        return ("skipped", item, filepath)

    # 2) announcementId 去重清单
    manifest_path = os.path.join(stock_dir, "_downloaded.json")
    manifest = {}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}
    if item["announcementId"] in manifest:
        return ("skipped", item, filepath)

    # 执行下载
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Referer": referer,
        "Accept": "*/*",
    })
    try:
        with opener.open(req, timeout=30) as resp:
            data = resp.read()
        if not data or len(data) < 500:
            return ("error", item, "文件过小或为空(%d字节)" % len(data))
        with open(filepath, "wb") as f:
            f.write(data)
        manifest[item["announcementId"]] = {
            "title": title, "date": date, "file": filename,
            "channel": item.get("channel", ""),
        }
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        return ("downloaded", item, filepath)
    except Exception as e:
        return ("error", item, str(e))


# ----------------------------------------------------------------------------
# 单通道执行
# ----------------------------------------------------------------------------
def run_channel(channel, codes, years, types, out_dir, workers, per_code):
    """执行单个通道的查询+下载，更新 per_code 聚合字典。返回该通道的汇总。"""
    summary = {
        "downloaded": 0, "skipped": 0, "errors": 0,
        "totalQueried": 0, "found": 0, "lastError": "",
    }

    for code, name in codes:
        # 规范化代码为 6 位
        norm_code = code
        if not re.fullmatch(r"\d{6}", norm_code):
            norm_code = re.sub(r"^(SH|SZ|BJ)", "", norm_code.upper())
        if not re.fullmatch(r"\d{6}", norm_code):
            log("[跳过] 无效代码: %s" % code)
            pc = per_code.setdefault(code, _new_per_code(code, name))
            pc["status"] = "invalid"
            summary["errors"] += 1
            continue

        log("[%s 查询] %s %s ..." % (channel, norm_code, name))
        opener = _make_opener()
        if channel == "cninfo":
            _warmup_cookie(opener)
            errs = []
            items, seen = query_announcements(opener, norm_code, name, years, types, errs)
            summary["totalQueried"] += seen
            # 旧接口（hisAnnouncement/query）在本机/代理环境下常被屏蔽或返回 0 条，
            # 回退到新版 akshare + bulletin_detail 接口。
            if not items:
                log("  [cninfo] 旧接口无结果，尝试新版 akshare 披露查询...")
                v2_items, v2_seen = query_cninfo_v2(norm_code, years, types, errs)
                if v2_items:
                    items = v2_items
                    seen += v2_seen
                    summary["totalQueried"] += v2_seen
                    summary["found"] += len(items)
                    # 旧接口的错误信息不应覆盖新版接口的成功结果
                    errs.clear()
                    log("  [cninfo] 新版接口命中 %d 份报告" % len(items))
            elif items:
                summary["found"] += len(items)
        else:  # eastmoney
            errs = []
            items, seen = query_eastmoney(opener, norm_code, name, years, types, errs)
            summary["totalQueried"] += seen

        if errs:
            summary["lastError"] = errs[-1]
        log("  -> [%s] 命中 %d 份报告（接口共返回 %d 条公告）" % (channel, len(items), seen))

        if not items:
            pc = per_code.setdefault(norm_code, _new_per_code(norm_code, name))
            pc["status"] = "none"
            pc["queried"] = pc.get("queried", 0) + seen
            continue

        code_downloaded = code_skipped = code_errors = 0
        # 标记通道，便于去重清单记录来源
        for it in items:
            it["channel"] = channel
        with ThreadPoolExecutor(max_workers=max(1, min(workers, 4))) as ex:
            futures = [ex.submit(download_one, opener, it, out_dir) for it in items]
            for fut in as_completed(futures):
                status, item, info = fut.result()
                if status == "downloaded":
                    code_downloaded += 1
                    summary["downloaded"] += 1
                    log("  [下载] %s %s -> %s" % (item["date"], item["announcementTitle"], os.path.basename(info)))
                elif status == "skipped":
                    code_skipped += 1
                    summary["skipped"] += 1
                else:
                    code_errors += 1
                    summary["errors"] += 1
                    log("  [失败] %s %s : %s" % (item["announcementTitle"], item["date"], info))

        pc = per_code.setdefault(norm_code, _new_per_code(norm_code, name))
        pc["name"] = name or pc.get("name", "")
        pc["found"] = pc.get("found", 0) + len(items)
        pc["downloaded"] = pc.get("downloaded", 0) + code_downloaded
        pc["skipped"] = pc.get("skipped", 0) + code_skipped
        pc["errors"] = pc.get("errors", 0) + code_errors
        pc["queried"] = pc.get("queried", 0) + seen
        if pc["status"] != "invalid":
            pc["status"] = "ok"

    return summary


def _new_per_code(code, name):
    return {"code": code, "name": name, "found": 0, "downloaded": 0,
            "skipped": 0, "errors": 0, "queried": 0, "status": "ok"}


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def parse_codes_argument(codes_arg, file_arg):
    """解析股票代码列表，支持 'code' 或 'code 名称' 形式。返回 [(code, name), ...]"""
    entries = []
    seen = set()
    if file_arg:
        with open(file_arg, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                code = re.sub(r"^(SH|SZ|BJ)", "", parts[0].upper())
                code = code.lstrip("0") if code.isdigit() and len(code) > 6 else code
                name = parts[1] if len(parts) > 1 else ""
                if code not in seen:
                    seen.add(code)
                    entries.append((code, name))
    if codes_arg:
        for c in codes_arg.split(","):
            c = c.strip()
            if not c:
                continue
            parts = c.split()
            code = re.sub(r"^(SH|SZ|BJ)", "", parts[0].upper())
            name = parts[1] if len(parts) > 1 else ""
            if code not in seen:
                seen.add(code)
                entries.append((code, name))
    return entries


def run(codes, years, types, out_dir, workers, as_json, probe=False, channel="cninfo"):
    if probe:
        for code, name in codes:
            norm_code = code
            if not re.fullmatch(r"\d{6}", norm_code):
                norm_code = re.sub(r"^(SH|SZ|BJ)", "", norm_code.upper())
            if not re.fullmatch(r"\d{6}", norm_code):
                log("[跳过] 无效代码: %s" % code)
                continue
            opener = _make_opener()
            _warmup_cookie(opener)
            probe_combos(opener, norm_code, name, years)
        return {"totalCodes": len(codes), "downloaded": 0, "skipped": 0,
                "errors": 0, "totalQueried": 0, "lastError": "", "details": []}

    os.makedirs(out_dir, exist_ok=True)

    # 规范化并预建 per_code
    norm_entries = []
    per_code = {}
    for code, name in codes:
        norm_code = code
        if not re.fullmatch(r"\d{6}", norm_code):
            norm_code = re.sub(r"^(SH|SZ|BJ)", "", norm_code.upper())
        if not re.fullmatch(r"\d{6}", norm_code):
            log("[跳过] 无效代码: %s" % code)
            per_code[code] = _new_per_code(code, name)
            per_code[code]["status"] = "invalid"
            norm_entries.append((code, name, False))
            continue
        per_code[norm_code] = _new_per_code(norm_code, name)
        norm_entries.append((norm_code, name, True))

    summary = {
        "totalCodes": len(codes),
        "downloaded": 0, "skipped": 0, "errors": 0,
        "totalQueried": 0, "lastError": "", "details": [],
        "channels": {},
        "fallback": False,  # 是否发生"东财受限 → 巨潮回退"
    }

    # 通道尝试顺序：巨潮(同花顺/巨潮披露)在本机始终可靠，作为兜底；
    # - 用户选"巨潮": 仅巨潮；
    # - 用户选"东方财富"/"全部通道": 先试东财，东财命中 0（本机常因网络限制返回全站公告而不过滤）
    #   时自动回退巨潮，确保一定能下到报告。
    for norm_code, name, valid in norm_entries:
        if not valid:
            continue
        if channel == "cninfo":
            order = ["cninfo"]
        else:  # eastmoney / all
            order = ["eastmoney", "cninfo"]

        for ch in order:
            ch_summary = run_channel(ch, [(norm_code, name)], years, types, out_dir, workers, per_code)
            # 合并到分通道汇总
            if ch not in summary["channels"]:
                summary["channels"][ch] = {"downloaded": 0, "skipped": 0, "errors": 0,
                                           "totalQueried": 0, "found": 0, "lastError": ""}
            cs = summary["channels"][ch]
            cs["downloaded"] += ch_summary["downloaded"]
            cs["skipped"] += ch_summary["skipped"]
            cs["errors"] += ch_summary["errors"]
            cs["totalQueried"] += ch_summary["totalQueried"]
            cs["found"] += ch_summary["found"]
            # 合并到总汇总
            summary["downloaded"] += ch_summary["downloaded"]
            summary["skipped"] += ch_summary["skipped"]
            summary["errors"] += ch_summary["errors"]
            summary["totalQueried"] += ch_summary["totalQueried"]
            if ch_summary.get("lastError"):
                summary["lastError"] = ch_summary["lastError"]

            if ch == "eastmoney" and ch_summary["found"] == 0:
                # 东财受限（返回全站公告但不按股票过滤），回退巨潮
                summary["fallback"] = True
                log("  [回退] 东方财富接口未返回 %s 的年报/半年报（本机网络受限），自动改用巨潮资讯网" % norm_code)
                continue
            break

    # 构建 per-code 明细（按原始 codes 顺序）
    summary["details"] = [per_code.get(c, _new_per_code(c, n)) for c, n in codes]

    if as_json:
        # 仅输出一行 JSON，便于后端解析
        print("RESULT_JSON:" + json.dumps(summary, ensure_ascii=False))
    else:
        log("")
        log("==== 下载完成 ====")
        log("代码数: %d | 新下载: %d | 跳过(已存在): %d | 失败: %d"
            % (summary["totalCodes"], summary["downloaded"], summary["skipped"], summary["errors"]))
        for ch, cs in summary["channels"].items():
            log("  通道 %s: 下载 %d / 跳过 %d / 失败 %d（接口返回 %d 条公告）"
                % (ch, cs["downloaded"], cs["skipped"], cs["errors"], cs["totalQueried"]))
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="巨潮资讯网 / 东方财富 年报/半年报 批量下载工具")
    parser.add_argument("--codes", help="股票代码，逗号分隔，如 600938,000001")
    parser.add_argument("--file", help="代码列表文件，每行一个代码（可附名称）")
    parser.add_argument("--years", type=int, default=5, help="回溯年份数（默认5）")
    parser.add_argument("--types", default="annual,semi",
                        help="报告类型: annual,semi,q1,q3（默认 annual,semi）")
    parser.add_argument("--out", default="../data/reports",
                        help="输出根目录（默认 ../data/reports）")
    parser.add_argument("--workers", type=int, default=4, help="单只股票内并发下载数（默认4）")
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON 结果")
    parser.add_argument("--probe", action="store_true",
                        help="仅探测参数组合（打印各组合的 totalRecordNum），不下载")
    parser.add_argument("--channel", default="cninfo",
                        choices=CHANNELS + ["all"],
                        help="数据源通道: cninfo(巨潮,默认) / eastmoney(东方财富) / all(全部)")
    args = parser.parse_args()

    types = [t.strip() for t in args.types.split(",") if t.strip() in REPORT_TYPE_KEYWORDS]
    if not types:
        types = ["annual", "semi"]

    codes = parse_codes_argument(args.codes, args.file)
    if not codes:
        log("错误：未提供任何股票代码。使用 --codes 或 --file 指定。")
        sys.exit(1)

    # out 目录相对本脚本位置解析
    out_dir = args.out
    if not os.path.isabs(out_dir):
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), out_dir)
    out_dir = os.path.abspath(out_dir)

    log("开始批量下载：共 %d 只股票，类型=%s，回溯%d年，通道=%s，输出=%s"
        % (len(codes), ",".join(types), args.years, args.channel, out_dir))
    run(codes, args.years, types, out_dir, args.workers, args.json, args.probe, args.channel)


if __name__ == "__main__":
    main()
