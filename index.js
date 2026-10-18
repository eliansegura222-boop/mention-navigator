(function () {
  "use strict";
  // Mention Navigator 1.3 — Revenge clasico / Vendetta. Comando local /direct.
  // Archivo ya empaquetado en el formato de expresion que carga Vendetta.
  var api = vendetta;
  var React = api.metro.common.React;
  var RN = api.metro.common.ReactNative;
  var findByProps = api.metro.findByProps;
  var storage = api.plugin.storage;
  var dispatcher = null;
  var listener = null;
  var updateListener = null;
  var refresh = null;
  var running = false;
  var status = "No iniciado";
  var LIMIT = 150;
  var records = [];
  var currentId = null;
  var currentUserStore = null;
  var channelStore = null;
  var guildMemberStore = null;
  var selectedChannelStore = null;
  var removeDirectCommand = null;
  var commandStatus = "No registrado";
  var lastJumpByChannel = Object.create(null);

  function debug(message, error) {
    try { console.log("[MentionNavigator] " + message, error || ""); } catch (_) {}
  }
  function toast(message) {
    try { api.ui.toasts.showToast(message); } catch (_) {}
  }
  function redraw() {
    try { if (refresh) refresh(); } catch (_) {}
  }
  function getId(value) {
    if (value === undefined || value === null) return "";
    return String(value);
  }
  function saneText(v, n) {
    if (typeof v !== "string") return "";
    return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").slice(0, n);
  }
  function guessAuthor(author) {
    if (!author) return "Usuario";
    return saneText(author.global_name || author.globalName || author.username || author.name || "Usuario", 80) || "Usuario";
  }
  function findStore(names) {
    try { return findByProps.apply(null, names) || null; } catch (_) { return null; }
  }
  function getMyId() {
    try {
      if (!currentUserStore) currentUserStore = findStore(["getCurrentUser"]);
      var me = currentUserStore && currentUserStore.getCurrentUser();
      return me && getId(me.id);
    } catch (_) { return ""; }
  }
  function getChannel(id) {
    try {
      if (!channelStore) channelStore = findStore(["getChannel"]);
      return channelStore && channelStore.getChannel(id);
    } catch (_) { return null; }
  }
  function getRolesForMe(guildId, myId) {
    if (!guildId || !myId) return [];
    try {
      if (!guildMemberStore) guildMemberStore = findStore(["getMember"]);
      var member = guildMemberStore && guildMemberStore.getMember(guildId, myId);
      return member && Array.isArray(member.roles) ? member.roles.map(getId) : [];
    } catch (_) { return []; }
  }
  function hasUser(mentions, id) {
    if (!Array.isArray(mentions)) return false;
    return mentions.some(function (m) { return getId(m && (m.id || m.user_id || m.userId || m)) === id; });
  }
  function mentionType(message, event, myId, guildId) {
    if (!myId) return "";
    var content = typeof message.content === "string" ? message.content : "";
    var mentionUsers = message.mentions || message.mentionUsers || [];
    if (hasUser(mentionUsers, myId) || content.indexOf("<@" + myId + ">") !== -1 || content.indexOf("<@!" + myId + ">") !== -1) {
      return "directa";
    }
    var roles = message.mention_roles || message.mentionRoles || [];
    var myRoles = getRolesForMe(guildId, myId);
    if (Array.isArray(roles) && myRoles.some(function (role) {
      return roles.some(function (mentioned) { return getId(mentioned && (mentioned.id || mentioned)) === role; });
    })) return "rol";
    if (message.mention_everyone === true || message.mentionEveryone === true) return "general";
    // Los mensajes privados normales NO se consideran menciones automáticas.
    return "";
  }
  function getRecord(event) {
    var msg = event && (event.message || event);
    if (!msg || typeof msg !== "object") return null;
    var id = getId(msg.id || event.messageId || event.message_id);
    var channelId = getId(msg.channel_id || msg.channelId || event.channelId || event.channel_id);
    var myId = getMyId();
    var author = msg.author || event.author || {};
    var authorId = getId(author.id || msg.author_id || msg.authorId);
    if (!id || !channelId || !myId || !authorId || authorId === myId) return null;
    var channel = getChannel(channelId);
    var guildId = getId(msg.guild_id || msg.guildId || event.guildId || event.guild_id || (channel && (channel.guild_id || channel.guildId)));
    var type = mentionType(msg, event, myId, guildId);
    if (!type) return null;
    return {
      id: id,
      channelId: channelId,
      guildId: guildId,
      authorId: authorId,
      author: guessAuthor(author),
      content: saneText(msg.content || "(mensaje sin texto o con adjuntos)", 400),
      type: type,
      received: Date.now(),
      channelName: saneText(channel && channel.name || (guildId ? "Canal" : "Mensaje privado"), 80)
    };
  }
  function save() {
    try { storage.items = records.slice(0, LIMIT); } catch (e) { debug("No se pudo guardar el historial", e); }
  }
  function handleMessage(event) {
    if (!running) return;
    try {
      var entry = getRecord(event);
      if (!entry) return;
      var existing = records.findIndex(function (r) { return r.id === entry.id; });
      if (existing !== -1) {
        // Un MESSAGE_UPDATE puede cambiar texto, pero no cuenta como nueva mencion.
        entry.received = records[existing].received;
        records.splice(existing, 1);
      }
      records.unshift(entry);
      if (records.length > LIMIT) records.length = LIMIT;
      save();
      redraw();
    } catch (e) { debug("No se pudo procesar la mencion", e); }
  }
  function safeRecords(raw) {
    if (!Array.isArray(raw)) return [];
    var seen = {};
    return raw.filter(function (v) {
      if (!v || typeof v !== "object" || !/^\d+$/.test(getId(v.id)) || !/^\d+$/.test(getId(v.channelId))) return false;
      if (seen[v.id]) return false;
      seen[v.id] = true;
      return true;
    }).slice(0, LIMIT).map(function (v) {
      return {
        id: getId(v.id), channelId: getId(v.channelId), guildId: getId(v.guildId),
        authorId: getId(v.authorId), author: saneText(v.author || "Usuario", 80),
        content: saneText(v.content || "", 400),
        type: ["directa", "rol", "general"].indexOf(v.type) >= 0 ? v.type : "directa",
        received: Number(v.received) || Date.now(), channelName: saneText(v.channelName || "Canal", 80)
      };
    });
  }
  function messageLink(entry) {
    // Discord usa @me para los DMs y el ID de servidor para los canales de servidores.
    return "https://discord.com/channels/" + (entry.guildId || "@me") + "/" + entry.channelId + "/" + entry.id;
  }
  function copyLink(entry) {
    var link = messageLink(entry);
    try {
      var clipboard = api.metro.common.clipboard || findStore(["setString", "getString"]);
      if (clipboard && typeof clipboard.setString === "function") {
        clipboard.setString(link); toast("Enlace copiado"); return true;
      }
    } catch (e) { debug("No se pudo copiar", e); }
    toast("El portapapeles no esta disponible");
    return false;
  }
  function openMessage(entry) {
    if (!entry) return false;
    var link = messageLink(entry);
    try {
      var opener = findStore(["openUrl"]);
      if (opener && typeof opener.openUrl === "function") {
        var result = opener.openUrl(link);
        if (result && typeof result.catch === "function") {
          result.catch(function (e) { debug("Fallo el enlace interno", e); toast("No se pudo abrir. Usa Copiar enlace."); });
        }
        return true;
      }
      var urls = api.metro.common.url;
      if (urls && typeof urls.openURL === "function") {
        var p = urls.openURL(link);
        if (p && typeof p.catch === "function") p.catch(function () { toast("No se pudo abrir. Usa Copiar enlace."); });
        return true;
      }
      if (RN.Linking && typeof RN.Linking.openURL === "function") {
        var opened = RN.Linking.openURL(link);
        if (opened && typeof opened.catch === "function") opened.catch(function () { toast("No se pudo abrir. Usa Copiar enlace."); });
        return true;
      }
    } catch (e) { debug("No se pudo abrir la mencion", e); }
    copyLink(entry);
    toast("No hay navegador interno; enlace copiado si es posible.");
    return false;
  }

  function activeChannelId() {
    // Sólo se utiliza si la interfaz no suministra un canal en el contexto.
    try {
      if (!selectedChannelStore && typeof api.metro.findByStoreName === "function") {
        selectedChannelStore = api.metro.findByStoreName("SelectedChannelStore");
      }
      if (!selectedChannelStore) selectedChannelStore = findStore(["getChannelId", "getVoiceChannelId"]);
      var id = selectedChannelStore && typeof selectedChannelStore.getChannelId === "function"
        ? getId(selectedChannelStore.getChannelId()) : "";
      return /^\d+$/.test(id) ? id : "";
    } catch (_) { return ""; }
  }
  function directInChannel(channelId) {
    if (!/^\d+$/.test(channelId)) {
      toast("No se pudo identificar el canal actual.");
      return;
    }
    // Las menciones de roles y @everyone nunca entran en /direct.
    var matches = records.filter(function (record) {
      return record.channelId === channelId && record.type === "directa";
    });
    if (!matches.length) {
      toast("No hay menciones directas guardadas en este chat.");
      return;
    }
    // Primera ejecución: última mención. Repeticiones: anteriores, en bucle.
    var previous = getId(lastJumpByChannel[channelId]);
    var oldIndex = matches.findIndex(function (record) { return record.id === previous; });
    var index = oldIndex === -1 ? 0 : (oldIndex + 1) % matches.length;
    var entry = matches[index];
    if (openMessage(entry)) {
      lastJumpByChannel[channelId] = entry.id;
    }
  }
  function registerDirectCommand() {
    if (!api.commands || typeof api.commands.registerCommand !== "function") {
      commandStatus = "Tu versión de Revenge no expone comandos locales";
      debug(commandStatus);
      return;
    }
    try {
      // BUILT_IN = 0: ejecución sólo en el dispositivo.
      // Nunca devolver { content } ni llamar a sendMessage.
      removeDirectCommand = api.commands.registerCommand({
        name: "direct",
        displayName: "direct",
        description: "Ir a una mención directa guardada en este chat (local)",
        displayDescription: "Ir a una mención directa guardada en este chat (local)",
        applicationId: "-1",
        type: 1,
        inputType: 0,
        options: [],
        execute: function (_args, context) {
          try {
            if (!running) return;
            var fromContext = getId(context && context.channel && context.channel.id);
            var channelId = /^\d+$/.test(fromContext) ? fromContext : activeChannelId();
            directInChannel(channelId);
          } catch (error) {
            debug("Fallo /direct", error);
            toast("No se pudo ejecutar /direct.");
          }
          // Sin texto de salida: nada se publica en el canal.
          return;
        }
      });
      commandStatus = "Comando /direct disponible (local)";
    } catch (error) {
      removeDirectCommand = null;
      commandStatus = "No se pudo registrar /direct en esta versión";
      debug(commandStatus, error);
    }
  }

  function eraseHistory() {
    records = [];
    lastJumpByChannel = Object.create(null);
    currentId = null;
    save();
    redraw();
    toast("Historial eliminado");
  }
  function formatDate(time) {
    try { return new Date(time).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch (_) { return ""; }
  }
  function SettingsScreen() {
    var local = React.useState(0);
    var force = local[1];
    var queryState = React.useState("");
    var query = queryState[0];
    var setQuery = queryState[1];
    var filterState = React.useState("todas");
    var filter = filterState[0];
    var setFilter = filterState[1];
    var selectedState = React.useState(null);
    var selectedId = selectedState[0];
    var selectId = selectedState[1];
    React.useEffect(function () {
      refresh = function () { force(function (v) { return v + 1; }); };
      return function () { refresh = null; };
    }, []);
    var q = query.toLowerCase().trim();
    var visible = records.filter(function (r) {
      var typeMatches = filter === "todas" || r.type === filter;
      var needle = (r.author + " " + r.content + " " + r.channelName).toLowerCase();
      return typeMatches && (!q || needle.indexOf(q) !== -1);
    });
    var selectedIndex = visible.findIndex(function (r) { return r.id === selectedId; });
    if (selectedIndex < 0) selectedIndex = 0;
    var selected = visible.length ? visible[selectedIndex] : null;

    function Text(value, style) {
      return React.createElement(RN.Text, { style: Object.assign({ color: "#f5f6fa", fontSize: 14, lineHeight: 21 }, style || {}) }, value);
    }
    function Button(label, onPress, disabled, variant) {
      return React.createElement(RN.TouchableOpacity, {
        key: label, onPress: onPress, disabled: !!disabled, activeOpacity: 0.75,
        style: {
          backgroundColor: disabled ? "#343640" : (variant === "danger" ? "#8b2a3c" : variant === "secondary" ? "#333648" : "#5865f2"),
          borderRadius: 11, paddingVertical: 12, paddingHorizontal: 10,
          marginTop: 8, alignItems: "center", justifyContent: "center", flexGrow: 1,
        }
      }, Text(label, { color: disabled ? "#868998" : "#ffffff", fontWeight: "700", textAlign: "center", fontSize: 13 }));
    }
    function row(elements, key) {
      return React.createElement(RN.View, { key: key, style: { flexDirection: "row", gap: 8, marginTop: 4 } }, elements);
    }
    var filters = [
      ["todas", "Todas"], ["directa", "Directas"], ["rol", "Roles"], ["general", "Generales"]
    ];
    var filterButtons = filters.map(function (item) {
      return React.createElement(RN.TouchableOpacity, {
        key: item[0], onPress: function () { setFilter(item[0]); selectId(null); },
        style: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, marginRight: 7,
          backgroundColor: filter === item[0] ? "#5865f2" : "#303240" }
      }, Text(item[1], { fontWeight: "600" }));
    });
    var cards = visible.map(function (item, index) {
      var chosen = !!selected && selected.id === item.id;
      return React.createElement(RN.TouchableOpacity, {
        key: item.id,
        onPress: function () { selectId(item.id); },
        activeOpacity: 0.75,
        style: { backgroundColor: chosen ? "#2e3653" : "#24262f", borderColor: chosen ? "#7785ff" : "#343743",
          borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 9 }
      },
        row([
          React.createElement(RN.View, { key: "a", style: { flex: 1 } }, Text(item.author, { fontWeight: "700", fontSize: 15 })),
          React.createElement(RN.View, { key: "b" }, Text(formatDate(item.received), { color: "#a2a6b7", fontSize: 11 }))
        ], "header"),
        Text(item.content, { marginTop: 7, color: "#e2e4ec" }),
        Text((item.guildId ? "#" : "DM · ") + item.channelName + "  ·  " + item.type, {
          marginTop: 6, color: "#acb4ff", fontSize: 12
        }),
        chosen ? row([
          Button("IR AL MENSAJE", function () { openMessage(item); }, false),
          Button("COPIAR LINK", function () { copyLink(item); }, false, "secondary")
        ], "actions") : null
      );
    });
    return React.createElement(RN.ScrollView, {
      style: { flex: 1, backgroundColor: "#15161b" },
      contentContainerStyle: { padding: 16, paddingBottom: 55 }
    },
      Text("MENTION NAVIGATOR", { fontSize: 22, fontWeight: "800", marginTop: 5 }),
      Text("Historial de menciones | Comando local /direct (v1.3)", { color: "#a9acb9", marginTop: 3, marginBottom: 14 }),
      React.createElement(RN.View, { style: { backgroundColor: "#222630", borderRadius: 12, padding: 12, marginBottom: 12 } },
        Text(status, { color: running && listener ? "#80e9b2" : "#ffcb80", fontWeight: "700" }),
        Text(records.length + " menciones guardadas de " + LIMIT + " posibles", { marginTop: 4, color: "#c9cbda" }),
        Text(commandStatus, { marginTop: 4, color: removeDirectCommand ? "#80e9b2" : "#ffcb80", fontSize: 12 }),
        Text("Escribe /direct en un chat y selecciona el comando sugerido. Abre la mención directa más reciente de ese canal; repítelo para las anteriores. No envía mensajes.", { marginTop: 8, color: "#b2b5c1", fontSize: 12 }),
        Text("Solo registra menciones nuevas mientras Discord recibe eventos con el plugin activo.", { marginTop: 8, color: "#b2b5c1", fontSize: 12 })
      ),
      React.createElement(RN.TextInput, {
        value: query, onChangeText: setQuery, placeholder: "Buscar usuario, texto o canal...",
        placeholderTextColor: "#999caa", autoCapitalize: "none", autoCorrect: false,
        style: { backgroundColor: "#292c36", color: "#ffffff", borderRadius: 12,
          paddingHorizontal: 13, paddingVertical: 11, fontSize: 14, marginBottom: 10 }
      }),
      React.createElement(RN.ScrollView, { horizontal: true, showsHorizontalScrollIndicator: false,
        contentContainerStyle: { paddingVertical: 5 } }, filterButtons),
      Text("RESULTADOS: " + visible.length, { color: "#b2b5c1", fontWeight: "700", marginTop: 14 }),
      selected ? row([
        Button("← ANTERIOR", function () { selectId(visible[Math.max(0, selectedIndex - 1)].id); }, selectedIndex <= 0, "secondary"),
        Button("SIGUIENTE →", function () { selectId(visible[Math.min(visible.length - 1, selectedIndex + 1)].id); }, selectedIndex >= visible.length - 1, "secondary")
      ], "pager") : null,
      cards.length ? cards : Text("Todavía no hay menciones para mostrar. Pide a alguien que te mencione en un canal y vuelve aquí.", { color: "#bfc1d0", marginTop: 16 }),
      Button("ELIMINAR TODO EL HISTORIAL", eraseHistory, records.length === 0, "danger"),
      Text("Los datos se guardan localmente en Revenge. Las menciones de roles requieren que Discord tenga cargados tus roles. Los enlaces pueden abrirse en Discord o en un navegador, según tu versión.", {
        marginTop: 15, color: "#858897", fontSize: 12
      })
    );
  }
  return {
    onLoad: function () {
      running = true;
      currentId = getMyId();
      records = safeRecords(storage.items);
      lastJumpByChannel = Object.create(null);
      // Los datos sobrantes de la antigua interfaz flotante ya no se usan.
      try { delete storage.pendingMentions; delete storage.testChatButton; } catch (_) {}
      registerDirectCommand();
      try {
        dispatcher = api.metro.common.FluxDispatcher || findStore(["subscribe", "unsubscribe", "dispatch"]);
        if (!dispatcher || typeof dispatcher.subscribe !== "function" || typeof dispatcher.unsubscribe !== "function") {
          status = "No se encontró el despachador de eventos en esta versión de Discord.";
          debug(status); redraw(); return;
        }
        listener = function (event) { handleMessage(event); };
        updateListener = function (event) { handleMessage(event); };
        dispatcher.subscribe("MESSAGE_CREATE", listener);
        dispatcher.subscribe("MESSAGE_UPDATE", updateListener);
        status = "Escuchando menciones nuevas";
      } catch (e) {
        status = "Error iniciando detector de menciones";
        debug(status, e);
        try { if (dispatcher && listener) dispatcher.unsubscribe("MESSAGE_CREATE", listener); } catch (_) {}
        try { if (dispatcher && updateListener) dispatcher.unsubscribe("MESSAGE_UPDATE", updateListener); } catch (_) {}
        listener = null;
        updateListener = null;
      }
      redraw();
    },
    onUnload: function () {
      running = false;
      if (typeof removeDirectCommand === "function") {
        try { removeDirectCommand(); } catch (e) { debug("Error quitando /direct", e); }
      }
      removeDirectCommand = null;
      lastJumpByChannel = Object.create(null);
      selectedChannelStore = null;
      try { if (dispatcher && listener) dispatcher.unsubscribe("MESSAGE_CREATE", listener); } catch (_) {}
      try { if (dispatcher && updateListener) dispatcher.unsubscribe("MESSAGE_UPDATE", updateListener); } catch (_) {}
      dispatcher = null;
      listener = null;
      updateListener = null;
      refresh = null;
    },
    settings: SettingsScreen
  };
})()
