"""Lightweight traffic/activity logging for the admin dashboard.

One document per non-static HTTP request (see the middleware in
`app.main`), with no bodies/headers captured - just enough to answer "who
did what, how often, how fast" without turning into a full request/response
audit log. A TTL index (see `app.db.create_indexes`) prunes anything older
than 60 days automatically, so this never grows without bound.
"""

from datetime import UTC, datetime, timedelta

from bson import ObjectId

from app.db import access_logs_col, events_col, users_col

# Requests under these prefixes are noise for a "who's using this and how"
# dashboard (asset bytes, not user activity) and would otherwise dominate
# the log volume many times over.
_EXCLUDED_PREFIXES = ("/static/",)

# 일정 화면이 몇 초마다 두드리는 버전 확인 요청(/api/events/{id}/version).
# 사용자가 한 행동이 아니라 화면이 켜져 있다는 사실일 뿐인데, 남겨 두면
# 로그의 대부분을 차지해 나머지를 덮어 버립니다.
_EXCLUDED_SUFFIXES = ("/version",)


def should_log(path: str) -> bool:
    if path.startswith(_EXCLUDED_PREFIXES):
        return False
    return not path.endswith(_EXCLUDED_SUFFIXES)


async def record_request(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    user_id: str | None,
    ip: str | None,
    user_agent: str | None,
) -> None:
    if status_code in (404, 405):
        return
    await access_logs_col.insert_one(
        {
            "ts": datetime.now(UTC),
            "method": method,
            "path": path,
            "statusCode": status_code,
            "durationMs": round(duration_ms, 1),
            "userId": ObjectId(user_id) if user_id else None,
            "ip": ip,
            "userAgent": (user_agent or "")[:200],
        }
    )


def _parse_user_agent(ua: str) -> tuple[str, str]:
    """User-Agent 문자열 -> (브라우저, 기기). 광고 수준의 정밀함은 필요 없고,
    "우리 사용자는 대체로 뭘로 들어오나"에 답할 만큼만 구분합니다.
    순서가 중요합니다 - Edge/삼성 UA에도 "Chrome"이, Chrome UA에도 "Safari"가
    들어 있어 구체적인 것부터 확인해야 합니다."""
    s = ua or ""
    low = s.lower()
    if not s:
        browser = "알 수 없음"
    elif any(t in low for t in ("bot", "spider", "crawler", "curl", "python", "wget", "httpclient")):
        browser = "봇/스크립트"
    elif "edg/" in low:
        browser = "Edge"
    elif "samsungbrowser" in low:
        browser = "삼성 브라우저"
    elif "whale" in low:
        browser = "웨일"
    elif "firefox/" in low:
        browser = "Firefox"
    elif "chrome/" in low or "crios/" in low:
        browser = "Chrome"
    elif "safari/" in low:
        browser = "Safari"
    else:
        browser = "기타"
    device = "모바일" if any(t in s for t in ("Mobile", "Android", "iPhone", "iPad")) else "데스크톱"
    return browser, device


# 하루/시간 경계는 한국 시간 기준입니다 - 사용자도 관리자도 한국에 있는데
# UTC로 자르면 "오늘"이 아침 9시에 시작하는 그래프가 됩니다.
_TZ = "Asia/Seoul"


