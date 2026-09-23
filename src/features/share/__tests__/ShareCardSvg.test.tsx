/**
 * The privacy rules over what the card actually DRAWS (final review m10): each kind rendered by
 * `ShareCardSvg`, every toggle on, from inputs that carry a name, a birth date, place labels, a
 * polyline and a user id. The strings are read from the rendered SVG text nodes, not from the model.
 */
import { render, screen } from '@testing-library/react-native';

import { BANNED_COPY } from '@/notifications/catalog';
import { ThemeProvider } from '@/ui/theme';

import { buildCardModel, CARD_KINDS } from '../cardModel';
import { ShareCardSvg } from '../ShareCardSvg';
import { INPUTS, LEAKS } from '../__fixtures__/cards';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

/**
 * Every string the SVG draws: react-native-svg renders a text run as an `RNSVGTSpan` whose
 * `content` prop is the string (plus any plain string children).
 */
function svgText(tree: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as { props?: { content?: unknown }; children?: unknown[] | null };
    if (typeof n.props?.content === 'string') out.push(n.props.content);
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

async function drawn(kind: (typeof CARD_KINDS)[number]) {
  const model = buildCardModel({ ...INPUTS[kind], inviteCode: 'ABCD2345' }, { distance: true, code: true });
  expect(model).not.toBeNull();
  const view = await render(
    <ThemeProvider>
      <ShareCardSvg model={model!} width={360} />
    </ThemeProvider>
  );
  const strings = svgText(screen.toJSON());
  await view.unmount();
  return { model: model!, strings };
}

describe('ShareCardSvg: the text on the card itself', () => {
  test.each(CARD_KINDS)('%s: what is drawn carries no name, place, route, time, speed, ID wording or points', async (kind) => {
    const { strings } = await drawn(kind);
    expect(strings.length).toBeGreaterThan(3);
    const all = strings.join('\n');
    for (const leak of LEAKS) expect(all).not.toContain(leak);
    for (const s of strings) {
      expect(s).not.toMatch(/\d{1,2}:\d{2}/);
      expect(s).not.toMatch(/mph|km\/h|\blat\b|\blng\b|polyline/i);
      expect(s).not.toMatch(/licen[cs]e|\bID\b|DOB|date of birth|<<|MRZ/i);
      expect(s).not.toMatch(/points?\b/i);
      for (const re of BANNED_COPY) expect(s).not.toMatch(re);
    }
  });

  test.each(CARD_KINDS)('%s: the drawn text is the model — every field it prints, nothing else', async (kind) => {
    const { model, strings } = await drawn(kind);
    expect(strings).toContain('RoadWise');
    expect(strings).toContain(model.heading.toUpperCase());
    for (const detail of model.details) expect(strings).toContain(detail);
    if (model.unit) expect(strings).toContain(model.unit);
    // The primary may wrap over several text nodes; together they are the whole of it.
    expect(strings.join(' ')).toContain(model.primary);
    expect(strings).toContain('ABCD 2345');
  });
});
