#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
巨潮资讯公告获取工具 - 获取上市公司公告

API: http://www.cninfo.com.cn/new/hisAnnouncement/query
"""

import httpx
import json
import os
import re
import io
import argparse
import time
from typing import List, Dict, Optional
from dataclasses import dataclass
from datetime import datetime


@dataclass
class Announcement:
    """公告数据结构"""
    announcement_id: str
    sec_code: str           # 股票代码
    sec_name: str            # 股票名称
    org_id: str              # 机构ID
    announcement_time: str    # 发布时间
    announcement_title: str  # 公告标题
    announcement_type: str    # 公告类型
    adjunct_url: str          # PDF链接
    

class CninfoReader:
    """巨潮资讯公告读取器"""
    
    BASE_URL = "https://www.cninfo.com.cn/new"
    
    def __init__(self, timeout: int = 30):
        self.client = httpx.Client(timeout=timeout)
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": "https://www.cninfo.com.cn",
            "Referer": "https://www.cninfo.com.cn/",
            "X-Requested-With": "XMLHttpRequest",
        }

    @staticmethod
    def _format_time(v) -> str:
        if v is None:
            return ""
        try:
            if isinstance(v, (int, float)):
                ts = float(v)
            else:
                s = str(v).strip()
                if not s:
                    return ""
                if s.isdigit():
                    ts = float(s)
                else:
                    return s
            if ts > 1e12:
                ts /= 1000.0
            elif ts > 1e10:
                ts /= 1000.0
            return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return "" if v is None else str(v)

    @staticmethod
    def _build_pdf_url(adjunct_url: str) -> str:
        u = (adjunct_url or "").strip()
        if not u:
            return ""
        if u.startswith("http://") or u.startswith("https://"):
            return u
        if not u.startswith("/"):
            u = "/" + u
        return "https://static.cninfo.com.cn" + u

    def get_announcement_pdf_text(self, ann: Announcement, max_chars: int = 20000) -> str:
        pdf_url = self._build_pdf_url(ann.adjunct_url)
        if not pdf_url:
            return ""
        self.client.get("https://www.cninfo.com.cn/", headers=self.headers)
        r = self.client.get(pdf_url, headers=self.headers)
        r.raise_for_status()
        pdf_bytes = r.content

        text = ""
        try:
            import fitz

            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            parts = []
            for page in doc:
                parts.append(page.get_text() or "")
            text = "\n".join(parts)
        except Exception:
            try:
                from pypdf import PdfReader

                reader = PdfReader(io.BytesIO(pdf_bytes))
                parts = []
                for page in reader.pages:
                    parts.append(page.extract_text() or "")
                text = "\n".join(parts)
            except Exception:
                try:
                    from PyPDF2 import PdfReader

                    reader = PdfReader(io.BytesIO(pdf_bytes))
                    parts = []
                    for page in reader.pages:
                        parts.append(page.extract_text() or "")
                    text = "\n".join(parts)
                except Exception:
                    return ""

        text = re.sub(r"\s+", " ", text).strip()
        if max_chars > 0 and len(text) > max_chars:
            text = text[:max_chars]
        return text
    
    def get_announcements(
        self,
        stock_code: str,
        org_id: str = "",
        start_date: str = "",
        end_date: str = "",
        category: str = "",
        page: int = 1,
        page_size: int = 30
    ) -> Dict:
        """
        获取个股公告列表
        
        Args:
            stock_code: 股票代码 (如 "600000")
            org_id: 机构ID (如 "9900002345")
            start_date: 开始日期 "YYYY-MM-DD"
            end_date: 结束日期 "YYYY-MM-DD"
            category: 公告类别筛选
            page: 页码
            page_size: 每页数量
        
        Returns:
            API响应字典
        """
        # 判断市场
        if stock_code.startswith("6"):
            column = "szse"  # 沪市
            plate = "sh"
        elif stock_code.startswith(("00", "30")):
            column = "szse"  # 深市
            plate = "sz"
        elif stock_code.startswith("8") or stock_code.startswith("4"):
            column = "szse"  # 北交所
            plate = "bj"
        else:
            column = "szse"
            plate = ""
        
        # 构造请求
        se_date = f"{start_date}~{end_date}" if start_date and end_date else ""
        
        data = {
            "pageNum": page,
            "pageSize": page_size,
            "column": column,
            "tabName": "fulltext",
            "plate": plate,
            "stock": f"{stock_code},{org_id}",
            "searchkey": "",
            "secid": "",
            "category": category,
            "trade": "",
            "seDate": se_date,
            "sortName": "time",
            "sortType": "desc",
            "isHLtitle": "true"
        }
        
        try:
            response = self.client.post(
                f"{self.BASE_URL}/hisAnnouncement/query",
                data=data,
                headers=self.headers
            )
            return response.json()
        except Exception as e:
            return {"error": str(e)}

    def get_daily_latest_by_stock(
        self,
        date: str,
        page_size: int = 50,
        max_pages: int = 200,
        category: str = ""
    ) -> List[Announcement]:
        se_date = f"{date}~{date}"
        seen = set()
        out: List[Announcement] = []
        for page in range(1, max_pages + 1):
            data = {
                "pageNum": page,
                "pageSize": page_size,
                "column": "szse",
                "tabName": "fulltext",
                "plate": "",
                "stock": "",
                "searchkey": "",
                "secid": "",
                "category": category,
                "trade": "",
                "seDate": se_date,
                "sortName": "time",
                "sortType": "desc",
                "isHLtitle": "true"
            }
            try:
                r = self.client.post(f"{self.BASE_URL}/hisAnnouncement/query", data=data, headers=self.headers)
                j = r.json()
            except Exception:
                break

            items = j.get("announcements")
            if not isinstance(items, list) or not items:
                break

            def _s(v):
                return "" if v is None else str(v)

            for item in items:
                sec_code = _s(item.get("sec_code") or item.get("secCode")).strip()
                if not sec_code or sec_code in seen:
                    continue
                seen.add(sec_code)
                out.append(Announcement(
                    announcement_id=_s(item.get("announcement_id") or item.get("announcementId")),
                    sec_code=sec_code,
                    sec_name=_s(item.get("sec_name") or item.get("secName")).strip(),
                    org_id=_s(item.get("org_id") or item.get("orgId")),
                    announcement_time=self._format_time(item.get("announcement_time") or item.get("announcementTime")),
                    announcement_title=_s(item.get("announcement_title") or item.get("announcementTitle")).strip(),
                    announcement_type=_s(item.get("announcement_type") or item.get("announcementType")).strip(),
                    adjunct_url=_s(item.get("adjunct_url") or item.get("adjunctUrl")).strip()
                ))
        return out
    
    def get_latest_announcements(self, stock_code: str, org_id: str = "", days: int = 7) -> List[Announcement]:
        """获取最近N天的公告"""
        from datetime import timedelta
        end_date = datetime.now().strftime("%Y-%m-%d")
        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        
        result = self.get_announcements(stock_code, org_id, start_date, end_date)
        
        announcements = []
        if "error" not in result and (result.get("error_code") in (0, None)) and isinstance(result.get("announcements"), list):
            def _s(v):
                return "" if v is None else str(v)
            for item in result.get("announcements", []):
                announcement_id = _s(item.get("announcement_id") or item.get("announcementId"))
                sec_code = _s(item.get("sec_code") or item.get("secCode"))
                sec_name = _s(item.get("sec_name") or item.get("secName"))
                org_id_v = _s(item.get("org_id") or item.get("orgId"))
                announcement_time = self._format_time(item.get("announcement_time") or item.get("announcementTime"))
                announcement_title = _s(item.get("announcement_title") or item.get("announcementTitle"))
                announcement_type = _s(item.get("announcement_type") or item.get("announcementType"))
                adjunct_url = _s(item.get("adjunct_url") or item.get("adjunctUrl"))
                announcements.append(Announcement(
                    announcement_id=announcement_id,
                    sec_code=sec_code,
                    sec_name=sec_name,
                    org_id=org_id_v,
                    announcement_time=announcement_time,
                    announcement_title=announcement_title,
                    announcement_type=announcement_type,
                    adjunct_url=adjunct_url
                ))
        
        return announcements

    def get_latest_announcement(self, stock_code: str, org_id: str = "") -> Optional[Announcement]:
        result = self.get_announcements(stock_code, org_id, page=1, page_size=1)
        if "error" in result or not isinstance(result.get("announcements"), list):
            return None
        items = result.get("announcements") or []
        if not items:
            return None
        item = items[0]
        def _s(v):
            return "" if v is None else str(v)
        ann = Announcement(
            announcement_id=_s(item.get("announcement_id") or item.get("announcementId")),
            sec_code=_s(item.get("sec_code") or item.get("secCode")),
            sec_name=_s(item.get("sec_name") or item.get("secName")),
            org_id=_s(item.get("org_id") or item.get("orgId")),
            announcement_time=self._format_time(item.get("announcement_time") or item.get("announcementTime")),
            announcement_title=_s(item.get("announcement_title") or item.get("announcementTitle")),
            announcement_type=_s(item.get("announcement_type") or item.get("announcementType")),
            adjunct_url=_s(item.get("adjunct_url") or item.get("adjunctUrl"))
        )
        if not org_id and ann.sec_code and ann.sec_code != stock_code:
            return None
        return ann
    
    def get_announcement_content(self, announcement_id: str) -> str:
        """
        获取公告正文内容 (HTML)
        通过PDF链接访问
        """
        url = f"{self.BASE_URL}/disclosure/detail?announcement_id={announcement_id}"
        try:
            response = self.client.get(url, headers=self.headers)
            # 这里需要解析返回的HTML提取正文
            # 简化版本返回标题
            return ""
        except Exception as e:
            return f"Error: {e}"
    
    def get_stock_org_id(self, stock_code: str) -> Optional[str]:
        """
        根据股票代码获取org_id
        需要调用股票信息接口
        """
        try:
            self.client.get("https://www.cninfo.com.cn/", headers=self.headers)
            response = self.client.post(
                f"{self.BASE_URL}/information/topSearch/query",
                params={"keyWord": stock_code, "maxNum": "10"},
                headers=self.headers
            )
            data = response.json()
            if isinstance(data, list):
                for item in data:
                    if str(item.get("code", "")).strip() == stock_code:
                        return str(item.get("orgId", "") or "").strip() or None
        except:
            pass
        return None
    
    def close(self):
        self.client.close()


class KimiLLM:
    def __init__(self, api_key: str, base_url: str, model: str, timeout: int = 60):
        self.api_key = api_key
        self.base_url = (base_url or "").rstrip("/")
        self.model = model
        self.client = httpx.Client(timeout=timeout)

    def summarize_zh(self, text: str, max_chars: int = 100) -> str:
        t = (text or "").strip()
        if not t:
            return ""
        prompt = (
            f"请将以下公告内容浓缩为不超过{max_chars}个汉字，保留关键信息（公司/事项/金额/时间/影响）。"
            "只输出摘要，不要标题，不要换行：\n"
            f"{t}"
        )
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": "你是严谨的中文财报/公告摘要助手。"},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
        }
        r = self.client.post(url, headers=headers, content=json.dumps(payload))
        r.raise_for_status()
        data = r.json()
        content = (
            (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
        )
        s = re.sub(r"\s+", " ", str(content)).strip()
        if max_chars > 0 and len(s) > max_chars:
            s = s[:max_chars]
        return s

    def close(self):
        self.client.close()


# 常用股票org_id映射表 (部分热门股票)
STOCK_ORG_ID_MAP = {
    # 沪市
    "600000": "9900002345",  # 浦发银行
    "600519": "9900002352",  # 贵州茅台
    "600036": "9900002342",  # 招商银行
    "600276": "9900002336",  # 恒瑞医药
    "601318": "9900002365",  # 中国平安
    "601888": "9900002367",  # 中国中免
    # 深市
    "000001": "9900002483",  # 平安银行
    "000002": "9900002484",  # 万科A
    "000858": "9900002498",  # 五粮液
    "000333": "9900002508",  # 美的集团
    "300750": "9900002518",  # 宁德时代
    "300059": "9900002522",  # 东方财富
}


def main():
    """测试用例"""
    reader = CninfoReader()
    
    parser = argparse.ArgumentParser()
    parser.add_argument("stock_codes", nargs="*", default=["002787", "002606", "300658", "600839", "600105"])
    parser.add_argument("--today", action="store_true")
    parser.add_argument("--date", default="")
    parser.add_argument("--max-stocks", type=int, default=200)
    parser.add_argument("--page-size", type=int, default=50)
    parser.add_argument("--max-pages", type=int, default=200)
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--summary-chars", type=int, default=100)
    parser.add_argument("--llm-model", default=os.getenv("KIMI_MODEL", os.getenv("LLM_MODEL", "moonshot-v1-8k")))
    parser.add_argument("--llm-base-url", default=os.getenv("KIMI_BASE_URL", os.getenv("LLM_BASE_URL", "https://api.moonshot.cn/v1")))
    parser.add_argument("--llm-api-key", default=os.getenv("KIMI_API_KEY", os.getenv("LLM_API_KEY", "")))
    args = parser.parse_args()

    llm = None
    if args.summary:
        if not args.llm_api_key:
            raise SystemExit("缺少KIMI_API_KEY环境变量或--llm-api-key")
        try:
            import fitz
        except Exception:
            try:
                from pypdf import PdfReader
            except Exception:
                try:
                    from PyPDF2 import PdfReader
                except Exception:
                    raise SystemExit("缺少PDF解析库：请安装pymupdf或pypdf")
        llm = KimiLLM(args.llm_api_key, args.llm_base_url, args.llm_model)

    try:
        def _fallback_summary(text: str, max_chars: int) -> str:
            s = re.sub(r"\s+", "", text or "").strip()
            if not s:
                return ""
            if max_chars > 0 and len(s) > max_chars:
                cut = s[:max_chars]
            else:
                cut = s
            i = cut.rfind("。")
            if i >= 20:
                cut = cut[: i + 1]
            return cut

        if args.today or args.date:
            d = args.date.strip() or datetime.now().strftime("%Y-%m-%d")
            anns = reader.get_daily_latest_by_stock(d, page_size=args.page_size, max_pages=args.max_pages)
            if args.max_stocks > 0:
                anns = anns[: args.max_stocks]
            for ann in anns:
                title = (ann.announcement_title or "").replace("\n", " ").strip()
                t = (ann.announcement_time or "").strip()
                name = (ann.sec_name or "").strip()
                stock_code = (ann.sec_code or "").strip()
                if not args.summary:
                    print(f"{stock_code}\t{name}\t{t}\t{title}")
                    continue
                pdf_text = reader.get_announcement_pdf_text(ann)
                if not pdf_text:
                    summary = ""
                else:
                    payload_text = f"股票:{stock_code} 名称:{name} 时间:{t} 标题:{title} 正文:{pdf_text}"
                    try:
                        summary = llm.summarize_zh(payload_text, max_chars=args.summary_chars) if llm else ""
                    except Exception:
                        summary = _fallback_summary(pdf_text, args.summary_chars)
                print(f"{stock_code}\t{name}\t{t}\t{title}\t{summary}")
            return

        for stock_code in args.stock_codes:
            org_id = STOCK_ORG_ID_MAP.get(stock_code, "") or (reader.get_stock_org_id(stock_code) or "")
            ann = reader.get_latest_announcement(stock_code, org_id)
            if not ann:
                print(f"{stock_code}\t无公告或请求失败")
                continue
            title = (ann.announcement_title or "").replace("\n", " ").strip()
            t = (ann.announcement_time or "").strip()
            name = (ann.sec_name or "").strip()
            if not args.summary:
                print(f"{stock_code}\t{name}\t{t}\t{title}")
                continue

            pdf_text = reader.get_announcement_pdf_text(ann)
            if not pdf_text:
                summary = ""
            else:
                payload_text = f"股票:{stock_code} 名称:{name} 时间:{t} 标题:{title} 正文:{pdf_text}"
                try:
                    summary = llm.summarize_zh(payload_text, max_chars=args.summary_chars) if llm else ""
                except Exception:
                    summary = _fallback_summary(pdf_text, args.summary_chars)
            print(f"{stock_code}\t{name}\t{t}\t{title}\t{summary}")
    finally:
        if llm:
            llm.close()
    
    reader.close()


if __name__ == "__main__":
    main()
