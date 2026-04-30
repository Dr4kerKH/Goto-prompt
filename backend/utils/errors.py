class OllamaUnavailableError(Exception):
    def __init__(self, url: str) -> None:
        super().__init__(f"Ollama service unavailable at {url}")
        self.url = url


class LLMStreamError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
