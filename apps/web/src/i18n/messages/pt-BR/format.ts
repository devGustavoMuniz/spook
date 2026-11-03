import type { MessageMap } from "../../types";

export const format = {
  "format.pattern.time": "HH:mm",
  "format.pattern.dateShort": "dd/MM/yyyy",
  "format.pattern.day": "d 'de' MMMM 'de' yyyy",
  "format.pattern.fullDate": "EEEE, d 'de' MMMM 'de' yyyy 'às' HH:mm",
  "format.todayAt": "Hoje às {time}",
  "format.yesterdayAt": "Ontem às {time}",
  "format.relative.now": "agora",
  "format.relative.minutes": "há {count} min",
  "format.relative.hours": "há {count} h",
  "format.relative.days": { one: "há {count} dia", other: "há {count} dias" },
} as const satisfies MessageMap;
