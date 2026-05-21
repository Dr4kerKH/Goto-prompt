using GotoPrompt.Models;

namespace GotoPrompt.Services;

public static class ModeClassifier
{
    private static readonly string[] VagueTerms =
        ["something", "anything", "whatever", "idk", "not sure", "i don't know"];

    private static readonly string[] ImageKeywords =
        ["image", "picture", "photo", "dalle", "midjourney", "stable diffusion", "flux"];

    private static readonly string[] DesignKeywords =
        ["component", " ui ", "frontend", "css", "tailwind", "layout", "responsive", "html page"];

    private static readonly string[] RewriteKeywords =
        ["rewrite", "format", "convert", "restructure", "rephrase", "translate", "transform"];

    public static PromptMode Classify(string userMessage, string? canonicalPrompt)
    {
        if (!string.IsNullOrWhiteSpace(canonicalPrompt))
            return PromptMode.Refine;

        var lower = userMessage.ToLowerInvariant();
        if (userMessage.Length < 60 && VagueTerms.Any(t => lower.Contains(t)))
            return PromptMode.Clarify;

        return PromptMode.Generate;
    }

    public static string DetectTaskType(string userMessage, string? explicitType)
    {
        if (!string.IsNullOrWhiteSpace(explicitType)) return explicitType;

        var lower = " " + userMessage.ToLowerInvariant() + " ";
        if (ImageKeywords.Any(k => lower.Contains(k))) return "image_generation";
        if (DesignKeywords.Any(k => lower.Contains(k))) return "design_with_code";
        if (RewriteKeywords.Any(k => lower.Contains(k))) return "format_rewrite";
        return "coding";
    }
}
