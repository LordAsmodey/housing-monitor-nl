import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:/.test(v)),
  REDIS_URL: z.url().refine((v) => /^rediss?:/.test(v)),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
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