async def get_stats(days: int = 30) -> dict:
    now = datetime.now(UTC)
    since = now - timedelta(days=days)
    week_ago = now - timedelta(days=7)
    in_window = {"ts": {"$gte": since}}

    total_users = await users_col.count_documents({})
    total_admins = await users_col.count_documents({"isAdmin": True})
    total_events = await events_col.count_documents({"isDeleted": {"$ne": True}})
    total_requests_window = await access_logs_col.count_documents(in_window)

    daily = await access_logs_col.aggregate(
        [
            {"$match": in_window},
            {
                "$group": {
                    "_id": {
                        "$dateToString": {
                            "format": "%Y-%m-%d",
                            "date": "$ts",
                            "timezone": _TZ,
                        }
                    },
                    "requests": {"$sum": 1},
                    "users": {"$addToSet": "$userId"},
                }
            },
            {"$sort": {"_id": 1}},
        ]
    ).to_list(length=None)
    daily_traffic = [
        {
            "date": d["_id"],
            "requests": d["requests"],
            "uniqueUsers": len([u for u in d["users"] if u]),
        }
        for d in daily
    ]

    top_paths = await access_logs_col.aggregate(
        [
            {"$match": in_window},
            {"$group": {"_id": "$path", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 10},
        ]
    ).to_list(length=None)

    # ---- 오늘/어제 (전일 대비 화살표용) --------------------------------
    today_local = daily_traffic[-1]["requests"] if daily_traffic else 0
    yesterday_local = daily_traffic[-2]["requests"] if len(daily_traffic) >= 2 else 0

    # ---- 상태코드 분포 + 최근 오류 -------------------------------------
    status_rows = await access_logs_col.aggregate(
        [
            {"$match": in_window},
            {
                "$group": {
                    "_id": {
                        "$concat": [
                            {"$toString": {"$floor": {"$divide": ["$statusCode", 100]}}},
                            "xx",
                        ]
                    },
                    "count": {"$sum": 1},
                }
            },
        ]
    ).to_list(length=None)
    status_groups = {r["_id"]: r["count"] for r in status_rows}

    recent_errors = (
        await access_logs_col.find(
            {**in_window, "statusCode": {"$gte": 400}},
            {"ts": 1, "method": 1, "path": 1, "statusCode": 1, "userId": 1},
        )
        .sort("ts", -1)
        .limit(8)
        .to_list(length=None)
    )

    # ---- 응답 시간 (평균/p95) + 느린 엔드포인트 -------------------------
    perf_rows = await access_logs_col.aggregate(
        [
            {"$match": in_window},
            {
                "$group": {
                    "_id": None,
                    "avg": {"$avg": "$durationMs"},
                    "p95": {
                        "$percentile": {
                            "input": "$durationMs", "p": [0.95], "method": "approximate",
                        }
                    },
                }
            },
        ]
    ).to_list(length=None)
    perf = perf_rows[0] if perf_rows else {"avg": 0, "p95": [0]}

    slowest = await access_logs_col.aggregate(
        [
            # 느린 "엔드포인트"를 찾는 것이므로 오류 응답은 뺍니다 - 타임아웃
            # 직전까지 버틴 502가 섞이면 평균이 진단 불가능해집니다.
            {"$match": {**in_window, "statusCode": {"$lt": 400}}},
            {
                "$group": {
                    "_id": {"method": "$method", "path": "$path"},
                    "avgMs": {"$avg": "$durationMs"},
                    "count": {"$sum": 1},
                }
            },
            # 한두 번 호출된 경로의 평균은 노이즈입니다.
            {"$match": {"count": {"$gte": 5}}},
            {"$sort": {"avgMs": -1}},
            {"$limit": 6},
        ]
    ).to_list(length=None)

    # ---- 시간대별 (0~23시, KST) ----------------------------------------
    hourly_rows = await access_logs_col.aggregate(
        [
            {"$match": in_window},
            {
                "$group": {
                    "_id": {"$hour": {"date": "$ts", "timezone": _TZ}},
                    "count": {"$sum": 1},
                }
            },
        ]
    ).to_list(length=None)
    hourly = [0] * 24
    for r in hourly_rows:
        hourly[r["_id"]] = r["count"]

    # ---- 순사용자 / 활동 상위 사용자 -----------------------------------
    unique_users = len(await access_logs_col.distinct("userId", {**in_window, "userId": {"$ne": None}}))
    unique_ips = len(await access_logs_col.distinct("ip", {**in_window, "ip": {"$ne": None}}))

    top_user_rows = await access_logs_col.aggregate(
        [
            {"$match": {**in_window, "userId": {"$ne": None}}},
            {"$group": {"_id": "$userId", "count": {"$sum": 1}, "last": {"$max": "$ts"}}},
            {"$sort": {"count": -1}},
            {"$limit": 8},
        ]
    ).to_list(length=None)
    top_user_docs = await users_col.find(
        {"_id": {"$in": [r["_id"] for r in top_user_rows]}}, {"email": 1, "name": 1}
    ).to_list(length=None)
    by_id = {u["_id"]: u for u in top_user_docs}
    top_users = [
        {
            "name": by_id.get(r["_id"], {}).get("name") or "(탈퇴/미상)",
            "email": by_id.get(r["_id"], {}).get("email") or "",
            "count": r["count"],
            "lastSeen": r["last"],
        }
        for r in top_user_rows
    ]

    # ---- 브라우저 / 기기 ------------------------------------------------
    # UA 원문이 아니라 (같은 UA는 한 그룹으로) 묶어 받아 파이썬에서 분류합니다
    # - 고유 UA는 기껏 수백 개라, 문서 전부를 가져오는 것보다 훨씬 쌉니다.
    ua_rows = await access_logs_col.aggregate(
        [
            {"$match": in_window},
            {"$group": {"_id": "$userAgent", "count": {"$sum": 1}}},
        ]
    ).to_list(length=None)
    browsers: dict[str, int] = {}
    devices: dict[str, int] = {}
    for r in ua_rows:
        b, d = _parse_user_agent(r["_id"] or "")
        browsers[b] = browsers.get(b, 0) + r["count"]
        devices[d] = devices.get(d, 0) + r["count"]

    # ---- 신규 가입 / 신규 일정 ------------------------------------------
    async def _daily_created(col, extra_match=None):
        match = {"createdAt": {"$gte": since}}
        if extra_match:
            match.update(extra_match)
        rows = await col.aggregate(
            [
                {"$match": match},
                {
                    "$group": {
                        "_id": {
                            "$dateToString": {
                                "format": "%Y-%m-%d", "date": "$createdAt", "timezone": _TZ,
                            }
                        },
                        "count": {"$sum": 1},
                    }
                },
                {"$sort": {"_id": 1}},
            ]
        ).to_list(length=None)
        return [{"date": r["_id"], "count": r["count"]} for r in rows]

    new_users_daily = await _daily_created(users_col)
    new_events_daily = await _daily_created(events_col)
    new_users_7d = await users_col.count_documents({"createdAt": {"$gte": week_ago}})
    new_events_7d = await events_col.count_documents({"createdAt": {"$gte": week_ago}})
    closed_events = await events_col.count_documents(
        {"isDeleted": {"$ne": True}, "isClosed": True}
    )

    return {
        "totalUsers": total_users,
        "totalAdmins": total_admins,
        "totalEvents": total_events,
        "closedEvents": closed_events,
        "requestsInWindow": total_requests_window,
        "windowDays": days,
        "dailyTraffic": daily_traffic,
        "topPaths": [{"path": p["_id"], "count": p["count"]} for p in top_paths],
        "requestsToday": today_local,
        "requestsYesterday": yesterday_local,
        "statusGroups": status_groups,
        "recentErrors": [
            {
                "ts": e["ts"], "method": e["method"], "path": e["path"],
                "statusCode": e["statusCode"],
            }
            for e in recent_errors
        ],
        "perf": {
            "avgMs": round(perf.get("avg") or 0, 1),
            "p95Ms": round((perf.get("p95") or [0])[0], 1),
            "slowest": [
                {
                    "method": r["_id"]["method"], "path": r["_id"]["path"],
                    "avgMs": round(r["avgMs"], 1), "count": r["count"],
                }
                for r in slowest
            ],
        },
        "hourly": hourly,
        "uniques": {"users": unique_users, "ips": unique_ips},
        "topUsers": top_users,
        "browsers": sorted(
            [{"name": k, "count": v} for k, v in browsers.items()],
            key=lambda x: -x["count"],
        ),
        "devices": sorted(
            [{"name": k, "count": v} for k, v in devices.items()],
            key=lambda x: -x["count"],
        ),
        "growth": {
            "newUsersDaily": new_users_daily,
            "newEventsDaily": new_events_daily,
            "newUsers7d": new_users_7d,
            "newEvents7d": new_events_7d,
        },
    }


async def list_logs(
    *, page: int = 1, page_size: int = 50, user_id: str | None = None
) -> dict:
    query: dict = {}
    if user_id:
        oid = ObjectId(user_id) if ObjectId.is_valid(user_id) else None
        query["userId"] = oid

    total = await access_logs_col.count_documents(query)
    skip = max(0, (page - 1) * page_size)
    rows = (
        await access_logs_col.find(query)
        .sort("ts", -1)
        .skip(skip)
        .limit(page_size)
        .to_list(length=None)
    )

    user_ids = {r["userId"] for r in rows if r.get("userId")}
    users = (
        await users_col.find(
            {"_id": {"$in": list(user_ids)}}, {"email": 1, "name": 1}
        ).to_list(length=None)
        if user_ids
        else []
    )
    by_id = {u["_id"]: u for u in users}

    items = []
    for r in rows:
        user = by_id.get(r.get("userId"))
        items.append(
            {
                "ts": r["ts"],
                "method": r["method"],
                "path": r["path"],
                "statusCode": r["statusCode"],
                "durationMs": r["durationMs"],
                "ip": r.get("ip"),
                "userEmail": user.get("email") if user else None,
                "userName": user.get("name") if user else None,
            }
        )

    return {"items": items, "total": total, "page": page, "pageSize": page_size}
