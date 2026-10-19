import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, setCsrf, type Overview, type Source, type Settings } from "./api";
import "./style.css";
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString("ru-RU") : "—";
const labels: Record<string, string> = {
  HEALTHY: "Работает",
  DEGRADED: "Требует внимания",
  BLOCKED: "Заблокирован",
  DISABLED: "Не запущен",
  RUNNING: "Выполняется",
  SUCCEEDED: "Успешно",
  FAILED: "Ошибка",
  PENDING: "Ожидают",
  SENDING: "Отправляются",
  SENT: "Доставлены",
  DEAD_LETTER: "Ошибка доставки",
  UNCERTAIN: "Доставка не подтверждена",
};
function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const s = await api<{ csrf: string }>("login", "POST", {
        login: form.get("login"),
        password: form.get("password"),
      });
      setCsrf(s.csrf);
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="brand">
        HM<span> / HOUSING MONITOR</span>
      </div>
      <h1>Управление мониторингом</h1>
      <p>Войдите, чтобы настроить поиск жилья и проверить работу источников.</p>
      <form onSubmit={submit}>
        <label>
          Логин
          <input
            name="login"
            autoComplete="username"
            required
            autoFocus
            maxLength={200}
          />
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={500}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button disabled={busy}>{busy ? "Входим…" : "Войти"}</button>
      </form>
    </main>
  );
}
function SourcePanel({
  source,
  onSaved,
}: {
  source: Source;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(source.settings),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<
      | {
          revision: number;
          enabled: boolean;
          filters: Settings["filters"];
          createdAt: string;
        }[]
      | null
    >(null);
  const [dirty, setDirty] = useState(false);
  const changed = dirty;
  useEffect(() => {
    if (!dirty) setDraft(source.settings);
  }, [source.settings]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (changed) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await api<Settings>(
        "sources/" + encodeURIComponent(source.module.id),
        "PUT",
        {
          revision: draft.revision,
          enabled: draft.enabled,
          filters: draft.filters,
        },
      );
      setDraft(value);
      setDirty(false);
      setMessage("Настройки сохранены. Применятся к следующей проверке.");
      setHistory(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const h = source.health;
  return (
    <section className="source">
      <div className="section-title">
        <div>
          <span className="eyebrow">ИСТОЧНИК</span>
          <h2>{source.module.name}</h2>
        </div>
        <span
          className={
            "badge " + (!source.settings.enabled ? "paused" : (h?.status ?? ""))
          }
        >
          {!source.settings.enabled
            ? "Приостановлен"
            : (labels[h?.status ?? ""] ?? "Ожидает запуска")}
        </span>
      </div>
      <p className="note">{source.module.note}</p>
      {(!source.runtimeAvailable || !source.runtimeEnabled) && (
        <p className="error">
          Источник недоступен в текущей конфигурации сервера. Включение в форме
          не заменяет настройку подключения.
        </p>
      )}
      <div className="facts">
        <div>
          Последняя попытка<strong>{date(h?.lastAttemptAt ?? null)}</strong>
        </div>
        <div>
          Последний успех<strong>{date(h?.lastSuccessAt ?? null)}</strong>
        </div>
        <div>
          Следующая проверка
          <strong>
            {!source.settings.enabled
              ? "На паузе"
              : date(h?.nextCheckAt ?? null)}
          </strong>
        </div>
        <div>
          Объявлений в истории
          <strong>
            {h?.listings ?? "—"}
            {h?.running ? " · Проверка выполняется" : ""}
          </strong>
        </div>
      </div>
      <form onSubmit={save}>
        <div className="section-title">
          <h3>Настройки поиска</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => {
                setDirty(true);
                setDraft({ ...draft, enabled: e.target.checked });
                setMessage("");
              }}
            />
            Мониторинг включён
          </label>
        </div>
        <div className="fields">
          {source.module.fields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                required={!field.nullable}
                placeholder={field.nullable ? "Без ограничения" : undefined}
                value={draft.filters[field.key] ?? ""}
                onChange={(e) => {
                  setDirty(true);
                  setDraft({
                    ...draft,
                    filters: {
                      ...draft.filters,
                      [field.key]:
                        e.target.value === "" ? null : Number(e.target.value),
                    },
                  });
                  setMessage("");
                }}
              />
            </label>
          ))}
        </div>
        <p className="hint">
          После изменения фильтров текущая выдача сохраняется без уведомлений.
          Затем приходят только новые объявления. История сохраняется.
        </p>
        {source.settings.revision !== source.settings.appliedRevision && (
          <p className="hint">
            Новые настройки ожидают первого успешного сбора.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="success">
            {message}
          </p>
        )}
        <div className="actions">
          <button disabled={!changed || busy || !source.ready}>
            {busy ? "Сохраняем…" : "Сохранить настройки"}
          </button>
          {changed && (
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setDraft(source.settings);
                setDirty(false);
                setError("");
              }}
            >
              Отменить изменения
            </button>
          )}
          <span className="hint">Версия {draft.revision}</span>
        </div>
      </form>
      <h3>Последние проверки</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Начало</th>
              <th>Результат</th>
              <th>Охват</th>
              <th>Найдено</th>
              <th>Ошибка</th>
            </tr>
          </thead>
          <tbody>
            {h?.runs.map((run) => (
              <tr key={run.id}>
                <td>{date(run.startedAt)}</td>
                <td>{labels[run.status] ?? run.status}</td>
                <td>{run.collectionScope === 'head' ? 'Первые 2 страницы' : run.collectionScope === 'catalog' ? 'Вся выдача' : '—'}</td>
                <td>{run.listingsFound ?? "—"}</td>
                <td>
                  <code>{run.errorCategory ?? "—"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!h?.runs.length && <p className="hint">Проверок пока нет.</p>}
      </div>
      <button
        className="secondary"
        onClick={async () => {
          try {
            setHistory(
              await api(
                "sources/" + encodeURIComponent(source.module.id) + "/history",
              ),
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        История настроек
      </button>
      {history && (
        <div className="history">
          {history.length ? (
            history.map((change) => (
              <div key={change.revision}>
                <strong>
                  Версия {change.revision} · {date(change.createdAt)}
                </strong>
                <p>
                  {change.enabled ? "Включён" : "Приостановлен"} ·{" "}
                  {source.module.fields
                    .map(
                      (f) =>
                        `${f.label}: ${change.filters[f.key] ?? "без ограничения"}`,
                    )
                    .join(" · ")}
                </p>
              </div>
            ))
          ) : (
            <p>Изменений пока нет.</p>
          )}
        </div>
      )}
    </section>
  );
}
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [overview, setOverview] = useState<Overview | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const expired = () => {
      setAuthenticated(false);
      setOverview(null);
      setCsrf("");
    };
    window.addEventListener("admin-session-expired", expired);
    api<{ csrf: string }>("session")
      .then((s) => {
        setCsrf(s.csrf);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false));
    return () => window.removeEventListener("admin-session-expired", expired);
  }, []);
  async function refresh() {
    try {
      setOverview(await api<Overview>("overview"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!authenticated) return;
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [authenticated]);
  if (authenticated === null) return <main className="login">Загрузка…</main>;
  if (!authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  return (
    <>
      <header>
        <div className="brand">
          HM<span> / HOUSING MONITOR</span>
        </div>
        <button
          className="secondary"
          onClick={async () => {
            try {
              await api("logout", "POST");
              setAuthenticated(false);
              setOverview(null);
              setCsrf("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Выйти
        </button>
      </header>
      <main>
        <div className="page-title">
          <div>
            <span className="eyebrow">ОБЗОР СИСТЕМЫ</span>
            <h1>Мониторинг жилья</h1>
            <p>Источники, фильтры и доставка уведомлений.</p>
          </div>
          <div className="updated">
            Обновлено: {date(overview?.updatedAt ?? null)}
            <button className="secondary" onClick={refresh}>
              Обновить
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <section className="delivery">
          <h2>Telegram</h2>
          <p>
            {overview?.deliveryEnabled
              ? "Отправка уведомлений включена"
              : "Отправка уведомлений выключена на сервере"}
          </p>
          <div className="delivery-counts">
            {overview?.delivery.map((d) => (
              <div key={d.status}>
                <strong>{d.count}</strong>
                <span>{labels[d.status] ?? d.status}</span>
              </div>
            ))}
          </div>
        </section>
        <div className="sources">
          {overview?.sources.map((source) => (
            <SourcePanel
              key={source.module.id}
              source={source}
              onSaved={refresh}
            />
          ))}
        </div>
      </main>
      <footer>
        Housing Monitor NL · Время отображается в часовом поясе устройства
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
