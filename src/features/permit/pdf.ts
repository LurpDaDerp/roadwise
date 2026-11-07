/**
 * The practice log as a PDF: an HTML page (pure, `practiceLogHtml`) printed to a file by
 * `expo-print` and handed to the share sheet (`sharePracticeLog`: Save to Files, Mail, AirDrop,
 * Print). The file lives in the app's cache; it is deleted once the sheet is done with it.
 */
import { formatDuration } from '@/features/drives/format';
import { distanceIn, type Units } from '@/lib/units';

import { permitCopy } from './copy';
import { dayTargetOf, hoursText, targetText, type PracticeLog } from './log';
import type { PermitTargets } from './prefs';
import type { NightRule, PermitState } from './states';

const copy = permitCopy.pdf;

/** Text made safe for the page. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A formatter in `tz` when it is one the phone knows, else in the phone's own zone. */
function inZone(options: Intl.DateTimeFormatOptions, tz?: string | null): Intl.DateTimeFormat {
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
    } catch {
      // an unknown zone: the phone's
    }
  }
  return new Intl.DateTimeFormat('en-US', options);
}

/** "Oct 5, 2026" (in `tz` when given: a drive's date is its own local date, as the log counts it). */
const longDay = (ts: number, tz?: string | null): string => inZone({ month: 'short', day: 'numeric', year: 'numeric' }, tz).format(new Date(ts));

/** "7:42 AM", in the drive's own zone like its date. */
const clock = (ts: number, tz?: string | null): string => inZone({ hour: 'numeric', minute: '2-digit' }, tz).format(new Date(ts));

/** A "YYYY-MM-DD" day as "Oct 5, 2026". */
export function dayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return longDay(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime());
}

export interface PracticeLogDoc {
  log: PracticeLog;
  startDay: string;
  /** Now, for the period's end. */
  now: number;
  state: PermitState | null;
  rule: NightRule;
  targets: PermitTargets;
  driverName: string | null;
  units: Units;
}

const progressLine = (label: string, minutes: number, target: number | null): string =>
  `<tr><td>${label}</td><td>${target === null ? copy.hours(hoursText(minutes)) : copy.of(hoursText(minutes), targetText(target))}</td></tr>`;

