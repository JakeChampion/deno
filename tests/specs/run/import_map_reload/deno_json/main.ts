const mapPath = new URL("./map.json", import.meta.url);

console.log(import.meta.resolve("alias"));
const first = await import("alias");
console.log(first.default);

Deno.writeTextFileSync(
  mapPath,
  JSON.stringify({ imports: { alias: "./b.ts" } }),
);
await Deno[Deno.internal].reloadImportMap();

console.log(import.meta.resolve("alias"));
const second = await import("alias");
console.log(second.default);

// a module that was already instantiated is still the same instance
const againA = await import("./a.ts");
console.log(first === againA);
