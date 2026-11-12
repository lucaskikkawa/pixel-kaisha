# Ferramenta padrão por personagem (Pixel Kaisha F2.6 → B2.4)

Aditivo ao protocolo WebSocket existente (`/ws`, ver `core/asyncapi.yaml`). Um servidor antigo ignora a mensagem nova (o `default:` de `server/src/clientMessageHandler.ts` não faz nada) e continua salvando o campo novo do perfil, porque `CharacterProfile` é aberto (`additionalProperties: true`) e o servidor persiste a lista como recebe.

Ferramentas: `"claude" | "codex" | "agy"` — os mesmos ids de `providerId` dos selos (`webview-ui/src/cloud/engineBadge.ts`, ver `protocol-cloud.md`).

## O campo no perfil: `defaultTool`

```json
{ "id": "c-ab12cd", "name": "Bob", "body": "flat", "v": 35, "defaultTool": "codex" }
```

- Opcional. **Ausente = `claude`.** Valor desconhecido (`"gpt"`, `42`, `null`…) também = `claude`; não invalida o perfil nem a lista.
- Por personagem (perfil), não global. Viaja nas mensagens que já carregam perfis:
  - cliente → servidor: `saveCharacterProfiles.profiles[i].defaultTool`
  - servidor → cliente: `characterProfilesLoaded.profiles[i].defaultTool` (snapshot no `webviewReady` e eco de cada save)
- Tipo: `core/src/characterProfiles.ts` (`CharacterProfile.defaultTool?: string`). Leitura/validação no cliente: `webview-ui/src/characters/defaultTool.ts` (`defaultToolOf`, `setDefaultTool`).

## Cliente → servidor: `setCharacterDefaultTool`

```json
{
  "type": "setCharacterDefaultTool",
  "profileId": "c-ab12cd",
  "providerId": "codex"
}
```

- `profileId`: o `id` permanente do perfil (`CharacterProfile.id`), não o índice.
- `providerId`: `"claude" | "codex" | "agy"`.
- Enviada **depois** do `saveCharacterProfiles` do mesmo Save, uma por personagem cuja ferramenta mudou em relação à última lista que o servidor mandou (ou ao último save deste cliente). Personagem novo só gera mensagem se não for `claude`. Voltar para `claude` também é enviado.

## Servidor → cliente (proposta para o B2.4): `characterDefaultToolUpdated`

Opcional. Se o B2.4 quiser confirmar explicitamente:

```json
{ "type": "characterDefaultToolUpdated", "profileId": "c-ab12cd", "providerId": "codex" }
```

A UI de hoje **não precisa** dela: o eco do `characterProfilesLoaded` (com `defaultTool` no perfil) já basta e é o que a UI usa. Se for enviada, a UI atual ignora (tipo desconhecido).

## O que a UI faz hoje

1. Configuração visual de personagem (`CharactersView`): cada cartão do roster (desktop) tem um seletor Claude / Codex / agy (`ui/ToolPicker.tsx`, borda na cor do selo); no celular fica no painel **More**, abaixo do nome, como três botões.
2. A escolha é uma edição do rascunho como qualquer outra (desfazer/refazer, "unsaved changes"). Nada vai ao servidor até **Save**.
3. No Save, `castStore.ts`:
   - envia `saveCharacterProfiles` (com `defaultTool` nos perfis) — **é isto que persiste hoje**, em `~/.pixel-agents/characters.json`;
   - em seguida `defaultToolSync.saved(profiles)` envia um `setCharacterDefaultTool` por personagem alterado. **Ponto de integração:** `webview-ui/src/characters/castStore.ts` (`defaultToolSync`, via `transport.send`) e `webview-ui/src/characters/defaultTool.ts` (`createDefaultToolSync`, `defaultToolChanges`).
4. Ao receber `characterProfilesLoaded`, `castMessages.ts` chama `defaultToolSync.loaded(profiles)`: essa lista vira a base do próximo diff.
5. Reconexão: a UI reenvia `saveCharacterProfiles` não respondidos (`resendInFlight`), e o perfil já carrega `defaultTool`. A mensagem `setCharacterDefaultTool` não é reenviada; o B2.4 deve tratar o campo do perfil como a verdade.

## O que o B2.4 precisa implementar

1. **Registrar** `setCharacterDefaultTool` em `core/asyncapi.yaml` (ClientMessage) e `defaultTool` em `CharacterProfile` (string, enum `claude|codex|agy`, opcional), e rodar `npm run asyncapi:generate`. Esta PR **não** mexe no asyncapi; a UI envia com um cast (`asClientMessage` em `defaultTool.ts`) que pode sair depois.
2. **Persistir** no `characterProfilesStore` / `characterProfilesPersistence`: ao receber `setCharacterDefaultTool`, gravar `defaultTool` no perfil com aquele `id` (ignorar id desconhecido ou `providerId` inválido) e transmitir `characterProfilesLoaded` (sem `saveId`, como mudança externa) — ou `characterDefaultToolUpdated`. Lembrar do gate `refuseReadOnly` (mensagem privilegiada por padrão).
3. **Honrar** a ferramenta ao lançar: quando um `launchAgent` usa um personagem (pick do roster, default da Directory ou palette sorteada), lançar com o provider de `defaultTool` daquele perfil (ausente = Claude) e anunciar com `agentCreated.providerId`, para o selo bater.
4. **Ecoar no snapshot**: `characterProfilesLoaded` no `webviewReady` com `defaultTool` em cada perfil (já acontece se ele foi salvo pelo caminho normal).
5. Perfis sem o campo = `claude`. Nunca rejeitar a lista inteira por um `defaultTool` inválido.
