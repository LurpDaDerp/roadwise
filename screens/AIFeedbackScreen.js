// AIFeedbackScreen — the personalized coaching response. The request, response
// cache and safety-score write are unchanged; only the presentation moved onto
// the shared primitives.
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Dimensions } from 'react-native';
import LottieView from 'lottie-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuth } from 'firebase/auth';

import { getAIFeedback } from '../utils/gptApi';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Banner,
  Button,
  Ring,
  scoreColor,
  useTheme,
} from '../theme';
import { TipsList } from '../components/drives';
import { scoreLabel } from '../utils/driveScore';

const { width } = Dimensions.get('window');

function normalizeInput(stats) {
  const { generatedAt, ...rest } = stats;
  return rest;
}

export default function AIFeedbackScreen({ route }) {
  const t = useTheme();
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('Analyzing data...');

  useEffect(() => {
    if (feedback !== null) return;
    const controller = new AbortController();
    const messages = ['Processing data…', 'Analyzing driving behavior…', 'Generating response…'];
    let index = 0;
    setLoadingMessage(messages[index]);
    let timeoutId;

    const showNextMessage = () => {
      index++;
      if (index < messages.length) {
        const randomDelay = Math.floor(Math.random() * 1800) + 750;
        timeoutId = setTimeout(() => {
          setLoadingMessage(messages[index]);
          showNextMessage();
        }, randomDelay);
      }
    };
    showNextMessage();

    const fetchFeedback = async () => {
      try {
        const user = getAuth().currentUser;
        if (!user) {
          if (!controller.signal.aborted) {
            setFeedback({ summary: 'No user logged in.', score: 0, tips: [] });
            setError('No user logged in.');
            setLoading(false);
          }
          return;
        }

        const { statsJSON } = route.params;
        const normalizedInput = normalizeInput(statsJSON);

        let cache = [];
        try {
          const storedCache = await AsyncStorage.getItem('feedbackCache');
          if (storedCache) cache = JSON.parse(storedCache);
        } catch (err) {
          console.error('Error loading cache:', err);
        }

        const match = cache.find(
          (entry) => JSON.stringify(entry.input) === JSON.stringify(normalizedInput)
        );
        if (match) {
          setFeedback(match.response);
          setLoading(false);
          return;
        }

        const aiResponse = await getAIFeedback(statsJSON, controller.signal);
        if (!controller.signal.aborted) {
          if (!aiResponse) {
            setFeedback({ summary: 'No feedback received.', score: 0, tips: [] });
            setError('No feedback received. The coach did not return a response.');
          } else {
            setFeedback(aiResponse);
            try {
              await AsyncStorage.setItem('safetyScore', aiResponse.score.toString());
            } catch (err) {
              console.error('Error saving safety score:', err);
            }
            try {
              const newEntry = { input: normalizedInput, response: aiResponse };
              const updatedCache = [newEntry, ...cache].slice(0, 10);
              await AsyncStorage.setItem('feedbackCache', JSON.stringify(updatedCache));
            } catch (err) {
              console.error('Error updating cache:', err);
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error(err);
          setFeedback({ summary: 'Error getting AI feedback.', score: 0, tips: [] });
          setError('Could not reach the feedback service. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          clearTimeout(timeoutId);
        }
      }
    };

    fetchFeedback();
    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const retry = () => {
    setError(null);
    setFeedback(null);
    setLoading(true);
    setAttempt((a) => a + 1);
  };

  if (loading) {
    return (
      <Screen hasHeader>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <LottieView
            source={require('../assets/loader.json')}
            autoPlay
            loop
            style={{ width: width * 0.9, height: width * 0.9 }}
          />
          <Text
            style={[
              t.typography.bodyStrong,
              { color: t.colors.text, position: 'absolute', marginTop: 40 },
            ]}
          >
            {loadingMessage}
          </Text>
        </View>
      </Screen>
    );
  }

  const score = Math.max(0, Math.min(100, Number(feedback?.score) || 0));

  return (
    <Screen hasHeader>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
        <ScreenHeader
          eyebrow="Insights · Feedback"
          title="Your feedback"
          subtitle="A personalized read on your recent drives."
        />

        {error ? (
          <Section>
            <Banner
              tone="danger"
              title="Feedback unavailable"
              body={error}
              style={{ marginBottom: 14 }}
            />
            <Button title="Try again" onPress={retry} />
          </Section>
        ) : (
          !!feedback && (
            <>
              <Section label="Safety rating">
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
                    <Ring value={score} size={104} color={scoreColor(score, t)} />
                    <View style={{ flex: 1 }}>
                      <Text style={[t.typography.subheading, { color: scoreColor(score, t) }]}>
                        {scoreLabel(score)}
                      </Text>
                      <Text
                        style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 4 }]}
                      >
                        Overall score across your last 30 days of driving.
                      </Text>
                    </View>
                  </View>
                </Card>
              </Section>

              <Section label="Summary">
                <Card>
                  <Text style={[t.typography.body, { color: t.colors.text, lineHeight: 23 }]}>
                    {feedback.summary}
                  </Text>
                </Card>
              </Section>

              {feedback.tips && feedback.tips.length > 0 && (
                <Section label="Tips & suggestions">
                  <TipsList tips={feedback.tips} icon="bulb-outline" />
                </Section>
              )}
            </>
          )
        )}
      </ScrollView>
    </Screen>
  );
}
