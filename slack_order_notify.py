#!/usr/bin/env python3
"""
CGETC 신규 주문 → Slack 알림
- ERP(Odoo)에서 주기적으로 주문 조회
- 새 주문 감지 시 Slack Incoming Webhook으로 알림
"""
import json
import os
import ssl
import sys
import time
import urllib.request
from datetime import datetime

# ── 설정 (환경변수 우선, 없으면 기본값) ─────────────────
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
ERP_URL = os.environ.get("ERP_URL", "https://erp.cgetc.com")
ERP_DB = os.environ.get("ERP_DB", "linkup2017-cgetc-master-4705026")
ERP_LOGIN = os.environ.get("ERP_LOGIN", "it@hanah1.com")
ERP_PASSWORD = os.environ.get("ERP_PASSWORD", "")
PARTNER_ID = int(os.environ.get("PARTNER_ID", "1589358"))
POLL_INTERVAL = 2
ALLOWED_CHANNELS = {"tiktok_shop", "amazon"}
MIN_AMOUNT = 20
MAX_AMOUNT = 180
# ─────────────────────────────────────────────────────

# seen orders 메모리에만 보관 (서버 재시작 시 초기화 → 첫 폴링에서 다시 등록)
seen = set()


def erp_authenticate():
    """Odoo JSON-RPC 인증 → session_id"""
    data = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "call",
        "params": {"db": ERP_DB, "login": ERP_LOGIN, "password": ERP_PASSWORD}
    }).encode()
    req = urllib.request.Request(
        f"{ERP_URL}/web/session/authenticate",
        data=data, headers={"Content-Type": "application/json"}
    )
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
    print("[AUTH] Login failed!")
    return None


def fetch_recent_orders(session_id):
    """최근 주문 조회 (sale/done 상태, 최신 50건)"""
    domain = [
        ["message_partner_ids", "child_of", PARTNER_ID],
        ["state", "in", ["sale", "done"]]
    ]
    fields = ["name", "date_order", "partner_id", "amount_total",
              "state", "origin", "channel_type"]
    data = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "call",
        "params": {
            "model": "sale.order", "method": "search_read",
            "args": [domain],
            "kwargs": {"fields": fields, "limit": 50, "offset": 0, "order": "date_order desc"}
        }
    }).encode()
    req = urllib.request.Request(
        f"{ERP_URL}/web/dataset/call_kw/sale.order/search_read",
        data=data,
        headers={"Content-Type": "application/json", "Cookie": f"session_id={session_id}"}
    )
    ctx = ssl.create_default_context()
    resp = urllib.request.urlopen(req, context=ctx)
    result = json.loads(resp.read())
    if "error" in result:
        raise Exception(result["error"].get("data", {}).get("message", "RPC Error"))
    return result["result"]


def get_stock_info(session_id, order_id):
    """주문 상품의 재고 수량을 간단히 반환"""
    try:
        # 1) order line에서 상품 ID 조회
        data = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "call",
            "params": {
                "model": "sale.order.line", "method": "search_read",
                "args": [[["order_id", "=", order_id]]],
                "kwargs": {"fields": ["product_id"]}
            }
        }).encode()
        req = urllib.request.Request(
            f"{ERP_URL}/web/dataset/call_kw/sale.order.line/search_read",
            data=data,
            headers={"Content-Type": "application/json", "Cookie": f"session_id={session_id}"}
        )
        ctx = ssl.create_default_context()
        lines = json.loads(urllib.request.urlopen(req, context=ctx).read())["result"]
        product_ids = [l["product_id"][0] for l in lines if l.get("product_id")]
        if not product_ids:
            return ""

        # 2) stock.quant에서 재고 조회
        data = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "call",
            "params": {
                "model": "stock.quant", "method": "search_read",
                "args": [[["product_id", "in", product_ids], ["location_id.usage", "=", "internal"]]],
                "kwargs": {"fields": ["product_id", "quantity", "reserved_quantity"]}
            }
        }).encode()
        req = urllib.request.Request(
            f"{ERP_URL}/web/dataset/call_kw/stock.quant/search_read",
            data=data,
            headers={"Content-Type": "application/json", "Cookie": f"session_id={session_id}"}
        )
        stock = {}
        for q in json.loads(urllib.request.urlopen(req, context=ctx).read())["result"]:
            pid = q["product_id"][0]
            avail = q.get("quantity", 0) - q.get("reserved_quantity", 0)
            stock[pid] = stock.get(pid, 0) + avail

        parts = []
        for line in lines:
            if not line.get("product_id"):
                continue
            pid = line["product_id"][0]
            pname = line["product_id"][1]
            avail = int(stock.get(pid, 0))
            parts.append(f"{pname} 재고 {avail}개")
        return " / ".join(parts)
    except Exception as e:
        print(f"[STOCK] Error: {e}")
        return ""


