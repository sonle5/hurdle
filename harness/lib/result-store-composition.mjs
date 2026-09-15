const engineFactoriesByStore = new WeakMap();

export function registerResultStoreEngineFactory(store, factory) {
  if (
    !store
    || typeof store !== "object"
    || typeof factory !== "function"
    || engineFactoriesByStore.has(store)
  ) {
    throw new TypeError("Result Store engine factory cannot be registered");
  }
  engineFactoriesByStore.set(store, factory);
}

export function composeResultStoreRunEngine(store, dependencies) {
  const factory = engineFactoriesByStore.get(store);
  if (!factory) throw new TypeError("Run Engine requires a first-party Result Store");
  return factory(dependencies);
}
