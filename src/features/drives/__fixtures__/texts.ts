import { screen } from '@testing-library/react-native';

type JsonNode = { type: string; props: Record<string, unknown>; children: (JsonNode | string)[] | null };

const flat = (style: unknown): Record<string, unknown> =>
  ([] as unknown[]).concat(style ?? []).flat(Infinity as 1).reduce<Record<string, unknown>>((a, s) => (s && typeof s === 'object' ? { ...a, ...s } : a), {});

/** Every host Text under the element with `testID`, in render order: its string and its flattened style. */
export function textsUnder(testID: string): { text: string; style: Record<string, unknown> }[] {
  const out: { text: string; style: Record<string, unknown> }[] = [];
  let root: JsonNode | null = null;
  const find = (n: JsonNode | string | null | (JsonNode | string)[]): void => {
    if (!n || typeof n === 'string' || root) return;
    if (Array.isArray(n)) return n.forEach(find);
    if (n.props.testID === testID) {
      root = n;
      return;
    }
    (n.children ?? []).forEach(find);
  };
  find(screen.toJSON() as JsonNode | JsonNode[] | null);
  const walk = (n: JsonNode | string): void => {
    if (typeof n === 'string') return;
    if (n.type === 'Text') {
      out.push({ text: (n.children ?? []).filter((c): c is string => typeof c === 'string').join(''), style: flat(n.props.style) });
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  if (root) walk(root);
  return out;
}
