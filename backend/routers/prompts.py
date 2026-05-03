import asyncio
import logging
from datetime import datetime, timezone
from typing import AsyncGenerator, List, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import HealthResponse, PromptGenerationRequest
from services.llm_service import OllamaService
from utils.errors import LLMStreamError, OllamaUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")
llm_service = OllamaService()

MAX_RETRIES = 2


# =========================
# IMMUTABLE SYSTEM POLICY
# =========================
SYSTEM_MESSAGE = (
    "You are Goto-prompt.\n\n"

    "ROLE:\n"
    "- You generate system prompts for AI assistants.\n\n"

    "STRICT MODES (choose exactly one):\n"
    "1. GENERATE → output ONLY final system prompt\n"
    "2. CLARIFY → ask up to 2 questions only\n"
    "3. REFINE → rewrite and output ONLY updated prompt\n\n"

    "HARD RULES:\n"
    "- No explanations\n"
    "- No markdown\n"
    "- No labels\n"
    "- No extra text outside required output\n"
    "- Do NOT mention modes\n\n"

    "OUTPUT FORMAT (MANDATORY):\n"
    "[GENERATE]\n<system prompt>\n\n"
    "[CLARIFY]\n- question 1\n- question 2\n\n"
    "[REFINE]\n<updated prompt>\n"
)


# =========================
# MODE CONTROL (SERVER-SIDE)
# =========================
def classify_mode(user_message: str) -> str:
    text = user_message.lower()

    if any(k in text for k in ["rewrite", "refine", "edit", "improve"]):
        return "REFINE"

    if len(text.split()) < 6:
        return "CLARIFY"

    return "GENERATE"


# =========================
# CONTEXT BUILDER (ENFORCED ORDER)
# =========================
def build_messages(request: PromptGenerationRequest) -> List[Dict]:
    messages: List[Dict] = []

    # 1. SYSTEM ALWAYS FIRST (ENFORCED)
    messages.append({
        "role": "system",
        "content": SYSTEM_MESSAGE
    })

    # 2. Optional trimmed history (prevents context overflow)
    if request.conversation_history:
        for msg in request.conversation_history[-6:]:
            messages.append({
                "role": msg.role,
                "content": msg.content
            })

    # 3. Server-controlled user input (mode injected)
    mode = classify_mode(request.user_message)

    messages.append({
        "role": "user",
        "content": f"""MODE: {mode}

USER REQUEST:
{request.user_message}

Follow system rules strictly."""
    })

    return messages, mode


# =========================
# VALIDATION (FAIL SAFE)
# =========================
def validate_output(text: str, mode: str) -> str:
    text = text.strip()

    if mode == "CLARIFY" and "?" not in text:
        raise ValueError("Invalid CLARIFY output")

    if mode in ("GENERATE", "REFINE") and "?" in text:
        raise ValueError("Invalid GENERATE/REFINE output contains questions")

    return text


# =========================
# STREAM WITH RETRY
# =========================
async def stream_with_retry(messages) -> AsyncGenerator[str, None]:
    last_error = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            async for token in llm_service.generate_stream(messages):
                yield token
            return

        except OllamaUnavailableError:
            raise

        except LLMStreamError as e:
            last_error = e

            if attempt < MAX_RETRIES:
                await asyncio.sleep(2 ** attempt)
                logger.warning("Retrying LLM stream...")
            else:
                logger.error("LLM failed after retries")

    raise last_error


# =========================
# MAIN ENDPOINT
# =========================
@router.post("/generate-prompt")
async def generate_prompt(request: PromptGenerationRequest):
    logger.info("Request received")

    if not await llm_service.check_availability():
        raise HTTPException(
            status_code=503,
            detail="LLM service unavailable"
        )

    messages, mode = build_messages(request)

    async def event_stream():
        buffer = ""

        try:
            async for token in stream_with_retry(messages):
                buffer += token
                yield f"data: {token}\n\n"

            # enforce output correctness AFTER generation
            validate_output(buffer, mode)

        except Exception as e:
            logger.exception("Streaming error: %s", e)
            yield "data: [ERROR] Generation failed\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# =========================
# HEALTH CHECK
# =========================
@router.get("/health", response_model=HealthResponse)
async def health():
    ok = await llm_service.check_availability()

    return HealthResponse(
        status="ok" if ok else "degraded",
        timestamp=datetime.now(timezone.utc).isoformat(),
        ollama_available=ok,
        model=llm_service.model,
    )