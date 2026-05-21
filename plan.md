# Conversion Plan: Python/FastAPI + Vanilla JS → ASP.NET Blazor Server

## Why Blazor Server

The app is streaming-heavy and stateful per session. Blazor Server's SignalR connection replaces the SSE + client-side `[META]` sentinel dance entirely — the component just awaits tokens and calls `StateHasChanged()`. No separate ports, no CORS, no manual SSE parsing.

---

## Project Structure

```
blazor/
├── GotoPrompt.csproj
├── Program.cs
├── appsettings.json
├── App.razor
├── Routes.razor
├── _Imports.razor
├── Models/
│   └── Schemas.cs              ← PromptRequest, ChatMessage, OllamaOptions
├── Services/
│   ├── ILlmService.cs
│   ├── OllamaService.cs        ← streams tokens from Ollama /api/chat
│   ├── TemplateRegistry.cs     ← built-in templates + optional override file
│   └── ModeClassifier.cs       ← CLARIFY / GENERATE / REFINE detection
├── Components/
│   ├── Layout/
│   │   └── MainLayout.razor
│   └── Pages/
│       └── Home.razor          ← entire chat UI + streaming logic
└── wwwroot/
    ├── app.css
    └── js/
        └── interop.js          ← dot-grid canvas, scrollToBottom (JS interop)
```

---

## Migration Map

| Python / JS | Blazor Server equivalent |
|---|---|
| `routers/prompts.py` SSE stream | `OllamaService.StreamAsync()` → `IAsyncEnumerable<string>` |
| `services/llm_service.py` | `OllamaService` using `HttpClient` with `ReadAsStreamAsync` |
| `services/template_registry.py` | `TemplateRegistry` singleton |
| `utils/errors.py` mode logic | `ModeClassifier` static class |
| `models/schemas.py` | C# records in `Models/Schemas.cs` |
| `frontend/script.js` state | `@code {}` block in `Home.razor` |
| Canvas dot-grid JS | Kept as-is — called via `IJSRuntime` on first render |
| Web Speech API mic | JS interop — no .NET equivalent |
| `[META]prompt` / `[META]clarify` | Removed — service returns structured result or `IAsyncEnumerable` ends cleanly; `isPrompt` flag carried on `ChatMessage` |

---

## Phases

### Phase 1 — Scaffold & verify it runs
- [x] Create `blazor/GotoPrompt.csproj` targeting net8.0
- [x] `Program.cs` with DI wiring
- [x] `App.razor`, `Routes.razor`, `_Imports.razor`
- [x] Minimal `MainLayout.razor`
- [x] `Home.razor` stub — just renders "hello"
- [ ] `dotnet run` from `blazor/` — confirms .NET toolchain works

### Phase 2 — Core services
- [x] `Models/Schemas.cs`
- [x] `Services/ModeClassifier.cs`
- [x] `Services/TemplateRegistry.cs`
- [x] `Services/OllamaService.cs` — streaming `IAsyncEnumerable<string>`
- [ ] Manually test streaming with a REST client against Ollama

### Phase 3 — Chat UI
- [x] `Home.razor` — full chat component with streaming, state, copy button
- [x] `wwwroot/js/interop.js` — dot-grid canvas + scrollToBottom
- [ ] Test golden path: send message → see tokens stream → copy prompt
- [ ] Test refinement: send follow-up → canonical merges correctly
- [ ] Test stop button cancels the stream

### Phase 4 — Polish
- [ ] Port mic button (Web Speech API via JS interop)
- [ ] Follow-up suggestion pills
- [ ] Health check endpoint (`/api/health`) if needed for Docker
- [ ] Dockerfile for the Blazor app
- [ ] Update Makefile with `dotnet run --project blazor/`

---

## Key Implementation Notes

**Streaming loop in `Home.razor`:**
```csharp
await foreach (var token in LlmService.StreamAsync(request, _cts.Token))
{
    _streamBuffer += token;
    await InvokeAsync(StateHasChanged); // pushes each token to browser via SignalR
}
```

**Why `InvokeAsync(StateHasChanged)`:** Blazor Server UI updates must happen on the render thread. `InvokeAsync` marshals the call correctly when streaming runs on a background task.

**`[META]` sentinels are gone:** `OllamaService` returns a plain token stream. Whether the result is a prompt or a clarification is determined by `ModeClassifier.Classify()` before the stream starts — the `Home.razor` knows upfront what kind of response to expect.

**Context capping:** `OllamaService.BuildMessages()` takes the last 6 deltas and truncates `CanonicalPrompt` to 24KB max. This mirrors the Python backend behavior.

**CancellationToken flow:** `Home.razor` owns the `CancellationTokenSource`. Stop button calls `_cts.Cancel()`. `IAsyncDisposable.DisposeAsync()` cancels on component teardown to prevent token leaks.

---

## Running the Blazor App

```
# Prerequisites: .NET 8 SDK, Ollama running on localhost:11434
cd blazor
dotnet run
# → https://localhost:5001
```

Configure via `blazor/appsettings.json` (same variables as the Python `.env`).
