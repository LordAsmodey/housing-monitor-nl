export type Filters = Record<string, number | null>;
export type Settings = {
  enabled: boolean;
  filters: Filters;
  revision: number;
  appliedRevision: number;
};
export type Run = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  listingsFound: number | null;
  collectionScope: string | null;
  errorCategory: string | null;
  searchRevision: number | null;
};
export type Field = {
  key: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  nullable: boolean;
  stage: string;
};
export type Source = {
  module: {
    id: string;
    key: string;
    name: string;
    note: string;
    fields: Field[];
  };
  ready: boolean;
  runtimeAvailable: boolean;
  runtimeEnabled: boolean;
  settings: Settings;
  health: null | {
    status: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextCheckAt: string | null;
    running: boolean;
    listings: number;
    runs: Run[];
  };
};
export type Overview = {
  updatedAt: string;
  deliveryEnabled: boolean;
  delivery: { status: string; count: number }[];
  sources: Source[];
};
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api/admin/" + path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Request": "1",
      "X-CSRF-Token": csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("admin-session-expired"));
    throw new Error(
      typeof data.message === "string"
        ? data.message
        : "Не удалось выполнить запрос",
    );
  }
  return data;
}
