#!/usr/bin/env python3
"""
한아원 대시보드 서버
- 대시보드 HTML 서빙
- ERP API 프록시 (CORS 우회)
- 데이터 자동 갱신
"""
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

REFRESH_INTERVAL = 300  # 5분 (초)

DIR = Path(__file__).parent
CONFIG_PATH = DIR / "erp_config.json"
DATA_PATH = DIR / "data.json"
ADDR_CACHE_PATH = DIR / "address_cache.json"

def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)

def erp_authenticate(config):
    """Odoo JSON-RPC 인증 → session_id 반환"""
    data = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "call",
        "params": {
            "db": config["erp_db"],
            "login": config["erp_login"],
            "password": config["erp_password"]
        }
    }).encode()
    req = urllib.request.Request(
        f"{config['erp_url']}/web/session/authenticate",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    ctx = ssl.create_default_context()
    resp = urllib.request.urlopen(req, context=ctx)
    # Extract session_id from Set-Cookie header
    cookie_header = resp.headers.get_all("Set-Cookie") or []
    session_id = None
    for cookie in cookie_header:
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("session_id="):
                session_id = part.split("=", 1)[1]
    result = json.loads(resp.read())
    uid = result.get("result", {}).get("uid")
    if uid and session_id:
        print(f"[AUTH] Logged in as uid={uid}")
        return session_id
    print("[AUTH] Failed!")
    return None

def erp_rpc(config, session_id, model, method, args, kwargs):
    """Odoo JSON-RPC 호출"""
    data = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "call",
        "params": {"model": model, "method": method, "args": args, "kwargs": kwargs}
    }).encode()
    req = urllib.request.Request(
        f"{config['erp_url']}/web/dataset/call_kw/{model}/{method}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Cookie": f"session_id={session_id}"
        }
    )
    ctx = ssl.create_default_context()
    resp = urllib.request.urlopen(req, context=ctx)
    result = json.loads(resp.read())
    if "error" in result:
        raise Exception(result["error"].get("data", {}).get("message", "RPC Error"))
    return result["result"]

def fetch_erp_orders(config, session_id):
    """ERP에서 전체 주문 가져오기"""
    domain = [
        ["message_partner_ids", "child_of", config["partner_id"]],
        ["state", "in", ["sale", "done", "cancel"]]
    ]
    fields = ["name", "date_order", "partner_id", "amount_total", "state", "origin", "channel_type",
              "mp_recipient_address_state", "mp_recipient_address_city"]
    all_orders = []
    offset = 0
    while True:
        batch = erp_rpc(config, session_id, "sale.order", "search_read",
                        [domain], {"fields": fields, "limit": 200, "offset": offset, "order": "date_order desc"})
        all_orders.extend(batch)
        print(f"[ERP] Fetched {len(all_orders)} orders...")
        if len(batch) < 200:
            break
        offset += 200
    return all_orders


def load_address_cache():
    """주소 캐시 로드 (order_name → {state, city})"""
    if ADDR_CACHE_PATH.exists():
        try:
            with open(ADDR_CACHE_PATH) as f:
                return json.load(f)
        except:
            pass
    return {}


def save_address_cache(cache):
    """주소 캐시 저장"""
    with open(ADDR_CACHE_PATH, "w") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1)


US_STATE_MAP = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming", "DC": "Washington D.C.",
    "PR": "Puerto Rico", "GU": "Guam", "VI": "Virgin Islands", "AS": "American Samoa", "MP": "Northern Mariana Islands"
}
# 역매핑: 풀네임 → 약어 (소문자 키)
US_STATE_REVERSE = {v.lower(): k for k, v in US_STATE_MAP.items()}
US_STATES = set(US_STATE_MAP.keys())

CA_PROVINCE_MAP = {
    "AB": "Alberta", "BC": "British Columbia", "MB": "Manitoba",
    "NB": "New Brunswick", "NL": "Newfoundland and Labrador",
    "NS": "Nova Scotia", "NT": "Northwest Territories", "NU": "Nunavut",
    "ON": "Ontario", "PE": "Prince Edward Island", "QC": "Quebec",
    "SK": "Saskatchewan", "YT": "Yukon"
}
CA_PROVINCES = set(CA_PROVINCE_MAP.keys())


