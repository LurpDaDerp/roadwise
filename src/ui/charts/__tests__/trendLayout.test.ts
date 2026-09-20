import { layoutTrend, TREND, type Box } from '@/ui/charts/trendLayout';

// The same arithmetic the component draws with: if this passes, the labels cannot collide.

const series = (first: number) => [
  { label: 'Aug 4', value: first },
  { label: 'Aug 11', value: 76 },
  { label: 'Aug 18', value: null },
  { label: 'Aug 25', value: 84 },
];

const intersects = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe.each([1, 2])('at font scale %s', (fontScale) => {
  test.each([71, 76, 84, 60, 66, 52, 97])(
    'end labels clear the gutter numerals and the axis row for a first value of %s',
    (first) => {
      const l = layoutTrend(series(first), { width: 320, height: 160, fontScale });
      expect(l.ends).toHaveLength(2);
      const gutterRight = Math.max(...l.ticks.map((tick) => tick.box.right));
      for (const end of l.ends) {
        for (const tick of l.ticks) expect(intersects(end.box, tick.box)).toBe(false);
        expect(end.box.left).toBeGreaterThanOrEqual(gutterRight + TREND.gap);
        expect(end.box.top).toBeGreaterThanOrEqual(0);
        expect(end.box.bottom).toBeLessThanOrEqual(l.xLabelTop - TREND.gap / 2);
        expect(end.box.right).toBeLessThanOrEqual(l.width);
      }
    }
  );

  test('the plot keeps its height; only the gutters grow with the text', () => {
    const l = layoutTrend(series(71), { width: 320, height: 160, fontScale });
    expect(l.plotH).toBe(160 - TREND.padTop - TREND.gutterBottom);
    expect(l.height).toBe(160 + (fontScale - 1) * (TREND.padTop + TREND.gutterBottom));
    expect(l.xLabelTop + l.line).toBeLessThanOrEqual(l.height);
  });

  test('tick numerals never touch each other', () => {
    const l = layoutTrend(series(71), { width: 320, height: 160, fontScale });
    for (let i = 1; i < l.ticks.length; i += 1) {
      expect(l.ticks[i]!.box.top).toBeGreaterThanOrEqual(l.ticks[i - 1]!.box.bottom);
    }
    expect(l.ticks.map((tick) => tick.value)).toContain(100);
    expect(l.ticks.map((tick) => tick.value)).toContain(l.yMin);
  });
});

test('a last point near the top puts its label below the marker, still clear of the axis row', () => {
  const l = layoutTrend(
    [
      { label: 'a', value: 60 },
      { label: 'b', value: 99 },
    ],
    { width: 320, height: 160, fontScale: 2 }
  );
  const last = l.ends[l.ends.length - 1]!;
  expect(last.box.top).toBeGreaterThan(l.y(99));
  expect(last.box.bottom).toBeLessThanOrEqual(l.xLabelTop - TREND.gap / 2);
});

test('the first label starts one gap to the right of its marker, the last ends just past its own', () => {
  const l = layoutTrend(series(71), { width: 320, height: 160, fontScale: 1 });
  const [first, last] = l.ends;
  expect(first!.anchor).toEqual({ left: l.x(0) + TREND.gap });
  expect(last!.anchor).toEqual({ right: l.width - (l.x(3) + 6) });
  expect(last!.band).toBe('Good');
  expect(first!.band).toBeNull();
});

test('one scored point gets a single label with its band, anchored left', () => {
  const l = layoutTrend([{ label: 'a', value: null }, { label: 'b', value: 84 }], {
    width: 320,
    height: 160,
    fontScale: 1,
  });
  expect(l.ends).toHaveLength(1);
  expect(l.ends[0]!.atRight).toBe(false);
  expect(l.ends[0]!.band).toBe('Good');
});

test('a period without a score breaks the path', () => {
  const l = layoutTrend(series(71), { width: 320, height: 160, fontScale: 1 });
  expect(l.path.match(/M/g)).toHaveLength(2);
});
