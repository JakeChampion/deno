// Mirrors a config passed with `--config` whose inline `imports` are the
// import map and get rewritten on disk while the process is running.
const configPath = new URL("./deno.json", import.meta.url);

console.log(import.meta.resolve("alias"));
const first = await import("alias");
console.log(first.default);

Deno.writeTextFileSync(
  configPath,
  JSON.stringify({ imports: { alias: "./b.ts" } }),
);
await Deno[Deno.internal].reloadImportMap();

console.log(import.meta.resolve("alias"));
const second = await import("alias");
console.log(second.default);

// a module that was already instantiated is still the same instance
const againA = await import("./a.ts");
console.log(first === againA);
