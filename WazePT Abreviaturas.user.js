// ==UserScript==
// @name         WazePT Abreviaturas
// @namespace    https://greasyfork.org/en/users/1559074-xtryker
// @version      17.0.2
// @description  Script para o Waze Map Editor que automatiza a normalização de endereços de rua em Portugal, seguindo as convenções de abreviaturas do Wazeopedia PT. As regras (abreviaturas, correções, erros ortográficos, lista branca…) e a lista de editores autorizados vivem numa base de dados Firebase, geridas pelos administradores no painel de administração.
// @author       Xtryker
// @copyright    Xtryker 2026
// @match        https://www.waze.com/editor*
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/editor*
// @match        https://beta.waze.com/*/editor*
// @icon         https://i.imgur.com/UksVMzF.png
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      wazept-abreviaturas-default-rtdb.europe-west1.firebasedatabase.app
// @connect      firebasedatabase.app
// @connect      github.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @license      All Rights Reserved; sem permissão para copiar, redistribuir ou modificar sem autorização escrita do autor
// @updateURL    https://github.com/Xtryker/WazePT-Abreviaturas/raw/refs/heads/main/WazePT%20Abreviaturas.user.js
// @downloadURL  https://github.com/Xtryker/WazePT-Abreviaturas/raw/refs/heads/main/WazePT%20Abreviaturas.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_ID = 'wme-endereco-sem-abreviaturas'; // id interno — mantido estável para não perder as preferências guardadas
  const SCRIPT_NAME = 'WazePT Abreviaturas';

  // Lida da linha // @version do cabeçalho (GM_info), para que basta mudar o
  // cabeçalho; o literal é só um recurso para gestores sem GM_info.
  const SCRIPT_VERSION = (() => {
    try {
      const v = typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version;
      if (v && /^\d+(\.\d+)*$/.test(String(v).trim())) return String(v).trim();
    } catch (e) { /* ignora */ }
    return '17.0.2';
  })();

  // Logs detalhados desligados por omissão. Para ligar em depuração:
  //   window.wazePTAbreviaturasDebug(true)
  let DEBUG = false;
  const LOG = (...args) => { if (DEBUG) console.log(`[${SCRIPT_NAME}]`, ...args); };
  const LOGE = (...args) => console.error(`[${SCRIPT_NAME}]`, ...args);
  try {
    (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).wazePTAbreviaturasDebug = (v) => { DEBUG = !!v; return DEBUG; };
  } catch (e) { /* ambiente sem window (testes) */ }

  // unsafeWindow dá acesso directo ao window da página (onde o WME expõe
  // getWmeSdk e W.loginManager) mesmo com GM_xmlhttpRequest concedido.
  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* ------------------------------------------------------------------ *
   *  Pedidos de rede (GM_xmlhttpRequest)
   *
   *  O CSP da página do Waze não permite fetch()/XHR para o Firebase nem
   *  para o GitHub, por isso tudo passa pelo gestor de userscripts, com uma
   *  API com a forma de fetch().
   * ------------------------------------------------------------------ */
  const GM_FETCH_TIMEOUT_MS = 20000;

  function gmFetch(url, { method = 'GET', headers = {}, body = null, timeout = GM_FETCH_TIMEOUT_MS, anonymous = false } = {}) {
    const GM_XHR = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest)
      || (typeof GM !== 'undefined' && GM?.xmlHttpRequest)
      || null;

    if (!GM_XHR) {
      return Promise.reject(new Error('GM_xmlhttpRequest indisponível — verifica a lista de @grant do userscript'));
    }

    return new Promise((resolve, reject) => {
      GM_XHR({
        method,
        url,
        headers,
        data: body,
        timeout,
        ...(anonymous ? { anonymous: true } : {}),
        onload: (res) => {
          const status = res.status;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            url,
            header: (nome) => {
              const procurado = String(nome || '').toLowerCase();
              for (const linha of String(res.responseHeaders || '').split(/\r?\n/)) {
                const i = linha.indexOf(':');
                if (i > 0 && linha.slice(0, i).trim().toLowerCase() === procurado) return linha.slice(i + 1).trim();
              }
              return null;
            },
            text: async () => res.responseText,
            // Lança com um corpo ilegível: o Firebase responde o literal
            // `null` para um nó vazio, e um 200 truncado não pode passar por
            // "base de dados vazia".
            json: async () => JSON.parse(res.responseText),
          });
        },
        onerror: (err) => reject(new Error(`Erro de rede ao contactar ${url}: ${err?.error || err?.statusText || 'desconhecido'}`)),
        ontimeout: () => reject(new Error(`Tempo esgotado ao contactar ${url}`)),
        onabort: () => reject(new Error(`Pedido cancelado: ${url}`)),
      });
    });
  }

  /* ------------------------------------------------------------------ *
   *  Base de dados Firebase (Realtime Database, API REST)
   *
   *  Estrutura:
   *    users/<chave>  { name, enabled, isNew, perms: { destaques, admin },
   *                     addedBy, addedAt }
   *    config         { meta: { rev, updatedAt, updatedBy }, dataJson }
   *
   *  `dataJson` é o JSON (em texto) de TODAS as regras e definições do
   *  script: abreviaturas, correcções, erros ortográficos, lista branca,
   *  partículas, tipos de segmento… Guardado como texto (e não como
   *  árvore do Firebase) porque a ordem das listas importa e o Firebase
   *  não guarda listas vazias nem aceita certos caracteres nas chaves.
   *
   *  Modelo de confiança: igual ao WazePT Tools — a identidade é o nome de
   *  utilizador do WME, sem início de sessão no Firebase. As escritas são
   *  controladas por este script (só administradores); as regras do
   *  Firebase (wazept-abreviaturas.rules.json) só validam a forma dos dados.
   * ------------------------------------------------------------------ */
  const FIREBASE_DB_URL = 'https://wazept-abreviaturas-default-rtdb.europe-west1.firebasedatabase.app';

  function firebaseUrl(caminho) {
    return `${FIREBASE_DB_URL}/${caminho}.json`;
  }

  function pedidoFirebase(caminho, { method = 'GET', body, headers = {} } = {}) {
    const temCorpo = body !== undefined;
    return gmFetch(firebaseUrl(caminho), {
      method,
      headers: { ...(temCorpo ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(temCorpo ? { body: JSON.stringify(body) } : {}),
    });
  }

  // Leituras/escritas de localStorage protegidas (navegação privada, quota…).
  function lerJSONLocal(chave, omissao) {
    try {
      const v = JSON.parse(localStorage.getItem(chave) || 'null');
      return v === null ? omissao : v;
    } catch (e) { return omissao; }
  }
  function gravarJSONLocal(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); return true; } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ *
   *  Controlo de acesso — editores autorizados (Firebase `users/`)
   *
   *  Cada editor com registo tem três permissões, geridas no painel de
   *  administração:
   *    • Script    (enabled)        — pode usar o script. Sem isto, o
   *      editor vê só a caixa de mensagens informativa do painel de edição
   *      (o que corrigir / que alternativo criar), sem botões nem destaques.
   *    • Destaques (perms.destaques) — painel flutuante dos toggles e
   *      destaques de segmentos no mapa. Sem isto, o editor continua a ter
   *      os botões "Corrigir/Abreviar" e "Alternativo" e as sugestões no
   *      painel de edição.
   *    • Admin     (perms.admin)     — vê o painel de administração: gere
   *      editores (incluindo outros administradores) e as regras.
   *
   *  O DONO (ACCESS_OWNER_NAME) está fixo no código: tem sempre tudo e
   *  nunca depende da rede — ninguém o pode trancar fora editando a base.
   *
   *  Um editor sem registo regista-se a si próprio (tudo desligado, com a
   *  etiqueta "Novo"), para aparecer aos administradores, que decidem.
   * ------------------------------------------------------------------ */
  const ACCESS_OWNER_NAME = 'Xtryker';
  const ACCESS_PERM_IDS = ['destaques', 'admin'];
  // Com o que começa um editor acrescentado por um administrador.
  const ACCESS_PERMS_NOVO = { destaques: true, admin: false };

  function accessIsOwnerName(nome) {
    return String(nome || '').trim().toLowerCase() === ACCESS_OWNER_NAME.toLowerCase();
  }

  // Chave Firebase de um nome de editor: minúsculas, sem espaços nas pontas
  // e os caracteres proibidos nas chaves do Firebase escapados com "%".
  // Mesmo esquema do WazePT Tools.
  function accessEditorKey(nome) {
    const n = String(nome || '').trim().toLowerCase();
    if (!n) return null;
    return n.replace(/[.$#[\]/\u0000-\u001f\u007f%]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  // Registo não confiável → exactamente os booleanos conhecidos. Tudo o que
  // não for literalmente `true` é false: um campo em falta nunca concede nada.
  function normalizarPerms(raw) {
    const out = {};
    for (const id of ACCESS_PERM_IDS) out[id] = !!raw && typeof raw === 'object' && raw[id] === true;
    return out;
  }

  function permsDono() {
    const out = {};
    for (const id of ACCESS_PERM_IDS) out[id] = true;
    return out;
  }

  function limparNomeAcesso(raw) {
    const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    return s.length >= 1 && s.length <= 64 ? s : '';
  }

  function accessUsersToList(data) {
    if (!data || typeof data !== 'object') return [];
    const out = [];
    for (const key of Object.keys(data)) {
      const v = data[key];
      if (!v || typeof v !== 'object') continue;
      const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : key;
      out.push({
        key,
        name,
        enabled: v.enabled !== false,
        isNew: v.isNew === true,
        perms: normalizarPerms(v.perms),
        addedBy: typeof v.addedBy === 'string' ? v.addedBy : '',
        addedAt: Number.isFinite(v.addedAt) ? v.addedAt : 0,
      });
    }
    // Pedidos novos (à espera de aprovação) primeiro.
    out.sort((a, b) => (b.isNew - a.isNew) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out;
  }

  // sdk.State.getUserInfo() devolve { userName, rank, ... } ou null se o
  // editor não estiver autenticado. Cai para W.loginManager.user em builds
  // mais antigas do WME.
  function obterNomeEditor() {
    try {
      const info = sdk?.State?.getUserInfo?.();
      if (info && typeof info.userName === 'string' && info.userName.trim()) {
        return info.userName.trim();
      }
    } catch (e) { /* ignora */ }
    try {
      const legado = UW?.W?.loginManager?.user;
      const nome = legado?.userName || legado?.username || legado?.name;
      if (typeof nome === 'string' && nome.trim()) return nome.trim();
    } catch (e) { /* ignora */ }
    return null;
  }

  const ALLOWLIST_CACHE_KEY = `${SCRIPT_ID}:acesso:v2`;
  try { localStorage.removeItem(`${SCRIPT_ID}:allowlist:v1`); } catch (e) { /* ignora */ }
  // Uma resposta em cache é confiada durante 1 h antes de voltar a
  // perguntar à base de dados (igual ao WazePT Tools/Segments/Landmark).
  const ALLOWLIST_TTL_MS = 60 * 60 * 1000;
  // Sem rede, um "sim" já confirmado continua válido durante 7 dias. Um
  // "não" nunca é prolongado: falhar a ligação nunca concede acesso.
  const ALLOWLIST_GRACE_MS = 7 * 24 * 3600 * 1000;

  function carregarAllowlistCache() {
    const v = lerJSONLocal(ALLOWLIST_CACHE_KEY, null);
    if (v && typeof v.username === 'string' && typeof v.allowed === 'boolean' && Number.isFinite(v.checkedAt)) {
      return { ...v, perms: normalizarPerms(v.perms) };
    }
    return null;
  }

  async function obterRegistoAcesso(username) {
    const key = accessEditorKey(username);
    if (!key) throw new Error('acesso: nome vazio');
    const res = await pedidoFirebase(`users/${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error(`acesso: HTTP ${res.status}`);
    const data = await res.json();
    if (data === null || data === undefined) return { found: false, enabled: false, perms: normalizarPerms(null) };
    if (typeof data !== 'object') throw new Error('acesso: registo inesperado');
    return { found: true, enabled: data.enabled !== false, perms: normalizarPerms(data.perms) };
  }

  // Editores que este navegador já registou uma vez. Um editor que um
  // administrador REMOVEU não deve voltar a aparecer como "novo".
  const ACCESS_SELF_REG_KEY = `${SCRIPT_ID}:acessoAutoRegisto:v1`;

  async function registarPedidoAcesso(username) {
    const name = limparNomeAcesso(username);
    const key = accessEditorKey(username);
    if (!name || !key || accessIsOwnerName(name)) return false;
    const jaRegistados = new Set(lerJSONLocal(ACCESS_SELF_REG_KEY, []));
    if (jaRegistados.has(key)) return false;
    try {
      const res = await pedidoFirebase(`users/${encodeURIComponent(key)}`, {
        method: 'PUT',
        // Escrita condicional: só se o nó AINDA estiver vazio — nunca
        // sobrepõe um registo que um administrador criou entretanto (412).
        headers: { 'if-match': 'null_etag' },
        body: {
          name,
          enabled: false,
          isNew: true,
          perms: normalizarPerms(null),
          addedBy: name,
          addedAt: { '.sv': 'timestamp' },
        },
      });
      if (res.ok || res.status === 412) {
        jaRegistados.add(key);
        gravarJSONLocal(ACCESS_SELF_REG_KEY, [...jaRegistados].slice(-50));
      }
      return res.ok;
    } catch (erro) {
      LOG('acesso: auto-registo falhou', erro);
      return false;
    }
  }

  // Estado de autorização legível de forma síncrona. Começa fechado e fica
  // assim até refreshAllowlistState() resolver para o editor actual.
  let allowlistState = { checked: false, allowed: false, perms: normalizarPerms(null), origem: null };

  function editorAutorizado() {
    return allowlistState.checked && allowlistState.allowed === true;
  }
  function podeUsarDestaques() {
    return editorAutorizado() && allowlistState.perms.destaques === true;
  }
  function ehAdmin() {
    return editorAutorizado() && allowlistState.perms.admin === true;
  }
  function assinaturaAcesso() {
    return `${allowlistState.checked}|${allowlistState.allowed}|${ACCESS_PERM_IDS.map((id) => allowlistState.perms[id]).join(',')}`;
  }

  let allowlistRefreshEmCurso = null;

  // Verifica (ou reutiliza uma resposta em cache suficientemente recente)
  // o registo do editor ACTUAL. Seguro chamar repetidamente.
  async function refreshAllowlistState({ forcar = false } = {}) {
    const username = obterNomeEditor();
    if (!username) {
      allowlistState = { checked: false, allowed: false, perms: normalizarPerms(null), origem: null };
      return 'sem-utilizador';
    }

    if (accessIsOwnerName(username)) {
      allowlistState = { checked: true, allowed: true, perms: permsDono(), origem: 'dono' };
      return 'dono';
    }

    const cache = carregarAllowlistCache();
    const cacheCorresponde = !!cache && cache.username.toLowerCase() === username.toLowerCase()
      && cache.checkedAt <= Date.now();
    if (!forcar && cacheCorresponde && (Date.now() - cache.checkedAt) < ALLOWLIST_TTL_MS) {
      allowlistState = { checked: true, allowed: cache.allowed, perms: cache.allowed ? cache.perms : normalizarPerms(null), origem: 'cache' };
      return 'cache';
    }

    if (allowlistRefreshEmCurso) return allowlistRefreshEmCurso;

    allowlistRefreshEmCurso = (async () => {
      try {
        const reg = await obterRegistoAcesso(username);
        const allowed = reg.found && reg.enabled;
        if (!reg.found) await registarPedidoAcesso(username);
        gravarJSONLocal(ALLOWLIST_CACHE_KEY, { username, allowed, perms: reg.perms, checkedAt: Date.now() });
        allowlistState = { checked: true, allowed, perms: allowed ? reg.perms : normalizarPerms(null), origem: 'firebase', registado: reg.found };
        LOG(`acesso: ${username} -> ${allowed ? 'autorizado' : 'não autorizado'}`);
        return 'ok';
      } catch (erro) {
        LOG('acesso: falha ao contactar a base de dados', erro);
        if (cacheCorresponde && cache.allowed && (Date.now() - cache.checkedAt) < ALLOWLIST_GRACE_MS) {
          allowlistState = { checked: true, allowed: true, perms: cache.perms, origem: 'cache-graca' };
        } else if (cacheCorresponde && !cache.allowed) {
          allowlistState = { checked: true, allowed: false, perms: normalizarPerms(null), origem: 'cache' };
        } else {
          allowlistState = { checked: true, allowed: false, perms: normalizarPerms(null), origem: 'falha' };
        }
        return 'falha';
      } finally {
        allowlistRefreshEmCurso = null;
      }
    })();
    return allowlistRefreshEmCurso;
  }

  /* ------------------------------------------------------------------ *
   *  Regras e definições (Firebase `config/`) com cache local de 24 h
   *
   *  Na primeira execução (ou quando a cache passou das 24 h) o script lê
   *  primeiro só `config/meta/rev` (poucos bytes): se a revisão for a
   *  mesma da cache, renova-a sem voltar a descarregar as regras. Se for
   *  diferente, descarrega o `config` inteiro.
   *
   *  Sem rede, usa a cache antiga, mesmo passadas as 24 h — regras de ontem
   *  são sempre melhores do que nenhumas. Sem cache nem rede, o script fica
   *  sem regras e avisa no painel de edição, sem sugerir nada.
   * ------------------------------------------------------------------ */
  const DADOS_CACHE_KEY = `${SCRIPT_ID}:dados:v1`;
  const DADOS_TTL_MS = 24 * 3600 * 1000;
  // Sem regras nenhumas, volta a tentar com esta frequência mínima.
  const DADOS_RETRY_MS = 5 * 60 * 1000;

  // { rev, updatedAt, updatedBy, fetchedAt, origem, erro }
  let dadosEstado = { rev: 0, updatedAt: 0, updatedBy: '', fetchedAt: 0, origem: null, erro: '' };
  let dadosAtivos = null;
  let dadosRefreshEmCurso = null;
  let dadosUltimaFalha = 0;

  function carregarCacheDados() {
    const v = lerJSONLocal(DADOS_CACHE_KEY, null);
    if (!v || typeof v !== 'object' || !v.data || !Number.isFinite(v.fetchedAt)) return null;
    const data = normalizarDados(v.data);
    if (!data) return null;
    return { ...v, data };
  }

  function gravarCacheDados(entrada) {
    if (!gravarJSONLocal(DADOS_CACHE_KEY, entrada)) LOGE('Não foi possível guardar as regras em cache (localStorage cheio?).');
  }

  function metaDe(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    return {
      rev: Number.isFinite(m.rev) ? m.rev : 0,
      updatedAt: Number.isFinite(m.updatedAt) ? m.updatedAt : 0,
      updatedBy: typeof m.updatedBy === 'string' ? m.updatedBy : '',
    };
  }

  // Aplica um conjunto de regras ao motor. Devolve true se mudou a revisão.
  function ativarDados(data, meta, origem, fetchedAt) {
    const mudou = dadosAtivos === null || meta.rev !== dadosEstado.rev;
    dadosAtivos = data;
    dadosEstado = { ...meta, fetchedAt, origem, erro: '' };
    reconstruirRegras(data);
    return mudou;
  }

  // Resolve sempre (nunca rejeita) com true se as regras activas mudaram.
  async function carregarDados({ forcar = false } = {}) {
    const cache = carregarCacheDados();

    // Primeira chamada da página: põe logo a cache em uso, mesmo antiga,
    // para o motor nunca ficar vazio enquanto a rede responde.
    let mudou = false;
    if (cache && dadosAtivos === null) {
      mudou = ativarDados(cache.data, metaDe(cache), 'cache', cache.fetchedAt);
    }

    const fresca = !!cache && cache.fetchedAt <= Date.now() && (Date.now() - cache.fetchedAt) < DADOS_TTL_MS;
    if (!forcar && fresca) return mudou;
    if (!forcar && !cache && dadosUltimaFalha && (Date.now() - dadosUltimaFalha) < DADOS_RETRY_MS) return mudou;
    if (dadosRefreshEmCurso) return dadosRefreshEmCurso.then((m) => m || mudou);

    dadosRefreshEmCurso = (async () => {
      try {
        if (cache && !forcar) {
          const resRev = await pedidoFirebase('config/meta/rev');
          if (!resRev.ok) throw new Error(`dados: HTTP ${resRev.status}`);
          const rev = await resRev.json();
          if (Number.isFinite(rev) && rev === cache.rev) {
            // Mesma revisão: renova a cache sem descarregar as regras.
            const renovada = { ...cache, fetchedAt: Date.now() };
            gravarCacheDados(renovada);
            dadosEstado = { ...dadosEstado, fetchedAt: renovada.fetchedAt, origem: 'firebase' };
            dadosUltimaFalha = 0;
            return false;
          }
        }

        const res = await pedidoFirebase('config');
        if (!res.ok) throw new Error(`dados: HTTP ${res.status}`);
        const config = await res.json();
        if (!config || typeof config.dataJson !== 'string') {
          // Base de dados ainda sem regras (por exemplo, antes de o dono
          // importar o ficheiro inicial). Mantém a cache, se houver.
          dadosEstado = { ...dadosEstado, erro: 'vazio' };
          dadosUltimaFalha = Date.now();
          return false;
        }
        const data = normalizarDados(JSON.parse(config.dataJson));
        if (!data) throw new Error('dados: conteúdo inválido em config/dataJson');
        const meta = metaDe(config.meta);
        const fetchedAt = Date.now();
        gravarCacheDados({ ...meta, fetchedAt, data });
        dadosUltimaFalha = 0;
        return ativarDados(data, meta, 'firebase', fetchedAt);
      } catch (erro) {
        LOG('dados: falha ao obter as regras', erro);
        dadosUltimaFalha = Date.now();
        dadosEstado = { ...dadosEstado, erro: 'rede' };
        return false;
      } finally {
        dadosRefreshEmCurso = null;
      }
    })();
    return dadosRefreshEmCurso.then((m) => m || mudou);
  }

  function dadosDisponiveis() {
    return dadosAtivos !== null;
  }

  // #### INICIO-LOGICA-PURA ####
  // Tudo o que está entre estes marcadores é lógica pura (sem DOM nem SDK),
  // para poder ser testada isoladamente.

  // ------------------------------------------------------------------
  // UTILITÁRIOS DE REGEX
  //
  // O \b do JavaScript não reconhece letras acentuadas como parte de uma
  // palavra, por isso /\bAgua\b/ apanha "Agua" dentro de "Aguaçadoura" (o "ç"
  // conta como fronteira). Todas as regras passam a ser geradas com
  // lookarounds explícitos sobre uma classe de letras que inclui acentos.
  // ------------------------------------------------------------------
  const CLS_LETRA = 'A-Za-zÀ-ÖØ-öø-ÿ';
  const RE_LETRA = new RegExp(`[${CLS_LETRA}]`);

  function escaparRegex(texto) {
    return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // As expansões/abreviações trazem sempre um espaço a seguir embutido no
  // próprio texto de substituição (ex.: "Professora ", "Pte. "), para
  // separar da palavra seguinte. Quando a abreviatura está colada a um
  // fecho de parêntesis/aspas/pontuação (ex.: "(Prof.ª)"), esse espaço fica
  // preso ali dentro — não é removido por um simples .trim(), pois não está
  // na extremidade real da string. Esta função remove esse espaço a mais
  // antes de qualquer fecho de parêntesis, colchete, aspas ou pontuação.
  function limparEspacoAntesPontuacao(texto) {
    return String(texto).replace(/\s+([)\]}»”’,.;:!?])/g, '$1');
  }

  // Regex para uma palavra/expressão por extenso (ex.: "Avenida",
  // "Área de Serviço"), com fronteiras que respeitam acentos.
  function reExpressao(texto, flags) {
    const corpo = escaparRegex(texto).replace(/\s+/g, '\\s+');
    return new RegExp(
      `(?<![${CLS_LETRA}\\d])${corpo}(?![${CLS_LETRA}\\d])`,
      flags || 'gi'
    );
  }

  // Regex para uma abreviatura (ex.: "R.", "Qt.ª", "A. S."), consumindo os
  // espaços que se lhe seguem.
  function reAbreviatura(abrev, flags) {
    const corpo = escaparRegex(abrev).replace(/\s+/g, '\\s*');
    return new RegExp(`(?<![${CLS_LETRA}\\d])${corpo}\\s*`, flags || 'gi');
  }

  // ------------------------------------------------------------------
  // PARTÍCULAS E TIPOS DE VIA
  // ------------------------------------------------------------------
  // Palavras de ligação (de, da, do…) — vêm dos dados (Firebase).
  let PARTICULAS = new Set();

  // Palavras que, quando aparecem antes de uma abreviatura de uma só letra,
  // confirmam que essa letra é mesmo uma abreviatura e não uma inicial de
  // nome próprio. Guardadas já normalizadas (minúsculas, sem acentos).
  let TIPOS_DE_VIA = new Set();

  // Normaliza um nome para comparação "tolerante": minúsculas, espaços
  // colapsados e sem acentos.
  //
  // Memorizada: cada chamada faz um normalize('NFD') mais três passagens de
  // regex, e o ciclo de destaques chama-a repetidamente sobre os MESMOS
  // nomes (o nome principal e os alternativos são partilhados por muitos
  // segmentos da mesma rua). O resultado depende só do texto de entrada, por
  // isso é seguro memorizar; o limite evita que o mapa cresça sem fim numa
  // sessão longa.
  const cacheNormalizacao = new Map();
  const LIMITE_CACHE_NORMALIZACAO = 5000;

  function normalizarParaComparar(texto) {
    const chave = String(texto || '');
    const emCache = cacheNormalizacao.get(chave);
    if (emCache !== undefined) return emCache;

    const resultado = chave
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (cacheNormalizacao.size >= LIMITE_CACHE_NORMALIZACAO) cacheNormalizacao.clear();
    cacheNormalizacao.set(chave, resultado);
    return resultado;
  }

  // ------------------------------------------------------------------
  // REGRAS DE EXPANSÃO DE ABREVIATURAS
  //
  // Cada entrada declara a abreviatura em texto ("R.") e a forma por extenso.
  // As regex são geradas a partir desse texto — antes eram escritas à mão e
  // depois "desmontadas" com manipulação de strings sobre re.source, o que
  // produzia lixo para abreviaturas de duas palavras (ex.: "A. S." dava
  // "A.s*S.").
  // ------------------------------------------------------------------

  // d'Palavra → de Palavra (ex.: d'Alva → de Alva). Tem grupo de captura,
  // por isso fica fora da lista normal.
  const RE_D_APOSTROFO = new RegExp(`(?<![${CLS_LETRA}\\d])d['’]([${CLS_LETRA}])`, 'gi');

  // As listas de abreviaturas (expansão) vêm dos dados — ver DADOS mais abaixo.
  // A ordem importa: as formas femininas ("X.ª") têm de vir antes das
  // masculinas ("X."), senão "Dr." apanhava o início de "Dr.ª".

  // Núcleo = letras antes do primeiro ponto ("Qt" em "Qt.ª", "R" em "R.").
  function nucleoDeAbreviatura(abrev) {
    const idx = abrev.indexOf('.');
    return idx === -1 ? '' : abrev.slice(0, idx);
  }

  // Estruturas derivadas dos dados (Firebase). São reconstruídas por
  // reconstruirRegras() sempre que chegam regras novas (cache local,
  // Firebase, ou o painel de administração a testar um rascunho).
  let ABREVIATURAS_DEF = [];
  let ABREVIATURAS_COMPOSTAS_DEF = [];
  let ABREVIATURAS_INVERSAS_DEF = [];
  let ERROS_DEF = [];

  let ABREV_UMA_LETRA = [];
  let ABREV_GERAIS = [];
  let ABREV_COMPOSTAS = [];
  let NUCLEOS_UMA_LETRA_CONHECIDOS = new Set();
  let TODAS_ABREVIATURAS = [];
  let NUCLEO_PARA_ABREVIATURA = new Map();
  let ABREVIATURAS_INVERSAS = [];
  let CORRECOES_VIRGULA = [];
  let ERROS_ORTOGRAFICOS = [];
  let LISTA_BRANCA = [];

  // "D." e "D.ª" (Dom/Dona), "M.ª" (Maria) e "S." (São) expandem sempre, sem
  // depender do contexto nem da palavra que se segue — são títulos/nomes
  // que raramente colidem com uma inicial pessoal.
  let ABREV_UMA_LETRA_SEMPRE = new Set();

  // Um número ou uma letra isolada logo a seguir ("R. 2", "R. A", "R. b",
  // "Bc. da R. A") é um forte indício de que a abreviatura é mesmo um tipo
  // de via (ruas numeradas/letradas em loteamentos são comuns em PT) e não
  // uma inicial de nome — ninguém escreve "Maria R. A" como nome próprio.
  // Aceita números simples ou com um sufixo de letra/ordinal (ex.: "2",
  // "2A", "10º") ou uma única letra, maiúscula ou minúscula (ex.: "A", "b"),
  // incluindo as partículas de uma letra ("a", "e", "o", "à").
  const RE_PROXIMA_NUMERO = /^\d+[ºªA-Za-z]?$/;
  const RE_PROXIMA_LETRA_ISOLADA = /^[A-Za-zÀ-ÖØ-öø-ÿ]$/;

  function proximaPalavraEhNumeroOuLetra(proximaPalavra) {
    if (!proximaPalavra) return false;
    return RE_PROXIMA_NUMERO.test(proximaPalavra) || RE_PROXIMA_LETRA_ISOLADA.test(proximaPalavra);
  }

  // As restantes abreviaturas de uma letra só são expandidas se a palavra
  // anterior confirmar que se trata mesmo de uma abreviatura: início do
  // nome, uma partícula (de, da, do…), outra abreviatura (termina em "." ou
  // ".ª"), um tipo de via (Rua, Praça…), ou se a palavra seguinte for um
  // número ou uma letra isolada.
  function podeExpandirUmaLetra(palavraAnterior, abrev, proximaPalavra) {
    if (abrev && ABREV_UMA_LETRA_SEMPRE.has(abrev)) return true;
    if (proximaPalavraEhNumeroOuLetra(proximaPalavra)) return true;
    if (palavraAnterior === null || palavraAnterior === undefined) return true;
    if (/[.ª]$/.test(palavraAnterior) && /\./.test(palavraAnterior)) return true;
    const n = normalizarParaComparar(palavraAnterior);
    if (PARTICULAS.has(n)) return true;
    if (TIPOS_DE_VIA.has(n)) return true;
    return false;
  }

  function expandirAbreviaturasDeUmaLetra(texto) {
    const partes = texto.split(/(\s+)/);
    const indicesPalavra = [];
    for (let i = 0; i < partes.length; i++) {
      if (partes[i] !== '' && !/^\s+$/.test(partes[i])) indicesPalavra.push(i);
    }

    for (let k = 0; k < indicesPalavra.length; k++) {
      const i = indicesPalavra[k];
      const token = partes[i];
      const entrada = ABREV_UMA_LETRA.find(({ reToken }) => reToken.test(token));
      if (!entrada) continue;

      const anterior = k > 0 ? partes[indicesPalavra[k - 1]] : null;
      const proxima = k < indicesPalavra.length - 1 ? partes[indicesPalavra[k + 1]] : null;
      if (!podeExpandirUmaLetra(anterior, entrada.abrev, proxima)) continue;

      partes[i] = token.replace(entrada.reToken, entrada.exp);
    }
    return partes.join('');
  }

  function expandirNome(nome) {
    if (!nome) return '';
    return comListaBrancaProtegida(String(nome), (texto) => {
      let resultado = texto;
      resultado = resultado.replace(RE_D_APOSTROFO, 'de $1');
      for (const { re, exp } of ABREV_COMPOSTAS) resultado = resultado.replace(re, exp);
      for (const { re, exp } of ABREV_GERAIS) resultado = resultado.replace(re, exp);
      resultado = expandirAbreviaturasDeUmaLetra(resultado);
      return limparEspacoAntesPontuacao(resultado.replace(/\s+/g, ' ').trim());
    });
  }

  // ------------------------------------------------------------------
  // MAPA "NÚCLEO SEM PONTO" → ABREVIATURA CORRECTA
  //
  // Detecta quando alguma palavra do endereço é uma abreviatura conhecida
  // escrita sem o ponto ("Pte D. Luís I" → "Pte. D. Luís I", "Rua Az das
  // Flores" → "Rua Az. das Flores", "R Maria Joana" → "R. Maria Joana").
  // Aplica-se a qualquer posição — incluindo a primeira palavra — excepto
  // à última (protegida, é o nome próprio) e a texto entre aspas (já
  // mascarado antes de chegar aqui). Ficam de fora:
  //   • núcleos ambíguos (ex.: "Dr" pode ser "Dr." ou "Dr.ª") — excepto os
  //     que estão na lista branca à parte (ver NUCLEOS_AMBIGUOS_PERMITIDOS),
  //     que resolvem sempre para a forma masculina por omissão;
  //   • abreviaturas de duas palavras (ex.: "A. S.") — não se adivinha a
  //     segunda a partir de um único token;
  //   • núcleos que também são palavras correntes (Mar, Sol, Cor…);
  //   • núcleos de uma só letra em geral (S, V, M…) — demasiado ambíguos
  //     fora do contexto de abreviatura (podem ser uma inicial ou uma
  //     palavra isolada) — excepto "R", que também está na lista branca por
  //     ser suficientemente inequívoco e comum sem o ponto. "D" deixou de
  //     estar aqui de propósito: sem o ponto é indistinguível de uma
  //     inicial de nome próprio (ex.: "Maria D"), por isso já não se
  //     auto-corrige para "D.".
  // ------------------------------------------------------------------
  let NUCLEOS_IGNORADOS = new Set();

  function construirNucleoParaAbreviatura() {
    const candidatos = new Map();
    TODAS_ABREVIATURAS.forEach(({ abrev }) => {
      if (!abrev.includes('.')) return;
      if (/\s/.test(abrev)) return;
      const nucleo = nucleoDeAbreviatura(abrev);
      if (!nucleo || nucleo.length < 2) return;   // exclui núcleos de 1 letra
      const chave = nucleo.toLowerCase();
      if (!candidatos.has(chave)) candidatos.set(chave, new Set());
      candidatos.get(chave).add(abrev);
    });

    const mapa = new Map();
    candidatos.forEach((formas, chave) => {
      if (formas.size !== 1) return;              // género ambíguo
      if (NUCLEOS_IGNORADOS.has(chave)) return;   // também é palavra corrente
      mapa.set(chave, [...formas][0]);
    });
    return mapa;
  }

  // Lista branca de núcleos ambíguos (colidem com uma forma feminina, ex.:
  // "Dr"/"Dr.ª", ou são de uma só letra, ex.: "R") que ainda assim são
  // corrigidos quando escritos sem o ponto, em qualquer posição do endereço
  // (excepto a última palavra ou texto entre aspas). Resolvem sempre para a
  // forma masculina/omissão indicada — não há verdadeira ambiguidade na
  // prática, já que a forma feminina sem ponto teria a sua própria grafia
  // diferente (ex.: "Dr.ª" sem ponto seria "Dra", não "Dr").
  //
  // "D" foi removido de propósito: uma letra "D" isolada sem ponto é
  // indistinguível de uma inicial de nome próprio (ex.: "Rua Maria D"), por
  // isso o script já não a corrige automaticamente para "D.".
  let NUCLEOS_AMBIGUOS_PERMITIDOS = new Map();

  function corrigirPalavraSemPonto(palavra) {
    if (!palavra || palavra.includes('.')) return null;
    const chave = palavra.toLowerCase();
    return NUCLEO_PARA_ABREVIATURA.get(chave) || NUCLEOS_AMBIGUOS_PERMITIDOS.get(chave) || null;
  }

  // ------------------------------------------------------------------
  // REGRAS DE ABREVIAÇÃO (por extenso → abreviatura)
  //
  // As frases compostas / com hífen vêm primeiro (ex.: "Grão-Duque" antes de
  // "Duque"). As fronteiras são geradas com lookarounds, por isso já não é
  // preciso o callback com offset que existia antes — callback esse que
  // partia em silêncio assim que alguém acrescentasse um grupo de captura.
  // ------------------------------------------------------------------
  // As regras de abreviação (por extenso → abreviatura) vêm dos dados.

  // ------------------------------------------------------------------
  // PROTECÇÃO DE TEXTO ENTRE ASPAS
  //
  // As aspas tipográficas e as guillemets nunca eram protegidas: a regex
  // usava uma retro-referência (\1), que exige o MESMO carácter a fechar, e
  // «Boqueirão» fecha com um carácter diferente daquele com que abre. Agora
  // cada par é declarado explicitamente.
  // ------------------------------------------------------------------
  const RE_PARES_ASPAS = /"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’/g;

  function mascararAspas(nome) {
    const guardados = [];
    const mascarado = String(nome).replace(RE_PARES_ASPAS, (match) => {
      guardados.push(match);
      return `\x00Q${guardados.length - 1}\x00`;
    });
    return { mascarado, guardados };
  }

  function restaurarAspas(texto, guardados) {
    return texto.replace(/\x00Q(\d+)\x00/g, (_, i) => guardados[Number(i)]);
  }

  const RE_TOKEN_MASCARADO = /^\x00Q\d+\x00$/;
  const RE_TOKEN_LISTA_BRANCA = /^\x01W\d+\x01$/;

  // Um token é intocável se veio de dentro de aspas ou da lista branca.
  function tokenProtegido(token) {
    return RE_TOKEN_MASCARADO.test(token) || RE_TOKEN_LISTA_BRANCA.test(token);
  }

  function aplicarAbreviaturasInversas(texto) {
    return comListaBrancaProtegida(texto, (protegido) => {
      let resultado = protegido;
      for (const { re, abrev } of ABREVIATURAS_INVERSAS) {
        re.lastIndex = 0;
        resultado = resultado.replace(re, abrev);
      }
      return resultado;
    });
  }

  // ------------------------------------------------------------------
  // NUMERAIS ROMANOS E INICIAIS
  // ------------------------------------------------------------------
  const RE_NUMERAL_ROMANO = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

  function eNumeralRomano(palavra) {
    if (!palavra) return false;
    let nucleo = palavra;
    if (/[ºª]$/.test(nucleo)) {
      const candidato = nucleo.slice(0, -1);
      if (/^[IVXLCDM]+$/.test(candidato)) nucleo = candidato;
    }
    if (!/^[IVXLCDM]+$/.test(nucleo)) return false;
    return RE_NUMERAL_ROMANO.test(nucleo);
  }

  function eLetraInicialMaiuscula(palavra) {
    return /^[A-ZÀ-ÖØ-Þ]$/.test(palavra);
  }

  // Quantas palavras finais devem ser protegidas: sempre a última (nome
  // próprio) e também a penúltima quando a última é um numeral romano ou uma
  // inicial isolada ("Maria IV", "Maria M").
  function nProtegidas(partes) {
    if (partes.length === 0) return 0;
    const ultima = partes[partes.length - 1];
    if ((eNumeralRomano(ultima) || eLetraInicialMaiuscula(ultima)) && partes.length >= 3) return 2;
    return 1;
  }

  function abreviarNomeProtegendoUltimaPalavra(nome) {
    const { mascarado, guardados } = mascararAspas(nome);
    const partes = mascarado.trim().split(/\s+/);
    if (partes.length <= 1) return String(nome).trim();

    const n = nProtegidas(partes);
    const protegidas = partes.slice(-n).join(' ');
    const resto = partes.slice(0, -n).join(' ');
    if (!resto) return String(nome).trim();

    const restoAbreviado = aplicarAbreviaturasInversas(resto);
    const resultado = limparEspacoAntesPontuacao(`${restoAbreviado} ${protegidas}`.replace(/\s+/g, ' ').trim());
    return restaurarAspas(resultado, guardados);
  }

  // Abreviaturas que só existem no sentido da EXPANSÃO (endereço
  // alternativo) e que nunca devem ser expandidas dentro do nome
  // principal. Sem isto, um "[P]" que calhasse ser a última palavra do
  // nome era expandido por expandirTokenFinal (a regra "a última palavra
  // nunca fica abreviada") e o marcador desaparecia do endereço principal.
  let ABREV_SO_ALTERNATIVO = new Set();

  function ehAbreviaturaSoAlternativo(token) {
    return ABREV_SO_ALTERNATIVO.has(String(token || '').trim().toLowerCase());
  }

  // Expande o último token de um endereço, se for uma abreviatura conhecida.
  // Abreviaturas de uma só letra ("D.", "D.ª", "M.ª") só são expandidas
  // quando o contexto confirma que não são uma inicial de nome próprio —
  // exceto as que estão em ABREV_UMA_LETRA_SEMPRE, que expandem sempre.
  function expandirTokenFinal(token, anterior) {
    if (!token) return token;
    if (eNumeralRomano(token) || eLetraInicialMaiuscula(token)) return token;
    if (tokenProtegido(token)) return token;
    if (ehAbreviaturaSoAlternativo(token)) return token;
    if (/^d['’]/.test(token)) return token;
    const entradaUmaLetra = ABREV_UMA_LETRA.find(({ reToken }) => reToken.test(token));
    if (entradaUmaLetra && !podeExpandirUmaLetra(anterior, entradaUmaLetra.abrev)) return token;
    const expandido = expandirNome(token).trim();
    return expandido || token;
  }

  // ------------------------------------------------------------------
  // ERROS ORTOGRÁFICOS E CORRECÇÕES — as listas vêm dos dados.
  // ------------------------------------------------------------------

  // Marcadores legíveis nas regras de expressão regular. Sem eles, cada
  // fronteira de palavra (que tem de reconhecer letras acentuadas, ver
  // CLS_LETRA) obrigava a escrever "(?<![A-Za-zÀ-ÖØ-öø-ÿ\d])" por extenso:
  //   {ini}  início de palavra  → não precedido de letra nem algarismo
  //   {fim}  fim de palavra     → não seguido de letra
  //   {L}    uma letra (incluindo acentuadas)
  const MARCADORES_REGEX = [
    ['{ini}', `(?<![${CLS_LETRA}\\d])`],
    ['{fim}', `(?![${CLS_LETRA}])`],
    ['{L}', `[${CLS_LETRA}]`],
  ];

  function expandirMarcadoresRegex(fonte) {
    let s = String(fonte);
    for (const [marcador, regex] of MARCADORES_REGEX) s = s.split(marcador).join(regex);
    return s;
  }

  // Inverso: converte as formas por extenso (dados antigos) nos marcadores,
  // para as listas ficarem legíveis. Troca textual exacta, por isso a
  // expressão compilada é a mesma.
  function compactarMarcadoresRegex(fonte) {
    let s = String(fonte);
    for (const [marcador, regex] of MARCADORES_REGEX) s = s.split(regex).join(marcador);
    return s;
  }

  function compilarRegraErro({ tipo, de, re, flags, correto }) {
    try {
      if (tipo === 're') return { re: new RegExp(expandirMarcadoresRegex(re), flags || 'gi'), correto };
      if (tipo === 'abrev') return { re: reAbreviatura(de, flags), correto };
      return { re: reExpressao(de, flags), correto };
    } catch (erro) {
      LOGE('Regra inválida ignorada:', { tipo, de, re, flags }, erro);
      return null;
    }
  }

  // ==================================================================
  // DADOS (regras e definições vindas do Firebase)
  //
  // Formato (schema 1) — todas as listas por ordem de aplicação:
  //   abreviaturasCompostas  [{ abrev, exp }]   expansão, processadas 1.º
  //   abreviaturas           [{ abrev, exp }]   expansão (alternativo)
  //   abreviaturasInversas   [{ ext, abrev }]   abreviação (principal)
  //   correccoes             [regra]            abreviaturas mal escritas
  //   ortografiaA            [regra]            palavras de via mal escritas
  //   ortografiaB            [regra]            acentuação e topónimos
  //       regra = { tipo: 'palavra'|'abrev'|'re', de | re, flags?, correto }
  //   listaBranca, particulas, tiposDeVia, abrevUmaLetraSempre,
  //   nucleosIgnorados, abrevSoAlternativo        [string]
  //   nucleosAmbiguos        [{ nucleo, abrev }]
  //   tiposSegmentoDesativados, tiposComCidade    [número]
  // ==================================================================
  const DADOS_SCHEMA = 1;

  // Catálogo de tipos de segmento conhecidos da SDK do WME (usado no
  // painel de administração para escolher os tipos elegíveis).
  const TODOS_TIPOS_VIA = [
    { id: 1, nome: 'Rua' },
    { id: 2, nome: 'Rua Principal' },
    { id: 3, nome: 'Autoestrada' },
    { id: 4, nome: 'Rampa' },
    { id: 5, nome: 'Trilho Pedestre' },
    { id: 6, nome: 'IP / IC Estrada Nacional' },
    { id: 7, nome: 'Estrada Municipal' },
    { id: 8, nome: 'Não Pavimentada' },
    { id: 9, nome: 'Caminho Pedonal' },
    { id: 10, nome: 'Trilho Pedestre' },
    { id: 15, nome: 'Ferry' },
    { id: 16, nome: 'Escadas' },
    { id: 17, nome: 'Estrada Privada' },
    { id: 18, nome: 'Via Férrea' },
    { id: 19, nome: 'Pista de Aeroporto' },
    { id: 20, nome: 'Via de Parque de Estacionamento' },
    { id: 22, nome: 'Rua Estreita' },
  ];

  // O Firebase devolve listas esparsas como objectos {0:…,1:…}.
  function paraLista(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      return Object.keys(v).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b).map((k) => v[k]);
    }
    return [];
  }

  function textoOuVazio(v) {
    return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '');
  }

  function normalizarListaPares(v, campoA, campoB) {
    return paraLista(v)
      .filter((d) => d && typeof d === 'object')
      .map((d) => ({ [campoA]: textoOuVazio(d[campoA]).trim(), [campoB]: textoOuVazio(d[campoB]).trim() }))
      .filter((d) => d[campoA] && d[campoB]);
  }

  function normalizarListaRegras(v) {
    const out = [];
    for (const d of paraLista(v)) {
      if (!d || typeof d !== 'object') continue;
      const correto = textoOuVazio(d.correto);
      if (!correto.trim()) continue;
      const flags = typeof d.flags === 'string' && /^[gimsuy]*$/.test(d.flags) ? d.flags : '';
      if (d.tipo === 're') {
        const re = compactarMarcadoresRegex(textoOuVazio(d.re));
        if (!re) continue;
        try { new RegExp(expandirMarcadoresRegex(re), flags || 'gi'); } catch (e) { continue; }
        const desc = textoOuVazio(d.desc).trim().slice(0, 200);
        out.push({ tipo: 're', re, ...(flags ? { flags } : {}), correto, ...(desc ? { desc } : {}) });
      } else {
        const tipo = d.tipo === 'abrev' ? 'abrev' : 'palavra';
        const de = textoOuVazio(d.de).trim();
        if (!de) continue;
        out.push({ tipo, de, ...(flags ? { flags } : {}), correto });
      }
    }
    return out;
  }

  function normalizarListaTexto(v) {
    const vistos = new Set();
    const out = [];
    for (const t of paraLista(v)) {
      const s = textoOuVazio(t).trim();
      if (!s || vistos.has(s)) continue;
      vistos.add(s);
      out.push(s);
    }
    return out;
  }

  function normalizarListaNumeros(v) {
    return [...new Set(paraLista(v).map(Number).filter((n) => Number.isInteger(n) && n >= 0))];
  }

  // Dados não confiáveis (Firebase, cache, ficheiro importado) → objecto
  // limpo, ou null se não forem reconhecíveis como dados deste script.
  function normalizarDados(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema !== undefined && Number(raw.schema) > DADOS_SCHEMA) return null;
    if (raw.abreviaturas === undefined && raw.abreviaturasInversas === undefined) return null;
    return {
      schema: DADOS_SCHEMA,
      abreviaturasCompostas: normalizarListaPares(raw.abreviaturasCompostas, 'abrev', 'exp'),
      abreviaturas: normalizarListaPares(raw.abreviaturas, 'abrev', 'exp'),
      abreviaturasInversas: normalizarListaPares(raw.abreviaturasInversas, 'ext', 'abrev'),
      correccoes: normalizarListaRegras(raw.correccoes),
      ortografiaA: normalizarListaRegras(raw.ortografiaA),
      ortografiaB: normalizarListaRegras(raw.ortografiaB),
      listaBranca: normalizarListaTexto(raw.listaBranca),
      particulas: normalizarListaTexto(raw.particulas).map((p) => p.toLowerCase()),
      tiposDeVia: normalizarListaTexto(raw.tiposDeVia).map((p) => normalizarParaComparar(p)),
      abrevUmaLetraSempre: normalizarListaTexto(raw.abrevUmaLetraSempre),
      nucleosIgnorados: normalizarListaTexto(raw.nucleosIgnorados).map((p) => p.toLowerCase()),
      nucleosAmbiguos: normalizarListaPares(raw.nucleosAmbiguos, 'nucleo', 'abrev'),
      abrevSoAlternativo: normalizarListaTexto(raw.abrevSoAlternativo),
      tiposSegmentoDesativados: normalizarListaNumeros(raw.tiposSegmentoDesativados),
      tiposComCidade: normalizarListaNumeros(raw.tiposComCidade),
    };
  }

  // Tipos de via elegíveis para "Erros"/"Alt."/"Fix Loc." e tipos que devem
  // ter cidade ("Loc."). Reconstruídos em reconstruirRegras().
  let TIPOS_DESATIVADOS_SET = new Set();
  let TIPOS_COM_CIDADE_SET = new Set();

  // Reconstrói TODAS as estruturas derivadas a partir dos dados. Chamada
  // sempre que chegam regras novas (cache, Firebase, ou o painel de
  // administração a testar um rascunho). Com `dados` null o motor fica
  // vazio.
  function reconstruirRegras(dados) {
    const d = dados || normalizarDados({ abreviaturas: [] });

    ABREVIATURAS_DEF = d.abreviaturas.map(({ abrev, exp }) => ({ abrev, exp: `${exp.trim()} ` }));
    ABREVIATURAS_COMPOSTAS_DEF = d.abreviaturasCompostas.map(({ abrev, exp }) => ({ abrev, exp: `${exp.trim()} ` }));
    ABREVIATURAS_INVERSAS_DEF = d.abreviaturasInversas.map(({ ext, abrev }) => ({ ext, abrev }));

    ABREV_UMA_LETRA = [];
    ABREV_GERAIS = [];
    ABREVIATURAS_DEF.forEach(({ abrev, exp }) => {
      const entrada = {
        abrev,
        exp,
        re: reAbreviatura(abrev),
        reToken: new RegExp(`^${escaparRegex(abrev)}`, 'i'),
      };
      if (abrev.includes('.') && nucleoDeAbreviatura(abrev).length === 1) {
        ABREV_UMA_LETRA.push(entrada);
      } else {
        ABREV_GERAIS.push(entrada);
      }
    });

    ABREV_COMPOSTAS = ABREVIATURAS_COMPOSTAS_DEF.map(({ abrev, exp }) => ({
      abrev, exp, re: reAbreviatura(abrev),
    }));

    ABREV_UMA_LETRA_SEMPRE = new Set(d.abrevUmaLetraSempre);
    NUCLEOS_IGNORADOS = new Set(d.nucleosIgnorados);
    NUCLEOS_AMBIGUOS_PERMITIDOS = new Map(d.nucleosAmbiguos.map(({ nucleo, abrev }) => [nucleo.toLowerCase(), abrev]));
    ABREV_SO_ALTERNATIVO = new Set(d.abrevSoAlternativo.map((t) => t.toLowerCase()));
    TIPOS_DE_VIA = new Set(d.tiposDeVia);
    PARTICULAS = new Set(d.particulas);

    NUCLEOS_UMA_LETRA_CONHECIDOS = new Set(ABREV_UMA_LETRA.map(({ abrev }) => abrev.toLowerCase()));
    TODAS_ABREVIATURAS = [...ABREV_COMPOSTAS, ...ABREV_GERAIS, ...ABREV_UMA_LETRA];
    NUCLEO_PARA_ABREVIATURA = construirNucleoParaAbreviatura();

    ABREVIATURAS_INVERSAS = ABREVIATURAS_INVERSAS_DEF.map(({ ext, abrev }) => ({
      re: reExpressao(ext), abrev,
    }));

    CORRECOES_VIRGULA = TODAS_ABREVIATURAS
      .filter(({ abrev }) => abrev.includes('.'))
      .map(({ abrev }) => ({
        re: reAbreviatura(abrev.replace(/\./g, ',')),
        correto: `${abrev} `,
      }));

    // A ordem importa: palavras mal escritas → abreviaturas mal escritas →
    // acentuação/topónimos (estes últimos dependem das correcções de
    // acentuação já aplicadas, ex.: "Povoa" → "Póvoa" antes de
    // "Póvoa do Varzim" → "Póvoa de Varzim").
    ERROS_DEF = [...d.ortografiaA, ...d.correccoes, ...d.ortografiaB];
    ERROS_ORTOGRAFICOS = ERROS_DEF.map(compilarRegraErro).filter(Boolean);

    LISTA_BRANCA = d.listaBranca
      .slice()
      .sort((a, b) => b.length - a.length); // as mais longas primeiro

    TIPOS_DESATIVADOS_SET = new Set(d.tiposSegmentoDesativados);
    TIPOS_COM_CIDADE_SET = new Set(d.tiposComCidade);

    cacheAnalise.clear();
  }

  // ------------------------------------------------------------------
  // LISTA BRANCA
  //
  // Palavras/expressões que o script nunca deve abreviar, expandir nem
  // assinalar como erro. Usa a mesma técnica das aspas: são substituídas
  // por marcadores neutros antes de aplicar as regras e repostas no fim.
  // Usa um marcador próprio (\x01) para não colidir com o das aspas (\x00),
  // já que as duas máscaras podem estar activas ao mesmo tempo.
  // ------------------------------------------------------------------
  function mascararListaBranca(texto) {
    if (!LISTA_BRANCA.length) return { mascarado: texto, guardados: [] };
    const guardados = [];
    let resultado = String(texto);
    LISTA_BRANCA.forEach((termo) => {
      const re = reExpressao(termo);
      resultado = resultado.replace(re, (match) => {
        guardados.push(match);
        return `\x01W${guardados.length - 1}\x01`;
      });
    });
    return { mascarado: resultado, guardados };
  }

  function restaurarListaBranca(texto, guardados) {
    if (!guardados.length) return texto;
    return texto.replace(/\x01W(\d+)\x01/g, (_, i) => guardados[Number(i)]);
  }

  // Envolve uma transformação de texto com a protecção da lista branca.
  function comListaBrancaProtegida(texto, transformar) {
    const { mascarado, guardados } = mascararListaBranca(texto);
    return restaurarListaBranca(transformar(mascarado), guardados);
  }

  function temErroOrtografico(texto) {
    return ERROS_ORTOGRAFICOS.some(({ re }) => { re.lastIndex = 0; return re.test(texto); });
  }

  function temAbreviaturaComVirgula(texto) {
    return CORRECOES_VIRGULA.some(({ re }) => { re.lastIndex = 0; return re.test(texto); });
  }

  // Abreviaturas não reconhecidas: expande o que se conhece e vê se ainda
  // sobra "palavra." antes de mais texto. Exige 2+ letras, para não apanhar
  // iniciais legítimas ("R. Maria F.").
  const RE_ABREV_DESCONHECIDA = new RegExp(`(?<![${CLS_LETRA}\\d])[${CLS_LETRA}]{2,}\\.\\s*(?=\\S)`);

  // A primeira palavra do endereço é suspeita quando é uma letra isolada,
  // com ou sem ponto, que não corresponde a nenhuma abreviatura conhecida:
  //   • sem ponto (ex.: "B do Teste"): ao contrário de uma inicial no fim
  //     do nome (ex.: "Maria B", protegida de propósito), ninguém começa um
  //     nome de rua por uma inicial pessoal — é muito mais provável ser uma
  //     abreviatura truncada (ex.: "B" em vez de "Bc.", "Br.", "Bl.",
  //     "Bpo."…). As letras já cobertas pela lista branca (R, que se
  //     auto-corrige sozinha) não entram aqui.
  //   • com ponto (ex.: "B. do Teste"): "B." não corresponde a nenhuma
  //     abreviatura da lista (ao contrário de "S.", "V.", "R.", "D.",
  //     "D.ª", "M.ª", que são legítimas e ficam de fora deste aviso).
  const RE_LETRA_COM_PONTO = /^[A-Za-zÀ-ÖØ-öø-ÿ]\.ª?$/;

  function primeiraPalavraEhAbreviaturaSuspeita(mascarado) {
    const partes = mascarado.trim().split(/\s+/);
    if (partes.length < 2) return false; // endereço de uma só palavra
    const primeira = partes[0];

    if (eLetraInicialMaiuscula(primeira)) {
      return !NUCLEOS_AMBIGUOS_PERMITIDOS.has(primeira.toLowerCase());
    }
    if (RE_LETRA_COM_PONTO.test(primeira)) {
      return !NUCLEOS_UMA_LETRA_CONHECIDOS.has(primeira.toLowerCase());
    }
    return false;
  }

  // Corrige apenas erros ortográficos e abreviaturas mal escritas
  // conhecidas (ex.: "Srg." → "Sarg."), sem tocar em capitalização,
  // partículas ou na última palavra — usado por temAbreviaturaDesconhecida
  // para não confundir uma abreviatura CONHECIDA mas mal escrita com uma
  // verdadeiramente desconhecida.
  function aplicarCorrecoesConhecidas(texto) {
    return comListaBrancaProtegida(texto, (protegido) => {
      let resultado = protegido;
      for (const { re, correto } of CORRECOES_VIRGULA) {
        re.lastIndex = 0;
        resultado = resultado.replace(re, correto);
      }
      for (const { re, correto } of ERROS_ORTOGRAFICOS) {
        re.lastIndex = 0;
        resultado = resultado.replace(re, correto);
      }
      return resultado;
    });
  }

  function temAbreviaturaDesconhecida(streetName) {
    if (!streetName) return false;
    const { mascarado } = mascararAspas(streetName);
    const corrigidoConhecido = aplicarCorrecoesConhecidas(mascarado);
    if (RE_ABREV_DESCONHECIDA.test(expandirNome(corrigidoConhecido))) return true;
    return primeiraPalavraEhAbreviaturaSuspeita(corrigidoConhecido);
  }

  // ------------------------------------------------------------------
  // CORRECÇÃO DO NOME PRINCIPAL
  // ------------------------------------------------------------------
  function corrigirNome(nome) {
    const { mascarado: semAspas, guardados } = mascararAspas(nome);
    // Também protege os termos da lista branca durante toda a correcção —
    // incluindo a capitalização, para respeitar grafias próprias (ex.: uma
    // marca escrita em minúsculas).
    const { mascarado: protegidoLB, guardados: guardadosLB } = mascararListaBranca(semAspas);
    let resultado = protegidoLB;

    // 0. Qualquer palavra (excepto a última, protegida) que seja uma
    //    abreviatura conhecida escrita sem o ponto
    //    ("R Maria Joana" → "R. Maria Joana",
    //     "Rua Pte D. Luís I" → "Rua Pte. D. Luís I").
    {
      const partesIniciais = resultado.trim().split(/\s+/);
      for (let idx = 0; idx < partesIniciais.length - 1; idx++) {
        if (tokenProtegido(partesIniciais[idx])) continue;
        const corrigida = corrigirPalavraSemPonto(partesIniciais[idx]);
        if (corrigida) partesIniciais[idx] = corrigida;
      }
      resultado = partesIniciais.join(' ');
    }

    // 1. Vírgulas em abreviaturas ("R," → "R.")
    for (const { re, correto } of CORRECOES_VIRGULA) {
      re.lastIndex = 0;
      resultado = resultado.replace(re, correto);
    }

    // 2. Erros ortográficos
    for (const { re, correto } of ERROS_ORTOGRAFICOS) {
      re.lastIndex = 0;
      resultado = resultado.replace(re, correto);
    }

    resultado = limparEspacoAntesPontuacao(resultado.replace(/\s+/g, ' ').trim());

    // 3. Capitalização e partículas
    const partes = resultado.split(/\s+/);
    for (let i = 0; i < partes.length; i++) {
      const p = partes[i];
      if (!p) continue;
      if (tokenProtegido(p)) continue;
      if (eLetraInicialMaiuscula(p)) continue;

      if (/^[Dd]['’]/.test(p)) {
        partes[i] = "d'" + p.slice(2);
        continue;
      }

      const pLower = p.toLowerCase();
      if (i > 0 && PARTICULAS.has(pLower)) {
        partes[i] = pLower;
        continue;
      }

      const capitalizada = p.charAt(0).toUpperCase() + p.slice(1);
      if (capitalizada !== p) partes[i] = capitalizada;
    }

    // 4. A última palavra nunca fica abreviada (é o nome próprio).
    if (partes.length >= 1) {
      const ultimo = partes.length - 1;
      const anterior = ultimo > 0 ? partes[ultimo - 1] : null;
      const expandida = expandirTokenFinal(partes[ultimo], anterior);
      if (expandida && expandida !== partes[ultimo]) partes[ultimo] = expandida;
    }

    resultado = limparEspacoAntesPontuacao(partes.join(' '));
    resultado = restaurarListaBranca(resultado, guardadosLB);
    return restaurarAspas(resultado, guardados);
  }

  // Pipeline completa. Corre até estabilizar (máx. 5 voltas) porque uma
  // correcção ortográfica pode desbloquear uma abreviatura: "Praca da
  // Republica" só vira "Pç. da República" depois de "Praca" → "Praça".
  // Antes fazia-se uma volta só e o segmento ficava marcado a vermelho
  // mesmo depois de clicar em Corrigir.
  function normalizarNomeCompleto(nome) {
    let atual = String(nome);
    for (let i = 0; i < 5; i++) {
      const proximo = corrigirNome(abreviarNomeProtegendoUltimaPalavra(atual));
      if (proximo === atual) break;
      atual = proximo;
    }
    return atual;
  }

  // ------------------------------------------------------------------
  // HELPERS DE COMPARAÇÃO
  // ------------------------------------------------------------------
  function nomeRuaVazioOuNenhum(streetName) {
    if (streetName === null || streetName === undefined) return true;
    const t = String(streetName).trim().toLowerCase();
    if (t === '') return true;
    return t === 'none' || t === 'nenhum' || t === 'nenhuma' || t === 'sem nome';
  }

  // Remove aspas do nome. O apóstrofo só é removido quando não está entre
  // duas letras, para não estragar "d'Alva".
  function removerAspas(nome) {
    return String(nome)
      .replace(/["“”«»]/g, '')
      .replace(/['’`]/g, (m, off, s) => {
        const antes = s[off - 1];
        const depois = s[off + 1];
        return (antes && depois && RE_LETRA.test(antes) && RE_LETRA.test(depois)) ? m : '';
      })
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escaparHTML(texto) {
    return String(texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function restaurarAspasEmHTML(html, guardados) {
    return html.replace(/\x00Q(\d+)\x00/g, (_, i) => escaparHTML(guardados[Number(i)]));
  }

  const RE_TOKEN_ABREV_DESCONHECIDA = new RegExp(`^[${CLS_LETRA}]{2,}\\.$`);

  // Constrói o HTML do nome com as palavras que vão ser alteradas destacadas
  // a vermelho. Usado tanto na pré-visualização do painel como na camada
  // sobreposta ao campo do nome — antes eram duas implementações diferentes,
  // que por vezes discordavam entre si.
  function nomeComAlvosDestacadosHTML(streetName, apenasInvalidas) {
    const { mascarado, guardados } = mascararAspas(streetName);

    const tokens = [];
    const reTokens = /\S+/g;
    let m;
    while ((m = reTokens.exec(mascarado)) !== null) {
      tokens.push({ texto: m[0], inicio: m.index, fim: m.index + m[0].length });
    }
    if (tokens.length === 0) return { html: escaparHTML(streetName), temAlvo: false };

    const textos = tokens.map((t) => t.texto);
    const protegidas = nProtegidas(textos);
    const alvoIndices = new Set();

    tokens.forEach((tok, i) => {
      const texto = tok.texto;
      if (tokenProtegido(texto)) return;

      const eUltimo = i === tokens.length - 1;
      const eProtegido = i >= tokens.length - protegidas;

      if (apenasInvalidas) {
        if (RE_TOKEN_ABREV_DESCONHECIDA.test(texto) && expandirNome(texto).trim() === texto) {
          alvoIndices.add(i);
        } else if (i === 0 && primeiraPalavraEhAbreviaturaSuspeita(mascarado)) {
          alvoIndices.add(i);
        }
        return;
      }

      let alvo = false;

      if (!eUltimo && corrigirPalavraSemPonto(texto)) alvo = true;

      if (!alvo) alvo = temAbreviaturaComVirgula(texto);
      if (!alvo) alvo = temErroOrtografico(texto);
      if (!alvo && !eProtegido && aplicarAbreviaturasInversas(texto) !== texto) alvo = true;

      if (!alvo && eUltimo) {
        const anterior = i > 0 ? textos[i - 1] : null;
        if (expandirTokenFinal(texto, anterior) !== texto) alvo = true;
      }

      if (
        !alvo &&
        !eLetraInicialMaiuscula(texto) &&
        !/^d['’]/.test(texto) &&
        !(i > 0 && PARTICULAS.has(texto.toLowerCase())) &&
        texto.charAt(0) !== texto.charAt(0).toUpperCase()
      ) {
        alvo = true;
      }

      if (alvo) alvoIndices.add(i);
    });

    let html = '';
    let cursor = 0;
    tokens.forEach((tok, i) => {
      html += escaparHTML(mascarado.slice(cursor, tok.inicio));
      const textoEscapado = escaparHTML(tok.texto);
      html += alvoIndices.has(i)
        ? `<span style="color:#c00; font-weight:700; text-decoration:underline; text-decoration-style:wavy;">${textoEscapado}</span>`
        : textoEscapado;
      cursor = tok.fim;
    });
    html += escaparHTML(mascarado.slice(cursor));

    return {
      html: restaurarAspasEmHTML(html, guardados),
      temAlvo: alvoIndices.size > 0,
    };
  }

  // ------------------------------------------------------------------
  // CACHE DE ANÁLISE POR NOME DE RUA
  //
  // O ciclo de destaques corria ~600 regex por segmento, em todos os
  // segmentos carregados, a cada actualização do mapa. Como muitos segmentos
  // partilham o mesmo nome, basta analisar cada nome uma vez.
  // ------------------------------------------------------------------
  const cacheAnalise = new Map();
  const LIMITE_CACHE = 5000;

  function analisarNome(streetName) {
    if (cacheAnalise.has(streetName)) return cacheAnalise.get(streetName);

    const corrigido = normalizarNomeCompleto(streetName);
    const expandido = removerAspas(expandirNome(streetName));
    // Calculado uma só vez e reutilizado: antes normalizava-se o nome
    // expandido duas vezes por cada nome analisado.
    const expandidoNormalizado = normalizarParaComparar(expandido);
    const analise = {
      corrigido,
      expandido,
      precisaCorreccao: corrigido !== streetName || temAbreviaturaDesconhecida(streetName),
      temAbreviaturas: expandidoNormalizado !== normalizarParaComparar(streetName),
      expandidoNormalizado,
    };

    if (cacheAnalise.size >= LIMITE_CACHE) cacheAnalise.clear();
    cacheAnalise.set(streetName, analise);
    return analise;
  }
  // #### FIM-LOGICA-PURA ####

  // ------------------------------------------------------------------
  // PERSISTÊNCIA DA POSIÇÃO
  // ------------------------------------------------------------------
  const CHAVE_POSICAO = `${SCRIPT_ID}-posicao`;
  const POSICAO_DEFAULT = { top: 110, left: 320 };
  const CHAVE_TOGGLES = `${SCRIPT_ID}-toggles`;

  function carregarPosicao() {
    try {
      const guardada = JSON.parse(localStorage.getItem(CHAVE_POSICAO));
      if (guardada && typeof guardada.top === 'number' && typeof guardada.left === 'number') {
        return guardada;
      }
    } catch (e) {
      LOG('Sem posição guardada válida, a usar posição default.');
    }
    return POSICAO_DEFAULT;
  }

  function guardarPosicao(top, left) {
    try {
      localStorage.setItem(CHAVE_POSICAO, JSON.stringify({ top, left }));
    } catch (e) {
      LOGE('Não foi possível guardar a posição do painel:', e);
    }
  }

  // Mantém o estado ligado/desligado de cada toggle entre sessões (fecho do
  // separador, refresh da página, etc.), tal como já acontecia com a posição
  // do painel.
  function carregarEstadoToggles() {
    try {
      const guardado = JSON.parse(localStorage.getItem(CHAVE_TOGGLES));
      if (guardado && typeof guardado === 'object') return guardado;
    } catch (e) {
      LOG('Sem estado de toggles guardado válido, a usar tudo desligado.');
    }
    return { erros: false, altcheck: false, semcidade: false, fixloc: false };
  }

  function guardarEstadoToggles() {
    try {
      localStorage.setItem(CHAVE_TOGGLES, JSON.stringify({
        erros: getToggleErros(),
        altcheck: getToggleAltCheck(),
        semcidade: getToggleSemCidade(),
        fixloc: getToggleFixLoc(),
      }));
    } catch (e) {
      LOGE('Não foi possível guardar o estado dos toggles:', e);
    }
  }

  function garantirPainel() {
    let painel = document.getElementById(`${SCRIPT_ID}-painel`);
    if (painel) return painel;

    const posGuardada = carregarPosicao();

    painel = document.createElement('div');
    painel.id = `${SCRIPT_ID}-painel`;
    painel.style.cssText = `
      position: fixed; top: ${posGuardada.top}px; left: ${posGuardada.left}px; z-index: 99999;
      background: #fff; border: 1px solid #ccc; border-radius: 5px;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
      font-family: sans-serif; font-size: 11px; width: fit-content; display: none;
      user-select: none;
    `;

    // Sem cabeçalho "Destacar": a própria linha de toggles serve de pega de
    // arrasto (cursor "move"), o que mantém a caixa mais pequena.
    const togglesDiv = document.createElement('div');
    togglesDiv.style.cssText = `
      padding: 5px 8px; font-size: 11px; display: flex; flex-direction: row;
      gap: 10px; align-items: center; white-space: nowrap; cursor: move;
    `;
    togglesDiv.innerHTML = `
      <label style="display:flex; align-items:center; gap:3px; cursor:pointer; margin:0;" title="Destaca a vermelho segmentos com nomes por extenso a abreviar, abreviaturas mal feitas (ex.: 'R,' em vez de 'R.'), erros ortográficos PT-PT, ou palavras sem maiúscula">
        <input type="checkbox" id="${SCRIPT_ID}-toggle-erros" style="margin:0;" />
        <span style="color:#c00; font-weight:600;">Erros</span>
        <span id="${SCRIPT_ID}-contador-erros" style="color:#c00; font-weight:600; min-width:1em; display:none;"></span>
      </label>
      <label style="display:flex; align-items:center; gap:3px; cursor:pointer; margin:0;" title="Destaca a amarelo segmentos com nome de rua principal mas sem um alternativo que seja a versão expandida (sem abreviaturas) desse nome">
        <input type="checkbox" id="${SCRIPT_ID}-toggle-altcheck" style="margin:0;" />
        <span style="color:#a80; font-weight:600;">Alt.</span>
        <span id="${SCRIPT_ID}-contador-altcheck" style="color:#a80; font-weight:600; min-width:1em; display:none;"></span>
      </label>
      <label style="display:flex; align-items:center; gap:3px; cursor:pointer; margin:0;" title="Destaca a magenta segmentos sem cidade definida no endereço principal">
        <input type="checkbox" id="${SCRIPT_ID}-toggle-semcidade" style="margin:0;" />
        <span style="color:#c0c; font-weight:600;">Loc.</span>
        <span id="${SCRIPT_ID}-contador-semcidade" style="color:#c0c; font-weight:600; min-width:1em; display:none;"></span>
      </label>
      <label style="display:flex; align-items:center; gap:3px; cursor:pointer; margin:0;" title="Destaca a laranja segmentos cujo endereço alternativo já tem o nome certo mas a cidade errada (diferente da cidade do endereço principal)">
        <input type="checkbox" id="${SCRIPT_ID}-toggle-fixloc" style="margin:0;" />
        <span style="color:#e67e00; font-weight:600;">Fix Loc.</span>
        <span id="${SCRIPT_ID}-contador-fixloc" style="color:#e67e00; font-weight:600; min-width:1em; display:none;"></span>
      </label>
      <span style="width:1px; align-self:stretch; background:#ccc; margin:0 1px;"></span>
      <button type="button" id="${SCRIPT_ID}-btn-admin"
        title="Painel de administração"
        style="width:20px; height:20px; padding:0; margin:0; flex:none;
               display:none; align-items:center; justify-content:center;
               font-family:sans-serif; font-size:11px; line-height:1;
               border:1px solid #ccc; border-radius:3px; background:#f7f7f7;
               color:#444; cursor:pointer;">🛡</button>
      <button type="button" id="${SCRIPT_ID}-btn-proximo"
        title="Selecionar o próximo segmento destacado"
        style="width:20px; height:20px; padding:0; margin:0; flex:none;
               display:flex; align-items:center; justify-content:center;
               font-family:sans-serif; font-size:12px; line-height:1;
               border:1px solid #ccc; border-radius:3px; background:#f7f7f7;
               color:#444; cursor:pointer;">»</button>
    `;
    painel.appendChild(togglesDiv);

    const estadoGuardado = carregarEstadoToggles();
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-erros`).checked = !!estadoGuardado.erros;
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-altcheck`).checked = !!estadoGuardado.altcheck;
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-semcidade`).checked = !!estadoGuardado.semcidade;
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-fixloc`).checked = !!estadoGuardado.fixloc;

    const aoMudarToggle = () => {
      guardarEstadoToggles();
      atualizarDestaques();
    };
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-erros`).addEventListener('change', aoMudarToggle);
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-altcheck`).addEventListener('change', aoMudarToggle);
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-semcidade`).addEventListener('change', aoMudarToggle);
    togglesDiv.querySelector(`#${SCRIPT_ID}-toggle-fixloc`).addEventListener('change', aoMudarToggle);
    togglesDiv.querySelector(`#${SCRIPT_ID}-btn-proximo`).addEventListener('click', selecionarProximoDestacado);
    const btnAdmin = togglesDiv.querySelector(`#${SCRIPT_ID}-btn-admin`);
    btnAdmin.style.display = ehAdmin() ? 'flex' : 'none';
    btnAdmin.addEventListener('click', () => abrirPainelAdmin());

    document.body.appendChild(painel);
    tornarArrastavel(painel, togglesDiv);
    return painel;
  }

  // Os listeners de mousemove/mouseup são anexados APENAS durante o arrasto
  // e removidos no fim. Antes ficavam permanentemente ligados ao document,
  // o que obrigava o browser a chamar o nosso handler em cada movimento do
  // rato sobre o editor inteiro (o WME dispara mousemove continuamente ao
  // passar e ao arrastar o mapa), mesmo com o painel parado.
  //
  // Os limites do ecrã são calculados uma vez no início do arrasto: lê-los a
  // cada mousemove (offsetWidth/offsetHeight) forçava um reflow síncrono por
  // evento, o que dava um arrasto visivelmente aos solavancos.
  function tornarArrastavel(elemento, pega) {
    let offsetX = 0;
    let offsetY = 0;
    let maxX = 0;
    let maxY = 0;

    const aoMover = (e) => {
      const novoX = Math.min(Math.max(e.clientX - offsetX, 0), Math.max(maxX, 0));
      const novoY = Math.min(Math.max(e.clientY - offsetY, 0), Math.max(maxY, 0));
      elemento.style.left = `${novoX}px`;
      elemento.style.top = `${novoY}px`;
    };

    const aoLargar = () => {
      document.removeEventListener('mousemove', aoMover);
      document.removeEventListener('mouseup', aoLargar);
      const rect = elemento.getBoundingClientRect();
      guardarPosicao(Math.round(rect.top), Math.round(rect.left));
    };

    pega.addEventListener('mousedown', (e) => {
      // Não iniciar o arrasto ao clicar nos checkboxes/labels dos toggles,
      // senão o preventDefault abaixo impedia o checkbox de mudar de estado.
      if (e.target.closest('input, label, button')) return;

      const rect = elemento.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      maxX = window.innerWidth - elemento.offsetWidth;
      maxY = window.innerHeight - elemento.offsetHeight;

      document.addEventListener('mousemove', aoMover);
      document.addEventListener('mouseup', aoLargar);
      e.preventDefault();
    });
  }

  // ------------------------------------------------------------------
  // DESTAQUES NO MAPA
  // ------------------------------------------------------------------
  const CORES_DESTAQUE = {
    vermelho: '#ff0000',
    amarelo: '#ffd400',
    magenta: '#ff00ff',
    laranja: '#ff8c00',
  };

  // Tipos de via elegíveis para os toggles "Erros", "Alt." e "Fix Loc." e
  // tipos que devem ter cidade ("Loc.") — definidos pelos administradores
  // (ver TIPOS_DESATIVADOS_SET / TIPOS_COM_CIDADE_SET em reconstruirRegras).
  function tipoElegivelParaDestaque(roadType) {
    return !TIPOS_DESATIVADOS_SET.has(roadType);
  }

  // segmentId → cor actualmente aplicada. Só mexemos no DOM dos segmentos
  // que entram ou saem de destaque; antes tocava-se no elemento de TODOS os
  // segmentos em cada passagem, e o "valor original" guardado podia já estar
  // desactualizado quando era reposto (era isto que fazia segmentos
  // desaparecerem).
  let destaquesAtuais = new Map();

  function obterElementoSegmento(segmentId) {
    try {
      return sdk.Map.getFeatureDomElement({ featureId: segmentId, layerName: 'segments' });
    } catch (e) {
      return null;
    }
  }

  function aplicarDestaque(segmentId, cor) {
    const linha = obterElementoSegmento(segmentId);
    if (!linha) return;

    if (cor) {
      // O snapshot é feito no momento em que o destaque é aplicado e
      // descartado quando é retirado, por isso nunca fica velho.
      if (linha.dataset.wmeOrigSalvo !== 'true') {
        linha.dataset.wmeOrigStroke = linha.getAttribute('stroke') || '';
        linha.dataset.wmeOrigOpacity = linha.getAttribute('stroke-opacity') || '';
        linha.dataset.wmeOrigWidth = linha.getAttribute('stroke-width') || '';
        linha.dataset.wmeOrigDasharray = linha.getAttribute('stroke-dasharray') || '';
        linha.dataset.wmeOrigSalvo = 'true';
      }
      linha.setAttribute('stroke', cor);
      linha.setAttribute('stroke-opacity', '0.9');
      linha.setAttribute('stroke-width', '8');
      linha.setAttribute('stroke-dasharray', 'none');
      return;
    }

    if (linha.dataset.wmeOrigSalvo !== 'true') return; // nunca foi tocado

    restaurarAtributoOriginal(linha, 'stroke', linha.dataset.wmeOrigStroke);
    restaurarAtributoOriginal(linha, 'stroke-opacity', linha.dataset.wmeOrigOpacity);
    restaurarAtributoOriginal(linha, 'stroke-width', linha.dataset.wmeOrigWidth);
    restaurarAtributoOriginal(linha, 'stroke-dasharray', linha.dataset.wmeOrigDasharray);
    delete linha.dataset.wmeOrigStroke;
    delete linha.dataset.wmeOrigOpacity;
    delete linha.dataset.wmeOrigWidth;
    delete linha.dataset.wmeOrigDasharray;
    delete linha.dataset.wmeOrigSalvo;
  }

  function restaurarAtributoOriginal(el, nomeAtributo, valorOriginal) {
    if (valorOriginal) {
      el.setAttribute(nomeAtributo, valorOriginal);
    } else {
      el.removeAttribute(nomeAtributo);
    }
  }

  function limparTodosOsDestaques() {
    destaquesAtuais.forEach((_, segmentId) => aplicarDestaque(segmentId, null));
    destaquesAtuais = new Map();
  }

  function getToggleAltCheck() {
    return document.getElementById(`${SCRIPT_ID}-toggle-altcheck`)?.checked || false;
  }
  function getToggleErros() {
    return document.getElementById(`${SCRIPT_ID}-toggle-erros`)?.checked || false;
  }
  function getToggleSemCidade() {
    return document.getElementById(`${SCRIPT_ID}-toggle-semcidade`)?.checked || false;
  }
  function getToggleFixLoc() {
    return document.getElementById(`${SCRIPT_ID}-toggle-fixloc`)?.checked || false;
  }

  // ------------------------------------------------------------------
  // NAVEGAÇÃO PELOS SEGMENTOS DESTACADOS (botão »)
  //
  // Percorre ciclicamente os segmentos actualmente destacados: cada clique
  // selecciona o seguinte (e simula Ctrl+A para seleccionar também todos os
  // segmentos ligados com o mesmo nome); ao chegar ao fim volta ao
  // princípio.
  //
  // Guardamos o último id seleccionado E a ordem completa em que os
  // destaques apareciam nesse momento (ultimaOrdemDestaques). Quando o
  // utilizador corrige e grava um segmento, este desaparece da lista de
  // destaques — se usássemos só "o último id" para procurar a posição
  // actual, essa procura falhava (o id já não existe) e o ciclo reiniciava
  // do princípio, obrigando a saltar outra vez os segmentos já ignorados
  // propositadamente. Em vez disso, quando o último id já não está na
  // lista actual, procuramos na ORDEM ANTERIOR qual seria o próximo depois
  // dele, e avançamos para o primeiro desses que ainda esteja destacado —
  // preservando o lugar na sequência mesmo com a lista a encolher.
  // ------------------------------------------------------------------
  let ultimoSegmentoNavegado = null;
  let ultimaOrdemDestaques = [];

  function darFeedbackBotaoNavegacao(texto) {
    const botao = document.getElementById(`${SCRIPT_ID}-btn-proximo`);
    if (!botao) return;
    if (botao.dataset.textoOriginal === undefined) {
      botao.dataset.textoOriginal = botao.textContent;
    }
    botao.textContent = texto;
    clearTimeout(botao._feedbackTimeout);
    botao._feedbackTimeout = setTimeout(() => {
      botao.textContent = botao.dataset.textoOriginal;
    }, 1200);
  }

  // Activa/desactiva visualmente o botão » consoante haja ou não segmentos
  // destacados para percorrer.
  function atualizarEstadoBotaoNavegacao() {
    const botao = document.getElementById(`${SCRIPT_ID}-btn-proximo`);
    if (!botao) return;
    const algumToggleAtivo = getToggleErros() || getToggleAltCheck() || getToggleSemCidade() || getToggleFixLoc();
    const ativo = algumToggleAtivo && destaquesAtuais.size > 0;
    botao.disabled = !ativo;
    botao.style.opacity = ativo ? '1' : '0.4';
    botao.style.cursor = ativo ? 'pointer' : 'not-allowed';
    botao.title = ativo
      ? `Selecionar o próximo segmento destacado (${destaquesAtuais.size})`
      : 'Ative um dos filtros para percorrer os segmentos destacados';
  }

  // Determina qual deve ser o próximo id a seleccionar, preservando o lugar
  // na sequência mesmo que o último visitado já não esteja destacado.
  function calcularProximoDestacado(idsAtuais) {
    if (ultimoSegmentoNavegado === null) return idsAtuais[0];

    const posAtual = idsAtuais.indexOf(ultimoSegmentoNavegado);
    if (posAtual !== -1) {
      // Ainda está na lista: avança normalmente para o seguinte.
      return idsAtuais[(posAtual + 1) % idsAtuais.length];
    }

    // Já não está destacado (foi corrigido e gravado, por exemplo). Usa a
    // ordem anterior para saber o que vinha a seguir, e escolhe o primeiro
    // desses ids que ainda esteja na lista actual.
    const posAntiga = ultimaOrdemDestaques.indexOf(ultimoSegmentoNavegado);
    if (posAntiga !== -1) {
      for (let passo = 1; passo <= ultimaOrdemDestaques.length; passo++) {
        const candidato = ultimaOrdemDestaques[(posAntiga + passo) % ultimaOrdemDestaques.length];
        if (idsAtuais.includes(candidato)) return candidato;
      }
    }

    // Sem qualquer referência aproveitável: começa do início.
    return idsAtuais[0];
  }

  // Nº máximo de segmentos que ficam seleccionados depois do Ctrl+A. O WME
  // é que decide quais os segmentos ligados com o mesmo nome — nós só
  // limitamos o resultado a seguir, para não seleccionar centenas de
  // segmentos de uma vez numa rua muito longa.
  const LIMITE_SELECAO_CTRL_A = 50;

  // Simula o atalho de teclado Ctrl+A, usado pelo WME para seleccionar
  // todos os segmentos ligados com o mesmo nome de rua. Dispara em document
  // e window para chegar a qualquer listener global de teclado da app.
  function simularCtrlA() {
    const opcoes = {
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      which: 65,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    };
    ['keydown', 'keypress', 'keyup'].forEach((tipo) => {
      try {
        const evento = new KeyboardEvent(tipo, opcoes);
        document.dispatchEvent(evento);
      } catch (e) {
        LOG('Não foi possível simular Ctrl+A:', e);
      }
    });
  }

  // Corta a selecção actual para o máximo definido, se o Ctrl+A tiver
  // seleccionado mais do que isso. O segmento originalmente clicado
  // (idPrioritario) fica sempre incluído, mesmo que isso signifique
  // descartar outro para dar lugar.
  function limitarSelecaoAtual(maxSegmentos, idPrioritario) {
    try {
      const selecao = sdk.Editing.getSelection();
      if (!selecao || selecao.objectType !== 'segment' || !selecao.ids || selecao.ids.length <= maxSegmentos) {
        return;
      }

      let ids = selecao.ids.filter((id) => id !== idPrioritario);
      if (idPrioritario !== undefined && idPrioritario !== null) ids.unshift(idPrioritario);
      const limitados = ids.slice(0, maxSegmentos);

      sdk.Editing.setSelection({ selection: { ids: limitados, objectType: 'segment' } });
      darFeedbackBotaoNavegacao(`${maxSegmentos}+`);
    } catch (erro) {
      LOGE('Falha ao limitar a selecção a', maxSegmentos, 'segmentos:', erro);
    }
  }

  // Calcula o ponto médio (ao longo do comprimento, não apenas a média dos
  // vértices) de uma LineString GeoJSON. Usar o ponto médio ao longo do
  // comprimento em vez da média simples das coordenadas evita que uma
  // geometria em "L" ou muito irregular centre a vista fora da própria
  // linha.
  function pontoMedioDaLinha(coordenadas) {
    if (!Array.isArray(coordenadas) || coordenadas.length === 0) return null;
    if (coordenadas.length === 1) return coordenadas[0];

    const comprimentos = [];
    let total = 0;
    for (let i = 1; i < coordenadas.length; i++) {
      const [x1, y1] = coordenadas[i - 1];
      const [x2, y2] = coordenadas[i];
      const d = Math.hypot(x2 - x1, y2 - y1);
      comprimentos.push(d);
      total += d;
    }
    if (total === 0) return coordenadas[0];

    let alvo = total / 2;
    for (let i = 0; i < comprimentos.length; i++) {
      if (alvo <= comprimentos[i]) {
        const t = comprimentos[i] === 0 ? 0 : alvo / comprimentos[i];
        const [x1, y1] = coordenadas[i];
        const [x2, y2] = coordenadas[i + 1];
        return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      }
      alvo -= comprimentos[i];
    }
    return coordenadas[coordenadas.length - 1];
  }

  // Centra o mapa no segmento indicado, mantendo o nível de zoom actual do
  // utilizador — o objectivo é levar a vista até ao segmento, não decidir
  // por ele a que zoom deve trabalhar.
  function centrarMapaNoSegmento(segmentId) {
    try {
      const segmento = obterSegmento(segmentId);
      const coordenadas = segmento && segmento.geometry && segmento.geometry.coordinates;
      const ponto = pontoMedioDaLinha(coordenadas);
      if (!ponto) return;

      const zoomAtual = typeof sdk.Map.getZoomLevel === 'function' ? sdk.Map.getZoomLevel() : undefined;
      sdk.Map.setMapCenter({
        lonLat: { lon: ponto[0], lat: ponto[1] },
        ...(typeof zoomAtual === 'number' ? { zoomLevel: zoomAtual } : {}),
      });
    } catch (erro) {
      LOG('Não foi possível centrar o mapa no segmento:', erro);
    }
  }

  function selecionarProximoDestacado() {
    if (!sdk || !podeUsarDestaques()) return;

    const algumToggleAtivo = getToggleErros() || getToggleAltCheck() || getToggleSemCidade() || getToggleFixLoc();
    if (!algumToggleAtivo) {
      darFeedbackBotaoNavegacao('–');
      return;
    }

    const idsAtuais = [...destaquesAtuais.keys()];
    if (!idsAtuais.length) {
      darFeedbackBotaoNavegacao('–');
      return;
    }

    const proximo = calcularProximoDestacado(idsAtuais);

    try {
      sdk.Editing.setSelection({ selection: { ids: [proximo], objectType: 'segment' } });
      ultimoSegmentoNavegado = proximo;
      ultimaOrdemDestaques = idsAtuais;
      centrarMapaNoSegmento(proximo);

      // Pequeno atraso para dar tempo à selecção de assentar antes de
      // simular o atalho que selecciona os segmentos ligados com o mesmo
      // nome, e outro depois disso para dar tempo ao WME de processar o
      // atalho antes de verificarmos e limitarmos o tamanho da selecção.
      setTimeout(() => {
        simularCtrlA();
        setTimeout(() => limitarSelecaoAtual(LIMITE_SELECAO_CTRL_A, proximo), 150);
      }, 80);
    } catch (erro) {
      LOGE('Falha ao seleccionar o segmento destacado:', erro);
      darFeedbackBotaoNavegacao('✖');
    }
  }

  function atualizarContadorToggle(nomeToggle, ativo, contagem) {
    const span = document.getElementById(`${SCRIPT_ID}-contador-${nomeToggle}`);
    if (!span) return;
    if (ativo) {
      span.textContent = String(contagem);
      span.style.display = 'inline';
    } else {
      span.textContent = '';
      span.style.display = 'none';
    }
  }

  // Uma única chamada a getAddress por segmento (antes eram duas: uma para o
  // nome, outra para a cidade). Inclui também o countryId, usado pelo
  // filtro de país (ver paisEhPortugal).
  function obterEnderecoPrincipal(segmentId) {
    try {
      const endereco = sdk.DataModel.Segments.getAddress({ segmentId });
      if (!endereco) return null;
      const cidade = endereco.city;
      const pais = endereco.country;
      return {
        streetName: endereco.street ? endereco.street.name : null,
        cityId: cidade ? cidade.id : undefined,
        countryId: pais ? pais.id : undefined,
        semCidade: !cidade || cidade.isEmpty === true,
      };
    } catch (e) {
      LOG('Erro em getAddress:', e);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // FILTRO POR PAÍS
  //
  // Este script normaliza endereços segundo as convenções de Portugal; não
  // faz sentido (e pode ser mesmo prejudicial) aplicá-lo a segmentos de
  // outro país — ex.: uma conta com permissões em vários países, ou um
  // segmento perto de uma fronteira. Comparamos por abreviatura/nome em vez
  // de um id fixo, porque o id de país não está documentado como estável
  // entre ambientes (produção/beta) e confiar num número adivinhado seria
  // mais frágil do que perguntar à própria SDK. Mesma lógica do WazePT
  // Suite, para consistência entre scripts.
  //
  // Sem dados de país (countryId indisponível) o script NÃO bloqueia — é o
  // comportamento anterior a esta funcionalidade, para uma falha a obter o
  // país não desligar o script silenciosamente por completo.
  // ------------------------------------------------------------------
  const cachePaisPortugal = new Map(); // countryId → boolean

  function paisEhPortugal(countryId) {
    if (countryId === undefined || countryId === null) return true;
    if (cachePaisPortugal.has(countryId)) return cachePaisPortugal.get(countryId);

    let ehPT = true;
    try {
      const pais = sdk.DataModel.Countries.getById({ countryId });
      if (pais) {
        const candidatos = [pais.abbr, pais.name, pais.englishName]
          .filter(Boolean)
          .map((v) => String(v).trim().toLowerCase());
        ehPT = candidatos.includes('pt') || candidatos.includes('portugal');
      }
    } catch (e) {
      LOG('Não foi possível determinar o país do segmento (id', countryId, '):', e);
    }

    cachePaisPortugal.set(countryId, ehPT);
    return ehPT;
  }

  // Resolve as ruas alternativas UMA vez e devolve tanto os objectos como os
  // nomes já normalizados. Com os toggles "Alt." e "Fix Loc." ambos ligados,
  // o ciclo de destaques resolvia a mesma lista de alternateStreetIds duas
  // vezes por segmento (uma para os nomes, outra para os objectos), ou seja
  // o dobro das chamadas Streets.getById necessárias.
  function obterAlternativasResolvidas(segment) {
    const ruas = obterRuasAlternativas(segment);
    const nomes = [];
    for (const r of ruas) {
      if (r && r.name) nomes.push(normalizarParaComparar(r.name));
    }
    return { ruas, nomes };
  }

  // Devolve os objectos completos das ruas alternativas (id, name, cityId),
  // necessário para o "Fix Loc." — comparar a cidade de cada alternativa
  // com a cidade do endereço principal, não só o nome.
  function obterRuasAlternativas(segment) {
    const ids = segment.alternateStreetIds || [];
    const ruas = [];
    for (const streetId of ids) {
      try {
        const street = sdk.DataModel.Streets.getById({ streetId });
        if (street) ruas.push(street);
      } catch (e) { /* ids que não resolvem */ }
    }
    return ruas;
  }

  // Entre as ruas alternativas, procura as que têm o MESMO nome (já
  // expandido/normalizado) do endereço principal mas uma cidade DIFERENTE —
  // o caso que o "Fix Loc." detecta e o botão "Alternativo" corrige.
  function obterAlternativasComCidadeErrada(ruasAlt, nomeExpandidoNormalizado, cityIdPrincipal) {
    return ruasAlt.filter((r) => (
      normalizarParaComparar(r.name) === nomeExpandidoNormalizado && r.cityId !== cityIdPrincipal
    ));
  }

  function atualizarDestaques() {
    if (!sdk) return;

    const altCheckAtivo = getToggleAltCheck();
    const errosAtivo = getToggleErros();
    const semCidadeAtivo = getToggleSemCidade();
    const fixLocAtivo = getToggleFixLoc();

    // Sem a permissão "Destaques" (ou sem regras carregadas) é como se os
    // toggles estivessem todos desligados.
    const semDestaques = !podeUsarDestaques() || !dadosDisponiveis();
    if (semDestaques || (!altCheckAtivo && !errosAtivo && !semCidadeAtivo && !fixLocAtivo)) {
      limparTodosOsDestaques();
      atualizarContadorToggle('erros', false, 0);
      atualizarContadorToggle('altcheck', false, 0);
      atualizarContadorToggle('semcidade', false, 0);
      atualizarContadorToggle('fixloc', false, 0);
      ultimoSegmentoNavegado = null;
      ultimaOrdemDestaques = [];
      atualizarEstadoBotaoNavegacao();
      atualizarPainelDeEdicao();
      return;
    }

    let segments;
    try {
      segments = sdk.DataModel.Segments.getAll();
    } catch (e) {
      LOGE('Erro ao obter todos os segmentos:', e);
      return;
    }

    // Abre a cache de permissões só para esta passagem (ver podeEditar).
    cachePermissoes = new Map();
    try {
      calcularDestaques(segments, { altCheckAtivo, errosAtivo, semCidadeAtivo, fixLocAtivo });
    } finally {
      cachePermissoes = null;
    }
  }

  function calcularDestaques(segments, { altCheckAtivo, errosAtivo, semCidadeAtivo, fixLocAtivo }) {

    const novosDestacados = new Map();
    let contadorErros = 0;
    let contadorAlt = 0;
    let contadorSemCidade = 0;
    let contadorFixLoc = 0;
    const naoDestacarBloqueados = !!prefs.naoDestacarBloqueados;
    // Por omissão TRUE: só usa !== false para que o valor por omissão
    // continue a ser "ligado" mesmo sem a chave guardada.
    const soComCidade = prefs.soDestacarComCidade !== false;

    segments.forEach((segment) => {
      // Ignora por completo segmentos acima do nível do utilizador quando a
      // opção está activa — só verifica a permissão quando necessário, para
      // não pagar este custo extra por segmento quando a opção está desligada.
      if (naoDestacarBloqueados && !podeEditar(segment.id)) return;

      const info = obterEnderecoPrincipal(segment.id);

      // Fora de Portugal: o script nunca destaca nem corrige, seja qual for
      // o toggle activo (inclui o "Loc.", que de outro modo não passaria
      // pelos filtros abaixo, que dependem de nome de rua).
      if (info && !paisEhPortugal(info.countryId)) return;

      const streetName = info ? info.streetName : null;
      const temNomeReal = !nomeRuaVazioOuNenhum(streetName);
      const tipoExcluido = !tipoElegivelParaDestaque(segment.roadType);
      // "Erros", "Alt." e "Fix Loc." só se aplicam a segmentos com cidade
      // definida quando esta opção está activa (por omissão está) — "Fix
      // Loc." precisa sempre de uma cidade principal válida para saber qual
      // é a cidade "certa" a corrigir.
      const elegivelComCidade = !soComCidade || !(info && info.semCidade);

      let temErroDetetado = false;
      let faltaAltExpandido = false;
      let semCidade = false;
      let temFixLoc = false;

      const analise = (temNomeReal && (errosAtivo || altCheckAtivo || fixLocAtivo) && !tipoExcluido && elegivelComCidade)
        ? analisarNome(streetName)
        : null;

      if (analise && errosAtivo) {
        temErroDetetado = analise.precisaCorreccao;
        if (temErroDetetado) contadorErros++;
      }

      // As ruas alternativas são resolvidas no máximo uma vez por segmento e
      // partilhadas pelas verificações "Alt." e "Fix Loc.", que antes faziam
      // cada uma a sua própria ronda de Streets.getById sobre a mesma lista.
      let alternativas = null;
      const precisaAlternativas = analise && analise.temAbreviaturas
        && (altCheckAtivo || (fixLocAtivo && info && !info.semCidade));
      if (precisaAlternativas) alternativas = obterAlternativasResolvidas(segment);

      if (alternativas && altCheckAtivo) {
        faltaAltExpandido = !alternativas.nomes.includes(analise.expandidoNormalizado);
        if (faltaAltExpandido) contadorAlt++;
      }

      // "Fix Loc." exige mesmo uma cidade definida no principal, para além
      // do que "soComCidade" já garante — sem isso não há "cidade certa"
      // com que comparar.
      if (alternativas && fixLocAtivo && info && !info.semCidade) {
        const erradas = obterAlternativasComCidadeErrada(alternativas.ruas, analise.expandidoNormalizado, info.cityId);
        temFixLoc = erradas.length > 0;
        if (temFixLoc) contadorFixLoc++;
      }

      if (semCidadeAtivo && info && temNomeReal) {
        const eRotunda = segment.junctionId != null;
        if (!eRotunda && TIPOS_COM_CIDADE_SET.has(segment.roadType)) {
          semCidade = info.semCidade;
          if (semCidade) contadorSemCidade++;
        }
      }

      // Prioridade: sem cidade (magenta) > fix loc (laranja) > erros (vermelho) > falta alt. (amarelo)
      let cor = null;
      if (semCidade) cor = CORES_DESTAQUE.magenta;
      else if (temFixLoc) cor = CORES_DESTAQUE.laranja;
      else if (temErroDetetado) cor = CORES_DESTAQUE.vermelho;
      else if (faltaAltExpandido) cor = CORES_DESTAQUE.amarelo;

      if (cor) {
        // Reaplicamos sempre aos que devem estar destacados: o WME recria os
        // elementos SVG ao redesenhar o mapa e o estilo perder-se-ia.
        aplicarDestaque(segment.id, cor);
        novosDestacados.set(segment.id, cor);
      }
    });

    // Só toca no DOM dos que deixaram de estar destacados.
    destaquesAtuais.forEach((_, segmentId) => {
      if (!novosDestacados.has(segmentId)) aplicarDestaque(segmentId, null);
    });
    destaquesAtuais = novosDestacados;

    atualizarContadorToggle('erros', errosAtivo, contadorErros);
    atualizarContadorToggle('altcheck', altCheckAtivo, contadorAlt);
    atualizarContadorToggle('semcidade', semCidadeAtivo, contadorSemCidade);
    atualizarContadorToggle('fixloc', fixLocAtivo, contadorFixLoc);
    atualizarEstadoBotaoNavegacao();

    atualizarPainelDeEdicao();
  }

  function atualizarPainelDeEdicao() {
    const segmentPanel = document.getElementById('segment-edit-general');
    if (!segmentPanel) {
      removerOverlayPalavras();
      return;
    }
    const selecao = safeGetSelection();
    if (selecao && selecao.objectType === 'segment' && selecao.ids && selecao.ids.length) {
      const info = obterEnderecoPrincipal(selecao.ids[0]);
      if (info && !paisEhPortugal(info.countryId)) {
        removerAviso();
        removerOverlayPalavras();
        return;
      }
      const nome = info ? info.streetName : null;
      atualizarAvisoAbreviatura(nome);
      atualizarDestaquePalavras(segmentPanel, nome);
    } else {
      removerAviso();
      removerOverlayPalavras();
    }
  }

  function debounce(fn, espera) {
    let temporizador;
    return function (...args) {
      clearTimeout(temporizador);
      temporizador = setTimeout(() => fn(...args), espera);
    };
  }

  const atualizarDestaquesComAtraso = debounce(atualizarDestaques, 300);

  // ------------------------------------------------------------------
  // LÓGICA PRINCIPAL (WME SDK)
  // ------------------------------------------------------------------
  let sdk = null;

  // ------------------------------------------------------------------
  // BLOQUEIO DO ATALHO NATIVO "R" (inverter direcção do segmento)
  //
  // O WME usa a tecla "R" (sem modificadores) como atalho nativo para
  // alternar a direcção de circulação do segmento seleccionado. Isto é
  // perigoso em conjunto com os botões deste script: ao clicar em
  // "Corrigir/Abreviar" ou "Alternativo", o script simula Ctrl+A para
  // aplicar a correcção a todos os segmentos ligados com o mesmo nome, e
  // essa selecção alargada fica activa depois do clique. Se a próxima
  // tecla premida pelo utilizador for "R" — por hábito, ou por engano —
  // TODOS os segmentos selecionados (nalguns casos dezenas) têm a sua
  // direcção invertida silenciosamente, sem qualquer aviso visual, já que
  // o painel não distingue 1 segmento seleccionado de 300.
  //
  // Para eliminar este risco, este script intercepta o "R" na fase de
  // CAPTURA (antes de chegar aos listeners do próprio WME) sempre que o
  // painel de edição de segmento estiver aberto, e cancela o evento por
  // completo. O atalho só é bloqueado quando:
  //   • a tecla é literalmente "r"/"R", sem Ctrl/Alt/Meta (para não
  //     interferir com outros atalhos como Ctrl+R, usados pelo browser);
  //   • o foco não está num campo de texto/edição (para não impedir a
  //     pessoa de escrever a letra "r" num nome de rua, ex.: "Rua");
  //   • existe de facto um painel de edição de segmento aberto.
  // Fora dessas condições o evento segue o seu caminho normal.
  // ------------------------------------------------------------------
  function elementoEhCampoDeTexto(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    // Componentes Web do WME (ex.: <wz-input>) escondem o <input> real no
    // shadow DOM; se o foco activo estiver dentro de um shadow root,
    // verifica-se também o elemento activo desse shadow root.
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      return elementoEhCampoDeTexto(el.shadowRoot.activeElement);
    }
    return false;
  }

  function segmentoEmEdicao() {
    return !!document.getElementById('segment-edit-general');
  }

  function bloquearAtalhoInversaoDirecao(evento) {
    if (evento.defaultPrevented) return;
    // Só faz sentido para quem tem os botões (que simulam Ctrl+A).
    if (!editorAutorizado()) return;
    if (evento.ctrlKey || evento.altKey || evento.metaKey) return;
    if (evento.key !== 'r' && evento.key !== 'R') return;
    if (elementoEhCampoDeTexto(document.activeElement)) return;
    if (!segmentoEmEdicao()) return;

    evento.preventDefault();
    evento.stopPropagation();
    if (typeof evento.stopImmediatePropagation === 'function') {
      evento.stopImmediatePropagation();
    }
    LOG('Atalho "R" (inverter direcção) bloqueado por segurança durante a edição de segmento.');
  }

  let listenerBloqueioRAtivo = false;

  function ativarBloqueioAtalhoR() {
    if (listenerBloqueioRAtivo) return;
    // A fase de captura (true) é essencial: garante que este handler corre
    // ANTES dos listeners de teclado do próprio WME, que normalmente estão
    // ligados a document/window na fase de propagação normal.
    document.addEventListener('keydown', bloquearAtalhoInversaoDirecao, true);
    listenerBloqueioRAtivo = true;
    LOG('Bloqueio do atalho "R" (inverter direcção) activado.');
  }

  function init() {
    LOG('init() chamado, a obter a SDK...');
    prefs = carregarPrefs();
    reconstruirRegras(null);
    try {
      sdk = UW.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
    } catch (e) {
      LOGE('Erro ao obter a SDK:', e);
      return;
    }

    sdk.Events.once({ eventName: 'wme-ready' }).then(async () => {
      LOG('Evento wme-ready recebido.');

      // Independente do acesso e das regras.
      iniciarVerificacaoAtualizacoes();

      // Acesso e regras em paralelo. Normalmente resolvem da cache local,
      // quase instantâneo; só esperam pela rede na primeira vez ou quando
      // a cache expirou (1 h para o acesso, 24 h para as regras).
      await Promise.all([refreshAllowlistState(), carregarDados()]);
      LOG(`Editor ${editorAutorizado() ? 'autorizado' : 'NÃO autorizado'}; regras ${dadosDisponiveis() ? `rev ${dadosEstado.rev}` : 'indisponíveis'}.`);

      registarSeparador();
      ativarBloqueioAtalhoR();

      // O handler verifica a permissão "Destaques" a cada chamada, por isso
      // pode ficar sempre ligado (as permissões podem mudar na sessão).
      sdk.Events.on({
        eventName: 'wme-map-data-loaded',
        eventHandler: atualizarDestaquesComAtraso,
      });

      // O painel de edição nem sempre é recriado ao mudar de segmento — o
      // MutationObserver sozinho podia deixar a pré-visualização a mostrar o
      // segmento anterior.
      try {
        sdk.Events.on({
          eventName: 'wme-selection-changed',
          eventHandler: aoMudarSelecao,
        });
      } catch (e) {
        LOG('Evento wme-selection-changed indisponível nesta versão da SDK.');
      }

      // wme-feature-editor-opened dispara quando o painel abre para uma
      // feature NOVA (ex.: segmento ainda por gravar, ID negativo) ou quando
      // a selecção muda.
      try {
        sdk.Events.on({
          eventName: 'wme-feature-editor-opened',
          eventHandler: aoAbrirEditorFeature,
        });
      } catch (e) {
        LOG('Evento wme-feature-editor-opened indisponível nesta versão da SDK.');
      }

      // Eventos do modelo de dados: disparam quando o ENDEREÇO do segmento
      // é de facto alterado — essencial para segmentos novos, cujo nome é
      // escrito no mesmo painel já aberto.
      try {
        sdk.Events.trackDataModelEvents({ dataModelName: 'segments' });
        sdk.Events.on({
          eventName: 'wme-data-model-objects-changed',
          eventHandler: aoSegmentoAlterado,
        });
      } catch (e) {
        LOG('Eventos do modelo de dados para "segments" indisponíveis:', e);
      }

      observeEditPanel();
      aplicarEstadoAcesso();
      iniciarVerificacaoPeriodica();
    });
  }

  function aoMudarSelecao() {
    removerOverlayPalavras();
    const segmentPanel = document.getElementById('segment-edit-general');
    if (segmentPanel) {
      handleSegmentPanel(segmentPanel);
    } else {
      removerAviso();
    }
  }

  // Dá tempo ao WME para desenhar o painel antes de o procurarmos — este
  // evento pode disparar um instante antes do nó aparecer no DOM.
  function aoAbrirEditorFeature() {
    setTimeout(() => {
      const segmentPanel = document.getElementById('segment-edit-general');
      if (segmentPanel) handleSegmentPanel(segmentPanel);
    }, 50);
  }

  // Reage a alterações reais nos atributos de qualquer segmento (inclui o
  // endereço). Só nos interessa quando o segmento alterado é o que está
  // actualmente seleccionado — outros segmentos a mudar (ex.: outro editor,
  // ou o próprio split ao criar uma rua) não devem mexer no nosso painel.
  function aoSegmentoAlterado({ dataModelName, objectIds }) {
    if (dataModelName !== 'segments') return;
    const selecao = safeGetSelection();
    if (!selecao || selecao.objectType !== 'segment' || !selecao.ids || !selecao.ids.length) return;

    const idsAlterados = new Set(objectIds);
    if (!selecao.ids.some((id) => idsAlterados.has(id))) return;

    const segmentPanel = document.getElementById('segment-edit-general');
    if (segmentPanel) handleSegmentPanel(segmentPanel);
    if (podeUsarDestaques()) atualizarDestaquesComAtraso();
  }

  function safeGetSelection() {
    try {
      return sdk.Editing.getSelection();
    } catch (e) {
      LOG('getSelection() lançou erro:', e.message || e);
      return null;
    }
  }

  function obterSegmento(segmentId) {
    try {
      if (sdk.DataModel.Segments.getById) {
        return sdk.DataModel.Segments.getById({ segmentId });
      }
    } catch (e) { /* cai para o getAll */ }
    try {
      return sdk.DataModel.Segments.getAll().find((s) => s.id === segmentId) || null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // INJEÇÃO DOS BOTÕES NO PAINEL DE EDIÇÃO
  // ------------------------------------------------------------------
  const BOTOES_MARCADOR = `data-${SCRIPT_ID}-botoes`;
  const BLOQUEADO_MARCADOR = `data-${SCRIPT_ID}-bloqueado`;
  const MAX_TENTATIVAS_PAINEL = 60;

  // O nó de painel de segmento que já foi processado. Serve de guarda para
  // não voltar a correr handleSegmentPanel a cada mutação do DOM quando
  // nada mudou de facto.
  let painelSegmentoProcessado = null;

  // O observador tem de estar ligado a document.body e NÃO a #edit-panel: o
  // WME substitui o #edit-panel inteiro (não só o seu conteúdo) em várias
  // transições da interface, e um observador ligado ao nó antigo fica órfão
  // a observar um elemento já destacado da página — a partir daí os botões
  // deixavam simplesmente de ser injectados, sem erro nenhum na consola.
  //
  // Observar o body inteiro é muito mais ruidoso, por isso o callback é
  // deliberadamente barato: uma única chamada a getElementById por lote de
  // mutações (em vez de um querySelector por nó adicionado, como antes) e
  // saída imediata quando o painel é o mesmo de há pouco.
  function observeEditPanel(tentativa = 0) {
    if (!document.body) {
      if (tentativa >= MAX_TENTATIVAS_PAINEL) {
        LOGE('document.body não apareceu; o script não vai injectar os botões.');
        return;
      }
      setTimeout(() => observeEditPanel(tentativa + 1), 250);
      return;
    }

    const observer = new MutationObserver(() => {
      const painel = document.getElementById('segment-edit-general');

      if (!painel) {
        // Painel fechado → limpar a camada sobreposta e os avisos, que vivem
        // no <body> e de outra forma ficavam órfãos por cima do mapa.
        if (painelSegmentoProcessado) {
          painelSegmentoProcessado = null;
          removerOverlayPalavras();
          removerAviso();
        }
        return;
      }

      // Mesmo nó de painel já tratado: nada a fazer. Isto também garante
      // que a inserção dos nossos próprios botões/avisos (que dispara novas
      // mutações) não provoca um ciclo infinito.
      if (painel === painelSegmentoProcessado) return;

      painelSegmentoProcessado = painel;
      handleSegmentPanel(painel);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    LOG('A observar o document.body à procura do painel de segmento.');
  }

  const handleSegmentPanelComAtraso = debounce(handleSegmentPanel, 300);

  // Novos segmentos (ainda por gravar, com ID negativo) abrem o painel sem
  // nome de rua definido, por isso handleSegmentPanel sai logo no início e
  // os botões não aparecem. Só voltaríamos a correr esta função quando a
  // SELECÇÃO muda ou quando o WME insere um NOVO nó #segment-edit-general —
  // nenhum dos dois acontece enquanto a pessoa escreve o nome da rua no
  // mesmo painel já aberto. Para cobrir isso, ouvimos alterações nos campos
  // do próprio painel ('input' com atraso para feedback ao vivo, e
  // 'change'/'blur' imediatos como rede de segurança) e voltamos a correr a
  // verificação. O marcador evita anexar o mesmo listener duas vezes caso
  // este nó de painel seja reaproveitado pelo WME.
  function garantirListenerAlteracaoEndereco(segmentPanel) {
    if (segmentPanel.dataset.wmeListenerEndereco === 'true') return;
    segmentPanel.dataset.wmeListenerEndereco = 'true';

    segmentPanel.addEventListener('input', () => handleSegmentPanelComAtraso(segmentPanel));
    segmentPanel.addEventListener('change', () => handleSegmentPanel(segmentPanel), true);
    segmentPanel.addEventListener('blur', () => handleSegmentPanel(segmentPanel), true);
  }

  function handleSegmentPanel(segmentPanel) {
    // Mantém o observador em sincronia quando esta função é chamada
    // directamente (mudança de selecção, abertura do editor, alteração do
    // segmento), para o observador não repetir logo a seguir o mesmo trabalho.
    painelSegmentoProcessado = segmentPanel;

    garantirListenerAlteracaoEndereco(segmentPanel);
    removeExistingButtons(segmentPanel);

    const selecao = safeGetSelection();
    if (!selecao || selecao.objectType !== 'segment' || !selecao.ids || !selecao.ids.length) return;

    const info = obterEnderecoPrincipal(selecao.ids[0]);
    // Fora de Portugal: não injecta os botões nem avisos — o script
    // simplesmente não se aplica a este segmento.
    if (info && !paisEhPortugal(info.countryId)) return;

    if (!info || !info.streetName) return;

    // Sem regras nenhumas (sem cache nem rede): não sugere nada, avisa.
    if (!dadosDisponiveis()) {
      inserirAvisoSemDados(segmentPanel);
      return;
    }

    injectButtons(segmentPanel, info.streetName, segmentoAcimaDoNivel(selecao.ids));
  }

  // Cache com o tempo de vida de UMA passagem dos destaques. hasPermissions
  // é uma chamada à SDK por segmento e, com a opção "não destacar
  // bloqueados" ligada, corria para todos os segmentos carregados em cada
  // actualização do mapa. Não é guardada entre passagens de propósito: as
  // permissões podem mudar (mudança de área de edição, promoção de nível)
  // e uma cache persistente ficaria desactualizada sem aviso.
  let cachePermissoes = null;

  function podeEditar(segmentId) {
    if (cachePermissoes && cachePermissoes.has(segmentId)) return cachePermissoes.get(segmentId);

    let permitido;
    try {
      permitido = sdk.DataModel.Segments.hasPermissions({ segmentId, permission: 'EDIT_PROPERTIES' });
    } catch (e) {
      permitido = true;
    }

    if (cachePermissoes) cachePermissoes.set(segmentId, permitido);
    return permitido;
  }

  function segmentoAcimaDoNivel(segmentIds) {
    if (!sdk || !segmentIds || !segmentIds.length) return false;
    return segmentIds.some((segmentId) => !podeEditar(segmentId));
  }

  // ------------------------------------------------------------------
  // AVISOS NO PAINEL DE EDIÇÃO
  // ------------------------------------------------------------------
  const AVISO_MARCADOR = `data-${SCRIPT_ID}-aviso`;
  function removerAviso() {
    document.querySelectorAll(`[${AVISO_MARCADOR}="true"]`).forEach((el) => el.remove());
  }

  // Verde claro para assinalar visualmente que o botão tem algo por fazer;
  // '' (vazio) repõe o estilo por omissão do wz-button. Nunca mexe num
  // botão desactivado (segmento acima do nível do utilizador já tem a sua
  // própria cor de aviso, que não deve ser substituída).
  const COR_BOTAO_DISPONIVEL = '#c8e6c9';
  // Laranja para o botão "Alternativo" quando o alternativo já existe com o
  // nome certo mas a cidade errada (caso do "Fix Loc.").
  const COR_BOTAO_FIXLOC = '#ffcc80';

  function definirCorPersistenteBotao(botao, ativo) {
    if (!botao || botao.disabled) return;
    botao.style.background = ativo ? COR_BOTAO_DISPONIVEL : '';
  }

  // Desactiva/reactiva os botões de forma REVERSÍVEL (ex.: por causa da
  // ambiguidade do "Imp.", que pode desaparecer assim que o utilizador
  // corrigir o endereço manualmente). Nunca mexe num botão com bloqueio
  // PERMANENTE (segmento acima do nível do utilizador — ver desabilitarBotao).
  function definirDesativacaoTemporaria(botao, desativar) {
    if (!botao || botao.dataset.wmeBloqueadoPermanente === 'true') return;

    if (desativar) {
      if (botao.dataset.wmeDesativadoTemp === 'true') return;
      botao.dataset.wmeDesativadoTemp = 'true';
      botao.disabled = true;
      botao.style.pointerEvents = 'none';
      botao.style.cursor = 'not-allowed';
      botao.style.opacity = '0.6';
      botao.style.background = '#ffe0b2';
      botao.style.color = '#8a5a00';
      botao.style.border = '1px solid #cc8400';
    } else if (botao.dataset.wmeDesativadoTemp === 'true') {
      delete botao.dataset.wmeDesativadoTemp;
      botao.disabled = false;
      botao.style.pointerEvents = '';
      botao.style.cursor = '';
      botao.style.opacity = '';
      botao.style.background = '';
      botao.style.color = '';
      botao.style.border = '';
    }
  }

  // Ordinais que abrem um nome de rua e funcionam como parte do próprio
  // tipo de via ("1º Imp.", "2º Imp."). Só as formas masculinas: "Impasse"
  // é masculino, por isso "1ª Imp." não é uma construção válida. Aceita
  // tanto a forma abreviada ("1º") como a forma por extenso ("Primeiro"),
  // porque o script converte entre as duas.
  const RE_ORDINAL_ABREVIADO = /^\d+º$/;
  const ORDINAIS_POR_EXTENSO = new Set([
    'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto',
    'sexto', 'setimo', 'oitavo', 'nono', 'decimo',
  ]);

  function ehOrdinalDeTipoDeVia(palavra) {
    if (!palavra) return false;
    if (RE_ORDINAL_ABREVIADO.test(palavra)) return true;
    return ORDINAIS_POR_EXTENSO.has(normalizarParaComparar(palavra));
  }

  // "Imp." fora da primeira palavra é ambíguo: antes era usado tanto para
  // "Impasse" (tipo de via, sempre a primeira palavra) como, por vezes,
  // como resquício de "Imperador" — que agora tem a sua própria abreviatura
  // "Imper.". Quando "Imp." aparece depois da primeira palavra já não se
  // sabe a qual das duas se refere, por isso exige-se correcção manual em
  // vez de tentar adivinhar.
  //
  // Excepção: um ordinal a abrir o nome faz parte do tipo de via, por isso
  // o "Imp." logo a seguir é necessariamente "Impasse" — "1º Imp. do Cabo"
  // é um endereço legítimo e não deve ser assinalado. Já "R. do Imp.
  // Martins" continua ambíguo (Imperador ou Impasse?) e mantém o aviso.
  function temImpAmbiguoForaDaPrimeira(mascarado) {
    const partes = mascarado.trim().split(/\s+/);
    for (let i = 1; i < partes.length; i++) {
      if (!/^Imp\.$/i.test(partes[i])) continue;
      if (i === 1 && ehOrdinalDeTipoDeVia(partes[0])) continue;
      return true;
    }
    return false;
  }

  const AVISO_IMP_AMBIGUO =
    '⚠️ ATENÇÃO! a abreviatura Imp. de Imperador passou a ser Imper. e Imp. passou a ser Impasse, ' +
    'Verifique qual palavra se trata para criar o endereço alternativo correto. Fazer correção manual ' +
    'dos dois endereços conforme as novas abreviaturas. ⚠️';

  function atualizarAvisoAbreviatura(streetName) {
    removerAviso();

    const container = document.querySelector(`[${BOTOES_MARCADOR}="true"]`);
    if (!container || !container.parentNode) return;

    const botaoCorrigir = document.getElementById(`${SCRIPT_ID}-btn-corrigir`);
    const botaoAlternativo = document.getElementById(`${SCRIPT_ID}-btn-alternativo`);

    if (!streetName || nomeRuaVazioOuNenhum(streetName)) {
      definirCorPersistenteBotao(botaoCorrigir, false);
      definirCorPersistenteBotao(botaoAlternativo, false);
      definirDesativacaoTemporaria(botaoCorrigir, false);
      definirDesativacaoTemporaria(botaoAlternativo, false);
      return;
    }

    const { mascarado: nomeMascarado } = mascararAspas(streetName);

    if (temImpAmbiguoForaDaPrimeira(nomeMascarado)) {
      definirDesativacaoTemporaria(botaoCorrigir, true);
      definirDesativacaoTemporaria(botaoAlternativo, true);

      const aviso = document.createElement('div');
      aviso.setAttribute(AVISO_MARCADOR, 'true');
      aviso.style.cssText = `
        font-size: 11px; font-family: sans-serif; font-weight: 700;
        line-height: 1.35; word-break: break-word;
        margin: -2px 0 4px 0; padding: 3px 6px;
        border-radius: 0 3px 3px 0; color:#8a5a00; border-left:3px solid #cc8400; background:#fff3e0;
      `;
      aviso.textContent = AVISO_IMP_AMBIGUO;
      container.insertAdjacentElement('afterend', aviso);
      return;
    }

    definirDesativacaoTemporaria(botaoCorrigir, false);
    definirDesativacaoTemporaria(botaoAlternativo, false);

    const avisos = [];
    let precisaCorrigir = false;
    let faltaAlternativo = false;
    let precisaFixLoc = false;

    if (temAbreviaturaDesconhecida(streetName)) {
      avisos.push({
        html: nomeComAlvosDestacadosHTML(streetName, true).html,
        estiloExtra: 'color:#333; border-left:3px solid #c00; background:#fff0f0;',
      });
      avisos.push({
        texto: '⚠️ Possível abreviatura inadequada. Verificar e corrigir manualmente ⚠️',
        estiloExtra: 'color:#c00; border-left:3px solid #c00; background:#fff0f0;',
      });
    } else {
      const analise = analisarNome(streetName);

      if (analise.corrigido !== streetName) {
        precisaCorrigir = true;
        avisos.push({
          html: nomeComAlvosDestacadosHTML(streetName, false).html,
          estiloExtra: 'color:#333; border-left:3px solid #1a7a1a; background:#f0fff0;',
        });
        avisos.push({
          texto: `✓ Corrigir para: "${analise.corrigido}"`,
          estiloExtra: 'color:#1a7a1a; border-left:3px solid #1a7a1a; background:#f0fff0;',
        });
      }

      if (analise.temAbreviaturas) {
        const selecao = safeGetSelection();
        if (selecao && selecao.objectType === 'segment' && selecao.ids && selecao.ids.length) {
          const seg = obterSegmento(selecao.ids[0]);
          if (seg && tipoElegivelParaDestaque(seg.roadType)) {
            // Resolvidas uma só vez: o ramo do "Fix Loc." precisava dos
            // objectos das ruas e voltava a pedi-los à SDK depois de já ter
            // pedido os nomes.
            const alternativas = obterAlternativasResolvidas(seg);
            if (!alternativas.nomes.includes(analise.expandidoNormalizado)) {
              faltaAlternativo = true;
              avisos.push({
                texto: `✓ Criar alternativo: "${analise.expandido}"`,
                estiloExtra: 'color:#1a7a1a; border-left:3px solid #1a7a1a; background:#f0fff0;',
              });
            } else {
              // O nome já existe entre os alternativos — verifica se é com
              // a cidade certa (caso contrário, é o cenário do "Fix Loc.").
              const infoPrincipal = obterEnderecoPrincipal(selecao.ids[0]);
              if (infoPrincipal && !infoPrincipal.semCidade) {
                const erradas = obterAlternativasComCidadeErrada(alternativas.ruas, analise.expandidoNormalizado, infoPrincipal.cityId);
                if (erradas.length) {
                  precisaFixLoc = true;
                  avisos.push({
                    texto: `⚠ O alternativo "${analise.expandido}" tem uma cidade diferente da do endereço principal — clique em "Alternativo" para corrigir`,
                    estiloExtra: 'color:#a05a00; border-left:3px solid #e67e00; background:#fff3e0;',
                  });
                  avisos.push({
                    texto: 'Atenção! pode existir um motivo pela qual este segmento tenha mais do que uma localidade diferente no endereço alternativo, há situações que localidades partilham a mesma rua e porém o segmento contém duas localidades, consultar o AM local a um CM antes de editar.',
                    estiloExtra: 'color:#a05a00; border-left:3px solid #e67e00; background:#fff3e0;',
                  });
                }
              }
            }
          }
        }
      }
    }

    // O botão Corrigir fica verde sempre que há algo a corrigir. O botão
    // Alternativo fica verde quando falta criar o alternativo, ou LARANJA
    // quando já existe mas com a cidade errada — em ambos os casos só
    // quando NÃO há correcção pendente (essa já trata do alternativo a
    // seguir, ver aoClicarCorrigir).
    definirCorPersistenteBotao(botaoCorrigir, precisaCorrigir);
    definirCorPersistenteBotao(botaoAlternativo, false); // limpa antes de decidir a cor certa
    if (!precisaCorrigir && botaoAlternativo && !botaoAlternativo.disabled) {
      if (faltaAlternativo) {
        botaoAlternativo.style.background = COR_BOTAO_DISPONIVEL;
      } else if (precisaFixLoc) {
        botaoAlternativo.style.background = COR_BOTAO_FIXLOC;
      }
    }

    let ancora = container;
    for (const { texto, html, estiloExtra } of avisos) {
      const aviso = document.createElement('div');
      aviso.setAttribute(AVISO_MARCADOR, 'true');
      aviso.style.cssText = `
        font-size: 11px; font-family: sans-serif;
        line-height: 1.35; word-break: break-word;
        margin: -2px 0 4px 0; padding: 3px 6px;
        border-radius: 0 3px 3px 0; ${estiloExtra}
      `;
      if (html !== undefined) aviso.innerHTML = html;
      else aviso.textContent = texto;
      ancora.insertAdjacentElement('afterend', aviso);
      ancora = aviso;
    }
  }

  function removeExistingButtons(segmentPanel) {
    const existing = segmentPanel.parentNode?.querySelector(`[${BOTOES_MARCADOR}="true"]`);
    if (existing) existing.remove();
    document.querySelectorAll(`[${BLOQUEADO_MARCADOR}="true"]`).forEach((el) => el.remove());
    document.querySelectorAll(`[${SEM_DADOS_MARCADOR}="true"]`).forEach((el) => el.remove());
    removerAviso();
    removerOverlayPalavras();
  }

  // ------------------------------------------------------------------
  // CAMADA SOBREPOSTA AO CAMPO DO NOME DA RUA
  //
  // Um <input> nativo não permite colorir parte do texto, por isso o texto
  // real fica transparente e desenhamos por cima. Agora a camada:
  //   • desaparece assim que o campo ganha foco ou é editado (antes ficava-se
  //     a escrever num campo invisível, com texto desactualizado por baixo);
  //   • acompanha scroll e redimensionamento;
  //   • é sempre removida quando o painel fecha ou a selecção muda.
  // ------------------------------------------------------------------
  const OVERLAY_PALAVRAS_MARCADOR = `data-${SCRIPT_ID}-overlay-palavras`;
  let overlayAtual = null;
  let inputAssociado = null;

  function reposicionarOverlay() {
    if (!overlayAtual || !inputAssociado || !inputAssociado.isConnected) {
      removerOverlayPalavras();
      return;
    }
    const rect = inputAssociado.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      overlayAtual.style.display = 'none';
      return;
    }
    overlayAtual.style.display = 'flex';
    overlayAtual.style.left = `${rect.left}px`;
    overlayAtual.style.top = `${rect.top}px`;
    overlayAtual.style.width = `${rect.width}px`;
    overlayAtual.style.height = `${rect.height}px`;
  }

  const reposicionarOverlayComAtraso = debounce(reposicionarOverlay, 50);

  function removerOverlayPalavras() {
    if (inputAssociado) {
      if (inputAssociado.dataset.wmeCorOriginal !== undefined) {
        inputAssociado.style.color = inputAssociado.dataset.wmeCorOriginal;
        delete inputAssociado.dataset.wmeCorOriginal;
      }
      inputAssociado.removeEventListener('focus', removerOverlayPalavras);
      inputAssociado.removeEventListener('input', removerOverlayPalavras);
      inputAssociado = null;
    }
    window.removeEventListener('scroll', reposicionarOverlayComAtraso, true);
    window.removeEventListener('resize', reposicionarOverlayComAtraso);
    document.querySelectorAll(`[${OVERLAY_PALAVRAS_MARCADOR}="true"]`).forEach((el) => el.remove());
    overlayAtual = null;
  }

  // O WME usa Web Components: boa parte dos campos reais vive dentro de um
  // shadow root e é por isso invisível a um querySelectorAll('input')
  // normal, que só percorre o DOM claro. Percorremos os dois — primeiro o
  // DOM claro (caminho rápido, cobre os campos que não estão encapsulados)
  // e só depois descemos aos shadow roots encontrados.
  function encontrarInputNomeRua(segmentPanel, streetName) {
    const visitados = new Set();
    const porVisitar = [segmentPanel];

    while (porVisitar.length) {
      const raiz = porVisitar.shift();
      if (!raiz || visitados.has(raiz)) continue;
      visitados.add(raiz);

      let inputs;
      try {
        inputs = raiz.querySelectorAll('input');
      } catch (e) {
        continue;
      }
      for (const input of inputs) {
        if (input.value === streetName) return input;
      }

      let elementos;
      try {
        elementos = raiz.querySelectorAll('*');
      } catch (e) {
        continue;
      }
      for (const el of elementos) {
        if (el.shadowRoot) porVisitar.push(el.shadowRoot);
      }
    }

    return null;
  }

  function atualizarDestaquePalavras(segmentPanel, streetName) {
    removerOverlayPalavras();

    if (!streetName || nomeRuaVazioOuNenhum(streetName)) return;

    const { html, temAlvo } = nomeComAlvosDestacadosHTML(streetName, false);
    if (!temAlvo) return;

    const input = encontrarInputNomeRua(segmentPanel, streetName);
    if (!input) return;
    if (document.activeElement === input) return; // a ser editado: não tapar

    let rect;
    let estilo;
    try {
      rect = input.getBoundingClientRect();
      estilo = window.getComputedStyle(input);
    } catch (e) {
      return;
    }
    if (!rect || rect.width === 0) return;

    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_PALAVRAS_MARCADOR, 'true');
    overlay.style.cssText = `
      position: fixed; left: ${rect.left}px; top: ${rect.top}px;
      width: ${rect.width}px; height: ${rect.height}px;
      display: flex; align-items: center;
      font-family: ${estilo.fontFamily}; font-size: ${estilo.fontSize};
      font-weight: ${estilo.fontWeight}; letter-spacing: ${estilo.letterSpacing};
      padding-left: ${estilo.paddingLeft}; padding-right: ${estilo.paddingRight};
      box-sizing: border-box; pointer-events: none; z-index: 9999;
      white-space: pre; overflow: hidden; color: ${estilo.color};
    `;
    overlay.innerHTML = html;

    document.body.appendChild(overlay);
    overlayAtual = overlay;
    inputAssociado = input;

    if (input.dataset.wmeCorOriginal === undefined) {
      input.dataset.wmeCorOriginal = input.style.color || '';
    }
    input.style.color = 'transparent';

    input.addEventListener('focus', removerOverlayPalavras);
    input.addEventListener('input', removerOverlayPalavras);
    window.addEventListener('scroll', reposicionarOverlayComAtraso, true);
    window.addEventListener('resize', reposicionarOverlayComAtraso);
  }

  // Antes de aplicar "Corrigir/Abreviar" ou "Alternativo", simula Ctrl+A
  // para seleccionar todos os segmentos ligados com o mesmo nome, e só
  // depois corre a acção sobre essa selecção alargada — assim corrige-se a
  // rua toda de uma vez, em vez de só o segmento clicado. Um pequeno atraso
  // dá tempo ao WME de processar o atalho antes de lermos a selecção final.
  // Um marcador no botão evita despoletar duas vezes com cliques repetidos
  // durante essa janela de espera.
  function executarComSelecaoCompleta(botao, callback) {
    if (botao.dataset.wmeAExecutar === 'true') return;

    const selecaoInicial = safeGetSelection();
    if (!selecaoInicial || selecaoInicial.objectType !== 'segment' || !selecaoInicial.ids || !selecaoInicial.ids.length) {
      return;
    }

    botao.dataset.wmeAExecutar = 'true';
    simularCtrlA();

    setTimeout(() => {
      delete botao.dataset.wmeAExecutar;
      const selecaoFinal = safeGetSelection();
      const ids = (selecaoFinal && selecaoFinal.objectType === 'segment' && selecaoFinal.ids && selecaoFinal.ids.length)
        ? selecaoFinal.ids
        : selecaoInicial.ids;
      callback(ids);
    }, 150);
  }

  function injectButtons(segmentPanel, streetName, bloqueado) {
    if (segmentPanel.parentNode.querySelector(`[${BOTOES_MARCADOR}="true"]`)) return;

    const container = document.createElement('div');
    container.setAttribute(BOTOES_MARCADOR, 'true');

    if (editorAutorizado()) {
      container.style.display = 'flex';
      container.style.gap = '4px';
      container.style.marginBottom = '6px';

      const botaoCorrigir = criarBotaoNativo('Corrigir/Abreviar');
      const botaoAlternativo = criarBotaoNativo('Alternativo');
      botaoCorrigir.id = `${SCRIPT_ID}-btn-corrigir`;
      botaoAlternativo.id = `${SCRIPT_ID}-btn-alternativo`;

      if (bloqueado) {
        desabilitarBotao(botaoCorrigir);
        desabilitarBotao(botaoAlternativo);
      } else {
        // "click" em vez de "mousedown": com mousedown o botão disparava
        // também com o botão direito ou o do meio do rato.
        botaoCorrigir.addEventListener('click', () => {
          executarComSelecaoCompleta(botaoCorrigir, (ids) => aoClicarCorrigir(ids, botaoCorrigir));
        });

        botaoAlternativo.addEventListener('click', () => {
          executarComSelecaoCompleta(botaoAlternativo, (ids) => aoClicarAlternativo(ids, botaoAlternativo));
        });
      }

      container.appendChild(botaoCorrigir);
      container.appendChild(botaoAlternativo);
    } else {
      // Editor fora da lista branca: nenhum botão é criado — o container
      // fica vazio e escondido, servindo apenas de âncora de posição para
      // a mensagem informativa (atualizarAvisoAbreviatura), que continua
      // a aparecer normalmente logo a seguir a ele.
      container.style.display = 'none';
    }

    const anchor = findHouseNumbersAnchor(segmentPanel) || segmentPanel;
    anchor.parentNode.insertBefore(container, anchor);

    if (bloqueado && editorAutorizado()) inserirAvisoBloqueado(container);

    atualizarAvisoAbreviatura(streetName);
    atualizarDestaquePalavras(segmentPanel, streetName);
  }

  function desabilitarBotao(botao) {
    botao.setAttribute('disabled', 'true');
    botao.disabled = true;
    botao.style.pointerEvents = 'none';
    botao.style.cursor = 'not-allowed';
    botao.style.opacity = '0.9';
    botao.style.background = '#ffcdd2';
    botao.style.color = '#c00';
    botao.style.border = '1px solid #c00';
    // Marca como bloqueio PERMANENTE (permissão do utilizador), para que a
    // desactivação temporária por ambiguidade (ver definirDesativacaoTemporaria)
    // nunca o reactive por engano.
    botao.dataset.wmeBloqueadoPermanente = 'true';
  }

  function inserirAvisoBloqueado(container) {
    const aviso = document.createElement('div');
    aviso.setAttribute(BLOQUEADO_MARCADOR, 'true');
    aviso.textContent = '⚠️ Este segmento está acima do teu nível de edição: o script não o pode alterar. Corrige manualmente. ⚠️';
    aviso.style.cssText = `
      font-size: 11px; font-family: sans-serif; color: #c00; font-weight: 700;
      line-height: 1.35; word-break: break-word;
      margin: -2px 0 4px 0; padding: 3px 6px;
      border-radius: 0 3px 3px 0; border-left: 3px solid #c00; background:#fff0f0;
    `;
    container.insertAdjacentElement('afterend', aviso);
  }

  function criarBotaoNativo(texto) {
    const button = document.createElement('wz-button');
    button.setAttribute('type', 'button');
    button.setAttribute('color', 'secondary');
    button.setAttribute('size', 'sm');
    button.style.flex = '1';
    button.style.fontSize = '11px';
    button.style.lineHeight = '1';
    button.style.padding = '2px 6px';
    button.style.minHeight = '24px';
    button.style.height = '24px';
    button.textContent = texto;
    return button;
  }

  function findHouseNumbersAnchor(segmentPanel) {
    const candidateSelectors = [
      '#segment-edit-house-numbers',
      '[name="houseNumbers"]',
      'wz-section[name="houseNumbers"]',
    ];

    for (const selector of candidateSelectors) {
      const el = segmentPanel.querySelector(selector);
      if (el) return el.closest('.form-group, wz-section, div') || el;
    }

    const HOUSE_NUMBERS_LABELS = [
      'house numbers', 'house number',
      'números de porta', 'número de porta', 'números da porta', 'numero de porta',
      'números de porta/casa', 'número da casa',
      'números de puerta', 'número de puerta',
      'numéros de rue', 'numéro de rue',
      'hausnummern', 'numeri civici',
    ];

    const labelLike = Array.from(
      segmentPanel.querySelectorAll('label, .label, wz-label, span, div, h1, h2, h3, h4, p, wz-overline')
    );
    const match = labelLike.find((el) => {
      if (el.children && el.children.length > 0) return false;
      const text = el.textContent && el.textContent.trim().toLowerCase();
      return text && HOUSE_NUMBERS_LABELS.some((t) => text === t || text.startsWith(t));
    });

    return match ? match.closest('section, li, .form-group, wz-section, div') || match : null;
  }

  function darFeedbackBotao(botao, texto, cor) {
    if (!botao) return;
    if (botao.dataset.textoOriginal === undefined) {
      botao.dataset.textoOriginal = botao.textContent;
    }
    const original = botao.dataset.textoOriginal;
    botao.textContent = texto;
    botao.style.background = cor;
    clearTimeout(botao._feedbackTimeout);
    botao._feedbackTimeout = setTimeout(() => {
      botao.textContent = original;
      // Em vez de restaurar uma cor "original" guardada (que ficaria
      // desactualizada assim que o estado persistente mudasse entre
      // cliques), recalcula-se a cor a partir do estado actual do segmento.
      atualizarPainelDeEdicao();
    }, 2000);
  }

  function obterOuCriarRua(streetName, cityId) {
    let rua = sdk.DataModel.Streets.getStreet({ streetName, cityId });
    if (!rua) rua = sdk.DataModel.Streets.addStreet({ streetName, cityId });
    return rua;
  }

  // updateAddress tem duas assinaturas em circulação: a produção aceita os
  // campos directamente em cima do objecto ({ segmentId, primaryStreetId }),
  // a beta exige-os embrulhados em addressData. O script chamava as duas
  // formas em sítios diferentes (primaryStreetId à solta, alternateStreetIds
  // dentro de addressData), pelo que uma delas falharia consoante o ambiente.
  // Este envoltório tenta primeiro a forma directa e recorre a addressData se
  // essa for rejeitada. Mesma implementação do WazePT Suite, para os dois
  // scripts se comportarem de igual maneira.
  function updateAddressCompat(segmentId, payload) {
    try {
      sdk.DataModel.Segments.updateAddress(Object.assign({ segmentId }, payload));
    } catch (e) {
      sdk.DataModel.Segments.updateAddress({ segmentId, addressData: payload });
    }
  }

  // Garante que o segmento tem um endereço alternativo com o nome esperado
  // (versão expandida de nomeBase) E a cidade certa (igual à do endereço
  // principal). Três desfechos possíveis:
  //   'ok'        — já existe, com o nome e a cidade certos, nada a fazer.
  //   'corrigido' — existia com o nome certo mas cidade diferente (o caso
  //                 do "Fix Loc.") — troca-se pela versão com a cidade
  //                 certa, usando updateAddress com a lista completa de
  //                 alternateStreetIds (a SDK não tem um "removeAlternate
  //                 Street", só addAlternateStreet, por isso a substituição
  //                 tem de passar pela lista toda).
  //   'criado'    — não existia nenhum com este nome — cria-se de novo.
  //   'nada'      — o nome não tem abreviaturas a expandir, não aplicável.
  //   'falha'     — erro ao consultar/gravar.
  function garantirAlternativoCorreto(segmentId, info, nomeBase) {
    const nomeExpandido = removerAspas(expandirNome(nomeBase));
    if (!nomeExpandido || nomeExpandido === nomeBase) return 'nada';

    const seg = obterSegmento(segmentId);
    if (!seg) return 'falha';

    const nomeAlvoNormalizado = normalizarParaComparar(nomeExpandido);
    const ruasAlt = obterRuasAlternativas(seg);
    const combinamNome = ruasAlt.filter((r) => normalizarParaComparar(r.name) === nomeAlvoNormalizado);
    if (combinamNome.some((r) => r.cityId === info.cityId)) return 'ok';

    try {
      const ruaCorreta = obterOuCriarRua(nomeExpandido, info.cityId);

      if (combinamNome.length > 0) {
        const idsErrados = new Set(combinamNome.map((r) => r.id));
        const novosIds = [
          ...(seg.alternateStreetIds || []).filter((id) => !idsErrados.has(id)),
          ruaCorreta.id,
        ];
        updateAddressCompat(segmentId, { alternateStreetIds: novosIds });
        return 'corrigido';
      }

      sdk.DataModel.Segments.addAlternateStreet({ segmentIds: [segmentId], streetId: ruaCorreta.id });
      return 'criado';
    } catch (erro) {
      LOGE('Falha ao criar/associar/corrigir a rua alternativa:', erro);
      return 'falha';
    }
  }

  // Cada segmento é tratado com o SEU próprio endereço e a SUA cidade. Antes
  // lia-se apenas o endereço do primeiro segmento seleccionado e escrevia-se
  // esse nome em todos os outros — com vários segmentos de nomes diferentes
  // seleccionados, isso apagava os restantes nomes.
  //
  // Depois de corrigir o endereço principal, garante também que existe um
  // alternativo igual à versão expandida do nome já CORRIGIDO (não do nome
  // antigo, por abreviar), com a cidade certa — corrige primeiro, só depois
  // trata do alternativo. Só se aplica a segmentos onde uma correcção foi
  // mesmo necessária; se o nome já estava correcto, este botão não mexe em
  // alternativos (esse caso fica para o botão "Alternativo").
  function aoClicarCorrigir(segmentIds, botao) {
    let alterados = 0;
    let altsAdicionados = 0;
    let altsCorrigidos = 0;
    let bloqueados = 0;
    let falhas = 0;

    segmentIds.forEach((segmentId) => {
      if (!podeEditar(segmentId)) { bloqueados++; return; }
      const info = obterEnderecoPrincipal(segmentId);
      if (!info || !info.streetName) return;
      // Rede de segurança: um Ctrl+A poderia, em teoria, alargar a selecção
      // a segmentos fora de Portugal.
      if (!paisEhPortugal(info.countryId)) return;

      // Segurança extra para selecções múltiplas (ex.: via Ctrl+A): o botão
      // só reflecte o estado do PRIMEIRO segmento seleccionado, por isso
      // verificamos aqui também, segmento a segmento.
      if (temImpAmbiguoForaDaPrimeira(mascararAspas(info.streetName).mascarado)) {
        LOG('Segmento ignorado por ambiguidade de "Imp.":', segmentId);
        return;
      }

      const nomeCorrigido = normalizarNomeCompleto(info.streetName);
      if (nomeCorrigido === info.streetName) return; // nada a corrigir neste segmento

      try {
        const rua = obterOuCriarRua(nomeCorrigido, info.cityId);
        updateAddressCompat(segmentId, { primaryStreetId: rua.id });
        alterados++;
      } catch (erro) {
        LOGE('Falha ao corrigir o endereço principal:', erro);
        falhas++;
        return; // não tenta o alternativo se a correcção do principal falhou
      }

      const resultadoAlt = garantirAlternativoCorreto(segmentId, info, nomeCorrigido);
      if (resultadoAlt === 'criado') altsAdicionados++;
      else if (resultadoAlt === 'corrigido') altsCorrigidos++;
    });

    reportarResultadoCorrigir(botao, alterados, altsAdicionados, altsCorrigidos, bloqueados, falhas);
    if (alterados || altsAdicionados || altsCorrigidos) atualizarDestaques();
  }

  // O botão "Alternativo" faz três coisas, dependendo do que já existe:
  //   • não existe nenhum alternativo com este nome → cria-o;
  //   • existe com o nome certo mas a cidade errada (o caso do "Fix Loc.",
  //     ex.: "Rua do Cabo" sem cidade quando o principal é em Faro) →
  //     verifica que é mesmo a versão expandida do nome principal e troca-o
  //     por um com a cidade certa;
  //   • já existe correcto → não faz nada.
  function aoClicarAlternativo(segmentIds, botao) {
    let criados = 0;
    let corrigidos = 0;
    let bloqueados = 0;
    let falhas = 0;

    segmentIds.forEach((segmentId) => {
      if (!podeEditar(segmentId)) { bloqueados++; return; }
      const info = obterEnderecoPrincipal(segmentId);
      if (!info || !info.streetName) return;
      if (!paisEhPortugal(info.countryId)) return;

      if (temImpAmbiguoForaDaPrimeira(mascararAspas(info.streetName).mascarado)) {
        LOG('Segmento ignorado por ambiguidade de "Imp.":', segmentId);
        return;
      }

      const resultado = garantirAlternativoCorreto(segmentId, info, info.streetName);
      if (resultado === 'criado') criados++;
      else if (resultado === 'corrigido') corrigidos++;
      else if (resultado === 'falha') falhas++;
    });

    reportarResultadoAlternativo(botao, criados, corrigidos, bloqueados, falhas);
    if (criados || corrigidos) atualizarDestaques();
  }

  function reportarResultadoAlternativo(botao, criados, corrigidos, bloqueados, falhas) {
    if (falhas) {
      darFeedbackBotao(botao, '✖ Falhou, ver consola', '#ffcdd2');
      return;
    }
    if (criados || corrigidos) {
      const partes = [];
      if (criados) partes.push(`${criados} criado(s)`);
      if (corrigidos) partes.push(`${corrigidos} cidade corrigida`);
      const sufixo = bloqueados ? ` (${bloqueados} bloqueados)` : '';
      darFeedbackBotao(botao, `✔ ${partes.join(' + ')} (por gravar)${sufixo}`, '#c8e6c9');
      return;
    }
    if (bloqueados) {
      darFeedbackBotao(botao, '✖ Segmento acima do teu nível', '#ffcdd2');
      return;
    }
    darFeedbackBotao(botao, 'Sem abreviaturas a expandir', '#e0e0e0');
  }

  function reportarResultadoCorrigir(botao, alterados, altsAdicionados, altsCorrigidos, bloqueados, falhas) {
    if (falhas) {
      darFeedbackBotao(botao, '✖ Falhou, ver consola', '#ffcdd2');
      return;
    }
    if (alterados) {
      let msg = `✔ ${alterados} corrigido(s)`;
      if (altsAdicionados) msg += ` + ${altsAdicionados} alt.`;
      if (altsCorrigidos) msg += ` + ${altsCorrigidos} cidade alt.`;
      msg += ' (por gravar)';
      if (bloqueados) msg += ` (${bloqueados} bloq.)`;
      darFeedbackBotao(botao, msg, '#c8e6c9');
      return;
    }
    if (bloqueados) {
      darFeedbackBotao(botao, '✖ Segmento acima do teu nível', '#ffcdd2');
      return;
    }
    darFeedbackBotao(botao, 'Sem erros a corrigir', '#e0e0e0');
  }

  // ==================================================================
  // PREFERÊNCIAS PESSOAIS (só de visualização, guardadas neste navegador)
  //
  // As regras e definições globais vivem no Firebase e só os
  // administradores as alteram. Ficam locais apenas duas preferências de
  // visualização dos destaques, que não mudam nenhuma correcção.
  // ==================================================================
  const CHAVE_PREFS = `${SCRIPT_ID}-prefs`;
  const PREFS_OMISSAO = () => ({ naoDestacarBloqueados: false, soDestacarComCidade: true });
  let prefs = PREFS_OMISSAO();

  function carregarPrefs() {
    const guardadas = lerJSONLocal(CHAVE_PREFS, null);
    if (guardadas && typeof guardadas === 'object') return { ...PREFS_OMISSAO(), ...guardadas };
    // Migração: até à v16.x estas opções viviam em "<id>-config".geral,
    // junto com as listas editáveis localmente (que deixaram de existir).
    const antiga = lerJSONLocal(`${SCRIPT_ID}-config`, null);
    if (antiga && antiga.geral && typeof antiga.geral === 'object') {
      return {
        ...PREFS_OMISSAO(),
        ...(typeof antiga.geral.naoDestacarBloqueados === 'boolean' ? { naoDestacarBloqueados: antiga.geral.naoDestacarBloqueados } : {}),
        ...(typeof antiga.geral.soDestacarComCidade === 'boolean' ? { soDestacarComCidade: antiga.geral.soDestacarComCidade } : {}),
      };
    }
    return PREFS_OMISSAO();
  }

  function guardarPrefs() {
    if (!gravarJSONLocal(CHAVE_PREFS, prefs)) LOGE('Não foi possível guardar as preferências.');
  }

  // ==================================================================
  // ESTILOS, AVISOS (toast) E JANELAS (modal)
  // ==================================================================
  const CSS_ID = `${SCRIPT_ID}-estilos`;

  function garantirEstilos() {
    if (document.getElementById(CSS_ID)) return;
    const st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = `
      .wptab-ov{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:sans-serif}
      .wptab-modal{background:#fff;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.35);display:flex;flex-direction:column;max-width:96vw;max-height:92vh;font-size:12px;color:#222;box-sizing:border-box}
      .wptab-mh{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e5e5e5;font-weight:700;font-size:14px}
      .wptab-mh .wptab-x{margin-left:auto;cursor:pointer;border:none;background:none;font-size:20px;line-height:1;color:#666;padding:0 4px}
      .wptab-mb{padding:12px 14px;overflow:auto;flex:1;min-height:0}
      .wptab-btn{border:1px solid #bbb;background:#f7f7f7;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;color:#222;line-height:1.3;white-space:nowrap}
      .wptab-btn:hover{background:#eee}
      .wptab-btn.pri{background:#1a73e8;border-color:#1a73e8;color:#fff}
      .wptab-btn.pri:hover{background:#1765cc}
      .wptab-btn.perigo{border-color:#c00;color:#c00;background:#fff}
      .wptab-btn:disabled{opacity:.5;cursor:not-allowed}
      .wptab-btn.mini{padding:1px 0;width:22px;height:22px;text-align:center;font-size:11px;flex:none}
      .wptab-in{font-size:12px;padding:3px 5px;border:1px solid #ccc;border-radius:3px;box-sizing:border-box;min-width:0}
      .wptab-in.erro{border-color:#c00;background:#fff5f5}
      .wptab-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#323232;color:#fff;padding:8px 14px;border-radius:4px;z-index:100002;font:12px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:80vw}
      .wptab-tabs{display:flex;gap:2px;border-bottom:1px solid #ddd;padding:8px 14px 0}
      .wptab-tab{padding:6px 12px;cursor:pointer;border:1px solid transparent;border-bottom:none;border-radius:4px 4px 0 0;color:#555;user-select:none}
      .wptab-tab.on{border-color:#ddd;background:#fff;color:#000;font-weight:700;margin-bottom:-1px}
      .wptab-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-bottom:1px solid #f0f0f0;min-height:26px}
      .wptab-row:hover{background:#fafafa}
      .wptab-head{font-weight:700;color:#555;background:#f6f6f6;position:sticky;top:0;z-index:1}
      .wptab-badge{font-size:10px;padding:1px 6px;border-radius:8px;background:#e8f0fe;color:#1a73e8;margin-left:5px;font-weight:600}
      .wptab-badge.novo{background:#fde7e7;color:#c00}
      .wptab-nota{font-size:11px;color:#666;line-height:1.4;margin:4px 0 8px}
      .wptab-aviso{font-size:11px;line-height:1.4;padding:6px 8px;border-left:3px solid #cc8400;background:#fff3e0;color:#8a5a00;border-radius:0 3px 3px 0;margin:6px 0}
      .wptab-lista{border:1px solid #eee;border-radius:3px;overflow-y:auto}
      .wptab-sec{padding:5px 8px;cursor:pointer;border-radius:3px;display:flex;justify-content:space-between;gap:6px}
      .wptab-sec:hover{background:#f2f2f2}
      .wptab-sec.on{background:#e8f0fe;color:#1a73e8;font-weight:700}
      .wptab-tag{font-size:10px;color:#666;background:#f0f0f0;border-radius:3px;padding:0 4px;margin-right:4px}
      .wptab-esp{color:#bbb}
      .wptab-barra{display:flex;align-items:center;gap:6px;padding:8px 14px;border-top:1px solid #e5e5e5;flex-wrap:wrap}
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  let toastTimer = null;
  function toast(msg) {
    garantirEstilos();
    let el = document.getElementById(`${SCRIPT_ID}-toast`);
    if (!el) {
      el = document.createElement('div');
      el.id = `${SCRIPT_ID}-toast`;
      el.className = 'wptab-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  function el(tag, props = {}, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'style') e.style.cssText = v;
      else if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const f of filhos) {
      if (f === null || f === undefined || f === false) continue;
      e.appendChild(typeof f === 'string' ? document.createTextNode(f) : f);
    }
    return e;
  }

  function botao(texto, aoClicar, classe = '', titulo) {
    return el('button', { type: 'button', class: `wptab-btn ${classe}`.trim(), text: texto, title: titulo, onclick: (ev) => { ev.stopPropagation(); aoClicar(ev); } });
  }

  const pilhaModais = [];

  // Janela modal genérica. Fecha com o X ou com Escape (nunca com um clique
  // fora, para não perder trabalho no painel de administração). As teclas
  // não passam para o WME enquanto a janela está aberta.
  function abrirModal({ titulo, largura = 460, altura, construir, podeFechar, aoFechar }) {
    garantirEstilos();
    const ov = el('div', { class: 'wptab-ov' });
    const modal = el('div', { class: 'wptab-modal', style: `width:${largura}px;${altura ? `height:${altura};` : ''}` });
    const btnX = el('button', { type: 'button', class: 'wptab-x', title: 'Fechar', text: '×' });
    const cabecalho = el('div', { class: 'wptab-mh' }, el('span', { text: titulo }), btnX);
    const corpo = el('div', { class: 'wptab-mb' });
    modal.append(cabecalho, corpo);
    ov.appendChild(modal);

    let fechado = false;
    const api = {
      corpo, modal, cabecalho,
      fechar: async (forcar = false) => {
        if (fechado) return;
        if (!forcar && podeFechar && !(await podeFechar())) return;
        fechado = true;
        ov.remove();
        const i = pilhaModais.indexOf(api);
        if (i !== -1) pilhaModais.splice(i, 1);
        try { aoFechar?.(); } catch (e) { LOG('aoFechar falhou', e); }
      },
    };
    btnX.addEventListener('click', () => api.fechar());
    for (const tipo of ['keydown', 'keyup', 'keypress']) {
      ov.addEventListener(tipo, (ev) => {
        ev.stopPropagation();
        if (tipo === 'keydown' && ev.key === 'Escape' && pilhaModais[pilhaModais.length - 1] === api) {
          ev.preventDefault();
          api.fechar();
        }
      });
    }
    pilhaModais.push(api);
    document.body.appendChild(ov);
    construir(api);
    modal.tabIndex = -1;
    if (!modal.contains(document.activeElement)) modal.focus();
    return api;
  }

  function confirmar(mensagem, { titulo = 'Confirmar', rotuloOk = 'OK', perigo = false } = {}) {
    return new Promise((resolve) => {
      let resposta = false;
      abrirModal({
        titulo,
        largura: 400,
        aoFechar: () => resolve(resposta),
        construir: ({ corpo, fechar }) => {
          corpo.appendChild(el('div', { style: 'white-space:pre-wrap;line-height:1.5;font-size:13px;margin-bottom:12px;', text: mensagem }));
          corpo.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;gap:6px;' },
            botao('Cancelar', () => fechar()),
            botao(rotuloOk, () => { resposta = true; fechar(); }, perigo ? 'perigo' : 'pri')));
        },
      });
    });
  }

  function formatarData(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    try {
      return new Date(ms).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date(ms).toISOString(); }
  }

  // ==================================================================
  // SECÇÕES DAS REGRAS (partilhado pelo separador e pelo painel de admin.)
  // ==================================================================
  const CAMPOS_ABREV = [['abrev', 'Abreviatura', 'ex.: Fte.'], ['exp', 'Por extenso', 'ex.: Fonte']];

  const SECCOES_REGRAS = [
    {
      id: 'abreviaturas', grupo: 'Principais', titulo: 'Abreviaturas', tipo: 'pares', campos: CAMPOS_ABREV, chave: 'abrev',
      desc: 'Expansão no endereço alternativo (abreviatura → por extenso). A ordem importa: as formas femininas ("Dr.ª") têm de vir antes das masculinas ("Dr.").',
      espelho: 'abreviaturasInversas',
    },
    {
      id: 'abreviaturasInversas', grupo: 'Principais', titulo: 'Abreviação', tipo: 'pares', chave: 'ext',
      campos: [['ext', 'Por extenso', 'ex.: Fonte'], ['abrev', 'Abreviatura', 'ex.: Fte.']],
      desc: 'Usada para abreviar o endereço principal (por extenso → abreviatura). As frases compostas/com hífen têm de vir antes das palavras simples (ex.: "Grão-Duque" antes de "Duque") e as formas femininas antes das masculinas.',
    },
    {
      id: 'abreviaturasCompostas', grupo: 'Principais', titulo: 'Abreviaturas compostas', tipo: 'pares', campos: CAMPOS_ABREV, chave: 'abrev',
      desc: 'Abreviaturas de mais de uma palavra (ex.: "A. S." → "Área de Serviço"), expandidas antes de todas as outras.',
    },
    {
      id: 'correccoes', grupo: 'Principais', titulo: 'Correções', tipo: 'regras',
      desc: 'Abreviaturas mal escritas ou desatualizadas que passam à forma correta (ex.: "Trav." → "Tv."). Aplicadas depois dos erros dos tipos de via e antes da acentuação.',
    },
    {
      id: 'ortografiaA', grupo: 'Principais', titulo: 'Erros ortográficos (tipos de via)', tipo: 'regras',
      desc: 'Palavras de tipo de via mal escritas (ex.: "Avendia" → "Avenida"). Aplicadas primeiro.',
    },
    {
      id: 'ortografiaB', grupo: 'Principais', titulo: 'Erros ortográficos (acentuação e topónimos)', tipo: 'regras',
      desc: 'Palavras sem acento ou mal escritas (ex.: "Joao" → "João"). Aplicadas por último; os topónimos compostos ("Póvoa do Varzim") devem vir depois das correções de acentuação de que dependem.',
    },
    {
      id: 'listaBranca', grupo: 'Principais', titulo: 'Lista branca', tipo: 'lista', exemplo: 'ex.: Quinta do Lago',
      desc: 'Palavras ou expressões que o script nunca altera nem assinala como erro — nem ao abreviar, nem ao corrigir, nem ao criar o endereço alternativo.',
    },
    {
      id: 'particulas', grupo: 'Principais', titulo: 'Partículas', tipo: 'lista', minusculas: true, exemplo: 'ex.: até',
      desc: 'Palavras de ligação (de, da, do, e, a, o…) que ficam sempre em minúsculas no meio do nome.',
    },
    {
      id: 'tiposDeVia', grupo: 'Avançado', titulo: 'Tipos de via (contexto)', tipo: 'lista', normalizar: true, exemplo: 'ex.: rua',
      desc: 'Palavras que, antes de uma abreviatura de uma letra (ex.: "Rua S. Pedro"), confirmam que é mesmo uma abreviatura e não uma inicial. Guardadas em minúsculas e sem acentos.',
    },
    {
      id: 'abrevUmaLetraSempre', grupo: 'Avançado', titulo: 'Abreviaturas de uma letra sempre expandidas', tipo: 'lista', exemplo: 'ex.: S.',
      desc: 'Abreviaturas de uma letra ("D.", "S."…) que expandem sempre, sem depender do contexto.',
    },
    {
      id: 'nucleosAmbiguos', grupo: 'Avançado', titulo: 'Abreviaturas sem ponto corrigidas', tipo: 'pares', chave: 'nucleo',
      campos: [['nucleo', 'Sem ponto', 'ex.: Dr'], ['abrev', 'Corrige para', 'ex.: Dr.']],
      desc: 'Abreviaturas ambíguas (de uma letra, ou com forma feminina) que mesmo assim são corrigidas quando escritas sem ponto. As restantes abreviaturas sem ponto são corrigidas automaticamente.',
    },
    {
      id: 'nucleosIgnorados', grupo: 'Avançado', titulo: 'Abreviaturas que são palavras correntes', tipo: 'lista', minusculas: true, exemplo: 'ex.: mar',
      desc: 'Abreviaturas escritas sem ponto que também são palavras correntes (Mar, Sol, Cor…) e por isso nunca são corrigidas para a forma com ponto.',
    },
    {
      id: 'abrevSoAlternativo', grupo: 'Avançado', titulo: 'Abreviaturas só do alternativo', tipo: 'lista', exemplo: 'ex.: [P]',
      desc: 'Abreviaturas que expandem no endereço alternativo mas nunca no principal, mesmo quando são a última palavra (ex.: "[P]" → "Estacionamento").',
    },
  ];

  const TIPOS_REGRA = [
    ['palavra', 'Palavra'],
    ['abrev', 'Abreviatura'],
    ['re', 'Expressão regular'],
  ];

  function mostrarEspacoFinal(texto) {
    const s = String(texto);
    return /\s$/.test(s)
      ? [s.trimEnd(), el('span', { class: 'wptab-tag', style: 'margin-left:4px;', title: 'A substituição termina com um espaço, para não colar à palavra seguinte', text: '+ espaço' })]
      : [s];
  }

  // Representação de uma entrada para as listas (só leitura e admin).
  function formatarEntrada(seccao, item) {
    const caixa = el('div', { style: 'flex:1 1 auto;min-width:0;word-break:break-word;' });
    if (seccao.tipo === 'lista') {
      caixa.appendChild(el('strong', { text: item }));
    } else if (seccao.tipo === 'pares') {
      const [a, b] = seccao.campos;
      caixa.append(el('strong', { text: item[a[0]] }), ' → ', item[b[0]]);
    } else {
      const rotulo = (TIPOS_REGRA.find(([id]) => id === item.tipo) || TIPOS_REGRA[0])[1];
      caixa.appendChild(el('span', { class: 'wptab-tag', text: rotulo }));
      if (item.tipo === 're') {
        caixa.appendChild(el('strong', { text: item.desc || 'Regra avançada (sem descrição)' }));
        caixa.append(' → ', ...mostrarEspacoFinal(item.correto));
        caixa.appendChild(el('div', {
          style: 'font-family:monospace;font-size:10px;color:#888;margin-top:1px;',
          title: 'Expressão regular. {ini} = início de palavra, {fim} = fim de palavra, {L} = uma letra',
          text: `${item.re}${item.flags && item.flags !== 'gi' ? `   (flags: ${item.flags})` : ''}`,
        }));
        return caixa;
      } else {
        caixa.appendChild(el('strong', { text: item.de }));
        if (item.flags) caixa.appendChild(el('span', { class: 'wptab-tag', style: 'margin-left:4px;', text: `flags: ${item.flags}` }));
      }
      caixa.append(' → ', ...mostrarEspacoFinal(item.correto));
    }
    return caixa;
  }

  function textoPesquisavel(seccao, item) {
    if (seccao.tipo === 'lista') return item;
    if (seccao.tipo === 'pares') return seccao.campos.map(([k]) => item[k]).join(' ');
    return [item.de, item.re, item.desc, item.correto].filter(Boolean).join(' ');
  }

  // ==================================================================
  // SEPARADOR "WazePT Abrev." (painel Scripts do WME) — para todos
  //
  // Mostra o estado do acesso e das regras, as preferências pessoais de
  // visualização e as regras em vigor (só consulta). Os administradores
  // têm aqui o botão para o painel de administração. Um editor sem acesso
  // vê só a mensagem de acesso restrito e um botão para voltar a verificar.
  // ==================================================================
  let painelSeparador = null;
  const estadoSeparador = { abertas: new Set(), filtros: {} };

  async function registarSeparador() {
    try {
      const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
      tabLabel.textContent = 'WazePT Abrev.';
      tabLabel.title = 'WazePT Abreviaturas';
      painelSeparador = el('div', { style: 'font-family:sans-serif;padding:4px 12px 4px 2px;font-size:12px;' });
      tabPane.appendChild(painelSeparador);
      renderizarSeparador();
      LOG('Separador registado.');
    } catch (e) {
      LOGE('Não foi possível registar o separador:', e);
    }
  }

  function linhaVersao() {
    const linha = el('div', { style: 'font-size:11px;color:#666;margin-bottom:8px;' }, `v${SCRIPT_VERSION} · `);
    linha.appendChild(el('a', {
      href: '#', text: 'Procurar atualizações',
      onclick: (ev) => { ev.preventDefault(); verificarAtualizacao({ manual: true }); },
    }));
    return linha;
  }

  function caixaEstadoDados() {
    const caixa = el('div', { style: 'margin-bottom:12px;padding:6px 8px;background:#f7f7f7;border-radius:4px;font-size:11px;line-height:1.5;' });
    caixa.appendChild(el('div', { style: 'font-weight:700;font-size:12px;margin-bottom:2px;', text: 'Regras' }));
    if (!dadosDisponiveis()) {
      caixa.appendChild(el('div', { style: 'color:#c00;', text: dadosEstado.erro === 'vazio'
        ? 'A base de dados ainda não tem regras publicadas. Um administrador tem de as importar no painel de administração.'
        : 'Não foi possível obter as regras da base de dados. O script volta a tentar automaticamente.' }));
      return caixa;
    }
    caixa.appendChild(el('div', { text: `Revisão ${dadosEstado.rev || '—'} · publicada em ${formatarData(dadosEstado.updatedAt)}${dadosEstado.updatedBy ? ` por ${dadosEstado.updatedBy}` : ''}` }));
    caixa.appendChild(el('div', { text: `Obtidas em ${formatarData(dadosEstado.fetchedAt)} · próxima verificação depois de ${formatarData(dadosEstado.fetchedAt + DADOS_TTL_MS)}` }));
    if (dadosEstado.erro === 'rede') {
      caixa.appendChild(el('div', { style: 'color:#a05a00;', text: 'Sem ligação à base de dados — a usar as regras guardadas neste navegador.' }));
    }
    return caixa;
  }

  function renderizarConsultaRegras(contentor) {
    contentor.appendChild(el('div', { style: 'font-weight:700;font-size:12px;margin:10px 0 4px;', text: 'Regras em vigor (só consulta)' }));
    if (!dadosAtivos) return;
    for (const seccao of SECCOES_REGRAS) {
      const lista = dadosAtivos[seccao.id] || [];
      const det = el('details', { style: 'margin-bottom:6px;' });
      det.open = estadoSeparador.abertas.has(seccao.id);
      det.addEventListener('toggle', () => {
        if (det.open) estadoSeparador.abertas.add(seccao.id); else estadoSeparador.abertas.delete(seccao.id);
        if (det.open && !det.dataset.cheio) preencher();
      });
      det.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600;padding:3px 0;', text: `${seccao.titulo} (${lista.length})` }));

      // O conteúdo só é construído quando a secção é aberta.
      const preencher = () => {
        det.dataset.cheio = '1';
        det.appendChild(el('div', { class: 'wptab-nota', text: seccao.desc }));
        const filtro = el('input', { type: 'text', class: 'wptab-in', placeholder: 'Procurar…', style: 'width:100%;margin-bottom:4px;' });
        filtro.value = estadoSeparador.filtros[seccao.id] || '';
        const caixa = el('div', { class: 'wptab-lista', style: 'max-height:240px;' });
        const linhas = lista.map((item) => {
          const linha = el('div', { class: 'wptab-row', style: 'font-size:11px;' }, formatarEntrada(seccao, item));
          linha.dataset.q = normalizarParaComparar(textoPesquisavel(seccao, item));
          caixa.appendChild(linha);
          return linha;
        });
        if (!lista.length) caixa.appendChild(el('div', { class: 'wptab-nota', style: 'padding:6px;', text: 'Sem entradas.' }));
        const aplicar = () => {
          const q = normalizarParaComparar(filtro.value);
          estadoSeparador.filtros[seccao.id] = filtro.value;
          linhas.forEach((l) => { l.style.display = !q || l.dataset.q.includes(q) ? '' : 'none'; });
        };
        filtro.addEventListener('input', aplicar);
        aplicar();
        det.append(filtro, caixa);
      };
      if (det.open) preencher();
      contentor.appendChild(det);
    }
  }

  function renderizarToggleGeral({ chave, rotulo, descricao }) {
    const caixa = el('input', { type: 'checkbox', style: 'margin:0;flex:none;' });
    caixa.checked = !!prefs[chave];
    caixa.addEventListener('change', () => {
      prefs = { ...prefs, [chave]: caixa.checked };
      guardarPrefs();
      atualizarDestaques();
    });
    return el('div', { style: 'margin-bottom:10px;' },
      el('label', { style: 'display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:700;font-size:12px;' }, caixa, el('span', { text: rotulo })),
      el('div', { style: 'font-size:10px;color:#666;margin:2px 0 0 20px;line-height:1.35;', text: descricao }));
  }

  function renderizarSeparador() {
    if (!painelSeparador) return;
    painelSeparador.innerHTML = '';
    painelSeparador.appendChild(el('div', { style: 'font-weight:700;font-size:13px;color:#333;margin-bottom:2px;', text: 'WazePT Abreviaturas' }));
    painelSeparador.appendChild(linhaVersao());

    const nome = obterNomeEditor();
    if (!editorAutorizado()) {
      const caixa = el('div', { class: 'wptab-aviso' });
      if (allowlistState.origem === 'falha' || !allowlistState.checked) {
        caixa.textContent = 'Não foi possível verificar o teu acesso (sem ligação à base de dados ou o Tampermonkey está a bloquear o domínio do Firebase). Enquanto isso, o painel de edição mostra só as sugestões de correção, sem botões.';
      } else {
        caixa.textContent = `Acesso restrito: o editor ${nome || '(sem sessão iniciada)'} ainda não está autorizado a usar o script. `
          + 'O pedido de acesso fica registado automaticamente para os administradores. Enquanto isso, o painel de edição mostra as sugestões de correção, sem botões.';
      }
      painelSeparador.appendChild(caixa);
      const btn = botao('Verificar acesso de novo', async () => {
        btn.disabled = true;
        const antes = assinaturaAcesso();
        await refreshAllowlistState({ forcar: true });
        if (antes !== assinaturaAcesso()) aplicarEstadoAcesso(); else renderizarSeparador();
        toast(editorAutorizado() ? 'Acesso autorizado.' : 'Ainda sem acesso.');
      });
      painelSeparador.appendChild(el('div', { style: 'margin:8px 0 12px;' }, btn));
      painelSeparador.appendChild(caixaEstadoDados());
    } else {
      const perms = allowlistState.perms;
      const marca = (v) => (v ? '✓' : '✗');
      painelSeparador.appendChild(el('div', { style: 'font-size:11px;color:#444;margin-bottom:8px;line-height:1.5;' },
        `Editor: ${nome || '—'}${accessIsOwnerName(nome) ? ' (dono)' : ''}`,
        el('br'),
        `Script ✓ · Destaques ${marca(perms.destaques)} · Admin ${marca(perms.admin)}`));

      if (ehAdmin()) {
        painelSeparador.appendChild(el('div', { style: 'margin-bottom:12px;' }, botao('🛡 Painel de administração', () => abrirPainelAdmin(), 'pri')));
      }

      painelSeparador.appendChild(caixaEstadoDados());

      if (podeUsarDestaques()) {
        painelSeparador.appendChild(el('div', { style: 'font-weight:700;font-size:12px;margin:4px 0 6px;', text: 'Preferências de destaque (só neste navegador)' }));
        painelSeparador.appendChild(renderizarToggleGeral({
          chave: 'naoDestacarBloqueados',
          rotulo: 'Não destacar segmentos bloqueados',
          descricao: 'Quando ativo, o script não destaca no mapa segmentos acima do teu nível de edição.',
        }));
        painelSeparador.appendChild(renderizarToggleGeral({
          chave: 'soDestacarComCidade',
          rotulo: 'Só destacar segmentos com localidade',
          descricao: 'Quando ativo (por omissão), os toggles "Erros", "Alt." e "Fix Loc." só destacam segmentos que já têm uma cidade definida.',
        }));
      }

      renderizarConsultaRegras(painelSeparador);
    }

    painelSeparador.appendChild(el('div', { style: 'margin-top:10px;font-style:italic;color:#a05a00;font-size:11px;', text: 'Este script pode cometer erros, cabe a cada editor avaliar as correções que este script executar com bom senso' }));
    painelSeparador.appendChild(el('div', {
      style: 'font-size:10px;color:#888;text-align:center;margin-top:10px;',
      html: 'Este script foi feito por '
        + '<a href="https://www.waze.com/pt-PT/user/editor/Xtryker" target="_blank" rel="noopener noreferrer" style="color:#888;text-decoration:underline;">Xtryker</a>'
        + ' com amor para a comunidade <a href="https://linktr.ee/wazept" target="_blank" rel="noopener noreferrer" style="color:#888;text-decoration:underline;">WazePT</a>',
    }));
  }

  // ==================================================================
  // PAINEL DE ADMINISTRAÇÃO (só administradores; o dono vê-o sempre)
  //
  //   • Editores  — quem pode usar o script e o quê (Script / Destaques /
  //                 Admin); os administradores podem nomear outros.
  //   • Regras    — todas as listas (abreviaturas, correções, erros
  //                 ortográficos, lista branca…), editadas num RASCUNHO.
  //   • Definições— tipos de segmento verificados e tipos com cidade.
  //
  // Nada nas Regras/Definições chega aos editores antes de "Publicar". A
  // publicação usa uma escrita condicional (ETag): se outro administrador
  // publicou entretanto, é recusada em vez de apagar o trabalho dele. Os
  // editores recebem a revisão nova quando a cache de 24 h expirar.
  // ==================================================================
  let adm = null;

  function clonar(v) { return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)); }

  function admSujo() {
    return !!adm && adm.rascunho !== null && JSON.stringify(adm.rascunho) !== JSON.stringify(adm.publicado);
  }

  function admNovos() {
    return adm ? adm.users.filter((u) => u.isNew).length : 0;
  }

  function abrirPainelAdmin() {
    if (!ehAdmin()) { toast('O painel de administração não está ativo para a tua conta.'); return; }
    if (adm) { adm.modal.modal.focus(); return; }
    adm = {
      aba: 'regras',
      users: [], usersCarregados: false, usersErro: '', filtroUsers: '', textoNovo: '',
      configCarregada: false, configErro: '', etag: null, meta: metaDe(null), existe: false,
      publicado: null, rascunho: null,
      seccao: SECCOES_REGRAS[0].id, filtro: '', editar: null, novo: {},
      teste: '', ocupado: false, modal: null, campos: {},
    };
    adm.modal = abrirModal({
      titulo: '🛡 WazePT Abreviaturas — Administração',
      largura: 980,
      altura: '86vh',
      podeFechar: async () => !admSujo() || confirmar('Há alterações por publicar nas regras. Fechar e perdê-las?', { titulo: 'Alterações por publicar', rotuloOk: 'Fechar sem publicar', perigo: true }),
      aoFechar: () => { adm = null; },
      construir: ({ modal, corpo }) => {
        corpo.style.padding = '0';
        corpo.style.display = 'flex';
        corpo.style.flexDirection = 'column';
        corpo.style.overflow = 'hidden';
        modal.style.height = '86vh';
      },
    });
    renderizarAdmin();
    admCarregarUtilizadores();
    admCarregarConfig();
  }

  function fecharPainelAdmin() {
    if (adm && adm.modal) adm.modal.fechar(true);
  }

  // Reconstrói o conteúdo mantendo o foco/cursor e o scroll das listas.
  function renderizarAdmin() {
    if (!adm) return;
    const corpo = adm.modal.corpo;
    const ativo = document.activeElement;
    const fk = ativo && corpo.contains(ativo) ? ativo.dataset.fk : null;
    let selecao = null;
    try { if (fk && typeof ativo.selectionStart === 'number') selecao = [ativo.selectionStart, ativo.selectionEnd]; } catch (e) { /* ignora */ }
    const scrolls = {};
    corpo.querySelectorAll('[data-sk]').forEach((n) => { scrolls[n.dataset.sk] = n.scrollTop; });

    corpo.innerHTML = '';
    const novos = admNovos();
    const abas = el('div', { class: 'wptab-tabs' });
    for (const [id, rotulo] of [['regras', 'Regras'], ['definicoes', 'Definições'], ['editores', `Editores${novos ? ` (${novos} novo${novos > 1 ? 's' : ''})` : ''}`]]) {
      abas.appendChild(el('div', {
        class: `wptab-tab${adm.aba === id ? ' on' : ''}`,
        text: rotulo,
        onclick: () => { adm.aba = id; adm.editar = null; renderizarAdmin(); },
      }));
    }
    corpo.appendChild(abas);

    const area = el('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;' });
    corpo.appendChild(area);
    if (adm.aba === 'editores') renderizarAbaEditores(area);
    else if (adm.aba === 'definicoes') renderizarAbaDefinicoes(area);
    else renderizarAbaRegras(area);

    if (adm.aba !== 'editores') corpo.appendChild(barraPublicacao());

    corpo.querySelectorAll('[data-sk]').forEach((n) => { if (scrolls[n.dataset.sk] !== undefined) n.scrollTop = scrolls[n.dataset.sk]; });
    if (fk) {
      const alvo = corpo.querySelector(`[data-fk="${fk}"]`);
      if (alvo) {
        alvo.focus();
        try { if (selecao) alvo.setSelectionRange(selecao[0], selecao[1]); } catch (e) { /* ignora */ }
      }
    }
  }

  // Os campos de "acrescentar" (novo-…) e de edição (ed-…) guardam o que
  // foi escrito em adm.campos, para um redesenho não apagar texto a meio.
  function campoPersistente(fk) {
    return !!fk && (fk.startsWith('novo-') || fk.startsWith('ed-'));
  }

  function ligarPersistencia(no, fk) {
    if (!campoPersistente(fk) || !adm) return;
    if (Object.prototype.hasOwnProperty.call(adm.campos, fk)) no.value = adm.campos[fk];
    const guardar = () => { if (adm) adm.campos[fk] = no.value; };
    no.addEventListener('input', guardar);
    no.addEventListener('change', guardar);
  }

  function limparCampos(prefixo) {
    if (!adm) return;
    for (const k of Object.keys(adm.campos)) if (k.startsWith(prefixo)) delete adm.campos[k];
  }

  function inputAdm(fk, valor, placeholder, estilo = '') {
    const i = el('input', { type: 'text', class: 'wptab-in', placeholder, style: estilo, spellcheck: false });
    i.value = valor ?? '';
    if (fk) i.dataset.fk = fk;
    ligarPersistencia(i, fk);
    return i;
  }

  // ------------------------------------------------------------------
  // Editores
  // ------------------------------------------------------------------
  async function admCarregarUtilizadores({ avisar = false } = {}) {
    if (!adm || !ehAdmin()) return;
    adm.usersErro = '';
    try {
      const res = await pedidoFirebase('users');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!adm) return;
      adm.users = accessUsersToList(data).filter((u) => !accessIsOwnerName(u.name) && !accessIsOwnerName(u.key));
      adm.usersCarregados = true;
      if (avisar) toast('Lista de editores atualizada.');
    } catch (erro) {
      LOGE('Falha ao carregar os editores:', erro);
      if (adm) adm.usersErro = 'Não foi possível contactar a base de dados de acessos.';
    }
    renderizarAdmin();
  }

  async function admAdicionarUtilizador(nomeBruto) {
    if (!ehAdmin()) { toast('Sem permissão de administrador.'); return false; }
    const name = limparNomeAcesso(nomeBruto);
    if (!name) { toast('Escreve um nome de editor válido.'); return false; }
    if (accessIsOwnerName(name)) { toast('O dono tem sempre acesso.'); return false; }
    const key = accessEditorKey(name);
    const existente = adm.users.find((u) => u.key === key);
    if (existente && !existente.isNew) { toast('Esse editor já está na lista.'); return false; }
    try {
      const registo = {
        name,
        enabled: true,
        isNew: false,
        perms: { ...ACCESS_PERMS_NOVO },
        addedBy: String(obterNomeEditor() || '').slice(0, 64),
        addedAt: { '.sv': 'timestamp' },
      };
      const res = await pedidoFirebase(`users/${encodeURIComponent(key)}`, { method: 'PUT', body: registo });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(`${name} — editor acrescentado.`);
      await admCarregarUtilizadores();
      return true;
    } catch (erro) {
      LOGE('Falha ao acrescentar editor:', erro);
      toast('Não foi possível gravar a alteração.');
      return false;
    }
  }

  async function admRemoverUtilizador(user) {
    if (!ehAdmin()) { toast('Sem permissão de administrador.'); return; }
    if (accessEditorKey(obterNomeEditor()) === user.key) { toast('Não te podes remover a ti próprio — pede a outro administrador.'); return; }
    if (!(await confirmar(`${user.name}\nEste editor vai perder o acesso ao script.`, { titulo: 'Remover editor', rotuloOk: 'Remover', perigo: true }))) return;
    try {
      const res = await pedidoFirebase(`users/${encodeURIComponent(user.key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (adm) adm.users = adm.users.filter((u) => u.key !== user.key);
      toast(`${user.name} — editor removido.`);
      renderizarAdmin();
    } catch (erro) {
      LOGE('Falha ao remover editor:', erro);
      toast('Não foi possível gravar a alteração.');
    }
  }

  // id: 'enabled' (Script) ou uma permissão. Qualquer decisão de um
  // administrador retira também a etiqueta "Novo".
  async function admDefinirPermissao(user, id, valor) {
    if (!ehAdmin()) { toast('Sem permissão de administrador.'); return false; }
    const proprio = accessEditorKey(obterNomeEditor()) === user.key;
    if (proprio && !valor && (id === 'admin' || id === 'enabled')) {
      toast('Não podes retirar o teu próprio acesso de administrador — pede a outro administrador.');
      return false;
    }
    try {
      const body = id === 'enabled' ? { enabled: valor, isNew: false } : { [`perms/${id}`]: valor, isNew: false };
      const res = await pedidoFirebase(`users/${encodeURIComponent(user.key)}`, { method: 'PATCH', body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (id === 'enabled') user.enabled = valor; else user.perms[id] = valor;
      user.isNew = false;
      return true;
    } catch (erro) {
      LOGE('Falha ao gravar permissão:', erro);
      toast('Não foi possível gravar a alteração.');
      return false;
    }
  }

  const COLUNAS_ACESSO = [
    ['enabled', 'Script', 'Pode usar o script (botões e sugestões no painel de edição). Sem isto, vê só as mensagens informativas.'],
    ['destaques', 'Destaques', 'Painel flutuante dos toggles e destaques de segmentos no mapa.'],
    ['admin', 'Admin', 'Vê o painel de administração: gere editores e as regras.'],
  ];

  function renderizarAbaEditores(area) {
    const wrap = el('div', { style: 'padding:12px 14px;display:flex;flex-direction:column;min-height:0;flex:1;' });
    area.appendChild(wrap);

    if (!adm.usersCarregados) {
      wrap.appendChild(el('div', { class: adm.usersErro ? 'wptab-aviso' : 'wptab-nota', text: adm.usersErro || 'A carregar…' }));
      if (adm.usersErro) wrap.appendChild(el('div', {}, botao('Tentar de novo', () => admCarregarUtilizadores())));
      return;
    }

    const inNovo = inputAdm('adm-novo', adm.textoNovo, 'Nome de editor do WME', 'flex:1;');
    inNovo.maxLength = 64;
    inNovo.addEventListener('input', () => { adm.textoNovo = inNovo.value; });
    const acrescentar = async () => {
      if (await admAdicionarUtilizador(inNovo.value) && adm) { adm.textoNovo = ''; renderizarAdmin(); }
    };
    inNovo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); acrescentar(); } });
    const filtro = inputAdm('adm-filtro-users', adm.filtroUsers, 'Procurar editores…', 'flex:1;');

    wrap.appendChild(el('div', { style: 'display:flex;gap:6px;margin-bottom:6px;' }, inNovo, botao('Acrescentar', acrescentar, 'pri')));
    wrap.appendChild(el('div', { style: 'display:flex;gap:6px;margin-bottom:8px;' }, filtro, botao('↻ Atualizar', () => admCarregarUtilizadores({ avisar: true }))));
    wrap.appendChild(el('div', { class: 'wptab-nota', text: 'Os editores sem registo que abrem o WME com o script aparecem aqui como "Novo", com tudo desligado. As alterações chegam ao editor em até 1 hora (ou de imediato com "Verificar acesso de novo" no separador do script).' }));

    const lista = el('div', { class: 'wptab-lista', style: 'flex:1;min-height:0;' });
    lista.dataset.sk = 'users';
    const cab = el('div', { class: 'wptab-row wptab-head' }, el('div', { style: 'flex:1;', text: 'Editor' }));
    for (const [, rotulo, dica] of COLUNAS_ACESSO) cab.appendChild(el('div', { style: 'width:70px;text-align:center;', text: rotulo, title: dica }));
    cab.appendChild(el('div', { style: 'width:26px;' }));
    lista.appendChild(cab);

    const linhas = [];
    const mkLinha = (user, dono) => {
      const nome = el('div', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', title: user.addedBy ? `${user.name} — acrescentado por ${user.addedBy} em ${formatarData(user.addedAt)}` : user.name }, user.name);
      if (dono) nome.appendChild(el('span', { class: 'wptab-badge', text: 'Dono' }));
      if (user.isNew) nome.appendChild(el('span', { class: 'wptab-badge novo', text: 'Novo' }));
      const linha = el('div', { class: 'wptab-row' }, nome);
      linha.dataset.q = user.name.toLowerCase();
      for (const [id, rotulo] of COLUNAS_ACESSO) {
        const cb = el('input', { type: 'checkbox', title: `${rotulo} — ${user.name}` });
        const ligado = () => (id === 'enabled' ? user.enabled !== false : user.perms[id] === true);
        cb.checked = dono ? true : ligado();
        cb.disabled = dono;
        if (!dono) {
          cb.addEventListener('change', async () => {
            const quer = cb.checked;
            cb.disabled = true;
            const ok = await admDefinirPermissao(user, id, quer);
            cb.disabled = false;
            if (!ok) cb.checked = ligado();
            else renderizarAdmin();
          });
        }
        linha.appendChild(el('div', { style: 'width:70px;text-align:center;' }, cb));
      }
      linha.appendChild(dono
        ? el('div', { style: 'width:26px;' })
        : el('div', { style: 'width:26px;text-align:center;' }, botao('✕', () => admRemoverUtilizador(user), 'mini perigo', 'Remover editor')));
      linhas.push(linha);
      return linha;
    };
    lista.appendChild(mkLinha({ name: ACCESS_OWNER_NAME, enabled: true, perms: permsDono() }, true));
    adm.users.forEach((u) => lista.appendChild(mkLinha(u, false)));
    wrap.appendChild(lista);
    if (!adm.users.length) wrap.appendChild(el('div', { class: 'wptab-nota', text: 'Ainda não há outros editores — acrescenta um acima.' }));

    const aplicarFiltro = () => {
      const q = adm.filtroUsers.trim().toLowerCase();
      linhas.forEach((l) => { l.style.display = !q || l.dataset.q.includes(q) ? '' : 'none'; });
    };
    filtro.addEventListener('input', () => { adm.filtroUsers = filtro.value; aplicarFiltro(); });
    aplicarFiltro();
  }

  // ------------------------------------------------------------------
  // Regras — carregar, publicar, importar/exportar
  // ------------------------------------------------------------------
  async function admCarregarConfig() {
    if (!adm || !ehAdmin()) return;
    adm.configErro = '';
    try {
      const res = await gmFetch(firebaseUrl('config'), { headers: { 'X-Firebase-ETag': 'true' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.header('etag');
      const config = await res.json();
      if (!adm) return;
      adm.etag = etag;
      adm.meta = metaDe(config && config.meta);
      if (config && typeof config.dataJson === 'string') {
        const data = normalizarDados(JSON.parse(config.dataJson));
        if (!data) throw new Error('config/dataJson inválido');
        adm.existe = true;
        adm.publicado = data;
        adm.rascunho = clonar(data);
      } else {
        adm.existe = false;
        adm.publicado = null;
        adm.rascunho = null;
      }
      adm.configCarregada = true;
    } catch (erro) {
      LOGE('Falha ao carregar as regras para edição:', erro);
      if (adm) adm.configErro = 'Não foi possível obter as regras da base de dados.';
    }
    renderizarAdmin();
  }

  async function admPublicar() {
    if (!ehAdmin()) { toast('Sem permissão de administrador.'); return; }
    if (!adm.rascunho || adm.ocupado) return;
    const dados = normalizarDados(adm.rascunho);
    if (!dados) { toast('O rascunho não é válido.'); return; }
    const perdidas = SECCOES_REGRAS.filter((s) => (dados[s.id] || []).length !== (adm.rascunho[s.id] || []).length);
    if (perdidas.length && !(await confirmar(`Algumas entradas inválidas vão ser descartadas ao publicar (${perdidas.map((s) => s.titulo).join(', ')}). Continuar?`, { titulo: 'Entradas inválidas' }))) return;
    const rev = (adm.meta.rev || 0) + 1;
    if (!(await confirmar(`Publicar a revisão ${rev} das regras?\nOs editores recebem-na quando a cache local deles (24 h) expirar.`, { titulo: 'Publicar regras', rotuloOk: 'Publicar' }))) return;

    adm.ocupado = true;
    renderizarAdmin();
    try {
      const body = {
        meta: { rev, updatedAt: { '.sv': 'timestamp' }, updatedBy: String(obterNomeEditor() || '').slice(0, 64) },
        dataJson: JSON.stringify(dados),
      };
      const res = await pedidoFirebase('config', { method: 'PUT', body, headers: adm.etag ? { 'if-match': adm.etag } : {} });
      if (res.status === 412) {
        toast('Outro administrador publicou entretanto. Recarrega as regras antes de publicar.');
        await confirmar('Outro administrador publicou uma revisão nova enquanto editavas. A tua publicação foi recusada para não apagar o trabalho dele.\n\nExporta o teu rascunho se quiseres guardá-lo, e depois usa "Recarregar" para obter a versão atual.', { titulo: 'Conflito de publicação' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gravado = await res.json().catch(() => null);
      const meta = metaDe(gravado && gravado.meta);
      if (!meta.rev) meta.rev = rev;
      // Aplica já neste navegador, sem esperar pelas 24 h.
      const fetchedAt = Date.now();
      gravarCacheDados({ ...meta, fetchedAt, data: dados });
      ativarDados(dados, meta, 'firebase', fetchedAt);
      aplicarRegrasNovas();
      toast(`Revisão ${meta.rev} publicada.`);
      await admCarregarConfig();
    } catch (erro) {
      LOGE('Falha ao publicar as regras:', erro);
      toast('Não foi possível publicar as regras.');
    } finally {
      if (adm) { adm.ocupado = false; renderizarAdmin(); }
    }
  }

  function admExportar() {
    if (!adm.rascunho) return;
    const blob = new Blob([JSON.stringify(adm.rascunho, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `wazept-abreviaturas-dados-rev${adm.meta.rev || 0}${admSujo() ? '-rascunho' : ''}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Aceita o ficheiro de dados simples, ou um export do Firebase com
  // { config: { dataJson } } / { dataJson }.
  function interpretarImportacao(texto) {
    let raw = JSON.parse(texto);
    if (raw && raw.config && typeof raw.config.dataJson === 'string') raw = JSON.parse(raw.config.dataJson);
    else if (raw && typeof raw.dataJson === 'string') raw = JSON.parse(raw.dataJson);
    return normalizarDados(raw);
  }

  function admImportar() {
    const input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none;' });
    input.addEventListener('change', async () => {
      const ficheiro = input.files && input.files[0];
      input.remove();
      if (!ficheiro || !adm) return;
      try {
        const dados = interpretarImportacao(await ficheiro.text());
        if (!dados) { toast('O ficheiro não contém regras do WazePT Abreviaturas.'); return; }
        const resumo = SECCOES_REGRAS.map((s) => `${s.titulo}: ${dados[s.id].length}`).join('\n');
        if (adm.rascunho && !(await confirmar(`Substituir o rascunho atual pelo conteúdo do ficheiro?\n\n${resumo}`, { titulo: 'Importar regras', rotuloOk: 'Substituir' }))) return;
        adm.rascunho = dados;
        adm.editar = null;
        toast('Regras importadas para o rascunho. Revê e carrega em "Publicar".');
        renderizarAdmin();
      } catch (erro) {
        LOGE('Falha ao importar:', erro);
        toast('Não foi possível ler o ficheiro JSON.');
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  function barraPublicacao() {
    const barra = el('div', { class: 'wptab-barra' });
    const sujo = admSujo();
    const info = adm.existe
      ? `Revisão publicada: ${adm.meta.rev || '—'} · ${formatarData(adm.meta.updatedAt)}${adm.meta.updatedBy ? ` por ${adm.meta.updatedBy}` : ''}`
      : 'Ainda não há regras publicadas.';
    barra.appendChild(el('div', { style: 'flex:1;font-size:11px;color:#666;min-width:200px;' }, info,
      sujo ? el('span', { style: 'color:#c00;font-weight:700;margin-left:8px;', text: '● Alterações por publicar' }) : null));
    barra.appendChild(botao('Importar JSON', () => admImportar(), '', 'Carregar regras de um ficheiro para o rascunho'));
    const exp = botao('Exportar JSON', () => admExportar(), '', 'Descarregar o rascunho atual');
    exp.disabled = !adm.rascunho;
    barra.appendChild(exp);
    const rec = botao('Recarregar', async () => {
      if (admSujo() && !(await confirmar('Descartar as alterações por publicar e recarregar da base de dados?', { titulo: 'Recarregar', rotuloOk: 'Descartar', perigo: true }))) return;
      adm.editar = null;
      await admCarregarConfig();
    }, '', 'Voltar a ler as regras publicadas');
    barra.appendChild(rec);
    const desc = botao('Descartar', async () => {
      if (!(await confirmar('Descartar todas as alterações por publicar?', { titulo: 'Descartar', rotuloOk: 'Descartar', perigo: true }))) return;
      adm.rascunho = clonar(adm.publicado);
      adm.editar = null;
      renderizarAdmin();
    });
    desc.disabled = !sujo;
    barra.appendChild(desc);
    const pub = botao(adm.ocupado ? 'A publicar…' : 'Publicar', () => admPublicar(), 'pri');
    pub.disabled = adm.ocupado || !adm.rascunho || (!sujo && adm.existe);
    barra.appendChild(pub);
    return barra;
  }

  // Corre o motor com um conjunto de dados temporário e repõe o activo.
  function testarComDados(dados, nome) {
    reconstruirRegras(dados);
    try {
      return {
        corrigido: normalizarNomeCompleto(nome),
        alternativo: removerAspas(expandirNome(nome)),
        desconhecida: temAbreviaturaDesconhecida(nome),
        ambiguo: temImpAmbiguoForaDaPrimeira(mascararAspas(nome).mascarado),
      };
    } finally {
      reconstruirRegras(dadosAtivos);
    }
  }

  function caixaTeste() {
    const caixa = el('div', { style: 'border:1px solid #e5e5e5;border-radius:4px;padding:6px 8px;margin-bottom:8px;background:#fcfcfc;' });
    const inp = inputAdm('adm-teste', adm.teste, 'Testar um nome de rua com o rascunho… (ex.: Avenida Doutor Joao Silva)', 'width:100%;');
    const res = el('div', { style: 'font-size:11px;line-height:1.55;margin-top:4px;' });
    const atualizar = () => {
      adm.teste = inp.value;
      res.innerHTML = '';
      const nome = inp.value.trim();
      if (!nome || !adm.rascunho) return;
      const r = testarComDados(adm.rascunho, nome);
      res.append(
        el('div', {}, 'Principal: ', el('strong', { text: r.corrigido }), r.corrigido === nome ? el('span', { style: 'color:#1a7a1a;', text: ' (sem alterações)' }) : null),
        el('div', {}, 'Alternativo: ', el('strong', { text: r.alternativo })),
      );
      if (r.desconhecida) res.appendChild(el('div', { style: 'color:#c00;', text: '⚠ Possível abreviatura desconhecida (o editor teria de corrigir manualmente).' }));
      if (r.ambiguo) res.appendChild(el('div', { style: 'color:#a05a00;', text: '⚠ "Imp." ambíguo fora da primeira palavra (botões desativados).' }));
    };
    inp.addEventListener('input', atualizar);
    caixa.append(inp, res);
    atualizar();
    return caixa;
  }

  function renderizarAbaRegras(area) {
    if (!adm.configCarregada) {
      const w = el('div', { style: 'padding:12px 14px;' });
      w.appendChild(el('div', { class: adm.configErro ? 'wptab-aviso' : 'wptab-nota', text: adm.configErro || 'A carregar…' }));
      if (adm.configErro) w.appendChild(botao('Tentar de novo', () => admCarregarConfig()));
      area.appendChild(w);
      return;
    }
    if (!adm.rascunho) {
      const w = el('div', { style: 'padding:12px 14px;' });
      w.appendChild(el('div', { class: 'wptab-aviso', text: 'A base de dados ainda não tem regras. Importa o ficheiro inicial (wazept-abreviaturas-dados.json) e carrega em "Publicar".' }));
      const acoes = el('div', { style: 'display:flex;gap:6px;margin-top:8px;' }, botao('Importar ficheiro JSON', () => admImportar(), 'pri'));
      if (dadosAtivos) {
        acoes.appendChild(botao('Começar a partir das regras em cache deste navegador', () => {
          adm.rascunho = clonar(dadosAtivos);
          renderizarAdmin();
        }));
      }
      w.appendChild(acoes);
      area.appendChild(w);
      return;
    }

    const grelha = el('div', { style: 'display:flex;flex:1;min-height:0;' });
    area.appendChild(grelha);

    // Coluna das secções
    const nav = el('div', { style: 'width:230px;flex:none;border-right:1px solid #eee;overflow-y:auto;padding:8px;' });
    nav.dataset.sk = 'nav';
    let grupoAtual = null;
    for (const s of SECCOES_REGRAS) {
      if (s.grupo !== grupoAtual) {
        grupoAtual = s.grupo;
        nav.appendChild(el('div', { style: 'font-size:10px;text-transform:uppercase;color:#888;margin:8px 0 3px 4px;letter-spacing:.5px;', text: s.grupo }));
      }
      const alterada = JSON.stringify(adm.rascunho[s.id]) !== JSON.stringify(adm.publicado ? adm.publicado[s.id] : undefined);
      nav.appendChild(el('div', {
        class: `wptab-sec${adm.seccao === s.id ? ' on' : ''}`,
        onclick: () => { adm.seccao = s.id; adm.filtro = ''; adm.editar = null; renderizarAdmin(); },
      }, el('span', {}, s.titulo, alterada ? el('span', { style: 'color:#c00;', text: ' ●' }) : null), el('span', { style: 'color:#888;', text: String(adm.rascunho[s.id].length) })));
    }
    grelha.appendChild(nav);

    const painel = el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;padding:8px 12px;' });
    grelha.appendChild(painel);
    painel.appendChild(caixaTeste());
    renderizarEditorSeccao(painel, SECCOES_REGRAS.find((s) => s.id === adm.seccao) || SECCOES_REGRAS[0]);
  }

  // ------------------------------------------------------------------
  // Editor genérico de uma secção (pares / regras / lista)
  // ------------------------------------------------------------------

  // Constrói os campos de uma entrada. Devolve { nos, ler } — ler() devolve
  // { item } ou { erro }.
  function camposEntrada(seccao, item, prefixo) {
    if (seccao.tipo === 'lista') {
      const i = inputAdm(`${prefixo}-v`, item || '', seccao.exemplo || '', 'flex:1;');
      return {
        nos: [i],
        ler: () => {
          let v = i.value.trim();
          if (seccao.minusculas) v = v.toLowerCase();
          if (seccao.normalizar) v = normalizarParaComparar(v);
          if (!v) { i.classList.add('erro'); return { erro: 'Escreve um valor.' }; }
          return { item: v };
        },
      };
    }
    if (seccao.tipo === 'pares') {
      const inputs = seccao.campos.map(([k, rotulo, ex], idx) => {
        const i = inputAdm(`${prefixo}-${k}`, item ? item[k] : '', `${rotulo} (${ex})`, 'flex:1;');
        i.title = rotulo;
        if (idx === 0) i.style.maxWidth = '40%';
        return i;
      });
      return {
        nos: inputs,
        ler: () => {
          const out = {};
          let erro = null;
          seccao.campos.forEach(([k, rotulo], idx) => {
            const v = inputs[idx].value.trim();
            if (!v) { inputs[idx].classList.add('erro'); erro = `Preenche "${rotulo}".`; }
            out[k] = v;
          });
          return erro ? { erro } : { item: out };
        },
      };
    }
    // regras
    const tipo = el('select', { class: 'wptab-in', title: 'Tipo de regra' });
    TIPOS_REGRA.forEach(([id, rotulo]) => tipo.appendChild(el('option', { value: id, text: rotulo })));
    tipo.value = item ? item.tipo : 'palavra';
    tipo.dataset.fk = `${prefixo}-tipo`;
    ligarPersistencia(tipo, tipo.dataset.fk);
    const de = inputAdm(`${prefixo}-de`, item ? (item.tipo === 're' ? item.re : item.de) : '', '', 'flex:1;max-width:38%;');
    const flags = inputAdm(`${prefixo}-flags`, item ? item.flags || '' : '', 'gi', 'width:38px;flex:none;');
    flags.title = 'Flags da expressão (vazio = gi: global, ignora maiúsculas)';
    const correto = inputAdm(`${prefixo}-correto`, item ? item.correto.trimEnd() : '', 'Correto', 'flex:1;');
    const desc = inputAdm(`${prefixo}-desc`, item ? item.desc || '' : '', 'Descrição da regra (ex.: "Nossa Sra." → "N.ª Sr.ª")', 'flex:1 1 100%;order:10;');
    const ajuda = el('div', { class: 'wptab-nota', style: 'flex:1 1 100%;margin:0;order:11;', text: 'Marcadores: {ini} = início de palavra · {fim} = fim de palavra · {L} = uma letra (incluindo acentuadas). Ex.: {ini}Nossa\\s+Sra\\.\\s*' });
    const espaco = el('input', { type: 'checkbox', title: 'Acrescentar um espaço no fim da substituição (necessário nas abreviaturas, para não colar à palavra seguinte)' });
    espaco.checked = item ? /\s$/.test(item.correto) : false;
    {
      const fkEsp = `${prefixo}-espaco`;
      if (adm && Object.prototype.hasOwnProperty.call(adm.campos, fkEsp)) espaco.checked = adm.campos[fkEsp] === '1';
      espaco.addEventListener('change', () => { if (adm) adm.campos[fkEsp] = espaco.checked ? '1' : '0'; });
    }
    const atualizarDica = () => {
      de.placeholder = tipo.value === 're' ? 'Expressão regular (ex.: {ini}Qt\\.(?!ª))' : (tipo.value === 'abrev' ? 'Abreviatura errada (ex.: Trav.)' : 'Palavra errada (ex.: Joao)');
      const re = tipo.value === 're';
      desc.style.display = re ? '' : 'none';
      ajuda.style.display = re ? '' : 'none';
    };
    tipo.addEventListener('change', () => {
      atualizarDica();
      if (!item) {
        espaco.checked = tipo.value === 'abrev';
        if (adm) adm.campos[`${prefixo}-espaco`] = espaco.checked ? '1' : '0';
      }
    });
    atualizarDica();
    return {
      nos: [tipo, de, flags, correto, el('label', { style: 'display:flex;align-items:center;gap:2px;font-size:11px;white-space:nowrap;', title: espaco.title }, espaco, '+ espaço'), desc, ajuda],
      ler: () => {
        const t = tipo.value;
        const v = de.value.trim();
        const f = flags.value.trim();
        const c = correto.value.trim();
        if (!v) { de.classList.add('erro'); return { erro: 'Preenche o texto errado.' }; }
        if (!c) { correto.classList.add('erro'); return { erro: 'Preenche a forma correta.' }; }
        if (f && !/^[gimsuy]*$/.test(f)) { flags.classList.add('erro'); return { erro: 'Flags inválidas (usa só g, i, m, s, u, y).' }; }
        try {
          if (t === 're') new RegExp(expandirMarcadoresRegex(v), f || 'gi');
          else if (t === 'abrev') reAbreviatura(v, f || undefined);
          else reExpressao(v, f || undefined);
        } catch (e) {
          de.classList.add('erro');
          return { erro: `Expressão inválida: ${e.message}` };
        }
        const novo = t === 're' ? { tipo: 're', re: compactarMarcadoresRegex(v) } : { tipo: t, de: v };
        if (f) novo.flags = f;
        novo.correto = c + (espaco.checked ? ' ' : '');
        const d = desc.value.trim();
        if (t === 're' && d) novo.desc = d.slice(0, 200);
        return { item: novo };
      },
    };
  }

  function chaveDuplicado(seccao, item) {
    if (seccao.tipo === 'lista') return item;
    if (seccao.tipo === 'pares') return String(item[seccao.chave]).toLowerCase();
    return item.tipo === 're' ? `re:${item.re}` : `${item.tipo}:${String(item.de).toLowerCase()}`;
  }

  // Valida e grava uma entrada nova (idx null) ou editada (idx).
  function gravarEntradaRascunho(seccao, idx, item, posicao) {
    const lista = adm.rascunho[seccao.id];
    const chave = chaveDuplicado(seccao, item);
    const dup = lista.findIndex((x, i) => i !== idx && chaveDuplicado(seccao, x) === chave);
    if (dup !== -1) return `Já existe uma entrada igual (n.º ${dup + 1}).`;
    if (idx !== null) lista.splice(idx, 1);
    const n = lista.length;
    let pos = Number.isInteger(posicao) ? posicao - 1 : (idx !== null ? idx : n);
    pos = Math.max(0, Math.min(n, pos));
    lista.splice(pos, 0, item);
    return null;
  }

  function campoPosicao(fk, valor, max) {
    const i = el('input', { type: 'number', class: 'wptab-in', min: '1', max: String(max), title: 'Posição na lista (a ordem de aplicação importa)', style: 'width:58px;flex:none;' });
    i.value = valor ? String(valor) : '';
    i.placeholder = 'Pos.';
    i.dataset.fk = fk;
    ligarPersistencia(i, fk);
    return i;
  }

  function lerPosicao(input) {
    const v = parseInt(input.value, 10);
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  function renderizarEditorSeccao(painel, seccao) {
    const lista = adm.rascunho[seccao.id];
    painel.appendChild(el('div', { style: 'font-weight:700;font-size:13px;margin-bottom:2px;', text: `${seccao.titulo} (${lista.length})` }));
    painel.appendChild(el('div', { class: 'wptab-nota', text: seccao.desc }));

    // --- Acrescentar ---
    const msgNovo = el('div', { style: 'color:#c00;font-size:11px;min-height:14px;' });
    const campos = camposEntrada(seccao, null, `novo-${seccao.id}`);
    const pos = campoPosicao(`novo-${seccao.id}-pos`, '', lista.length + 1);
    let espelho = null;
    if (seccao.espelho) {
      espelho = el('input', { type: 'checkbox' });
      espelho.checked = adm.novo.espelho !== false;
      espelho.addEventListener('change', () => { adm.novo.espelho = espelho.checked; });
    }
    const acrescentar = () => {
      painel.querySelectorAll('.wptab-in.erro').forEach((n) => n.classList.remove('erro'));
      const r = campos.ler();
      if (r.erro) { msgNovo.textContent = r.erro; return; }
      const erro = gravarEntradaRascunho(seccao, null, r.item, lerPosicao(pos));
      if (erro) { msgNovo.textContent = erro; return; }
      if (espelho && espelho.checked) {
        const secEsp = SECCOES_REGRAS.find((s) => s.id === seccao.espelho);
        const inverso = { ext: r.item.exp, abrev: r.item.abrev };
        const erroEsp = gravarEntradaRascunho(secEsp, null, inverso, null);
        if (erroEsp) toast(`Abreviação não acrescentada: ${erroEsp}`);
      }
      limparCampos(`novo-${seccao.id}`);
      toast('Entrada acrescentada ao rascunho.');
      renderizarAdmin();
    };
    for (const n of campos.nos) {
      n.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); acrescentar(); } });
    }
    painel.appendChild(el('div', { style: 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;' }, ...campos.nos, pos, botao('+ Acrescentar', acrescentar, 'pri')));
    if (espelho) {
      painel.appendChild(el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;color:#555;margin-top:3px;cursor:pointer;' }, espelho,
        'Acrescentar também à lista "Abreviação" (por extenso → abreviatura), no fim — confirma depois a posição.'));
    }
    painel.appendChild(msgNovo);

    // --- Pesquisa ---
    const filtro = inputAdm(`filtro-${seccao.id}`, adm.filtro, 'Procurar nesta lista…', 'width:100%;margin-bottom:4px;');
    painel.appendChild(filtro);

    // --- Lista ---
    const caixa = el('div', { class: 'wptab-lista', style: 'flex:1;min-height:120px;' });
    caixa.dataset.sk = `lista-${seccao.id}`;
    const linhas = [];
    lista.forEach((item, idx) => {
      const linha = el('div', { class: 'wptab-row', style: 'font-size:12px;' });
      linha.dataset.q = normalizarParaComparar(textoPesquisavel(seccao, item));
      const num = el('div', { style: 'width:34px;flex:none;color:#999;font-size:10px;text-align:right;', text: `#${idx + 1}` });
      if (adm.editar && adm.editar.seccao === seccao.id && adm.editar.idx === idx) {
        const msg = el('div', { style: 'color:#c00;font-size:11px;width:100%;' });
        const ce = camposEntrada(seccao, item, `ed-${seccao.id}`);
        const pe = campoPosicao(`ed-${seccao.id}-pos`, idx + 1, lista.length);
        const gravar = () => {
          painel.querySelectorAll('.wptab-in.erro').forEach((n) => n.classList.remove('erro'));
          const r = ce.ler();
          if (r.erro) { msg.textContent = r.erro; return; }
          const erro = gravarEntradaRascunho(seccao, idx, r.item, lerPosicao(pe));
          if (erro) { msg.textContent = erro; return; }
          adm.editar = null;
          limparCampos('ed-');
          renderizarAdmin();
        };
        for (const n of [...ce.nos, pe]) {
          n.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); gravar(); }
          });
        }
        linha.style.flexWrap = 'wrap';
        linha.style.background = '#f5f9ff';
        linha.append(num, ...ce.nos, pe,
          botao('✔', gravar, 'mini', 'Gravar no rascunho'),
          botao('✖', () => { adm.editar = null; limparCampos('ed-'); renderizarAdmin(); }, 'mini', 'Cancelar'),
          msg);
      } else {
        linha.append(num, formatarEntrada(seccao, item),
          botao('✎', () => { limparCampos('ed-'); adm.editar = { seccao: seccao.id, idx }; renderizarAdmin(); }, 'mini', 'Editar'),
          botao('↑', () => { adm.editar = null; if (idx > 0) { [lista[idx - 1], lista[idx]] = [lista[idx], lista[idx - 1]]; renderizarAdmin(); } }, 'mini', 'Subir'),
          botao('↓', () => { adm.editar = null; if (idx < lista.length - 1) { [lista[idx + 1], lista[idx]] = [lista[idx], lista[idx + 1]]; renderizarAdmin(); } }, 'mini', 'Descer'),
          botao('🗑', () => { lista.splice(idx, 1); adm.editar = null; renderizarAdmin(); }, 'mini perigo', 'Apagar do rascunho'));
      }
      linhas.push(linha);
      caixa.appendChild(linha);
    });
    if (!lista.length) caixa.appendChild(el('div', { class: 'wptab-nota', style: 'padding:6px;', text: 'Sem entradas.' }));
    painel.appendChild(caixa);

    const aplicarFiltro = () => {
      const q = normalizarParaComparar(adm.filtro);
      linhas.forEach((l) => { l.style.display = !q || l.dataset.q.includes(q) ? '' : 'none'; });
    };
    filtro.addEventListener('input', () => { adm.filtro = filtro.value; aplicarFiltro(); });
    aplicarFiltro();
  }

  // ------------------------------------------------------------------
  // Definições (tipos de segmento)
  // ------------------------------------------------------------------
  function listaTiposSegmento({ titulo, descricao, ligado, alternar }) {
    const caixa = el('div', { style: 'margin-bottom:16px;' });
    caixa.appendChild(el('div', { style: 'font-weight:700;font-size:13px;margin-bottom:2px;', text: titulo }));
    caixa.appendChild(el('div', { class: 'wptab-nota', text: descricao }));
    const grelha = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:2px 12px;' });
    for (const { id, nome } of TODOS_TIPOS_VIA) {
      const cb = el('input', { type: 'checkbox', style: 'margin:0;' });
      cb.checked = ligado(id);
      cb.addEventListener('change', () => { alternar(id, cb.checked); renderizarAdmin(); });
      grelha.appendChild(el('label', { style: 'display:flex;align-items:center;gap:5px;padding:2px 0;cursor:pointer;' }, cb, `${nome} (id ${id})`));
    }
    caixa.appendChild(grelha);
    return caixa;
  }

  function renderizarAbaDefinicoes(area) {
    const w = el('div', { style: 'padding:12px 14px;overflow-y:auto;flex:1;' });
    w.dataset.sk = 'definicoes';
    area.appendChild(w);
    if (!adm.configCarregada || !adm.rascunho) {
      w.appendChild(el('div', { class: 'wptab-nota', text: adm.configCarregada ? 'Importa primeiro as regras no separador "Regras".' : (adm.configErro || 'A carregar…') }));
      return;
    }
    const d = adm.rascunho;
    w.appendChild(listaTiposSegmento({
      titulo: 'Tipos de segmento verificados',
      descricao: 'Tipos de segmento que o script verifica e destaca nos toggles "Erros", "Alt." e "Fix Loc.". Desligado = esse tipo nunca é destacado nem assinalado no painel de edição.',
      ligado: (id) => !d.tiposSegmentoDesativados.includes(id),
      alternar: (id, v) => {
        d.tiposSegmentoDesativados = v ? d.tiposSegmentoDesativados.filter((x) => x !== id) : [...d.tiposSegmentoDesativados, id];
      },
    }));
    w.appendChild(listaTiposSegmento({
      titulo: 'Tipos de segmento que devem ter cidade',
      descricao: 'Tipos de segmento destacados pelo toggle "Loc." quando não têm cidade definida no endereço principal (as rotundas ficam sempre de fora).',
      ligado: (id) => d.tiposComCidade.includes(id),
      alternar: (id, v) => {
        d.tiposComCidade = v ? [...d.tiposComCidade, id] : d.tiposComCidade.filter((x) => x !== id);
      },
    }));
  }

  // ==================================================================
  // ATUALIZAÇÕES DO SCRIPT (GitHub)
  //
  // Lê o cabeçalho do script publicado, compara o @version com a versão
  // instalada e, se houver uma mais recente, mostra uma janela com o botão
  // "Atualizar agora" (abre a página de instalação do gestor de scripts).
  // Independente do acesso: um editor com uma versão antiga tem de ser
  // avisado mesmo sem acesso confirmado. Mesmo mecanismo do WazePT Tools.
  //
  // MANTER EM SINTONIA com as linhas // @updateURL / // @downloadURL e com
  // as // @connect github.com / raw.githubusercontent.com do cabeçalho.
  // ==================================================================
  const UPDATE_INSTALL_URL = 'https://github.com/Xtryker/WazePT-Abreviaturas/raw/refs/heads/main/WazePT%20Abreviaturas.user.js';
  // A verificação lê o mesmo ficheiro directamente do raw.githubusercontent
  // com um parâmetro anti-cache, para a CDN do GitHub (~5 min) não esconder
  // uma versão acabada de publicar.
  const UPDATE_META_URL = 'https://raw.githubusercontent.com/Xtryker/WazePT-Abreviaturas/refs/heads/main/WazePT%20Abreviaturas.user.js';
  // Vários separadores abertos ao mesmo tempo reutilizam o último resultado.
  const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
  const UPDATE_RECHECK_EVERY_MS = 60 * 60 * 1000;
  // "Mais tarde" silencia a janela durante 24 h, só para essa versão.
  const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;
  const UPDATE_STATE_KEY = `${SCRIPT_ID}:atualizacao:v1`;
  const UPDATE_RANGE_BYTES = 8192;

  let atualizacaoEmCurso = false;
  let janelaAtualizacaoMostrada = false;

  function lerEstadoAtualizacao() {
    const v = lerJSONLocal(UPDATE_STATE_KEY, {});
    return v && typeof v === 'object' ? v : {};
  }
  function gravarEstadoAtualizacao(patch) {
    gravarJSONLocal(UPDATE_STATE_KEY, { ...lerEstadoAtualizacao(), ...patch });
  }

  function lerVersaoUserscript(texto) {
    const m = /^\s*\/\/\s*@version\s+(\S+)/m.exec(String(texto || ''));
    const v = m ? m[1].trim() : '';
    return /^\d+(\.\d+)*$/.test(v) ? v : null;
  }

  // >0 se a for mais recente do que b, <0 se mais antiga, 0 se iguais.
  function compararVersoes(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  function mostrarJanelaAtualizacao(nova) {
    let aInstalar = false;
    abrirModal({
      titulo: 'Nova versão disponível',
      largura: 420,
      aoFechar: () => {
        if (!aInstalar) gravarEstadoAtualizacao({ adiadaVersao: nova, adiadaAte: Date.now() + UPDATE_SNOOZE_MS });
      },
      construir: ({ corpo, fechar }) => {
        corpo.appendChild(el('div', {
          style: 'font-size:13px;line-height:1.55;margin-bottom:12px;',
          html: 'Está disponível uma nova versão do <b>WazePT Abreviaturas</b>.'
            + `<br><br>Versão instalada: <b>v${escaparHTML(SCRIPT_VERSION)}</b>`
            + `<br>Nova versão: <b>v${escaparHTML(nova)}</b>`
            + '<br><br>Prima <b>"Atualizar agora"</b> para abrir a página de instalação do gestor de scripts, '
            + 'confirme a atualização e depois recarregue o WME.',
        }));
        corpo.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;gap:6px;' },
          botao('Mais tarde', () => fechar()),
          botao('Atualizar agora', () => {
            aInstalar = true;
            gravarEstadoAtualizacao({ adiadaVersao: null, adiadaAte: 0 });
            try { window.open(UPDATE_INSTALL_URL, '_blank', 'noopener'); } catch (e) { LOGE('Não foi possível abrir a página de instalação:', e); }
            fechar();
          }, 'pri')));
      },
    });
  }

  // Espera que outra janela (ex.: o painel de administração) feche, em vez
  // de se sobrepor.
  function pedirAtualizacao(nova, tentativas = 24) {
    if (janelaAtualizacaoMostrada) return;
    if (pilhaModais.length > 0 && tentativas > 0) {
      setTimeout(() => pedirAtualizacao(nova, tentativas - 1), 5000);
      return;
    }
    janelaAtualizacaoMostrada = true;
    try { mostrarJanelaAtualizacao(nova); } catch (e) { janelaAtualizacaoMostrada = false; LOGE('Falha na janela de atualização:', e); }
  }

  function avaliarAtualizacao(nova, manual) {
    if (!nova) return;
    if (compararVersoes(nova, SCRIPT_VERSION) <= 0) {
      if (manual) toast(`Já tens a versão mais recente (v${SCRIPT_VERSION}).`);
      return;
    }
    const st = lerEstadoAtualizacao();
    const adiada = st.adiadaVersao === nova && Number(st.adiadaAte) > Date.now();
    if (adiada && !manual) return;
    if (manual) janelaAtualizacaoMostrada = false;
    pedirAtualizacao(nova);
  }

  async function verificarAtualizacao({ manual = false } = {}) {
    if (atualizacaoEmCurso) {
      if (manual) toast('A verificação de atualizações já está em curso.');
      return;
    }
    const st = lerEstadoAtualizacao();
    const recente = Number(st.ultimaVerificacao) > 0 && (Date.now() - Number(st.ultimaVerificacao)) < UPDATE_CHECK_INTERVAL_MS;
    if (recente && !manual) {
      avaliarAtualizacao(typeof st.ultimaVersao === 'string' ? st.ultimaVersao : null, false);
      return;
    }
    atualizacaoEmCurso = true;
    if (manual) toast('A procurar atualizações…');
    try {
      const res = await gmFetch(`${UPDATE_META_URL}?_=${Date.now()}`, {
        headers: { Range: `bytes=0-${UPDATE_RANGE_BYTES - 1}`, 'Cache-Control': 'no-cache' },
        anonymous: true,
        timeout: 15000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const nova = lerVersaoUserscript((await res.text()).slice(0, 16384));
      if (!nova) throw new Error('@version não encontrado no script publicado');
      gravarEstadoAtualizacao({ ultimaVerificacao: Date.now(), ultimaVersao: nova });
      avaliarAtualizacao(nova, manual);
    } catch (erro) {
      LOG('Falha ao verificar atualizações:', erro);
      if (manual) toast('Não foi possível verificar atualizações.');
    } finally {
      atualizacaoEmCurso = false;
    }
  }

  function iniciarVerificacaoAtualizacoes() {
    setTimeout(() => { verificarAtualizacao().catch((e) => LOG('verificação de atualizações falhou', e)); }, 4000);
    setInterval(() => { verificarAtualizacao().catch((e) => LOG('verificação de atualizações falhou', e)); }, UPDATE_RECHECK_EVERY_MS);
  }

  // ==================================================================
  // APLICAR ESTADO (acesso / regras) À INTERFACE
  // ==================================================================

  // Reconcilia tudo o que depende das permissões: painel flutuante,
  // destaques, botões do painel de edição, separador e painel de admin.
  function aplicarEstadoAcesso() {
    const painel = podeUsarDestaques() ? garantirPainel() : document.getElementById(`${SCRIPT_ID}-painel`);
    if (painel) painel.style.display = podeUsarDestaques() ? 'block' : 'none';
    const btnAdmin = document.getElementById(`${SCRIPT_ID}-btn-admin`);
    if (btnAdmin) btnAdmin.style.display = ehAdmin() ? 'flex' : 'none';
    if (!ehAdmin() && adm) fecharPainelAdmin();
    aplicarRegrasNovas();
  }

  // Chamada quando chegam regras novas (ou mudam as permissões).
  function aplicarRegrasNovas() {
    try { atualizarDestaques(); } catch (e) { LOG('atualizarDestaques falhou', e); }
    const segmentPanel = document.getElementById('segment-edit-general');
    if (segmentPanel) handleSegmentPanel(segmentPanel);
    renderizarSeparador();
  }

  // Revalida o acesso (cache de 1 h) e as regras (cache de 24 h) de vez em
  // quando numa sessão longa, e ao voltar ao separador do navegador.
  const VERIFICACAO_PERIODICA_MS = 10 * 60 * 1000;
  let verificacaoEmCurso = false;

  async function verificarEstado() {
    if (verificacaoEmCurso) return;
    verificacaoEmCurso = true;
    try {
      const antes = assinaturaAcesso();
      await refreshAllowlistState();
      const mudouDados = await carregarDados();
      if (antes !== assinaturaAcesso()) aplicarEstadoAcesso();
      else if (mudouDados) aplicarRegrasNovas();
    } catch (e) {
      LOG('verificação periódica falhou', e);
    } finally {
      verificacaoEmCurso = false;
    }
  }

  function iniciarVerificacaoPeriodica() {
    setInterval(verificarEstado, VERIFICACAO_PERIODICA_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) verificarEstado(); });
  }

  // Aviso no painel de edição quando não há regras nenhumas (sem cache e
  // sem ligação à base de dados).
  const SEM_DADOS_MARCADOR = `data-${SCRIPT_ID}-semdados`;

  function inserirAvisoSemDados(segmentPanel) {
    if (document.querySelector(`[${SEM_DADOS_MARCADOR}="true"]`)) return;
    const aviso = document.createElement('div');
    aviso.setAttribute(SEM_DADOS_MARCADOR, 'true');
    aviso.textContent = dadosEstado.erro === 'vazio'
      ? '⚠️ WazePT Abreviaturas: ainda não há regras publicadas na base de dados.'
      : '⚠️ WazePT Abreviaturas: não foi possível obter as regras (sem ligação à base de dados). As sugestões voltam assim que for possível obtê-las.';
    aviso.style.cssText = `
      font-size: 11px; font-family: sans-serif; color: #8a5a00;
      line-height: 1.35; word-break: break-word;
      margin: 0 0 6px 0; padding: 3px 6px;
      border-radius: 0 3px 3px 0; border-left: 3px solid #cc8400; background:#fff3e0;
    `;
    const anchor = findHouseNumbersAnchor(segmentPanel) || segmentPanel;
    anchor.parentNode.insertBefore(aviso, anchor);
  }


  // ------------------------------------------------------------------
  // ARRANQUE
  // ------------------------------------------------------------------
  const MAX_TENTATIVAS_SDK = 240; // ~60 s

  if (UW.SDK_INITIALIZED) {
    UW.SDK_INITIALIZED.then(init);
  } else {
    LOG('SDK_INITIALIZED ainda não existe, a aguardar...');
    let tentativas = 0;
    const espera = setInterval(() => {
      if (UW.SDK_INITIALIZED) {
        clearInterval(espera);
        UW.SDK_INITIALIZED.then(init);
        return;
      }
      if (++tentativas >= MAX_TENTATIVAS_SDK) {
        clearInterval(espera);
        LOGE('SDK_INITIALIZED não apareceu; o script não vai arrancar.');
      }
    }, 250);
  }
})();
