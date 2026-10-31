import { Permission, type PermissionName } from "@spook/shared";

export const PERMISSION_LABELS: { name: PermissionName; label: string; description: string }[] = [
  { name: "ADMINISTRATOR", label: "Administrador", description: "Todas as permissões." },
  { name: "MANAGE_GUILD", label: "Gerenciar servidor", description: "Nome, ícone e convites." },
  { name: "MANAGE_CHANNELS", label: "Gerenciar canais", description: "Criar, editar e excluir." },
  { name: "MANAGE_ROLES", label: "Gerenciar cargos", description: "Cargos abaixo do seu." },
  { name: "KICK_MEMBERS", label: "Expulsar membros", description: "Remover do servidor." },
  { name: "CREATE_INVITE", label: "Criar convites", description: "Gerar links de convite." },
  { name: "VIEW_CHANNEL", label: "Ver canais", description: "Ler as mensagens." },
  { name: "SEND_MESSAGES", label: "Enviar mensagens", description: "Escrever nos canais." },
  { name: "MANAGE_MESSAGES", label: "Gerenciar mensagens", description: "Excluir de outros." },
  { name: "ATTACH_FILES", label: "Anexar arquivos", description: "Disponível numa fase futura." },
  { name: "CONNECT", label: "Conectar à voz", description: "Disponível numa fase futura." },
  { name: "SPEAK", label: "Falar", description: "Disponível numa fase futura." },
  { name: "VIDEO", label: "Vídeo", description: "Disponível numa fase futura." },
];

export const flagOf = (name: PermissionName) => Permission[name];
