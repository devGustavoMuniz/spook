// Último servidor/canal visitado, por navegador (conveniência; nunca é fonte de verdade).
const GUILD = "spook:last-guild";
const channelKey = (guildId: string) => `spook:last-channel:${guildId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // armazenamento indisponível: segue sem lembrar
  }
}

export const lastLocation = {
  guild: () => read(GUILD),
  channel: (guildId: string) => read(channelKey(guildId)),
  remember(guildId: string, channelId?: string) {
    write(GUILD, guildId);
    if (channelId) write(channelKey(guildId), channelId);
  },
};
