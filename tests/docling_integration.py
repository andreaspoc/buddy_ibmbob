"""Run in knowledge-worker; checks real Docling extraction and Ollama vectors."""
import asyncio
import io

from docx import Document
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from app import rag


def text_pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 16 Tf 50 740 Td (Project Juniper) Tj 0 -35 Td (Emergency access code: ORCHID-742.) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def word_table():
    doc = Document()
    doc.add_heading("Service desk hours", level=1)
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Day"
    table.cell(0, 1).text = "Opening time"
    table.cell(1, 0).text = "Monday"
    table.cell(1, 1).text = "09:15"
    output = io.BytesIO()
    doc.save(output)
    return output.getvalue()


def scanned_pdf():
    image = Image.new("RGB", (1200, 1600), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
    draw.text((90, 100), "Service desk opens at 09:15 on Monday.", fill="black", font=font)
    output = io.BytesIO()
    image.save(output, "PDF", resolution=150)
    return output.getvalue()


async def main():
    for filename, content, expected in [
        ("juniper.pdf", text_pdf(), "ORCHID-742"),
        ("hours.docx", word_table(), "09:15"),
        ("scanned.pdf", scanned_pdf(), "09:15"),
    ]:
        print(f"Preparing {filename} with Docling…", flush=True)
        sections = await asyncio.to_thread(rag.extract, filename, content)
        prepared = "\n".join(text for _, text in sections)
        assert expected in prepared, prepared
        if filename.endswith(".pdf"):
            assert sections[0][0] == "page 1", sections
        else:
            assert "Monday" in prepared and "Opening time" in prepared and "|" in prepared, prepared
        import httpx
        async with httpx.AsyncClient(timeout=60) as client:
            embedded = await rag.embed_passage(client, rag.chunk_sections(sections)[0])
        assert embedded and len(embedded[0]["embedding"]) == 768
        print(f"Verified {filename}: prepared text and 768-dimensional embeddings", flush=True)
    print("Docling integration passed: PDF, DOCX tables and scanned PDF OCR", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
