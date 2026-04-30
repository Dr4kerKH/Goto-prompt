import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from utils.logging import setup_logging
from routers.prompts import router as prompts_router

setup_logging()

app = FastAPI(
    title="Prompt Engineering Assistant",
    description="AI-powered prompt engineering suggestions",
    version="1.0.0",
)

_raw_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000")
cors_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(prompts_router)


@app.get("/")
async def root() -> dict:
    return {"service": "Prompt Engineering Assistant API", "version": "1.0.0", "status": "running"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
