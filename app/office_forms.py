"""Validated field specifications shared by chat tools and the Office service."""
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator


class FormField(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z][A-Za-z0-9_]*$')
    label: str = Field(min_length=1, max_length=160)
    type: Literal['text', 'textarea', 'email', 'date', 'checkbox', 'dropdown'] = 'text'
    required: bool = False
    options: list[str] = Field(default_factory=list, max_length=40)

    @model_validator(mode='after')
    def choices(self):
        if self.type == 'dropdown':
            if not self.options or any(not v.strip() or len(v) > 120 for v in self.options) or len(set(self.options)) != len(self.options):
                raise ValueError('Dropdowns require unique nonempty options (maximum 120 characters each)')
        elif self.options:
            raise ValueError('Options are only supported for dropdown fields')
        return self


class FormSpec(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default='', max_length=2000)
    fields: list[FormField] = Field(min_length=1, max_length=80)
    folder_id: UUID | None = None

    @model_validator(mode='after')
    def unique_names(self):
        if len({f.name for f in self.fields}) != len(self.fields):
            raise ValueError('Field names must be unique')
        return self
