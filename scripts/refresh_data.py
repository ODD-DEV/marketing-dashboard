#!/usr/bin/env python3
"""
GitHub Actions용 데이터 갱신 스크립트
- 환경변수에서 config 읽기
- ERP API → 주문 데이터
- ReCharge API → 구독 데이터
- Google Sheets → 리뷰 데이터
- 출력: data.js (+ address_cache.json 갱신)
"""
import json
import os
import re
import ssl
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

DIR = Path(__file__).parent.parent  # repo root
ADDR_CACHE_PATH = DIR / "address_cache.json"


def load_config():
    """환경변수에서 config 로드 (GitHub Secrets → env vars)"""
    return {
        "erp_url": os.environ["ERP_URL"],
        "erp_db": os.environ["ERP_DB"],
        "erp_login": os.environ["ERP_LOGIN"],
        "erp_password": os.environ["ERP_PASSWORD"],
        "partner_id": int(os.environ["ERP_PARTNER_ID"]),
        "recharge_api_token": os.environ.get("RECHARGE_API_TOKEN", ""),
        "google_sheet_id": os.environ.get("GOOGLE_SHEET_ID", ""),
        "google_sheet_gids": json.loads(os.environ.get("GOOGLE_SHEET_GIDS", "{}")),
    }


# ═══ ERP (Odoo) ═══

def erp_authenticate(config):
    data = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "call",
        "params": {"db": config["erp_db"], "login": config["erp_login"], "password": config["erp_password"]}
    }).encode()
    req = urllib.request.Request(f"{config['erp_url']}/web/session/authenticate", data=data, headers={"Content-Type": "application/json"})
    ctx = ssl.create_default_context()
    resp = urllib.request.urlopen(req, context=ctx)
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
    data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "call", "params": {"model": model, "method": method, "args": args, "kwargs": kwargs}}).encode()
    req = urllib.request.Request(f"{config['erp_url']}/web/dataset/call_kw/{model}/{method}", data=data, headers={"Content-Type": "application/json", "Cookie": f"session_id={session_id}"})
    ctx = ssl.create_default_context()
    resp = urllib.request.urlopen(req, context=ctx)
    result = json.loads(resp.read())
    if "error" in result:
        raise Exception(result["error"].get("data", {}).get("message", "RPC Error"))
    return result["result"]


def fetch_erp_orders(config, session_id):
    domain = [["message_partner_ids", "child_of", config["partner_id"]], ["state", "in", ["sale", "done", "cancel"]]]
    fields = ["name", "date_order", "partner_id", "amount_total", "state", "origin", "channel_type", "mp_recipient_address_state", "mp_recipient_address_city"]
    all_orders = []
    offset = 0
    while True:
        batch = erp_rpc(config, session_id, "sale.order", "search_read", [domain], {"fields": fields, "limit": 200, "offset": offset, "order": "date_order desc"})
        all_orders.extend(batch)
        print(f"[ERP] Fetched {len(all_orders)} orders...")
        if len(batch) < 200:
            break
        offset += 200
    return all_orders


# ═══ Address scraping ═══

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
    if not raw_state:
        return ""
    s = raw_state.strip()
    upper = s.upper()
    if upper in US_STATE_MAP:
        return US_STATE_MAP[upper]
    if upper in CA_PROVINCE_MAP:
        return CA_PROVINCE_MAP[upper]
    lower = s.lower()
    if lower in US_STATE_REVERSE:
        return US_STATE_MAP[US_STATE_REVERSE[lower]]
    ca_reverse = {v.lower(): v for v in CA_PROVINCE_MAP.values()}
    if lower in ca_reverse:
        return ca_reverse[lower]
    return s


