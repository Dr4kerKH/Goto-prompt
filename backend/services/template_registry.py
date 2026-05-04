import json
import logging
from pathlib import Path
from typing import Dict

from models.schemas import TaskType

logger = logging.getLogger(__name__)

DEFAULT_TASK_TYPE: TaskType = "format_rewrite"

BUILTIN_TASK_TEMPLATES: Dict[TaskType, str] = {
    "coding": """TASK TEMPLATE: coding
- Goal: produce high-quality code-focused prompts with clear technical constraints.
- Must capture: language/runtime, dependencies, input/output contract, edge cases, tests, and failure handling.
- Prefer precise acceptance criteria (linting, tests, expected behavior).
- Include placeholders like [YOUR_LANGUAGE], [YOUR_RUNTIME], [YOUR_INPUT_SCHEMA], [YOUR_TEST_COMMAND].
""",
    "design_with_code": """TASK TEMPLATE: design_with_code
- Goal: produce architecture/design prompts that still include implementation-ready code guidance.
- Must capture: scope, constraints, tradeoffs, interfaces, modules, and migration steps.
- Include both conceptual sections and concrete snippets/pseudocode expectations.
- Include placeholders like [YOUR_SYSTEM_SCOPE], [YOUR_TECH_STACK], [YOUR_NON_FUNCTIONAL_REQUIREMENTS].
""",
    "format_rewrite": """TASK TEMPLATE: format_rewrite
- Goal: rewrite or reformat content without changing intent.
- Must capture: target format, tone, audience, length, mandatory sections, and forbidden changes.
- Preserve meaning unless user explicitly asks to expand/reduce.
- Include placeholders like [YOUR_TARGET_FORMAT], [YOUR_TONE], [YOUR_MAX_LENGTH].
""",
    "image_generation": """TASK TEMPLATE: image_generation
- Goal: produce prompts optimized for image generation models.
- Must capture: subject, style, composition, camera/framing, lighting, color mood, and negative constraints.
- Prefer explicit aspect ratio/output hints and avoid vague adjectives.
- Include placeholders like [YOUR_SUBJECT], [YOUR_STYLE], [YOUR_ASPECT_RATIO], [YOUR_NEGATIVE_PROMPT].
""",
}


def _load_override_file(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        logger.warning("Task template override path not found: %s", path)
        return {}

    try:
        raw = p.read_text(encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed reading task template override file: %s", exc)
        return {}

    suffix = p.suffix.lower()
    try:
        if suffix == ".json":
            data = json.loads(raw)
        elif suffix in (".yaml", ".yml"):
            import yaml  # type: ignore

            data = yaml.safe_load(raw)
        else:
            logger.warning("Unsupported task template override extension: %s", suffix)
            return {}
    except Exception as exc:
        logger.warning("Failed parsing task template override file: %s", exc)
        return {}

    if not isinstance(data, dict):
        logger.warning("Task template override root must be an object/map")
        return {}
    return data


def load_task_templates(override_path: str | None = None) -> Dict[TaskType, str]:
    merged: Dict[TaskType, str] = dict(BUILTIN_TASK_TEMPLATES)
    override = _load_override_file(override_path)
    for k, v in override.items():
        if k in BUILTIN_TASK_TEMPLATES and isinstance(v, str) and v.strip():
            merged[k] = v.strip()
    return merged

