export class DeliveryError extends Error {
  constructor(readonly category: string, readonly uncertain: boolean, readonly retryable = false, readonly retryAfter = 0) {
    super(category);
  }
}
export class TelegramSender {
  constructor(private readonly token: string, private readonly transport: typeof fetch = fetch) {}
  async send(chatId: string, text: string): Promise<string> {
    let response: Response;
    let body: any;
    try {
      response = await this.transport(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      body = await response.json();
    } catch { throw new DeliveryError('TRANSPORT_UNCERTAIN', true); }
    if (body?.ok === true && response.ok && Number.isSafeInteger(body.result?.message_id)) return String(body.result.message_id);
    if (body?.ok !== false) throw new DeliveryError('INVALID_RESPONSE', true);
    const code = Number.isInteger(body.error_code) ? body.error_code : response.status;
    if (code >= 500) throw new DeliveryError('SERVER_UNCERTAIN', true);
    if (code === 429) throw new DeliveryError('RATE_LIMIT', false, true,
      Number.isSafeInteger(body.parameters?.retry_after) && body.parameters.retry_after > 0 ? Math.min(body.parameters.retry_after, 86400) : 60);
    throw new DeliveryError('API_REJECTED', false);
  }
}
