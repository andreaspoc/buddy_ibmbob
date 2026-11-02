"""Validated quiz definitions and server-only deterministic assessment grading.

Learner payloads are built from an explicit allowlist. Never serialize the stored
quiz definition directly to a participant: it includes reference answers.
"""
from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class QuizQuestion(StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]*$')
    type: Literal['single', 'multiple', 'dropdown', 'text']
    question: str = Field(min_length=1, max_length=2000)
    options: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(default_factory=list, max_length=20)
    answer: str | list[StrictInt] = Field(max_length=10000)
    points: StrictInt = Field(default=1, ge=1, le=100)
    rubric: str | None = Field(default=None, max_length=5000)
    explanation: str = Field(default='', max_length=5000)
    study_topic: str = Field(default='', max_length=200)
    reading: str = Field(default='', max_length=1000)

    @field_validator('question')
    @classmethod
    def meaningful_question(cls, value):
        if not value.strip():
            raise ValueError('Question text cannot be blank')
        return value.strip()

    @model_validator(mode='after')
    def validate_answer(self):
        if self.type == 'text':
            if self.options:
                raise ValueError('Written questions cannot contain choice options')
            if not isinstance(self.answer, str) or not self.answer.strip():
                raise ValueError('Written questions require a nonempty reference answer')
            if not self.rubric or not self.rubric.strip():
                raise ValueError('Written questions require a marking rubric')
        else:
            if not 2 <= len(self.options) <= 20:
                raise ValueError('Choice questions need 2–20 options')
            if any(not item.strip() for item in self.options):
                raise ValueError('Choice options cannot be blank')
            if len({item.strip() for item in self.options}) != len(self.options):
                raise ValueError('Choice options must be distinct')
            if not isinstance(self.answer, list) or not self.answer:
                raise ValueError('Choice questions require answer indices')
            if len(set(self.answer)) != len(self.answer):
                raise ValueError('Answer indices must be unique')
            if any(index < 0 or index >= len(self.options) for index in self.answer):
                raise ValueError('Answer index is outside the available options')
            if self.type in ('single', 'dropdown') and len(self.answer) != 1:
                raise ValueError('Single-choice questions require exactly one correct option')
        return self


