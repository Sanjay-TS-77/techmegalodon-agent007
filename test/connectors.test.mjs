import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectors } from '../src/connectors.mjs';

test('local connectors transform data without sending a network request', async () => {
  const { invokeConnector } = createConnectors({ transport: () => assert.fail('Unexpected request') });
  const run = { mode: 'preview' };
  const invoke = async (connector, input) => (await invokeConnector({ connector, input, run })).text;

  const result = await invoke('csv-to-json', '\uFEFFname,note,extra\r\nAda,"line 1\r\nline 2, ""quoted""",\r\n');
  assert.deepEqual(JSON.parse(result), [{ name: 'Ada', note: 'line 1\r\nline 2, "quoted"', extra: '' }]);
  await assert.rejects(invoke('csv-to-json', 'name,name\nAda,Grace'), /unique/);
  await assert.rejects(invoke('csv-to-json', 'name,note\nAda'), /same number/);
  await assert.rejects(invoke('csv-to-json', 'name\n"Ada'), /unclosed/);

  const invokePointer = (value, pointer) => invoke('json-select', JSON.stringify({ value, pointer }));
  assert.equal(await invokePointer({ 'a/b': [{ '~name': 42 }] }, '/a~1b/0/~0name'), '42');
  assert.equal(await invokePointer(false, ''), 'false');
  await assert.rejects(invokePointer({}, '/constructor'), /does not exist/);
  await assert.rejects(invokePointer([1], '/length'), /does not exist/);
  await assert.rejects(invokePointer({}, '/~2'), /valid JSON Pointer/);
  assert.equal(await invoke('text-sha256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('new public connectors use fixed HTTPS endpoints and return bounded summary fields', async () => {
  const contracts = new Map([
    ['github-pulls', ['org/repo', 'https://api.github.com/repos/org/repo/pulls?state=open&per_page=10',
      [{ number: 42, title: 'Improve docs', draft: false, confidential: 'ignored' }], [{ number: 42, title: 'Improve docs', draft: false }]]],
    ['pypi-project', ['Build_Tools', 'https://pypi.org/pypi/build-tools/json',
      { info: { name: 'Build_Tools', version: '2.0', requires_python: '>=3.10', description: 'ignored' } }, { name: 'Build_Tools', version: '2.0', requiresPython: '>=3.10' }]],
    ['crates-package', ['serde', 'https://crates.io/api/v1/crates/serde',
      { crate: { name: 'serde', max_stable_version: '1.0', max_version: '2.0-preview' } }, { name: 'serde', version: '1.0' }]],
    ['hackernews-item', ['123', 'https://hacker-news.firebaseio.com/v0/item/123.json',
      { id: 123, type: 'story', title: 'Story', descendants: 3, text: '<p>ignored</p>' }, { id: 123, type: 'story', title: 'Story', comments: 3 }]],
    ['openlibrary-isbn', ['978-0140328721', 'https://openlibrary.org/search.json?isbn=9780140328721&limit=1&fields=key,title,author_name,first_publish_year',
      { docs: [{ key: '/works/OL123W', title: 'Book', author_name: ['Writer'], first_publish_year: 1988 }] },
      { title: 'Book', authors: ['Writer'], firstPublished: 1988, url: 'https://openlibrary.org/works/OL123W' }]],
  ]);
  const requests = [];
  const { catalog, invokeConnector } = createConnectors({ transport: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['user-agent'], /Agent007/);
    requests.push(url);
    const contract = [...contracts.values()].find(([, expectedUrl]) => expectedUrl === url);
    assert.ok(contract, `Unexpected URL ${url}`);
    return Response.json(contract[2]);
  } });
  assert.equal(catalog.length, 16);
  for (const [connector, [input, url, , expected]] of contracts) {
    const preview = await invokeConnector({ connector, input, run: { mode: 'preview' } });
    assert.match(preview.text, /preview/);
    assert.equal(requests.includes(url), false);
    const live = await invokeConnector({ connector, input, run: { mode: 'live' } });
    assert.equal(requests.at(-1), url);
    assert.deepEqual(JSON.parse(live.text), expected);
    await assert.rejects(invokeConnector({ connector, input: 'https://example.org/', run: { mode: 'live' } }));
  }
  assert.equal(requests.length, contracts.size);
});
