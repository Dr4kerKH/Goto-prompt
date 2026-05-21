using GotoPrompt.Models;
using GotoPrompt.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.Configure<OllamaOptions>(builder.Configuration.GetSection("Ollama"));
builder.Services.AddSingleton<TemplateRegistry>();

var ollamaUrl = builder.Configuration["Ollama:ApiUrl"] ?? "http://localhost:11434";
builder.Services.AddHttpClient<OllamaService>(client =>
{
    client.BaseAddress = new Uri(ollamaUrl);
    client.Timeout = Timeout.InfiniteTimeSpan; // streaming — never time out mid-response
});
builder.Services.AddScoped<ILlmService, OllamaService>();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<GotoPrompt.App>()
    .AddInteractiveServerRenderMode();

app.Run();