def normalize_state_name(raw_state):
    """주 이름 정규화: 약어 → 풀네임, 이미 풀네임이면 유지
    ex) 'CA' → 'California', 'New York' → 'New York', 'Ny' → 'New York'
    """
    if not raw_state:
        return ""
    s = raw_state.strip()
    # 약어 매칭 (대소문자 무시)
    upper = s.upper()
    if upper in US_STATE_MAP:
        return US_STATE_MAP[upper]
    if upper in CA_PROVINCE_MAP:
        return CA_PROVINCE_MAP[upper]
    # 풀네임 확인 (이미 올바른 경우)
    lower = s.lower()
    if lower in US_STATE_REVERSE:
        return US_STATE_MAP[US_STATE_REVERSE[lower]]
    # CA province 풀네임 확인
    ca_reverse = {v.lower(): v for v in CA_PROVINCE_MAP.values()}
    if lower in ca_reverse:
        return ca_reverse[lower]
    # 그대로 반환 (알 수 없는 지역)
    return s

def _scrape_order_address(erp_url, session_id, order_id, order_name):
    """단일 주문의 포탈 페이지에서 배송 주소 파싱 (US/CA/UK/기타)"""
    try:
        ctx = ssl.create_default_context()
        portal_url = f"{erp_url}/my/orders/{order_id}"
        req = urllib.request.Request(portal_url, headers={"Cookie": f"session_id={session_id}"})
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        html = resp.read().decode("utf-8")

        # <address> 태그에서 배송 주소 추출
        addr_blocks = re.findall(r'<address[^>]*>(.*?)</address>', html, re.DOTALL)
        if len(addr_blocks) < 2:
            return order_name, None

        # 마지막 address block = 배송 주소 (또는 2번째가 billing=shipping일 수도)
        shipping_block = addr_blocks[-1]
        clean = re.sub(r'<[^>]+>', '\n', shipping_block)
        lines = [l.strip() for l in clean.split('\n') if l.strip()]

        # 국가 탐지
        country = ""
        country_idx = -1
        for i, line in enumerate(lines):
            ll = line.strip().lower()
            if ll in ("united states", "us", "usa"):
                country = "US"
                country_idx = i
            elif ll in ("canada",):
                country = "CA"
                country_idx = i
            elif ll in ("united kingdom", "uk"):
                country = "UK"
                country_idx = i

        # 1) US 주소: City STATE ZIP (대소문자 무시)
        for line in lines:
            m = re.match(r'^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$', line.strip())
            if m:
                state_code = m.group(2).upper()
                if state_code in US_STATES:
                    return order_name, {
                        "city": m.group(1).strip().rstrip(','),
                        "state": state_code,
                        "zip": m.group(3),
                        "country": "US"
                    }

        # 2) Canadian 주소: City PROVINCE POSTALCODE (A1A 1A1)
        for line in lines:
            m = re.match(r'^(.+?)\s+([A-Za-z]{2})\s+([A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d)$', line.strip())
            if m:
                prov = m.group(2).upper()
                if prov in CA_PROVINCES:
                    return order_name, {
                        "city": m.group(1).strip().rstrip(','),
                        "state": prov,
                        "zip": m.group(3).upper(),
                        "country": "CA"
                    }

        # 3) UK 주소: 국가 라인 위에서 도시 추출
        if country == "UK" and country_idx >= 2:
            # UK format: ... / City / Region / PostalCode / United Kingdom
            # or: ... / City / PostalCode / United Kingdom
            postal_line = lines[country_idx - 1] if country_idx >= 1 else ""
            # UK postal code: A1 1AA, A1A 1AA, etc.
            uk_postal = re.match(r'^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$', postal_line.strip(), re.IGNORECASE)
            if uk_postal and country_idx >= 3:
                region = lines[country_idx - 2]
                city = lines[country_idx - 3] if country_idx >= 4 else region
                return order_name, {
                    "city": city,
                    "state": region,
                    "zip": postal_line.strip().upper(),
                    "country": "UK"
                }
            elif uk_postal and country_idx >= 2:
                city = lines[country_idx - 2]
                return order_name, {
                    "city": city,
                    "state": "UK",
                    "zip": postal_line.strip().upper(),
                    "country": "UK"
                }

        # 4) 국가만이라도 반환
        if country and country_idx >= 1:
            # Country 위 라인을 city로 사용
            city_line = lines[country_idx - 1] if country_idx >= 1 else ""
            return order_name, {
                "city": city_line,
                "state": country,
                "country": country
            }

        return order_name, None
    except Exception as e:
        print(f"[ADDR] Error scraping {order_name}: {e}")
        return order_name, None


