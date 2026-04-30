import asyncio
import logging
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import HealthResponse, PromptGenerationRequest
from services.llm_service import OllamaService
from utils.errors import LLMStreamError, OllamaUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")
llm_service = OllamaService()

MAX_RETRIES = 2


_FOCUS_MAP: dict[str, str] = {
    "security": (
        "Prioritize security hardening, OWASP top 10, authentication, authorization, "
        "data protection, input validation, and vulnerability prevention."
    ),
    "performance": (
        "Prioritize performance optimization, efficiency, caching strategies, "
        "resource management, and measurable speed improvements."
    ),
    "best_practices": (
        "Prioritize clean code, maintainability, consistent architecture, "
        "design patterns, and long-term readability."
    ),
}


def _build_system_prompt(request: PromptGenerationRequest) -> str:
    if request.focus == "custom" and request.custom_focus:
        focus_clause = f"Key focus: {request.custom_focus.strip()}"
    elif request.focus in _FOCUS_MAP:
        focus_clause = f"Key focus: {_FOCUS_MAP[request.focus]}"
    else:
        focus_clause = ""

    if request.conversation_context:
        task_block = (
            f"Previous generated prompt (refine this):\n{request.conversation_context}"
            f"\n\nRefinement request: {request.user_message}"
        )
    else:
        task_block = f"Task: {request.user_message}"

    parts = [
        "You are an expert prompt engineer. Create a comprehensive, production-ready system prompt.",
        "",
        task_block,
    ]
    if focus_clause:
        parts.append(focus_clause)
    parts += [
        "",
        "Output ONLY the system prompt itself — no preamble, no explanation, no markdown fences.",
        "Begin directly with the system prompt content.",
    ]
    return "\n".join(parts)


async def _stream_with_retry(prompt: str) -> AsyncGenerator[str, None]:
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            async for token in llm_service.generate_stream(prompt):
                yield token
            return
        except OllamaUnavailableError:
            raise
        except LLMStreamError as exc:
            last_exc = exc
            if attempt < MAX_RETRIES:
                wait = 2 ** attempt
                logger.warning(
                    "Stream attempt %d/%d failed (%s), retrying in %ds",
                    attempt + 1, MAX_RETRIES + 1, exc, wait,
                )
                await asyncio.sleep(wait)
            else:
                logger.error("All %d stream attempts exhausted: %s", MAX_RETRIES + 1, exc)
    raise last_exc  # type: ignore[misc]


@router.post("/generate-prompt")
async def generate_prompt(request: PromptGenerationRequest) -> StreamingResponse:
    logger.info("generate-prompt request received")

    if not await llm_service.check_availability():
        raise HTTPException(
            status_code=503,
            detail=f"LLM service unavailable at {llm_service.base_url}. Ensure Ollama is running.",
        )

    system_prompt = _build_system_prompt(request)

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            async for token in _stream_with_retry(system_prompt):
                yield f"data: {token}\n\n"
            logger.info("generate-prompt stream completed")
        except OllamaUnavailableError as exc:
            logger.error("Ollama became unavailable mid-stream: %s", exc)
            yield "data: [ERROR] LLM service disconnected\n\n"
        except LLMStreamError as exc:
            logger.error("LLM stream error after retries: %s", exc)
            yield "data: [ERROR] Failed to generate prompt\n\n"
        except Exception as exc:
            logger.exception("Unexpected error during streaming: %s", exc)
            yield "data: [ERROR] Internal server error\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    available = await llm_service.check_availability()
    return HealthResponse(
        status="ok" if available else "degraded",
        timestamp=datetime.now(timezone.utc).isoformat(),
        ollama_available=available,
        model=llm_service.model,
    )
