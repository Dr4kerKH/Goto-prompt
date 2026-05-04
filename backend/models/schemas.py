from typing import Literal

from pydantic import BaseModel, Field, field_validator

TaskType = Literal["coding", "design_with_code", "format_rewrite", "image_generation"]


class PromptGenerationRequest(BaseModel):
    """Single canonical prompt + current delta (+ optional prior user lines)."""

    user_message: str = Field(..., min_length=1)
    canonical_prompt: str | None = None
    recent_deltas: list[str] | None = Field(default=None, max_length=6)
    task_type: TaskType | None = None

    @field_validator("user_message")
    @classmethod
    def strip_user_message(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("user_message must not be blank")
        return v.strip()

    @field_validator("canonical_prompt")
    @classmethod
    def strip_canonical(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip()
        return s or None

    @field_validator("recent_deltas")
    @classmethod
    def normalize_deltas(cls, v: list[str] | None) -> list[str] | None:
        if not v:
            return None
        out: list[str] = []
        for item in v:
            s = (item or "").strip()
            if s:
                out.append(s)
        return out or None

    @field_validator("task_type")
    @classmethod
    def normalize_task_type(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip().lower() or None


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    ollama_available: bool
    model: str
