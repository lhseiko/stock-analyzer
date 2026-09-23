#!/usr/bin/env python3
# 人民银行「社会融资规模增量统计表」解析（确定性数据，非 AI）。
# 复刻 a-stock-data 技能 pboc_social_financing（2021 年起支持）。
# 输出 JSON：{ok, year, month, afre_total, ytd_total, rmb_loans, government_bonds, source}
import os, sys, json, re
import requests

# 清除系统代理（与本机运行环境一致：系统代理会挂起请求）
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)

PBC_BASE = "https://www.pbc.gov.cn"
PBC_INDEX = PBC_BASE + "/diaochatongjisi/116219/116319/index.html"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def _get(url, timeout=30):
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def _abs(href):
    return href if href.startswith("http") else PBC_BASE + href


def main():
    try:
        import pandas as pd
        from io import BytesIO
    except Exception as e:
        print(json.dumps({"ok": False, "error": "pandas 不可用: %s" % str(e)[:200]}, ensure_ascii=False))
        return
    try:
        idx = _get(PBC_INDEX)
        years = re.findall(r'href=["\']([^"\']+)["\'][^>]*>\s*(\d{4})年统计数据\s*</a>', idx)
        if not years:
            print(json.dumps({"ok": False, "error": "人民银行索引页未找到年份链接"}, ensure_ascii=False))
            return
        table = {int(y): h for h, y in years}
        target = max(table)
        ypage = _get(_abs(table[target]))
        topics = re.findall(r'href=["\']([^"\']+)["\'][^>]*>\s*社会融资规模\s*</a>', ypage)
        if not topics:
            print(json.dumps({"ok": False, "error": "%d 年页未找到社会融资规模专题" % target}, ensure_ascii=False))
            return
        tpage = _get(_abs(topics[0]))
        books = re.findall(r'href=["\']([^"\']+\.xlsx?)["\']', tpage)
        if not books:
            print(json.dumps({"ok": False, "error": "社融专题页未找到 xlsx 附件"}, ensure_ascii=False))
            return
        content = requests.get(_abs(books[0]), headers=UA, timeout=60).content
        raw = pd.read_excel(BytesIO(content), header=None)
        start = None
        for i in range(len(raw)):
            if str(raw.iloc[i, 0]).strip() == "月份":
                start = i
                break
        if start is None:
            print(json.dumps({"ok": False, "error": "社融表无「月份」表头"}, ensure_ascii=False))
            return
        cols = ["month", "afre_total", "rmb_loans", "fx_loans", "entrusted_loans", "trust_loans",
                "undiscounted_bankers_acceptance", "corporate_bonds", "government_bonds",
                "equity_financing", "abs_by_depository", "loans_written_off"]
        df = raw.iloc[start + 3:].copy().iloc[:, :len(cols)]
        df.columns = cols
        df = df[df["month"].astype(str).str.match(r"^\d{4}\.\d{1,2}$", na=False)].copy()
        for c in cols[1:]:
            df[c] = pd.to_numeric(df[c], errors="coerce")

        def _ml(v):
            m = re.match(r"^(\d{4})\.(\d{1,2})$", str(v).strip())
            if not m:
                return None
            y, mo = m.group(1), m.group(2)
            if len(mo) == 1:
                mo += "0"
            return "%s-%02d" % (y, int(mo))

        df["month"] = [_ml(v) for v in df["month"]]
        df = df[df["month"].notna()]
        df = df[df["month"].str.startswith("%d-" % target)].reset_index(drop=True)
        df = df.dropna(subset=["afre_total"]).reset_index(drop=True)
        if df.empty:
            print(json.dumps({"ok": False, "error": "%d 年社融表无有效月份" % target}, ensure_ascii=False))
            return
        latest = df.loc[df["month"].idxmax()]  # 取最新已发布月份（表按月份升序，末行为最新）
        ytd = df["afre_total"].sum()
        out = {
            "ok": True,
            "year": target,
            "month": str(latest["month"]),
            "afre_total": float(latest["afre_total"]),
            "ytd_total": float(ytd),
            "rmb_loans": (None if pd.isna(latest["rmb_loans"]) else float(latest["rmb_loans"])),
            "government_bonds": (None if pd.isna(latest["government_bonds"]) else float(latest["government_bonds"])),
            "source": "中国人民银行·社会融资规模增量统计表",
        }
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