def fetch_shipping_addresses(config, session_id, orders):
    """모든 주문의 배송 주소를 가져오기 (캐시 + 포탈 스크래핑)
    - mp_recipient_address_state 있는 주문: 마켓플레이스 데이터 사용
    - 없는 주문 (Shopify): 포탈 페이지 스크래핑
    Returns: dict {order_name: {state, city}}
    """
    cache = load_address_cache()
    addr_map = {}
    to_scrape = []

    for o in orders:
        name = o.get("name", "")
        mp_state = o.get("mp_recipient_address_state") or ""
        mp_city = o.get("mp_recipient_address_city") or ""
        ch = o.get("channel_type") or ""

        if not ch:
            continue  # 채널 없는 주문 제외

        # 마켓플레이스 데이터가 있으면 사용
        if mp_state and mp_state is not False:
            addr_map[name] = {"state": str(mp_state).strip(), "city": str(mp_city).strip()}
            continue

        # 캐시에 있으면 사용
        if name in cache and cache[name]:
            addr_map[name] = cache[name]
            continue

        # 스크래핑 필요
        to_scrape.append(o)

    if to_scrape:
        print(f"[ADDR] Scraping {len(to_scrape)} order addresses from portal pages...")
        erp_url = config["erp_url"]
        scraped = 0
        failed = 0

        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = {
                executor.submit(_scrape_order_address, erp_url, session_id, o["id"], o["name"]): o["name"]
                for o in to_scrape
            }
            for future in as_completed(futures):
                order_name, addr = future.result()
                if addr:
                    addr_map[order_name] = addr
                    cache[order_name] = addr
                    scraped += 1
                else:
                    failed += 1

        save_address_cache(cache)
        print(f"[ADDR] Scraped: {scraped} success, {failed} failed, {len(cache)} total cached")
    else:
        print(f"[ADDR] All addresses from cache/marketplace ({len(addr_map)} total)")

    return addr_map

def parse_csv_row(line):
    """간단한 CSV 파서 (따옴표 내 쉼표 처리)"""
    cells = []
    current = ""
    in_quote = False
    for ch in line:
        if ch == '"':
            in_quote = not in_quote
        elif ch == ',' and not in_quote:
            cells.append(current.strip().strip('"').strip())
            current = ""
        else:
            current += ch
    cells.append(current.strip().strip('"').strip())
    return cells


