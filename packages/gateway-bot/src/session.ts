export function buildSessionKey(platform: 'telegram' | 'discord', chatId: string): string {
  return `${platform}::${chatId}`;
}
