using System.Collections.Concurrent;
using backend.Endpoints;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<ConcurrentDictionary<string, long>>();
builder.Services.AddSingleton<LAState>();

var app = builder.Build();

app.MountAttackEndpoints();
app.MountStateEndpoints();

app.Run();
