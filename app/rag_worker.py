"""Durable document indexing independent of chat execution."""
import asyncio
import logging

import httpx

from app import rag, conversation_documents

logger = logging.getLogger(__name__)


async def process(document: dict) -> None:
    task = asyncio.create_task(rag.index_document(document))
    try:
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=20)
            if not done and not await asyncio.to_thread(rag.renew, document):
                # Cancelling to_thread cannot stop Docling's synchronous work.
                # Let conversion finish before reusing the converter; save_index
                # checks the lease token and discards deleted or superseded work.
                await task
                return
        await task
    except asyncio.CancelledError:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise
    except Exception as exc:
        logger.exception("Knowledge indexing failed for %s", document["id"])
        message = ("Cannot reach local Ollama. Check BOB_OLLAMA_URL and retry." if isinstance(exc, httpx.TransportError)
                   else "Ollama rejected embedding input; check the installed model and retry." if isinstance(exc, httpx.HTTPStatusError)
                   else str(exc) if isinstance(exc, (ValueError, UnicodeError))
                   else "Could not extract or index this document. Check the file and retry.")
        await asyncio.to_thread(rag.fail_index, document, message)


async def main() -> None:
    await asyncio.to_thread(rag.ensure_schema)
    await asyncio.to_thread(conversation_documents.ensure_schema)
    logger.info("Document worker ready for shared knowledge and private conversation attachments")
    while True:
        try:
            attachment = await asyncio.to_thread(conversation_documents.claim)
            if attachment:
                await conversation_documents.process(attachment)
            document = await asyncio.to_thread(rag.claim)
            if document:
                await process(document)
            elif not attachment:
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Knowledge worker failed")
            await asyncio.sleep(5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
