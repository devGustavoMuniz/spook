import type { MessageKey } from "../../core";
import type { Message } from "../../types";
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

/** Tradução em inglês: precisa ter exatamente as mesmas chaves e placeholders de pt-BR (há teste). */
export const en: Record<MessageKey, Message> = {
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
};
