import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:/.test(v)),
  REDIS_URL: z.url().refine((v) => /^rediss?:/.test(v)),
  TELEGRAM_DELIVERY_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/).optional(),
  TELEGRAM_CHAT_ID: z.string().regex(/^-[1-9]\d*$/).optional(),
  TELEGRAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
}).superRefine((v, ctx) => {
  if (v.TELEGRAM_DELIVERY_ENABLED) for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const) {
    if (!v[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required for delivery' });
  }
});

export function parseEnvironment(input: Record<string, unknown>) {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    // Do not include input values: URLs may contain credentials.
    const keys = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${keys.join(', ')}`);
  }
  return result.data;
}
