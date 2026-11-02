"""Validated human-authored lesson content; no runtime service dependencies."""
from app.branding import brand_text
import re
from typing import Literal
from urllib.parse import urlsplit, parse_qs
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .assistant_name import ASSISTANT_NAME_PATTERN


def video_embed(value):
    """Normalize only supported providers; no server-side URL fetching."""
    parts = urlsplit(value)
    if parts.scheme != 'https' or parts.username or parts.password or parts.port not in (None, 443):
        raise ValueError('Use an HTTPS YouTube or Vimeo video link')
    host = parts.hostname
    video = None
    if host == 'youtu.be':
        video = parts.path.strip('/')
    elif host in {'youtube.com', 'www.youtube.com', 'www.youtube-nocookie.com'}:
        if parts.path == '/watch':
            video = parse_qs(parts.query).get('v', [''])[0]
        elif parts.path.startswith(('/embed/', '/shorts/')):
            video = parts.path.split('/')[2]
    if video is not None and re.fullmatch(r'[A-Za-z0-9_-]{11}', video):
        return f'https://www.youtube-nocookie.com/embed/{video}'
    if host in {'vimeo.com', 'www.vimeo.com', 'player.vimeo.com'}:
        video = parts.path.rsplit('/', 1)[-1]
        if re.fullmatch(r'[0-9]{1,15}', video):
            return f'https://player.vimeo.com/video/{video}'
    raise ValueError('Use a YouTube or Vimeo video link')


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class BoardCard(Strict):
    id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,64}$')
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=5000)
    color: Literal['violet', 'blue', 'green', 'amber'] = 'violet'
    next_ids: list[str] = Field(default_factory=list, max_length=4)

    @model_validator(mode='after')
    def meaningful(self):
        if not self.title.strip() or not self.body.strip():
            raise ValueError('Cards need a title and learning content')
        return self


class Board(Strict):
    layout: Literal['cards', 'path'] = 'cards'
    cards: list[BoardCard] = Field(min_length=2, max_length=12)

    @model_validator(mode='after')
    def valid_graph(self):
        ids = {card.id for card in self.cards}
        if len(ids) != len(self.cards):
            raise ValueError('Board card identifiers must be unique')
        for card in self.cards:
            if len(set(card.next_ids)) != len(card.next_ids) or card.id in card.next_ids or any(target not in ids for target in card.next_ids):
                raise ValueError('Board paths must point to distinct other cards on this board')
            if self.layout == 'cards' and card.next_ids:
                raise ValueError('Switch to a decision path to connect cards')
        if self.layout == 'path':
            reached = set()
            pending = [self.cards[0].id]
            while pending:
                node = pending.pop()
                if node not in reached:
                    reached.add(node)
                    pending.extend(next(c.next_ids for c in self.cards if c.id == node))
            if reached != ids or not any(not card.next_ids for card in self.cards):
                raise ValueError('Connect every decision card from the first card and include an ending')
        return self


class Step(Strict):
    id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,64}$')
    kind: Literal['text', 'reveal', 'question', 'video', 'image', 'board'] = 'text'
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(default='', max_length=20000)
    url: str = Field(default='', max_length=2048)
    asset_id: UUID | None = None
    options: list[str] = Field(default_factory=list, max_length=8)
    answer: int | None = Field(default=None, ge=0, strict=True)
    feedback: str = Field(default='', max_length=5000)
    teacher_notes: str = Field(default='', max_length=10000)
    board: Board | None = None

    @model_validator(mode='after')
    def valid(self):
        if not self.title.strip():
            raise ValueError('Enter a section title')
        if (self.kind == 'board') != (self.board is not None):
            raise ValueError('Board sections require a board; other sections must not include one')
        if self.kind == 'question':
            if len(self.options) < 2 or any(not v.strip() or len(v) > 1000 for v in self.options) or len(set(v.strip() for v in self.options)) != len(self.options):
                raise ValueError('Questions need 2–8 distinct, non-empty choices')
            if self.answer is None or self.answer >= len(self.options):
                raise ValueError('Select a correct answer')
        if self.kind == 'video':
            if bool(self.url) == bool(self.asset_id):
                raise ValueError('Choose one uploaded video or external video link')
            if self.url:
                self.url = video_embed(self.url)
        elif self.url:
            raise ValueError('External links are supported only for videos')
        if self.kind == 'image' and not self.asset_id:
            raise ValueError('Upload an image')
        if self.asset_id and self.kind not in {'image', 'video'}:
            raise ValueError('Only image and video sections accept media')
        return self


class LessonTranslation(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=2000)
    steps: list[Step] = Field(min_length=1, max_length=100)
    approved: bool = False


class LessonInput(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=2000)
    steps: list[Step] = Field(min_length=1, max_length=100)
    language: str | None = Field(default=None, min_length=1, max_length=80)
    translations: dict[str, LessonTranslation] | None = None
    approved_languages: list[str] | None = None

    @model_validator(mode='after')
    def valid(self):
        if not self.title.strip() or len({s.id for s in self.steps}) != len(self.steps):
            raise ValueError('Enter a title and use unique section identifiers')
        if len(self.model_dump_json().encode('utf-8')) > 800000:
            raise ValueError('Lesson content is too large; split it into smaller lessons')
        return self


class LessonEditInput(LessonInput):
    expected_digest: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


class LessonPublishInput(Strict):
    expected_digest: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


class Progress(Strict):
    version: int = Field(ge=1)
    step: int = Field(ge=0)
    completed: bool = False


class Check(Strict):
    version: int = Field(ge=1)
    step_id: str = Field(max_length=64)
    answer: int = Field(ge=0, strict=True)



class BuddyDraftRequest(Strict):
    message: str = Field(min_length=1, max_length=6000)
    language: str = Field(default='en', min_length=1, max_length=80)
    current: LessonInput | None = None
    assistant_name: str | None = Field(default=None, pattern=ASSISTANT_NAME_PATTERN)

    @model_validator(mode='after')
    def meaningful(self):
        if not self.message.strip() or not self.language.strip():
            raise ValueError(brand_text('Describe what Buddy should help you create and choose a language'))
        return self