def fetch_google_sheet_names(config):
    """Google Sheet에서 리뷰 이름 가져오기 (채널별 분리).
    Amazon: 리뷰작성날짜 OR Review link 셀에 데이터 있으면 리뷰어 (구매날짜만으로는 리뷰어 아님)
    TikTok: 구매날짜 OR 리뷰작성날짜 셀에 데이터 있으면 리뷰어
    셀에 무언가(날짜, 링크 등) 작성되어 있으면 리뷰어로 판단.
    Returns dict: {all: [...], amazon: [...], tiktok: [...], amazon_entries: N, tiktok_entries: N}"""
    all_names = set()
    amazon_names = set()
    tiktok_names = set()
    amazon_entries = 0  # 제품별 중복 포함한 총 리뷰 엔트리 수
    tiktok_entries = 0
    sheet_id = config.get("google_sheet_id", "")
    gids = config.get("google_sheet_gids", {})
    ctx = ssl.create_default_context()
    skip_words = {"이름", "remove", "price", "odd", "상품명", "신청자수", "리뷰완료수",
                  "추가", "starter-kit", "refill-pack", "product name", "need more",
                  "new:", "will join", "-> already"}
    for tab, gid in gids.items():
        is_amazon = "amazon" in tab.lower()
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
        try:
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req, context=ctx)
            csv_text = resp.read().decode("utf-8")
            rows = [parse_csv_row(line) for line in csv_text.split("\n")]

            # 모든 행에서 "이름" 헤더 컬럼 찾기 (Oct + Jan 섹션 모두)
            name_groups = []  # [(name_col, header_row_idx), ...]
            seen_cols = set()
            for ri, row in enumerate(rows):
                for ci, cell in enumerate(row):
                    if cell == "이름" and ci not in seen_cols:
                        name_groups.append((ci, ri))
                        seen_cols.add(ci)

            if not name_groups:
                continue

            tab_entries = 0
            # 각 이름 컬럼에 대해 헤더 행 아래 데이터 추출
            for name_col, header_ri in name_groups:
                # 같은 행에서 구매날짜/리뷰날짜/리뷰링크 컬럼 위치 파악
                hrow = rows[header_ri] if header_ri < len(rows) else []
                date_col = review_col = link_col = None
                for j in range(name_col + 1, min(name_col + 7, len(hrow))):
                    cell_lower = hrow[j].lower().strip()
                    if "구매" in cell_lower and "날짜" in cell_lower:
                        date_col = j
                    elif "리뷰" in cell_lower and "날짜" in cell_lower:
                        review_col = j
                    elif "review link" in cell_lower and is_amazon:
                        link_col = j  # Amazon만 Review link 컬럼 사용

                # 헤더 행 아래의 데이터 행 순회
                for ri in range(header_ri + 1, len(rows)):
                    row = rows[ri]
                    if name_col >= len(row):
                        continue
                    name = row[name_col].strip()
                    if not name or len(name) < 2 or name.isdigit():
                        continue
                    if any(sw in name.lower() for sw in skip_words):
                        continue

                    # 셀에 내용이 있으면 리뷰어로 판단
                    has_date = (date_col is not None and date_col < len(row)
                                and row[date_col].strip() != "")
                    has_review = (review_col is not None and review_col < len(row)
                                  and row[review_col].strip() != "")
                    # Amazon만 Review link 확인
                    has_link = (is_amazon and link_col is not None
                                and link_col < len(row)
                                and row[link_col].strip() != "")

                    # Amazon: 리뷰작성날짜 OR Review link (구매날짜만으로는 리뷰어 아님)
                    # TikTok: 구매날짜 OR 리뷰작성날짜
                    if is_amazon:
                        if has_review or has_link:
                            all_names.add(name.lower())
                            amazon_names.add(name.lower())
                            tab_entries += 1
                    else:
                        if has_date or has_review:
                            all_names.add(name.lower())
                            tiktok_names.add(name.lower())
                            tab_entries += 1

            if is_amazon:
                amazon_entries += tab_entries
            else:
                tiktok_entries += tab_entries
            print(f"[SHEET] {tab} ({'Amazon' if is_amazon else 'TikTok'}): {len(name_groups)} sections, {tab_entries} entries")
        except Exception as e:
            print(f"[SHEET] Error fetching {tab}: {e}")
    print(f"[SHEET] Total: {len(all_names)} names (Amazon: {len(amazon_names)} names/{amazon_entries} entries, TikTok: {len(tiktok_names)} names/{tiktok_entries} entries)")
    return {
        "all": sorted(all_names),
        "amazon": sorted(amazon_names),
        "tiktok": sorted(tiktok_names),
        "amazon_entries": amazon_entries,
        "tiktok_entries": tiktok_entries
    }

