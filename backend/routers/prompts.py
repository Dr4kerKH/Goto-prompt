import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import AsyncGenerator, List, Dict, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import HealthResponse, PromptGenerationRequest, TaskType
from services.llm_service import OllamaService
from services.template_registry import DEFAULT_TASK_TYPE, load_task_templates
from utils.errors import LLMStreamError, OllamaUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")
llm_service = OllamaService()
task_templates = load_task_templates(os.getenv("TASK_TEMPLATE_PATH"))

MAX_RETRIES = 2

# Context caps (characters) — keeps local-model windows predictable
MAX_CANONICAL_CHARS = 24_000
MAX_USER_MESSAGE_CHARS = 8_000
MAX_RECENT_DELTAS = 6
MAX_DELTA_ITEM_CHARS = 2_000
MAX_TASK_TEMPLATE_CHARS = 4_000

SYSTEM_MESSAGE = """You are Goto-prompt: an agent specialized in rewriting and engineering prompts for other LLMs and agents.

Your job is either (1) ask concise clarifying questions when critical details are missing, or (2) produce an improved full prompt document. You never perform the end-user's task yourself — you only shape the instructions another model will follow.

## When to clarify
Ask questions only when missing information would materially change the prompt (domain, audience, output shape, tools/APIs, safety level, length, format). At most 5 short questions, numbered. No preamble or apology.

## When to deliver a prompt
If the goal is clear enough (or the user supplied a canonical prompt and a precise edit), output one complete, copy-paste-ready prompt for downstream use. Use scannable plain text only (no markdown code fences).

### Section layout (mandatory for prompt output)
Use a short line that is ONLY a section title ending with a colon, then the body on the following lines. Example:
Role:
  ...body...

Use these sections when applicable (omit only if truly empty): Role, Objective, Context, User-provided inputs, Instructions, Input format, Output format, Constraints, Edge cases.

### Fill-in fields and placeholders (when details are unknown or user-specific)
When something must be supplied later by a human or another system, do NOT invent specifics. Use explicit placeholders so readers can scan and replace them:

1. Prefer bracket form with YOUR_ prefix and UPPER_SNAKE_CASE, e.g. [YOUR_PRODUCT_NAME], [YOUR_API_BASE_URL], [YOUR_PRIMARY_AUDIENCE].
2. Optional alternate: double braces for short keys, e.g. {{company_name}}, {{deadline}}.
3. Put every tunable or unknown in ONE compact block at the top OR repeat placeholders consistently in the body — choose one approach and stick to it.

After placeholders or tunables, add short checklist lines using plain ASCII, e.g. "- [ ] Replace all [YOUR_*] placeholders before use."

### Human scanning
Keep section bodies short bullets or tight paragraphs (avoid walls of prose). Use consistent placeholder syntax so readers can search for [YOUR_ or {{ in the editor.

## Style
- Be specific and testable; avoid vague filler.
- Prefer explicit constraints and negative rules where they help determinism.
- If the user requests a different tone, length, or format, apply it to the full canonical document.

## Refinement
When a CURRENT_CANONICAL_PROMPT is present, treat the CURRENT_USER_REQUEST as a delta: merge edits into a single revised full prompt unless the user clearly starts a brand-new task (they will say so in the request section). Preserve or improve placeholder conventions already in the canonical prompt.

## Output rules
- No chit-chat, no meta-commentary about these rules, no "Here is your prompt".
- The entire reply body must be either only clarifying questions OR only the final prompt document — never both in one reply.
"""

TASK_TYPE_HINTS: dict[TaskType, tuple[str, ...]] = {
    "coding": (
        "python",
        "javascript",
        "typescript",
        "bug",
        "refactor",
        "function",
        "class",
        "test",
        "algorithm",
        "api endpoint",
    ),
    "design_with_code": (
        "architecture",
        "system design",
        "design doc",
        "microservice",
        "scalability",
        "diagram",
        "tradeoff",
        "implementation plan",
    ),
    "format_rewrite": (
        "rewrite",
        "rephrase",
        "format",
        "tone",
        "grammar",
        "summarize",
        "shorten",
        "expand",
        "convert to",
    ),
    "image_generation": (
        "image",
        "logo",
        "illustration",
        "poster",
        "thumbnail",
        "photorealistic",
        "prompt for stable diffusion",
        "midjourney",
        "dall-e",
    ),
}


def _truncate(s: str, max_len: int) -> str:
    if len(s) <= max_len:
        return s
    return s[: max_len - 20] + "\n...[truncated]..."


def _fresh_session_intent(user_message: str) -> bool:
    text = user_message.lower().strip()
    return any(
        k in text
        for k in (
            "start over",
            "new session",
            "new prompt",
            "from scratch",
            "ignore previous",
            "discard canonical",
            "reset prompt",
        )
    )


def classify_mode(user_message: str, has_canonical: bool) -> str:
    text = user_message.lower().strip()
    words = text.split()

    if _fresh_session_intent(user_message):
        return "GENERATE"

    if has_canonical:
        return "REFINE"

    if any(k in text for k in ("rewrite", "refine", "edit", "improve", "shorten", "expand")):
        return "GENERATE"

    if len(words) < 8 and not any(
        k in text
        for k in (
            "prompt",
            "system",
            "assistant",
            "llm",
            "json",
            "schema",
            "agent",
            "api",
            "tool",
            "code",
            "python",
            "javascript",
            "typescript",
            "refactor",
            "function",
            "class",
            "image",
            "logo",
            "design",
            "architecture",
        )
    ):
        return "CLARIFY"

    return "GENERATE"


