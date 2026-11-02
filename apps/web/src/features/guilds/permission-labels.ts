import { Permission, type PermissionName } from "@spook/shared";

export type PermissionInfo = { name: PermissionName; label: string; description: string };
export type PermissionGroup = { id: string; title: string; items: PermissionInfo[] };

/** Permissões agrupadas para a tela de cargos (as flags são as do SPEC 7; só muda a apresentação). */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "general",
    title: "Geral",
    items: [
      { name: "ADMINISTRATOR", label: "Administrador", description: "Todas as permissões." },
      { name: "VIEW_CHANNEL", label: "Ver canais", description: "Ler as mensagens." },
      { name: "MANAGE_GUILD", label: "Gerenciar servidor", description: "Nome, ícone e convites." },
      {
        name: "MANAGE_CHANNELS",
        label: "Gerenciar canais",
        description: "Criar, editar e excluir.",
      },
      { name: "MANAGE_ROLES", label: "Gerenciar cargos", description: "Cargos abaixo do seu." },
      { name: "CREATE_INVITE", label: "Criar convites", description: "Gerar links de convite." },
    ],
  },
  {
    id: "text",
    title: "Texto",
    items: [
      { name: "SEND_MESSAGES", label: "Enviar mensagens", description: "Escrever nos canais." },
      { name: "ATTACH_FILES", label: "Anexar arquivos", description: "Enviar imagens e arquivos." },
    ],
  },
  {
    id: "voice",
    title: "Voz",
    items: [
      { name: "CONNECT", label: "Conectar à voz", description: "Entrar nos canais de voz." },
      { name: "SPEAK", label: "Falar", description: "Usar o microfone na chamada." },
      { name: "VIDEO", label: "Vídeo", description: "Ligar a câmera e compartilhar a tela." },
    ],
  },
  {
    id: "moderation",
    title: "Moderação",
    items: [
      { name: "KICK_MEMBERS", label: "Expulsar membros", description: "Remover do servidor." },
      {
        name: "MANAGE_MESSAGES",
        label: "Gerenciar mensagens",
        description: "Excluir as de outros.",
      },
    ],
  },
];

export const PERMISSION_LABELS: PermissionInfo[] = PERMISSION_GROUPS.flatMap((g) => g.items);

export const flagOf = (name: PermissionName) => Permission[name];
