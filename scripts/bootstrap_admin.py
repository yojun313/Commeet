"""One-off CLI to grant the first admin(s) - there's no bootstrap path
through the app itself (an admin can promote others once one exists, but
the very first one has to be set directly in the database).

Usage:
    uv run python scripts/bootstrap_admin.py someone@postech.ac.kr [more@postech.ac.kr ...]
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import users_col
from app.db.mongo import close
from app.services.auth_service import normalize_email


async def main(emails: list[str]) -> None:
    for raw_email in emails:
        email = normalize_email(raw_email)
        user = await users_col.find_one({"email": email})
        if not user:
            print(f"찾을 수 없음 (가입되지 않음): {email}")
            continue
        if user.get("isAdmin"):
            print(f"이미 관리자: {email}")
            continue
        await users_col.update_one({"_id": user["_id"]}, {"$set": {"isAdmin": True}})
        print(f"관리자로 지정됨: {email}")
    await close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: uv run python scripts/bootstrap_admin.py <이메일> [이메일2 ...]")
        sys.exit(1)
    asyncio.run(main(sys.argv[1:]))
