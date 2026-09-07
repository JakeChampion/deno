self.onmessage = async (e) => {
  if (e.data === "reload") {
    await Deno[Deno.internal].reloadImportMap();
  }
  const mod = await import("alias");
  self.postMessage(mod.default);
};
