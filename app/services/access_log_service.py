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


def should_log(path: str) -> bool:
    return not path.startswith(_EXCLUDED_PREFIXES)


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


async def get_stats(days: int = 30) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)

    total_users = await users_col.count_documents({})
    total_admins = await users_col.count_documents({"isAdmin": True})
    total_events = await events_col.count_documents({"isDeleted": {"$ne": True}})
    total_requests_window = await access_logs_col.count_documents(
        {"ts": {"$gte": since}}
    )

    daily = await access_logs_col.aggregate(
        [
            {"$match": {"ts": {"$gte": since}}},
            {
                "$group": {
                    "_id": {
                        "$dateToString": {
                            "format": "%Y-%m-%d",
                            "date": "$ts",
                            "timezone": "UTC",
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
            {"$match": {"ts": {"$gte": since}}},
            {"$group": {"_id": "$path", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 10},
        ]
    ).to_list(length=None)

    return {
        "totalUsers": total_users,
        "totalAdmins": total_admins,
        "totalEvents": total_events,
        "requestsInWindow": total_requests_window,
        "windowDays": days,
        "dailyTraffic": daily_traffic,
        "topPaths": [{"path": p["_id"], "count": p["count"]} for p in top_paths],
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
