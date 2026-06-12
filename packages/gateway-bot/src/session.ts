export function buildSessionKey(
  platform: 'telegram' | 'discord' | 'email' | 'slack' | 'webhook',
  chatId: string,
): string {
  return `${platform}::${chatId}`;
}
