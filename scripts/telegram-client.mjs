// Setup-only client. Never log API URLs, response bodies or transport errors:
// Telegram URLs contain the bot token; updates contain group conversations.
export class TelegramError extends Error {
  constructor(message, { code, retryAfter, uncertain = false } = {}) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
    this.uncertain = uncertain;
  }
}

export class TelegramClient {
  constructor(token, fetchImpl = globalThis.fetch) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token ?? '')) {
      throw new TelegramError('Set a valid TELEGRAM_BOT_TOKEN in secrets or .env.');
    }
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, parameters = {}) {
    let response;
    let body;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      body = await response.json();
    } catch {
      throw new TelegramError('Telegram request failed or timed out.', {
        uncertain: method === 'sendMessage',
      });
    }
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
      throw new TelegramError('Invalid Telegram response.', { uncertain: method === 'sendMessage' });
    }
    if (!response.ok || !body.ok) {
      const code = Number.isInteger(body.error_code) ? body.error_code : response.status;
      const messages = {
        400: 'Telegram rejected the request. Check the group ID and bot permissions.',
        401: 'Telegram token was rejected. Check TELEGRAM_BOT_TOKEN.',
        403: 'Telegram access denied. Add the bot to the group and allow sending messages.',
        409: 'Telegram updates are in use by a webhook or another polling process.',
        429: 'Telegram rate limit reached. Wait before trying again.',
      };
      throw new TelegramError(messages[code] ?? 'Telegram API request failed.', {
        code,
        retryAfter: Number.isInteger(body.parameters?.retry_after) ? body.parameters.retry_after : undefined,
        uncertain: method === 'sendMessage' && code >= 500,
      });
    }
    return body.result;
  }

  async verifyBot(expectedUsername) {
    const bot = await this.call('getMe');
    if (bot?.is_bot !== true || typeof bot.username !== 'string' ||
        bot.username.toLowerCase() !== expectedUsername.toLowerCase()) {
      throw new TelegramError('Token belongs to a different bot. Check TELEGRAM_BOT_USERNAME.');
    }
    return bot;
  }

  async discoverGroups() {
    const webhook = await this.call('getWebhookInfo');
    if (!webhook || typeof webhook.url !== 'string') throw new TelegramError('Invalid webhook response.');
    if (webhook.url) throw new TelegramError('A webhook is active. Use its received chat ID; discovery will not remove the webhook.');
    // No offset: do not acknowledge/discard updates. No allowed_updates:
    // do not change the subscription used by any future update consumer.
    const updates = await this.call('getUpdates', { timeout: 0, limit: 100 });
    if (!Array.isArray(updates)) throw new TelegramError('Invalid updates response.');
    return groupIdsFromUpdates(updates);
  }

  async sendTest(chatId) {
    if (!/^-[1-9]\d*$/.test(chatId ?? '')) throw new TelegramError('Set TELEGRAM_CHAT_ID to a negative numeric group ID.');
    const chat = await this.call('getChat', { chat_id: chatId });
    if (!['group', 'supergroup'].includes(chat?.type)) throw new TelegramError('Destination must be a group or supergroup.');
    // One request, no automatic retry: a timeout may hide a successful delivery.
    const message = await this.call('sendMessage', {
      chat_id: chatId,
      text: 'Housing Monitor NL: Telegram подключён. Здесь будут появляться новые предложения аренды. Мониторинг сайтов пока не запущен.',
      link_preview_options: { is_disabled: true },
    });
    if (!Number.isSafeInteger(message?.message_id)) {
      throw new TelegramError('Delivery response is invalid. Check the group before retrying.', { uncertain: true });
    }
    return message.message_id;
  }
}

export function groupIdsFromUpdates(updates) {
  const ids = new Set();
  for (const update of updates) {
    const chat = update?.message?.chat ?? update?.my_chat_member?.chat;
    if (['group', 'supergroup'].includes(chat?.type) && Number.isSafeInteger(chat.id) && chat.id < 0) {
      // A migrated basic group is no longer the correct destination.
      const id = update?.message?.migrate_to_chat_id ?? chat.id;
      if (Number.isSafeInteger(id) && id < 0) ids.add(String(id));
    }
  }
  const migratedIds = updates.flatMap((u) => [
    u?.message?.migrate_from_chat_id,
    u?.message?.migrate_to_chat_id ? u?.message?.chat?.id : undefined,
  ]).filter(Number.isSafeInteger);
  for (const id of migratedIds) ids.delete(String(id));
  return [...ids];
}
