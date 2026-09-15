export type EvalVersionDisplay = {
  id: string;
  name?: string | null;
};

export function evalVersionDisplayName(version: EvalVersionDisplay | null | undefined): string {
  const name = version?.name?.trim();
  return name || version?.id || "";
}

export function evalVersionDisplayNameById(
  versions: EvalVersionDisplay[],
  id: string | null | undefined,
): string {
  if (!id) return "";
  return evalVersionDisplayName(versions.find((version) => version.id === id)) || id;
}
