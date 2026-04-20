const { setGlobalOptions } = require("firebase-functions/v2/options");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const HERE_API_KEY = defineSecret("HERE_API_KEY");

const PROCESSED_EVENT_TTL_MS = 10 * 60 * 1000;
const processedEvents = new Map();

function markProcessed(id) {
  const now = Date.now();
  for (const [key, ts] of processedEvents) {
    if (now - ts > PROCESSED_EVENT_TTL_MS) processedEvents.delete(key);
  }
  processedEvents.set(id, now);
}

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

//send Expo notifications
async function sendExpoPush(tokens, title, body, extraData = {}) {
  const messages = tokens.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data: extraData,
  }));

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("Expo push failed:", response.status, text);
    }
  } catch (err) {
    console.error("Expo push error:", err);
  }
}

exports.notifyOnEmergency = onDocumentUpdated("groups/{groupId}", async (event) => {
  if (processedEvents.has(event.id)) {
    return;
  }
  markProcessed(event.id);

  const before = event.data.before.data();
  const after = event.data.after.data();

  if (!before || !after) return;

  const beforeMembers = before.memberLocations || {};
  const afterMembers = after.memberLocations || {};


  for (const [uid, member] of Object.entries(afterMembers)) {
    const wasEmergency = beforeMembers[uid]?.emergency || false;
    const isEmergency = member?.emergency || false;

    if (wasEmergency === isEmergency) continue;

    if (!wasEmergency && isEmergency) {
      console.log(`Emergency detected for user ${uid} in group ${event.params.groupId}`);

      const userSnap = await admin.firestore().collection("users").doc(uid).get();
      const userData = userSnap.exists ? userSnap.data() : {};
      const username = userData.username || "member"; 

      const userDocs = await admin.firestore()
        .collection("users")
        .where("groupId", "==", event.params.groupId)
        .get();

      const tokens = [];
      userDocs.forEach(doc => {
        const data = doc.data();
        if (data.pushToken && doc.id !== uid) {
          tokens.push(data.pushToken);
        }
      });

      if (tokens.length > 0) {
        await sendExpoPush(
          tokens,
          "⚠️ Emergency Alert",
          `${username} signaled an emergency! Click here to view location.`,
          { emergencyUid: uid }
        );
      }
    }

    if (wasEmergency && !isEmergency) {
      console.log(`Emergency cleared for user ${uid} in group ${event.params.groupId}`);

      const userSnap = await admin.firestore().collection("users").doc(uid).get();
      const userData = userSnap.exists ? userSnap.data() : {};
      const username = userData.username || "member";

      const userDocs = await admin.firestore()
        .collection("users")
        .where("groupId", "==", event.params.groupId)
        .get();

      const tokens = [];
      userDocs.forEach(doc => {
        const data = doc.data();
        if (data.pushToken && doc.id !== uid) {
          tokens.push(data.pushToken);
        }
      });

      if (tokens.length > 0) {
        await sendExpoPush(
          tokens,
          "Emergency Cleared",
          `${username} is no longer in an emergency.`,
          { emergencyUid: uid }
        );
      }
    }
  }
});

function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }
}

async function openAIResponses(apiKey, body, signal) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("OpenAI error:", response.status, errText);
    throw new HttpsError("internal", "OpenAI request failed.");
  }

  const data = await response.json();
  let text = "";
  if (data.output_text) {
    text = data.output_text;
  } else if (Array.isArray(data.output)) {
    const item = data.output.find((i) => i.content);
    const textPart = item?.content?.find(
      (c) => c.type === "output_text" || c.type === "text"
    );
    if (textPart?.text) text = textPart.text;
  }

  return text;
}

exports.callChatGPT = onCall(
  { secrets: [OPENAI_API_KEY], timeoutSeconds: 60 },
  async (request) => {
    requireAuth(request);

    const { mode, payload } = request.data || {};
    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "OpenAI key not configured.");
    }

    if (mode === "feedback") {
      const statsJSON = payload?.statsJSON;
      if (!statsJSON || typeof statsJSON !== "object") {
        throw new HttpsError("invalid-argument", "statsJSON required.");
      }

      const text = await openAIResponses(apiKey, {
        model: "gpt-5-chat-latest",
        input: `Act as a driving safety coach.
        Stats (30 days): ${JSON.stringify(statsJSON)}

        Thresholds:
        - Speeding Margin: <3=excellent; 3-7=fair; >7=risky
        - Sudden Stops: <10=safe; 10-20=moderate; >20=risky
        - Sudden Accels: same as stops
        - Distance: <100mi -> mention data may be insufficient

        Output JSON only:
        {
          "score": 0-100,
          "summary": "1-2 sentences on strengths/weaknesses (mention 30 days)",
          "tips": ["5-10 concise tips referencing stats, casual/constructive"]
        }

        Rules:
        - Don't use variable names (e.g. no "avgSpeedingMargin")
        - Must cite actual numbers (e.g. "22 hard stops")
        - Be encouraging
        - No text outside JSON`,
      });

      if (!text) return { result: null };

      try {
        const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
        return { result: JSON.parse(cleaned) };
      } catch (err) {
        console.error("Failed to parse feedback JSON:", text, err);
        return { result: null };
      }
    }

    if (mode === "roadCondition") {
      const metrics = payload?.metrics;
      if (!metrics || typeof metrics !== "object") {
        throw new HttpsError("invalid-argument", "metrics required.");
      }

      const text = await openAIResponses(apiKey, {
        model: "gpt-5-nano",
        input: `You are evaluating road conditions.
        Metrics: ${JSON.stringify(metrics)}

        Return ONLY valid JSON in this schema, use commas to separate phrases:
        {
          "summary": "3-6 words about conditions",
          "score": 1-5 (1 = very dangerous, 5 = very safe)
        }`,
        reasoning: { effort: "minimal" },
      });

      if (!text) return { result: null };

      try {
        return { result: JSON.parse(text.trim()) };
      } catch (err) {
        console.error("Failed to parse road-condition JSON:", text, err);
        return { result: null };
      }
    }

    throw new HttpsError("invalid-argument", `Unknown mode: ${mode}`);
  }
);

exports.hereAutocomplete = onCall(
  { secrets: [HERE_API_KEY], timeoutSeconds: 15 },
  async (request) => {
    requireAuth(request);

    const { q } = request.data || {};
    if (typeof q !== "string" || !q.trim()) {
      throw new HttpsError("invalid-argument", "q (query) required.");
    }

    const apiKey = HERE_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "HERE key not configured.");
    }

    const url = `https://autocomplete.search.hereapi.com/v1/autocomplete?q=${encodeURIComponent(
      q
    )}&apiKey=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error("HERE autocomplete failed:", res.status);
      throw new HttpsError("internal", "HERE request failed.");
    }
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [] };
  }
);

exports.hereRevGeocode = onCall(
  { secrets: [HERE_API_KEY], timeoutSeconds: 15 },
  async (request) => {
    requireAuth(request);

    const { lat, lon } = request.data || {};
    if (typeof lat !== "number" || typeof lon !== "number") {
      throw new HttpsError("invalid-argument", "lat/lon (number) required.");
    }

    const apiKey = HERE_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "HERE key not configured.");
    }

    const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${lat},${lon}&lang=en-US&showNavAttributes=speedLimits&apikey=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error("HERE revgeocode failed:", res.status);
      throw new HttpsError("internal", "HERE request failed.");
    }
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [] };
  }
);
