#!/usr/bin/env python3
"""
GA4 Data API → ga4_data.js 자동 갱신
GitHub Actions에서 15분마다 실행
"""
import json
import os
import sys
from datetime import datetime

def main():
    # 서비스 계정 키 (GitHub Secret → 환경변수 → 파일)
    sa_key = os.environ.get("GA4_SERVICE_ACCOUNT_KEY", "")
    if sa_key:
        import tempfile
        key_file = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        key_file.write(sa_key)
        key_file.close()
        key_path = key_file.name
    else:
        # 로컬 실행 시 파일 직접 사용
        key_path = os.path.join(os.path.dirname(__file__), "..", "google_cloud_api", "gen-lang-client-0657722366-53e8bc101002.json")
        if not os.path.exists(key_path):
            print("[GA4] No service account key found, skipping")
            return

    try:
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import (
            RunReportRequest, DateRange, Dimension, Metric
        )
        from google.oauth2 import service_account
    except ImportError:
        print("[GA4] Installing google-analytics-data...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "google-analytics-data", "-q"])
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import (
            RunReportRequest, DateRange, Dimension, Metric
        )
        from google.oauth2 import service_account

    PROPERTY_ID = "487396409"
    creds = service_account.Credentials.from_service_account_file(
        key_path, scopes=['https://www.googleapis.com/auth/analytics.readonly']
    )
    client = BetaAnalyticsDataClient(credentials=creds)
    DATE_RANGE = DateRange(start_date="2026-01-01", end_date="today")

    def run_report(dims, metrics, limit=1000):
        req = RunReportRequest(
            property=f"properties/{PROPERTY_ID}",
            date_ranges=[DATE_RANGE],
            dimensions=[Dimension(name=d) for d in dims],
            metrics=[Metric(name=m) for m in metrics],
            limit=limit,
        )
        return client.run_report(req)

    def parse_rows(resp, dim_names, met_names):
        rows = []
        for row in resp.rows:
            r = {}
            for i, d in enumerate(dim_names):
                r[d] = row.dimension_values[i].value
            for i, m in enumerate(met_names):
                v = row.metric_values[i].value
                r[m] = int(v) if '.' not in v else round(float(v), 4)
            rows.append(r)
        return rows

    print("[GA4] Fetching traffic_daily...")
    traffic = parse_rows(
        run_report(["date", "sessionDefaultChannelGroup"],
                   ["sessions", "totalUsers", "newUsers", "engagedSessions", "averageSessionDuration", "engagementRate"]),
        ["date", "channel"], ["sessions", "users", "new_users", "engaged_sessions", "avg_duration", "engagement_rate"]
    )
    print(f"  {len(traffic)} rows")

    print("[GA4] Fetching ecommerce_daily...")
    ecom = parse_rows(
        run_report(["date", "sessionDefaultChannelGroup", "sessionSourceMedium"],
                   ["ecommercePurchases", "purchaseRevenue", "addToCarts"]),
        ["date", "channel", "source_medium"], ["purchases", "revenue", "add_to_carts"]
    )
    print(f"  {len(ecom)} rows")

    print("[GA4] Fetching landing_pages_daily...")
    landing = parse_rows(
        run_report(["date", "landingPage"],
                   ["sessions", "engagedSessions", "engagementRate", "averageSessionDuration", "ecommercePurchases", "purchaseRevenue"]),
        ["date", "page"], ["sessions", "engaged_sessions", "engagement_rate", "avg_duration", "purchases", "revenue"]
    )
    print(f"  {len(landing)} rows")

    print("[GA4] Fetching devices...")
    devices = parse_rows(
        run_report(["date", "deviceCategory"], ["sessions", "totalUsers"]),
        ["date", "device"], ["sessions", "users"]
    )
    print(f"  {len(devices)} rows")

    print("[GA4] Fetching geo_daily...")
    geo = parse_rows(
        run_report(["date", "country", "region"],
                   ["sessions", "totalUsers", "ecommercePurchases", "purchaseRevenue"], limit=2000),
        ["date", "country", "region"], ["sessions", "users", "purchases", "revenue"]
    )
    print(f"  {len(geo)} rows")

    print("[GA4] Fetching pages_daily...")
    pages = parse_rows(
        run_report(["date", "pagePath"],
                   ["screenPageViews", "engagementRate", "averageSessionDuration"]),
        ["date", "path"], ["views", "engagement_rate", "avg_duration"]
    )
    print(f"  {len(pages)} rows")

    print("[GA4] Fetching new_vs_returning...")
    nvr = parse_rows(
        run_report(["date", "newVsReturning"], ["sessions", "totalUsers"]),
        ["date", "type"], ["sessions", "users"]
    )
    print(f"  {len(nvr)} rows")

    data = {
        "updated_at": datetime.now().isoformat(),
        "ga4_property": PROPERTY_ID,
        "traffic_daily": traffic,
        "ecommerce_daily": ecom,
        "landing_pages_daily": landing,
        "devices": devices,
        "geo_daily": geo,
        "new_vs_returning": nvr,
        "pages_daily": pages,
    }

    output_path = os.path.join(os.path.dirname(__file__), "..", "ga4_data.js")
    with open(output_path, "w") as f:
        f.write("var GA4_DATA = ")
        json.dump(data, f, ensure_ascii=False)
        f.write(";")

    total_rows = sum(len(v) for v in data.values() if isinstance(v, list))
    print(f"[GA4] Done! {total_rows} rows → ga4_data.js")

    # 임시 키 파일 삭제
    if sa_key:
        os.unlink(key_path)

if __name__ == "__main__":
    main()
