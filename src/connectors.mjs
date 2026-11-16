const slug = /^[\w.-]{1,100}$/;
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
};

export function createConnectors({ transport = fetch } = {}) {
  async function readJson(url) {
    const response = await transport(url, {
      headers: { accept: 'application/json', 'user-agent': 'WorkflowStudio/0.1' },
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
        if (size > 1_000_000) throw new Error('The connector response exceeded 1 MB.');
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
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
    ['github-repository', 'GitHub repository', 'Read the metadata of a public repository.', 'owner/repository', github('github-repository')],
    ['github-issues', 'GitHub issues', 'Read open issues from the first page of a public repository.', 'owner/repository', github('github-issues')],
    ['github-release', 'GitHub release', 'Read the latest public stable release.', 'owner/repository', github('github-release')],
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
