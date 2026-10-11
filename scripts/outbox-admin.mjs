// Operational CLI: never print destinations, payloads, URLs or raw errors.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  const [command, id, value] = process.argv.slice(2);
  if (command === 'list') {
    const rows = await db.notificationOutbox.findMany({
      where: { status: { in: ['UNCERTAIN', 'DEAD_LETTER'] } },
      select: { id: true, status: true, attempts: true, lastErrorCategory: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === 'sent' && id && /^[1-9]\d*$/.test(value ?? '')) {
    const r = await db.notificationOutbox.updateMany({ where: { id, status: 'UNCERTAIN' },
      data: { status: 'SENT', telegramMessageId: value, sentAt: new Date(), lastErrorCategory: null } });
    console.log(`Resolved rows: ${r.count}`);
  } else if (command === 'retry' && id && value === '--accept-duplicate-risk') {
    const r = await db.notificationOutbox.updateMany({ where: { id, status: { in: ['UNCERTAIN', 'DEAD_LETTER'] } },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastErrorCategory: null, lockToken: null, lockedUntil: null } });
    console.log(`Queued rows: ${r.count}`);
  } else throw new Error('usage');
} catch {
  console.error('Outbox command failed. Use list | sent <id> <messageId> | retry <id> --accept-duplicate-risk.');
  process.exitCode = 1;
} finally { await db.$disconnect(); }