def fetch_inventory(config, session_id):
    """ERP 포털 페이지에서 재고 데이터 스크래핑"""
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(f"{config['erp_url']}/portal/product", headers={"Cookie": f"session_id={session_id}"})
        resp = urllib.request.urlopen(req, context=ctx, timeout=30)
        html = resp.read().decode("utf-8")
        tbody = re.search(r'<tbody>(.*?)</tbody>', html, re.DOTALL)
        if not tbody:
            print("[INVENTORY] No tbody found")
            return []
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', tbody.group(1), re.DOTALL)
        inventory = []
        def _clean(s):
            return re.sub(r'<[^>]+>', '', s).strip()
        def _num(s):
            s = _clean(s).replace(',', '').replace('$', '').strip()
            try: return float(s)
            except: return 0.0
        for row in rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) < 12:
                continue
            name = _clean(cells[3])
            if not name:
                continue
            inventory.append({
                "name": name, "sku": _clean(cells[1]), "on_hand": _num(cells[8]),
                "forecasted": _num(cells[11]), "reserved": _num(cells[10]),
                "incoming": 0, "outgoing": _num(cells[10]),
            })
        print(f"[INVENTORY] {len(inventory)} products loaded")
        return inventory
    except Exception as e:
        print(f"[INVENTORY] Error: {e}")
        return []


