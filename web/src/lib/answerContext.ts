import { marked } from 'marked';
import type { ChatMessage } from '../types';

export interface AnswerLink { href: string; label: string }
/** Only enumerate links actually present in Markdown. Never infer retrieval or confidence. */
export function answerLinks(content: string, origin: string): AnswerLink[] {
  const links = new Map<string, AnswerLink>();
  try {
    marked.walkTokens(marked.lexer(content), token => { // NOSONAR: synchronous callback, no promises produced
      if (token.type !== 'link') return;
      const href = token.href;
      try {
        const url = new URL(href, origin);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash === '#stream-pending') return;
        // Local file links need the session's file resolver. Keep those in the
        // existing answer renderer; do not create a different destination here.
        if (!/^https?:\/\//i.test(href) && !href.startsWith('/')) return;
        if (href.startsWith('#') || href.startsWith('//')) return;
        if (url.origin !== origin && !/^https?:\/\//i.test(href)) return;
        if (!links.has(url.href)) links.set(url.href, { href: url.href, label: token.text || url.hostname });
      } catch { /* Invalid destinations remain excluded. */ }
    });
  } catch { /* Older malformed Markdown can still show recorded request context. */ }
  return [...links.values()];
}

/** Never attach another turn's context when a request has been deleted. */
export function requestForAnswer(messages: ChatMessage[], index: number): ChatMessage | undefined {
  const answer = messages[index];
  return messages.slice(0, index).reverse().find(message => message.role === 'user' && (
    answer.historyTurnIndex !== undefined ? message.historyTurnIndex === answer.historyTurnIndex
      : answer.correlationId ? message.correlationId === answer.correlationId
      : true
  ));
}
