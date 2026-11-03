import type { MessageMap } from "../../types";

export const format = {
  "format.pattern.time": "h:mm a",
  "format.pattern.dateShort": "MM/dd/yyyy",
  "format.pattern.day": "MMMM d, yyyy",
  "format.pattern.fullDate": "EEEE, MMMM d, yyyy 'at' h:mm a",
  "format.todayAt": "Today at {time}",
  "format.yesterdayAt": "Yesterday at {time}",
  "format.relative.now": "just now",
  "format.relative.minutes": "{count} min ago",
  "format.relative.hours": "{count} h ago",
  "format.relative.days": { one: "{count} day ago", other: "{count} days ago" },
} as const satisfies MessageMap;