def fetch_recharge_subscriptions(config):
    """ReCharge API에서 구독 데이터 가져오기 (활성+취소+고객정보)"""
    token = config.get("recharge_api_token", "")
    if not token:
        print("[RECHARGE] No API token configured, skipping")
        return {"active": [], "cancelled": []}

    ctx = ssl.create_default_context()
    base = "https://api.rechargeapps.com"
    headers = {"X-Recharge-Access-Token": token}

    def rc_get(endpoint):
        req = urllib.request.Request(f"{base}{endpoint}", headers=headers)
        resp = urllib.request.urlopen(req, context=ctx)
        return json.loads(resp.read())

    # 1) 전체 고객 목록 (이름 매핑)
    customers = {}
    try:
        cdata = rc_get("/customers?limit=250")
        for c in cdata.get("customers", []):
            customers[c["id"]] = {
                "name": f"{c.get('first_name','')} {c.get('last_name','')}".strip(),
                "email": c.get("email", ""),
                "status": c.get("status", "")
            }
        print(f"[RECHARGE] {len(customers)} customers loaded")
    except Exception as e:
        print(f"[RECHARGE] Error fetching customers: {e}")

    # 2) 활성 구독
    active = []
    try:
        adata = rc_get("/subscriptions?status=active&limit=250")
        for s in adata.get("subscriptions", []):
            cust = customers.get(s["customer_id"], {})
            next_dt = s.get("next_charge_scheduled_at") or ""
            if next_dt:
                try:
                    dt = datetime.strptime(next_dt[:10], "%Y-%m-%d")
                    next_fmt = dt.strftime("%b %d")
                except:
                    next_fmt = next_dt[:10]
            else:
                next_fmt = "-"
            # 결제 회차: next_charge와 created_at 간격으로 정확 계산
            charge_count = 1
            try:
                cr_date = datetime.strptime(s.get("created_at", "")[:10], "%Y-%m-%d")
                interval = int(s.get("charge_interval_frequency", 30) or 30)
                if next_dt:
                    nxt = datetime.strptime(next_dt[:10], "%Y-%m-%d")
                    total_days = (nxt - cr_date).days
                    charge_count = max(1, total_days // interval)
                else:
                    days_active = (datetime.now() - cr_date).days
                    charge_count = max(1, days_active // interval + 1)
            except:
                pass
            active.append({
                "n": cust.get("name", s.get("email", "Unknown")),
                "email": s.get("email", ""),
                "amt": s.get("price", 0),
                "next": next_fmt,
                "next_raw": next_dt[:10] if next_dt else "",
                "product": s.get("product_title", ""),
                "created": s.get("created_at", "")[:10],
                "sub_id": s.get("id"),
                "customer_id": s.get("customer_id"),
                "cc": charge_count
            })
        print(f"[RECHARGE] {len(active)} active subscriptions")
    except Exception as e:
        print(f"[RECHARGE] Error fetching active subs: {e}")

    # 3) 취소 구독
    cancelled = []
    try:
        cdata2 = rc_get("/subscriptions?status=cancelled&limit=250")
        for s in cdata2.get("subscriptions", []):
            cust = customers.get(s["customer_id"], {})
            created = s.get("created_at", "")[:10]
            cancelled_at = s.get("cancelled_at", "")[:10]
            # 구독 기간(일) 계산
            days = 0
            try:
                d1 = datetime.strptime(created, "%Y-%m-%d")
                d2 = datetime.strptime(cancelled_at, "%Y-%m-%d")
                days = (d2 - d1).days
            except:
                pass
            # 내부 테스트 계정 필터
            email = s.get("email", "")
            if email in ("test@test.com", "baek@hanah1.com"):
                continue
            # 결제 회차 계산
            interval = int(s.get("charge_interval_frequency", 30) or 30)
            charge_count = max(1, days // interval + 1) if days > 0 else 1
            cancelled.append({
                "n": cust.get("name", email),
                "email": email,
                "reason": s.get("cancellation_reason", ""),
                "created": created,
                "cancelled": cancelled_at,
                "days": days,
                "product": s.get("product_title", ""),
                "sub_id": s.get("id"),
                "customer_id": s.get("customer_id"),
                "cc": charge_count
            })
        print(f"[RECHARGE] {len(cancelled)} cancelled subscriptions (excl. test accounts)")
    except Exception as e:
        print(f"[RECHARGE] Error fetching cancelled subs: {e}")

    return {"active": active, "cancelled": cancelled}


FEMALE_NAMES = {"abbey","alexis","alice","amber","amina","angeline","anycia","ashley","autumn","ayushi",
    "becky","bella","britnee","brittany","bryn","carrie","caroline","cassidy","celeste","chioma","christina",
    "christine","cynthia","dawn","diana","dorothy","eleanor","electra","elina","elizabeth","emily","ester",
    "esha","fran","gilmerys","grace","heather","holly","huneza","hwa","hye","jane","jenny","jennifer",
    "jessica","jieun","jillian","jodie","judy","julie","kat","kate","katie","kathryn","kelley","khine",
    "kristin","leila","lexi","lidia","lily","linda","lindsay","lizbeth","liz","lydia","madison","malissa",
    "mandy","margot","maria","marion","mary","maya","megan","mei","melissa","michele","michelle","mimi",
    "misty","molly","monica","monise","nadine","nancy","natalie","natasha","nicole","norma","odontuya",
    "olive","olivia","onyinye","patricia","rachel","rebecca","riley","robin","rosa","roselyn","ruth",
    "samantha","sandra","sarah","shaikha","shanta","shelley","sofi","sophia","stacey","stephanie","susan",
    "talia","tamikka","tiffany","tina","vaishali","valentina","vanissa","vee","victoria","virginia",
    "wendi","wendy","yadira","yasmin","yolanda","yoli","you","yuliia","yumi","anna","caitlyn","karen",
    "lauren","lindsey","lisa","margaret","mia","pam","paula","sharon","tamara","valerie","quynh","tianyi"}
MALE_NAMES = {"allen","andrew","bill","brian","chris","daniel","david","derek","earl","eddie","edward",
    "frank","geonha","george","grant","greg","henry","jack","james","jason","javier","jerry","joey","john",
    "josh","justin","keith","ken","kevin","kyounghoon","larry","leo","luigi","mark","matt","michael","mike",
    "mohamed","nick","omar","patrick","paul","peter","randy","richard","rob","robert","roger","ron","ryan",
    "sam","scott","sean","steve","thomas","tim","todd","tom","tyler","victor","walter","wayne","william",
    "guardial","youngsoo","imri","rajvir","zhiyuan"}

def infer_gender(name):
    """이름에서 성별 추론: F/M/U"""
    if not name:
        return "U"
    first = name.lower().strip().split()[0] if name.strip() else ""
    if first in FEMALE_NAMES:
        return "F"
    if first in MALE_NAMES:
        return "M"
    return "U"


def refresh_data():
    """전체 데이터 갱신 → data.json 저장"""
    config = load_config()
    if config["erp_login"] == "YOUR_EMAIL_HERE":
        print("[ERROR] erp_config.json에 로그인 정보를 입력하세요!")
        return False

    print("[REFRESH] Starting data refresh...")
    session_id = erp_authenticate(config)
    if not session_id:
        return False

    # ERP 주문
    orders = fetch_erp_orders(config, session_id)

    # 배송 주소 스크래핑 (포탈 페이지 HTML 파싱)
    # mp_recipient_address_state는 마켓플레이스(Amazon/TikTok)만 제공
    # Shopify 주문은 포탈 페이지에서 스크래핑
    addr_map = fetch_shipping_addresses(config, session_id, orders)

    # 채널별 분류 + 주소 매핑
    sales_orders = []
    gender_unknown = set()
    addr_found = 0
    addr_missing = 0
    for o in orders:
        ch = o.get("channel_type") or ""
        if not ch:
            continue  # gifting/internal 제외
        cname = (o.get("partner_id") or [0, ""])[1]
        g = infer_gender(cname)
        if g == "U" and cname:
            gender_unknown.add(cname.split()[0].lower() if cname.split() else "")

        # 주소: 마켓플레이스 데이터 우선 → 스크래핑 데이터 → 빈값
        oname = o.get("name", "")
        mp_state = (o.get("mp_recipient_address_state") or "")
        mp_city = (o.get("mp_recipient_address_city") or "")
        if mp_state and mp_state is not False:
            state = str(mp_state).strip()
            city = str(mp_city).strip()
        elif oname in addr_map:
            state = addr_map[oname].get("state", "")
            city = addr_map[oname].get("city", "")
        else:
            state = ""
            city = ""

        # 주 이름 정규화: 약어 → 풀네임 (CA → California, NY → New York)
        state = normalize_state_name(state)

        if state:
            addr_found += 1
        else:
            addr_missing += 1

        sales_orders.append({
            "d": (o.get("date_order") or "")[:10],
            "t": o.get("amount_total", 0),
            "s": o.get("state", ""),
            "c": cname,
            "ch": ch,
            "src": o.get("origin") or "",
            "st": state,
            "ct": city,
            "g": g
        })
    if gender_unknown:
        print(f"[GENDER] Unknown first names: {sorted(gender_unknown)}")
    print(f"[ADDR] Address stats: {addr_found} with address, {addr_missing} missing")

    # 재고 데이터
    inventory = fetch_inventory(config, session_id)

    # Google Sheet 리뷰 이름 (채널별 분리)
    review_data = fetch_google_sheet_names(config)

    # ReCharge 구독 데이터
    recharge = fetch_recharge_subscriptions(config)

    # 저장
    data = {
        "updated_at": datetime.now().isoformat(),
        "source": "erp_api",
        "total_erp_orders": len(orders),
        "orders": sales_orders,
        "review_names": review_data["all"],
        "amazon_review_names": review_data["amazon"],
        "tiktok_review_names": review_data["tiktok"],
        "amazon_review_entries": review_data["amazon_entries"],
        "tiktok_review_entries": review_data["tiktok_entries"],
        "inventory": inventory,
        "recharge_active": recharge["active"],
        "recharge_cancelled": recharge["cancelled"]
    }
    with open(DATA_PATH, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    # file:// 접근용 data.js 생성
    js_path = DIR / "data.js"
    with open(js_path, "w") as f:
        f.write("var EMBEDDED_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";")
    print(f"[REFRESH] Saved data.js for offline access")

    by_ch = {}
    for o in sales_orders:
        ch = o["ch"]
        if ch not in by_ch:
            by_ch[ch] = {"count": 0, "total": 0}
        by_ch[ch]["count"] += 1
        by_ch[ch]["total"] += o["t"]

    print(f"[REFRESH] Done! {len(sales_orders)} sales orders, {len(review_data['all'])} review names (Amazon:{len(review_data['amazon'])}/{review_data['amazon_entries']}entries, TikTok:{len(review_data['tiktok'])}/{review_data['tiktok_entries']}entries)")
    for ch, v in by_ch.items():
        print(f"  {ch}: {v['count']} orders, ${v['total']:.2f}")
    return True


class DashboardHandler(SimpleHTTPRequestHandler):
    """대시보드 서버 핸들러"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIR), **kwargs)

    def do_GET(self):
        if self.path == "/":
            self.path = "/sales_dashboard.html"
            return super().do_GET()
        elif self.path == "/api/data":
            self._serve_json(DATA_PATH)
        elif self.path == "/api/refresh":
            self._handle_refresh()
        elif self.path == "/api/status":
            self._serve_status()
        else:
            return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/erp/"):
            self._proxy_erp()
        else:
            self.send_error(404)

    def _serve_json(self, path):
        try:
            with open(path) as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(content.encode())
        except FileNotFoundError:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"data.json not found. Run /api/refresh first."}')

    def _handle_refresh(self):
        try:
            success = refresh_data()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if success:
                auto_push_to_github()
                with open(DATA_PATH) as f:
                    data = json.load(f)
                self.wfile.write(json.dumps({
                    "ok": True,
                    "updated_at": data["updated_at"],
                    "order_count": len(data["orders"])
                }).encode())
            else:
                self.wfile.write(b'{"ok":false,"error":"Refresh failed. Check credentials."}')
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def _serve_status(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        status = {"server": "running"}
        if DATA_PATH.exists():
            with open(DATA_PATH) as f:
                data = json.load(f)
            status["data_updated_at"] = data.get("updated_at")
            status["order_count"] = len(data.get("orders", []))
        else:
            status["data_updated_at"] = None
        self.wfile.write(json.dumps(status).encode())

    def _proxy_erp(self):
        """ERP API 프록시 (CORS 우회)"""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b""
        erp_path = self.path.replace("/api/erp", "")
        config = load_config()
        try:
            req = urllib.request.Request(
                f"{config['erp_url']}{erp_path}",
                data=body,
                headers={"Content-Type": "application/json"}
            )
            ctx = ssl.create_default_context()
            resp = urllib.request.urlopen(req, context=ctx)
            result = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(result)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        try:
            msg = str(args[0]) if args else ""
            if "/api/" in msg:
                print(f"[API] {msg}")
        except Exception:
            pass


def auto_push_to_github():
    """data.js 변경 시 자동으로 GitHub에 push (GitHub Pages 실시간 반영)"""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "data.js"],
            cwd=str(DIR), capture_output=True, text=True, timeout=10
        )
        if "data.js" not in result.stdout:
            return  # 변경 없음
        subprocess.run(["git", "add", "data.js"], cwd=str(DIR), timeout=10)
        subprocess.run(
            ["git", "commit", "-m", f"data: auto-update {datetime.now().strftime('%m/%d %H:%M')}"],
            cwd=str(DIR), capture_output=True, timeout=10
        )
        push = subprocess.run(
            ["git", "push", "origin", "main"],
            cwd=str(DIR), capture_output=True, text=True, timeout=30
        )
        if push.returncode == 0:
            print(f"[GIT] ✓ data.js pushed to GitHub at {datetime.now().strftime('%H:%M:%S')}")
        else:
            print(f"[GIT] Push failed: {push.stderr.strip()}")
    except Exception as e:
        print(f"[GIT] Error: {e}")


def auto_refresh_loop():
    """백그라운드에서 5분마다 데이터 자동 갱신 + GitHub push"""
    while True:
        time.sleep(REFRESH_INTERVAL)
        try:
            print(f"[AUTO] Auto-refresh at {datetime.now().strftime('%H:%M:%S')}")
            success = refresh_data()
            if success:
                auto_push_to_github()
        except Exception as e:
            print(f"[AUTO] Error: {e}")


def main():
    if "--refresh" in sys.argv:
        # CLI에서 데이터만 갱신
        refresh_data()
        return

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

    # 백그라운드 자동 갱신 스레드 시작
    t = threading.Thread(target=auto_refresh_loop, daemon=True)
    t.start()
    print(f"[SERVER] Auto-refresh every {REFRESH_INTERVAL}s enabled")

    server = HTTPServer(("0.0.0.0", port), DashboardHandler)
    print(f"[SERVER] Dashboard: http://localhost:{port}")
    print(f"[SERVER] Refresh:   http://localhost:{port}/api/refresh")
    print(f"[SERVER] Status:    http://localhost:{port}/api/status")

    if not DATA_PATH.exists():
        print("[SERVER] No data.json found. Visit /api/refresh to fetch data.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[SERVER] Stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