def _scrape_order_address(erp_url, session_id, order_id, order_name):
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(f"{erp_url}/my/orders/{order_id}", headers={"Cookie": f"session_id={session_id}"})
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        html = resp.read().decode("utf-8")
        addr_blocks = re.findall(r'<address[^>]*>(.*?)</address>', html, re.DOTALL)
        if len(addr_blocks) < 2:
            return order_name, None
        shipping_block = addr_blocks[-1]
        clean = re.sub(r'<[^>]+>', '\n', shipping_block)
        lines = [l.strip() for l in clean.split('\n') if l.strip()]
        country = ""
        country_idx = -1
        for i, line in enumerate(lines):
            ll = line.strip().lower()
            if ll in ("united states", "us", "usa"):
                country = "US"; country_idx = i
            elif ll in ("canada",):
                country = "CA"; country_idx = i
            elif ll in ("united kingdom", "uk"):
                country = "UK"; country_idx = i
        for line in lines:
            m = re.match(r'^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$', line.strip())
            if m:
                state_code = m.group(2).upper()
                if state_code in US_STATES:
                    return order_name, {"city": m.group(1).strip().rstrip(','), "state": state_code, "zip": m.group(3), "country": "US"}
        for line in lines:
            m = re.match(r'^(.+?)\s+([A-Za-z]{2})\s+([A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d)$', line.strip())
            if m:
                prov = m.group(2).upper()
                if prov in CA_PROVINCES:
                    return order_name, {"city": m.group(1).strip().rstrip(','), "state": prov, "zip": m.group(3).upper(), "country": "CA"}
        if country == "UK" and country_idx >= 2:
            postal_line = lines[country_idx - 1] if country_idx >= 1 else ""
            uk_postal = re.match(r'^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$', postal_line.strip(), re.IGNORECASE)
            if uk_postal and country_idx >= 3:
                return order_name, {"city": lines[country_idx - 3] if country_idx >= 4 else lines[country_idx - 2], "state": lines[country_idx - 2], "zip": postal_line.strip().upper(), "country": "UK"}
            elif uk_postal and country_idx >= 2:
                return order_name, {"city": lines[country_idx - 2], "state": "UK", "zip": postal_line.strip().upper(), "country": "UK"}
        if country and country_idx >= 1:
            return order_name, {"city": lines[country_idx - 1], "state": country, "country": country}
        return order_name, None
    except Exception as e:
        print(f"[ADDR] Error scraping {order_name}: {e}")
        return order_name, None


def load_address_cache():
    if ADDR_CACHE_PATH.exists():
        try:
            with open(ADDR_CACHE_PATH) as f:
                return json.load(f)
        except:
            pass
    return {}


def save_address_cache(cache):
    with open(ADDR_CACHE_PATH, "w") as f:
        json.dump(cache, f, ensure_ascii=False, indent=1)


def fetch_shipping_addresses(config, session_id, orders):
    cache = load_address_cache()
    addr_map = {}
    to_scrape = []
    for o in orders:
        name = o.get("name", "")
        mp_state = o.get("mp_recipient_address_state") or ""
        ch = o.get("channel_type") or ""
        if not ch:
            continue
        if mp_state and mp_state is not False:
            addr_map[name] = {"state": str(mp_state).strip(), "city": str(o.get("mp_recipient_address_city") or "").strip()}
            continue
        if name in cache and cache[name]:
            addr_map[name] = cache[name]
            continue
        to_scrape.append(o)
    if to_scrape:
        print(f"[ADDR] Scraping {len(to_scrape)} order addresses...")
        erp_url = config["erp_url"]
        scraped = failed = 0
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(_scrape_order_address, erp_url, session_id, o["id"], o["name"]): o["name"] for o in to_scrape}
            for future in as_completed(futures):
                order_name, addr = future.result()
                if addr:
                    addr_map[order_name] = addr; cache[order_name] = addr; scraped += 1
                else:
                    failed += 1
        save_address_cache(cache)
        print(f"[ADDR] Scraped: {scraped} success, {failed} failed, {len(cache)} total cached")
    else:
        print(f"[ADDR] All addresses from cache/marketplace ({len(addr_map)} total)")
    return addr_map


# ═══ Google Sheets ═══

