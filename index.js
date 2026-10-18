(function () {
  "use strict";
  // Mention Navigator 1.2 — Revenge clasico / Vendetta. Boton @ flotante en chat.
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
  var patchCleanups = [];
  var patchTargets = [];
  var renderCount = 0;
  var overlayError = "";
  var previewEnabled = false;
  var lastPatchedAt = 0;
  var channelListener = null;
  var uiSubscribers = [];
  var pendingIds = []; // Menciones directas no visitadas, almacenadas localmente.
  var MAX_PENDING = 150;
  var lastChannelFromEvent = "";

  function debug(message, error) {
    try { console.log("[MentionNavigator] " + message, error || ""); } catch (_) {}
  }
  function toast(message) {
    try { api.ui.toasts.showToast(message); } catch (_) {}
  }
  function redraw() {
    try { if (refresh) refresh(); } catch (_) {}
    uiSubscribers.slice().forEach(function (fn) { try { fn(); } catch (_) {} });
  }
  function subscribeToUI(fn) {
    uiSubscribers.push(fn);
    return function () { uiSubscribers = uiSubscribers.filter(function (cb) { return cb !== fn; }); };
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
  function getActiveChannelId() {
    // Solo un canal seleccionado, NUNCA el del último MESSAGE_CREATE recibido.
    try {
      if (!selectedChannelStore && api.metro.findByStoreName)
        selectedChannelStore = api.metro.findByStoreName("SelectedChannelStore") || null;
      if (!selectedChannelStore) selectedChannelStore = findStore(["getChannelId", "getVoiceChannelId"]);
      if (selectedChannelStore) {
        var c = "";
        if (typeof selectedChannelStore.getChannelId === "function") c = getId(selectedChannelStore.getChannelId());
        if (c && /^\d+$/.test(c)) return c;
        if (typeof selectedChannelStore.getLastSelectedChannelId === "function") {
          c = getId(selectedChannelStore.getLastSelectedChannelId());
          if (c && /^\d+$/.test(c)) return c;
        }
      }
      var lastSelected = findStore(["getLastSelectedChannelId"]);
      if (lastSelected && typeof lastSelected.getLastSelectedChannelId === "function") {
        var id = getId(lastSelected.getLastSelectedChannelId());
        if (/^\d+$/.test(id)) return id;
      }
    } catch (e) { debug("No se pudo leer el canal actual", e); }
    return lastChannelFromEvent;
  }
  function getChannelIdFromProps(props) {
    try {
      if (!props) return "";
      var val = props.channelId || props.channel_id || (props.channel && props.channel.id);
      if (val && /^\d+$/.test(getId(val))) return getId(val);
    } catch (_) {}
    return "";
  }
  function getPendingForChannel(channelId) {
    if (!channelId) return [];
    return pendingIds.filter(function (id) {
      return records.some(function (entry) {
        return entry.id === id && entry.channelId === channelId && entry.type === "directa";
      });
    });
  }
  function markPending(id) {
    id = getId(id);
    if (pendingIds.indexOf(id) === -1) {
      pendingIds.push(id);
      pendingIds = pendingIds.slice(-MAX_PENDING);
      savePending();
    }
  }
  function savePending() {
    try { storage.pendingMentions = pendingIds.slice(-MAX_PENDING); } catch (e) { debug("No se pudo guardar pendientes", e); }
  }
  function acknowledgeMention(id) {
    var index = pendingIds.indexOf(getId(id));
    if (index >= 0) {
      pendingIds.splice(index, 1);
      savePending();
      redraw();
    }
  }
  function jumpToPending(channelId) {
    var ids = getPendingForChannel(channelId);
    if (!ids.length) return;
    // Primero la mención pendiente más antigua, así ninguna queda perdida.
    var entry = records.find(function (r) { return r.id === ids[0] && r.channelId === channelId; });
    if (!entry) return;
    if (openMessage(entry)) acknowledgeMention(entry.id);
  }
  function MentionFloatingButton(props) {
    var state = React.useState(0);
    var bump = state[1];
    React.useEffect(function () {
      if (!running) return;
      return subscribeToUI(function () { bump(function (n) { return n + 1; }); });
    }, []);
    if (!running) return null;
    // Si Discord muestra otro chat, el botón no debe revelar menciones de un chat ajeno.
    var channelId = getChannelIdFromProps(props) || getActiveChannelId();
    var mentions = getPendingForChannel(channelId);
    if (!mentions.length && !previewEnabled) return null;
    var count = mentions.length;
    return React.createElement(RN.View, {
      pointerEvents: "box-none",
      style: { position: "absolute", right: 15, bottom: 100, zIndex: 70, elevation: 15 }
    }, React.createElement(RN.TouchableOpacity, {
      onPress: function () {
        if (mentions.length) jumpToPending(channelId);
        else toast("El botón @ se dibuja correctamente. Espera una mención directa nueva.");
      },
      activeOpacity: 0.76,
      accessibilityRole: "button",
      accessibilityLabel: "Ir a la siguiente mención directa de este canal",
      style: {
        height: 42, minWidth: 42, borderRadius: 21, paddingHorizontal: 8,
        backgroundColor: previewEnabled && !count ? "#5E6778" : "#5865F2", borderColor: "#B5BDFD", borderWidth: 1,
        justifyContent: "center", alignItems: "center", flexDirection: "row",
        shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 5,
        shadowOffset: { width: 0, height: 2 }, elevation: 8
      }
    },
      React.createElement(RN.Text, {
        style: { color: "#FFFFFF", fontSize: 25, fontWeight: "800", lineHeight: 31, textAlign: "center" }
      }, "@"),
      count > 1 ? React.createElement(RN.Text, {
        style: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", marginLeft: 2 }
      }, String(count > 99 ? "99+" : count)) : null
    ));
  }
  function wrapChat(original, fallbackProps) {
    if (!original || !React.isValidElement || !React.isValidElement(original)) return original;
    // No envolver dos veces el mismo chat aunque lo encuentre mas de una estrategia.
    if (original.props && original.props.__mentionNavigatorChatRoot) return original;
    try {
      renderCount++;
      lastPatchedAt = Date.now();
      var channelId = getChannelIdFromProps(fallbackProps) || getActiveChannelId();
      if (!channelId || !/^\d+$/.test(channelId)) return original;
      return React.createElement(RN.View, {
        __mentionNavigatorChatRoot: true,
        collapsable: false,
        style: { flex: 1, position: "relative" }
      }, original, React.createElement(MentionFloatingButton, {
        key: "mention-navigator-at-button",
        channelId: channelId
      }));
    } catch (e) {
      overlayError = String(e && e.message || e);
      debug("Error al dibujar el boton @", e);
      return original;
    }
  }
  function registerPatch(cleanup, targetName) {
    if (typeof cleanup !== "function") return false;
    patchCleanups.push(cleanup);
    patchTargets.push(targetName);
    debug("Boton @ conectado a " + targetName);
    return true;
  }
  function tryPatch(target, key, name) {
    if (!target || typeof target[key] !== "function") return false;
    try {
      return registerPatch(api.patcher.after(key, target, function (args, result, self) {
        return wrapChat(result, args && args[0] || self && self.props);
      }), name);
    } catch (e) { debug("No se pudo interceptar " + name, e); return false; }
  }
  function installChatButton() {
    if (!api.patcher || typeof api.patcher.after !== "function") {
      overlayError = "Revenge no expone la API patcher.after";
      return false;
    }
    var metro = api.metro;
    var successes = 0;
    var seenTargets = [];
    function patchOne(obj, key, name) {
      if (!obj || seenTargets.some(function (o) { return o.obj === obj && o.key === key; })) return false;
      seenTargets.push({ obj: obj, key: key });
      if (tryPatch(obj, key, name)) { successes++; return true; }
      return false;
    }
    function patchComponent(comp, name) {
      if (!comp) return;
      var val = comp.default || comp;
      if (val.prototype && typeof val.prototype.render === "function") {
        patchOne(val.prototype, "render", name + ".render"); return;
      }
      if (val.type && val.type.prototype && typeof val.type.prototype.render === "function") {
        patchOne(val.type.prototype, "render", name + ".type.render"); return;
      }
      if (typeof val.render === "function") { patchOne(val, "render", name + ".render"); return; }
      if (val.type && typeof val.type.render === "function") {
        patchOne(val.type, "render", name + ".type.render");
      }
    }
    // El componente antiguo que usa la funcion de fondo de chat de Vendetta.
    try {
      var mod = metro.findByProps && metro.findByProps("MessagesWrapper");
      if (mod && mod.MessagesWrapper) patchComponent(mod.MessagesWrapper, "MessagesWrapper");
    } catch (e) { debug("MessagesWrapper no disponible", e); }
    try {
      var connected = metro.findByName && metro.findByName("MessagesWrapperConnected", false);
      if (connected && typeof connected.default === "function") {
        patchOne(connected, "default", "MessagesWrapperConnected.default");
      }
    } catch (e) { debug("MessagesWrapperConnected no disponible", e); }
    // En Discord moderno el nombre de la funcion a menudo esta en .type.name
    // y NO en el export default de Metro. Buscar ambas representaciones.
    var candidates = ["MessagesWrapper", "MessagesWrapperConnected", "ChatView", "ChannelChatView", "ChannelChat"];
    ["findByTypeNameAll", "findByDisplayNameAll", "findByNameAll"].forEach(function (finder) {
      if (typeof metro[finder] !== "function") return;
      candidates.forEach(function (name) {
        try {
          [true, false].forEach(function (exportIsDefault) {
            var results = metro[finder](name, exportIsDefault);
            if (!results) return;
            if (!Array.isArray(results)) results = [results];
            results.slice(0, 10).forEach(function (item) {
              patchComponent(exportIsDefault ? item : item.default || item, name + " (" + finder + ")");
              if (!exportIsDefault && item && typeof item.default === "function") {
                patchOne(item, "default", name + ".default (" + finder + ")");
              }
            });
          });
        } catch (_) {}
      });
    });
    // Ultimo recurso: JSX usa con frecuencia React.createElement para crear
    // la raiz del chat aunque Metro ya haya importado las funciones del modulo.
    // Solo se interceptan elementos con nombres conocidos; no todos los Views.
    if (!successes && typeof React.createElement === "function") {
      try {
        var names = { MessagesWrapperConnected: true, MessagesWrapper: true,
          ChatView: true, ChannelChatView: true, ChannelChat: true };
        var unpatch = api.patcher.after("createElement", React, function (args, result) {
          try {
            var type = args && args[0];
            var name = type && (type.displayName || type.name || type.type && (type.type.displayName || type.type.name)
              || type.render && (type.render.displayName || type.render.name));
            if (!name || !names[name]) return result;
            return wrapChat(result, args[1]);
          } catch (_) { return result; }
        });
        if (registerPatch(unpatch, "React.createElement (respaldo)")) successes++;
      } catch (e) { debug("Respaldo de React.createElement no disponible", e); }
    }
    if (!successes) overlayError = "No se encontro un componente de chat compatible";
    return successes > 0;
  }
  function removeChatButton() {
    patchCleanups.splice(0).reverse().forEach(function (fn) { try { fn(); } catch (_) {} });
    patchTargets = [];
    renderCount = 0;
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
    // Los registros eliminados al llegar a 150 ya no deben mostrarse pendientes.
    var ids = {};
    records.forEach(function (r) { ids[r.id] = true; });
    var remaining = pendingIds.filter(function (id) { return ids[id]; });
    if (remaining.length !== pendingIds.length) {
      pendingIds = remaining;
      savePending();
    }
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
      // Solo @menciones directas activan el flotante; no roles ni @everyone.
      // Una edición no reactivará una mención ya visitada.
      if (entry.type === "directa" && existing === -1) markPending(entry.id);
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
  function eraseHistory() {
    records = [];
    pendingIds = [];
    savePending();
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
      Text("Historial de menciones | Botón @ en el chat (v1.2)", { color: "#a9acb9", marginTop: 3, marginBottom: 14 }),
      React.createElement(RN.View, { style: { backgroundColor: "#222630", borderRadius: 12, padding: 12, marginBottom: 12 } },
        Text(status, { color: running && listener ? "#80e9b2" : "#ffcb80", fontWeight: "700" }),
        Text(records.length + " menciones guardadas de " + LIMIT + " posibles", { marginTop: 4, color: "#c9cbda" }),
        Text("Conexiones UI: " + (patchTargets.length ? patchTargets.join(", ") : "ninguna"), { marginTop: 6, color: "#b2b5c1", fontSize: 11 }),
      Text("Render del chat detectado: " + renderCount + " | Canal: " + (getActiveChannelId() || "desconocido"), { marginTop: 4, color: "#b2b5c1", fontSize: 11 }),
      Text("Menciones directas pendientes aqui: " + getPendingForChannel(getActiveChannelId()).length, { marginTop: 4, color: "#b2b5c1", fontSize: 11 }),
      overlayError ? Text("Diagnostico: " + overlayError, { marginTop: 4, color: "#f7b1b1", fontSize: 11 }) : null,
      Text("El boton @ aparece sobre la flecha de bajar cuando hay una mencion directa nueva.", { marginTop: 8, color: "#b2b5c1", fontSize: 12 })
      ),
      Button(previewEnabled ? "DESACTIVAR PRUEBA DE @" : "PROBAR BOTON @ EN EL CHAT", function () {
        previewEnabled = !previewEnabled;
        try { storage.testChatButton = previewEnabled; } catch (_) {}
        redraw();
        toast(previewEnabled ? "Regresa a un chat. El @ de prueba debe aparecer." : "Prueba @ desactivada");
      }, false, "secondary"),
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
      previewEnabled = !!storage.testChatButton;
      pendingIds = Array.isArray(storage.pendingMentions) ? storage.pendingMentions.filter(function (id) {
        return /^\d+$/.test(getId(id)) && records.some(function (r) { return r.id === getId(id) && r.type === "directa"; });
      }).map(getId).slice(-MAX_PENDING) : [];
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
        channelListener = function (event) {
          try {
            var id = getId(event && (event.channelId || event.channel_id));
            if (/^\d+$/.test(id)) lastChannelFromEvent = id;
            redraw();
          } catch (_) {}
        };
        try { dispatcher.subscribe("CHANNEL_SELECT", channelListener); } catch (_) {}
        status = "Escuchando menciones nuevas";
        var patched = installChatButton();
        status += patched ? " | Botón @ habilitado" : " | Botón @ incompatible en esta versión";
      } catch (e) {
        status = "Error iniciando detector de menciones";
        debug(status, e);
        try { if (dispatcher && listener) dispatcher.unsubscribe("MESSAGE_CREATE", listener); } catch (_) {}
        try { if (dispatcher && updateListener) dispatcher.unsubscribe("MESSAGE_UPDATE", updateListener); } catch (_) {}
        try { if (dispatcher && channelListener) dispatcher.unsubscribe("CHANNEL_SELECT", channelListener); } catch (_) {}
        removeChatButton();
        listener = null;
        updateListener = null;
      }
      redraw();
    },
    onUnload: function () {
      running = false;
      try { if (dispatcher && listener) dispatcher.unsubscribe("MESSAGE_CREATE", listener); } catch (_) {}
      try { if (dispatcher && updateListener) dispatcher.unsubscribe("MESSAGE_UPDATE", updateListener); } catch (_) {}
      try { if (dispatcher && channelListener) dispatcher.unsubscribe("CHANNEL_SELECT", channelListener); } catch (_) {}
      removeChatButton();
      uiSubscribers = [];
      channelListener = null;
      lastChannelFromEvent = "";
      selectedChannelStore = null;
      dispatcher = null;
      listener = null;
      updateListener = null;
      refresh = null;
    },
    settings: SettingsScreen
  };
})()
