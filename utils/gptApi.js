// utils/gptApi.js
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

const callChatGPT = httpsCallable(functions, "callChatGPT");

export const getAIFeedback = async (statsJSON, signal) => {
  if (signal?.aborted) return null;

  const promise = callChatGPT({ mode: "feedback", payload: { statsJSON } });

  if (signal) {
    const abortPromise = new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    try {
      const { data } = await Promise.race([promise, abortPromise]);
      return data?.result ?? null;
    } catch (err) {
      if (err?.message === "aborted") return null;
      console.error("Error fetching AI feedback:", err);
      throw err;
    }
  }

  try {
    const { data } = await promise;
    return data?.result ?? null;
  } catch (err) {
    console.error("Error fetching AI feedback:", err);
    throw err;
  }
};

export const getRoadConditionSummary = async (metrics) => {
  try {
    const { data } = await callChatGPT({ mode: "roadCondition", payload: { metrics } });
    return data?.result ?? null;
  } catch (err) {
    console.error("Error fetching road condition summary:", err);
    throw err;
  }
};
