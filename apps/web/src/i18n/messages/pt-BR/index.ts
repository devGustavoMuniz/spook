import { auth } from "./auth";
import { chat } from "./chat";
import { common } from "./common";
import { format } from "./format";
import { guilds } from "./guilds";
import { people } from "./people";
import { settings } from "./settings";
import { shell } from "./shell";
import { system } from "./system";
import { voice } from "./voice";

/** Idioma-fonte: toda chave nasce aqui. O tipo `MessageKey` deriva deste objeto. */
export const ptBR = {
  ...common,
  ...format,
  ...auth,
  ...shell,
  ...chat,
  ...people,
  ...guilds,
  ...voice,
  ...settings,
  ...system,
} as const;
