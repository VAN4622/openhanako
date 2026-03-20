export default async function conversationsRoute(app, { engine }) {
  app.get("/api/conversations/local", async (req, reply) => {
    const sessionPath = req.query?.sessionPath;
    if (!sessionPath) {
      reply.code(400);
      return { error: "sessionPath required" };
    }

    return {
      binding: engine.agent?.conversationManager?.getBindingInfoForLocalSession(sessionPath) || null,
    };
  });

  app.get("/api/conversations/bridge", async (req, reply) => {
    const sessionKey = req.query?.sessionKey;
    if (!sessionKey) {
      reply.code(400);
      return { error: "sessionKey required" };
    }

    const guest = req.query?.guest === true || req.query?.guest === "true";
    return {
      binding: engine.agent?.conversationManager?.getBindingInfoForBridgeSession(sessionKey, { guest }) || null,
    };
  });

  app.get("/api/conversations/:conversationId/timeline", async (req, reply) => {
    const conversationId = req.params?.conversationId;
    if (!conversationId) {
      reply.code(400);
      return { error: "conversationId required" };
    }

    const limit = Math.max(1, Math.min(200, Number.parseInt(req.query?.limit, 10) || 50));
    const events = engine.agent?.conversationManager?.readTimeline(conversationId) || [];
    return {
      conversationId,
      events: events.slice(-limit),
    };
  });

  app.get("/api/conversations/:conversationId/snapshot", async (req, reply) => {
    const conversationId = req.params?.conversationId;
    if (!conversationId) {
      reply.code(400);
      return { error: "conversationId required" };
    }

    return {
      conversationId,
      snapshot: engine.agent?.conversationManager?.readSnapshot(conversationId) || null,
    };
  });

  app.post("/api/conversations/link", async (req, reply) => {
    const { sessionPath, sessionKey, guest } = req.body || {};
    if (!sessionPath || !sessionKey) {
      reply.code(400);
      return { error: "sessionPath and sessionKey required" };
    }

    const cm = engine.agent?.conversationManager;
    if (!cm) {
      reply.code(500);
      return { error: "conversation manager unavailable" };
    }

    const localId = await cm.ensureLocalSession(sessionPath);
    const bridgeId = await cm.ensureBridgeSession(sessionKey, { guest: !!guest });
    const localInfo = cm.getBindingInfoForLocalSession(sessionPath);
    const bridgeInfo = cm.getBindingInfoForBridgeSession(sessionKey, { guest: !!guest });
    const conversationId = (bridgeInfo?.conversationLastSeq || 0) > (localInfo?.conversationLastSeq || 0)
      ? bridgeId
      : (localId || bridgeId);

    if (!conversationId) {
      reply.code(500);
      return { error: "failed to resolve conversation" };
    }

    await cm.linkLocalSession(sessionPath, conversationId);
    await cm.linkBridgeSession(sessionKey, conversationId, { guest: !!guest });

    return {
      ok: true,
      conversationId,
      local: cm.getBindingInfoForLocalSession(sessionPath),
      bridge: cm.getBindingInfoForBridgeSession(sessionKey, { guest: !!guest }),
    };
  });

  app.post("/api/conversations/local/reset", async (req, reply) => {
    const { sessionPath } = req.body || {};
    if (!sessionPath) {
      reply.code(400);
      return { error: "sessionPath required" };
    }

    const cm = engine.agent?.conversationManager;
    if (!cm) {
      reply.code(500);
      return { error: "conversation manager unavailable" };
    }

    const previous = cm.getBindingInfoForLocalSession(sessionPath);
    const conversationId = await cm.resetLocalSessionConversation(sessionPath, {
      resetBy: "api",
      resetScope: "local_session",
    });

    return {
      ok: true,
      conversationId,
      previous,
      local: cm.getBindingInfoForLocalSession(sessionPath),
    };
  });

  app.post("/api/conversations/bridge/reset", async (req, reply) => {
    const { sessionKey, guest } = req.body || {};
    if (!sessionKey) {
      reply.code(400);
      return { error: "sessionKey required" };
    }

    const cm = engine.agent?.conversationManager;
    if (!cm) {
      reply.code(500);
      return { error: "conversation manager unavailable" };
    }

    const previous = cm.getBindingInfoForBridgeSession(sessionKey, { guest: !!guest });
    const conversationId = await cm.resetBridgeSessionConversation(sessionKey, {
      guest: !!guest,
      meta: {
        resetBy: "api",
        resetScope: guest ? "bridge_guest_session" : "bridge_owner_session",
      },
    });

    return {
      ok: true,
      conversationId,
      previous,
      bridge: cm.getBindingInfoForBridgeSession(sessionKey, { guest: !!guest }),
    };
  });
}
