"""The single place in the codebase that opens a MongoDB connection.

Every other module reaches MongoDB through the collection handles exported
by ``app.db`` (see ``app/db/__init__.py``), never by importing this module
directly or creating another client.
"""

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from app.config import DB_NAME, MONGO_URI

client: AsyncIOMotorClient = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
db: AsyncIOMotorDatabase = client[DB_NAME]


async def ping() -> None:
    await client.admin.command("ping")


async def close() -> None:
    client.close()
