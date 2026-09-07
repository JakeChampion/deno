const mapPath = new URL("./map.json", import.meta.url);

function ask(worker: Worker, message: string): Promise<string> {
  return new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage(message);
  });
}

const first = await import("alias");
console.log("main before:", first.default);

const worker1 = new Worker(import.meta.resolve("./worker.ts"), {
  type: "module",
});
console.log("worker1 before:", await ask(worker1, "import"));

Deno.writeTextFileSync(
  mapPath,
  JSON.stringify({ imports: { alias: "./b.ts" } }),
);
await Deno[Deno.internal].reloadImportMap();
console.log("main after:", (await import("alias")).default);

// the import map is shared, but worker1 still has its own cached resolution
console.log("worker1 after:", await ask(worker1, "import"));
// until it reloads itself
console.log("worker1 reloaded:", await ask(worker1, "reload"));

// a worker created after the reload has no cached resolutions
const worker2 = new Worker(import.meta.resolve("./worker.ts"), {
  type: "module",
});
console.log("worker2:", await ask(worker2, "import"));

worker1.terminate();
worker2.terminate();
