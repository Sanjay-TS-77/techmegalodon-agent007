import { createHash } from 'node:crypto';
import { parseCsv, selectJson } from './transforms.mjs';

const slug = /^[\w.-]{1,100}$/;
const APPLICATION = 'Agent007/0.2 (https://github.com/Sanjay-TS-77/techmegalodon-agent007)';
const summaries = {
  'github-repository': {
    suffix: '',
    select: value => ({ name: value.full_name, description: value.description, stars: value.stargazers_count, license: value.license?.spdx_id, url: value.html_url }),
  },
  'github-issues': {
    suffix: '/issues?state=open&per_page=10',
    select: value => value.filter(issue => !issue.pull_request).map(issue => ({ number: issue.number, title: issue.title, url: issue.html_url })),
  },
  'github-release': {
    suffix: '/releases/latest',
    select: value => ({ tag: value.tag_name, title: value.name, publishedAt: value.published_at, url: value.html_url, notes: value.body?.slice(0, 8_000) }),
  },
  'github-pulls': {
    suffix: '/pulls?state=open&per_page=10',
    select: value => value.map(pull => ({ number: pull.number, title: pull.title, draft: pull.draft, url: pull.html_url })),
  },
};

export function createConnectors({ transport = fetch } = {}) {
  async function readJson(url, maxBytes = 1_000_000) {
    const response = await transport(url, {
      headers: { accept: 'application/json', 'user-agent': APPLICATION },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The public connector returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('The connector response exceeded the size limit.');
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  function lookup(label, parse, url, select, maxBytes) {
    return async ({ input, run }) => {
      const id = parse(input.trim());
      if (!id) throw new Error(`Enter a valid ${label} identifier.`);
      if (run.mode === 'preview') return `${label} request preview for ${id}.`;
      return JSON.stringify(select(await readJson(url(id), maxBytes)), null, 2);
    };
  }

  function github(id) {
    return async ({ input, run }) => {
      const found = input.trim().match(/^([a-zA-Z0-9-]{1,39})\/([a-zA-Z0-9_.-]{1,100})$/);
      if (!found || found[2] === '.' || found[2] === '..') throw new Error('Enter a public GitHub repository in owner/repository format.');
      if (run.mode === 'preview') return `Public GitHub request preview for ${input.trim()}.`;
      const [, owner, repository] = found;
      const { suffix, select } = summaries[id];
      const data = await readJson(`https://api.github.com/repos/${owner}/${repository}${suffix}`);
      return JSON.stringify(select(data), null, 2);
    };
  }

  const definitions = [
    ['text-clean', 'Clean text', 'Trim extra space and empty lines.', 'Plain text', ({ input }) => input.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n') || '(empty)'],
    ['text-count', 'Count text', 'Count lines, words and characters.', 'Plain text', ({ input }) => JSON.stringify({ lines: input.split(/\r?\n/).length, words: input.trim().split(/\s+/).filter(Boolean).length, characters: [...input].length })],
    ['text-dedupe', 'Deduplicate lines', 'Keep the first occurrence of each nonempty line.', 'One item per line', ({ input }) => [...new Set(input.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].join('\n') || '(empty)'],
    ['json-format', 'Format JSON', 'Validate and indent JSON input.', 'A JSON document', ({ input }) => JSON.stringify(JSON.parse(input), null, 2)],
    ['json-select', 'Select JSON value', 'Extract a value with a JSON Pointer.', 'JSON with value and pointer (for example /items/0)', ({ input }) => selectJson(input)],
    ['csv-to-json', 'CSV to JSON', 'Convert CSV records with a header row into a JSON array.', 'CSV with unique column names', ({ input }) => parseCsv(input)],
    ['text-sha256', 'SHA-256 digest', 'Produce the hexadecimal SHA-256 digest of text.', 'Plain text', ({ input }) => createHash('sha256').update(input).digest('hex')],
    ['github-repository', 'GitHub repository', 'Read the metadata of a public repository.', 'owner/repository', github('github-repository')],
    ['github-issues', 'GitHub issues', 'Read open issues from the first page of a public repository.', 'owner/repository', github('github-issues')],
    ['github-release', 'GitHub release', 'Read the latest public stable release.', 'owner/repository', github('github-release')],
    ['github-pulls', 'GitHub pull requests', 'Read the first page of open public pull requests.', 'owner/repository', github('github-pulls')],
    ['pypi-project', 'PyPI project', 'Read the latest public Python package metadata.', 'A PyPI project name', lookup('PyPI project',
      name => /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/.test(name) && name,
      name => `https://pypi.org/pypi/${name.toLowerCase().replace(/[-_.]+/g, '-')}/json`,
      ({ info }) => ({ name: info.name, version: info.version, summary: info.summary, requiresPython: info.requires_python, license: info.license_expression ?? info.license, url: info.package_url }),
      4_000_000)],
    ['crates-package', 'crates.io package', 'Read public Rust package metadata.', 'A crates.io crate name', lookup('crates.io package',
      name => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) && name,
      name => `https://crates.io/api/v1/crates/${name}`,
      ({ crate }) => ({ name: crate.name, version: crate.max_stable_version ?? crate.max_version, description: crate.description, repository: crate.repository, downloads: crate.downloads }))],
    ['hackernews-item', 'Hacker News item', 'Read the public metadata of a Hacker News story or comment.', 'A numeric Hacker News item ID', lookup('Hacker News item',
      id => /^[1-9]\d{0,11}$/.test(id) && id,
      id => `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
      item => {
        if (!item || item.deleted || item.dead) throw new Error('The Hacker News item is unavailable.');
        return { id: item.id, type: item.type, title: item.title, author: item.by, score: item.score, url: item.url, comments: item.descendants };
      })],
    ['openlibrary-isbn', 'Open Library ISBN', 'Read a public book record by ISBN-10 or ISBN-13.', 'ISBN with optional dashes', lookup('ISBN',
      value => {
        const normalized = value.replace(/[\s-]/g, '').toUpperCase();
        return /^(?:\d{9}[0-9X]|\d{13})$/.test(normalized) && normalized;
      },
      isbn => `https://openlibrary.org/search.json?isbn=${isbn}&limit=1&fields=key,title,author_name,first_publish_year`,
      result => {
        const book = result.docs?.[0];
        if (!book) throw new Error('Open Library found no book for that ISBN.');
        return { title: book.title, authors: book.author_name, firstPublished: book.first_publish_year, url: `https://openlibrary.org${book.key}` };
      })],
    ['npm-package', 'npm package', 'Read metadata for the latest public npm version.', 'package-name or @scope/package', async ({ input, run }) => {
      const parts = input.trim().split('/');
      if (!(parts.length === 1 && slug.test(parts[0])) &&
          !(parts.length === 2 && parts[0].startsWith('@') && slug.test(parts[0].slice(1)) && slug.test(parts[1]))) {
        throw new Error('Enter a public npm package name.');
      }
      if (parts.some(part => part === '.' || part === '..')) throw new Error('Enter a public npm package name.');
      const name = input.trim();
      if (run.mode === 'preview') return `Public npm registry request preview for ${name}.`;
      const data = await readJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
      return JSON.stringify({ name: data.name, version: data.version, description: data.description, license: data.license, homepage: data.homepage }, null, 2);
    }],
  ];

  const registry = new Map(definitions.map(([id, name, description, inputHint, execute]) => [
    id, { id, name, description, inputHint, configured: true, execute },
  ]));

  return {
    catalog: [...registry.values()].map(({ execute, ...metadata }) => metadata),
    async invokeConnector(context) {
      const connector = registry.get(context.connector);
      if (!connector) throw new Error('This connector is not installed.');
      return { text: await connector.execute(context) };
    },
  };
}
