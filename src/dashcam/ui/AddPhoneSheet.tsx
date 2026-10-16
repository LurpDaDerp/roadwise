import { useEffect, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, Sheet, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import { dashpalLink, formatCode, linkDomain, type PairingCode } from '../label';

const copy = dashpalCopy.screen.addPhoneSheet;

/** The one-time code's window on the dashcam: ADD_PHONE opens it for 120 s. */
export const ADD_PHONE_WINDOW_MS = 120_000;

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Add another phone: the one-time code the dashcam accepts for 2 minutes, as a QR code of its link
 * for the other phone to scan (in RoadWise or with its own camera), with the time left and Show code
 * for typing. Only the one-time code is ever shown here, never the DashPal's label code. The code
 * lives only in this sheet: closing it, or the 2 minutes ending, wipes it. With no link domain in
 * this build there is no QR code, only the code to type.
 */
export function AddPhoneSheet({
  code,
  dashcamId,
  openedAt,
  onClose,
  now = Date.now,
  domain = linkDomain(),
}: {
  code: PairingCode | null;
  dashcamId: string;
  openedAt: number;
  onClose(): void;
  now?: () => number;
  domain?: string;
}) {
  const th = useTheme();
  const close = () => {
    code?.S.fill(0);
    onClose();
  };
  return (
    <Sheet visible={code !== null} onClose={close} title={copy.title} testID="dashcam-add-phone-sheet">
      {code ? <AddPhoneBody key={openedAt} code={code} dashcamId={dashcamId} openedAt={openedAt} now={now} domain={domain} /> : null}
      <Button label={copy.done} variant="ghost" onPress={close} testID="add-phone-done" style={{ marginTop: th.space.sm }} />
    </Sheet>
  );
}

function AddPhoneBody({ code, dashcamId, openedAt, now, domain }: { code: PairingCode; dashcamId: string; openedAt: number; now: () => number; domain: string }) {
  const th = useTheme();
  const [left, setLeft] = useState(() => ADD_PHONE_WINDOW_MS - (now() - openedAt));
  const [showCode, setShowCode] = useState(false);
  const ended = left <= 0;

  useEffect(() => {
    const timer = setInterval(() => setLeft(ADD_PHONE_WINDOW_MS - (now() - openedAt)), 1000);
    return () => clearInterval(timer);
    // `now` and `openedAt` are fixed for this body (it is keyed by `openedAt`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ended) code.S.fill(0);
  }, [code, ended]);

  if (ended) {
    return (
      <Text variant="body" testID="add-phone-ended">
        {copy.ended}
      </Text>
    );
  }
  const text = formatCode(code.S, 'once');
  const link = domain.length > 0 ? dashpalLink(dashcamId, code, domain) : null;
  return (
    <View style={{ gap: th.space.md, alignItems: 'center' }}>
      {link ? (
        <View style={{ padding: th.space.md, backgroundColor: '#FFFFFF', borderRadius: th.radius.card }} testID="add-phone-qr">
          <QRCode value={link} size={200} color="#001D3D" backgroundColor="#FFFFFF" ecl="M" />
        </View>
      ) : null}
      <Text variant="headline" testID="add-phone-left">
        {copy.left(mmss(left))}
      </Text>
      <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }}>
        {copy.body}
      </Text>
      {showCode || !link ? (
        <Text variant="headline" selectable style={{ textAlign: 'center' }} testID="add-phone-code">
          {text}
        </Text>
      ) : (
        <Button label={copy.showCode} variant="secondary" onPress={() => setShowCode(true)} testID="add-phone-show-code" />
      )}
    </View>
  );
}
