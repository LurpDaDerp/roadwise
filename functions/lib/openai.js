"use strict";

const {HttpsError} = require("firebase-functions/v2/https");

const {fetchJson} = require("./http");

const FEEDBACK_MODEL = "gpt-5-chat-latest";
const ROAD_CONDITION_MODEL = "gpt-5-nano";

async function callResponses(apiKey, body) {
  const res = await fetchJson("https://api.openai.com/v1/responses", {
    method: "POST",
    timeoutMs: 45000,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("OpenAI error:", res.status, (res.text || "").slice(0, 500));
    throw new HttpsError("internal", "OpenAI request failed.");
  }

  const data = res.body || {};
  if (data.output_text) return data.output_text;

  if (Array.isArray(data.output)) {
    const item = data.output.find((i) => i.content);
    const textPart = item && item.content &&
      item.content.find((c) => c.type === "output_text" || c.type === "text");
    if (textPart && textPart.text) return textPart.text;
  }
  return "";
}

function parseJsonResponse(text, label) {
  if (!text) return null;
  try {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error(`Failed to parse ${label} JSON:`, text.slice(0, 500));
    return null;
  }
}

async function driverFeedback(apiKey, statsSerialized) {
  const text = await callResponses(apiKey, {
    model: FEEDBACK_MODEL,
    input: `Act as a driving safety coach.
Stats (30 days): ${statsSerialized}

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

  const parsed = parseJsonResponse(text, "feedback");
  if (!parsed) return null;

  // The score drives a UI gauge; clamp it rather than trusting the model.
  const score = Number(parsed.score);
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    tips: Array.isArray(parsed.tips) ? parsed.tips.filter((tip) => typeof tip === "string") : [],
  };
}

async function roadCondition(apiKey, metricsSerialized) {
  const text = await callResponses(apiKey, {
    model: ROAD_CONDITION_MODEL,
    input: `You are evaluating road conditions.
Metrics: ${metricsSerialized}

Return ONLY valid JSON in this schema, use commas to separate phrases:
{
  "summary": "3-6 words about conditions",
  "score": 1-5 (1 = very dangerous, 5 = very safe)
}`,
    reasoning: {effort: "minimal"},
  });

  const parsed = parseJsonResponse(text, "road-condition");
  if (!parsed) return null;

  const score = Number(parsed.score);
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 80) : "",
    score: Number.isFinite(score) ? Math.max(1, Math.min(5, Math.round(score))) : 3,
  };
}

module.exports = {driverFeedback, roadCondition};
