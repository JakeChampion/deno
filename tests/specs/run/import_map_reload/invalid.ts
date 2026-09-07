const mapPath = new URL("./map.json", import.meta.url);

const first = await import("alias");
console.log(first.default);

Deno.writeTextFileSync(mapPath, "{ not json");
try {
  await Deno[Deno.internal].reloadImportMap();
  console.log("unexpectedly succeeded");
} catch (err) {
  console.log("rejected:", (err as Error).message.split("\n")[0]);
}

// the previous import map is still in use
console.log(import.meta.resolve("alias"));
