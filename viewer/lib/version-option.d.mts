export type VersionOptionInput = {
  id: string;
  name: string;
  description?: string | null;
  kind?: "weekly" | "experiment" | "smoke" | null;
  runAt?: string | null;
  createdAt?: string | null;
};

export function versionOptionItem(option: VersionOptionInput): {
  value: string;
  label: string;
  sub: string | null;
  description: string | null;
};
