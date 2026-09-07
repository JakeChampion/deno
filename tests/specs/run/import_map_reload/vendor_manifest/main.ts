// http://localhost:4546 redirects to http://localhost:4545. The vendor
// manifest is what records the redirect, so this import only works once the
// manifest brought in by the staged vendor directory has been reloaded;
// the module files alone cannot satisfy it.
const url = "http://localhost:4546/welcome.ts";

try {
  await import(url);
  console.log("unexpectedly imported before reload");
} catch {
  console.log("not cached before reload");
}

Deno.renameSync(
  new URL("./staging/vendor", import.meta.url),
  new URL("./vendor", import.meta.url),
);
await Deno[Deno.internal].reloadImportMap();

await import(url);
console.log("imported after reload");
