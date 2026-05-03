import json
import logging
import os
from typing import AsyncGenerator

import httpx

from utils.errors import LLMStreamError, OllamaUnavailableError

logger = logging.getLogger(__name__)


class OllamaService:
    def __init__(self) -> None:
        self.base_url: str = os.getenv("OLLAMA_API_URL", "http://localhost:11434").rstrip("/")
        self.model: str = os.getenv("LLM_MODEL", "mistral:7b")

    async def check_availability(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                return response.status_code == 200
        except Exception as exc:
            logger.warning("Ollama availability check failed: %s", exc)
            return False

    async def generate_stream(self, messages: list[dict], system: str = "") -> AsyncGenerator[str, None]:
        payload: dict = {"model": self.model, "messages": messages, "stream": True}
        if system:
            payload["system"] = system
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/api/chat",
                    json=payload,
                ) as response:
                    if response.status_code != 200:
                        raise LLMStreamError(f"Ollama returned HTTP {response.status_code}")
                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        try:
                            data: dict = json.loads(line)
                        except json.JSONDecodeError as exc:
                            logger.warning("Skipping unparseable line: %s | %s", line, exc)
                            continue
                        token: str = data.get("message", {}).get("content", "")
                        if token:
                            yield token
                        if data.get("done", False):
                            return
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise OllamaUnavailableError(self.base_url) from exc
        except LLMStreamError:
            raise
        except Exception as exc:
            raise LLMStreamError(str(exc)) from exc
