import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Card, Divider, Text, useTheme } from '@/ui';

import { signedPoints } from './format';
import { canReport, disputeText, isRemoved, RECEIPT_MAX_LINES, spokenPoints, type Receipt as ReceiptData, type ReceiptLine } from './summary';

const TABULAR = { fontVariant: ['tabular-nums' as const] };

/** A receipt's dashed rule above the total. A one-sided dashed border draws solid on iOS, so a clipped box draws it. */
function DashedRule() {
  const t = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={{ height: 1, overflow: 'hidden', marginTop: t.space.xs }}>
      <View style={{ height: 2, borderWidth: 1, borderStyle: 'dashed', borderColor: t.colors.borderStrong }} />
    </View>
  );
}

/** A screen reader reads "→" as "right arrow"; the multiplier line says "to" instead. */
const spokenArrow = (s: string): string => s.replace(/ → /g, ' to ');

function EarnedRow({ earned, detail }: { earned: number; detail: readonly string[] }) {
  const t = useTheme();
  const color = earned > 0 ? t.colors.signal.clean.text : t.colors.textMuted;
  return (
    <View
      testID="receipt-earned"
      accessible
      accessibilityLabel={`Earned, ${spokenPoints(earned)}${detail.length > 0 ? `. ${detail.map(spokenArrow).join(', ')}` : ''}`}
      style={{ gap: 2, paddingBottom: t.space.sm }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: t.space.md }}>
        <Text variant="label" tone="muted">
          Earned
        </Text>
        <Text variant="title2" style={[TABULAR, { color }]}>
          {signedPoints(earned)}
        </Text>
      </View>
      {detail.length > 0 ? (
        <Text variant="footnote" tone="muted" testID="receipt-detail">
          {detail.join(' · ')}
        </Text>
      ) : null}
    </View>
  );
}

function DeductionLine({ line, selected, onSelect, onReport }: { line: ReceiptLine; selected: boolean; onSelect: () => void; onReport: () => void }) {
  const t = useTheme();
  const e = line.event;
  const removed = isRemoved(e);
  const status = disputeText(e);
  const color = line.tone === 'loss' ? t.colors.signal.severe.text : t.colors.textMuted;
  const spoken = removed ? 'removed' : line.cost === null ? 'points not known yet' : spokenPoints(-line.cost);
  return (
    <View
      style={{
        marginHorizontal: -t.space.sm,
        paddingHorizontal: t.space.sm,
        paddingVertical: t.space.xs,
        borderRadius: t.radius.md,
        backgroundColor: selected ? t.colors.accentFaint : 'transparent',
      }}
    >
      <Pressable
        testID={line.key}
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={`${line.label} at ${line.time}, ${spoken}`}
        accessibilityHint="Circles it on the route map"
        accessibilityState={{ selected }}
        hitSlop={{ top: 4, bottom: 4 }}
        style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.md, minHeight: 36, paddingTop: t.space.xs }}
      >
        <Text variant="callout" style={[{ flex: 1 }, removed ? { textDecorationLine: 'line-through' } : null]}>
          {line.label}
        </Text>
        <Text variant="title3" style={[TABULAR, { color }]}>
          {line.value}
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: t.space.sm, minHeight: 28 }}>
        <Text variant="footnote" tone="subtle" accessibilityElementsHidden importantForAccessibility="no">
          {line.time}
        </Text>
        {canReport(e) ? (
          <Pressable
            testID={`report-${e.id}`}
            onPress={onReport}
            accessibilityRole="button"
            accessibilityLabel={`Report ${line.label} at ${line.time}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 16 }}
            style={({ pressed }) => ({ paddingVertical: t.space.xs, opacity: pressed ? 0.6 : 1 })}
          >
            <Text variant="footnote" tone="accent" style={{ fontWeight: '600', textDecorationLine: 'underline' }}>
              Report
            </Text>
          </Pressable>
        ) : status ? (
          <Text variant="footnote" tone="muted" testID={`dispute-${e.id}`} style={{ flexShrink: 1 }}>
            {status}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export type ReceiptProps = {
  receipt: ReceiptData;
  selectedId: string | null;
  onSelect: (eventId: string) => void;
  onReport: (eventId: string) => void;
};

/**
 * The summary's points receipt: Earned in green, one line per deduction in red (tap → circled on
 * the map, Report under it), at most five before "Show more", then the total under a dashed rule.
 * Every amount carries its sign, so colour is never the only cue.
 */
export function Receipt({ receipt, selectedId, onSelect, onReport }: ReceiptProps) {
  const t = useTheme();
  const [all, setAll] = useState(false);
  const { earned, detail, deductions, total, note } = receipt;
  const hidden = deductions.length - RECEIPT_MAX_LINES;
  const shown = all || hidden <= 0 ? deductions : deductions.slice(0, RECEIPT_MAX_LINES);
  return (
    <Card padded style={{ gap: 0 }} testID="receipt">
      {earned !== null ? <EarnedRow earned={earned} detail={detail} /> : null}
      {deductions.length === 0 ? (
        <>
          {earned !== null ? <Divider /> : null}
          <Text variant="callout" tone="muted" testID="receipt-none" style={{ paddingVertical: t.space.md }}>
            No deductions
          </Text>
        </>
      ) : (
        shown.map((line, i) => (
          <View key={line.key}>
            {i > 0 || earned !== null ? <Divider /> : null}
            <DeductionLine line={line} selected={selectedId === line.event.id} onSelect={() => onSelect(line.event.id)} onReport={() => onReport(line.event.id)} />
          </View>
        ))
      )}
      {hidden > 0 ? (
        <Button
          label={all ? 'Show less' : 'Show more'}
          icon={all ? 'chevron-up' : 'chevron-down'}
          variant="ghost"
          size="sm"
          onPress={() => setAll((v) => !v)}
          accessibilityHint={all ? 'Hides the extra deductions' : `Shows ${hidden} more ${hidden === 1 ? 'deduction' : 'deductions'}`}
          testID="receipt-more"
          style={{ alignSelf: 'flex-start', marginTop: t.space.xs }}
        />
      ) : null}
      {total !== null ? (
        <>
          <DashedRule />
          <View
            testID="receipt-total"
            accessible
            accessibilityLabel={`Total, ${spokenPoints(total)}`}
            style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: t.space.md, paddingTop: t.space.md }}
          >
            <Text variant="headline">Total</Text>
            <Text variant="stat" style={TABULAR}>
              {signedPoints(total)}
            </Text>
          </View>
        </>
      ) : null}
      {note ? (
        <Text variant="footnote" tone="muted" style={{ paddingTop: t.space.sm }}>
          {note}
        </Text>
      ) : null}
    </Card>
  );
}
