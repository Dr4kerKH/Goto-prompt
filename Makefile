# Monorepo commands for Prompt Engineering Assistant
#
# Windows (Git Bash):  BIN = backend/.venv/Scripts  (default)
# Mac/Linux:           override with `make <target> BIN=backend/.venv/bin`

VENV := backend/.venv
BIN  := $(VENV)/Scripts

.PHONY: setup install dev-backend dev-frontend dev clean help

## First-time setup: create venv and install backend deps
setup:
	python -m venv $(VENV)
	$(BIN)/pip install --upgrade pip
	$(BIN)/pip install -r backend/requirements.txt
	cp -n backend/.env.example backend/.env || true

## Install / sync backend deps after requirements.txt changes
install:
	$(BIN)/pip install -r backend/requirements.txt
===========================================================================
## Run backend dev server (hot-reload, port 8000)
dev-backend:
	cd backend && .venv/Scripts/python -m uvicorn main:app --reload --port 8000

## Serve frontend on port 3000
dev-frontend:
	python -m http.server 3000 --directory frontend
===========================================================================
## Remove virtualenv
clean:
	rm -rf $(VENV)

help:
	@echo ""
	@echo "  make setup          Create venv + install deps (first time)"
	@echo "  make install        Re-install deps"
	@echo "  make dev-backend    Run FastAPI with hot-reload (port 8000)"
	@echo "  make dev-frontend   Serve frontend (port 3000)"
	@echo "  make clean          Remove virtualenv"
	@echo ""
	@echo "  Mac/Linux: append BIN=backend/.venv/bin to any target"
	@echo ""
