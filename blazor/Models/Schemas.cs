namespace GotoPrompt.Models;

public record PromptRequest(
    string UserMessage,
    string? CanonicalPrompt = null,
    List<string>? RecentDeltas = null,
    string? TaskType = null
);

public enum PromptMode { Clarify, Generate, Refine }

public record ChatMessage(string Role, string Content, bool IsPrompt = false);

public class OllamaOptions
{
    public string ApiUrl { get; set; } = "http://localhost:11434";
    public string Model { get; set; } = "mistral:7b";
}
