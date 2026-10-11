import { TelegramClient, TelegramError } from './telegram-client.mjs';

async function main() {
  const command = process.argv[2];
  if (!['check', 'chats', 'test'].includes(command)) {
    throw new TelegramError('Usage: npm run telegram:check | telegram:chats | telegram:test');
  }
  const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
  const username = process.env.TELEGRAM_BOT_USERNAME ?? 'Housing_Monitor_NL_bot';
  await client.verifyBot(username);
  if (command === 'check') {
    console.log(`Verified bot @${username}. No message sent.`);
  } else if (command === 'chats') {
    const ids = await client.discoverGroups();
    if (!ids.length) {
      console.log(`No groups found. Add @${username} to the group, send /start@${username} there, then run this command again.`);
    } else {
      console.log('Group IDs (select your destination; no automatic selection):');
      for (const id of ids) console.log(`TELEGRAM_CHAT_ID=${id}`);
    }
  } else {
    const id = await client.sendTest(process.env.TELEGRAM_CHAT_ID);
    console.log(`Test message sent. Message ID: ${id}`);
  }
}

main().catch((error) => {
  console.error(error instanceof TelegramError ? error.message : 'Telegram setup failed.');
  if (error instanceof TelegramError && error.uncertain) {
    console.error('Delivery is uncertain. Check the group before repeating the test.');
  }
  process.exitCode = 1;
});
