import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { ThemeProvider } from '@/ui/theme';

import { formatBirthDate } from '../copy';
import {
  BirthDateField,
  birthDateError,
  checkBirthDate,
  EMPTY_BIRTH_DATE,
  localIsoDate,
  type BirthDateParts,
} from '../steps/BirthDateField';

/** Noon local time on 15 June 2026: far from any midnight, so the local date is unambiguous. */
const TODAY = new Date(2026, 5, 15, 12, 0, 0);
const parts = (month: string, day: string, year: string): BirthDateParts => ({ month, day, year });

describe('checkBirthDate', () => {
  it.each([
    parts('', '', ''),
    parts('3', '04', '2008'),
    parts('03', '4', '2008'),
    parts('03', '04', '208'),
    parts('03', '04', ''),
    parts('0a', '04', '2008'),
  ])('%p is incomplete, and says nothing yet', (p) => {
    const check = checkBirthDate(p, TODAY);
    expect(check).toEqual({ ok: false, reason: 'incomplete' });
    expect(birthDateError(check)).toBeNull();
  });

  it.each([
    parts('13', '01', '2008'),
    parts('00', '01', '2008'),
    parts('01', '00', '2008'),
    parts('04', '31', '2008'),
    parts('02', '30', '2008'),
    parts('02', '29', '2007'),
  ])('%p is not a date', (p) => {
    const check = checkBirthDate(p, TODAY);
    expect(check).toEqual({ ok: false, reason: 'invalid' });
    expect(birthDateError(check)).toBe('Check the month and day.');
  });

  it('29 February counts in a leap year', async () => {
    expect(checkBirthDate(parts('02', '29', '2008'), TODAY)).toEqual({ ok: true, iso: '2008-02-29' });
  });

  it('today is accepted, tomorrow is in the future', async () => {
    expect(checkBirthDate(parts('06', '15', '2026'), TODAY)).toEqual({ ok: true, iso: '2026-06-15' });
    const tomorrow = checkBirthDate(parts('06', '16', '2026'), TODAY);
    expect(tomorrow).toEqual({ ok: false, reason: 'future' });
    expect(birthDateError(tomorrow)).toBe("That date hasn't happened yet.");
  });

  it("holds to the server's 120-year bound", async () => {
    expect(checkBirthDate(parts('06', '15', '1906'), TODAY)).toEqual({ ok: true, iso: '1906-06-15' });
    const older = checkBirthDate(parts('06', '14', '1906'), TODAY);
    expect(older).toEqual({ ok: false, reason: 'too-old' });
    expect(birthDateError(older)).toBe('Check the year.');
  });

  it('dates the future check by the local calendar', async () => {
    expect(localIsoDate(new Date(2026, 0, 2, 0, 30))).toBe('2026-01-02');
    expect(localIsoDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
});

describe('formatBirthDate', () => {
  it.each([
    ['2008-03-04', 'March 4, 2008'],
    ['1999-12-31', 'December 31, 1999'],
    ['2012-01-09', 'January 9, 2012'],
  ])('%s reads as %s', (iso, words) => {
    expect(formatBirthDate(iso)).toBe(words);
  });
});

function Harness({ onValue }: { onValue?: (p: BirthDateParts) => void }) {
  const [value, setValue] = useState<BirthDateParts>(EMPTY_BIRTH_DATE);
  return (
    <ThemeProvider>
      <BirthDateField
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
      />
    </ThemeProvider>
  );
}

describe('BirthDateField', () => {
  it('is three typed fields with nothing filled in: no default year', async () => {
    await render(<Harness />);
    for (const seg of ['Month', 'Day', 'Year']) {
      const input = screen.getByLabelText(`Birth date, ${seg}`);
      expect(input.props.value).toBe('');
      expect(input.props.keyboardType).toBe('number-pad');
    }
    expect(screen.getByLabelText('Birth date, Year').props.placeholder).toBe('YYYY');
  });

  it('keeps digits only, up to each part’s length', async () => {
    const onValue = jest.fn();
    await render(<Harness onValue={onValue} />);
    await fireEvent.changeText(screen.getByLabelText('Birth date, Month'), '0x3');
    await fireEvent.changeText(screen.getByLabelText('Birth date, Year'), '200812');
    expect(screen.getByLabelText('Birth date, Month').props.value).toBe('03');
    expect(screen.getByLabelText('Birth date, Year').props.value).toBe('2008');
  });

  it('prints a saved date read-only, with no field to type in', async () => {
    await render(
      <ThemeProvider>
        <BirthDateField value={EMPTY_BIRTH_DATE} onChange={() => {}} fixed="2008-03-04" />
      </ThemeProvider>
    );
    expect(screen.getByText('March 4, 2008')).toBeOnTheScreen();
    expect(screen.getByText("Your birth date is saved and can't be changed.")).toBeOnTheScreen();
    expect(screen.queryByLabelText('Birth date, Month')).toBeNull();
  });

  it('shows an error under the field', async () => {
    await render(
      <ThemeProvider>
        <BirthDateField value={EMPTY_BIRTH_DATE} onChange={() => {}} error="Check the year." />
      </ThemeProvider>
    );
    expect(screen.getByText('Check the year.')).toBeOnTheScreen();
  });
});
