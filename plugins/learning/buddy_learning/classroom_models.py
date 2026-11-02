"""Teacher-authored classroom schedules, assignments and feedback."""
from datetime import datetime
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ClassInput(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=5000)
    teacher_username: str | None = Field(default=None, min_length=1, max_length=200)
    parent_id: UUID | None = None

    @model_validator(mode='after')
    def meaningful(self):
        if not self.title.strip():
            raise ValueError('Enter a class title')
        if self.teacher_username is not None and not self.teacher_username.strip():
            raise ValueError('Select a course teacher')
        return self


class ClassAccessInput(Strict):
    usernames: list[str] = Field(default_factory=list, max_length=1000)
    app_groups: list[UUID] = Field(default_factory=list, max_length=200)
    groups: list[str] = Field(default_factory=list, max_length=200)
    teacher_username: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.usernames)) != len(self.usernames) or any(not name or len(name) > 200 for name in self.usernames):
            raise ValueError('Select distinct provisioned users')
        return self


class ClassUpdate(ClassInput):
    expected_revision: int = Field(ge=1)
    archived: bool = False


class Members(Strict):
    usernames: list[str] = Field(max_length=1000)

    @model_validator(mode='after')
    def unique(self):
        if len(set(self.usernames)) != len(self.usernames) or any(not name or len(name)>200 for name in self.usernames):
            raise ValueError('Select distinct provisioned users')
        return self


class Announcement(Strict):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=10000)

    @model_validator(mode='after')
    def meaningful(self):
        if not self.title.strip() or not self.body.strip():
            raise ValueError('Enter a title and announcement text')
        return self


class AnnouncementUpdate(Announcement):
    expected_revision: int = Field(ge=1)


class Session(Strict):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=10000)
    section: str = Field(default='', max_length=160)
    starts_at: datetime
    ends_at: datetime

    @model_validator(mode='after')
    def scheduled(self):
        if not self.title.strip():
            raise ValueError('Enter a session title')
        if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None or self.ends_at <= self.starts_at:
            raise ValueError('Provide timezone-aware times with the end after the start')
        return self


class SessionUpdate(Session):
    expected_revision: int = Field(ge=1)


class Assignment(Strict):
    title: str = Field(min_length=1, max_length=200)
    instructions: str = Field(min_length=1, max_length=20000)
    section: str = Field(default='', max_length=160)
    due_at: datetime | None = None
    allow_late: bool = True
    required: bool = True
    minimum_score_percent: float = Field(default=0, ge=0, le=100, allow_inf_nan=False)
    resource_type: Literal['none', 'book', 'lesson', 'quiz'] = 'none'
    resource_id: UUID | None = None

    @model_validator(mode='after')
    def valid(self):
        if not self.title.strip() or not self.instructions.strip():
            raise ValueError('Enter assignment title and instructions')
        if (self.resource_type == 'none') != (self.resource_id is None):
            raise ValueError('Select a resource for linked assignments; homework has no linked resource')
        if self.minimum_score_percent and self.resource_type != 'quiz':
            raise ValueError('A score threshold applies only to quiz assignments')
        if self.due_at and self.due_at.tzinfo is None:
            raise ValueError('Due dates must include a timezone')
        return self


class AssignmentUpdate(Assignment):
    expected_revision: int = Field(ge=1)


class Homework(Strict):
    text: str = Field(min_length=1, max_length=50000)
    expected_revision: int = Field(ge=1)

    @model_validator(mode='after')
    def meaningful(self):
        if not self.text.strip():
            raise ValueError('Enter your submission')
        return self


class Feedback(Strict):
    feedback: str = Field(min_length=1, max_length=10000)
    mark: float | None = Field(default=None, ge=0, le=100000, allow_inf_nan=False)
    max_mark: float | None = Field(default=None, gt=0, le=100000, allow_inf_nan=False)
    expected_revision: int = Field(ge=1)

    @model_validator(mode='after')
    def valid(self):
        if not self.feedback.strip():
            raise ValueError('Enter teacher feedback')
        if (self.mark is None) != (self.max_mark is None) or self.mark is not None and self.mark > self.max_mark:
            raise ValueError('Provide both mark and maximum, with mark no greater than maximum')
        return self
