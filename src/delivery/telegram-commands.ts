import { AdminService } from '../admin/admin.service';
import { z } from 'zod';

const messageSchema = z.object({
  date: z.number().int(),
  text: z.string(),
  chat: z.object({ id: z.number().safe(), type: z.enum(['group', 'supergroup']) }),
  entities: z.array(z.object({ type: z.string(), offset: z.number(), length: z.number() })),
});

export function isListCommand(update: unknown, chatId: string, username: string, now = Date.now()): boolean {
  const parsed = z.object({ message: messageSchema }).safeParse(update);
  if (!parsed.success) return false;
  const m = parsed.data.message;
  if (String(m.chat.id) !== chatId || m.date * 1000 < now - 300_000 || m.date * 1000 > now + 30_000) return false;
  const command = m.text.trimEnd();
  if (command !== '/list' && command.toLowerCase() !== `/list@${username.toLowerCase()}`) return false;
  return m.entities.some(e => e.type === 'bot_command' && e.offset === 0 && e.length === command.length);
}

export function formatSourceList(overview: Awaited<ReturnType<AdminService['overview']>>): string[] {
  const lines = overview.sources.map(source => {
    const h = source.health;
    const status = !source.runtimeEnabled ? '⏸ Отключён в конфигурации' :
      !source.runtimeAvailable ? '⚪ Не настроено подключение' :
      !source.settings.enabled ? '⏸ Приостановлен' :
      !source.ready || !h || h.status === 'DISABLED' ? '⚪ Ожидает запуска' :
      h.status === 'BLOCKED' ? '🔴 Заблокирован' :
      h.running ? '🔄 Проверяется' :
      h.status === 'DEGRADED' ? '🟡 Требует внимания' :
      !h.lastSuccessAt ? '⚪ Ещё нет успешных проверок' : '🟢 Работает';
    const date = h?.lastSuccessAt ? new Date(h.lastSuccessAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'ещё не было';
    return `${source.module.name} — ${status}\nПоследний успех: ${date}`;
  });
  const chunks = [`Источники объявлений: ${lines.length}\nСтатус по данным мониторинга.`];
  for (const line of lines.length ? lines : ['Подключённых источников пока нет.']) {
    const i = chunks.length - 1;
    if (chunks[i]!.length + line.length + 2 > 3900) chunks.push(line);
    else chunks[i] += '\n\n' + line;
  }
  return chunks;
}

export class TelegramPollingError extends Error {
  constructor(readonly retryAfter = 10) { super('Telegram command polling failed'); }
}

export class TelegramUpdatesClient {
  constructor(private readonly token: string, private readonly transport: typeof fetch = fetch) {}
  async call(method: 'getMe' | 'getUpdates', parameters: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const response = await this.transport(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parameters), signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      const body = await response.json();
      if (response.ok && body?.ok === true) return body.result;
      const retry = body?.parameters?.retry_after;
      throw new TelegramPollingError(Number.isSafeInteger(retry) && retry > 0 ? Math.min(retry, 86400) : 10);
    } catch (error) {
      if (error instanceof TelegramPollingError) throw error;
      // Transport errors can contain the bot token. Never retain them as causes.
      throw new TelegramPollingError();
    }
  }
}

export const botSchema = z.object({ id: z.number().safe(), is_bot: z.literal(true), username: z.string().min(1) });
export const updatesSchema = z.array(z.object({ update_id: z.number().int().nonnegative().max(2147483646) }).passthrough());
