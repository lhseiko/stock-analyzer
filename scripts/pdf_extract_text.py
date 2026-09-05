#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF 文本提取（pdfplumber）——供 lib/pdfText.js 调用。

从本地资料库的财报 PDF 中提取前 N 页正文，用于财报解读的上下文补充。
用法:
  python pdf_extract_text.py --file <pdf路径> [--max-pages N] [--char-cap N]
输出（stdout 单行 JSON）:
  {"ok": true, "pages": 实际提取页数, "total_pages": 全文档页数, "text": 正文, "truncated": bool}
  {"ok": false, "error": "..."}
"""
import argparse
import json
import re
import sys


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--max-pages", type=int, default=40)
    ap.add_argument("--char-cap", type=int, default=0, help="正文最大字符数，0=不限制")
    args = ap.parse_args()

    try:
        import pdfplumber
    except ImportError:
        print(json.dumps({"ok": False, "error": "pdfplumber 未安装"}, ensure_ascii=False))
        return

    try:
        parts = []
        total_chars = 0
        truncated = False
        with pdfplumber.open(args.file) as pdf:
            total = len(pdf.pages)
            limit = min(total, args.max_pages)
            for i in range(limit):
                try:
                    t = pdf.pages[i].extract_text() or ""
                except Exception:
                    t = ""
                parts.append(t)
                total_chars += len(t)
                if args.char_cap and total_chars >= args.char_cap:
                    truncated = True
                    break
            if limit < total:
                truncated = True

        text = "\n".join(parts)
        text = re.sub(r"[ \t\u3000]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if args.char_cap and len(text) > args.char_cap:
            text = text[: args.char_cap]

        print(json.dumps({
            "ok": True,
            "pages": len(parts),
            "total_pages": total,
            "text": text,
            "truncated": truncated,
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
