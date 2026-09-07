try {
  // @ts-ignore Deno.internal is not part of the public types
  await Deno[Deno.internal].reloadImportMap();
  console.log("unexpectedly succeeded");
} catch (err) {
  console.log("rejected:", (err as Error).message);
}