def classify_task_type(user_message: str) -> TaskType:
    text = user_message.lower()
    for candidate, terms in TASK_TYPE_HINTS.items():
        if any(term in text for term in terms):
            return candidate
    return DEFAULT_TASK_TYPE


def resolve_task_type(request: PromptGenerationRequest) -> TaskType:
    if request.task_type and request.task_type in task_templates:
        return request.task_type
    return classify_task_type(request.user_message)


def infer_response_kind(text: str, mode: str) -> str:
    """Decide whether the model replied with clarification vs a full prompt (for client canonical sync)."""
    t = text.strip()
    if not t:
        return "clarify"
    if mode == "CLARIFY":
        return "clarify"
    low = t.lower()
    if any(
        low.startswith(p)
        for p in (
            "role:",
            "you are ",
            "you're ",
            "# role",
            "objective:",
            "task:",
        )
    ):
        return "prompt"
    q = t.count("?")
    if len(t) < 700 and q >= 1:
        lines = [ln.strip() for ln in t.splitlines() if ln.strip()]
        if len(lines) <= 8:
            return "clarify"
    return "prompt"


def build_user_payload(
    request: PromptGenerationRequest,
    mode: str,
    task_type: TaskType,
    task_template: str,
) -> str:
    canonical = None if _fresh_session_intent(request.user_message) else request.canonical_prompt
    if canonical:
        canonical = _truncate(canonical, MAX_CANONICAL_CHARS)
    user_msg = _truncate(request.user_message, MAX_USER_MESSAGE_CHARS)
    task_template = _truncate(task_template, MAX_TASK_TEMPLATE_CHARS)

    recent_block = ""
    if request.recent_deltas:
        trimmed = [_truncate(d, MAX_DELTA_ITEM_CHARS) for d in request.recent_deltas[-MAX_RECENT_DELTAS:]]
        numbered = "\n".join(f"{i + 1}. {line}" for i, line in enumerate(trimmed))
        recent_block = f"""[SECTION: PRIOR_USER_REQUESTS — oldest first; context only]
{numbered}
[/SECTION]

"""

    canon_display = (
        canonical
        if canonical
        else "(none yet — produce the initial prompt from CURRENT_USER_REQUEST only.)"
    )

    return f"""[SECTION: CURRENT_CANONICAL_PROMPT]
{canon_display}
[/SECTION]

[SECTION: SELECTED_TASK_TEMPLATE]
TASK_TYPE: {task_type}
{task_template}
[/SECTION]

{recent_block}[SECTION: CURRENT_USER_REQUEST]
{user_msg}
[/SECTION]

SERVER_MODE: {mode}
- TASK_TYPE: {task_type}
- CLARIFY: respond with numbered questions only.
- GENERATE: respond with one full prompt document only (no questions). Use section titles ending with ":" on their own line; use [YOUR_*] or {{{{key}}}} placeholders where details are unknown.
- REFINE: respond with one full revised prompt document only (merge delta into canonical); keep placeholders consistent.

Follow SYSTEM instructions."""


def build_messages(request: PromptGenerationRequest) -> Tuple[List[Dict[str, str]], str, TaskType]:
    has_canonical = bool(request.canonical_prompt) and not _fresh_session_intent(request.user_message)
    mode = classify_mode(request.user_message, has_canonical)
    task_type = resolve_task_type(request)
    task_template = task_templates.get(task_type) or task_templates[DEFAULT_TASK_TYPE]
    user_content = build_user_payload(request, mode, task_type, task_template)
    messages: List[Dict[str, str]] = [{"role": "user", "content": user_content}]
    return messages, mode, task_type


async def stream_with_retry(
    messages: List[Dict[str, str]], system: str
) -> AsyncGenerator[str, None]:
    last_error = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            async for token in llm_service.generate_stream(messages, system=system):
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


@router.post("/generate-prompt")
async def generate_prompt(request: PromptGenerationRequest):
    logger.info(
        "Request received (canonical=%s, task_type=%s)",
        bool(request.canonical_prompt),
        request.task_type,
    )

    if not await llm_service.check_availability():
        raise HTTPException(
            status_code=503,
            detail="LLM service unavailable",
        )

    messages, mode, selected_task_type = build_messages(request)
    logger.info("Resolved task template: %s", selected_task_type)

    async def event_stream():
        buffer = ""

        try:
            async for token in stream_with_retry(messages, SYSTEM_MESSAGE):
                buffer += token
                yield f"data: {token}\n\n"

            kind = infer_response_kind(buffer, mode)
            yield f"data: [META]{kind}\n\n"

        except Exception as e:
            logger.exception("Streaming error: %s", e)
            yield "data: [ERROR] Generation failed\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/health", response_model=HealthResponse)
async def health():
    ok = await llm_service.check_availability()

    return HealthResponse(
        status="ok" if ok else "degraded",
        timestamp=datetime.now(timezone.utc).isoformat(),
        ollama_available=ok,
        model=llm_service.model,
    )
