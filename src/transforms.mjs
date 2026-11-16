export function selectJson(input) {
  const request = JSON.parse(input);
  if (!request || typeof request.pointer !== 'string' || !Object.hasOwn(request, 'value') ||
      (request.pointer && !request.pointer.startsWith('/')) || /~(?![01])/.test(request.pointer)) {
    throw new Error('Supply a JSON object with value and a valid JSON Pointer.');
  }
  let value = request.value;
  const tokens = request.pointer ? request.pointer.slice(1).split('/') : [];
  for (const token of tokens) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key) ||
        (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key))) {
      throw new Error('The JSON Pointer does not exist in the supplied value.');
    }
    value = value[key];
  }
  return JSON.stringify(value, null, 2);
}

export function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let state = 'start';

  function endField() {
    row.push(field);
    if (row.length > 100) throw new Error('CSV must have at most 100 columns.');
    field = '';
    state = 'start';
  }

  function endRow() {
    endField();
    if (rows.length >= 1_001) throw new Error('CSV must have at most 1,000 data rows.');
    rows.push(row);
    row = [];
  }

  const text = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (state === 'quoted') {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') { field += '"'; index++; }
      else state = 'closed';
      continue;
    }
    if (character === ',') endField();
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      endRow();
    } else if (character === '"' && state === 'start') {
      state = 'quoted';
    } else {
      if (state === 'closed' || character === '"') throw new Error('CSV contains an invalid quoted field.');
      field += character;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('CSV contains an unclosed quoted field.');
  if (state !== 'start' || row.length) endRow();

  const [headers, ...records] = rows;
  if (!headers || headers.some(header => !header.trim()) || new Set(headers).size !== headers.length) {
    throw new Error('CSV requires a header row with unique, nonempty column names.');
  }
  if (records.some(record => record.length !== headers.length)) throw new Error('Every CSV record must have the same number of fields as the header.');
  return JSON.stringify(records.map(record => Object.fromEntries(headers.map((header, index) => [header, record[index]]))));
}
