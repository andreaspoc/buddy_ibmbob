"""Render only persisted certificate snapshots; never unescaped learner HTML."""
from app.branding import brand_text
from html import escape


def certificate_html(row):
    text = lambda value: escape(str(value or ''), quote=True)
    issued_at = row['issued_at']
    issued = issued_at.strftime('%d %B %Y') if hasattr(issued_at, 'strftime') else str(issued_at)
    revoked = bool(row.get('revoked_at'))
    status = '<div class="revoked">REVOKED — ' + text(row.get('revocation_reason')) + '</div>' if revoked else ''
    recipient_size = '16pt' if len(row['recipient_name']) > 100 else '20pt' if len(row['recipient_name']) > 60 else '26pt'
    course_size = '13pt' if len(row['course_title']) > 100 else '16pt' if len(row['course_title']) > 60 else '20pt'
    document = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{{ORGANIZATION_LABEL}} Course Certificate — ''' + text(row['course_title']) + '''</title>
<style>@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{margin:0;color:#1e1633;background:#f4effa;font-family:'Segoe UI',Arial,sans-serif}
main{height:186mm;background:linear-gradient(180deg,#ffffff 0%,#fcfaff 100%);border:4px solid #5a2d91;outline:2px solid #c5aee0;outline-offset:-12px;padding:12mm 18mm;text-align:center;position:relative;display:flex;flex-direction:column;justify-content:space-between}
.header-band{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #ece3f6;padding-bottom:4mm}
.brand{font-size:24pt;font-weight:800;letter-spacing:1.2px;color:#5a2d91;text-align:left}
.eyebrow{font-size:10pt;text-transform:uppercase;letter-spacing:3px;color:#6e5b87;font-weight:600}
.seal{display:inline-block;padding:2.5mm 5mm;border:1.5px solid #5a2d91;border-radius:999px;font-size:9pt;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#5a2d91;background:#f7f2fc}
h1{font-size:30pt;margin:4mm 0 2mm;font-weight:700;color:#24193d;letter-spacing:0.5px}
.subtitle{font-size:11pt;color:#5d5370;margin:0 0 2mm}
.recipient{font-size:26pt;line-height:1.15;font-weight:800;color:#5a2d91;margin:3mm auto;padding:2mm 8mm;border-bottom:2px solid #d7c6ec;display:inline-block;max-width:90%;overflow-wrap:anywhere}
.course-label{font-size:11pt;color:#5d5370;margin:2mm 0 1mm}
.course{font-size:20pt;line-height:1.25;font-weight:700;color:#1e1633;margin:2mm 0 4mm;overflow-wrap:anywhere}
p{font-size:11pt;line-height:1.4;margin:1.5mm 0}
.details{display:flex;justify-content:space-between;gap:12mm;text-align:left;border-top:1px solid #d7c6ec;padding-top:5mm;margin-top:4mm}
.details p{font-size:10pt;margin:0;color:#352b4d}
.details strong{color:#5a2d91;text-transform:uppercase;font-size:8.5pt;letter-spacing:1px}
.code{font-size:8.5pt;color:#655e70;margin-top:3mm;overflow-wrap:anywhere}
.revoked{border:3px solid #aa2233;background:#fff5f6;color:#aa2233;padding:3.5mm;font-weight:bold;font-size:13pt;margin:3mm 0}
@media screen{body{padding:24px}main{max-width:1120px;margin:auto;box-shadow:0 12px 36px rgba(45,20,80,0.12)}}
@media print{body{background:white;padding:0}main{height:186mm;box-shadow:none}}</style></head><body><main>
<div><div class="header-band"><div class="brand">{{ORGANIZATION_LABEL}}</div><div class="eyebrow">Learning &amp; Development</div><div class="seal">Verified Completion</div></div>
<h1>Certificate of Completion</h1>''' + status + '''
<p class="subtitle">This certifies that</p><div class="recipient">''' + text(row['recipient_name']) + '''</div>
<p class="course-label">has successfully completed the course requirements for</p>
<div class="course">''' + text(row['course_title']) + '''</div>
<p>Issued in recognition of completing the interactive lectures, assessments, and course curriculum.</p></div>
<div><div class="details"><p><strong>Course Lead / Approved by</strong><br>''' + text(row['instructor_name']) + '''</p><p><strong>Date issued</strong><br>''' + text(issued) + '''</p><p><strong>Certificate version</strong><br>Version ''' + text(row['version']) + '''</p></div>
<div class="code">Certificate ID: ''' + text(row['id']) + brand_text(''' &middot; Official {{ORGANIZATION_LABEL}} Learning Buddy course completion record.</div></div></main></body></html>''')
    return brand_text(document).replace('font-size:26pt;line-height:1.15', 'font-size:' + recipient_size + ';line-height:1.15').replace('font-size:20pt;line-height:1.25', 'font-size:' + course_size + ';line-height:1.25')
