import { countMetric, distanceMetric, percentMetric, pointsMetric, rateMetric, speedMetric, timeMetric } from '../format';

test('distance: one decimal under 100, whole numbers with separators above, in the driver units', () => {
  expect(distanceMetric(12.34, 'mi')).toEqual({ value: '12.3', unit: 'mi', spoken: '12.3 miles' });
  expect(distanceMetric(10, 'km')).toMatchObject({ value: '16.1', unit: 'km', spoken: '16.1 kilometers' });
  expect(distanceMetric(1204.4, 'mi')).toMatchObject({ value: '1,204' });
  expect(distanceMetric(0, 'mi').value).toBe('0.0');
  expect(distanceMetric(null, 'km')).toEqual({ value: '—', unit: 'km', spoken: 'no data' });
});

test('time: minutes under an hour, tenths of hours under ten, whole hours after', () => {
  expect(timeMetric(0)).toMatchObject({ value: '0', unit: 'min' });
  expect(timeMetric(20)).toMatchObject({ value: '<1', unit: 'min', spoken: 'under a minute' });
  expect(timeMetric(42 * 60)).toEqual({ value: '42', unit: 'min', spoken: '42 minutes' });
  expect(timeMetric(90 * 60)).toMatchObject({ value: '1.5', unit: 'h' });
  expect(timeMetric(152.2 * 3600)).toMatchObject({ value: '152', unit: 'h' });
});

test('speed, counts, percent and points', () => {
  expect(speedMetric(31.6, 'mi')).toMatchObject({ value: '32', unit: 'mph' });
  expect(speedMetric(31.6, 'km')).toMatchObject({ value: '51', unit: 'km/h' });
  expect(speedMetric(null, 'mi')).toMatchObject({ value: '—', spoken: 'no data' });
  expect(countMetric(1234)).toEqual({ value: '1,234', unit: '', spoken: '1,234' });
  expect(percentMetric(75)).toMatchObject({ value: '75', unit: '%' });
  expect(percentMetric(null).value).toBe('—');
  expect(pointsMetric(243)).toEqual({ value: '+243', unit: 'pts', spoken: 'plus 243 points' });
  expect(pointsMetric(-40)).toMatchObject({ value: '−40', spoken: 'minus 40 points' });
  expect(pointsMetric(0)).toMatchObject({ value: '0', spoken: '0 points' });
  expect(pointsMetric(44.6)).toMatchObject({ value: '+45', spoken: 'plus 45 points' });
  expect(pointsMetric(null)).toEqual({ value: '—', unit: 'pts', spoken: 'no data' });
});

test('rate: events per 100 of the driver units, one decimal under 10; a dash with no distance', () => {
  expect(rateMetric(4, 48, 'mi')).toEqual({ value: '8.3', unit: '/100 mi', spoken: '8.3 per 100 miles' });
  expect(rateMetric(4, 48, 'km')).toEqual({ value: '5.2', unit: '/100 km', spoken: '5.2 per 100 kilometers' });
  expect(rateMetric(30, 100, 'mi').value).toBe('30');
  expect(rateMetric(0, 12, 'mi').value).toBe('0.0');
  expect(rateMetric(3, 0, 'mi')).toEqual({ value: '—', unit: '/100 mi', spoken: 'no data' });
});
