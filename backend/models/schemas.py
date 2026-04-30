from typing import Literal

from pydantic import BaseModel, field_validator

FocusType = Literal["security", "performance", "best_practices", "custom", "none"]


class PromptGenerationRequest(BaseModel):
    user_message: str
    focus: FocusType = "none"
    custom_focus: str | None = None
    conversation_context: str | None = None

    @field_validator("user_message")
    @classmethod
    def must_not_be_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("user_message must not be blank")
        return v.strip()


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    ollama_available: bool
    model: str