def parse_csv_row(line):
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
    all_names = set()
    amazon_names = set()
    tiktok_names = set()
    amazon_entries = 0
    tiktok_entries = 0
    sheet_id = config.get("google_sheet_id", "")
    gids = config.get("google_sheet_gids", {})
    ctx = ssl.create_default_context()
    skip_words = {"이름", "remove", "price", "odd", "상품명", "신청자수", "리뷰완료수", "추가", "starter-kit", "refill-pack", "product name", "need more", "new:", "will join", "-> already"}
    for tab, gid in gids.items():
        is_amazon = "amazon" in tab.lower()
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"
        try:
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req, context=ctx)
            csv_text = resp.read().decode("utf-8")
            rows = [parse_csv_row(line) for line in csv_text.split("\n")]
            name_groups = []
            seen_cols = set()
            for ri, row in enumerate(rows):
                for ci, cell in enumerate(row):
                    if cell == "이름" and ci not in seen_cols:
                        name_groups.append((ci, ri))
                        seen_cols.add(ci)
            if not name_groups:
                continue
            tab_entries = 0
            for name_col, header_ri in name_groups:
                hrow = rows[header_ri] if header_ri < len(rows) else []
                date_col = review_col = link_col = None
                for j in range(name_col + 1, min(name_col + 7, len(hrow))):
                    cell_lower = hrow[j].lower().strip()
                    if "구매" in cell_lower and "날짜" in cell_lower:
                        date_col = j
                    elif "리뷰" in cell_lower and "날짜" in cell_lower:
                        review_col = j
                    elif "review link" in cell_lower and is_amazon:
                        link_col = j
                for ri in range(header_ri + 1, len(rows)):
                    row = rows[ri]
                    if name_col >= len(row):
                        continue
                    name = row[name_col].strip()
                    if not name or len(name) < 2 or name.isdigit():
                        continue
                    if any(sw in name.lower() for sw in skip_words):
                        continue
                    has_date = date_col is not None and date_col < len(row) and row[date_col].strip() != ""
                    has_review = review_col is not None and review_col < len(row) and row[review_col].strip() != ""
                    has_link = is_amazon and link_col is not None and link_col < len(row) and row[link_col].strip() != ""
                    if is_amazon:
                        if has_review or has_link:
                            all_names.add(name.lower()); amazon_names.add(name.lower()); tab_entries += 1
                    else:
                        if has_date or has_review:
                            all_names.add(name.lower()); tiktok_names.add(name.lower()); tab_entries += 1
            if is_amazon:
                amazon_entries += tab_entries
            else:
                tiktok_entries += tab_entries
            print(f"[SHEET] {tab} ({'Amazon' if is_amazon else 'TikTok'}): {len(name_groups)} sections, {tab_entries} entries")
        except Exception as e:
            print(f"[SHEET] Error fetching {tab}: {e}")
    print(f"[SHEET] Total: {len(all_names)} names (Amazon: {len(amazon_names)}/{amazon_entries}, TikTok: {len(tiktok_names)}/{tiktok_entries})")
    return {"all": sorted(all_names), "amazon": sorted(amazon_names), "tiktok": sorted(tiktok_names), "amazon_entries": amazon_entries, "tiktok_entries": tiktok_entries}


# ═══ ReCharge ═══

