export function toolValue(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  const heading = /^### Result\s*\r?\n/m.exec(text);
  const section = (heading ? text.slice(heading.index + heading[0].length) : text).trim();
  // Try the complete value first. Only accept a shorter JSON value when the
  // remainder is an MCP section, never by cutting through a quoted JSON string.
  try { return JSON.parse(section); } catch {}
  if (heading) {
    for (const boundary of section.matchAll(/\r?\n### /g)) {
      try { return JSON.parse(section.slice(0, boundary.index).trim()); } catch {}
    }
  }
  throw new Error('Could not read the browser result. Submission may have occurred; check Chrome before retrying.');
}

