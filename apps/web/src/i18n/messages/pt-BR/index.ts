import { auth } from "./auth";
import { chat } from "./chat";
import { common } from "./common";
import { crop } from "./crop";
import { feedback } from "./feedback";
import { format } from "./format";
import { guilds } from "./guilds";
import { nitro } from "./nitro";
import { people } from "./people";
import { settings } from "./settings";
import { shell } from "./shell";
import { system } from "./system";
import { voice } from "./voice";

/** Idioma-fonte: toda chave nasce aqui. O tipo `MessageKey` deriva deste objeto. */
export const ptBR = {
  ...common,
  ...crop,
  ...format,
  ...auth,
  ...shell,
  ...chat,
  ...people,
  ...guilds,
  ...voice,
  ...settings,
  ...feedback,
  ...nitro,
  ...system,
} as const;
