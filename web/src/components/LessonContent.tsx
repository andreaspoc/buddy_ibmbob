import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Rich lesson content stays inside an inert, semantic HTML allowlist. */
export function LessonContent({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }), {
    ALLOWED_TAGS: ['p','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','ul','ol','li','blockquote','pre','code','table','thead','tbody','tr','th','td','a','hr','br','details','summary','div','span','mark','kbd','sup','sub'],
    ALLOWED_ATTR: ['href','title'], ALLOW_DATA_ATTR: false,
  }), [text]);
  return <div className="lesson-rich-content" dangerouslySetInnerHTML={{ __html: html }} />;
}
