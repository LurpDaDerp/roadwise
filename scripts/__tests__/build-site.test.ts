import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS build script
const site = require('../build-site.js') as {
  robotsTxt: () => string;
  assertVercelLink: (outDir: string) => void;
  VERCEL_PROJECT: string;
};

const root = join(__dirname, '..', '..');

describe('robots.txt', () => {
  test('blocks nothing, so a crawler can read the share page and its noindex', () => {
    const robots = site.robotsTxt();
    // The share page keeps itself out of search with its own tag, which only works if crawlers may
    // fetch it: a Disallow over /w/ hides the tag, and the bare URL can still be indexed from links.
    expect(readFileSync(join(root, 'web', 'link-site', 'w', 'index.html'), 'utf8')).toContain('<meta name="robots" content="noindex">');
    expect(robots).not.toMatch(/^Disallow:\s*\S/m);
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Sitemap: https:\/\/getroadwise\.app\/sitemap\.xml$/m);
  });
});

describe('the deploy guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-dist-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const link = (json: unknown) => {
    mkdirSync(join(dir, '.vercel'), { recursive: true });
    writeFileSync(join(dir, '.vercel', 'project.json'), typeof json === 'string' ? json : JSON.stringify(json));
  };

  test('passes for a folder linked to getroadwise', () => {
    expect(site.VERCEL_PROJECT).toBe('getroadwise');
    link({ projectId: 'prj_x', orgId: 'team_x', projectName: 'getroadwise' });
    expect(() => site.assertVercelLink(dir)).not.toThrow();
  });

  test('refuses an unlinked folder (a fresh clone, another machine, a deleted build folder), naming the fix', () => {
    // `vercel deploy --yes` there would create a new project named after the folder.
    expect(() => site.assertVercelLink(dir)).toThrow(/not linked to the Vercel project getroadwise.*vercel link --project getroadwise/);
  });

  test('refuses a folder linked to another project, or a link file it cannot read', () => {
    link({ projectId: 'prj_y', orgId: 'team_x', projectName: 'site-dist' });
    expect(() => site.assertVercelLink(dir)).toThrow(/linked to site-dist/);
    link('not json');
    expect(() => site.assertVercelLink(dir)).toThrow(/not linked to the Vercel project getroadwise/);
  });
});
