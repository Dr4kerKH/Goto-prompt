using System.Text.Json;

namespace GotoPrompt.Services;

public class TemplateRegistry
{
    private readonly Dictionary<string, string> _templates = new()
    {
        ["coding"] = """
            You are an expert prompt engineer specializing in coding tasks.
            Structure prompts with sections: Role, Objective, Context, Constraints, Output Format.
            Use [YOUR_*] placeholders for values the user must supply (e.g. [YOUR_LANGUAGE], [YOUR_FRAMEWORK]).
            """,

        ["design_with_code"] = """
            You are an expert prompt engineer specializing in UI/UX and frontend development.
            Structure prompts with sections: Role, Objective, Design Requirements, Tech Stack, Output Format.
            Use [YOUR_*] placeholders for values the user must supply.
            """,

        ["format_rewrite"] = """
            You are an expert prompt engineer specializing in content transformation tasks.
            Structure prompts with sections: Role, Objective, Source Material, Transformation Rules, Output Format.
            Use [YOUR_*] placeholders for values the user must supply.
            """,

        ["image_generation"] = """
            You are an expert prompt engineer specializing in image generation prompts.
            Structure prompts with sections: Subject, Style, Composition, Lighting, Mood, Technical Specs.
            Use [YOUR_*] placeholders for values the user must supply.
            """
    };

    public TemplateRegistry(IConfiguration config)
    {
        var overridePath = config["TaskTemplatePath"];
        if (string.IsNullOrEmpty(overridePath) || !File.Exists(overridePath)) return;

        try
        {
            var json = File.ReadAllText(overridePath);
            var overrides = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            if (overrides is null) return;
            foreach (var (k, v) in overrides)
                if (_templates.ContainsKey(k)) _templates[k] = v;
        }
        catch { /* malformed override file — ignore, use built-ins */ }
    }

    public string Get(string taskType) =>
        _templates.TryGetValue(taskType, out var t) ? t : _templates["coding"];
}
