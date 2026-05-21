using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using GotoPrompt.Models;
using Microsoft.Extensions.Options;

namespace GotoPrompt.Services;

public class OllamaService(
    HttpClient httpClient,
    IOptions<OllamaOptions> options,
    TemplateRegistry templates) : ILlmService
{
    private static readonly int MaxCanonicalBytes = 24 * 1024;
    private static readonly int MaxUserMessageBytes = 8 * 1024;
    private readonly string _model = options.Value.Model;

    // Streaming Token level async API
    public async IAsyncEnumerable<string> StreamAsync(
        PromptRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var mode = ModeClassifier.Classify(request.UserMessage, request.CanonicalPrompt);
        var taskType = ModeClassifier.DetectTaskType(request.UserMessage, request.TaskType);
        var systemPrompt = BuildSystemPrompt(mode, taskType, request.CanonicalPrompt);
        var messages = BuildMessages(request, systemPrompt);

        var payload = new { model = _model, messages, stream = true };
        var json = JsonSerializer.Serialize(payload);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        try
        {
            response = await httpClient.PostAsync("/api/chat", content, ct);
            response.EnsureSuccessStatusCode();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            yield return $"[Error connecting to Ollama: {ex.Message}]";
            yield break;
        }

        using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream && !ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct);
            if (string.IsNullOrWhiteSpace(line)) continue;

            OllamaChunk? chunk;
            try { chunk = JsonSerializer.Deserialize<OllamaChunk>(line); }
            catch { continue; }

            if (chunk?.Message?.Content is { Length: > 0 } token)
                yield return token;

            if (chunk?.Done == true) break;
        }
    }

    private string BuildSystemPrompt(PromptMode mode, string taskType, string? canonical)
    {
        var template = templates.Get(taskType);
        return mode switch
        {
            PromptMode.Clarify => $"""
                {template}
                The user's request is vague. Ask 2-3 targeted clarifying questions to understand their needs.
                Be concise and friendly. Do not generate a full prompt yet.
                """,

            PromptMode.Refine => $"""
                {template}
                The user wants to refine an existing prompt. Incorporate their feedback and return the complete updated prompt.

                Existing prompt:
                {Truncate(canonical ?? "", MaxCanonicalBytes)}
                """,

            _ => $"""
                {template}
                Generate a complete, structured prompt based on the user's request.
                Use the section headers defined above. Be specific and actionable.
                """
        };
    }

    private static List<object> BuildMessages(PromptRequest request, string systemPrompt)
    {
        var messages = new List<object>
        {
            new { role = "system", content = systemPrompt }
        };

        if (request.RecentDeltas is { Count: > 0 })
            foreach (var delta in request.RecentDeltas.TakeLast(6))
                messages.Add(new { role = "user", content = Truncate(delta, 2048) });

        messages.Add(new { role = "user", content = Truncate(request.UserMessage, MaxUserMessageBytes) });
        return messages;
    }

    private static string Truncate(string s, int maxBytes)
    {
        if (Encoding.UTF8.GetByteCount(s) <= maxBytes) return s;
        var bytes = Encoding.UTF8.GetBytes(s)[..maxBytes];
        return Encoding.UTF8.GetString(bytes);
    }
}

file record OllamaChunk(
    [property: JsonPropertyName("message")] OllamaMessage? Message,
    [property: JsonPropertyName("done")] bool Done
);

file record OllamaMessage(
    [property: JsonPropertyName("content")] string? Content
);