def fetch_recharge_subscriptions(config):
    token = config.get("recharge_api_token", "")
    if not token:
        print("[RECHARGE] No API token, skipping")
        return {"active": [], "cancelled": []}
    ctx = ssl.create_default_context()
    base = "https://api.rechargeapps.com"
    headers = {"X-Recharge-Access-Token": token}

    def rc_get(endpoint):
        req = urllib.request.Request(f"{base}{endpoint}", headers=headers)
        resp = urllib.request.urlopen(req, context=ctx)
        return json.loads(resp.read())

    customers = {}
    try:
        cdata = rc_get("/customers?limit=250")
        for c in cdata.get("customers", []):
            customers[c["id"]] = {"name": f"{c.get('first_name','')} {c.get('last_name','')}".strip(), "email": c.get("email", ""), "status": c.get("status", "")}
        print(f"[RECHARGE] {len(customers)} customers loaded")
    except Exception as e:
        print(f"[RECHARGE] Error fetching customers: {e}")

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
            charge_count = 1
            try:
                cr_date = datetime.strptime(s.get("created_at", "")[:10], "%Y-%m-%d")
                days_active = (datetime.now() - cr_date).days
                charge_count = max(1, days_active // 30 + 1)
            except:
                pass
            active.append({"n": cust.get("name", s.get("email", "Unknown")), "email": s.get("email", ""), "amt": s.get("price", 0), "next": next_fmt, "next_raw": next_dt[:10] if next_dt else "", "product": s.get("product_title", ""), "created": s.get("created_at", "")[:10], "sub_id": s.get("id"), "customer_id": s.get("customer_id"), "cc": charge_count})
        print(f"[RECHARGE] {len(active)} active subscriptions")
    except Exception as e:
        print(f"[RECHARGE] Error fetching active subs: {e}")

    cancelled = []
    try:
        cdata2 = rc_get("/subscriptions?status=cancelled&limit=250")
        for s in cdata2.get("subscriptions", []):
            cust = customers.get(s["customer_id"], {})
            created = s.get("created_at", "")[:10]
            cancelled_at = s.get("cancelled_at", "")[:10]
            days = 0
            try:
                d1 = datetime.strptime(created, "%Y-%m-%d")
                d2 = datetime.strptime(cancelled_at, "%Y-%m-%d")
                days = (d2 - d1).days
            except:
                pass
            email = s.get("email", "")
            if email in ("test@test.com", "baek@hanah1.com"):
                continue
            charge_count = max(1, days // 30 + 1) if days > 0 else 1
            cancelled.append({"n": cust.get("name", email), "email": email, "reason": s.get("cancellation_reason", ""), "created": created, "cancelled": cancelled_at, "days": days, "product": s.get("product_title", ""), "sub_id": s.get("id"), "customer_id": s.get("customer_id"), "cc": charge_count})
        print(f"[RECHARGE] {len(cancelled)} cancelled subscriptions")
    except Exception as e:
        print(f"[RECHARGE] Error fetching cancelled subs: {e}")

    return {"active": active, "cancelled": cancelled}


# ═══ Gender ═══

FEMALE_NAMES = {"abbey","alexis","alice","amber","amina","angeline","anycia","ashley","autumn","ayushi","becky","bella","britnee","brittany","bryn","carrie","caroline","cassidy","celeste","chioma","christina","christine","cynthia","dawn","diana","dorothy","eleanor","electra","elina","elizabeth","emily","ester","esha","fran","gilmerys","grace","heather","holly","huneza","hwa","hye","jane","jenny","jennifer","jessica","jieun","jillian","jodie","judy","julie","kat","kate","katie","kathryn","kelley","khine","kristin","leila","lexi","lidia","lily","linda","lindsay","lizbeth","liz","lydia","madison","malissa","mandy","margot","maria","marion","mary","maya","megan","mei","melissa","michele","michelle","mimi","misty","molly","monica","monise","nadine","nancy","natalie","natasha","nicole","norma","odontuya","olive","olivia","onyinye","patricia","rachel","rebecca","riley","robin","rosa","roselyn","ruth","samantha","sandra","sarah","shaikha","shanta","shelley","sofi","sophia","stacey","stephanie","susan","talia","tamikka","tiffany","tina","vaishali","valentina","vanissa","vee","victoria","virginia","wendi","wendy","yadira","yasmin","yolanda","yoli","you","yuliia","yumi","anna","caitlyn","karen","lauren","lindsey","lisa","margaret","mia","pam","paula","sharon","tamara","valerie","quynh","tianyi"}
MALE_NAMES = {"allen","andrew","bill","brian","chris","daniel","david","derek","earl","eddie","edward","frank","geonha","george","grant","greg","henry","jack","james","jason","javier","jerry","joey","john","josh","justin","keith","ken","kevin","kyounghoon","larry","leo","luigi","mark","matt","michael","mike","mohamed","nick","omar","patrick","paul","peter","randy","richard","rob","robert","roger","ron","ryan","sam","scott","sean","steve","thomas","tim","todd","tom","tyler","victor","walter","wayne","william","guardial","youngsoo","imri","rajvir","zhiyuan"}


def infer_gender(name):
    if not name:
        return "U"
    first = name.lower().strip().split()[0] if name.strip() else ""
    if first in FEMALE_NAMES:
        return "F"
    if first in MALE_NAMES:
        return "M"
    return "U"


# ═══ Main ═══

def refresh_data():
    config = load_config()
    print("[REFRESH] Starting data refresh...")
    session_id = erp_authenticate(config)
    if not session_id:
        raise RuntimeError("ERP authentication failed")

    orders = fetch_erp_orders(config, session_id)
    addr_map = fetch_shipping_addresses(config, session_id, orders)

    sales_orders = []
    for o in orders:
        ch = o.get("channel_type") or ""
        if not ch:
            continue
        cname = (o.get("partner_id") or [0, ""])[1]
        g = infer_gender(cname)
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
            state = ""; city = ""
        state = normalize_state_name(state)
        sales_orders.append({"d": (o.get("date_order") or "")[:10], "t": o.get("amount_total", 0), "s": o.get("state", ""), "c": cname, "ch": ch, "src": o.get("origin") or "", "st": state, "ct": city, "g": g})

    review_data = fetch_google_sheet_names(config)
    recharge = fetch_recharge_subscriptions(config)

    data = {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "source": "erp_api",
        "total_erp_orders": len(orders),
        "orders": sales_orders,
        "review_names": review_data["all"],
        "amazon_review_names": review_data["amazon"],
        "tiktok_review_names": review_data["tiktok"],
        "amazon_review_entries": review_data["amazon_entries"],
        "tiktok_review_entries": review_data["tiktok_entries"],
        "recharge_active": recharge["active"],
        "recharge_cancelled": recharge["cancelled"]
    }

    js_path = DIR / "data.js"
    with open(js_path, "w") as f:
        f.write("var EMBEDDED_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";")

    print(f"[REFRESH] Done! {len(sales_orders)} sales orders saved to data.js")


if __name__ == "__main__":
    refresh_data()