class QuizTranslation(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    questions: list[QuizQuestion] = Field(min_length=1, max_length=50)
    approved: bool = False


class QuizInput(StrictModel):
    language: str = Field(default="en", min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=200)
    book_id: UUID | None = None
    lesson_id: UUID | None = None
    questions: list[QuizQuestion] = Field(min_length=1, max_length=50)
    translations: dict[str, QuizTranslation] | None = None
    approved_languages: list[str] | None = None

    @field_validator('title')
    @classmethod
    def meaningful_title(cls, value):
        if not value.strip():
            raise ValueError('Quiz title cannot be blank')
        return value.strip()

    @model_validator(mode='after')
    def unique_question_ids(self):
        if len({question.id for question in self.questions}) != len(self.questions):
            raise ValueError('Question IDs must be unique')
        return self


class Submission(StrictModel):
    answers: dict[str, str | list[StrictInt]] = Field(min_length=1, max_length=50)
    request_id: UUID
    version: StrictInt = Field(ge=1)

    @field_validator('answers')
    @classmethod
    def bounded_answers(cls, value):
        for answer in value.values():
            if isinstance(answer, str) and len(answer) > 10000:
                raise ValueError('Written answers must be at most 10,000 characters')
            if isinstance(answer, list) and len(answer) > 20:
                raise ValueError('Too many selected options')
        return value


class ManualGrade(StrictModel):
    score: float = Field(ge=0, allow_inf_nan=False)
    feedback: str = Field(default='', max_length=5000)

    @field_validator('score', mode='before')
    @classmethod
    def real_numeric_score(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError('Score must be a finite number')
        return value


class ManualGrades(StrictModel):
    grades: dict[str, ManualGrade] = Field(min_length=1, max_length=50)


def public_quiz(spec: QuizInput | dict) -> dict:
    """Return participant-safe content, independent of future private fields."""
    quiz = spec if isinstance(spec, QuizInput) else QuizInput.model_validate(spec)
    out = {
        'title': quiz.title,
        'language': quiz.language,
        'book_id': str(quiz.book_id) if quiz.book_id else None,
        'lesson_id': str(quiz.lesson_id) if getattr(quiz, 'lesson_id', None) else None,
        'questions': [
            {'id': question.id, 'type': question.type, 'question': question.question,
             'options': list(question.options), 'points': question.points}
            for question in quiz.questions
        ],
    }
    if quiz.translations:
        out['translations'] = {
            lang: {
                'title': tr.title,
                'approved': tr.approved,
                'questions': [
                    {'id': q.id, 'type': q.type, 'question': q.question,
                     'options': list(q.options), 'points': q.points}
                    for q in tr.questions
                ],
            }
            for lang, tr in quiz.translations.items()
        }
    if quiz.approved_languages:
        out['approved_languages'] = list(quiz.approved_languages)
    return out


def grade_submission(questions: list[QuizQuestion] | list[dict], answers: dict) -> dict:
    """Grade complete answers; written responses always require administrator review.

    Choice grading is exact-set with no partial or negative marks. A caller must
    authorize the quiz and persist the immutable published version separately.
    Solutions are released only through an owner-scoped result after submission.
    """
    items = [question if isinstance(question, QuizQuestion) else QuizQuestion.model_validate(question)
             for question in questions]
    if not 1 <= len(items) <= 50 or len({q.id for q in items}) != len(items):
        raise ValueError('Invalid quiz questions')
    if not isinstance(answers, dict) or set(answers) != {question.id for question in items}:
        raise ValueError('Answer every question exactly once; unknown question IDs are not accepted')
    grades = {}
    score = 0.0
    pending_manual = False
    for question in items:
        answer = answers[question.id]
        if question.type == 'text':
            if not isinstance(answer, str) or not answer.strip() or len(answer) > 10000:
                raise ValueError('Written answers must contain 1–10,000 characters')
            grades[question.id] = {'score': None, 'feedback': ''}
            pending_manual = True
            continue
        if not isinstance(answer, list) or not answer or any(type(index) is not int for index in answer):
            raise ValueError('Choose valid option indices for each choice question')
        if len(answer) > len(question.options) or len(set(answer)) != len(answer):
            raise ValueError('Selected option indices must be unique')
        if any(index < 0 or index >= len(question.options) for index in answer):
            raise ValueError('Selected option index is outside the available options')
        if question.type in ('single', 'dropdown') and len(answer) != 1:
            raise ValueError('Select exactly one option')
        awarded = float(question.points) if set(answer) == set(question.answer) else 0.0
        grades[question.id] = {'score': awarded, 'feedback': choice_feedback(question, answer), 'method': 'automatic'}
        score += awarded
    return {'score': score, 'max_score': float(sum(question.points for question in items)),
            'pending_manual': pending_manual, 'grades': grades}


def choice_feedback(question: QuizQuestion, answer: list[int]) -> str:
    """Explain exact-set marking using the published answer key, never invented facts."""
    expected = set(question.answer)
    selected = set(answer)
    parts = ['Correct.' if selected == expected else 'Incorrect.']
    if question.explanation.strip():
        parts.append(question.explanation.strip())
    else:
        parts.append('The correct answer is: ' + '; '.join(question.options[i] for i in question.answer) + '.')
    missed = expected - selected
    extra = selected - expected
    if missed:
        parts.append('Missing correct choices: ' + '; '.join(question.options[i] for i in sorted(missed)) + '.')
    if extra:
        parts.append('Incorrect choices selected: ' + '; '.join(question.options[i] for i in sorted(extra)) + '.')
    if question.type == 'multiple':
        parts.append('Full credit requires all correct choices and no incorrect choices.')
    return ' '.join(parts)


def result_details(row: dict) -> dict:
    """Enrich an authorized, immutable submission with consistent review feedback."""
    grades = {key: dict(value) for key, value in row['grades'].items()}
    for raw in row['questions']:
        question = QuizQuestion.model_validate(raw)
        mark = grades[question.id]
        if question.type != 'text' and not mark.get('feedback'):
            mark['feedback'] = choice_feedback(question, row['answers'][question.id])
        if question.type == 'text' and mark.get('score') is None:
            mark['feedback'] = 'Automatic grading is not available yet. Your answer is saved and awaits grading.'
        mark['outcome'] = ('pending' if mark.get('score') is None else
                           'correct' if mark['score'] == question.points else
                           'partial' if mark['score'] > 0 else 'incorrect')
    return {**row, 'grades': grades}


async def automatic_written_grades(row: dict, language='en', *, provider=None, budget=None) -> dict:
    """Validate automatic rubric marks before allowing any persistent grade change."""
    pending = [q for q in row['questions'] if q['type'] == 'text' and row['grades'][q['id']]['score'] is None]
    if not pending:
        return row['grades']
    if budget is None and row.get('username'):
        from app.agent_budget import RunBudget
        budget = RunBudget(row['username'])
    if provider is None:
        from .quiz_ai import suggest_grades
        provider = suggest_grades
    import json
    batches = []
    batch = []
    size = 0
    for question in pending:
        length = len(json.dumps({'question': question, 'submitted_answer': row['answers'][question['id']]}, ensure_ascii=False))
        if batch and size + length > 40000:
            batches.append(batch)
            batch, size = [], 0
        batch.append(question)
        size += length
    if batch:
        batches.append(batch)
    grades = {key: dict(mark) for key, mark in row['grades'].items()}
    for batch in batches:
        try:
            marks = await provider(batch, row['answers'], language, automatic=True, budget=budget)
        except TypeError:
            marks = await provider(batch, row['answers'], language, automatic=True)
        marks = ManualGrades.model_validate(marks.model_dump())
        if set(marks.grades) != {q['id'] for q in batch} or any(
                marks.grades[q['id']].score > q['points'] or not marks.grades[q['id']].feedback.strip() for q in batch):
            raise ValueError('Invalid automatic marks')
        grades.update({key: {**mark.model_dump(), 'method': 'ai'} for key, mark in marks.grades.items()})
    return grades



def recommended_chapters(row: dict, chapters: list[dict]) -> list[dict]:
    """Match missed concepts to real source chapter titles; never invent reading."""
    import re
    stop = {'which', 'what', 'when', 'where', 'this', 'that', 'with', 'from', 'your', 'answer', 'choose', 'select', 'explain', 'the', 'and', 'for', 'are', 'how', 'why', 'does'}
    def tokens(text):
        return {word for word in re.findall(r'[^\W_]+', text.casefold()) if len(word) > 2 and word not in stop}
    result = []
    for question in row['questions']:
        mark = row['grades'][question['id']]['score']
        if mark is None or mark >= question['points']:
            continue
        reference = (question.get('reading') or '').casefold()
        topic = tokens((question.get('study_topic') or '') + ' ' + question['question'])
        ranked = []
        for chapter in chapters:
            title = chapter['title'].strip()
            if not title:
                continue
            exact = bool(reference and (title.casefold() in reference or reference in title.casefold()))
            overlap = len(tokens(title) & topic)
            if exact or overlap:
                ranked.append((int(exact), overlap, chapter))
        if ranked:
            chapter = max(ranked, key=lambda item: item[:2])[2]
            result.append({'question_id': question['id'], 'chapter_id': chapter['id'], 'title': chapter['title'],
                           'reason': 'Revisit this source chapter to review: ' + (question.get('study_topic') or question['question'])})
    return result


def learner_display_name(user: dict) -> str:
    """Keep stable internal identity keys out of human-facing names."""
    import re
    for value in (user.get('display_name'), user.get('username')):
        if isinstance(value, str) and value.strip() and not re.fullmatch(r'kc-[a-f0-9]{40}', value.strip(), re.IGNORECASE):
            return value.strip()
    return 'Administrator' if user.get('is_admin') else 'Learner'
