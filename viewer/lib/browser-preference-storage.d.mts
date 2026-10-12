export function readStoredPreference(storage: Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>, key: string): string | null;
