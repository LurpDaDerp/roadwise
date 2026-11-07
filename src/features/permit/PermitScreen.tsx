// `/settings/permit`: Permit mode. The switch, and while it is on: the practice hours against the
// targets, the state (detected from the phone's location, or chosen), the hour targets with a hint
// to check them, the supervisor, the name on the log, the log's start date, the practice drives and
// the PDF of the log. Everything stays on this phone.
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useDataSource } from '@/data/queries/context';
import { useUnits } from '@/data/queries/units';
import { LinkRow, Section, SwitchRow, TopBar } from '@/features/settings/parts';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Button, Card, ProgressBar, Screen, Text, useTheme } from '@/ui';

import { permitCopy } from './copy';
import { DayPickerSheet } from './DayPickerSheet';
import { dayTargetOf, hoursText, nightRuleOf, permitState, progressOf, targetsOf, targetText, type LogTotals } from './log';
import { practiceLogHtml, dayText, sharePracticeLog, type PdfDeps } from './pdf';
import { NameSheet, StateSheet, TargetsSheet } from './PermitSheets';
import {
  todayKey,
  writeDriverName,
  writePermitEnabled,
  writePermitState,
  writeStartDay,
  writeSupervisor,
  writeTargets,
  type PermitTargets,
} from './prefs';
import { detectState, phoneStatePorts, type StatePorts } from './stateAt';
import { usePermitPrefs, usePracticeLog } from './usePermit';

const copy = permitCopy;

type SheetName = 'state' | 'targets' | 'supervisor' | 'driverName' | 'startDay' | null;

function ProgressRow({ label, minutes, target, testID }: { label: string; minutes: number; target: number | null; testID: string }) {
  const t = useTheme();
  const done = hoursText(minutes);
  const goal = target === null ? null : targetText(target);
  return (
    <View style={{ gap: t.space.xs }} testID={testID}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: t.space.md }}>
        <Text variant="subhead">{label}</Text>
        <Text variant="subhead" tone="muted" testID={`${testID}-value`}>
          {goal === null ? copy.progress.hours(done) : copy.progress.of(done, goal)}
        </Text>
      </View>
      {goal !== null ? (
        <ProgressBar value={progressOf(minutes, target)} tone="accent" height={8} accessibilityLabel={label} accessibilityValueText={copy.progress.spoken(label, done, goal)} />
      ) : null}
    </View>
  );
}

/** Day, night and total against the targets; total only without a night target. */
function ProgressCard({ totals, targets }: { totals: LogTotals; targets: PermitTargets }) {
  const t = useTheme();
  const p = copy.progress;
  return (
    <Card testID="permit-progress">
      <View style={{ gap: t.space.md }}>
        <Text variant="headline">{p.title}</Text>
        {targets.nightH !== null ? (
          <>
            <ProgressRow label={p.day} minutes={totals.dayMin} target={dayTargetOf(targets)} testID="permit-progress-day" />
            <ProgressRow label={p.night} minutes={totals.nightMin} target={targets.nightH} testID="permit-progress-night" />
          </>
        ) : null}
        <ProgressRow label={p.total} minutes={totals.totalMin} target={targets.totalH} testID="permit-progress-total" />
      </View>
    </Card>
  );
}

const EMPTY_TOTALS: LogTotals = { drives: 0, dayMin: 0, nightMin: 0, totalMin: 0, miles: 0 };

