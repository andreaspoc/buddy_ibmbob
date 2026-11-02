type Lesson = { id: string; title: string; status: string; started?: boolean; completed?: boolean };
type Quiz = { id: string; title: string; status: string; submitted?: boolean; pending_manual?: boolean };

/** Next steps are derived only from the current learner's folder contents. */
export function LearningNextSteps({ lessons, quizzes, onLesson, onQuiz }: {
  lessons: Lesson[]; quizzes: Quiz[]; onLesson(id: string): void; onQuiz(id: string): void;
}) {
  const inProgress = lessons.filter(lesson => lesson.status === 'published' && lesson.started && !lesson.completed);
  const available = quizzes.filter(quiz => quiz.status === 'published' && !quiz.submitted);
  const pending = quizzes.filter(quiz => quiz.submitted && quiz.pending_manual);
  if (!inProgress.length && !available.length && !pending.length) return null;
  return <section className="learning-next-steps" aria-labelledby="learning-next-steps-title">
    <h2 id="learning-next-steps-title">Your next steps</h2>
    {inProgress.length > 0 && <div><h3>Continue learning</h3><ul>{inProgress.map(lesson =>
      <li key={lesson.id}><button type="button" onClick={() => onLesson(lesson.id)}>{lesson.title}</button></li>)}</ul></div>}
    {available.length > 0 && <div><h3>Quizzes to complete</h3><ul>{available.map(quiz =>
      <li key={quiz.id}><button type="button" onClick={() => onQuiz(quiz.id)}>{quiz.title}</button></li>)}</ul></div>}
    {pending.length > 0 && <div><h3>Awaiting grading</h3><ul>{pending.map(quiz =>
      <li key={quiz.id}><button type="button" onClick={() => onQuiz(quiz.id)}>{quiz.title}</button></li>)}</ul></div>}
  </section>;
}
