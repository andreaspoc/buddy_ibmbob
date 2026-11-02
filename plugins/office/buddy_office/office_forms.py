"""Build genuine PDF AcroForm widgets without executing model-supplied code."""
from app.branding import brand_text
import io
import textwrap
from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject,
                           FloatObject, NameObject, NumberObject, TextStringObject)
from app.office_forms import FormSpec


def render_form(spec: FormSpec) -> bytes:
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica'),
        NameObject('/Encoding'): NameObject('/WinAnsiEncoding')}))
    resources = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/Helv'): font})})
    fields = ArrayObject()
    form = DictionaryObject({NameObject('/Fields'): fields, NameObject('/DR'): resources,
        NameObject('/DA'): TextStringObject('/Helv 11 Tf 0 g'), NameObject('/NeedAppearances'): BooleanObject(True)})
    writer._root_object[NameObject('/AcroForm')] = writer._add_object(form)
    page, commands, y = None, [], 0

    def literal(text):
        # PDF standard-font text uses Windows ANSI; unsupported glyphs are explicit errors.
        return '<' + text.encode('cp1252').hex() + '>'

    def text(value, x, baseline, size=11):
        commands.append(f'BT /Helv {size} Tf 0 g {x} {baseline} Td {literal(value)} Tj ET')

    def finish():
        if page is not None:
            stream = DecodedStreamObject()
            stream.set_data('\n'.join(commands).encode('ascii'))
            page[NameObject('/Contents')] = writer._add_object(stream)

    def new_page():
        nonlocal page, commands, y
        finish()
        page = writer.add_blank_page(width=595.28, height=841.89)
        page[NameObject('/Resources')] = resources
        page[NameObject('/Annots')] = ArrayObject()
        commands = []
        y = 796
        for line in textwrap.wrap(spec.title, 54):
            text(line, 44, y, 17)
            y -= 23
        y -= 14

    new_page()
    for line in textwrap.wrap(spec.description, 90):
        if y < 85:
            new_page()
        text(line, 44, y)
        y -= 16
    if spec.description:
        y -= 14
    for field in spec.fields:
        height = 72 if field.type == 'textarea' else 25
        label = field.label + (' *' if field.required else '')
        lines = textwrap.wrap(label, 85)
        needed = height + len(lines) * 16 + 20
        if y - needed < 44:
            new_page()
        for line in lines:
            text(line, 44, y)
            y -= 16
        top, bottom = y - 2, y - 2 - height
        right = 62 if field.type == 'checkbox' else 551
        if field.type == 'checkbox':
            bottom = top - 18
        widget = DictionaryObject({NameObject('/Type'): NameObject('/Annot'),
            NameObject('/Subtype'): NameObject('/Widget'), NameObject('/T'): TextStringObject(field.name),
            NameObject('/TU'): TextStringObject(field.label), NameObject('/P'): page.indirect_reference,
            NameObject('/Rect'): ArrayObject([FloatObject(v) for v in (44, bottom, right, top)]),
            NameObject('/F'): NumberObject(4), NameObject('/Ff'): NumberObject(2 if field.required else 0),
            NameObject('/DA'): TextStringObject('/Helv 11 Tf 0 g'),
            NameObject('/MK'): DictionaryObject({NameObject('/BC'): ArrayObject([NumberObject(0)]),
                NameObject('/BG'): ArrayObject([NumberObject(1)])}),
            NameObject('/BS'): DictionaryObject({NameObject('/W'): NumberObject(1), NameObject('/S'): NameObject('/S')})})
        if field.type == 'checkbox':
            widget[NameObject('/FT')] = NameObject('/Btn')
            widget[NameObject('/V')] = NameObject('/Off')
            widget[NameObject('/AS')] = NameObject('/Off')
            states = DictionaryObject()
            for state, drawing in [('Off', ''), ('Yes', '2 w 3 9 m 7 4 l 15 15 l S')]:
                stream = DecodedStreamObject()
                stream.set_data(('1 g 0 0 18 18 re f 0 G 0.8 w 0.5 0.5 17 17 re S ' + drawing).encode())
                stream.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                    NameObject('/BBox'): ArrayObject([NumberObject(v) for v in (0, 0, 18, 18)])})
                states[NameObject('/' + state)] = writer._add_object(stream)
            widget[NameObject('/AP')] = DictionaryObject({NameObject('/N'): states})
        elif field.type == 'dropdown':
            widget[NameObject('/FT')] = NameObject('/Ch')
            widget[NameObject('/Ff')] = NumberObject((2 if field.required else 0) | (1 << 17))
            widget[NameObject('/Opt')] = ArrayObject([TextStringObject('')] + [TextStringObject(v) for v in field.options])
            widget[NameObject('/V')] = TextStringObject('')
        else:
            widget[NameObject('/FT')] = NameObject('/Tx')
            widget[NameObject('/V')] = TextStringObject('')
            if field.type == 'textarea':
                widget[NameObject('/Ff')] = NumberObject((2 if field.required else 0) | (1 << 12))
            # Email/date remain portable text fields, with explicit format guidance.
            if field.type in ('email', 'date'):
                text('Email address' if field.type == 'email' else 'Date (YYYY-MM-DD)', 50, bottom + 8, 9)
        ref = writer._add_object(widget)
        page['/Annots'].append(ref)
        fields.append(ref)
        if field.type != 'checkbox':
            commands.append(f'0.65 G 0.7 w 44 {bottom} {right - 44} {top - bottom} re S')
        y = bottom - 24
    finish()
    empty_values = {field.name: '' for field in spec.fields if field.type != 'checkbox'}
    for form_page in writer.pages:
        writer.update_page_form_field_values(form_page, empty_values, auto_regenerate=False)
    writer.add_metadata({'/Title': spec.title, '/Creator': brand_text('Buddy Office')})
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()