export function PermitScreen({ deps = {} }: { deps?: { state?: StatePorts; pdf?: PdfDeps } }) {
  const t = useTheme();
  const router = useRouter();
  const { now } = useDataSource();
  const units = useUnits();
  const { prefs, write } = usePermitPrefs();
  const { log, loading: logLoading } = usePracticeLog(prefs);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [saveError, setSaveError] = useState(false);
  const [pdfState, setPdfState] = useState<'idle' | 'busy' | 'error'>('idle');
  const ports = deps.state ?? phoneStatePorts;

  const save = async (fn: Parameters<typeof write>[0]): Promise<boolean> => {
    const ok = await write(fn);
    setSaveError(!ok);
    return ok;
  };

  // The state follows the phone's location while it is set to: looked up each time the screen
  // opens (and when Permit mode is turned on). Nothing found leaves what is stored.
  const enabled = prefs?.enabled === true;
  const auto = prefs?.state.auto === true;
  const storedCode = prefs?.state.code ?? null;
  useEffect(() => {
    if (!enabled || !auto) return;
    let live = true;
    void detectState(ports).then((found) => {
      if (!live || found === null || found.code === storedCode) return;
      void write((s) => writePermitState(s, found.code, true));
    });
    return () => {
      live = false;
    };
    // Once per opening (and per switch to auto): the code it writes doesn't ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, auto]);

  const state = prefs ? permitState(prefs) : null;
  const targets = prefs ? targetsOf(prefs) : { totalH: null, nightH: null };
  const totals = log?.totals ?? EMPTY_TOTALS;
  const today = todayKey(now());
  const startDay = prefs?.startDay ?? today;

  const downloadPdf = async () => {
    // Never a log printed before its drives are read.
    if (!prefs || log === undefined) return;
    setPdfState('busy');
    const html = practiceLogHtml({
      log,
      startDay,
      now: now(),
      state,
      rule: nightRuleOf(state),
      targets,
      driverName: prefs.driverName,
      units,
    });
    const ok = await sharePracticeLog(html, deps.pdf);
    setPdfState(ok ? 'idle' : 'error');
  };

  const stateLine = state === null ? copy.state.choose : `${state.name} · ${auto ? copy.state.detected : copy.state.chosen}`;
  const targetsLine = copy.targets.summary(targets.totalH === null ? null : targetText(targets.totalH), targets.nightH === null ? null : targetText(targets.nightH));

  return (
    <Screen scroll testID="permit-screen">
      <TopBar title={copy.title} />
      <Section footer={copy.switchBody}>
        <SwitchRow
          icon="school-outline"
          title={copy.switchTitle}
          value={enabled}
          onValueChange={(on) => void save((s) => writePermitEnabled(s, on, now()))}
          testID="permit-switch"
        />
      </Section>
      {saveError ? (
        <Text variant="footnote" tone="danger" testID="permit-save-error">
          {copy.saveError}
        </Text>
      ) : null}

      {enabled && prefs ? (
        <>
          <ProgressCard totals={totals} targets={targets} />

          <View style={{ gap: t.space.sm }}>
            <Section>
              <LinkRow icon="map-outline" title={copy.state.title} subtitle={stateLine} onPress={() => setSheet('state')} testID="permit-state" />
              <LinkRow icon="flag-outline" title={copy.targets.title} subtitle={targetsLine} onPress={() => setSheet('targets')} testID="permit-targets" />
            </Section>
            <Text variant="footnote" tone="muted" testID="permit-targets-hint">
              {copy.targets.hint}
            </Text>
            {state !== null && state.note !== '' ? (
              <Text variant="footnote" tone="muted" testID="permit-state-note">
                {state.note}
              </Text>
            ) : null}
          </View>

          <Section>
            <LinkRow icon="person-outline" title={copy.supervisor.title} subtitle={prefs.supervisor ?? copy.supervisor.notSet} onPress={() => setSheet('supervisor')} testID="permit-supervisor" />
            <LinkRow icon="id-card-outline" title={copy.driverName.title} subtitle={prefs.driverName ?? copy.driverName.notSet} onPress={() => setSheet('driverName')} testID="permit-driver-name" />
            <LinkRow icon="calendar-outline" title={copy.startDay.title} subtitle={dayText(startDay)} onPress={() => setSheet('startDay')} testID="permit-start-day" />
            <LinkRow
              icon="list-outline"
              title={copy.drives.title}
              subtitle={copy.drives.rowSubtitle(totals.drives)}
              onPress={() => router.push(SETTINGS_HREFS.practiceDrives)}
              testID="permit-drives"
            />
          </Section>

          <Button label={copy.download} icon="document-text-outline" variant="secondary" loading={pdfState === 'busy' || logLoading} disabled={log === undefined} onPress={() => void downloadPdf()} testID="permit-download" />
          {pdfState === 'error' ? (
            <Text variant="footnote" tone="danger" testID="permit-download-error">
              {copy.downloadError}
            </Text>
          ) : null}

          <StateSheet
            visible={sheet === 'state'}
            selected={storedCode}
            auto={auto}
            onAuto={async () => {
              const found = await detectState(ports);
              if (found !== null) return save((s) => writePermitState(s, found.code, true));
              // Nothing found: the state still follows the location from now on (each opening looks
              // again). A state that was chosen goes; one already detected stays.
              if (!auto) await save((s) => writePermitState(s, null, true));
              return false;
            }}
            onChoose={(code) => {
              setSheet(null);
              void save((s) => writePermitState(s, code, false));
            }}
            onClose={() => setSheet(null)}
          />
          <TargetsSheet
            visible={sheet === 'targets'}
            targets={targets}
            state={prefs.targets !== null ? state : null}
            onSave={(next) => save((s) => writeTargets(s, next))}
            onReset={() => save((s) => writeTargets(s, null))}
            onClose={() => setSheet(null)}
          />
          <NameSheet
            visible={sheet === 'supervisor'}
            copy={copy.supervisor}
            initial={prefs.supervisor}
            onSave={(name) => save((s) => writeSupervisor(s, name))}
            onClose={() => setSheet(null)}
            testID="permit-supervisor-sheet"
          />
          <NameSheet
            visible={sheet === 'driverName'}
            copy={copy.driverName}
            initial={prefs.driverName}
            onSave={(name) => save((s) => writeDriverName(s, name))}
            onClose={() => setSheet(null)}
            testID="permit-driver-name-sheet"
          />
          <DayPickerSheet
            visible={sheet === 'startDay'}
            value={startDay}
            max={today}
            onPick={(day) => {
              setSheet(null);
              void save((s) => writeStartDay(s, day, now()));
            }}
            onClose={() => setSheet(null)}
          />
        </>
      ) : null}
    </Screen>
  );
}
