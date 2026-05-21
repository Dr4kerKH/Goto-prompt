using GotoPrompt.Models;

namespace GotoPrompt.Services;

public interface ILlmService
{
    IAsyncEnumerable<string> StreamAsync(PromptRequest request, CancellationToken ct = default);
}
