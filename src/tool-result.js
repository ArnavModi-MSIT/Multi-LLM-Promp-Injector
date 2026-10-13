export function toolValue(result) {
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  const section = text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1] ?? text;
  try { return JSON.parse(section.trim()); }
  catch { throw new Error('Could not read the browser result. Submission may have occurred; check Chrome before retrying.'); }
}

