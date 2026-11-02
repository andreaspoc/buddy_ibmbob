import { useState } from 'react';
import { LessonContent } from './LessonContent';
export type BoardCard = { id: string; title: string; body: string; color: 'violet' | 'blue' | 'green' | 'amber'; next_ids: string[] };
export type Board = { layout: 'cards' | 'path'; cards: BoardCard[] };
export const newBoardCard = (): BoardCard => ({ id: crypto.randomUUID(), title: 'New learning card', body: '', color: 'violet', next_ids: [] });
export function LessonBoard({ board }: { board: Board }) {
  const [open, setOpen] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const current = board.cards.find(card => card.id === path.at(-1)) || board.cards[0];
  if (!current) return null;
  if (board.layout === 'path') return <section className="lesson-path" aria-label="Decision board">
    <p className="lesson-board-instruction">Explore this scenario. Choose a path to see what happens next.</p>
    <article className={`lesson-board-card tone-${current.color}`}><h4>{current.title}</h4><LessonContent text={current.body} /></article>
    <div className="lesson-board-choices">{current.next_ids.map(id => board.cards.find(card => card.id === id)).filter((card): card is BoardCard => !!card).map(card => <button type="button" key={card.id} onClick={() => setPath(previous => [...previous.slice(-49), card.id])}>{card.title} →</button>)}</div>
    {!current.next_ids.length && <p role="status">End of this path. Try another route or continue the lesson.</p>}
    <div><button type="button" disabled={!path.length} onClick={() => setPath(previous => previous.slice(0,-1))}>Go back</button><button type="button" onClick={() => setPath([])}>Restart scenario</button></div>
  </section>;
  return <section aria-label="Interactive learning board"><p className="lesson-board-instruction">Choose a card to explore. Click it again to close it.</p>
    <div className="lesson-board-grid">{board.cards.map(card => <article className={`lesson-board-card tone-${card.color}`} key={card.id}>
      <button type="button" className="lesson-board-trigger" aria-expanded={open === card.id} onClick={() => setOpen(previous => previous === card.id ? null : card.id)}>{card.title}<span aria-hidden="true">{open === card.id ? '−' : '+'}</span></button>
      {open === card.id && <LessonContent text={card.body} />}
    </article>)}</div>
  </section>;
}
