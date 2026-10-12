import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:/.test(v)),
  REDIS_URL: z.url().refine((v) => /^rediss?:/.test(v)),
  TELEGRAM_DELIVERY_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/).optional(),
  TELEGRAM_CHAT_ID: z.string().regex(/^-[1-9]\d*$/),
  TELEGRAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  FUNDA_BROWSER_ORIGIN: z.url().optional(),
  FUNDA_BROWSER_TOKEN: z.string().min(32).optional(),
  HUURWONINGEN_BROWSER_ORIGIN: z.url().optional(),
  HUURWONINGEN_BROWSER_TOKEN: z.string().min(32).optional(),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
  VESTEDA_MONITORING_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
}).superRefine((v, ctx) => {
  if (Boolean(v.FUNDA_BROWSER_ORIGIN) !== Boolean(v.FUNDA_BROWSER_TOKEN)) ctx.addIssue({code:'custom',path:['FUNDA_BROWSER_ORIGIN'],message:'Browser origin and token must be configured together'});
  if (Boolean(v.HUURWONINGEN_BROWSER_ORIGIN) !== Boolean(v.HUURWONINGEN_BROWSER_TOKEN)) ctx.addIssue({code:'custom',path:['HUURWONINGEN_BROWSER_ORIGIN'],message:'Browser origin and token must be configured together'});
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