/** The printed log: title, who and where, the period, every practice drive, the totals, progress, the night rule, signature lines and the footer. */
export function practiceLogHtml(doc: PracticeLogDoc): string {
  const { log, targets, units } = doc;
  const distance = (miles: number) => distanceIn(miles, units).toFixed(1);
  const [date, start, end, duration, dayMin, nightMin, milesCol, supervisor] = copy.columns;
  const head = [date, start, end, duration, dayMin, nightMin, units === 'km' ? copy.kmColumn : milesCol, supervisor].map((c) => `<th>${escapeHtml(c ?? '')}</th>`).join('');
  const rows = [...log.rows]
    .reverse() // oldest first on paper
    .map((r) => {
      const endTs = r.drive.endedAt ?? r.drive.startedAt + r.drive.durationS * 1000;
      const cells = [
        longDay(r.drive.startedAt, r.drive.tz),
        clock(r.drive.startedAt, r.drive.tz),
        clock(endTs, r.drive.tz),
        formatDuration((r.dayMin + r.nightMin) * 60),
        String(r.dayMin),
        String(r.nightMin),
        distance(r.drive.miles),
        r.supervisor ?? '',
      ];
      return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
    })
    .join('\n');
  const t = log.totals;
  const totals = `<tr class="totals"><td>${copy.totals}</td><td></td><td></td><td>${escapeHtml(formatDuration(t.totalMin * 60))}</td><td>${t.dayMin}</td><td>${t.nightMin}</td><td>${distance(t.miles)}</td><td></td></tr>`;
  const progress =
    targets.nightH === null
      ? progressLine(copy.total, t.totalMin, targets.totalH)
      : [progressLine(copy.day, t.dayMin, dayTargetOf(targets)), progressLine(copy.night, t.nightMin, targets.nightH), progressLine(copy.total, t.totalMin, targets.totalH)].join('');
  const meta = [
    ...(doc.driverName === null ? [] : [[copy.driver, doc.driverName]]),
    [copy.state, doc.state?.name ?? copy.noState],
    [copy.period, `${dayText(doc.startDay)} to ${longDay(doc.now)}`],
  ]
    .map(([k, v]) => `<tr><th>${escapeHtml(k ?? '')}</th><td>${escapeHtml(v ?? '')}</td></tr>`)
    .join('');
  const signatures = copy.signatures.map((s) => `<div class="sig"><div class="line"></div>${escapeHtml(s)}</div>`).join('');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${copy.title}</title>
<style>
body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; margin: 32px; font-size: 11px; }
h1 { font-size: 20px; margin: 0 0 12px; }
h2 { font-size: 13px; margin: 20px 0 6px; }
table { border-collapse: collapse; }
.meta th { text-align: left; padding: 2px 12px 2px 0; font-weight: 600; }
.meta td { padding: 2px 0; }
.log { width: 100%; margin-top: 16px; }
.log th, .log td { border: 1px solid #999; padding: 4px 6px; text-align: left; }
.log th { background: #eee; }
.log .totals td { font-weight: 700; }
.progress td { padding: 2px 16px 2px 0; }
.rule { margin-top: 12px; }
.sigs { display: flex; gap: 24px; margin-top: 40px; }
.sig { flex: 1; font-size: 10px; color: #444; }
.sig .line { border-bottom: 1px solid #111; height: 28px; margin-bottom: 4px; }
.footer { margin-top: 32px; font-size: 9px; color: #555; }
</style></head>
<body>
<h1>${copy.title}</h1>
<table class="meta">${meta}</table>
<table class="log"><thead><tr>${head}</tr></thead><tbody>
${rows === '' ? `<tr><td colspan="8">${copy.empty}</td></tr>` : rows}
${totals}
</tbody></table>
<h2>${copy.progressTitle}</h2>
<table class="progress">${progress}</table>
<p class="rule">${escapeHtml(copy.nightRule(doc.rule, doc.state?.name ?? null))}</p>
<div class="sigs">${signatures}</div>
<p class="footer">${escapeHtml(copy.footer)}</p>
</body></html>`;
}

export interface PdfDeps {
  print?: (html: string) => Promise<{ uri: string }>;
  isAvailable?: () => Promise<boolean>;
  share?: (uri: string, options: { mimeType: string; UTI: string; dialogTitle: string }) => Promise<unknown>;
  remove?: (uri: string) => void;
}

const defaultPrint = async (html: string): Promise<{ uri: string }> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const Print = require('expo-print') as typeof import('expo-print');
  return Print.printToFileAsync({ html });
};

const sharing = (): typeof import('expo-sharing') =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  require('expo-sharing') as typeof import('expo-sharing');

const defaultRemove = (uri: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const { File } = require('expo-file-system') as typeof import('expo-file-system');
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // a leftover in the cache is the OS's to clear
  }
};

/** Prints the page to a PDF and opens the share sheet with it. False on any failure. Never throws. */
export async function sharePracticeLog(html: string, deps: PdfDeps = {}): Promise<boolean> {
  const print = deps.print ?? defaultPrint;
  const isAvailable = deps.isAvailable ?? (() => sharing().isAvailableAsync());
  const share = deps.share ?? ((uri, options) => sharing().shareAsync(uri, options));
  const remove = deps.remove ?? defaultRemove;
  let uri: string | null = null;
  try {
    if (!(await isAvailable())) return false;
    uri = (await print(html)).uri;
    await share(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: copy.dialogTitle });
    return true;
  } catch {
    return false;
  } finally {
    if (uri !== null) remove(uri);
  }
}