def extract_order_number(origin):
    if not origin:
        return ""
    parts = origin.split("#")
    if len(parts) >= 2:
        return f"#{parts[-1].strip()}"
    return origin


def send_slack(order, session_id=None):
    origin = order.get("origin") or ""
    order_num = extract_order_number(origin)
    amount = order.get("amount_total", 0)
    customer = (order.get("partner_id") or [0, ""])[1]
    ch = order.get("channel_type") or ""
    ch_label = "Amazon" if ch == "amazon" else "TikTok Shop"
    message = f"신규 주문 발생!!!\n{order_num} - {amount}$\n{customer}\n{ch_label}"

    if session_id:
        stock_info = get_stock_info(session_id, order["id"])
        if stock_info:
            message += f"\n{stock_info}"

    payload = json.dumps({"text": message}).encode()
    req = urllib.request.Request(
        SLACK_WEBHOOK_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        ctx = ssl.create_default_context()
        urllib.request.urlopen(req, context=ctx, timeout=10)
        print(f"[SLACK] Sent: {order_num} - ${amount} - {customer} ({ch_label})")
        return True
    except Exception as e:
        print(f"[SLACK] Error: {e}")
        return False


def run():
    global seen
    print("=" * 50)
    print("  CGETC 신규 주문 Slack 알림")
    print(f"  폴링 간격: {POLL_INTERVAL}초")
    print("=" * 50)

    if not SLACK_WEBHOOK_URL:
        print("[ERROR] SLACK_WEBHOOK_URL 환경변수를 설정하세요!")
        sys.exit(1)
    if not ERP_PASSWORD:
        print("[ERROR] ERP_PASSWORD 환경변수를 설정하세요!")
        sys.exit(1)

    session_id = None
    first_run = True

    while True:
        try:
            if not session_id:
                session_id = erp_authenticate()
                if not session_id:
                    print("[ERROR] Auth failed, retrying in 30s...")
                    time.sleep(30)
                    continue

            orders = fetch_recent_orders(session_id)
            now = datetime.now().strftime("%H:%M:%S")

            if first_run:
                for o in orders:
                    seen.add(o["id"])
                print(f"[{now}] 초기화 완료: 기존 주문 {len(orders)}건 등록")
                first_run = False
            else:
                new_count = 0
                for o in orders:
                    if o["id"] not in seen:
                        seen.add(o["id"])
                        ch = o.get("channel_type") or ""
                        amount = o.get("amount_total", 0)
                        if ch in ALLOWED_CHANNELS and MIN_AMOUNT <= amount <= MAX_AMOUNT:
                            send_slack(o, session_id)
                            new_count += 1
                if new_count > 0:
                    print(f"[{now}] 신규 주문 {new_count}건 알림 완료")
                else:
                    print(f"[{now}] 신규 주문 없음 (총 {len(seen)}건 추적 중)")

        except Exception as e:
            err_msg = str(e)
            print(f"[ERROR] {err_msg}")
            if "session" in err_msg.lower() or "expired" in err_msg.lower() or "denied" in err_msg.lower():
                session_id = None

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run()
