"""People plugin's durable away reply worker; shares the existing queue tables."""
import asyncio
import logging


async def main() -> None:
    from app.community_away import worker_loop
    await worker_loop()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
