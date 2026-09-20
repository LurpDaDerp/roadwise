import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  capTotal,
  scoringChangelog,
  scoringExplainer,
  type ExplainerBlock,
} from '@/content/scoring-explainer';
import { Card, Screen, Text, useTheme } from '@/ui';

import { Bars } from './Bars';
import { ChartBlock } from './ChartBlock';
import { TopBar } from './Chrome';
import { insightsCopy as copy } from './copy';
import { Field, FieldText, Rule } from './Field';
import { capRows, describeRows, tableRows } from './format';

/**
 * One section of the printed sheet: a rule, then the heading, then the paragraph and its list.
 * More air above the heading than below it, so the eight sections read as a document rather than
 * as eight interchangeable cards.
 */
function Block({
  block,
  first,
  children,
}: {
  block: ExplainerBlock;
  first: boolean;
  children?: ReactNode;
}) {
  const th = useTheme();
  return (
    <View
      testID={`block-${block.id}`}
      style={{
        gap: th.space.sm,
        paddingTop: first ? 0 : th.space.xl,
        marginTop: first ? 0 : th.space.xs,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: th.colors.border,
      }}
    >
      <Text variant="title3" accessibilityRole="header">
        {block.title}
      </Text>
      <Text variant="callout" tone="muted">
        {block.body}
      </Text>
      {children}
      {block.bullets ? (
        <View accessibilityRole="list" style={{ gap: th.space.xs, paddingTop: th.space.xs }}>
          {block.bullets.map((bullet) => (
            <View key={bullet} style={{ flexDirection: 'row', gap: th.space.sm }}>
              <Text variant="subhead" tone="subtle" accessibilityElementsHidden>
                —
              </Text>
              <Text variant="subhead" tone="muted" style={{ flex: 1 }}>
                {bullet}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * E4 — how scoring works (§7.E E4). The plain-language version of §9, written for trust: what is
 * measured, what is not, the caps, confidence, context, how to dispute, what the score is *not* —
 * and that this is an initial model, with the changelog behind it.
 *
 * Laid out as the back of the licence: one card face, eight ruled sections, the record of
 * versions on the desk beneath it. Every number is derived from `@scoring` by
 * `src/content/scoring-explainer.ts`, so a tuning change moves this screen with the engine
 * instead of leaving a stale promise printed on it.
 */
export function HowScoringWorksScreen() {
  const caps = capRows();

  return (
    <Screen scroll testID="how-scoring-works">
      <TopBar title={copy.how.title} />

      <Card variant="license">
        {scoringExplainer.map((block, index) => {
          if (block.id !== 'caps') {
            return <Block key={block.id} block={block} first={index === 0} />;
          }
          // The caps block lists the six ceilings in prose; drawn as boxes they are readable at a
          // glance, and the table toggle hands the same six numbers back as text.
          return (
            <Block key={block.id} block={{ ...block, bullets: undefined }} first={index === 0}>
              <ChartBlock
                label={describeRows(copy.how.capsCaption, caps)}
                summaryText={copy.how.capsSummary(capTotal)}
                table={{
                  caption: copy.how.capsCaption,
                  columns: [
                    { title: copy.how.capsColumns.category },
                    { title: copy.how.capsColumns.cap, numeric: true },
                  ],
                  rows: tableRows(caps),
                }}
                testID="caps-chart"
              >
                <Bars rows={caps} testID="caps-bars" />
              </ChartBlock>
            </Block>
          );
        })}
      </Card>

      <Field label={copy.how.changelog} testID="changelog">
        <View accessibilityRole="list">
          {scoringChangelog.map((entry, index) => (
            <Rule
              key={entry.version}
              label={copy.how.versionSpoken(entry.version, entry.date, entry.summary)}
              first={index === 0}
              testID={`version-${entry.version}`}
            >
              <FieldText face="numeral" variant="subhead" style={{ width: '30%' }}>
                {copy.how.version(entry.version)}
              </FieldText>
              <Text variant="subhead" style={{ flex: 1 }}>
                {entry.summary}
              </Text>
              <Text variant="footnote" tone="subtle">
                {entry.date}
              </Text>
            </Rule>
          ))}
        </View>
      </Field>
    </Screen>
  );
}
